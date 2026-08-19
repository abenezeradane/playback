//! Safe wrapper over the libmpv FFI (native-001).
//!
//! `Mpv` owns one mpv core handle. The handle is documented thread-safe in
//! client.h, so `Mpv` is `Send + Sync` and is shared (`Arc`) between the Tauri
//! command layer and the event thread. Destruction is EXPLICIT
//! (`Mpv::terminate`) and serialized against in-flight commands by the caller
//! (`player.rs` holds its state mutex across every mpv call), never via `Drop`
//! — client.h forbids concurrent use during `mpv_terminate_destroy`.
//!
//! All `unsafe` lives here and in `ffi.rs`; `player.rs` is safe code.

pub mod ffi;

use std::ffi::{CStr, CString};
use std::os::raw::{c_int, c_void};
use std::ptr::NonNull;

/// An mpv error: the raw code plus its `mpv_error_string` rendering. Crosses
/// to the WebView only through `ipc_error` (generic public message).
#[derive(Debug)]
pub struct MpvError {
    pub code: i32,
    pub msg: String,
}

impl std::fmt::Display for MpvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "mpv error {}: {}", self.code, self.msg)
    }
}

/// Owned, translated view of one `mpv_wait_event` result. Every pointer field
/// is copied out before the next `wait_event` call invalidates it.
#[derive(Debug)]
pub enum MpvEvent {
    Shutdown,
    StartFile,
    FileLoaded,
    Seek,
    PlaybackRestart,
    EndFile { reason: i32, error_code: i32 },
    /// Observed property change; value already read out by format.
    Property { name: String, value: PropValue },
    Log { level: String, text: String },
    /// Timeout or an event we don't handle.
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PropValue {
    Flag(bool),
    Double(f64),
    Int(i64),
    Str(String),
    /// Property unavailable (format NONE) — e.g. duration before it is known.
    None,
}

pub struct Mpv {
    h: NonNull<ffi::mpv_handle>,
    lib: &'static ffi::LibMpv,
}

// SAFETY: client.h documents the mpv client handle as fully thread-safe; the
// wrapper adds no thread-affine state.
unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}

impl Mpv {
    /// Create an UNINITIALIZED mpv core (options are set before `init`).
    pub fn create() -> Result<Self, String> {
        let lib = ffi::libmpv()?;
        let h = unsafe { (lib.create)() };
        let h = NonNull::new(h).ok_or_else(|| "mpv_create returned null".to_string())?;
        Ok(Mpv { h, lib })
    }

    fn err(&self, code: c_int) -> MpvError {
        let msg = unsafe {
            let p = (self.lib.error_string)(code);
            if p.is_null() {
                String::from("unknown")
            } else {
                CStr::from_ptr(p).to_string_lossy().into_owned()
            }
        };
        MpvError { code, msg }
    }

    fn check(&self, code: c_int) -> Result<(), MpvError> {
        if code >= 0 {
            Ok(())
        } else {
            Err(self.err(code))
        }
    }

    fn cstr(s: &str) -> Result<CString, MpvError> {
        CString::new(s).map_err(|_| MpvError {
            code: i32::MIN,
            msg: format!("interior NUL in string {s:?}"),
        })
    }

    /// Set a string option (pre-init) — also works for most post-init options.
    pub fn set_option_str(&self, name: &str, value: &str) -> Result<(), MpvError> {
        let n = Self::cstr(name)?;
        let v = Self::cstr(value)?;
        self.check(unsafe { (self.lib.set_option_string)(self.h.as_ptr(), n.as_ptr(), v.as_ptr()) })
    }

    /// Set an int64 option (pre-init) — used for `wid`.
    pub fn set_option_i64(&self, name: &str, mut value: i64) -> Result<(), MpvError> {
        let n = Self::cstr(name)?;
        self.check(unsafe {
            (self.lib.set_option)(
                self.h.as_ptr(),
                n.as_ptr(),
                ffi::MPV_FORMAT_INT64,
                &mut value as *mut i64 as *mut c_void,
            )
        })
    }

    pub fn initialize(&self) -> Result<(), MpvError> {
        self.check(unsafe { (self.lib.initialize)(self.h.as_ptr()) })
    }

    /// Run an mpv command in ARRAY form (no shell-style re-parsing, so file
    /// paths with spaces/quotes/unicode are never mangled).
    pub fn command(&self, args: &[&str]) -> Result<(), MpvError> {
        let owned: Vec<CString> = args
            .iter()
            .map(|a| Self::cstr(a))
            .collect::<Result<_, _>>()?;
        let mut ptrs: Vec<*const std::os::raw::c_char> =
            owned.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        self.check(unsafe { (self.lib.command)(self.h.as_ptr(), ptrs.as_mut_ptr()) })
    }

    pub fn set_prop_flag(&self, name: &str, value: bool) -> Result<(), MpvError> {
        let n = Self::cstr(name)?;
        let mut v: c_int = if value { 1 } else { 0 };
        self.check(unsafe {
            (self.lib.set_property)(
                self.h.as_ptr(),
                n.as_ptr(),
                ffi::MPV_FORMAT_FLAG,
                &mut v as *mut c_int as *mut c_void,
            )
        })
    }

    pub fn set_prop_f64(&self, name: &str, mut value: f64) -> Result<(), MpvError> {
        let n = Self::cstr(name)?;
        self.check(unsafe {
            (self.lib.set_property)(
                self.h.as_ptr(),
                n.as_ptr(),
                ffi::MPV_FORMAT_DOUBLE,
                &mut value as *mut f64 as *mut c_void,
            )
        })
    }

    pub fn set_prop_str(&self, name: &str, value: &str) -> Result<(), MpvError> {
        // mpv_set_property with MPV_FORMAT_STRING takes a char** — but
        // mpv_set_option_string works for properties post-init too via the
        // string layer; use the explicit property call for clarity.
        let n = Self::cstr(name)?;
        let v = Self::cstr(value)?;
        let mut p = v.as_ptr();
        self.check(unsafe {
            (self.lib.set_property)(
                self.h.as_ptr(),
                n.as_ptr(),
                ffi::MPV_FORMAT_STRING,
                &mut p as *mut *const std::os::raw::c_char as *mut c_void,
            )
        })
    }

    pub fn get_prop_f64(&self, name: &str) -> Result<f64, MpvError> {
        let n = Self::cstr(name)?;
        let mut out: f64 = 0.0;
        self.check(unsafe {
            (self.lib.get_property)(
                self.h.as_ptr(),
                n.as_ptr(),
                ffi::MPV_FORMAT_DOUBLE,
                &mut out as *mut f64 as *mut c_void,
            )
        })?;
        Ok(out)
    }

    pub fn get_prop_i64(&self, name: &str) -> Result<i64, MpvError> {
        let n = Self::cstr(name)?;
        let mut out: i64 = 0;
        self.check(unsafe {
            (self.lib.get_property)(
                self.h.as_ptr(),
                n.as_ptr(),
                ffi::MPV_FORMAT_INT64,
                &mut out as *mut i64 as *mut c_void,
            )
        })?;
        Ok(out)
    }

    pub fn get_prop_string(&self, name: &str) -> Result<String, MpvError> {
        let n = Self::cstr(name)?;
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        self.check(unsafe {
            (self.lib.get_property)(
                self.h.as_ptr(),
                n.as_ptr(),
                ffi::MPV_FORMAT_STRING,
                &mut out as *mut *mut std::os::raw::c_char as *mut c_void,
            )
        })?;
        let s = unsafe {
            let s = CStr::from_ptr(out).to_string_lossy().into_owned();
            (self.lib.free)(out as *mut c_void);
            s
        };
        Ok(s)
    }

    /// Observe a property; changes arrive as `MpvEvent::Property` on `wait_event`.
    pub fn observe(&self, name: &str, format: c_int) -> Result<(), MpvError> {
        let n = Self::cstr(name)?;
        self.check(unsafe { (self.lib.observe_property)(self.h.as_ptr(), 0, n.as_ptr(), format) })
    }

    pub fn request_log_messages(&self, min_level: &str) -> Result<(), MpvError> {
        let n = Self::cstr(min_level)?;
        self.check(unsafe { (self.lib.request_log_messages)(self.h.as_ptr(), n.as_ptr()) })
    }

    /// Wake a blocked `wait_event` (used to make shutdown immediate).
    pub fn wakeup(&self) {
        unsafe { (self.lib.wakeup)(self.h.as_ptr()) }
    }

    /// Block up to `timeout` seconds for the next event, translated to an owned
    /// value. Called only from the event thread.
    pub fn wait_event(&self, timeout: f64) -> MpvEvent {
        let ev = unsafe { (self.lib.wait_event)(self.h.as_ptr(), timeout) };
        if ev.is_null() {
            return MpvEvent::Other;
        }
        let ev = unsafe { &*ev };
        match ev.event_id {
            ffi::MPV_EVENT_SHUTDOWN => MpvEvent::Shutdown,
            ffi::MPV_EVENT_START_FILE => MpvEvent::StartFile,
            ffi::MPV_EVENT_FILE_LOADED => MpvEvent::FileLoaded,
            ffi::MPV_EVENT_SEEK => MpvEvent::Seek,
            ffi::MPV_EVENT_PLAYBACK_RESTART => MpvEvent::PlaybackRestart,
            ffi::MPV_EVENT_END_FILE => {
                let data = ev.data as *const ffi::mpv_event_end_file;
                if data.is_null() {
                    MpvEvent::EndFile { reason: -1, error_code: 0 }
                } else {
                    let d = unsafe { &*data };
                    MpvEvent::EndFile { reason: d.reason, error_code: d.error }
                }
            }
            ffi::MPV_EVENT_PROPERTY_CHANGE => {
                let data = ev.data as *const ffi::mpv_event_property;
                if data.is_null() {
                    return MpvEvent::Other;
                }
                let d = unsafe { &*data };
                let name = unsafe { CStr::from_ptr(d.name).to_string_lossy().into_owned() };
                let value = unsafe { read_prop_value(d.format, d.data) };
                MpvEvent::Property { name, value }
            }
            ffi::MPV_EVENT_LOG_MESSAGE => {
                let data = ev.data as *const ffi::mpv_event_log_message;
                if data.is_null() {
                    return MpvEvent::Other;
                }
                let d = unsafe { &*data };
                let level = unsafe { CStr::from_ptr(d.level).to_string_lossy().into_owned() };
                let text = unsafe { CStr::from_ptr(d.text).to_string_lossy().into_owned() };
                MpvEvent::Log { level, text }
            }
            _ => MpvEvent::Other,
        }
    }

    /// Destroy the core. Consumes the wrapper; the caller must have quiesced
    /// the event thread and hold exclusive access (see player.rs shutdown).
    pub fn terminate(self) {
        unsafe { (self.lib.terminate_destroy)(self.h.as_ptr()) }
    }
}

/// Read an observed-property payload by format (called on mpv-owned memory
/// valid until the next `wait_event`).
unsafe fn read_prop_value(format: c_int, data: *mut c_void) -> PropValue {
    if data.is_null() {
        return PropValue::None;
    }
    match format {
        ffi::MPV_FORMAT_FLAG => PropValue::Flag(*(data as *const c_int) != 0),
        ffi::MPV_FORMAT_DOUBLE => PropValue::Double(*(data as *const f64)),
        ffi::MPV_FORMAT_INT64 => PropValue::Int(*(data as *const i64)),
        ffi::MPV_FORMAT_STRING => {
            let p = *(data as *const *const std::os::raw::c_char);
            if p.is_null() {
                PropValue::None
            } else {
                PropValue::Str(CStr::from_ptr(p).to_string_lossy().into_owned())
            }
        }
        _ => PropValue::None,
    }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested): option composition + event throttling
// ---------------------------------------------------------------------------

/// The baseline engine options for this app, in the exact order they are set
/// (all BEFORE `mpv_initialize`; `wid` is set separately as int64). Pure so the
/// full option set — including the load-bearing `demuxer-lavf-o` — is pinned by
/// unit tests.
pub fn engine_options(hwdec: bool, shader_cache_dir: Option<&str>) -> Vec<(String, String)> {
    let s = |a: &str, b: &str| (a.to_string(), b.to_string());
    let mut opts = vec![
        // Rendering: gpu-next on d3d11 — the modern zero-copy path on Windows.
        s("vo", "gpu-next"),
        s("gpu-context", "d3d11"),
        // Hardware decode is opt-in in mpv; wire it to the app's hwaccel pref.
        s("hwdec", if hwdec { "auto-safe" } else { "no" }),
        // Reaching EOF pauses on the last frame instead of unloading — this is
        // what makes the frontend's `ended` (eof-reached) semantics match the
        // HTML element (picture stays up while the Up Next prompt shows).
        s("keep-open", "yes"),
        // The web layer owns ALL input and chrome; mpv must never compete.
        s("input-default-bindings", "no"),
        s("input-vo-keyboard", "no"),
        s("input-cursor", "no"),
        s("osc", "no"),
        s("osd-level", "0"),
        // No user config / scripts — the engine is deterministic app plumbing.
        s("config", "no"),
        s("load-scripts", "no"),
        s("terminal", "no"),
        // Blank child window is theme-black, matching the old <video> letterbox.
        s("background-color", "#000000"),
        // LOAD-BEARING (native-001): libavformat reads the tail `mfra` seek
        // index of fragmented MP4s ONLY with use_mfra_for set — without it,
        // seeks in a zero-duration OBS/Twitch recording land near the start
        // (verified in FFmpeg mov.c; see docs/native-engine-ipc.md).
        s("demuxer-lavf-o", "use_mfra_for=pts"),
        // PERF (perf-004): skip the extra frame of display latency mpv keeps for
        // its timing heuristics. Measured -45 ms on first frame; harmless here
        // because this is a local-file player with no live-stream sync to hold.
        s("video-latency-hacks", "yes"),
    ];
    // PERF (perf-004): gpu-next compiles its libplacebo shaders on first frame,
    // and without a cache directory it pays that cost on EVERY load — measured
    // at ~120 ms of the ~320 ms open. Pointing it at a persistent directory
    // makes the compile a one-time cost for the life of the install.
    if let Some(dir) = shader_cache_dir {
        opts.push(s("gpu-shader-cache-dir", dir));
    }
    opts
}

/// Parse the TEST-ONLY `PLAYBACK_MPV_OPTS` env value (`key=value;key=value`)
/// into option pairs, applied after the baseline (last write wins in mpv).
/// Empty/whitespace segments are skipped; a segment without `=` is ignored.
pub fn parse_extra_opts(raw: &str) -> Vec<(String, String)> {
    raw.split(';')
        .filter_map(|seg| {
            let seg = seg.trim();
            let (k, v) = seg.split_once('=')?;
            let (k, v) = (k.trim(), v.trim());
            if k.is_empty() {
                return None;
            }
            Some((k.to_string(), v.to_string()))
        })
        .collect()
}

/// Time-pos throttle: the element's `timeupdate` fires ~4 Hz; mpv observes
/// time-pos every frame. Emit at most once per `interval_ms` (monotonic input
/// so it is pure + testable).
pub struct Throttle {
    interval_ms: u64,
    last_emit_ms: Option<u64>,
}

impl Throttle {
    pub fn new(interval_ms: u64) -> Self {
        Throttle { interval_ms, last_emit_ms: None }
    }

    /// True when an event at `now_ms` should be emitted (and records it).
    pub fn admit(&mut self, now_ms: u64) -> bool {
        match self.last_emit_ms {
            Some(last) if now_ms.saturating_sub(last) < self.interval_ms => false,
            _ => {
                self.last_emit_ms = Some(now_ms);
                true
            }
        }
    }

    /// Forget the last emission (used at seeks/loads so the next tick is
    /// immediate — the UI should snap, not wait out the interval).
    pub fn reset(&mut self) {
        self.last_emit_ms = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts_map(hwdec: bool) -> std::collections::HashMap<String, String> {
        engine_options(hwdec, None).into_iter().collect()
    }

    #[test]
    fn engine_options_pin_the_load_bearing_values() {
        let on = opts_map(true);
        // The whole reason native-001 exists: seeks in a zero-duration
        // fragmented MP4 need the tail mfra index, which libavformat only
        // reads with this option (verified against FFmpeg mov.c — play-020's
        // root cause was Chromium lacking exactly this).
        assert_eq!(on.get("demuxer-lavf-o").map(String::as_str), Some("use_mfra_for=pts"));
        // keep-open is what maps mpv EOF onto the element's `ended` semantics
        // (picture holds on the last frame while the Up Next prompt shows).
        assert_eq!(on.get("keep-open").map(String::as_str), Some("yes"));
        // The web layer owns ALL input and chrome.
        assert_eq!(on.get("input-default-bindings").map(String::as_str), Some("no"));
        assert_eq!(on.get("input-vo-keyboard").map(String::as_str), Some("no"));
        assert_eq!(on.get("osc").map(String::as_str), Some("no"));
        // No user config/scripts — deterministic app plumbing.
        assert_eq!(on.get("config").map(String::as_str), Some("no"));
        // d3d11 + gpu-next render stack.
        assert_eq!(on.get("vo").map(String::as_str), Some("gpu-next"));
        assert_eq!(on.get("gpu-context").map(String::as_str), Some("d3d11"));
    }

    #[test]
    fn engine_options_wire_hwdec_to_the_hwaccel_pref() {
        assert_eq!(opts_map(true).get("hwdec").map(String::as_str), Some("auto-safe"));
        assert_eq!(opts_map(false).get("hwdec").map(String::as_str), Some("no"));
    }

    /// perf-004: the two options that took a file open from ~320 ms to ~157 ms.
    /// The shader cache is only set when a directory was resolved — the engine
    /// must still start (just without the cache) when it could not be created.
    #[test]
    fn engine_options_set_the_perf_004_startup_options() {
        let with_cache: std::collections::HashMap<String, String> =
            engine_options(true, Some("C:\\cache\\shaders")).into_iter().collect();
        assert_eq!(
            with_cache.get("gpu-shader-cache-dir").map(String::as_str),
            Some("C:\\cache\\shaders")
        );
        // Latency hacks are unconditional: they cost nothing for a local player.
        assert_eq!(with_cache.get("video-latency-hacks").map(String::as_str), Some("yes"));
        // gpu-next is retained -- the cache is what made it cheap, so there was
        // no need to fall back to the older `gpu` vo to win the latency back.
        assert_eq!(with_cache.get("vo").map(String::as_str), Some("gpu-next"));

        // No directory -> no cache option at all (never an empty value, which
        // mpv would treat as a path).
        assert!(!opts_map(true).contains_key("gpu-shader-cache-dir"));
        assert_eq!(opts_map(true).get("video-latency-hacks").map(String::as_str), Some("yes"));
    }

    #[test]
    fn parse_extra_opts_splits_semicolon_pairs_and_skips_junk() {
        assert_eq!(
            parse_extra_opts("d3d11-flip=no;hwdec=no"),
            vec![
                ("d3d11-flip".to_string(), "no".to_string()),
                ("hwdec".to_string(), "no".to_string())
            ]
        );
        // Whitespace tolerated, empty/malformed segments skipped.
        assert_eq!(
            parse_extra_opts(" a = 1 ; ; no-equals ; =v ; b=x=y "),
            vec![("a".to_string(), "1".to_string()), ("b".to_string(), "x=y".to_string())]
        );
        assert!(parse_extra_opts("").is_empty());
    }

    #[test]
    fn throttle_admits_at_interval_and_resets_for_snappy_seeks() {
        let mut t = Throttle::new(250);
        assert!(t.admit(1000)); // first tick always emits
        assert!(!t.admit(1100)); // within the interval -> dropped
        assert!(!t.admit(1249));
        assert!(t.admit(1250)); // interval elapsed
        assert!(!t.admit(1300));
        t.reset(); // seek/load: the next tick must snap immediately
        assert!(t.admit(1301));
    }
}

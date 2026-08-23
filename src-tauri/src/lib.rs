//! Playback — Tauri 2.0 application entry point.
//!
//! The frontend (a WebView running the Vite-built UI) is the player surface.
//! Native responsibilities are intentionally thin:
//!   * the dialog plugin provides the "Open file" picker,
//!   * the asset protocol (configured in tauri.conf.json) streams the chosen
//!     local video file into the WebView's <video> element,
//!   * window drag-and-drop is enabled so files can be dropped onto the window,
//!   * a path passed on the command line ("Open with…") is loaded on startup,
//!   * two thin commands (`stream_status` / `read_stream_chunk`) report a file's
//!     size + live-capture markers (so the frontend can DETECT a livestream and
//!     open an empty player — livestream playback itself is temporarily
//!     deprecated) and read byte ranges (used by the cut-view waveform),
//!   * `remux_ts` converts a container the WebView can't start playing — an MPEG-TS
//!     file (.ts/.m2ts/.mts, play-016) or a fragmented MP4 the demuxer would have to
//!     scan to EOF to find a duration (`is_fragmented_mp4`, play-020) — into a
//!     playable faststart temp .mp4 via a bundled ffmpeg sidecar, and caches it.
//!
//! Filesystem reads are scoped (sec-002): the WebView may only read inside
//! directories it has opened a file from. `allow_media_dir` records each opened
//! file's directory in an allow-list (and in the asset-protocol scope); the two
//! read commands reject any path that canonicalizes outside it, so neither the
//! commands nor the asset protocol is a whole-disk arbitrary-file-read primitive.

use base64::Engine;
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;

mod archive;
mod mp4probe;
mod mpv;
mod player;
mod tags;

/// Holds a media path supplied on the command line, if any.
struct LaunchPath(Option<String>);

/// Pick the file path passed on a command line ("Open with…" / `playback.exe
/// <file>`): the first non-flag argument, skipping the program name in `args[0]`.
/// Shared by the startup launch parse and the single-instance handler (a second
/// invocation forwards its whole argv here), so both agree on which token is the
/// file. Pure (no env/IO) → unit-testable.
fn first_file_arg(args: &[String]) -> Option<String> {
    args.iter().skip(1).find(|a| !a.starts_with('-')).cloned()
}

/// Bundle identifier — must match `tauri.conf.json` `identifier`. Used to locate
/// the per-user config directory where the hardware-acceleration preference is
/// stored (play-010). We compute this path manually rather than via the Tauri
/// `AppHandle`, because the preference must be read BEFORE the WebView is created
/// (the GPU launch flag is fixed at webview-creation time), i.e. before an
/// `AppHandle` exists.
const APP_IDENTIFIER: &str = "com.playback.player";

/// Chromium browser argument that forces SOFTWARE video decoding (play-010). It
/// disables only the GPU's video-decode engine; GPU compositing stays on, so the
/// play-004 cut-view canvas capture (which depends on the composited video plane —
/// see the webview2-canvas-video-capture gotcha) keeps working. Applied to the
/// WebView2 launch only when the user has turned hardware acceleration OFF.
const SW_DECODE_FLAG: &str = "--disable-accelerated-video-decode";

/// Canonical directories the WebView is allowed to read from (sec-002). Seeded
/// only by `allow_media_dir`, which the frontend calls for every file the user
/// actually opens (dialog / drag-drop / "Open with" launch arg / Recent) — never
/// trusted from a caller-supplied read path. `stream_status` / `read_stream_chunk`
/// reject any path that does not canonicalize to inside one of these roots, so the
/// old whole-disk arbitrary-file-read primitive (F-1) is gone. The native engine's
/// `player_load` (native-001) routes through the same gate.
#[derive(Default)]
pub(crate) struct AllowList(Mutex<HashSet<PathBuf>>);

/// True when `candidate` (already canonicalized) resolves inside one of the
/// allowed `roots`. `Path::starts_with` compares whole path components, so a
/// sibling sharing a name prefix (".../Videos-secret" vs an allowed ".../Videos")
/// is correctly NOT inside. Canonicalization by the caller is what defeats `..`
/// traversal and symlink escapes — both resolve to a real target before this
/// check. An empty root set denies everything (deny-by-default).
fn path_within_roots(roots: &HashSet<PathBuf>, candidate: &Path) -> bool {
    roots.iter().any(|root| candidate.starts_with(root))
}

/// Log a command's underlying error natively (for diagnostics) and return a
/// stable, generic message for the WebView (sec-005 / F-5). Raw OS error strings
/// can embed absolute paths and system detail (e.g. "The system cannot find the
/// path … C:\Users\<name>\…"); forwarding them across the IPC boundary is a minor
/// info-leak / fingerprinting hygiene issue. The `detail` stays on the native side
/// (stderr); only the stable `public` string crosses to the WebView.
pub(crate) fn ipc_error(context: &str, detail: impl std::fmt::Display, public: &str) -> String {
    eprintln!("[playback] {context}: {detail}");
    public.to_string()
}

/// Canonicalize `path` and confirm it lands inside the allow-list, returning a
/// generic error otherwise. This is the single security gate shared by the two
/// file-reading commands.
pub(crate) fn ensure_allowed(allow: &AllowList, path: &str) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path).map_err(|_| "file not found".to_string())?;
    let permitted = allow
        .0
        .lock()
        .map(|roots| path_within_roots(&roots, &canonical))
        .unwrap_or(false);
    if permitted {
        Ok(canonical)
    } else {
        Err("path not allowed".to_string())
    }
}

/// Returns the file path Playback was launched with (e.g. via "Open with…" or
/// `playback.exe <file>`), or `null` when started without one.
#[tauri::command]
fn launch_path(state: tauri::State<'_, LaunchPath>) -> Option<String> {
    state.0.clone()
}

// ---------------------------------------------------------------------------
// Hardware-acceleration preference (play-010)
//
// Playback's <video> is decoded and composited by the WebView2/Chromium media
// pipeline, which uses the GPU's video-decode + compositing path by default. When
// a specific GPU/driver misbehaves (green/black/torn frames) the user can turn
// hardware acceleration OFF, which appends `--disable-accelerated-video-decode` to
// the WebView2 launch so decoding falls back to software. Because those launch
// flags are fixed when the WebView is created, the change only takes effect on the
// NEXT launch — hence the UI's "restart to apply" hint.
//
// The preference can't live solely in the WebView's localStorage: it must be read
// BEFORE the WebView exists, to decide the launch flag. So the source of truth is a
// tiny native file in the per-user config dir (the frontend mirrors it into
// `playback:hwaccel` localStorage purely for display). `set_hwaccel` writes it and
// `get_hwaccel` reads it; `run()` reads it at startup to set the launch flag.
// ---------------------------------------------------------------------------

/// Path of the native hardware-acceleration preference file (`hwaccel` under the
/// app's per-user config dir). Computed from the environment — `%APPDATA%` on
/// Windows, `$XDG_CONFIG_HOME`/`$HOME/.config` elsewhere — so it is available at
/// startup without an `AppHandle`. The SAME function backs both the read (startup)
/// and the write (`set_hwaccel`), so the two always agree on the location.
fn hwaccel_pref_path() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    }?;
    Some(base.join(APP_IDENTIFIER).join("hwaccel"))
}

/// Read the persisted hardware-acceleration preference. Defaults to `true`
/// (hardware acceleration ON, the Chromium default) unless the file explicitly
/// holds `"off"` — so a missing/unreadable file, or a first run, keeps GPU decode.
pub(crate) fn read_hwaccel_pref() -> bool {
    match hwaccel_pref_path().and_then(|p| fs::read_to_string(p).ok()) {
        Some(contents) => contents.trim() != "off",
        None => true,
    }
}

/// Build the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` value for the given preference,
/// PRESERVING any args already present (e.g. the smoke harness's TEST-ONLY
/// `--disable-features=DirectCompositionVideoOverlays`, set externally before
/// launch). When hardware acceleration is enabled (the default) the existing value
/// is returned unchanged — production carries no extra flag. When disabled, the
/// software-decode flag is appended exactly once (idempotent if already present).
/// Pure (no env/IO), so the arg composition is unit-testable on its own.
fn browser_args_for_hwaccel(existing: &str, hwaccel_enabled: bool) -> String {
    if hwaccel_enabled || existing.split_whitespace().any(|a| a == SW_DECODE_FLAG) {
        return existing.to_string();
    }
    if existing.is_empty() {
        SW_DECODE_FLAG.to_string()
    } else {
        format!("{existing} {SW_DECODE_FLAG}")
    }
}

/// Apply the persisted hardware-acceleration preference to the WebView2 launch by
/// setting `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` BEFORE the webview is created.
/// Only mutates the env var when the value actually changes (i.e. when accel is OFF
/// and the flag isn't already there), so the default path leaves the environment —
/// and any externally-set test flags — exactly as-is. Must be called before
/// `tauri::Builder::run()`.
fn apply_hwaccel_launch_flag() {
    let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    let updated = browser_args_for_hwaccel(&existing, read_hwaccel_pref());
    if updated != existing {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", updated);
    }
}

/// Report the persisted hardware-acceleration preference to the frontend so the
/// Settings toggle reflects what will actually apply on the next launch.
#[tauri::command]
fn get_hwaccel() -> bool {
    read_hwaccel_pref()
}

// ---------------------------------------------------------------------------
// Playback-engine preference (native-001; default flipped in native-003)
//
// "native" = the embedded-libmpv engine (the DEFAULT since native-003 —
// instant open for fMP4/TS/MKV, no remux); "web" = the original WebView
// <video> path, kept as the compatibility fallback (and what the frontend
// degrades to when libmpv-2.dll is missing). Stored as a native pref file
// next to `hwaccel` (NOT localStorage) so smoke scripts can preseed it
// before launch, exactly like the smoke-hwaccel precedent.
// ---------------------------------------------------------------------------

/// Path of the engine preference file (`engine` under the app config dir) —
/// same location scheme as `hwaccel_pref_path`.
fn engine_pref_path() -> Option<PathBuf> {
    hwaccel_pref_path().map(|p| p.with_file_name("engine"))
}

/// Where the tag index lives (tags-001) — beside the other prefs, under the app
/// identifier. Resolved HERE, never passed in from the WebView.
pub(crate) fn tags_db_path() -> Option<PathBuf> {
    hwaccel_pref_path().map(|p| p.with_file_name("tags.db"))
}

/// Normalize a stored/requested engine value; anything unrecognized is the
/// default ("native" since native-003 — a missing DLL is still safe: the
/// frontend probes availability and degrades to the web engine). Pure +
/// unit-tested.
fn normalize_engine(value: &str) -> &'static str {
    if value.trim() == "web" {
        "web"
    } else {
        "native"
    }
}

/// Report the persisted playback-engine preference ("native" | "web").
#[tauri::command]
fn get_engine_pref() -> String {
    let stored = engine_pref_path().and_then(|p| fs::read_to_string(p).ok());
    normalize_engine(stored.as_deref().unwrap_or("native")).to_string()
}

/// Persist the playback-engine preference. Applies to the next file opened.
#[tauri::command]
fn set_engine_pref(engine: String) -> Result<(), String> {
    let path = engine_pref_path().ok_or_else(|| "could not save setting".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ipc_error("set_engine_pref: mkdir", e, "could not save setting"))?;
    }
    fs::write(&path, normalize_engine(&engine))
        .map_err(|e| ipc_error("set_engine_pref: write", e, "could not save setting"))?;
    Ok(())
}

/// Directory libplacebo (mpv's gpu-next) caches its compiled shaders in (perf-004).
/// Without it gpu-next recompiles on every load, which measured as ~120 ms of a
/// ~320 ms file open; with it the compile is paid once for the install. Created on
/// demand — a failure here is non-fatal, the engine just recompiles as before.
pub(crate) fn shader_cache_dir() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
    }?;
    let dir = base.join(APP_IDENTIFIER).join("shader-cache");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Perf tracing sink (perf-004). `PLAYBACK_PERF_LOG` names a file the frontend's
/// trace records are appended to; unset means tracing is OFF and the frontend
/// never calls `perf_log` at all. Diagnostic-only, and inert in a normal launch.
fn perf_log_path() -> Option<PathBuf> {
    std::env::var("PLAYBACK_PERF_LOG")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
}

/// Whether runtime perf tracing is enabled for this launch.
#[tauri::command]
fn perf_enabled() -> bool {
    perf_log_path().is_some()
}

/// Append a batch of frontend trace records (one JSON object per line).
#[tauri::command]
fn perf_log(lines: Vec<String>) -> Result<(), String> {
    let Some(path) = perf_log_path() else {
        return Ok(()); // tracing off: accept and discard
    };
    use std::io::Write;
    let mut out = String::with_capacity(lines.len() * 64);
    for line in lines {
        // One record per line; strip embedded newlines so the log stays parseable.
        out.push_str(&line.replace('\n', " "));
        out.push('\n');
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| ipc_error("perf_log: open", e, "could not write perf log"))?;
    f.write_all(out.as_bytes())
        .map_err(|e| ipc_error("perf_log: write", e, "could not write perf log"))?;
    Ok(())
}

/// Persist the hardware-acceleration preference (play-010). Written natively so the
/// next launch can read it before the WebView exists and set the GPU launch flag
/// accordingly. Takes effect on relaunch.
#[tauri::command]
fn set_hwaccel(enabled: bool) -> Result<(), String> {
    let path = hwaccel_pref_path().ok_or_else(|| "could not save setting".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ipc_error("set_hwaccel: mkdir", e, "could not save setting"))?;
    }
    fs::write(&path, if enabled { "on" } else { "off" })
        .map_err(|e| ipc_error("set_hwaccel: write", e, "could not save setting"))?;
    Ok(())
}

/// Current state of a (possibly still-growing) media file on disk.
#[derive(serde::Serialize)]
struct StreamStatus {
    /// Current byte length of the file.
    size: u64,
    /// True while a sibling `<path>.live` marker exists — a writer is actively
    /// appending to the file, so the frontend should tail it as a livestream.
    live: bool,
    /// True once a sibling `<path>.done` marker exists — writing has finished, so
    /// the frontend can finalize the MediaSource and treat it as a normal file.
    complete: bool,
    /// Milliseconds since the file was last modified (saturating; `u64::MAX` if the
    /// platform can't report it). The frontend uses this to recognise a recording
    /// in progress *before* the first frame paints: a recently-written file is a
    /// live candidate worth probing for growth, while a file last touched long ago
    /// is static and opens normally with no probe delay (play-005 detect-before-play).
    mtime_age_ms: u64,
    /// True when another process currently holds the file open for writing — i.e. a
    /// recorder (Streamlink/OBS) is still appending to it. This is the most reliable
    /// "still being written" signal: it is instant and, unlike a size-growth sample,
    /// it is not fooled by the multi-second flat gaps between an HLS recorder's
    /// segment-write bursts. Windows-only; always false elsewhere (the frontend then
    /// falls back to the growth probe).
    being_written: bool,
}

/// True when another process holds `path` open for writing. We probe by asking for
/// our own write handle while sharing only reads: an active writer's handle then
/// collides with ours and Windows denies the open with a sharing violation
/// (ERROR_SHARING_VIOLATION, raw OS error 32). The open is never used to write —
/// it is closed immediately — so it neither modifies the file nor its mtime. Any
/// other outcome (the open succeeds, or fails for an unrelated reason such as a
/// read-only file) is reported as "not actively being written".
#[cfg(windows)]
fn is_being_written(path: &str) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    match fs::OpenOptions::new()
        .write(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
    {
        Ok(_) => false,
        Err(e) => e.raw_os_error() == Some(ERROR_SHARING_VIOLATION),
    }
}

#[cfg(not(windows))]
fn is_being_written(_path: &str) -> bool {
    false
}

/// Authorize the directory of a media file the user has opened, so the WebView
/// may subsequently read it via the asset protocol and the `stream_status` /
/// `read_stream_chunk` commands (sec-002). The frontend calls this for every
/// file it opens, before any read. We canonicalize the file and record its
/// parent directory in the Rust-held allow-list (the read commands check against
/// it), and add that directory to the asset-protocol scope (keyed on the raw,
/// non-canonical path the WebView actually passes to `convertFileSrc`, so the
/// glob matches). Non-recursive: the opened media file is a direct child, so the
/// grant is the tightest that still serves it.
#[tauri::command]
fn allow_media_dir(
    app: tauri::AppHandle,
    allow: tauri::State<'_, AllowList>,
    path: String,
) -> Result<(), String> {
    let canonical = fs::canonicalize(&path).map_err(|_| "file not found".to_string())?;
    // gallery-001: every existing caller passes a FILE (authorize its PARENT, as
    // before). The gallery's "Open folder" entry point passes a FOLDER directly —
    // authorize the folder itself so `list_folder_images` can enumerate it.
    let (dir, raw_dir) = if canonical.is_dir() {
        (canonical.clone(), Some(Path::new(&path).to_path_buf()))
    } else {
        (
            canonical
                .parent()
                .ok_or_else(|| "invalid path".to_string())?
                .to_path_buf(),
            Path::new(&path).parent().map(Path::to_path_buf),
        )
    };
    authorize_dir(&app, &allow, dir, raw_dir.as_deref());
    Ok(())
}

/// Add a directory to BOTH read gates: the canonical `dir` into the IPC allow-list
/// (the read commands canonicalize before checking), and the asset-protocol scope
/// keyed on `raw_dir` (the non-canonical path the WebView passes to `convertFileSrc`
/// — on Windows the canonical form has a `\\?\` verbatim prefix that would not match
/// the glob). Shared by `allow_media_dir` (opened media) and `remux_ts` (temp dir).
fn authorize_dir(
    app: &tauri::AppHandle,
    allow: &AllowList,
    canonical_dir: PathBuf,
    raw_dir: Option<&Path>,
) {
    if let Ok(mut roots) = allow.0.lock() {
        roots.insert(canonical_dir);
    }
    if let Some(raw) = raw_dir {
        let _ = app.asset_protocol_scope().allow_directory(raw, false);
    }
}

/// Deterministic temp output filename for a remuxed transport stream. Keyed on the
/// source's canonical path + size + mtime, so re-opening the SAME unchanged file
/// reuses the cached .mp4 (no second ffmpeg run), while editing/replacing the source
/// (new size or mtime) yields a fresh name. Pure + unit-tested.
fn remux_output_name(canonical_src: &Path, size: u64, mtime_secs: u64) -> String {
    // FNV-1a over the identifying inputs — small, stable, dependency-free. Collisions
    // are not a security concern here (the path is already scope-checked); this only
    // needs to be stable for cache hits and distinct across different sources.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mix = |hash: &mut u64, bytes: &[u8]| {
        for &b in bytes {
            *hash ^= u64::from(b);
            *hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    mix(&mut hash, canonical_src.to_string_lossy().as_bytes());
    mix(&mut hash, &size.to_le_bytes());
    mix(&mut hash, &mtime_secs.to_le_bytes());
    format!("pb-ts-{hash:016x}.mp4")
}

/// ffmpeg arguments to remux a transport stream into a fragmentable, seekable MP4
/// without re-encoding. `-c copy` keeps the H.264/AAC elementary streams as-is (fast,
/// lossless); `-fflags +genpts` repairs the missing/irregular timestamps common in
/// TS captures so the MP4 seeks cleanly; `+faststart` moves the moov atom to the
/// front so the WebView's <video> starts immediately. Pure + unit-tested.
fn ffmpeg_remux_args(src: &Path, out: &Path) -> Vec<String> {
    vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        src.to_string_lossy().into_owned(),
        "-map".into(),
        "0:v:0?".into(),
        "-map".into(),
        "0:a:0?".into(),
        "-c".into(),
        "copy".into(),
        "-movflags".into(),
        "+faststart".into(),
        out.to_string_lossy().into_owned(),
    ]
}

/// Best-effort prune of stale remuxed files (older than a day) from the TS cache dir,
/// so the temp directory doesn't grow without bound across sessions.
fn prune_ts_cache(dir: &Path) {
    const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("pb-ts-") && name.ends_with(".mp4")) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| m.elapsed().map(|age| age > MAX_AGE).unwrap_or(false))
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Read a big-endian `u32` / `u64` from a reader (ISO-BMFF box fields).
/// Shared with the native engine's duration probe (mp4probe.rs).
pub(crate) fn read_be_u32<R: Read>(r: &mut R) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_be_bytes(b))
}
pub(crate) fn read_be_u64<R: Read>(r: &mut R) -> std::io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_be_bytes(b))
}

/// True when the ISO-BMFF (MP4) stream in `r` is a *fragmented* MP4 — i.e. it has a
/// top-level `moof` (movie-fragment) box, or a `moov` that contains an `mvex`
/// (movie-extends) box. Fragmented captures (Twitch/OBS/Streamlink "live" MP4s)
/// declare no usable duration in `moov`, and Chromium's progressive `<video>`
/// demuxer responds by scanning EVERY fragment to end-of-file before it reports
/// metadata — so a multi-GB fragmented recording opens but never starts playing
/// (play-020). The frontend remuxes such files to a plain, faststart MP4 first.
///
/// Only box HEADERS are read; box bodies (incl. multi-GB `mdat`s) are seeked over,
/// so this is cheap regardless of file size. A non-fragmented file is recognised by
/// a `moov` with no `mvex` and returns `false`. Pure over a `Read + Seek`, so it is
/// unit-tested with an in-memory cursor.
fn scan_is_fragmented<R: Read + Seek>(r: &mut R) -> std::io::Result<bool> {
    let end = r.seek(SeekFrom::End(0))?;
    r.seek(SeekFrom::Start(0))?;
    scan_boxes_for_fragmentation(r, 0, end, false)
}

/// Walk the boxes in `[start, region_end)`. At the top level (`in_moov == false`) a
/// `moof` means fragmented and a `moov` is descended into; inside `moov`
/// (`in_moov == true`) an `mvex` means fragmented. A complete `moov` with no `mvex`
/// is conclusive (a file has exactly one `moov`), so we stop and report `false`.
fn scan_boxes_for_fragmentation<R: Read + Seek>(
    r: &mut R,
    start: u64,
    region_end: u64,
    in_moov: bool,
) -> std::io::Result<bool> {
    let mut pos = start;
    let mut steps = 0u32;
    while pos + 8 <= region_end {
        steps += 1;
        if steps > 8192 {
            break; // guard against a pathological/malformed box chain
        }
        r.seek(SeekFrom::Start(pos))?;
        let size32 = read_be_u32(r)?;
        let mut ty = [0u8; 4];
        r.read_exact(&mut ty)?;
        let mut header = 8u64;
        let size = match size32 {
            0 => region_end - pos, // box runs to the end of the region
            1 => {
                header = 16;
                read_be_u64(r)?
            }
            n => u64::from(n),
        };
        if size < header || pos + size > region_end {
            break; // malformed / truncated header
        }
        if in_moov {
            if &ty == b"mvex" {
                return Ok(true);
            }
        } else if &ty == b"moof" {
            return Ok(true);
        } else if &ty == b"moov" {
            return scan_boxes_for_fragmentation(r, pos + header, pos + size, true);
        }
        pos += size;
    }
    Ok(false)
}

/// Report whether `path` is a fragmented MP4 that the WebView cannot start playing
/// directly (see `scan_is_fragmented`). The frontend calls this on open for ISO-BMFF
/// files and, when true, remuxes via `remux_ts` before playing (play-020). The path
/// must already be authorized (`allow_media_dir` runs first).
#[tauri::command]
fn is_fragmented_mp4(allow: tauri::State<'_, AllowList>, path: String) -> Result<bool, String> {
    let resolved = ensure_allowed(&allow, &path)?;
    let mut file = fs::File::open(&resolved).map_err(|_| "file not found".to_string())?;
    scan_is_fragmented(&mut file).map_err(|_| "could not read file".to_string())
}

/// Remux a container the WebView's `<video>` cannot start playing — an MPEG-TS file
/// (.ts/.m2ts/.mts, play-016) or a fragmented MP4 (play-020) — into a plain,
/// faststart temp .mp4 and return its path. Chromium can decode H.264/AAC but cannot
/// demux MPEG-TS, and for a fragmented MP4 it scans every fragment to EOF before it
/// will play (so a large one never starts); a stream-copy remux fixes both. The
/// bundled ffmpeg sidecar copies the streams (no re-encode). The source must already
/// be authorized (the frontend calls `allow_media_dir` first); the temp output's
/// directory is authorized here so the WebView can play it back. The result is cached
/// by source identity, so re-opening the same file is instant.
#[tauri::command]
async fn remux_ts(
    app: tauri::AppHandle,
    allow: tauri::State<'_, AllowList>,
    path: String,
) -> Result<String, String> {
    // Scope-check the source against the same allow-list the read commands use.
    let src = ensure_allowed(&allow, &path)?;
    let meta = fs::metadata(&src).map_err(|_| "file not found".to_string())?;
    let size = meta.len();
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cache_dir = std::env::temp_dir().join("playback-ts");
    fs::create_dir_all(&cache_dir).map_err(|_| "could not create temp directory".to_string())?;
    prune_ts_cache(&cache_dir);

    let out = cache_dir.join(remux_output_name(&src, size, mtime_secs));

    // Authorize the temp directory for both read gates BEFORE returning, so the
    // WebView can play the .mp4 and the cut-view waveform can read it. Keyed on the
    // raw (non-verbatim) temp path so the asset-scope glob matches convertFileSrc.
    let canonical_cache = fs::canonicalize(&cache_dir).unwrap_or_else(|_| cache_dir.clone());
    authorize_dir(&app, &allow, canonical_cache, Some(cache_dir.as_path()));

    // Cache hit: a non-empty remux already exists for this exact source.
    if fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(out.to_string_lossy().into_owned());
    }

    let args = ffmpeg_remux_args(&src, &out);
    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|_| "ffmpeg sidecar unavailable".to_string())?;
    let output = sidecar
        .args(args)
        .output()
        .await
        .map_err(|_| "remux failed to start".to_string())?;

    if !output.status.success() || !fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false) {
        let _ = fs::remove_file(&out); // don't leave a 0-byte file to be cache-hit later
        return Err("could not convert this file".to_string());
    }
    Ok(out.to_string_lossy().into_owned())
}

/// Report the size of a media file plus whether it is a live capture in progress.
/// The frontend polls this to learn how much new data is available and when the
/// stream has finalized.
#[tauri::command]
fn stream_status(allow: tauri::State<'_, AllowList>, path: String) -> Result<StreamStatus, String> {
    ensure_allowed(&allow, &path)?;
    let meta =
        fs::metadata(&path).map_err(|e| ipc_error("stream_status: metadata", e, "file not found"))?;
    let size = meta.len();
    let live = Path::new(&format!("{path}.live")).exists();
    let complete = Path::new(&format!("{path}.done")).exists();
    let mtime_age_ms = meta
        .modified()
        .ok()
        .and_then(|m| m.elapsed().ok())
        .map(|age| age.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(u64::MAX);
    let being_written = is_being_written(&path);
    Ok(StreamStatus { size, live, complete, mtime_age_ms, being_written })
}

/// Hard ceiling on how many bytes a single `read_stream_chunk` call will read —
/// and therefore allocate — regardless of the caller-supplied `max_len` (sec-003 /
/// F-3). The only first-party caller (`readWholeFile` in the frontend) requests at
/// most `READ_CHUNK_BYTES` (4 MiB) per call and advances by the *returned* length,
/// so this 8 MiB ceiling leaves it headroom and never clamps a legitimate read; it
/// exists purely so a hostile/buggy caller can't force a multi-GB native
/// allocation (plus ~1.33x for the base64 response) with one oversized `max_len`.
const MAX_CHUNK: u64 = 8 * 1024 * 1024;

/// Number of bytes `read_stream_chunk` will read for one request: the smaller of
/// what remains after `offset`, the caller's `max_len`, and the `MAX_CHUNK`
/// allocation ceiling. Pure (no I/O) so the clamp is unit-testable on its own.
fn clamp_read_len(remaining: u64, max_len: u64) -> usize {
    remaining.min(max_len).min(MAX_CHUNK) as usize
}

/// Read up to `max_len` bytes from `path` starting at `offset`, returned as a
/// base64 string. (A raw `Vec<u8>` response arrives on WebView2 as a slow JSON
/// number[]; base64 is far more compact and parses as a plain string.) Reads
/// only the bytes that exist right now, never more than `MAX_CHUNK` per call;
/// returns "" when `offset` is at/past EOF.
#[tauri::command]
fn read_stream_chunk(
    allow: tauri::State<'_, AllowList>,
    path: String,
    offset: u64,
    max_len: u64,
) -> Result<String, String> {
    ensure_allowed(&allow, &path)?;
    let mut file =
        fs::File::open(&path).map_err(|e| ipc_error("read_stream_chunk: open", e, "read failed"))?;
    let size = file
        .metadata()
        .map_err(|e| ipc_error("read_stream_chunk: metadata", e, "read failed"))?
        .len();
    if offset >= size {
        return Ok(String::new());
    }
    let read_len = clamp_read_len(size - offset, max_len);
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| ipc_error("read_stream_chunk: seek", e, "read failed"))?;
    let mut buf = vec![0u8; read_len];
    file.read_exact(&mut buf)
        .map_err(|e| ipc_error("read_stream_chunk: read", e, "read failed"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

// ---------------------------------------------------------------------------
// Cut-view audio waveform (perf-002)
//
// The play-004 timeline deck draws a ~240-bar audio waveform. The original
// implementation read the WHOLE audio-bearing file (capped at 48 MiB) across the
// IPC bridge as base64 4 MiB chunks, then ran WebAudio `decodeAudioData` over the
// entire clip in the WebView — an O(file size) CPU + memory spike (~200-400+ MiB
// transient for a 48 MiB clip) paid on EVERY open, even when the cut view is never
// shown (perf-001 ranked this the #1 bottleneck). `compute_waveform_peaks` moves
// that work natively: the bundled ffmpeg sidecar decodes the audio to coarse mono
// PCM and Rust downsamples it to ONLY the requested ~240 peaks, so the IPC transfer
// is O(bars) instead of O(file size) and the WebView never holds decoded audio.
// ---------------------------------------------------------------------------

/// Run a sidecar to completion and return (exit code, raw stdout, raw stderr).
///
/// LOAD-BEARING for binary stdout (found by native-002's filmstrip): the
/// plugin's own `output()` is line-oriented — it appends a newline after EVERY
/// stdout event, and even with `set_raw_out(true)` the events are pipe-buffer
/// CHUNKS, so any binary payload larger than one chunk (~8 KiB) gets 0x0A
/// bytes injected mid-stream. (Observed: only the one sub-8 KiB PNG cell
/// decoded; every larger cell was corrupt. The same mangling was quietly
/// distorting the waveform's f32 PCM.) This collects the raw chunk events
/// verbatim instead.
async fn sidecar_raw_output(
    cmd: tauri_plugin_shell::process::Command,
) -> Result<(Option<i32>, Vec<u8>, Vec<u8>), String> {
    use tauri_plugin_shell::process::CommandEvent;
    let (mut rx, _child) = cmd
        .set_raw_out(true)
        .spawn()
        .map_err(|_| "sidecar failed to start".to_string())?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code = None;
    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(chunk) => stdout.extend(chunk),
            CommandEvent::Stderr(chunk) => stderr.extend(chunk),
            CommandEvent::Terminated(payload) => code = payload.code,
            _ => {}
        }
    }
    Ok((code, stdout, stderr))
}

/// Mono sample rate ffmpeg resamples the audio to before the peak downsample. The
/// waveform is a coarse ~240-bar loudness envelope, so a low rate keeps the decoded
/// PCM small (a few MiB for a typical clip, tens of MiB even for a multi-hour movie)
/// while still leaving each bar hundreds of samples to take a max over. The heavy
/// decode happens in the ffmpeg subprocess (off the UI thread); only the final
/// `bars` floats cross the bridge.
const WAVE_PCM_RATE: u32 = 2000;

/// Clamp the WebView-requested bar count to a positive, sanely-small range (mirrors
/// `clamp_read_len`'s defensive intent — a hostile/buggy caller can't request a huge
/// allocation). The real caller always asks for `WAVEFORM_BARS` (240). Pure.
fn clamp_bars(bars: u32) -> usize {
    bars.clamp(1, 4096) as usize
}

/// ffmpeg arguments to decode a file's first audio stream to mono f32 little-endian
/// raw PCM at `rate` Hz on stdout. `-map 0:a:0?` makes the audio stream optional, so
/// a video with no audio simply produces no output (the caller then falls back to a
/// synthesized waveform) instead of being an error condition we must special-case.
/// Pure + unit-tested.
fn ffmpeg_waveform_args(src: &Path, rate: u32) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        src.to_string_lossy().into_owned(),
        "-map".into(),
        "0:a:0?".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        rate.to_string(),
        "-f".into(),
        "f32le".into(),
        "-".into(),
    ]
}

/// Reinterpret little-endian f32 PCM bytes as samples (a trailing partial frame, if
/// any, is ignored). Pure.
fn pcm_f32le_to_samples(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Peak-amplitude downsample of mono PCM `samples` into `bars` values normalized to
/// [0, 1] — the max absolute amplitude per evenly-sized bucket, divided by the global
/// max (floored at 1e-4 so a near-silent track doesn't divide by ~0). This mirrors
/// the frontend's former `downsamplePeaks` exactly, but runs natively so the WebView
/// never holds the decoded audio. Pure + unit-tested.
fn downsample_pcm_peaks(samples: &[f32], bars: usize) -> Vec<f32> {
    if bars == 0 || samples.is_empty() {
        return Vec::new();
    }
    let per = (samples.len() / bars).max(1);
    let mut peaks = Vec::with_capacity(bars);
    let mut max = 1e-4_f32;
    for i in 0..bars {
        let start = i * per;
        let mut peak = 0.0_f32;
        if start < samples.len() {
            let end = (start + per).min(samples.len());
            for &s in &samples[start..end] {
                let a = s.abs();
                if a > peak {
                    peak = a;
                }
            }
        }
        peaks.push(peak);
        if peak > max {
            max = peak;
        }
    }
    peaks.iter().map(|p| p / max).collect()
}

/// Compute the cut-view audio waveform peaks natively (perf-002). Decodes the file's
/// audio to coarse mono PCM via the bundled ffmpeg sidecar and returns ONLY `bars`
/// (~240) normalized peak values — turning the old O(file size) base64 read + WebAudio
/// decode into an O(bars) transfer with no decoded audio held in the WebView. Returns
/// an error when the file is unauthorized, has no audio stream, or can't be decoded;
/// the frontend then falls back to its synthesized placeholder waveform. The source
/// must already be authorized (the frontend calls `allow_media_dir` on open, the same
/// gate `read_stream_chunk` uses).
#[tauri::command]
async fn compute_waveform_peaks(
    app: tauri::AppHandle,
    allow: tauri::State<'_, AllowList>,
    path: String,
    bars: u32,
) -> Result<Vec<f32>, String> {
    let src = ensure_allowed(&allow, &path)?;
    let bars = clamp_bars(bars);

    let args = ffmpeg_waveform_args(&src, WAVE_PCM_RATE);
    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|_| "ffmpeg sidecar unavailable".to_string())?;
    // sidecar_raw_output (NOT the plugin's line-oriented output()) — the f32
    // PCM stream was being quietly distorted by injected newline bytes.
    let (code, stdout, _stderr) = sidecar_raw_output(sidecar.args(args))
        .await
        .map_err(|_| "waveform decode failed to start".to_string())?;

    if code != Some(0) || stdout.is_empty() {
        return Err("no decodable audio".to_string());
    }

    let samples = pcm_f32le_to_samples(&stdout);
    let peaks = downsample_pcm_peaks(&samples, bars);
    if peaks.is_empty() {
        return Err("no audio samples".to_string());
    }
    Ok(peaks)
}

// ---------------------------------------------------------------------------
// Cut-view filmstrip stills (native-002)
//
// Under the native engine the clip plays UNREMUXED (fragmented MP4, MPEG-TS —
// exactly what the hidden filmstrip generator <video> cannot decode), so the
// timeline deck's 12 thumbnails are extracted natively instead: one bounded
// ffmpeg-sidecar still per cell, seeked with `-ss` before `-i` (a demuxer-index
// seek — never a scan) and returned as one small base64 PNG. The transfer is
// O(thumbnail), independent of file size, same discipline as the waveform.
// ---------------------------------------------------------------------------

/// Thumbnail dimension ceilings (the real caller asks for 160x90). Mirrors
/// `clamp_bars`' defensive intent: a hostile/buggy caller cannot request a
/// frame-sized allocation or a giant encode.
fn clamp_still_dims(width: u32, height: u32) -> (u32, u32) {
    (width.clamp(16, 480), height.clamp(16, 270))
}

/// True for the ISO-BMFF extensions whose demuxer accepts `use_mfra_for`
/// (matches the `player_load` probe gate). The option is a HARD ffmpeg error
/// ("Option not found") on any other demuxer, so it must be extension-gated.
fn is_mp4_family(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()),
        Some(ref e) if ["mp4", "m4v", "mov"].contains(&e.as_str())
    )
}

/// ffmpeg arguments for one filmstrip still: seek to `time_s` (input seek =
/// demuxer index jump + decode-to-target, never a full-file scan), decode one
/// frame, center-crop-scale it to exactly `width`x`height` (the same cover
/// crop the web generator's drawCover applies), and emit a PNG on stdout.
/// With `use_mfra`, `-use_mfra_for pts` makes the mov demuxer read the tail
/// mfra index of a zero-duration fragmented MP4 — without it the seek
/// degrades to a sequential every-fragment walk (the play-020 pathology; the
/// same reason mpv gets demuxer-lavf-o=use_mfra_for=pts). The caller passes
/// `is_mp4_family` here (and retries once with `false` if ffmpeg rejects the
/// option — see extract_video_still). Pure + unit-tested.
fn ffmpeg_still_args(src: &Path, time_s: f64, width: u32, height: u32, use_mfra: bool) -> Vec<String> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into()];
    if use_mfra {
        args.push("-use_mfra_for".into());
        args.push("pts".into());
    }
    args.extend([
        "-ss".into(),
        format!("{:.3}", time_s.max(0.0)),
        "-i".into(),
        src.to_string_lossy().into_owned(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        format!("scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}"),
        "-f".into(),
        "image2pipe".into(),
        "-c:v".into(),
        "png".into(),
        "-".into(),
    ]);
    args
}

/// Extract one cut-view filmstrip thumbnail natively (native-002): a single
/// `width`x`height` PNG of the frame at `time` seconds, base64-encoded (the
/// same string-over-IPC choice as `read_stream_chunk` — a Vec<u8> crosses
/// WebView2 as a slow JSON number[]). A time past EOF or an undecodable file
/// is an error; the frontend keeps that cell as a dark placeholder slot. The
/// source must already be authorized (`allow_media_dir` ran on open — the
/// same `ensure_allowed` gate every read command uses).
#[tauri::command]
async fn extract_video_still(
    app: tauri::AppHandle,
    allow: tauri::State<'_, AllowList>,
    path: String,
    time: f64,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let src = ensure_allowed(&allow, &path)?;
    let (width, height) = clamp_still_dims(width, height);

    // Env-gated observability (the smoke harness's PLAYBACK_TEST_LOG): which
    // cells were requested and why one failed. Inert in production.
    let tlog = player::test_log_path();
    let t0 = std::time::Instant::now();

    let use_mfra = is_mp4_family(&src);
    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|_| "ffmpeg sidecar unavailable".to_string())?;
    // sidecar_raw_output (NOT the plugin's line-oriented output()) — a PNG is
    // binary; injected newline bytes made every multi-chunk cell undecodable.
    let (mut code, mut stdout, mut stderr) =
        sidecar_raw_output(sidecar.args(ffmpeg_still_args(&src, time, width, height, use_mfra)))
            .await
            .map_err(|_| "still extraction failed to start".to_string())?;

    // A file with an ISO-BMFF extension but different actual bytes (a common
    // rename artifact — e.g. Matroska named .mp4) makes `-use_mfra_for` a
    // FATAL "Option not found": ffmpeg picks the demuxer by CONTENT, and an
    // unconsumed demuxer option aborts the run — while mpv content-probes and
    // plays such a file fine. Retry once without the option so it still gets
    // a filmstrip (review finding).
    if code != Some(0) && use_mfra {
        let retry = app
            .shell()
            .sidecar("ffmpeg")
            .map_err(|_| "ffmpeg sidecar unavailable".to_string())?;
        (code, stdout, stderr) =
            sidecar_raw_output(retry.args(ffmpeg_still_args(&src, time, width, height, false)))
                .await
                .map_err(|_| "still extraction failed to start".to_string())?;
    }

    if code != Some(0) || stdout.is_empty() {
        player::test_log(
            &tlog,
            t0,
            &format!(
                "ev=still-error time={time:.3} code={code:?} stderr={}",
                String::from_utf8_lossy(&stderr).replace(['\r', '\n'], " ")
            ),
        );
        return Err("no frame at this time".to_string());
    }
    player::test_log(
        &tlog,
        t0,
        &format!("ev=still time={time:.3} bytes={}", stdout.len()),
    );
    Ok(base64::engine::general_purpose::STANDARD.encode(&stdout))
}

// ---------------------------------------------------------------------------
// Gallery thumbnails (perf-005)
//
// The gallery grid used to point each tile's <img src> at the ORIGINAL file, so a
// folder of 51-megapixel photos made the WebView decode ~200 MB of bitmap per
// ~200 px tile — measured at 2.6 s of main-thread stalls, worst single block
// 1130 ms. These commands render a small JPEG once per source, cache it on disk,
// and hand the frontend a path to THAT instead.
// ---------------------------------------------------------------------------

/// Longest edge of a generated gallery thumbnail. Sized for a ~200 px grid tile on
/// a 2x display; small enough that a whole folder of them costs less than ONE
/// full-resolution decode.
const THUMB_MAX_PX: u32 = 480;

/// Persistent thumbnail cache directory (alongside the shader cache).
pub(crate) fn thumb_cache_dir() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
    }?;
    let dir = base.join(APP_IDENTIFIER).join("thumb-cache");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Cache file name for one thumbnail. Same FNV-1a scheme as `remux_output_name`:
/// keyed on path + size + mtime so an edited or replaced source re-renders rather
/// than serving a stale tile, and on `max_px` so a size change is not a false hit.
fn thumb_cache_name(canonical_src: &Path, size: u64, mtime_secs: u64, max_px: u32) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mix = |hash: &mut u64, bytes: &[u8]| {
        for &b in bytes {
            *hash ^= u64::from(b);
            *hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    mix(&mut hash, canonical_src.to_string_lossy().as_bytes());
    mix(&mut hash, &size.to_le_bytes());
    mix(&mut hash, &mtime_secs.to_le_bytes());
    mix(&mut hash, &max_px.to_le_bytes());
    format!("pb-th-{hash:016x}.jpg")
}

/// Where a probed video duration is memoised (gallery-003), keyed exactly like the
/// thumbnail for the same source so editing the file invalidates both together.
///
/// `max_px` is fixed at 0 — no thumbnail is ever requested at that size, so the hash
/// can never collide with the JPEG's — and the `.dur` extension keeps the two apart
/// on disk even if it did.
fn duration_cache_path(dir: &Path, canonical_src: &Path, size: u64, mtime_secs: u64) -> PathBuf {
    let name = thumb_cache_name(canonical_src, size, mtime_secs, 0);
    dir.join(name.replace(".jpg", ".dur"))
}

/// True for a file this app put in the thumbnail cache — the JPEG tiles and the
/// gallery-003 `.dur` duration memos alike, so the pruner expires both.
fn is_prunable_cache_file(name: &str) -> bool {
    name.starts_with("pb-th-") && (name.ends_with(".jpg") || name.ends_with(".dur"))
}

/// Drop thumbnails and archive mirrors not touched in 30 days, so the cache
/// cannot grow without bound.
///
/// gallery-004: a mirror is a DIRECTORY, so it is removed recursively. A mirror
/// still in use is only ever removed after 30 days with no writes to it, and
/// re-materializes transparently on the next open — a cache miss, not a fault.
fn prune_thumb_cache(dir: &Path) {
    const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let prunable = if is_dir {
            archive::is_prunable_cache_dir(&name)
        } else {
            is_prunable_cache_file(&name)
        };
        if !prunable {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| m.elapsed().map(|age| age > MAX_AGE).unwrap_or(false))
            .unwrap_or(false);
        if stale {
            if is_dir {
                let _ = fs::remove_dir_all(entry.path());
            } else {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// Where in a VIDEO to grab the poster frame. A few seconds in avoids the black or
/// title frame most recordings open on, while staying inside even short clips
/// (a source shorter than this falls back to a seek of 0 — see `media_thumbnail`).
const THUMB_VIDEO_SEEK_S: f64 = 3.0;

/// ffmpeg args rendering ONE downscaled JPEG thumbnail to `dst`. Pure + unit-tested.
///
/// `-frames:v 1` takes only the first frame, so an animated GIF/WebP yields a still
/// poster rather than a re-encoded animation. The scale expression fits the image
/// INSIDE the box and never upscales a source already smaller than it.
///
/// `seek` (videos only) is placed BEFORE `-i` so it is a demuxer index jump rather
/// than a decode-and-discard scan, and `use_mfra` mirrors the native-002 still
/// extractor: libavformat only reads a fragmented MP4's tail index with it, without
/// which seeking a zero-duration recording walks every fragment.
fn ffmpeg_thumb_args(
    src: &Path,
    dst: &Path,
    max_px: u32,
    seek: Option<f64>,
    use_mfra: bool,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
    ];
    if use_mfra {
        args.push("-use_mfra_for".into());
        args.push("pts".into());
    }
    if let Some(s) = seek {
        args.push("-ss".into());
        args.push(format!("{:.3}", s.max(0.0)));
    }
    args.extend([
        "-i".into(),
        src.to_string_lossy().into_owned(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        format!(
            "scale='min({max_px},iw)':'min({max_px},ih)':force_original_aspect_ratio=decrease"
        ),
        "-q:v".into(),
        "4".into(),
        dst.to_string_lossy().into_owned(),
    ]);
    args
}

/// Render (or serve from cache) a small thumbnail for one image OR video,
/// returning the cached file's path. The frontend feeds that path to
/// `convertFileSrc`, so a tile loads a ~50 KB JPEG instead of the original.
///
/// Videos get a poster frame a few seconds in; if that fails (a clip shorter than
/// the seek, or an extension whose real container rejects `-use_mfra_for`, the
/// same rename artifact `extract_video_still` guards against) it retries with the
/// option dropped and then from the very start, so a short or odd file still gets
/// a picture rather than falling back to a gradient.
#[tauri::command]
async fn media_thumbnail(
    app: tauri::AppHandle,
    allow: tauri::State<'_, AllowList>,
    path: String,
) -> Result<String, String> {
    let src = ensure_allowed(&allow, &path)?;
    let meta = fs::metadata(&src).map_err(|_| "file not found".to_string())?;
    let size = meta.len();
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cache_dir = thumb_cache_dir().ok_or_else(|| "no thumbnail cache".to_string())?;
    let out = cache_dir.join(thumb_cache_name(&src, size, mtime_secs, THUMB_MAX_PX));

    // Authorize the cache directory for both read gates before returning, so the
    // WebView may actually load the tile (same pattern as the remux temp dir).
    let canonical_cache = fs::canonicalize(&cache_dir).unwrap_or_else(|_| cache_dir.clone());
    authorize_dir(&app, &allow, canonical_cache, Some(cache_dir.as_path()));

    // Cache hit: a non-empty thumbnail already exists for this exact source.
    if fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(out.to_string_lossy().into_owned());
    }

    let is_video = has_queue_video_ext(&src);
    // Attempts, best first. Images need only one; a video degrades seek -> no-mfra
    // -> start-of-file rather than giving up.
    let attempts: Vec<(Option<f64>, bool)> = if is_video {
        if is_mp4_family(&src) {
            vec![
                (Some(THUMB_VIDEO_SEEK_S), true),
                (Some(THUMB_VIDEO_SEEK_S), false),
                (Some(0.0), false),
            ]
        } else {
            vec![(Some(THUMB_VIDEO_SEEK_S), false), (Some(0.0), false)]
        }
    } else {
        vec![(None, false)]
    };

    for (seek, use_mfra) in attempts {
        let sidecar = app
            .shell()
            .sidecar("ffmpeg")
            .map_err(|_| "ffmpeg sidecar unavailable".to_string())?;
        let output = sidecar
            .args(ffmpeg_thumb_args(&src, &out, THUMB_MAX_PX, seek, use_mfra))
            .output()
            .await
            .map_err(|_| "thumbnail failed to start".to_string())?;
        if output.status.success() && fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false) {
            return Ok(out.to_string_lossy().into_owned());
        }
        let _ = fs::remove_file(&out); // never leave a 0-byte file to be cache-hit
    }
    Err("could not render a thumbnail".to_string())
}

/// Prepare the thumbnail cache for a gallery open: create + authorize the directory
/// and prune stale entries once, so the per-image command does no extra work.
#[tauri::command]
fn prepare_thumb_cache(app: tauri::AppHandle, allow: tauri::State<'_, AllowList>) {
    let Some(dir) = thumb_cache_dir() else { return };
    prune_thumb_cache(&dir);
    let canonical = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
    authorize_dir(&app, &allow, canonical, Some(dir.as_path()));
}

/// Parse the running time out of what `ffmpeg -i <file>` writes to stderr.
///
/// Given no output file, ffmpeg prints the input's header block and exits non-zero;
/// the line wanted here reads `Duration: 00:01:34.56, start: ..., bitrate: ...`.
///
/// A recording whose container carries no honest duration (a zero-duration
/// fragmented MP4 — the play-020 shape) prints `Duration: N/A`, and anything
/// unparseable is treated the same way: `None`, so the tile shows NO badge rather
/// than a fabricated `0:00`. Pure + unit-tested.
fn parse_ffmpeg_duration(stderr: &str) -> Option<f64> {
    let field = stderr.split("Duration: ").nth(1)?.split(',').next()?.trim();
    let mut parts = field.split(':');
    let hours: f64 = parts.next()?.trim().parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None; // more fields than h:m:s — not a shape this understands
    }
    let total = hours * 3600.0 + minutes * 60.0 + seconds;
    (total.is_finite() && total > 0.0).then_some(total)
}

/// The running time of one video, for the gallery tile's duration badge
/// (gallery-003). `None` means "no badge" — an unreadable or duration-less file is
/// shown without one rather than with a made-up number.
///
/// This is a HEADER read, not a decode: ffmpeg is given no output file, so it prints
/// the input block and stops. The answer is then memoised next to the thumbnail
/// cache under the same source+size+mtime key, so scrolling back over a folder — or
/// reopening it in a later session — re-probes nothing. A negative result is cached
/// too, so a file that has no duration is not re-probed on every visit.
#[tauri::command]
async fn video_duration(
    app: tauri::AppHandle,
    allow: tauri::State<'_, AllowList>,
    path: String,
) -> Result<Option<f64>, String> {
    let src = ensure_allowed(&allow, &path)?;
    if !has_queue_video_ext(&src) {
        return Ok(None); // an image tile never asks, but never trust the caller
    }
    let meta = fs::metadata(&src).map_err(|_| "file not found".to_string())?;
    let size = meta.len();
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cache = thumb_cache_dir().map(|dir| duration_cache_path(&dir, &src, size, mtime_secs));

    if let Some(memo) = cache.as_ref().and_then(|p| fs::read_to_string(p).ok()) {
        // "none" (or any unparseable content) round-trips back to None.
        return Ok(memo.trim().parse::<f64>().ok());
    }

    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|_| "ffmpeg sidecar unavailable".to_string())?;
    let output = sidecar
        .args([
            "-hide_banner".to_string(),
            "-i".to_string(),
            src.to_string_lossy().into_owned(),
        ])
        .output()
        .await
        .map_err(|_| "duration probe failed to start".to_string())?;
    // ffmpeg always exits non-zero here (no output file was given), so the status is
    // not the signal — the header it printed on the way out is.
    let seconds = parse_ffmpeg_duration(&String::from_utf8_lossy(&output.stderr));

    if let Some(path) = cache.as_ref() {
        let _ = fs::write(
            path,
            seconds.map(|s| s.to_string()).unwrap_or_else(|| "none".to_string()),
        );
    }
    Ok(seconds)
}

/// Video container extensions the folder queue enumerates (play-013). Mirrors the
/// frontend's `VIDEO_EXTENSIONS` — the natively-decodable containers plus the
/// MPEG-TS family (.ts/.m2ts/.mts), which the frontend remuxes to .mp4 on open
/// (play-016). Image formats are intentionally excluded: auto-advance keys off the
/// <video> "ended" event, which a still/animated image never fires, so images are
/// not part of the auto-advancing video queue.
const QUEUE_VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "webm", "ogg", "ogv", "mov", "m4v", "mkv", "avi", "ts", "m2ts", "mts",
];

/// True when `path`'s extension is one the folder queue treats as a video
/// (case-insensitive). A file with no extension is not a video.
pub(crate) fn has_queue_video_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| QUEUE_VIDEO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Image formats the gallery / photo sibling-nav enumerates (gallery-001):
/// mirrors the frontend's `IMAGE_EXTENSIONS` — the play-012 animated set
/// (gif/webp/apng/png) plus the additional static formats a Chromium WebView can
/// actually decode/display (jpg/jpeg/bmp/avif/ico). TIFF is deliberately excluded
/// — `<img>` cannot render it, so it would only ever reach the honest error state.
const GALLERY_IMAGE_EXTENSIONS: &[&str] = &[
    "gif", "webp", "apng", "png", "jpg", "jpeg", "bmp", "avif", "ico",
];

/// True when `path`'s extension is one the gallery treats as an image
/// (case-insensitive). A file with no extension is not an image.
pub(crate) fn has_gallery_image_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| GALLERY_IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Enumerate the files directly inside `dir` that satisfy `matches` (a predicate
/// like `has_queue_video_ext` / `has_gallery_image_ext`), returning paths rooted
/// at `raw_dir` when given — so each round-trips through `convertFileSrc` and the
/// asset-protocol scope grant (keyed on that raw, non-canonical dir) — or at `dir`
/// itself otherwise. Subdirectories and non-matching files are skipped. Shared by
/// `list_folder_videos_impl` (play-013) and `list_folder_images_impl` (gallery-001).
fn list_dir_entries_matching(
    dir: &Path,
    raw_dir: Option<&Path>,
    matches: impl Fn(&Path) -> bool,
    context: &str,
) -> Result<Vec<String>, String> {
    let entries =
        fs::read_dir(dir).map_err(|e| ipc_error(context, e, "could not list folder"))?;
    let mut out: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_file() || !matches(&entry_path) {
            continue;
        }
        let name = entry.file_name();
        let full = match raw_dir {
            Some(dir) => dir.join(&name),
            None => entry_path,
        };
        out.push(full.to_string_lossy().into_owned());
    }
    Ok(out)
}

/// List the sibling video files in the directory of an opened video so the frontend
/// can build a folder "queue" that auto-advances (play-013). The opened file must
/// already be authorized — the frontend calls `allow_media_dir` before this — so we
/// scope-check it through the SAME `ensure_allowed` gate the read commands use and
/// then enumerate only its parent directory. That directory is exactly the one
/// sec-002 already trusts for this file, so the queue introduces no new filesystem
/// reach: it cannot list any folder the user has not opened a file from.
///
/// Returns absolute sibling paths built from the RAW (non-verbatim) parent the
/// WebView passed, so each path round-trips through `convertFileSrc` and the
/// asset-protocol scope grant (which is keyed on that raw dir) — not the canonical
/// `\\?\`-prefixed form. Ordering is left to the frontend's unit-tested natural
/// sort. Non-video files and subdirectories are skipped.
#[tauri::command]
fn list_folder_videos(
    allow: tauri::State<'_, AllowList>,
    path: String,
) -> Result<Vec<String>, String> {
    list_folder_videos_impl(&allow, &path)
}

/// Core of `list_folder_videos`, taking `&AllowList` directly so it is unit-testable
/// without a `tauri::State`. The command is a thin wrapper over this.
fn list_folder_videos_impl(allow: &AllowList, path: &str) -> Result<Vec<String>, String> {
    // Scope-check the opened file (canonicalizing resolves `..`/symlinks) and use the
    // canonical directory to actually read — so we enumerate the real trusted folder.
    let canonical = ensure_allowed(allow, path)?;
    let canonical_dir = canonical
        .parent()
        .ok_or_else(|| "invalid path".to_string())?;
    // Build returned paths from the raw parent (matches convertFileSrc / asset scope).
    let raw_dir = Path::new(path).parent();
    list_dir_entries_matching(
        canonical_dir,
        raw_dir,
        has_queue_video_ext,
        "list_folder_videos: read_dir",
    )
}

/// List the images belonging to a gallery (gallery-001) — either the sibling images
/// of an opened photo (single-photo sibling nav) or, when `path` is itself an
/// authorized FOLDER (the "Open folder" gallery entry point), that folder's images
/// directly. `allow_media_dir` authorizes both shapes identically (a directory
/// authorizes itself; a file authorizes its parent), so this only needs to check
/// which shape `ensure_allowed` resolved to. Same trust model as
/// `list_folder_videos_impl`: no new filesystem reach beyond what sec-002 already
/// granted.
#[tauri::command]
fn list_folder_images(
    allow: tauri::State<'_, AllowList>,
    path: String,
) -> Result<Vec<String>, String> {
    list_folder_images_impl(&allow, &path)
}

/// Core of `list_folder_images`, taking `&AllowList` directly so it is unit-testable
/// without a `tauri::State`. The command is a thin wrapper over this.
fn list_folder_images_impl(allow: &AllowList, path: &str) -> Result<Vec<String>, String> {
    let canonical = ensure_allowed(allow, path)?;
    let (canonical_dir, raw_dir) = resolve_listing_dir(&canonical, path)?;
    list_dir_entries_matching(
        &canonical_dir,
        raw_dir.as_deref(),
        has_gallery_image_ext,
        "list_folder_images: read_dir",
    )
}

/// Resolve a listing target to the directory to actually READ (canonical, so the
/// real trusted folder is enumerated) and the directory returned paths are ROOTED
/// at (raw, so each round-trips through `convertFileSrc` and the asset-protocol
/// scope grant — on Windows the canonical form carries a `\\?\` verbatim prefix
/// that would not match the glob).
///
/// A FOLDER lists itself; a FILE lists its parent. Both listing commands accept
/// either shape, and `allow_media_dir` authorizes them identically, so this is the
/// one place that mapping lives.
fn resolve_listing_dir(
    canonical: &Path,
    raw: &str,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    if canonical.is_dir() {
        Ok((canonical.to_path_buf(), Some(Path::new(raw).to_path_buf())))
    } else {
        Ok((
            canonical
                .parent()
                .ok_or_else(|| "invalid path".to_string())?
                .to_path_buf(),
            Path::new(raw).parent().map(Path::to_path_buf),
        ))
    }
}

/// A gallery folder's browsable contents, split by kind (gallery-002, gallery-003).
/// Serialized to the WebView as `{ folders, images, videos }`.
///
/// Videos stay a separate list from images rather than one merged "media" vec: the
/// frontend re-interleaves them for display, but the two kinds open different
/// viewers, and keeping them apart here means no caller can conflate them.
#[derive(Debug, PartialEq, serde::Serialize)]
struct FolderEntries {
    folders: Vec<String>,
    images: Vec<String>,
    videos: Vec<String>,
    /// gallery-004: archives, which the grid shows as folder-like tiles.
    archives: Vec<String>,
}

/// List a gallery folder's SUBFOLDERS as well as its images (gallery-002), so the
/// grid can show a folder as a tile you click to descend into.
///
/// `list_folder_images` deliberately stays images-only: it also feeds the photo
/// viewer's sibling Prev/Next queue, which must never land on a directory. This
/// command is the grid's listing instead, and it does the whole job in ONE
/// `read_dir` rather than walking the folder twice.
///
/// Trust model is unchanged from gallery-001. `ensure_allowed` is a prefix check
/// (`path_within_roots`), so an authorized gallery folder already covers its whole
/// subtree — descending into a subfolder grants no new filesystem reach; the
/// frontend's existing `allow_media_dir` call only extends the (non-recursive)
/// asset-protocol scope to the folder the user clicked into.
#[tauri::command]
fn list_folder_entries(
    allow: tauri::State<'_, AllowList>,
    path: String,
) -> Result<FolderEntries, String> {
    list_folder_entries_impl(&allow, &path)
}

/// Core of `list_folder_entries`, taking `&AllowList` directly so it is
/// unit-testable without a `tauri::State`.
fn list_folder_entries_impl(allow: &AllowList, path: &str) -> Result<FolderEntries, String> {
    let canonical = ensure_allowed(allow, path)?;
    let (canonical_dir, raw_dir) = resolve_listing_dir(&canonical, path)?;
    let entries = fs::read_dir(&canonical_dir)
        .map_err(|e| ipc_error("list_folder_entries: read_dir", e, "could not list folder"))?;
    let mut folders: Vec<String> = Vec::new();
    let mut images: Vec<String> = Vec::new();
    let mut videos: Vec<String> = Vec::new();
    let mut archives: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        // Dot-prefixed entries are tool/cache dirs (.git, .thumbnails), not albums.
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let entry_path = entry.path();
        let full = match raw_dir.as_deref() {
            Some(dir) => dir.join(&name),
            None => entry_path.clone(),
        };
        if entry_path.is_dir() {
            folders.push(full.to_string_lossy().into_owned());
        } else if entry_path.is_file() {
            // gallery-003: the same predicate the folder queue uses, so the grid and
            // auto-advance agree on what counts as a video.
            if has_gallery_image_ext(&entry_path) {
                images.push(full.to_string_lossy().into_owned());
            } else if has_queue_video_ext(&entry_path) {
                videos.push(full.to_string_lossy().into_owned());
            } else if archive::has_archive_ext(&entry_path) {
                // gallery-004: browsable as a directory, so it is a tile.
                archives.push(full.to_string_lossy().into_owned());
            }
        }
    }
    Ok(FolderEntries {
        folders,
        images,
        videos,
        archives,
    })
}

/// The image a folder TILE should show as its cover (gallery-002): the first image
/// directly inside `path`, by case-insensitive name, or `None` when the folder holds
/// none (the tile then keeps a plain folder glyph rather than a broken picture).
///
/// This deliberately returns a PATH rather than a rendered thumbnail, so the tile
/// goes through the existing `media_thumbnail` command — one cache, one render
/// pipeline, no duplicated ffmpeg plumbing. It does not recurse: a cover is a cheap
/// hint, not a search.
#[tauri::command]
fn folder_cover_image(
    allow: tauri::State<'_, AllowList>,
    path: String,
) -> Result<Option<String>, String> {
    folder_cover_image_impl(&allow, &path)
}

/// Core of `folder_cover_image`, taking `&AllowList` directly so it is
/// unit-testable without a `tauri::State`.
fn folder_cover_image_impl(allow: &AllowList, path: &str) -> Result<Option<String>, String> {
    let canonical = ensure_allowed(allow, path)?;
    if !canonical.is_dir() {
        return Ok(None);
    }
    let entries = fs::read_dir(&canonical)
        .map_err(|e| ipc_error("folder_cover_image: read_dir", e, "could not list folder"))?;
    let raw_dir = Path::new(path);
    // Track the smallest key seen rather than collecting + sorting the whole folder:
    // a cover only ever needs one entry, and this runs per folder tile on screen.
    // gallery-003 keeps two candidates so an image can outrank a video that sorts
    // earlier, without a second pass over the directory.
    let mut best_image: Option<(String, String)> = None;
    let mut best_video: Option<(String, String)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy().into_owned();
        if name_str.starts_with('.') {
            continue;
        }
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }
        let best = if has_gallery_image_ext(&entry_path) {
            &mut best_image
        } else if has_queue_video_ext(&entry_path) {
            &mut best_video
        } else {
            continue;
        };
        let key = name_str.to_lowercase();
        if best.as_ref().map(|(k, _)| key < *k).unwrap_or(true) {
            *best = Some((key, raw_dir.join(&name).to_string_lossy().into_owned()));
        }
    }
    // An image wins outright when there is one: `media_thumbnail` renders it with a
    // single decode, where a video costs a demux + seek. The video is the fallback
    // that keeps an all-clips folder from showing a bare glyph.
    Ok(best_image.or(best_video).map(|(_, full)| full))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First non-flag argument is treated as a file to open.
    let launch = first_file_arg(&std::env::args().collect::<Vec<_>>());

    // play-010: set the WebView2 GPU launch flag from the saved preference BEFORE
    // the webview is created (the flag is fixed at creation time). No-op unless the
    // user has turned hardware acceleration off.
    apply_hwaccel_launch_flag();

    tauri::Builder::default()
        // play-019: run as a SINGLE instance. Without this, double-clicking a video
        // ("Open with…") while Playback is already open spawned a SECOND process +
        // window; that second instance wrote the file to the shared localStorage
        // recents, but the already-open window never re-read it, so the recently-
        // played list only updated after closing and relaunching. With the plugin,
        // a second invocation is routed HERE instead of spawning a window: we focus
        // the existing window and forward the file path to the WebView, which loads
        // it through the same funnel as every other open — so recents (and the
        // player) update live. NOTE: must be the FIRST plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            if let Some(path) = first_file_arg(&argv) {
                let _ = app.emit("open-file", path);
            }
        }))
        .manage(LaunchPath(launch))
        .manage(AllowList::default())
        .manage(player::PlayerState::default())
        .manage(tags::TagsDb::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        // img-002: the image clipboard write. Only write_image is used; the
        // capability grants only that permission, not the plugin's default set
        // (which also allows READING the user's clipboard).
        .plugin(tauri_plugin_clipboard_manager::init())
        // native-001: tear the mpv engine down BEFORE the main window (the
        // parent of mpv's child HWND) is destroyed — destroying the wid window
        // under a live mpv VO is documented crash territory. The handler runs
        // synchronously during CloseRequested, so the HWND still exists.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    player::shutdown_player(&window.state::<player::PlayerState>());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            launch_path,
            allow_media_dir,
            stream_status,
            read_stream_chunk,
            compute_waveform_peaks,
            extract_video_still,
            is_fragmented_mp4,
            remux_ts,
            list_folder_videos,
            list_folder_images,
            list_folder_entries,
            folder_cover_image,
            archive::list_archive_entries,
            archive::archive_entry_file,
            archive::archive_cover_entry,
            media_thumbnail,
            video_duration,
            prepare_thumb_cache,
            get_hwaccel,
            set_hwaccel,
            get_engine_pref,
            set_engine_pref,
            perf_enabled,
            perf_log,
            reveal_in_explorer,
            image_info,
            copy_image_to_clipboard,
            tags::tags_for_item,
            tags::tag_apply,
            tags::tag_unapply,
            tags::tag_suggest,
            player::player_engine_status,
            player::player_load,
            player::player_stop,
            player::player_seek,
            player::player_set_pause,
            player::player_set_speed,
            player::player_set_volume,
            player::player_set_mute,
            player::player_set_loop_file,
            player::player_set_hwdec,
            player::player_frame_step,
            player::player_set_video_margin_ratio,
            player::player_screenshot,
            player::test_flags
        ])
        .run(tauri::generate_context!())
        .expect("error while running Playback");
}


// ---------------------------------------------------------------------------
// Image file actions (img-002)
//
// Reveal a photo in Explorer, and report what a viewer can tell the reader
// about it: file size plus whatever the camera wrote into EXIF. Copying the
// picture to the clipboard is the third action and lives entirely in the
// frontend, which already has the decoded pixels.
// ---------------------------------------------------------------------------

/// Strip Windows' extended-length prefix from a canonical path.
///
/// `fs::canonicalize` returns `\\?\C:\...` (and `\\?\UNC\server\share` for a
/// network path). That form is correct for the Win32 file APIs and WRONG for
/// Explorer, which does not parse it: handed one, Explorer silently opens a
/// window on Documents and selects nothing. A wrong result with no error, so
/// the prefix comes off before the path is passed on.
fn strip_extended_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path.to_string()
}

/// Explorer's arguments for "open the containing folder and select this file".
///
/// `/select,` and the path are ONE argument, not two. Split into two, Explorer
/// opens Documents and selects nothing — again a silent wrong result rather
/// than a failure, which is why this has a test of its own.
fn explorer_select_args(path: &str) -> Vec<String> {
    vec![format!("/select,{path}")]
}

/// What the info panel shows about a picture. Everything from EXIF is optional:
/// a screenshot or an exported PNG has none of it, and the panel omits the rows
/// rather than showing zeroes as though they were readings.
#[derive(serde::Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageInfo {
    size_bytes: u64,
    camera: Option<String>,
    taken: Option<String>,
    exposure: Option<String>,
    aperture: Option<String>,
    iso: Option<String>,
}

/// How much of a file to read looking for EXIF. The APP1 block sits within the
/// first few KB of a JPEG; 256 KB is generous for an oversized thumbnail or
/// maker-note blob and still bounded, so a 200 MB TIFF is not read whole just
/// to print a shutter speed.
const EXIF_SCAN_BYTES: u64 = 256 * 1024;

/// Pull the human-readable EXIF fields out of an image's leading bytes.
///
/// Never fails and never panics: a file with no EXIF, a truncated block, or a
/// hostile one all yield `None` for every field. The panel's job is to report
/// what is really there, so "absent" has to be representable and has to be what
/// anything unreadable produces.
fn exif_summary(bytes: &[u8]) -> ImageInfo {
    let mut out = ImageInfo::default();
    let mut cursor = std::io::Cursor::new(bytes);
    let reader = match exif::Reader::new().read_from_container(&mut cursor) {
        Ok(r) => r,
        Err(_) => return out,
    };

    // `display_value()` renders ASCII fields with surrounding quotes; the panel
    // wants the text itself.
    let text = |tag: exif::Tag| -> Option<String> {
        reader.get_field(tag, exif::In::PRIMARY).map(|f| {
            f.display_value().to_string().trim_matches('"').trim().to_string()
        })
    };
    let non_empty = |s: Option<String>| s.filter(|v| !v.is_empty());

    // A camera writes maker and model separately, and most models already start
    // with the maker ("Canon EOS R5"), so joining blindly gives "Canon Canon
    // EOS R5".
    let make = non_empty(text(exif::Tag::Make));
    let model = non_empty(text(exif::Tag::Model));
    out.camera = match (make, model) {
        (Some(mk), Some(md)) if md.starts_with(&mk) => Some(md),
        (Some(mk), Some(md)) => Some(format!("{mk} {md}")),
        (Some(mk), None) => Some(mk),
        (None, Some(md)) => Some(md),
        (None, None) => None,
    };

    // EXIF stores dates as "2026:03:14 09:21:07", but the crate's display already
    // renders a DateTime field as "2026-03-14 09:21:07" — normalizing the date half
    // and leaving the time alone. Re-normalizing here turned the TIME into
    // "09-21-07" as well, which is what the unit test caught.
    out.taken = non_empty(
        text(exif::Tag::DateTimeOriginal).or_else(|| text(exif::Tag::DateTime)),
    );

    // Shutter speed reads as a fraction, the way a camera displays it.
    out.exposure = reader
        .get_field(exif::Tag::ExposureTime, exif::In::PRIMARY)
        .and_then(|f| match &f.value {
            exif::Value::Rational(v) => v.first().copied(),
            _ => None,
        })
        .filter(|r| r.denom != 0 && r.num != 0)
        .map(|r| {
            if r.num >= r.denom {
                format!("{} s", r.to_f64())
            } else {
                format!("{}/{} s", 1, (r.denom as f64 / r.num as f64).round() as u64)
            }
        });

    out.aperture = reader
        .get_field(exif::Tag::FNumber, exif::In::PRIMARY)
        .and_then(|f| match &f.value {
            exif::Value::Rational(v) => v.first().copied(),
            _ => None,
        })
        .filter(|r| r.denom != 0)
        .map(|r| {
            let f = r.to_f64();
            // f/2.8 keeps its decimal; f/8 does not need ".0".
            if (f - f.round()).abs() < 0.05 {
                format!("f/{}", f.round() as u64)
            } else {
                format!("f/{f:.1}")
            }
        });

    out.iso = reader
        .get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .filter(|v| *v > 0)
        .map(|v| format!("ISO {v}"));

    out
}

/// Open the containing folder with this file selected.
///
/// `spawn_blocking` because launching a process blocks, and every command in
/// this app runs on the WebView2 UI thread otherwise (the rule gallery-004
/// established). Explorer's exit status is deliberately ignored: it returns 1
/// on success as often as not, so treating a non-zero status as failure would
/// report an error for a window that opened correctly.
#[tauri::command]
async fn reveal_in_explorer(allow: tauri::State<'_, AllowList>, path: String) -> Result<(), String> {
    let canonical = ensure_allowed(&allow, &path)?;
    let target = strip_extended_prefix(&canonical.to_string_lossy());
    tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("explorer.exe")
            .args(explorer_select_args(&target))
            .spawn()
            .map(|_| ())
            .map_err(|e| ipc_error("reveal_in_explorer: spawn", e, "could not open the folder"))
    })
    .await
    .map_err(|e| ipc_error("reveal_in_explorer: join", e, "could not open the folder"))?
}

/// File size plus the EXIF summary for the info panel. Dimensions and format are
/// NOT reported here — the frontend already has the decoded picture and its own
/// file extension, so asking the native side to decode the image again purely to
/// re-learn its width would be a second full decode for nothing.
#[tauri::command]
async fn image_info(allow: tauri::State<'_, AllowList>, path: String) -> Result<ImageInfo, String> {
    ensure_allowed(&allow, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path)
            .map_err(|e| ipc_error("image_info: metadata", e, "file not found"))?;
        let mut file = fs::File::open(&path)
            .map_err(|e| ipc_error("image_info: open", e, "file not found"))?;
        let mut head = Vec::new();
        // Bounded read: EXIF lives at the front, and the panel is not worth
        // pulling a multi-hundred-megabyte file through memory for.
        std::io::Read::take(&mut file, EXIF_SCAN_BYTES)
            .read_to_end(&mut head)
            .map_err(|e| ipc_error("image_info: read", e, "could not read this file"))?;
        let mut info = exif_summary(&head);
        info.size_bytes = meta.len();
        Ok(info)
    })
    .await
    .map_err(|e| ipc_error("image_info: join", e, "could not read this file"))?
}


/// Ceiling on one clipboard payload. A 4000x2400 photograph encodes to a few
/// megabytes of PNG; 64 MiB is far above any real picture and still bounded, so
/// a hostile or wedged caller cannot force an unbounded native allocation. Same
/// reasoning as `MAX_CHUNK` on `read_stream_chunk`.
const MAX_CLIPBOARD_PNG_BYTES: u64 = 64 * 1024 * 1024;

/// Decode the base64 PNG the WebView sends for a clipboard copy.
///
/// Base64, not a byte array, and PNG, not raw pixels — both deliberate. A raw
/// `Uint8Array` argument arrives on WebView2 as a JSON `number[]`, and the RGBA
/// of a 4000x2400 photograph is 38 MB, or 38 MILLION array elements: measured at
/// roughly six seconds for one Ctrl-C. Encoding to PNG in the WebView and
/// shipping it as a base64 string is the same transport `read_stream_chunk`
/// already uses, for the same reason.
///
/// The length is checked BEFORE decoding, so an oversized payload is refused
/// rather than allocated.
fn decode_clipboard_png(b64: &str) -> Result<Vec<u8>, String> {
    if b64.is_empty() {
        return Err("empty image payload".to_string());
    }
    // Base64 is 4 characters per 3 bytes; this bounds the decoded size without
    // decoding first.
    if (b64.len() as u64 / 4) * 3 > MAX_CLIPBOARD_PNG_BYTES {
        return Err("image too large to copy".to_string());
    }
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| ipc_error("copy_image_to_clipboard: base64", e, "could not copy this image"))
}

/// Put a picture on the system clipboard.
///
/// The WebView renders what is on screen (orientation baked in) to a PNG and
/// sends it here; this decodes it and hands it to the clipboard. Doing the write
/// natively means the WebView is never granted clipboard permission at all —
/// the capability deliberately does NOT include any `clipboard-manager:` grant,
/// so nothing running in the page can read or write the user's clipboard on its
/// own. Only this command can, and only with a picture.
#[tauri::command]
async fn copy_image_to_clipboard(app: tauri::AppHandle, png_base64: String) -> Result<(), String> {
    let bytes = decode_clipboard_png(&png_base64)?;
    tauri::async_runtime::spawn_blocking(move || {
        let image = tauri::image::Image::from_bytes(&bytes)
            .map_err(|e| ipc_error("copy_image_to_clipboard: decode", e, "could not copy this image"))?;
        use tauri_plugin_clipboard_manager::ClipboardExt;
        app.clipboard()
            .write_image(&image)
            .map_err(|e| ipc_error("copy_image_to_clipboard: write", e, "could not copy this image"))
    })
    .await
    .map_err(|e| ipc_error("copy_image_to_clipboard: join", e, "could not copy this image"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Build a fresh, isolated temp directory tree for a test.
    fn temp_root(tag: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pb-sec002-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn path_within_roots_matches_on_segment_boundaries() {
        let mut roots = HashSet::new();
        roots.insert(PathBuf::from("/home/me/Videos"));
        assert!(path_within_roots(&roots, Path::new("/home/me/Videos/clip.mp4")));
        assert!(path_within_roots(&roots, Path::new("/home/me/Videos"))); // the root itself
        assert!(!path_within_roots(&roots, Path::new("/home/me/Videos-secret/x"))); // prefix sibling
        assert!(!path_within_roots(&roots, Path::new("/etc/passwd")));
        // an empty allow-list denies everything
        assert!(!path_within_roots(&HashSet::new(), Path::new("/home/me/Videos/clip.mp4")));
    }

    #[test]
    fn ensure_allowed_serves_authorized_file_and_rejects_outside() {
        let base = temp_root("allow");
        let media = base.join("media");
        let secret = base.join("secret");
        fs::create_dir_all(&media).unwrap();
        fs::create_dir_all(&secret).unwrap();
        let clip = media.join("clip.mp4");
        let key = secret.join("id_rsa");
        fs::write(&clip, b"video bytes").unwrap();
        fs::write(&key, b"PRIVATE KEY").unwrap();

        // Authorize ONLY the media directory (as allow_media_dir would).
        let allow = AllowList::default();
        allow
            .0
            .lock()
            .unwrap()
            .insert(fs::canonicalize(&media).unwrap());

        // The opened file (and its waveform reads) are served.
        assert!(ensure_allowed(&allow, clip.to_str().unwrap()).is_ok());

        // A sibling secret file outside the authorized dir is rejected.
        assert_eq!(
            ensure_allowed(&allow, key.to_str().unwrap()),
            Err("path not allowed".to_string())
        );

        // A ../ traversal that escapes the authorized dir is rejected
        // (canonicalize resolves the .. before the check).
        let escape = media.join("..").join("secret").join("id_rsa");
        assert_eq!(
            ensure_allowed(&allow, escape.to_str().unwrap()),
            Err("path not allowed".to_string())
        );

        // A path that does not exist canonicalizes to nothing → generic error.
        let missing = media.join("nope.mp4");
        assert_eq!(
            ensure_allowed(&allow, missing.to_str().unwrap()),
            Err("file not found".to_string())
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn remux_output_name_is_deterministic_and_source_specific() {
        let a = Path::new("/media/clip.ts");
        let b = Path::new("/media/other.ts");
        // Same inputs -> same name (so re-opening the unchanged file is a cache hit).
        assert_eq!(
            remux_output_name(a, 1000, 42),
            remux_output_name(a, 1000, 42)
        );
        // A different path, a different size, or a different mtime each change the name
        // (so an edited/replaced source is re-remuxed rather than serving a stale .mp4).
        assert_ne!(remux_output_name(a, 1000, 42), remux_output_name(b, 1000, 42));
        assert_ne!(remux_output_name(a, 1000, 42), remux_output_name(a, 2000, 42));
        assert_ne!(remux_output_name(a, 1000, 42), remux_output_name(a, 1000, 43));
        // Shape: a stable prefix + .mp4 so prune_ts_cache can recognise its own files.
        let name = remux_output_name(a, 1000, 42);
        assert!(name.starts_with("pb-ts-"));
        assert!(name.ends_with(".mp4"));
    }

    #[test]
    fn ffmpeg_remux_args_stream_copy_into_faststart_mp4() {
        let args = ffmpeg_remux_args(Path::new("/in.ts"), Path::new("/out.mp4"));
        // Lossless stream copy (no re-encode), input/output positioned, faststart moov.
        let joined = args.join(" ");
        assert!(args.windows(2).any(|w| w == ["-c", "copy"]));
        assert!(args.windows(2).any(|w| w == ["-i", "/in.ts"]));
        assert!(args.windows(2).any(|w| w == ["-movflags", "+faststart"]));
        assert_eq!(args.last().map(String::as_str), Some("/out.mp4"));
        // No transcode flags slipped in (would make a large file slow to open).
        assert!(!joined.contains("libx264"));
    }

    #[test]
    fn ffmpeg_waveform_args_decode_first_audio_to_mono_f32le_pcm_on_stdout() {
        let args = ffmpeg_waveform_args(Path::new("/in.mp4"), 2000);
        // Input positioned; only the (optional) first audio stream is mapped.
        assert!(args.windows(2).any(|w| w == ["-i", "/in.mp4"]));
        assert!(args.windows(2).any(|w| w == ["-map", "0:a:0?"]));
        // Coarse mono PCM at the requested rate, raw f32le, written to stdout ("-").
        assert!(args.windows(2).any(|w| w == ["-ac", "1"]));
        assert!(args.windows(2).any(|w| w == ["-ar", "2000"]));
        assert!(args.windows(2).any(|w| w == ["-f", "f32le"]));
        assert_eq!(args.last().map(String::as_str), Some("-"));
        // No re-encode of the video / no transcode codec slipped in.
        assert!(!args.join(" ").contains("libx264"));
    }

    #[test]
    fn clamp_bars_keeps_request_positive_and_bounded() {
        assert_eq!(clamp_bars(240), 240); // the real caller's request passes through
        assert_eq!(clamp_bars(0), 1); // never zero (would yield no bars)
        assert_eq!(clamp_bars(1_000_000), 4096); // a hostile huge request is capped
    }

    #[test]
    fn ffmpeg_still_args_seek_before_input_one_png_frame_on_stdout() {
        let args = ffmpeg_still_args(Path::new("/clip.mkv"), 27.5, 160, 90, false);
        // INPUT seek (-ss before -i): a demuxer index jump, never a full scan.
        let ss = args.iter().position(|a| a == "-ss").expect("-ss present");
        let input = args.iter().position(|a| a == "-i").expect("-i present");
        assert!(ss < input, "-ss must precede -i (input seek)");
        assert_eq!(args[ss + 1], "27.500");
        assert!(args.windows(2).any(|w| w == ["-i", "/clip.mkv"]));
        // Exactly one frame, cover-cropped to the requested cell size, PNG on stdout.
        assert!(args.windows(2).any(|w| w == ["-frames:v", "1"]));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-vf"
                && w[1] == "scale=160:90:force_original_aspect_ratio=increase,crop=160:90"));
        assert!(args.windows(2).any(|w| w == ["-c:v", "png"]));
        assert_eq!(args.last().map(String::as_str), Some("-"));
        // NOT mp4-family: use_mfra_for is a hard ffmpeg error on other demuxers
        // ("Option not found", verified against the bundled sidecar).
        assert!(!args.iter().any(|a| a == "-use_mfra_for"));
    }

    #[test]
    fn ffmpeg_still_args_mp4_family_reads_the_tail_mfra_index() {
        // The load-bearing half of native-002's filmstrip: without use_mfra_for
        // the mov demuxer seeks a zero-duration fragmented MP4 by walking every
        // fragment sequentially (the play-020 pathology, ~GBs for a Twitch VOD).
        // The caller gates the flag on is_mp4_family (pinned here) and retries
        // once without it if ffmpeg rejects it (content-mismatched extension).
        for name in ["/rec.mp4", "/rec.M4V", "/rec.mov"] {
            assert!(is_mp4_family(Path::new(name)), "{name} should be mp4-family");
            let args = ffmpeg_still_args(Path::new(name), 5.0, 160, 90, true);
            let pos = args
                .iter()
                .position(|a| a == "-use_mfra_for")
                .unwrap_or_else(|| panic!("{name}: -use_mfra_for missing"));
            assert_eq!(args[pos + 1], "pts");
            let input = args.iter().position(|a| a == "-i").unwrap();
            assert!(pos < input, "{name}: demuxer option must precede -i");
        }
        assert!(!is_mp4_family(Path::new("/clip.mkv")));
        assert!(!is_mp4_family(Path::new("/clip.ts")));
        assert!(!is_mp4_family(Path::new("/noext")));
        // A negative time (defensive) clamps to 0 rather than an ffmpeg error.
        let args = ffmpeg_still_args(Path::new("/rec.mp4"), -3.0, 160, 90, true);
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[ss + 1], "0.000");
    }

    #[test]
    fn ffmpeg_thumb_args_render_one_downscaled_frame_to_a_file() {
        let args = ffmpeg_thumb_args(Path::new("/photo.jpg"), Path::new("/cache/t.jpg"), 480, None, false);
        assert!(args.windows(2).any(|w| w == ["-i", "/photo.jpg"]));
        // Exactly one frame: an animated GIF/WebP yields a still poster, never a
        // re-encoded animation.
        assert!(args.windows(2).any(|w| w == ["-frames:v", "1"]));
        // Fit INSIDE the box and never upscale a source already smaller than it.
        assert!(args.windows(2).any(|w| w[0] == "-vf"
            && w[1] == "scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease"));
        // Overwrite, and the destination is the final argument.
        assert!(args.iter().any(|a| a == "-y"));
        assert_eq!(args.last().map(String::as_str), Some("/cache/t.jpg"));
    }

    #[test]
    fn ffmpeg_thumb_args_seek_before_input_for_a_video_poster() {
        // A video poster seeks a few seconds in to skip the black/title frame most
        // recordings open on, and the seek must precede -i so it is a demuxer index
        // jump rather than a decode-and-discard scan.
        let args = ffmpeg_thumb_args(
            Path::new("/clip.mp4"),
            Path::new("/cache/t.jpg"),
            480,
            Some(THUMB_VIDEO_SEEK_S),
            true,
        );
        let ss = args.iter().position(|a| a == "-ss").expect("-ss present");
        let input = args.iter().position(|a| a == "-i").expect("-i present");
        assert!(ss < input, "-ss must precede -i (input seek)");
        assert_eq!(args[ss + 1], "3.000");
        // use_mfra_for is also a demuxer option, so it too must precede -i.
        let mfra = args.iter().position(|a| a == "-use_mfra_for").expect("mfra present");
        assert!(mfra < input);
        assert_eq!(args[mfra + 1], "pts");

        // Without the flag it must not appear at all: it is a HARD ffmpeg error on
        // a demuxer that does not accept it (the extract_video_still lesson).
        let plain = ffmpeg_thumb_args(
            Path::new("/clip.mkv"),
            Path::new("/cache/t.jpg"),
            480,
            Some(0.0),
            false,
        );
        assert!(!plain.iter().any(|a| a == "-use_mfra_for"));
        // A negative seek (defensive) clamps to 0 rather than an ffmpeg error.
        let neg = ffmpeg_thumb_args(Path::new("/c.mp4"), Path::new("/t.jpg"), 480, Some(-5.0), false);
        let ss = neg.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(neg[ss + 1], "0.000");
        // An IMAGE passes no seek at all.
        let img = ffmpeg_thumb_args(Path::new("/a.jpg"), Path::new("/t.jpg"), 480, None, false);
        assert!(!img.iter().any(|a| a == "-ss"));
    }

    #[test]
    fn thumb_cache_name_is_deterministic_and_invalidates_on_change() {
        let a = Path::new("/photos/a.jpg");
        let b = Path::new("/photos/b.jpg");
        // Same inputs -> same name, so revisiting an unchanged folder is a cache hit.
        assert_eq!(
            thumb_cache_name(a, 1000, 42, 480),
            thumb_cache_name(a, 1000, 42, 480)
        );
        // A different path, size, mtime, or requested size each re-render rather
        // than serving a stale or wrongly-sized tile.
        assert_ne!(thumb_cache_name(a, 1000, 42, 480), thumb_cache_name(b, 1000, 42, 480));
        assert_ne!(thumb_cache_name(a, 1000, 42, 480), thumb_cache_name(a, 2000, 42, 480));
        assert_ne!(thumb_cache_name(a, 1000, 42, 480), thumb_cache_name(a, 1000, 43, 480));
        assert_ne!(thumb_cache_name(a, 1000, 42, 480), thumb_cache_name(a, 1000, 42, 240));
        // Shape: a stable prefix + .jpg so prune_thumb_cache recognises its own files.
        let name = thumb_cache_name(a, 1000, 42, 480);
        assert!(name.starts_with("pb-th-"));
        assert!(name.ends_with(".jpg"));
    }

    #[test]
    fn clamp_still_dims_bounds_the_thumbnail_allocation() {
        assert_eq!(clamp_still_dims(160, 90), (160, 90)); // the real caller passes through
        assert_eq!(clamp_still_dims(0, 0), (16, 16)); // never zero (ffmpeg error)
        assert_eq!(clamp_still_dims(10_000, 10_000), (480, 270)); // hostile huge request capped
    }

    #[test]
    fn pcm_f32le_to_samples_parses_le_floats_and_drops_partial_frame() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1.0f32.to_le_bytes());
        bytes.extend_from_slice(&(-0.5f32).to_le_bytes());
        bytes.push(0x00); // a trailing partial frame is ignored
        let samples = pcm_f32le_to_samples(&bytes);
        assert_eq!(samples, vec![1.0, -0.5]);
    }

    #[test]
    fn downsample_pcm_peaks_takes_normalized_per_bucket_max_abs() {
        // 4 samples into 2 bars => 2 per bucket; peak is max |sample| per bucket,
        // normalized by the global max (0.8). Negative amplitudes count by abs.
        let peaks = downsample_pcm_peaks(&[0.1, 0.4, -0.8, 0.2], 2);
        assert_eq!(peaks.len(), 2);
        assert!((peaks[0] - 0.5).abs() < 1e-6); // 0.4 / 0.8
        assert!((peaks[1] - 1.0).abs() < 1e-6); // 0.8 / 0.8
    }

    #[test]
    fn downsample_pcm_peaks_edges_empty_and_more_bars_than_samples() {
        // No samples or zero bars => empty (the frontend then synthesizes a waveform).
        assert!(downsample_pcm_peaks(&[], 240).is_empty());
        assert!(downsample_pcm_peaks(&[0.5, 0.5], 0).is_empty());
        // More bars than samples: per=1, the extra bars beyond the data are 0, and the
        // result always has exactly `bars` entries (so the canvas draws every bar).
        let peaks = downsample_pcm_peaks(&[1.0, 0.5], 4);
        assert_eq!(peaks.len(), 4);
        assert!((peaks[0] - 1.0).abs() < 1e-6);
        assert!((peaks[1] - 0.5).abs() < 1e-6);
        assert_eq!(peaks[2], 0.0);
        assert_eq!(peaks[3], 0.0);
    }

    #[test]
    fn downsample_pcm_peaks_silent_track_stays_zero_not_nan() {
        // An all-zero (silent) track must not divide by ~0 — the 1e-4 floor keeps the
        // peaks at 0 (the frontend treats an all-zero result as "synthesize instead").
        let peaks = downsample_pcm_peaks(&[0.0; 16], 4);
        assert_eq!(peaks, vec![0.0, 0.0, 0.0, 0.0]);
        assert!(peaks.iter().all(|p| p.is_finite()));
    }

    #[test]
    fn ensure_allowed_denies_when_nothing_authorized() {
        let base = temp_root("deny");
        let clip = base.join("clip.mp4");
        fs::write(&clip, b"video bytes").unwrap();
        // No directory has been authorized — deny-by-default.
        let allow = AllowList::default();
        assert_eq!(
            ensure_allowed(&allow, clip.to_str().unwrap()),
            Err("path not allowed".to_string())
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn ipc_error_returns_generic_string_not_raw_os_detail() {
        // A raw OS error embedding an absolute path is exactly what F-5 says must
        // not cross the IPC boundary. ipc_error must hand the WebView only the
        // stable generic string — never the path-bearing detail.
        let detail = std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "The system cannot find the path specified: C:\\Users\\Abenezer\\secret\\id_rsa",
        );
        let msg = ipc_error("read_stream_chunk: open", detail, "read failed");
        assert_eq!(msg, "read failed");
        // No absolute path or username leaks through.
        assert!(!msg.contains("C:\\"));
        assert!(!msg.contains("Abenezer"));
        assert!(!msg.contains("secret"));
        // The other generic string the commands use is likewise pass-through-clean.
        assert_eq!(
            ipc_error("stream_status: metadata", "raw os detail", "file not found"),
            "file not found"
        );
    }

    #[test]
    fn browser_args_for_hwaccel_appends_flag_only_when_disabled() {
        // Hardware acceleration ON (the default): the launch args are untouched, so
        // production carries NO extra flag and GPU decode stays on.
        assert_eq!(browser_args_for_hwaccel("", true), "");
        assert_eq!(
            browser_args_for_hwaccel("--autoplay-policy=no-user-gesture-required", true),
            "--autoplay-policy=no-user-gesture-required"
        );

        // Hardware acceleration OFF: the software-decode flag is appended, PRESERVING
        // anything already present (e.g. the smoke harness's TEST-ONLY
        // DirectCompositionVideoOverlays flag set externally before launch).
        assert_eq!(browser_args_for_hwaccel("", false), SW_DECODE_FLAG);
        let test_flags = "--autoplay-policy=no-user-gesture-required --disable-features=DirectCompositionVideoOverlays";
        let combined = browser_args_for_hwaccel(test_flags, false);
        assert!(combined.starts_with(test_flags)); // the test flags survive
        assert!(combined.contains(SW_DECODE_FLAG)); // ...with the SW flag added

        // Idempotent: if the flag is already in the args it is not added twice.
        assert_eq!(browser_args_for_hwaccel(SW_DECODE_FLAG, false), SW_DECODE_FLAG);
        // A token that merely CONTAINS the flag as a prefix is not mistaken for it.
        let near = "--disable-accelerated-video-decode-foo";
        assert_eq!(
            browser_args_for_hwaccel(near, false),
            format!("{near} {SW_DECODE_FLAG}")
        );
    }

    #[test]
    fn hwaccel_pref_round_trips_through_the_file() {
        // Point the pref at an isolated temp dir for this test (the helper reads
        // %APPDATA% / XDG_CONFIG_HOME / HOME). Writing "off" must read back as
        // disabled; "on" / a missing file must read back as enabled (default ON).
        let base = temp_root("hwaccel");
        // Drive both the Windows (%APPDATA%) and Unix (XDG_CONFIG_HOME) branches.
        std::env::set_var("APPDATA", &base);
        std::env::set_var("XDG_CONFIG_HOME", &base);

        let path = hwaccel_pref_path().expect("a pref path");
        assert!(path.starts_with(&base));
        assert!(path.ends_with(PathBuf::from(APP_IDENTIFIER).join("hwaccel")));

        // No file yet → default ON.
        let _ = fs::remove_file(&path);
        assert!(read_hwaccel_pref());

        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "off").unwrap();
        assert!(!read_hwaccel_pref());

        fs::write(&path, "on").unwrap();
        assert!(read_hwaccel_pref());

        // Trailing whitespace/newlines are tolerated (the value is trimmed).
        fs::write(&path, "off\n").unwrap();
        assert!(!read_hwaccel_pref());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn normalize_engine_defaults_everything_but_web_to_native() {
        // native-003: the native engine is the default — only an explicit
        // "web" opts into the WebView compatibility engine.
        assert_eq!(normalize_engine("web"), "web");
        assert_eq!(normalize_engine(" web\n"), "web"); // file read w/ newline
        assert_eq!(normalize_engine("native"), "native");
        assert_eq!(normalize_engine(""), "native");
        assert_eq!(normalize_engine("WEB"), "native"); // unrecognized -> default
        assert_eq!(normalize_engine("mpv"), "native");
    }

    #[test]
    fn first_file_arg_skips_program_name_and_flags() {
        let s = |a: &str| a.to_string();
        // Program name only -> no file (a plain launch shows the home screen).
        assert_eq!(first_file_arg(&[s("playback.exe")]), None);
        // The first non-flag arg after argv[0] is the file ("Open with…").
        assert_eq!(
            first_file_arg(&[s("playback.exe"), s("C:\\Videos\\clip.mp4")]),
            Some("C:\\Videos\\clip.mp4".to_string())
        );
        // Leading flags are skipped; the first non-flag token wins.
        assert_eq!(
            first_file_arg(&[s("playback.exe"), s("--flag"), s("clip.mp4"), s("other.mp4")]),
            Some("clip.mp4".to_string())
        );
        // All flags -> no file (e.g. a single-instance relaunch with only switches).
        assert_eq!(first_file_arg(&[s("playback.exe"), s("--flag")]), None);
        // Empty argv (defensive) -> no file.
        assert_eq!(first_file_arg(&[]), None);
    }

    #[test]
    fn has_queue_video_ext_matches_video_containers_only() {
        // Video containers (case-insensitive), including the MPEG-TS family.
        for p in ["a.mp4", "B.MKV", "c.webm", "d.mov", "e.avi", "f.ts", "g.m2ts", "h.MTS"] {
            assert!(has_queue_video_ext(Path::new(p)), "{p} should be a video");
        }
        // Images, other files, and extensionless names are NOT part of the video queue.
        for p in ["a.gif", "b.png", "c.webp", "d.txt", "e.srt", "noext", "f."] {
            assert!(!has_queue_video_ext(Path::new(p)), "{p} should not be a video");
        }
    }

    #[test]
    fn list_folder_videos_returns_only_authorized_sibling_videos() {
        let base = temp_root("queue");
        let media = base.join("media");
        fs::create_dir_all(&media).unwrap();
        // A mix of videos, an image, a subtitle, and a subdirectory in the folder.
        for name in ["clip2.mp4", "clip10.mp4", "clip1.mkv", "poster.png", "notes.txt"] {
            fs::write(media.join(name), b"x").unwrap();
        }
        fs::create_dir_all(media.join("subdir")).unwrap();

        // Authorize the media dir (as allow_media_dir would on open).
        let allow = AllowList::default();
        allow
            .0
            .lock()
            .unwrap()
            .insert(fs::canonicalize(&media).unwrap());

        let opened = media.join("clip1.mkv");
        let mut got = list_folder_videos_impl(&allow, opened.to_str().unwrap()).unwrap();
        got.sort(); // read_dir order is platform-defined; sort for a stable assertion

        // Only the three video siblings come back — the image, the .txt, and the
        // subdirectory are excluded. Paths are rooted at the (raw) opened parent.
        let names: Vec<String> = got
            .iter()
            .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["clip1.mkv", "clip10.mp4", "clip2.mp4"]);
        // Every returned path is a child of the directory the user opened from.
        assert!(got.iter().all(|p| Path::new(p).parent() == Some(media.as_path())));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_folder_videos_denies_an_unauthorized_folder() {
        let base = temp_root("queue-deny");
        let media = base.join("media");
        fs::create_dir_all(&media).unwrap();
        let clip = media.join("clip.mp4");
        fs::write(&clip, b"x").unwrap();
        // Nothing authorized -> deny-by-default, same gate as the read commands.
        let allow = AllowList::default();
        assert_eq!(
            list_folder_videos_impl(&allow, clip.to_str().unwrap()),
            Err("path not allowed".to_string())
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn has_gallery_image_ext_matches_supported_image_containers_only() {
        for p in [
            "a.jpg", "B.JPEG", "c.png", "d.gif", "e.webp", "f.apng", "g.bmp", "h.avif", "i.ICO",
        ] {
            assert!(has_gallery_image_ext(Path::new(p)), "{p} should be a gallery image");
        }
        // Videos, other files, extensionless names, and TIFF (unrenderable by the
        // WebView's <img>) are NOT part of the gallery.
        for p in ["a.mp4", "b.mkv", "c.txt", "d.tiff", "e.TIF", "noext", "f."] {
            assert!(!has_gallery_image_ext(Path::new(p)), "{p} should not be a gallery image");
        }
    }

    #[test]
    fn list_folder_images_returns_sibling_images_from_an_opened_photo() {
        let base = temp_root("gallery-siblings");
        let media = base.join("photos");
        fs::create_dir_all(&media).unwrap();
        // A mix of images (incl. natural-order-sensitive names), a video, and a
        // subtitle in the folder, plus a subdirectory.
        for name in ["b.jpg", "a.png", "c10.jpeg", "c2.jpeg", "clip.mp4", "notes.txt"] {
            fs::write(media.join(name), b"x").unwrap();
        }
        fs::create_dir_all(media.join("subdir")).unwrap();

        // Authorize the media dir (as the extended allow_media_dir would for a FILE).
        let allow = AllowList::default();
        allow
            .0
            .lock()
            .unwrap()
            .insert(fs::canonicalize(&media).unwrap());

        let opened = media.join("a.png");
        let mut got = list_folder_images_impl(&allow, opened.to_str().unwrap()).unwrap();
        got.sort(); // read_dir order is platform-defined; sort for a stable assertion

        // Only the four image siblings come back — the video, the .txt, and the
        // subdirectory are excluded. Paths are rooted at the (raw) opened parent.
        let names: Vec<String> = got
            .iter()
            .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["a.png", "b.jpg", "c10.jpeg", "c2.jpeg"]);
        assert!(got.iter().all(|p| Path::new(p).parent() == Some(media.as_path())));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_folder_images_returns_the_folders_images_when_the_folder_itself_is_opened() {
        let base = temp_root("gallery-folder");
        let media = base.join("photos");
        fs::create_dir_all(&media).unwrap();
        for name in ["one.jpg", "two.png", "clip.mp4"] {
            fs::write(media.join(name), b"x").unwrap();
        }

        // Authorize the FOLDER itself (as the extended allow_media_dir now does for
        // a directory, the "Open folder" gallery entry point).
        let allow = AllowList::default();
        allow
            .0
            .lock()
            .unwrap()
            .insert(fs::canonicalize(&media).unwrap());

        let mut got = list_folder_images_impl(&allow, media.to_str().unwrap()).unwrap();
        got.sort();
        let names: Vec<String> = got
            .iter()
            .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["one.jpg", "two.png"]);
        assert!(got.iter().all(|p| Path::new(p).parent() == Some(media.as_path())));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_folder_images_denies_an_unauthorized_folder() {
        let base = temp_root("gallery-deny");
        let media = base.join("photos");
        fs::create_dir_all(&media).unwrap();
        let photo = media.join("a.jpg");
        fs::write(&photo, b"x").unwrap();
        // Nothing authorized -> deny-by-default, same gate as the read commands.
        let allow = AllowList::default();
        assert_eq!(
            list_folder_images_impl(&allow, photo.to_str().unwrap()),
            Err("path not allowed".to_string())
        );
        // Denied for the bare folder too, not just the file inside it.
        assert_eq!(
            list_folder_images_impl(&allow, media.to_str().unwrap()),
            Err("path not allowed".to_string())
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_folder_entries_returns_subfolders_alongside_images() {
        let base = temp_root("gallery-entries");
        let media = base.join("photos");
        fs::create_dir_all(&media).unwrap();
        for name in ["b.jpg", "a.png", "clip.mp4", "notes.txt"] {
            fs::write(media.join(name), b"x").unwrap();
        }
        for dir in ["Sub-One", "Sub-Two", ".hidden"] {
            fs::create_dir_all(media.join(dir)).unwrap();
        }

        let allow = AllowList::default();
        allow
            .0
            .lock()
            .unwrap()
            .insert(fs::canonicalize(&media).unwrap());

        let mut got = list_folder_entries_impl(&allow, media.to_str().unwrap()).unwrap();
        got.folders.sort();
        got.images.sort();

        let names = |v: &Vec<String>| -> Vec<String> {
            v.iter()
                .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned())
                .collect()
        };
        // gallery-002: subdirectories now come back in their OWN list (the images
        // list is unchanged from gallery-001 — no video, no .txt, no directory).
        // A dot-prefixed directory is skipped: those are tool/cache dirs, not albums.
        assert_eq!(names(&got.folders), vec!["Sub-One", "Sub-Two"]);
        assert_eq!(names(&got.images), vec!["a.png", "b.jpg"]);
        // Both lists are rooted at the RAW opened dir, so each round-trips through
        // convertFileSrc and the asset-protocol scope grant.
        assert!(got
            .folders
            .iter()
            .chain(got.images.iter())
            .all(|p| Path::new(p).parent() == Some(media.as_path())));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_folder_entries_returns_a_subfolder_of_an_authorized_root() {
        // Descending is the whole point of gallery-002: the parent grant already
        // covers the subtree (path_within_roots is a prefix check), so opening a
        // sub-gallery needs no new authorization.
        let base = temp_root("gallery-descend");
        let media = base.join("photos");
        let sub = media.join("Sub-One");
        fs::create_dir_all(&sub).unwrap();
        fs::write(media.join("top.jpg"), b"x").unwrap();
        fs::write(sub.join("inner.png"), b"x").unwrap();

        let allow = AllowList::default();
        allow
            .0
            .lock()
            .unwrap()
            .insert(fs::canonicalize(&media).unwrap()); // only the PARENT

        let got = list_folder_entries_impl(&allow, sub.to_str().unwrap()).unwrap();
        assert!(got.folders.is_empty());
        assert_eq!(
            got.images
                .iter()
                .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["inner.png"]
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_folder_entries_denies_an_unauthorized_folder() {
        let base = temp_root("gallery-entries-deny");
        let media = base.join("photos");
        fs::create_dir_all(media.join("Sub-One")).unwrap();
        let allow = AllowList::default();
        assert_eq!(
            list_folder_entries_impl(&allow, media.to_str().unwrap()),
            Err("path not allowed".to_string())
        );
        // ...and the subfolder is denied too when nothing above it is authorized.
        assert_eq!(
            list_folder_entries_impl(&allow, media.join("Sub-One").to_str().unwrap()),
            Err("path not allowed".to_string())
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn folder_cover_image_picks_the_first_image_or_none() {
        let base = temp_root("gallery-cover");
        let media = base.join("photos");
        let empty = base.join("empty");
        fs::create_dir_all(&media).unwrap();
        fs::create_dir_all(&empty).unwrap();
        // Deliberately written out of order, and with a non-image sorting first.
        for name in ["zebra.png", "apple.jpg", "aardvark.txt"] {
            fs::write(media.join(name), b"x").unwrap();
        }
        fs::create_dir_all(media.join("aaa-subdir")).unwrap();
        fs::write(empty.join("notes.txt"), b"x").unwrap();

        let allow = AllowList::default();
        let mut roots = allow.0.lock().unwrap();
        roots.insert(fs::canonicalize(&media).unwrap());
        roots.insert(fs::canonicalize(&empty).unwrap());
        drop(roots);

        // The cover is the first IMAGE by case-insensitive name — the .txt and the
        // subdirectory (both of which sort earlier) are not candidates.
        let cover = folder_cover_image_impl(&allow, media.to_str().unwrap()).unwrap();
        assert_eq!(
            Path::new(cover.as_deref().unwrap())
                .file_name()
                .unwrap()
                .to_string_lossy(),
            "apple.jpg"
        );
        // A folder with no images has no cover — the tile keeps its folder glyph
        // rather than showing a broken image.
        assert_eq!(folder_cover_image_impl(&allow, empty.to_str().unwrap()), Ok(None));
        // Same deny-by-default gate as every other listing command.
        assert_eq!(
            folder_cover_image_impl(&AllowList::default(), media.to_str().unwrap()),
            Err("path not allowed".to_string())
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_folder_entries_returns_videos_in_their_own_list() {
        // gallery-003: the grid shows videos too, but they stay a SEPARATE list from
        // the images — `list_folder_images` (the photo viewer's Prev/Next queue) must
        // remain photos-only, so the two kinds can never be conflated in one vec.
        let base = temp_root("gallery-videos");
        let media = base.join("mixed");
        fs::create_dir_all(&media).unwrap();
        for name in ["b.jpg", "clip.MP4", "movie.mkv", "notes.txt", "audio.mp3"] {
            fs::write(media.join(name), b"x").unwrap();
        }
        fs::create_dir_all(media.join("Sub-One")).unwrap();

        let allow = AllowList::default();
        allow
            .0
            .lock()
            .unwrap()
            .insert(fs::canonicalize(&media).unwrap());

        let mut got = list_folder_entries_impl(&allow, media.to_str().unwrap()).unwrap();
        got.folders.sort();
        got.images.sort();
        got.videos.sort();

        let names = |v: &Vec<String>| -> Vec<String> {
            v.iter()
                .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned())
                .collect()
        };
        assert_eq!(names(&got.folders), vec!["Sub-One"]);
        assert_eq!(names(&got.images), vec!["b.jpg"]);
        // An uppercase extension counts (the match is case-insensitive), while a
        // .txt and an audio-only .mp3 are neither image nor video.
        assert_eq!(names(&got.videos), vec!["clip.MP4", "movie.mkv"]);
        // Videos are rooted at the RAW opened dir like the other two lists, so a
        // tile's thumbnail path round-trips through the asset-protocol scope grant.
        assert!(got
            .videos
            .iter()
            .all(|p| Path::new(p).parent() == Some(media.as_path())));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_folder_entries_returns_archives_in_their_own_list() {
        let base = temp_root("entries-archives");
        let media = base.join("media");
        fs::create_dir_all(&media).unwrap();
        fs::write(media.join("book.cbz"), b"zip").unwrap();
        fs::write(media.join("PACK.ZIP"), b"zip").unwrap(); // case-insensitive
        fs::write(media.join("comic.cbr"), b"rar").unwrap();
        fs::write(media.join("shot.jpg"), b"img").unwrap();
        fs::write(media.join("clip.mp4"), b"vid").unwrap();
        fs::write(media.join("notes.txt"), b"txt").unwrap();

        let allow = AllowList::default();
        allow.0.lock().unwrap().insert(fs::canonicalize(&media).unwrap());

        let got = list_folder_entries_impl(&allow, media.to_str().unwrap()).unwrap();
        let leaves = |v: &Vec<String>| {
            let mut out: Vec<String> = v
                .iter()
                .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned())
                .collect();
            out.sort();
            out
        };
        assert_eq!(leaves(&got.archives), vec!["PACK.ZIP", "book.cbz", "comic.cbr"]);
        assert_eq!(leaves(&got.images), vec!["shot.jpg"]);
        assert_eq!(leaves(&got.videos), vec!["clip.mp4"]);
        // A non-media file is in no list at all.
        assert!(got.folders.is_empty());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn folder_cover_image_falls_back_to_a_video_when_there_is_no_image() {
        // gallery-003: a folder holding only clips used to show a bare glyph. It now
        // covers with a video frame — but an image still wins when both are present,
        // because rendering an image thumbnail costs no ffmpeg seek.
        let base = temp_root("gallery-cover-video");
        let videos_only = base.join("clips");
        let mixed = base.join("mixed");
        fs::create_dir_all(&videos_only).unwrap();
        fs::create_dir_all(&mixed).unwrap();
        for name in ["zebra.mp4", "apple.mkv", "notes.txt"] {
            fs::write(videos_only.join(name), b"x").unwrap();
        }
        // The video sorts FIRST by name here, so picking it would be the natural
        // mistake — the image must still win.
        for name in ["aaa.mp4", "zzz.png"] {
            fs::write(mixed.join(name), b"x").unwrap();
        }

        let allow = AllowList::default();
        let mut roots = allow.0.lock().unwrap();
        roots.insert(fs::canonicalize(&videos_only).unwrap());
        roots.insert(fs::canonicalize(&mixed).unwrap());
        drop(roots);

        let leaf = |c: Option<String>| -> String {
            Path::new(c.as_deref().unwrap())
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(
            leaf(folder_cover_image_impl(&allow, videos_only.to_str().unwrap()).unwrap()),
            "apple.mkv"
        );
        assert_eq!(
            leaf(folder_cover_image_impl(&allow, mixed.to_str().unwrap()).unwrap()),
            "zzz.png"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn duration_cache_path_is_keyed_like_a_thumbnail_but_never_collides_with_one() {
        let dir = Path::new("/cache");
        let a = Path::new("/videos/a.mp4");
        // Same source, size and mtime -> same file, so a revisited folder re-probes
        // nothing.
        assert_eq!(
            duration_cache_path(dir, a, 1000, 42),
            duration_cache_path(dir, a, 1000, 42)
        );
        // Editing the file invalidates the cached duration rather than serving the
        // old one against new bytes.
        assert_ne!(
            duration_cache_path(dir, a, 1000, 42),
            duration_cache_path(dir, a, 1000, 43)
        );
        assert_ne!(
            duration_cache_path(dir, a, 1000, 42),
            duration_cache_path(dir, a, 2000, 42)
        );
        assert_ne!(
            duration_cache_path(dir, a, 1000, 42),
            duration_cache_path(dir, Path::new("/videos/b.mp4"), 1000, 42)
        );
        // It must NOT land on the thumbnail JPEG for the same source, or one would
        // overwrite the other.
        let name = duration_cache_path(dir, a, 1000, 42);
        let name = name.file_name().unwrap().to_string_lossy();
        assert!(name.ends_with(".dur"), "got {name}");
        assert_ne!(name, thumb_cache_name(a, 1000, 42, THUMB_MAX_PX));
        // Shares the prefix the pruner recognises, so these expire with the rest of
        // the cache instead of accumulating forever.
        assert!(name.starts_with("pb-th-"), "got {name}");
        assert!(is_prunable_cache_file(&name));
    }

    #[test]
    fn parse_ffmpeg_duration_reads_the_input_header() {
        // What `ffmpeg -i <file>` prints to stderr before bailing out for want of an
        // output file. This is the whole contract of the duration probe.
        let stderr = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':\n  \
             Metadata:\n    encoder         : Lavf58\n  \
             Duration: 00:01:34.56, start: 0.000000, bitrate: 1103 kb/s\n";
        assert_eq!(parse_ffmpeg_duration(stderr), Some(94.56));
        // Past an hour.
        assert_eq!(
            parse_ffmpeg_duration("  Duration: 01:02:03.00, start: 0.000000\n"),
            Some(3723.0)
        );
    }

    #[test]
    fn parse_ffmpeg_duration_returns_none_when_there_is_no_honest_duration() {
        // A zero-duration fragmented recording (play-020's shape) reports N/A. The
        // tile must then show NO badge rather than a fabricated 0:00.
        assert_eq!(parse_ffmpeg_duration("  Duration: N/A, bitrate: N/A\n"), None);
        assert_eq!(parse_ffmpeg_duration("clip.mp4: No such file or directory\n"), None);
        assert_eq!(parse_ffmpeg_duration(""), None);
        // Malformed fields are not silently read as zero.
        assert_eq!(parse_ffmpeg_duration("Duration: ab:cd:ef.gh,\n"), None);
    }

    #[test]
    fn clamp_read_len_caps_allocation_at_max_chunk() {
        // The chunk is min(remaining, max_len, MAX_CHUNK).
        // A hostile/oversized max_len against a huge file is capped at MAX_CHUNK,
        // not the whole file (the F-3 self-inflicted-allocation fix).
        let huge_file = 8 * 1024 * 1024 * 1024; // 8 GiB remaining
        assert_eq!(clamp_read_len(huge_file, u64::MAX), MAX_CHUNK as usize);
        assert_eq!(clamp_read_len(huge_file, huge_file), MAX_CHUNK as usize);

        // The first-party caller (max_len <= READ_CHUNK_BYTES = 4 MiB) is below the
        // ceiling, so its returned length is unchanged: min(remaining, max_len).
        let four_mib = 4 * 1024 * 1024;
        assert_eq!(clamp_read_len(huge_file, four_mib), four_mib as usize);
        // ...and a short tail still returns only the bytes that remain.
        assert_eq!(clamp_read_len(1000, four_mib), 1000);

        // max_len is honoured when it is the smallest of the three.
        assert_eq!(clamp_read_len(MAX_CHUNK, 100), 100);
        // Exactly at the ceiling stays at the ceiling (no off-by-one).
        assert_eq!(clamp_read_len(MAX_CHUNK, MAX_CHUNK), MAX_CHUNK as usize);
    }

    #[test]
    fn scan_is_fragmented_distinguishes_fragmented_from_plain_mp4() {
        use std::io::Cursor;
        // size(4 BE) + type(4) + body
        fn boxed(ty: &[u8; 4], body: &[u8]) -> Vec<u8> {
            let mut v = ((8 + body.len()) as u32).to_be_bytes().to_vec();
            v.extend_from_slice(ty);
            v.extend_from_slice(body);
            v
        }
        let ftyp = boxed(b"ftyp", b"isom\0\0\0\0");
        let mvhd = boxed(b"mvhd", &[0u8; 100]);
        let mvex = boxed(b"mvex", &boxed(b"trex", &[0u8; 24]));
        let moof = boxed(b"moof", &[0u8; 16]);
        let mdat = boxed(b"mdat", &[0u8; 64]);
        let mut frag_moov_body = mvhd.clone();
        frag_moov_body.extend_from_slice(&mvex);
        let frag_moov = boxed(b"moov", &frag_moov_body); // mvhd + mvex
        let plain_moov = boxed(b"moov", &mvhd); // mvhd only, no mvex
        let cat = |parts: &[&[u8]]| -> Vec<u8> { parts.concat() };

        // Fragmented (faststart): moov carries an mvex.
        assert!(scan_is_fragmented(&mut Cursor::new(cat(&[&ftyp, &frag_moov, &moof, &mdat]))).unwrap());
        // Fragmented (streaming): a top-level moof, moov not at the front.
        assert!(scan_is_fragmented(&mut Cursor::new(cat(&[&ftyp, &moof, &mdat]))).unwrap());
        // Plain MP4: a complete moov with no mvex.
        assert!(!scan_is_fragmented(&mut Cursor::new(cat(&[&ftyp, &plain_moov, &mdat]))).unwrap());
        // Plain MP4 with moov AFTER a large mdat (exercises the seek-over-body path).
        let big_mdat = boxed(b"mdat", &vec![0u8; 5000]);
        assert!(!scan_is_fragmented(&mut Cursor::new(cat(&[&ftyp, &big_mdat, &plain_moov]))).unwrap());
        // Degenerate inputs never panic and report "not fragmented".
        assert!(!scan_is_fragmented(&mut Cursor::new(Vec::<u8>::new())).unwrap());
        assert!(!scan_is_fragmented(&mut Cursor::new(ftyp.clone())).unwrap());
    }

    // --- img-002: reveal in Explorer + EXIF summary --------------------------

    #[test]
    fn strips_the_extended_length_prefix_explorer_cannot_read() {
        // fs::canonicalize returns \\?\C:\... on Windows. Explorer does not
        // understand that form and silently opens the Documents folder instead of
        // selecting the file, so the prefix has to come off before it is handed over.
        assert_eq!(strip_extended_prefix(r"\\?\C:\photos\a.jpg"), r"C:\photos\a.jpg");
        // UNC shares keep working: \\?\UNC\server\share -> \\server\share.
        assert_eq!(
            strip_extended_prefix(r"\\?\UNC\server\share\a.jpg"),
            r"\\server\share\a.jpg"
        );
        // An ordinary path is returned untouched.
        assert_eq!(strip_extended_prefix(r"C:\photos\a.jpg"), r"C:\photos\a.jpg");
    }

    #[test]
    fn builds_one_select_argument_not_two() {
        // "/select," and the path are ONE argument. Passed as two, Explorer opens a
        // window on Documents and selects nothing -- a silent wrong result, not an error.
        let args = explorer_select_args(r"C:\photos\a.jpg");
        assert_eq!(args.len(), 1);
        assert_eq!(args[0], r"/select,C:\photos\a.jpg");
    }

    #[test]
    fn reads_the_camera_date_and_exposure_out_of_exif() {
        let jpeg = jpeg_with_exif();
        let info = exif_summary(&jpeg);
        assert_eq!(info.camera.as_deref(), Some("TestMake TestModel"));
        assert_eq!(info.taken.as_deref(), Some("2026-03-14 09:21:07"));
        assert_eq!(info.exposure.as_deref(), Some("1/250 s"));
        assert_eq!(info.aperture.as_deref(), Some("f/2.8"));
        assert_eq!(info.iso.as_deref(), Some("ISO 400"));
    }

    #[test]
    fn reports_nothing_rather_than_zeroes_for_a_file_with_no_exif() {
        // A PNG from a screenshot has no EXIF at all. Every field must come back
        // absent so the panel can omit the rows, rather than showing "f/0" or
        // "1970-01-01" as though they were real readings.
        let info = exif_summary(b"\x89PNG\r\n\x1a\n not really a png body");
        assert!(info.camera.is_none());
        assert!(info.taken.is_none());
        assert!(info.exposure.is_none());
        assert!(info.aperture.is_none());
        assert!(info.iso.is_none());
    }

    #[test]
    fn survives_a_truncated_or_hostile_exif_block_without_panicking() {
        let jpeg = jpeg_with_exif();
        for cut in [2usize, 8, 20, 40, 64] {
            if cut < jpeg.len() {
                let _ = exif_summary(&jpeg[..cut]); // must not panic
            }
        }
        let _ = exif_summary(&[0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF]); // length past EOF
    }

    /// A minimal JPEG carrying one APP1 Exif block: SOI, APP1(Exif\0\0 + TIFF), EOI.
    /// Built by hand so the expectations above are exact and need no fixture file.
    fn jpeg_with_exif() -> Vec<u8> {
        // Little-endian TIFF. IFD0 holds Make, Model and the Exif IFD pointer;
        // the Exif IFD holds DateTimeOriginal, ExposureTime, FNumber and ISO.
        let mut tiff: Vec<u8> = Vec::new();
        tiff.extend_from_slice(b"II\x2a\x00"); // little-endian magic
        tiff.extend_from_slice(&8u32.to_le_bytes()); // IFD0 at offset 8

        // Values too big for the 4-byte inline slot live in a pool after both IFDs.
        // IFD0:     2 + 3*12 + 4 = 42 bytes, at offset 8   -> ends at 50.
        // Exif IFD: 2 + 4*12 + 4 = 54 bytes, at offset 50  -> ends at 104.
        let pool_start: u32 = 104;
        let make = b"TestMake\0";
        let model = b"TestModel\0";
        let date = b"2026:03:14 09:21:07\0";
        let make_off = pool_start;
        let model_off = make_off + make.len() as u32;
        let date_off = model_off + model.len() as u32;
        let exposure_off = date_off + date.len() as u32; // two u32s: a rational
        let fnumber_off = exposure_off + 8;

        let entry = |tag: u16, fmt: u16, count: u32, value: u32| -> Vec<u8> {
            let mut e = Vec::new();
            e.extend_from_slice(&tag.to_le_bytes());
            e.extend_from_slice(&fmt.to_le_bytes());
            e.extend_from_slice(&count.to_le_bytes());
            e.extend_from_slice(&value.to_le_bytes());
            e
        };

        // --- IFD0 ---
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&entry(0x010F, 2, make.len() as u32, make_off)); // Make
        tiff.extend_from_slice(&entry(0x0110, 2, model.len() as u32, model_off)); // Model
        tiff.extend_from_slice(&entry(0x8769, 4, 1, 50)); // Exif IFD pointer
        tiff.extend_from_slice(&0u32.to_le_bytes()); // no IFD1

        // --- Exif IFD (at offset 50) ---
        tiff.extend_from_slice(&4u16.to_le_bytes());
        tiff.extend_from_slice(&entry(0x9003, 2, date.len() as u32, date_off)); // DateTimeOriginal
        tiff.extend_from_slice(&entry(0x829A, 5, 1, exposure_off)); // ExposureTime
        tiff.extend_from_slice(&entry(0x829D, 5, 1, fnumber_off)); // FNumber
        tiff.extend_from_slice(&entry(0x8827, 3, 1, 400)); // ISOSpeedRatings (SHORT)
        tiff.extend_from_slice(&0u32.to_le_bytes());

        // --- value pool ---
        assert_eq!(
            tiff.len() as u32,
            pool_start,
            "IFD layout drifted from the offsets computed above"
        );
        tiff.extend_from_slice(make);
        tiff.extend_from_slice(model);
        tiff.extend_from_slice(date);
        tiff.extend_from_slice(&1u32.to_le_bytes()); // ExposureTime = 1/250
        tiff.extend_from_slice(&250u32.to_le_bytes());
        tiff.extend_from_slice(&28u32.to_le_bytes()); // FNumber = 28/10 = f/2.8
        tiff.extend_from_slice(&10u32.to_le_bytes());

        let mut app1: Vec<u8> = Vec::new();
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(&tiff);

        let mut jpeg: Vec<u8> = vec![0xFF, 0xD8]; // SOI
        jpeg.extend_from_slice(&[0xFF, 0xE1]); // APP1
        jpeg.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes()); // length, big-endian
        jpeg.extend_from_slice(&app1);
        jpeg.extend_from_slice(&[0xFF, 0xD9]); // EOI
        jpeg
    }

    #[test]
    fn decodes_a_base64_clipboard_payload() {
        // The picture crosses the IPC bridge as base64, the same transport
        // read_stream_chunk uses. A raw byte array arrives on WebView2 as a JSON
        // number[] instead: 38 MB of RGBA took SIX SECONDS to copy that way,
        // which is what sent this through base64 and a PNG encode.
        let encoded = base64::engine::general_purpose::STANDARD
            .encode([0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        let out = decode_clipboard_png(&encoded).unwrap();
        assert_eq!(out, vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    }

    #[test]
    fn rejects_a_payload_that_is_not_base64_instead_of_panicking() {
        assert!(decode_clipboard_png("not base64 !!!").is_err());
        assert!(decode_clipboard_png("").is_err());
    }

    #[test]
    fn refuses_an_oversized_payload_rather_than_allocating_it() {
        // A hostile or wedged caller must not be able to force an unbounded
        // native allocation, the same reasoning as read_stream_chunk's MAX_CHUNK.
        // Base64 is 4 characters per 3 bytes, so a string this long decodes past
        // the ceiling and has to be refused on its LENGTH, before it is decoded.
        let oversized = "A".repeat((MAX_CLIPBOARD_PNG_BYTES as usize / 3 + 16) * 4);
        assert!(decode_clipboard_png(&oversized).is_err());
    }
}

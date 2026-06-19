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
//!   * `remux_ts` converts an MPEG-TS file (.ts/.m2ts/.mts) into a playable temp
//!     .mp4 via a bundled ffmpeg sidecar — Chromium's <video> decodes H.264/AAC but
//!     cannot demux the TS container — and caches the result (play-016).
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
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

/// Holds a media path supplied on the command line, if any.
struct LaunchPath(Option<String>);

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
/// old whole-disk arbitrary-file-read primitive (F-1) is gone.
#[derive(Default)]
struct AllowList(Mutex<HashSet<PathBuf>>);

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
fn ipc_error(context: &str, detail: impl std::fmt::Display, public: &str) -> String {
    eprintln!("[playback] {context}: {detail}");
    public.to_string()
}

/// Canonicalize `path` and confirm it lands inside the allow-list, returning a
/// generic error otherwise. This is the single security gate shared by the two
/// file-reading commands.
fn ensure_allowed(allow: &AllowList, path: &str) -> Result<PathBuf, String> {
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
fn read_hwaccel_pref() -> bool {
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
    let dir = canonical
        .parent()
        .ok_or_else(|| "invalid path".to_string())?
        .to_path_buf();
    let raw_parent = Path::new(&path).parent().map(Path::to_path_buf);
    authorize_dir(&app, &allow, dir, raw_parent.as_deref());
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

/// Remux a transport-stream file (.ts/.m2ts/.mts) into a playable temp .mp4 and
/// return its path. Chromium's <video> can decode H.264/AAC but cannot demux the
/// MPEG-2 TS container, so on open the frontend calls this for TS files and plays
/// the returned .mp4 instead. The bundled ffmpeg sidecar stream-copies the streams
/// into MP4 (no re-encode). The source must already be authorized (the frontend
/// calls `allow_media_dir` first); the temp output's directory is authorized here so
/// the WebView can play it back. Result is cached by source identity, so re-opening
/// the same file is instant.
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
    let output = sidecar
        .args(args)
        .output()
        .await
        .map_err(|_| "waveform decode failed to start".to_string())?;

    if !output.status.success() || output.stdout.is_empty() {
        return Err("no decodable audio".to_string());
    }

    let samples = pcm_f32le_to_samples(&output.stdout);
    let peaks = downsample_pcm_peaks(&samples, bars);
    if peaks.is_empty() {
        return Err("no audio samples".to_string());
    }
    Ok(peaks)
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
fn has_queue_video_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| QUEUE_VIDEO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
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
    let entries = fs::read_dir(canonical_dir)
        .map_err(|e| ipc_error("list_folder_videos: read_dir", e, "could not list folder"))?;
    let mut out: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_file() || !has_queue_video_ext(&entry_path) {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First non-flag argument is treated as a file to open.
    let launch = std::env::args().skip(1).find(|a| !a.starts_with('-'));

    // play-010: set the WebView2 GPU launch flag from the saved preference BEFORE
    // the webview is created (the flag is fixed at creation time). No-op unless the
    // user has turned hardware acceleration off.
    apply_hwaccel_launch_flag();

    tauri::Builder::default()
        .manage(LaunchPath(launch))
        .manage(AllowList::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            launch_path,
            allow_media_dir,
            stream_status,
            read_stream_chunk,
            compute_waveform_peaks,
            remux_ts,
            list_folder_videos,
            get_hwaccel,
            set_hwaccel
        ])
        .run(tauri::generate_context!())
        .expect("error while running Playback");
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
}

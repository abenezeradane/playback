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
//!     deprecated) and read byte ranges (used by the cut-view waveform).
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
use tauri::Manager;

/// Holds a media path supplied on the command line, if any.
struct LaunchPath(Option<String>);

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
    if let Ok(mut roots) = allow.0.lock() {
        roots.insert(dir);
    }
    if let Some(raw_parent) = Path::new(&path).parent() {
        let _ = app.asset_protocol_scope().allow_directory(raw_parent, false);
    }
    Ok(())
}

/// Report the size of a media file plus whether it is a live capture in progress.
/// The frontend polls this to learn how much new data is available and when the
/// stream has finalized.
#[tauri::command]
fn stream_status(allow: tauri::State<'_, AllowList>, path: String) -> Result<StreamStatus, String> {
    ensure_allowed(&allow, &path)?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
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

/// Read up to `max_len` bytes from `path` starting at `offset`, returned as a
/// base64 string. (A raw `Vec<u8>` response arrives on WebView2 as a slow JSON
/// number[]; base64 is far more compact and parses as a plain string.) Reads
/// only the bytes that exist right now; returns "" when `offset` is at/past EOF.
#[tauri::command]
fn read_stream_chunk(
    allow: tauri::State<'_, AllowList>,
    path: String,
    offset: u64,
    max_len: u64,
) -> Result<String, String> {
    ensure_allowed(&allow, &path)?;
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if offset >= size {
        return Ok(String::new());
    }
    let read_len = (size - offset).min(max_len) as usize;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; read_len];
    file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First non-flag argument is treated as a file to open.
    let launch = std::env::args().skip(1).find(|a| !a.starts_with('-'));

    tauri::Builder::default()
        .manage(LaunchPath(launch))
        .manage(AllowList::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            launch_path,
            allow_media_dir,
            stream_status,
            read_stream_chunk
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
}

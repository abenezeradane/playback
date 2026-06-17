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
//!     deprecated) and read arbitrary byte ranges (used by the cut-view waveform).

use base64::Engine;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Holds a media path supplied on the command line, if any.
struct LaunchPath(Option<String>);

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
}

/// Report the size of a media file plus whether it is a live capture in progress.
/// The frontend polls this to learn how much new data is available and when the
/// stream has finalized.
#[tauri::command]
fn stream_status(path: String) -> Result<StreamStatus, String> {
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
    Ok(StreamStatus { size, live, complete, mtime_age_ms })
}

/// Read up to `max_len` bytes from `path` starting at `offset`, returned as a
/// base64 string. (A raw `Vec<u8>` response arrives on WebView2 as a slow JSON
/// number[]; base64 is far more compact and parses as a plain string.) Reads
/// only the bytes that exist right now; returns "" when `offset` is at/past EOF.
#[tauri::command]
fn read_stream_chunk(path: String, offset: u64, max_len: u64) -> Result<String, String> {
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            launch_path,
            stream_status,
            read_stream_chunk
        ])
        .run(tauri::generate_context!())
        .expect("error while running Playback");
}

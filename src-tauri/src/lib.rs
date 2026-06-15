//! Playback — Tauri 2.0 application entry point.
//!
//! The frontend (a WebView running the Vite-built UI) is the player surface.
//! Native responsibilities are intentionally thin:
//!   * the dialog plugin provides the "Open file" picker,
//!   * the asset protocol (configured in tauri.conf.json) streams the chosen
//!     local video file into the WebView's <video> element,
//!   * window drag-and-drop is enabled so files can be dropped onto the window,
//!   * a path passed on the command line ("Open with…") is loaded on startup,
//!   * two thin streaming commands (`stream_status` / `read_stream_chunk`) let the
//!     frontend tail a file that is still being written, for livestream playback
//!     (play-003) via MediaSource — the asset protocol only sees a file's bytes
//!     as of load time, so a growing file is fed in incrementally instead.

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
}

/// Report the size of a media file plus whether it is a live capture in progress.
/// The frontend polls this to learn how much new data is available and when the
/// stream has finalized.
#[tauri::command]
fn stream_status(path: String) -> Result<StreamStatus, String> {
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let live = Path::new(&format!("{path}.live")).exists();
    let complete = Path::new(&format!("{path}.done")).exists();
    Ok(StreamStatus { size, live, complete })
}

/// Read up to `max_len` bytes from `path` starting at `offset`, returned as a raw
/// (binary) IPC response — an ArrayBuffer on the JS side. Reads only the bytes
/// that exist right now; returns an empty buffer when `offset` is at/past EOF.
/// The frontend appends the returned bytes to its MediaSource SourceBuffer.
#[tauri::command]
fn read_stream_chunk(
    path: String,
    offset: u64,
    max_len: u64,
) -> Result<tauri::ipc::Response, String> {
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if offset >= size {
        return Ok(tauri::ipc::Response::new(Vec::<u8>::new()));
    }
    let read_len = (size - offset).min(max_len) as usize;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; read_len];
    file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(buf))
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

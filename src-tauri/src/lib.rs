//! Playback — Tauri 2.0 application entry point.
//!
//! The frontend (a WebView running the Vite-built UI) is the player surface.
//! Native responsibilities are intentionally thin:
//!   * the dialog plugin provides the "Open file" picker,
//!   * the asset protocol (configured in tauri.conf.json) streams the chosen
//!     local video file into the WebView's <video> element,
//!   * window drag-and-drop is enabled so files can be dropped onto the window,
//!   * a path passed on the command line ("Open with…") is loaded on startup,
//!   * three thin streaming commands (`stream_status` / `live_start` /
//!     `read_stream_chunk`) let the frontend tail a file that is still being
//!     written, for livestream playback (play-003) via MediaSource — the asset
//!     protocol only sees a file's bytes as of load time, so a growing file is
//!     fed in incrementally instead.

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

/// Where a fragmented-MP4 livestream should begin appending so the viewer starts
/// near the live edge instead of replaying (and buffering) the whole history.
#[derive(serde::Serialize)]
struct LiveStart {
    /// Current byte length of the file.
    size: u64,
    /// End of the init segment (ftyp+moov) = offset of the first `moof`. Equals
    /// `size` when the file is not a fragmented MP4 (no `moof` found).
    init_end: u64,
    /// Offset of the first fragment (`moof`) at or after `size - window_bytes`,
    /// snapped to a fragment boundary so the appended media is independently
    /// decodable. The frontend appends `[0, init_end)` then tails from here.
    start: u64,
}

/// Scan the top-level MP4 boxes of `path` to find the init segment and a recent
/// fragment boundary, so a (possibly multi-GB) growing livestream can be played
/// from near its live edge. Walks box headers only — cheap even for huge files.
#[tauri::command]
fn live_start(path: String, window_bytes: u64) -> Result<LiveStart, String> {
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let target = size.saturating_sub(window_bytes);

    let mut off: u64 = 0;
    let mut init_end: u64 = size;
    let mut start: Option<u64> = None;
    let mut header = [0u8; 16];

    while off + 8 <= size {
        file.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
        let to_read = ((size - off).min(16)) as usize;
        if file.read_exact(&mut header[..to_read]).is_err() {
            break;
        }
        let mut box_size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let box_type = &header[4..8];
        if box_size == 1 {
            if to_read < 16 {
                break;
            }
            box_size = u64::from_be_bytes(header[8..16].try_into().unwrap());
        }
        if box_size == 0 || box_size < 8 {
            break; // 0 = "to EOF"; anything < 8 is malformed — stop scanning.
        }
        if box_type == b"moof" {
            if init_end == size {
                init_end = off; // first moof marks the end of the init segment
            }
            if off >= target.max(init_end) {
                start = Some(off);
                break;
            }
        }
        off += box_size;
    }

    let start = start.unwrap_or(init_end).max(init_end).min(size);
    Ok(LiveStart { size, init_end, start })
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
            live_start,
            read_stream_chunk
        ])
        .run(tauri::generate_context!())
        .expect("error while running Playback");
}

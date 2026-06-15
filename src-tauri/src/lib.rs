//! Playback — Tauri 2.0 application entry point.
//!
//! The frontend (a WebView running the Vite-built UI) is the player surface.
//! Native responsibilities are intentionally thin:
//!   * the dialog plugin provides the "Open file" picker,
//!   * the asset protocol (configured in tauri.conf.json) streams the chosen
//!     local video file into the WebView's <video> element,
//!   * window drag-and-drop is enabled so files can be dropped onto the window,
//!   * a path passed on the command line ("Open with…") is loaded on startup.

/// Holds a media path supplied on the command line, if any.
struct LaunchPath(Option<String>);

/// Returns the file path Playback was launched with (e.g. via "Open with…" or
/// `playback.exe <file>`), or `null` when started without one.
#[tauri::command]
fn launch_path(state: tauri::State<'_, LaunchPath>) -> Option<String> {
    state.0.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First non-flag argument is treated as a file to open.
    let launch = std::env::args().skip(1).find(|a| !a.starts_with('-'));

    tauri::Builder::default()
        .manage(LaunchPath(launch))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![launch_path])
        .run(tauri::generate_context!())
        .expect("error while running Playback");
}

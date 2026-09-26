// No command is exposed to the WebView: the app crate calls this plugin from
// Rust (src/lib.rs), so the command list is empty and no permission is
// generated. `android_path` is what links the Kotlin library into the app.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}

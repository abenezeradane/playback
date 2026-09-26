//! Playback's Android host (android-001): a Rust API over the Kotlin plugin in
//! `android/`. The app crate's commands call it; nothing here is invokable from
//! the WebView.
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

const PLUGIN_IDENTIFIER: &str = "com.playback.host";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StorageAccess {
    pub granted: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StorageVolume {
    pub label: String,
    pub path: String,
    pub removable: bool,
}

#[derive(Deserialize)]
struct VolumeList {
    volumes: Vec<StorageVolume>,
}

pub struct PlaybackHost<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> PlaybackHost<R> {
    pub fn storage_access(&self) -> Result<StorageAccess, String> {
        self.0.run_mobile_plugin("storageAccess", ()).map_err(|e| e.to_string())
    }

    /// Opens the system "All files access" page for this app and returns when
    /// the user comes back. BLOCKS until then: call it off the async workers
    /// (spawn_blocking), never on the main thread.
    pub fn request_storage_access(&self) -> Result<StorageAccess, String> {
        self.0.run_mobile_plugin("requestStorageAccess", ()).map_err(|e| e.to_string())
    }

    pub fn storage_volumes(&self) -> Result<Vec<StorageVolume>, String> {
        self.0
            .run_mobile_plugin::<VolumeList>("storageVolumes", ())
            .map(|list| list.volumes)
            .map_err(|e| e.to_string())
    }

    pub fn move_to_background(&self) -> Result<(), String> {
        self.0.run_mobile_plugin("moveToBackground", ()).map_err(|e| e.to_string())
    }
}

pub trait PlaybackHostExt<R: Runtime> {
    fn playback_host(&self) -> &PlaybackHost<R>;
}

impl<R: Runtime, T: Manager<R>> PlaybackHostExt<R> for T {
    fn playback_host(&self) -> &PlaybackHost<R> {
        self.state::<PlaybackHost<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("playback-host")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "PlaybackHostPlugin")?;
            app.manage(PlaybackHost(handle));
            Ok(())
        })
        .build()
}

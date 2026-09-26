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

/// Every call awaits the Kotlin side's answer without parking a thread, so a
/// slow answer (or a user sitting in system Settings) costs no async worker.
impl<R: Runtime> PlaybackHost<R> {
    pub async fn storage_access(&self) -> Result<StorageAccess, String> {
        self.0
            .run_mobile_plugin_async("storageAccess", ())
            .await
            .map_err(|e| e.to_string())
    }

    /// Opens the system "All files access" page for this app and resolves when
    /// the user comes back, which may be minutes later.
    pub async fn request_storage_access(&self) -> Result<StorageAccess, String> {
        self.0
            .run_mobile_plugin_async("requestStorageAccess", ())
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn storage_volumes(&self) -> Result<Vec<StorageVolume>, String> {
        self.0
            .run_mobile_plugin_async::<VolumeList>("storageVolumes", ())
            .await
            .map(|list| list.volumes)
            .map_err(|e| e.to_string())
    }

    pub async fn move_to_background(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin_async("moveToBackground", ())
            .await
            .map_err(|e| e.to_string())
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

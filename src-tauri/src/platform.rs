//! What this build of Playback can do on the platform it was compiled for
//! (android-001).

/// The one error string for a capability this platform does not have. Crosses
/// IPC as-is: it names no path and no system detail (sec-005). Only a build that
/// lacks something refers to it (every mobile fence, and the mpv embed on any
/// non-Windows target), so the Windows desktop build compiles it for tests only.
#[cfg(any(not(windows), test))]
pub(crate) const NOT_ON_PLATFORM: &str = "not available on this platform";

use serde::Serialize;

/// Compile-time capabilities of this build. They are handed to the WebView
/// before any page script runs (`features_plugin`), and the frontend decides
/// which controls exist from this record alone (`visibleActions` in
/// src/platform-core.ts). Capabilities, not runtime state: `native_engine` is
/// true on Windows even when libmpv-2.dll is missing, because
/// `player_engine_status` still owns runtime availability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlatformFeatures {
    pub mobile: bool,
    pub native_engine: bool,
    pub sidecar: bool,
    pub recycle: bool,
    pub reveal: bool,
    pub clipboard_image: bool,
    pub storage_volumes: bool,
}

impl PlatformFeatures {
    pub(crate) const fn current() -> Self {
        let mobile = cfg!(mobile);
        Self {
            mobile,
            // The mpv embed and Explorer reveal are Windows code today.
            native_engine: cfg!(windows),
            sidecar: !mobile,
            recycle: !mobile,
            reveal: cfg!(windows),
            clipboard_image: !mobile,
            storage_volumes: cfg!(target_os = "android"),
        }
    }
}

/// The document-start script: `window.__PLAYBACK_FEATURES__ = Object.freeze({...});`.
pub(crate) fn features_init_script(f: PlatformFeatures) -> String {
    format!(
        "window.__PLAYBACK_FEATURES__ = Object.freeze({});",
        serde_json::to_string(&f).expect("PlatformFeatures always serializes")
    )
}

/// A command-less plugin whose only job is the init script above. A plugin is
/// Tauri's hook for a script that runs before the page's own, which is what
/// lets the frontend know its platform synchronously, with no desktop-controls
/// flash on a phone while an IPC round trip is in flight.
pub(crate) fn features_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("playback-features")
        .js_init_script(features_init_script(PlatformFeatures::current()))
        .build()
}

/// `{ granted }` for the storage-access commands.
#[derive(Serialize)]
pub(crate) struct AccessReply {
    granted: bool,
}

/// One storage volume, as Home's Storage row shows it. Android only: desktop
/// never builds one (it answers an empty list), and an unconstructed struct
/// would break the warning-free desktop build.
#[cfg(target_os = "android")]
#[derive(Serialize)]
pub(crate) struct VolumeReply {
    label: String,
    path: String,
    removable: bool,
}

/// Whether Playback may read the phone's shared storage (All-files access).
/// Desktop has no such gate, so it always answers yes there.
#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn storage_access(app: tauri::AppHandle) -> Result<AccessReply, String> {
    use tauri_plugin_playback_host::PlaybackHostExt;
    let access = app
        .playback_host()
        .storage_access()
        .await
        .map_err(|e| crate::ipc_error("storage_access", e, "could not check storage access"))?;
    Ok(AccessReply { granted: access.granted })
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn storage_access() -> Result<AccessReply, String> {
    Ok(AccessReply { granted: true })
}

/// Open the system "All files access" page and report the user's choice when
/// they come back. They may sit there for minutes; the command just awaits the
/// answer, holding no thread meanwhile.
#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn request_storage_access(app: tauri::AppHandle) -> Result<AccessReply, String> {
    use tauri_plugin_playback_host::PlaybackHostExt;
    let access = app
        .playback_host()
        .request_storage_access()
        .await
        .map_err(|e| crate::ipc_error("request_storage_access", e, "could not open storage settings"))?;
    Ok(AccessReply { granted: access.granted })
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn request_storage_access() -> Result<AccessReply, String> {
    Ok(AccessReply { granted: true })
}

/// The phone's mounted storage volumes, labelled by the system.
#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn storage_volumes(app: tauri::AppHandle) -> Result<Vec<VolumeReply>, String> {
    use tauri_plugin_playback_host::PlaybackHostExt;
    let volumes = app
        .playback_host()
        .storage_volumes()
        .await
        .map_err(|e| crate::ipc_error("storage_volumes", e, "could not read storage"))?;
    Ok(volumes
        .into_iter()
        .map(|v| VolumeReply { label: v.label, path: v.path, removable: v.removable })
        .collect())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn storage_volumes() -> Result<Vec<serde_json::Value>, String> {
    Ok(Vec::new())
}

/// Send the app to the background (Back at Home), rather than finishing it.
#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn move_to_background(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_playback_host::PlaybackHostExt;
    app.playback_host()
        .move_to_background()
        .await
        .map_err(|e| crate::ipc_error("move_to_background", e, "could not leave the app"))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn move_to_background() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_platform_refusal_is_one_stable_string() {
        assert_eq!(NOT_ON_PLATFORM, "not available on this platform");
    }

    #[test]
    fn a_windows_desktop_build_has_every_capability_and_no_phone_ones() {
        let f = PlatformFeatures::current();
        assert!(!f.mobile);
        assert!(!f.storage_volumes);
        assert!(f.sidecar && f.recycle && f.clipboard_image);
        assert_eq!(f.native_engine, cfg!(windows));
        assert_eq!(f.reveal, cfg!(windows));
    }

    #[test]
    fn the_init_script_hands_the_page_a_frozen_camel_case_record() {
        let phone = PlatformFeatures {
            mobile: true,
            native_engine: false,
            sidecar: false,
            recycle: false,
            reveal: false,
            clipboard_image: false,
            storage_volumes: true,
        };
        assert_eq!(
            features_init_script(phone),
            r#"window.__PLAYBACK_FEATURES__ = Object.freeze({"mobile":true,"nativeEngine":false,"sidecar":false,"recycle":false,"reveal":false,"clipboardImage":false,"storageVolumes":true});"#
        );
    }

    #[test]
    fn desktop_has_no_storage_gate_and_no_volumes() {
        let access = tauri::async_runtime::block_on(storage_access()).unwrap();
        assert!(access.granted);
        assert!(tauri::async_runtime::block_on(storage_volumes()).unwrap().is_empty());
    }
}

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
}

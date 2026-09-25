//! Where Playback keeps its own files (android-001).
//!
//! Two roots. The CONFIG root holds the pref files (`hwaccel`, `engine`) and
//! `tags.db`. The CACHE root holds the thumbnail cache (and the archive mirrors
//! inside it) and the shader cache. On desktop both are derived from the
//! environment exactly as they always were, so an existing install finds its data
//! where it left it. An Android app process has no %APPDATA%, XDG_* or usable
//! $HOME, and `std::env::temp_dir()` there is /data/local/tmp, which an app cannot
//! write, so on mobile both roots come from Tauri's path resolver instead,
//! captured once in `setup()` before any command can run.

use std::path::PathBuf;

/// Config root from an environment lookup: `%APPDATA%\<id>` on Windows, else
/// `$XDG_CONFIG_HOME/<id>` or `$HOME/.config/<id>`. Pure (the lookup is
/// injected) so the desktop formula is pinned by tests without touching the
/// process environment. This is the formula `hwaccel_pref_path` used inline
/// before android-001, moved verbatim. Compiled for desktop and for the host
/// test run only: a phone build never resolves from the environment.
#[cfg(any(desktop, test))]
pub(crate) fn config_root_from(get: impl Fn(&str) -> Option<std::ffi::OsString>, windows: bool) -> Option<PathBuf> {
    let base = if windows {
        get("APPDATA").map(PathBuf::from)
    } else {
        get("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| get("HOME").map(|h| PathBuf::from(h).join(".config")))
    }?;
    Some(base.join(crate::APP_IDENTIFIER))
}

/// Cache root from an environment lookup: `%LOCALAPPDATA%\<id>` on Windows, else
/// `$XDG_CACHE_HOME/<id>` or `$HOME/.cache/<id>`. The formula `shader_cache_dir`
/// and `thumb_cache_dir` used inline before android-001, moved verbatim.
#[cfg(any(desktop, test))]
pub(crate) fn cache_root_from(get: impl Fn(&str) -> Option<std::ffi::OsString>, windows: bool) -> Option<PathBuf> {
    let base = if windows {
        get("LOCALAPPDATA").map(PathBuf::from)
    } else {
        get("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| get("HOME").map(|h| PathBuf::from(h).join(".cache")))
    }?;
    Some(base.join(crate::APP_IDENTIFIER))
}

#[cfg(mobile)]
struct MobileRoots {
    config: Option<PathBuf>,
    cache: Option<PathBuf>,
}

#[cfg(mobile)]
static MOBILE: std::sync::OnceLock<MobileRoots> = std::sync::OnceLock::new();

/// Mobile: capture the app-private roots from Tauri's path resolver and make
/// sure they exist. A resolver failure leaves that root unset, and callers then
/// degrade exactly as a desktop with no %APPDATA% does (tags report "no config
/// directory") rather than writing to a guessed path.
#[cfg(mobile)]
pub(crate) fn init_mobile<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let config = app.path().app_config_dir().ok();
    let cache = app.path().app_cache_dir().ok();
    for dir in [&config, &cache].into_iter().flatten() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = MOBILE.set(MobileRoots { config, cache });
}

/// The per-user config root. Prefs and `tags.db` sit directly inside it.
#[cfg(desktop)]
pub(crate) fn config_root() -> Option<PathBuf> {
    config_root_from(|k| std::env::var_os(k), cfg!(windows))
}

#[cfg(mobile)]
pub(crate) fn config_root() -> Option<PathBuf> {
    MOBILE.get().and_then(|r| r.config.clone())
}

/// The per-user cache root. The thumbnail and shader caches are folders in it.
#[cfg(desktop)]
pub(crate) fn cache_root() -> Option<PathBuf> {
    cache_root_from(|k| std::env::var_os(k), cfg!(windows))
}

#[cfg(mobile)]
pub(crate) fn cache_root() -> Option<PathBuf> {
    MOBILE.get().and_then(|r| r.cache.clone())
}

/// A writable scratch directory: the OS temp dir on desktop (as before), a
/// `tmp` folder in the app cache on mobile (the OS temp dir is not writable
/// there).
#[cfg(desktop)]
#[allow(dead_code)]
pub(crate) fn temp_root() -> Option<PathBuf> {
    Some(std::env::temp_dir())
}

#[cfg(mobile)]
pub(crate) fn temp_root() -> Option<PathBuf> {
    cache_root().map(|c| c.join("tmp"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::path::PathBuf;

    /// A fake environment: the pure resolvers never touch the process
    /// environment, which other tests in this crate mutate.
    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: HashMap<String, OsString> =
            pairs.iter().map(|(k, v)| (k.to_string(), OsString::from(v))).collect();
        move |k| map.get(k).cloned()
    }

    fn id(base: &str) -> Option<PathBuf> {
        Some(PathBuf::from(base).join(crate::APP_IDENTIFIER))
    }

    #[test]
    fn windows_roots_are_appdata_and_localappdata_plus_the_identifier() {
        let e = env(&[
            ("APPDATA", r"C:\Users\u\AppData\Roaming"),
            ("LOCALAPPDATA", r"C:\Users\u\AppData\Local"),
            ("HOME", "/ignored"),
        ]);
        assert_eq!(config_root_from(&e, true), id(r"C:\Users\u\AppData\Roaming"));
        assert_eq!(cache_root_from(&e, true), id(r"C:\Users\u\AppData\Local"));
    }

    #[test]
    fn windows_ignores_the_unix_variables() {
        let e = env(&[("XDG_CONFIG_HOME", "/x"), ("XDG_CACHE_HOME", "/y"), ("HOME", "/h")]);
        assert_eq!(config_root_from(&e, true), None);
        assert_eq!(cache_root_from(&e, true), None);
    }

    #[test]
    fn unix_roots_prefer_xdg_then_fall_back_to_home() {
        let xdg = env(&[("XDG_CONFIG_HOME", "/x/cfg"), ("XDG_CACHE_HOME", "/x/cache"), ("HOME", "/h")]);
        assert_eq!(config_root_from(&xdg, false), id("/x/cfg"));
        assert_eq!(cache_root_from(&xdg, false), id("/x/cache"));
        let home = env(&[("HOME", "/h")]);
        assert_eq!(config_root_from(&home, false), Some(PathBuf::from("/h").join(".config").join(crate::APP_IDENTIFIER)));
        assert_eq!(cache_root_from(&home, false), Some(PathBuf::from("/h").join(".cache").join(crate::APP_IDENTIFIER)));
    }

    #[test]
    fn no_environment_means_no_root_never_a_guessed_one() {
        let none = env(&[]);
        for windows in [true, false] {
            assert_eq!(config_root_from(&none, windows), None);
            assert_eq!(cache_root_from(&none, windows), None);
        }
    }

    #[test]
    fn desktop_temp_root_is_the_os_temp_dir_as_before() {
        assert_eq!(temp_root(), Some(std::env::temp_dir()));
    }
}

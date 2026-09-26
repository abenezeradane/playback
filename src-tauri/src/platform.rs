//! What this build of Playback can do on the platform it was compiled for
//! (android-001).

/// The one error string for a capability this platform does not have. Crosses
/// IPC as-is: it names no path and no system detail (sec-005). Only a build that
/// lacks something refers to it (every mobile fence, and the mpv embed on any
/// non-Windows target), so the Windows desktop build compiles it for tests only.
#[cfg(any(not(windows), test))]
pub(crate) const NOT_ON_PLATFORM: &str = "not available on this platform";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_platform_refusal_is_one_stable_string() {
        assert_eq!(NOT_ON_PLATFORM, "not available on this platform");
    }
}

//! recycle.rs — moving a user's file to the Recycle Bin (img-003).

use std::path::Path;

/// Move `path` to the platform's Recycle Bin.
///
/// This is the ONLY deletion primitive in the app, and it never falls back to
/// `fs::remove_file`. When the bin is unavailable — a network share, a drive
/// without one — `trash` fails and that failure is reported as a failure. A
/// silent escalation from a recoverable delete to an unrecoverable one would
/// break exactly what the confirmation promised the user, which is the one
/// thing a delete button must not do.
pub(crate) fn recycle(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| format!("recycle: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A fresh temp directory per test, following the tags.rs / archive.rs
    /// convention (no dev-dependency; pid plus a counter keeps parallel tests
    /// apart).
    fn temp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("pb-recycle-test-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recycle_removes_the_file_from_its_folder() {
        let dir = temp_dir("basic");
        let file = dir.join("doomed.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(file.exists(), "fixture should exist before the delete");

        recycle(&file).unwrap();

        assert!(!file.exists(), "the file should no longer be at its path");
    }

    #[test]
    fn recycle_reports_an_error_for_a_path_that_is_not_there() {
        let dir = temp_dir("missing");
        let err = recycle(&dir.join("never-existed.txt"));
        assert!(err.is_err(), "a missing file must not report success");
    }
}

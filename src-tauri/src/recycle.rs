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
    // tags-004 code review (Finding 2): refused HERE, not only by callers that
    // remember to check first. `recycle_file` (below) already refuses a
    // directory before ever reaching this function, but the bulk sweep
    // (tags::tag_delete_all) calls this directly: it stats every member up
    // front via `classify_for_delete`, then runs the recycle loop for
    // however long hundreds of files take, so for the last member in a large
    // tag the window between ITS stat and this call is the whole sweep. If
    // something turned that path into a directory during that window,
    // `trash::delete` would recurse into it. Making the refusal structural —
    // every caller inherits it, not just the ones that ask first — closes
    // that window instead of relying on every call site remembering to.
    if path.is_dir() {
        return Err(format!("recycle: refused a directory: {}", path.display()));
    }
    trash::delete(path).map_err(|e| format!("recycle: {e}"))
}

/// Move one file to the Recycle Bin, on the user's explicit confirmation
/// (img-003).
///
/// The path comes from the WebView, so it goes through `ensure_allowed` — the
/// same sec-002 gate the two file-reading commands use, unchanged and not
/// widened. Anything the user can see they can already read, so a delete
/// scoped identically grants no new reach; and `ensure_allowed` canonicalizes
/// first, so `..` traversal and symlink escapes resolve to a real target
/// before the check, and a path that is not there fails on canonicalize
/// rather than reaching the bin.
///
/// This does not close the check-then-act window between that canonicalize
/// and the `recycle()` call below — something could replace what the
/// canonical path resolves to in between. It is accepted, not closed,
/// because `recycle()` is called on the canonical `PathBuf` `ensure_allowed`
/// already produced, never on the caller's original string, so the race
/// cannot be steered outside the authorized tree; because winning it needs
/// write access inside the user's OWN media directory, where an attacker in
/// that position could already delete or replace the file directly, gaining
/// nothing from racing this command instead; and because even a successful
/// race only recycles a file, which is RECOVERABLE from the bin — the race
/// cannot escalate into the one outcome this module refuses to allow.
///
/// The confirmation itself is the FRONTEND's job (see armDelete in
/// player-core.ts). This command deletes what it is given: it is the last
/// step, not the guard.
#[tauri::command]
pub(crate) async fn recycle_file(
    allow: tauri::State<'_, crate::AllowList>,
    path: String,
) -> Result<(), String> {
    let target = crate::ensure_allowed(&allow, &path)?;
    // Directories are refused here as well as in the UI. The UI decides which
    // tiles offer a delete; this decides what the command will ever do, and a
    // recursive folder delete is a materially different promise from removing
    // one file — one this app does not make anywhere.
    if target.is_dir() {
        return Err(crate::ipc_error(
            "recycle_file: refused a directory",
            target.display(),
            "folders cannot be deleted from here",
        ));
    }
    recycle(&target)
        .map_err(|e| crate::ipc_error("recycle_file", e, "that file could not be deleted"))
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

    /// tags-004 code review (Finding 2): `recycle()` itself must refuse a
    /// directory, not just `recycle_file` upstream of it — this is what the
    /// bulk sweep in tags.rs calls directly, bypassing that command.
    #[test]
    fn recycle_refuses_a_real_directory() {
        let dir = temp_dir("dir-refusal");
        let inside = dir.join("inside.txt");
        std::fs::write(&inside, b"x").unwrap();

        let err = recycle(&dir).expect_err("a directory must not be accepted");
        assert!(
            err.contains("directory"),
            "error should say why the directory was refused: {err}"
        );
        assert!(dir.exists(), "the directory must still be there — refused, not recycled");
        assert!(inside.exists(), "its contents must be untouched");
    }
}

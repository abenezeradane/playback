//! gallery-005: the folder watcher behind a live gallery.
//!
//! One watcher, one folder — at any moment at most one folder backs the active
//! view, so a second `watch_folder` replaces the first rather than accumulating.
//! Non-recursive on purpose: the grid's own listing is non-recursive, so a
//! change inside a sub-folder does not change the sub-folder's tile, and
//! recursing a photo tree would generate events for tiles that do not exist.
//!
//! The emitted event is deliberately COARSE about membership. `dir` says which
//! folder changed and the frontend re-lists it canonically; `touched` is only a
//! hint, used solely to invalidate a thumbnail for a file replaced in place.
//! If notify coalesces or drops entries from `touched`, the worst case is one
//! stale thumbnail — never a wrong grid.

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::Emitter;

use crate::{ensure_allowed, ipc_error, AllowList};

/// How long the folder must be quiet before the change is announced.
///
/// This is load-bearing, not hygiene. A file being copied in fires events for
/// as long as it is being written, so a TRAILING window waits for the copy to
/// finish by itself and the grid never tries to thumbnail a half-written file.
/// A fixed-interval debounce would fire mid-copy.
const QUIET_WINDOW: Duration = Duration::from_millis(300);

/// What the frontend is told about a watch attempt. `watching: false` is not a
/// failure to report to the user — it selects the poll fallback — but the
/// frontend cannot make that choice unless this says so honestly.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct WatchStatus {
    pub watching: bool,
    pub reason: String,
}

/// The `folder-changed` payload. See the module comment on why `touched` is a
/// hint rather than an authority.
#[derive(Debug, Clone, serde::Serialize)]
struct FolderChanged {
    dir: String,
    touched: Vec<String>,
}

/// The one live watcher. Dropping the `RecommendedWatcher` stops it; the
/// `generation` is what tells an already-running debounce thread that it has
/// been superseded and should exit without emitting.
#[derive(Default)]
pub(crate) struct GalleryWatch(Mutex<Option<Active>>);

pub(crate) struct Active {
    _watcher: RecommendedWatcher,
}

/// Monotonic, so a superseded debounce thread can recognise itself as stale.
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Flatten one quiet window's batches into the distinct paths it touched,
/// re-rooted onto `raw_dir`.
///
/// The watcher watches the CANONICAL directory, so on Windows every event
/// path arrives `\\?\`-prefixed. `list_folder_entries` deliberately builds
/// the paths the frontend holds from the RAW directory instead, so each one
/// round-trips through `convertFileSrc` and the asset-protocol scope grant
/// (see `list_dir_entries_matching`). Handing the frontend canonical paths
/// would leave `touched` unmatchable against its own listing, and a file
/// replaced in place -- same name, same count -- would keep its stale
/// thumbnail forever with nothing anywhere reporting a failure. The watch is
/// non-recursive, so every event path is a direct child of the watched
/// directory and its file name is all that is needed to re-root it.
fn coalesce_paths(batches: &[Vec<PathBuf>], raw_dir: &str) -> Vec<String> {
    let root = Path::new(raw_dir);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for batch in batches {
        for p in batch {
            let Some(name) = p.file_name() else { continue };
            let s = root.join(name).to_string_lossy().into_owned();
            if seen.insert(s.clone()) {
                out.push(s);
            }
        }
    }
    out
}

/// The gate `watch_folder` applies, split out so it is unit-testable without a
/// `tauri::State`. Same shape as `list_folder_images_impl` relative to its
/// command wrapper.
fn check_watchable(allow: &AllowList, path: &str) -> Result<PathBuf, String> {
    let canonical = ensure_allowed(allow, path)?;
    if !canonical.is_dir() {
        return Err("not a folder".to_string());
    }
    Ok(canonical)
}

/// Watch `path` (a directory), replacing any previous watch.
///
/// Routed through `ensure_allowed`, the SAME gate as `list_folder_images_impl`,
/// so this grants no filesystem reach: the only watchable folders are ones the
/// user already opened, which sec-002 already trusts for reads.
#[tauri::command]
pub(crate) fn watch_folder(
    app: tauri::AppHandle,
    allow: tauri::State<'_, AllowList>,
    state: tauri::State<'_, GalleryWatch>,
    path: String,
) -> Result<WatchStatus, String> {
    let canonical = check_watchable(&allow, &path)?;
    // Bump FIRST, then stop: dropping the old watcher is what wakes a draining
    // debounce thread, and that thread checks GENERATION on its way out. If the
    // bump came after the drop, a woken thread could pass the check and emit a
    // stale event for the folder we just replaced.
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    stop(&state);

    let (tx, rx) = channel();
    let mut watcher = match RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                let _ = tx.send(ev.paths);
            }
        },
        notify::Config::default(),
    ) {
        Ok(w) => w,
        Err(e) => {
            return Ok(WatchStatus {
                watching: false,
                reason: ipc_error("watch_folder: new", e, "watcher unavailable"),
            })
        }
    };
    if let Err(e) = watcher.watch(&canonical, RecursiveMode::NonRecursive) {
        // A network share or a removed drive lands here. Not an Err: the
        // frontend needs a STATUS so it can fall back to polling.
        return Ok(WatchStatus {
            watching: false,
            reason: ipc_error("watch_folder: watch", e, "folder cannot be watched"),
        });
    }

    // The raw path the frontend passed, not the canonical `\\?\` form — the
    // frontend compares this against its own `ui.galleryPath`.
    std::thread::spawn(move || debounce_loop(app, rx, path, generation));

    *state.0.lock().map_err(|_| "watch state poisoned".to_string())? =
        Some(Active { _watcher: watcher });
    Ok(WatchStatus { watching: true, reason: String::new() })
}

/// Drain one quiet window's worth of events, starting from `first`.
///
/// Returns every batch seen before the folder went quiet for `quiet`, or
/// `None` when the channel closed mid-drain (the watch was replaced or
/// dropped), in which case the caller must not emit.
///
/// Every event RESTARTS the window, because `recv_timeout` is called afresh
/// on each pass. That is what makes a mid-copy emit impossible: a large file
/// being written keeps the channel busy, so the drain keeps extending rather
/// than firing on a half-written file.
fn drain_quiet(
    rx: &Receiver<Vec<PathBuf>>,
    first: Vec<PathBuf>,
    quiet: Duration,
) -> Option<Vec<Vec<PathBuf>>> {
    let mut batches = vec![first];
    loop {
        match rx.recv_timeout(quiet) {
            Ok(more) => batches.push(more),
            Err(RecvTimeoutError::Timeout) => return Some(batches),
            Err(RecvTimeoutError::Disconnected) => return None,
        }
    }
}

/// Block for a change, drain until the folder goes quiet, emit once.
fn debounce_loop(app: tauri::AppHandle, rx: Receiver<Vec<PathBuf>>, dir: String, generation: u64) {
    while let Ok(first) = rx.recv() {
        let Some(batches) = drain_quiet(&rx, first, QUIET_WINDOW) else { return };
        if GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation {
            return; // superseded by a newer watch; this folder is no longer open
        }
        let _ = app.emit(
            "folder-changed",
            FolderChanged { dir: dir.clone(), touched: coalesce_paths(&batches, &dir) },
        );
    }
}

/// Drop the live watcher, if any. Idempotent.
fn stop(state: &tauri::State<'_, GalleryWatch>) {
    // Take the old Active OUT under the lock and drop it after releasing, so a
    // watcher whose Drop blocks on OS teardown cannot hold this lock. A poisoned
    // lock is recovered rather than ignored: silently no-oping here would make
    // the watch permanently unstoppable and leak it for the life of the process.
    let previous = match state.0.lock() {
        Ok(mut slot) => slot.take(),
        Err(poisoned) => {
            let mut slot = poisoned.into_inner();
            let taken = slot.take();
            drop(slot);
            state.0.clear_poison();
            taken
        }
    };
    drop(previous);
}

#[tauri::command]
pub(crate) fn unwatch_folder(state: tauri::State<'_, GalleryWatch>) {
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    stop(&state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use crate::AllowList;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("playback-watch-{tag}"));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    // The spec's security claim, as an executable assertion: watching is gated
    // by the SAME allow-list as reading. Mirrors
    // `list_folder_images_denies_an_unauthorized_folder`.
    #[test]
    fn watching_denies_an_unauthorized_folder() {
        let base = temp_dir("deny");
        let media = base.join("photos");
        fs::create_dir_all(&media).unwrap();
        let allow = AllowList::default(); // nothing authorized -> deny by default
        assert_eq!(
            check_watchable(&allow, media.to_str().unwrap()),
            Err("path not allowed".to_string())
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn watching_refuses_a_file_because_only_folders_are_watched() {
        let base = temp_dir("file");
        let photo = base.join("a.jpg");
        fs::write(&photo, b"x").unwrap();
        let allow = AllowList::default();
        allow.authorize_for_test(&base);
        assert_eq!(
            check_watchable(&allow, photo.to_str().unwrap()),
            Err("not a folder".to_string())
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn watching_allows_an_authorized_folder() {
        let base = temp_dir("allow");
        let allow = AllowList::default();
        allow.authorize_for_test(&base);
        assert!(check_watchable(&allow, base.to_str().unwrap()).is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    // REVIEW FOCUS 4: a file created and deleted inside one quiet window is in
    // `touched` but not in the folder. Coalescing must not assume it survives.
    #[test]
    fn ignores_a_touched_path_that_is_no_longer_in_the_folder() {
        let batches = vec![vec![PathBuf::from(r"C:\pics\ghost.jpg")]];
        // coalesce_paths reports it verbatim and makes no claim it exists —
        // the frontend's merge intersects it against the fresh listing.
        assert_eq!(
            coalesce_paths(&batches, r"C:\pics"),
            vec![r"C:\pics\ghost.jpg".to_string()]
        );
    }

    #[test]
    fn coalesce_deduplicates_paths_across_one_quiet_window() {
        // A single file copied in fires many events; the frontend needs the
        // path once, not once per fragment.
        let batches = vec![
            vec![PathBuf::from(r"C:\pics\a.jpg")],
            vec![PathBuf::from(r"C:\pics\a.jpg"), PathBuf::from(r"C:\pics\b.jpg")],
            vec![PathBuf::from(r"C:\pics\a.jpg")],
        ];
        let mut got = coalesce_paths(&batches, r"C:\pics");
        got.sort();
        assert_eq!(got, vec![r"C:\pics\a.jpg".to_string(), r"C:\pics\b.jpg".to_string()]);
    }

    #[test]
    fn coalesce_of_nothing_is_empty() {
        assert!(coalesce_paths(&[], r"C:\pics").is_empty());
    }

    // The watcher watches the CANONICAL directory, so on Windows every event path
    // arrives `\\?\`-prefixed, while the listing the frontend holds is built from
    // the RAW directory. Re-rooting is what makes `touched` matchable at all --
    // without it, a file replaced in place keeps its stale thumbnail forever and
    // nothing reports a failure. Found by the end-to-end smoke (Oracle F), not by
    // any unit test, which is why this one exists.
    #[test]
    fn coalesce_reroots_canonical_event_paths_onto_the_raw_directory() {
        let batches = vec![vec![PathBuf::from(r"\\?\C:\pics\a.jpg")]];
        assert_eq!(
            coalesce_paths(&batches, r"C:\pics"),
            vec![r"C:\pics\a.jpg".to_string()]
        );
    }

    // REVIEW FOCUS 1: a large file being copied in fires events for as long as it
    // is being written. Every event must RESTART the window, so the emit lands
    // after the copy finishes rather than on a half-written file. This drives the
    // SHIPPED drain, not a model of it.
    #[test]
    fn drain_restarts_the_window_on_every_event() {
        let (tx, rx) = channel();
        let sender = std::thread::spawn(move || {
            for i in 0..4 {
                tx.send(vec![PathBuf::from(format!("/pics/{i}.jpg"))]).unwrap();
                std::thread::sleep(Duration::from_millis(120));
            }
            // Hold the sender open past the final window so the drain ends on a
            // TIMEOUT (the folder going quiet), not on the channel closing --
            // otherwise this would pass for the wrong reason.
            std::thread::sleep(Duration::from_millis(600));
        });
        let first = rx.recv().unwrap();
        let batches = drain_quiet(&rx, first, Duration::from_millis(300)).expect("quiet, not closed");
        // 120ms spacing never reaches the 300ms window, so all four arrive in ONE
        // drain. A window that did not restart would have returned 1.
        assert_eq!(batches.len(), 4);
        sender.join().unwrap();
    }

    #[test]
    fn drain_stops_once_the_folder_goes_quiet() {
        let (tx, rx) = channel();
        tx.send(vec![PathBuf::from("/pics/a.jpg")]).unwrap();
        let first = rx.recv().unwrap();
        let started = std::time::Instant::now();
        let batches = drain_quiet(&rx, first, Duration::from_millis(200)).expect("quiet, not closed");
        assert_eq!(batches.len(), 1);
        assert!(started.elapsed() >= Duration::from_millis(200));
        drop(tx);
    }

    #[test]
    fn drain_reports_the_channel_closing_so_no_stale_event_is_emitted() {
        let (tx, rx) = channel();
        tx.send(vec![PathBuf::from("/pics/a.jpg")]).unwrap();
        let first = rx.recv().unwrap();
        drop(tx); // the watch was replaced -- its watcher and sender are gone
        assert!(drain_quiet(&rx, first, Duration::from_millis(300)).is_none());
    }
}

//! player.rs — the native (embedded libmpv) playback engine (native-001).
//!
//! Command + event bridge between the WebView frontend and one lazily-created
//! mpv core embedded into the main window via `wid` (mpv creates its own
//! auto-resizing child HWND; the transparent WebView2 composites the web chrome
//! above it — spike-verified on this machine). The full IPC contract lives in
//! docs/native-engine-ipc.md; change it and this file together.
//!
//! Concurrency/teardown model (the safety argument, do not weaken):
//! * every mpv interaction happens while holding the `PlayerState` mutex;
//! * shutdown `take()`s the `Player` out under that same mutex, quiesces the
//!   event thread (quit flag + `mpv_wakeup` + join), and only then calls
//!   `mpv_terminate_destroy` — so no command can ever race the terminate;
//! * window close is intercepted in lib.rs (`CloseRequested`) and runs this
//!   shutdown while the parent HWND still exists (mpv owns a child of it);
//! * a spontaneous `MPV_EVENT_SHUTDOWN` marks the player dead; the next
//!   `player_load` reaps it and lazily re-creates the engine.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use tauri::{Emitter, Manager};

use crate::mp4probe::{probe_mp4_duration, ProbedDuration};
use crate::mpv::{self, ffi, Mpv, MpvEvent, PropValue};
use crate::{ipc_error, AllowList};

/// Cadence of `time` events to the WebView — matches the HTML element's
/// ~4 Hz `timeupdate`, which the old controller cadence was built around.
const TIME_EVENT_INTERVAL_MS: u64 = 250;

/// The managed engine state: `None` until the first native load.
#[derive(Default)]
pub struct PlayerState {
    inner: Mutex<Option<Player>>,
    shot_seq: AtomicU64,
}

struct Player {
    mpv: Arc<Mpv>,
    load_seq: Arc<AtomicU64>,
    quit: Arc<AtomicBool>,
    dead: Arc<AtomicBool>,
    pending_first_frame: Arc<AtomicBool>,
    probe: Arc<Mutex<Option<ProbedDuration>>>,
    event_thread: Option<std::thread::JoinHandle<()>>,
}

/// Lock the player slot, recovering from a poisoned mutex (a panicked holder
/// must never permanently wedge playback; release builds abort on panic anyway).
fn lock_slot(state: &PlayerState) -> MutexGuard<'_, Option<Player>> {
    state.inner.lock().unwrap_or_else(|p| p.into_inner())
}

/// Run `f` against the live engine (error when none is running). The mutex is
/// held across the mpv call — see the module-level safety argument.
fn with_player<T>(
    state: &PlayerState,
    f: impl FnOnce(&Player) -> Result<T, String>,
) -> Result<T, String> {
    let guard = lock_slot(state);
    match guard.as_ref() {
        Some(p) if !p.dead.load(Ordering::SeqCst) => f(p),
        _ => Err("player not running".to_string()),
    }
}

fn mpv_err(context: &str, e: mpv::MpvError) -> String {
    ipc_error(context, e, "player error")
}

// ---------------------------------------------------------------------------
// Events to the WebView (the docs/native-engine-ipc.md payloads)
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum PlayerEventMsg {
    Loaded {
        load_seq: u64,
        duration: f64,
        width: i64,
        height: i64,
        container_fps: Option<f64>,
    },
    Duration {
        load_seq: u64,
        duration: f64,
    },
    Time {
        load_seq: u64,
        position: f64,
    },
    Pause {
        load_seq: u64,
        paused: bool,
    },
    Eof {
        load_seq: u64,
    },
    PlaybackRestart {
        load_seq: u64,
    },
    EndFile {
        load_seq: u64,
        reason: &'static str,
        message: Option<String>,
    },
    Shutdown,
}

/// Map an `mpv_end_file_reason` to the contract's string. Pure + unit-tested.
fn end_file_reason_str(reason: i32) -> &'static str {
    match reason {
        ffi::MPV_END_FILE_REASON_EOF => "eof",
        ffi::MPV_END_FILE_REASON_STOP => "stop",
        ffi::MPV_END_FILE_REASON_QUIT => "quit",
        ffi::MPV_END_FILE_REASON_ERROR => "error",
        ffi::MPV_END_FILE_REASON_REDIRECT => "redirect",
        _ => "stop",
    }
}

// ---------------------------------------------------------------------------
// Test hooks (env-gated; inert in production — see the IPC contract)
// ---------------------------------------------------------------------------

pub(crate) fn test_log_path() -> Option<PathBuf> {
    std::env::var_os("PLAYBACK_TEST_LOG").map(PathBuf::from)
}

fn test_shot_dir() -> Option<PathBuf> {
    std::env::var_os("PLAYBACK_TEST_SHOT_DIR").map(PathBuf::from)
}

/// Append one `t_ms=<n> ev=<name> [k=v…]` line to the test log (no-op without
/// the env var; failures are swallowed — the log is evidence, not control flow).
/// The line is preformatted and written with ONE write_all: multiple threads
/// log concurrently (the event thread + async command threads, native-002),
/// and Windows append mode is only atomic per syscall — `writeln!` on a File
/// issues one write per format fragment, which interleaved as torn lines.
pub(crate) fn test_log(path: &Option<PathBuf>, start: Instant, line: &str) {
    let Some(p) = path else { return };
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let full = format!("t_ms={} {}\n", start.elapsed().as_millis(), line);
        let _ = f.write_all(full.as_bytes());
    }
}

// ---------------------------------------------------------------------------
// mpv child-window z-order (spike-verified: the child's class is "mpv" and it
// is created at the BOTTOM of the sibling z-order — this pass is belt-and-
// braces against mpv/WebView2 internals changing)
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn push_mpv_child_to_bottom(parent: isize) {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE,
    };

    unsafe extern "system" fn cb(h: HWND, _l: LPARAM) -> i32 {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32) };
        let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        if class == "mpv" {
            unsafe {
                SetWindowPos(
                    h,
                    HWND_BOTTOM,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
            return 0; // stop enumerating
        }
        1
    }
    unsafe {
        EnumChildWindows(parent as HWND, Some(cb), 0);
    }
}

#[cfg(not(windows))]
fn push_mpv_child_to_bottom(_parent: isize) {}

// ---------------------------------------------------------------------------
// Engine creation + event thread
// ---------------------------------------------------------------------------

fn create_player(app: &tauri::AppHandle) -> Result<Player, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    let hwnd = window
        .hwnd()
        .map_err(|e| ipc_error("player: hwnd", e, "player error"))?
        .0 as isize;

    let mpv = Mpv::create().map_err(|e| ipc_error("player: load libmpv", e, "player unavailable"))?;

    // Baseline options (pure, unit-tested), then TEST-ONLY extras, then wid.
    let cache_dir = crate::shader_cache_dir();
    let cache_str = cache_dir.as_deref().and_then(Path::to_str);
    for (k, v) in mpv::engine_options(crate::read_hwaccel_pref(), cache_str) {
        mpv.set_option_str(&k, &v)
            .map_err(|e| mpv_err("player: option", e))?;
    }
    if let Ok(extra) = std::env::var("PLAYBACK_MPV_OPTS") {
        for (k, v) in mpv::parse_extra_opts(&extra) {
            // Test-only overrides; a bad key must not brick the engine.
            if let Err(e) = mpv.set_option_str(&k, &v) {
                eprintln!("[playback] PLAYBACK_MPV_OPTS {k}={v}: {e}");
            }
        }
    }
    mpv.set_option_i64("wid", hwnd as i64)
        .map_err(|e| mpv_err("player: wid", e))?;
    mpv.initialize().map_err(|e| mpv_err("player: initialize", e))?;

    // Observed properties → the tagged player-event stream.
    for (name, format) in [
        ("time-pos", ffi::MPV_FORMAT_DOUBLE),
        ("duration", ffi::MPV_FORMAT_DOUBLE),
        ("pause", ffi::MPV_FORMAT_FLAG),
        ("eof-reached", ffi::MPV_FORMAT_FLAG),
    ] {
        mpv.observe(name, format).map_err(|e| mpv_err("player: observe", e))?;
    }

    push_mpv_child_to_bottom(hwnd);

    // mpv warnings/errors go to stderr (same channel as ipc_error detail) —
    // the terminal is disabled, so this is the only native diagnostics tap.
    let _ = mpv.request_log_messages("warn");

    let mpv = Arc::new(mpv);
    let load_seq = Arc::new(AtomicU64::new(0));
    let quit = Arc::new(AtomicBool::new(false));
    let dead = Arc::new(AtomicBool::new(false));
    let pending_first_frame = Arc::new(AtomicBool::new(false));
    let probe: Arc<Mutex<Option<ProbedDuration>>> = Arc::new(Mutex::new(None));

    let start = Instant::now();
    let log = test_log_path();
    test_log(&log, start, "ev=engine-init engine=native");

    let ctx = EventCtx {
        mpv: Arc::clone(&mpv),
        app: app.clone(),
        load_seq: Arc::clone(&load_seq),
        quit: Arc::clone(&quit),
        dead: Arc::clone(&dead),
        pending_first_frame: Arc::clone(&pending_first_frame),
        probe: Arc::clone(&probe),
        parent_hwnd: hwnd,
        start,
        log,
    };
    let event_thread = std::thread::Builder::new()
        .name("mpv-events".into())
        .spawn(move || event_loop(ctx))
        .map_err(|e| ipc_error("player: event thread", e, "player error"))?;

    Ok(Player {
        mpv,
        load_seq,
        quit,
        dead,
        pending_first_frame,
        probe,
        event_thread: Some(event_thread),
    })
}

struct EventCtx {
    mpv: Arc<Mpv>,
    app: tauri::AppHandle,
    load_seq: Arc<AtomicU64>,
    quit: Arc<AtomicBool>,
    dead: Arc<AtomicBool>,
    pending_first_frame: Arc<AtomicBool>,
    probe: Arc<Mutex<Option<ProbedDuration>>>,
    parent_hwnd: isize,
    start: Instant,
    log: Option<PathBuf>,
}

fn event_loop(ctx: EventCtx) {
    let mut throttle = mpv::Throttle::new(TIME_EVENT_INTERVAL_MS);
    let emit = |msg: &PlayerEventMsg| {
        let _ = ctx.app.emit("player-event", msg);
    };
    // The seq stamped onto events is LATCHED at file boundaries (START_FILE),
    // not read live per event: player_load bumps the counter BEFORE issuing
    // loadfile, so an old file's queued events (eof-reached, END_FILE, a
    // settling seek) drained after the bump would otherwise carry the NEW
    // file's seq and defeat the frontend's stale-event guard — auto-advancing
    // past the file the user just opened, or surfacing the old file's error
    // against the new one (found by the native-001 code review).
    let mut current_seq: u64 = 0;
    loop {
        if ctx.quit.load(Ordering::SeqCst) {
            break;
        }
        let ev = ctx.mpv.wait_event(0.5);
        if matches!(ev, MpvEvent::StartFile) {
            current_seq = ctx.load_seq.load(Ordering::SeqCst);
        }
        let seq = current_seq;
        match ev {
            MpvEvent::Shutdown => {
                ctx.dead.store(true, Ordering::SeqCst);
                emit(&PlayerEventMsg::Shutdown);
                break;
            }
            MpvEvent::FileLoaded => {
                // Best-known duration. For a zero-duration fragmented MP4 the
                // demuxer reports a PARTIAL estimate at load (it has only read
                // the head fragments — observed: 8.3 s of a 60 s fixture) that
                // grows during playback, while the app-side mfra probe knows
                // the last fragment's start time — a tight lower bound of the
                // real duration. Take the LARGER of the two so seeks aren't
                // clamped to the partial estimate; mpv's later `duration`
                // property updates refine it further (the frontend keeps max).
                let demuxer = ctx
                    .mpv
                    .get_prop_f64("duration")
                    .ok()
                    .filter(|d| d.is_finite() && *d > 0.0);
                let probed = *ctx.probe.lock().unwrap_or_else(|p| p.into_inner());
                let (duration, source) = match (demuxer, probed) {
                    (Some(d), Some(p)) if p.seconds > d => (p.seconds, p.source),
                    (Some(d), _) => (d, "demuxer"),
                    (None, Some(p)) => (p.seconds, p.source),
                    (None, None) => (0.0, "none"),
                };
                let width = ctx.mpv.get_prop_i64("width").unwrap_or(0);
                let height = ctx.mpv.get_prop_i64("height").unwrap_or(0);
                let container_fps = ctx.mpv.get_prop_f64("container-fps").ok().filter(|f| *f > 0.0);
                push_mpv_child_to_bottom(ctx.parent_hwnd);
                throttle.reset();
                test_log(&ctx.log, ctx.start, "ev=file-loaded");
                test_log(
                    &ctx.log,
                    ctx.start,
                    &format!("ev=duration value={duration:.3} src={source}"),
                );
                emit(&PlayerEventMsg::Loaded {
                    load_seq: seq,
                    duration,
                    width,
                    height,
                    container_fps,
                });
            }
            MpvEvent::Seek => {
                throttle.reset();
            }
            MpvEvent::PlaybackRestart => {
                // Only the CURRENT load's first restart is "first-frame"; a
                // stale restart from the replaced file (pre-START_FILE) must
                // not consume the flag or the test-log line lies.
                let is_current = seq == ctx.load_seq.load(Ordering::SeqCst);
                if is_current && ctx.pending_first_frame.swap(false, Ordering::SeqCst) {
                    let hwdec = ctx
                        .mpv
                        .get_prop_string("hwdec-current")
                        .unwrap_or_else(|_| "unknown".into());
                    test_log(&ctx.log, ctx.start, &format!("ev=first-frame hwdec={hwdec}"));
                } else if let Ok(t) = ctx.mpv.get_prop_f64("time-pos") {
                    test_log(&ctx.log, ctx.start, &format!("ev=seek-done time={t:.3}"));
                }
                throttle.reset();
                emit(&PlayerEventMsg::PlaybackRestart { load_seq: seq });
            }
            MpvEvent::EndFile { reason, error_code } => {
                let reason = end_file_reason_str(reason);
                let message = if reason == "error" {
                    Some(
                        ctx.mpv
                            .get_prop_string("error")
                            .ok()
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| format!("playback failed ({error_code})")),
                    )
                } else {
                    None
                };
                // Why the file ended, in mpv's own words: "stop" is the core
                // honouring a `stop` command (the teardown oracle for a view
                // that leaves the player), "eof" is the clip running out.
                test_log(&ctx.log, ctx.start, &format!("ev=end-file reason={reason}"));
                emit(&PlayerEventMsg::EndFile { load_seq: seq, reason, message });
            }
            MpvEvent::Log { level, text } => {
                eprint!("[mpv/{level}] {text}"); // mpv text is newline-terminated
            }
            MpvEvent::Property { name, value } => match (name.as_str(), value) {
                ("time-pos", PropValue::Double(position)) => {
                    let now_ms = ctx.start.elapsed().as_millis() as u64;
                    if throttle.admit(now_ms) {
                        emit(&PlayerEventMsg::Time { load_seq: seq, position });
                    }
                }
                ("duration", PropValue::Double(duration)) if duration > 0.0 => {
                    emit(&PlayerEventMsg::Duration { load_seq: seq, duration });
                }
                ("pause", PropValue::Flag(paused)) => {
                    // A pause flip resets the time throttle so the NEXT time-pos
                    // emits immediately. This is what makes frame-step (native-002)
                    // position updates prompt: mpv's forward frame-step unpauses
                    // for one frame and re-pauses WITHOUT any Seek/PlaybackRestart
                    // event, so the post-step time-pos would otherwise wait out
                    // the 250 ms cadence.
                    throttle.reset();
                    let t = ctx.mpv.get_prop_f64("time-pos").unwrap_or(-1.0);
                    test_log(
                        &ctx.log,
                        ctx.start,
                        &format!("ev=pause paused={paused} time={t:.3}"),
                    );
                    emit(&PlayerEventMsg::Pause { load_seq: seq, paused });
                }
                ("eof-reached", PropValue::Flag(true)) => {
                    emit(&PlayerEventMsg::Eof { load_seq: seq });
                }
                _ => {}
            },
            _ => {}
        }
    }
}

/// Quiesce and destroy the engine. Called with the slot already `take()`n out
/// under the state mutex (window close, or reaping a dead core).
fn destroy_player(mut p: Player) {
    p.quit.store(true, Ordering::SeqCst);
    p.mpv.wakeup();
    if let Some(h) = p.event_thread.take() {
        let _ = h.join();
    }
    match Arc::try_unwrap(p.mpv) {
        Ok(m) => m.terminate(),
        // Unreachable by construction (the thread held the only other clone);
        // leak rather than risk a concurrent terminate.
        Err(_) => eprintln!("[playback] player teardown: handle still shared; leaking"),
    }
}

/// Shut the engine down if it is running. Wired to the main window's
/// CloseRequested in lib.rs so mpv dies BEFORE its parent HWND does.
pub fn shutdown_player(state: &PlayerState) {
    let taken = lock_slot(state).take();
    if let Some(p) = taken {
        destroy_player(p);
    }
}

// ---------------------------------------------------------------------------
// Commands (docs/native-engine-ipc.md)
// ---------------------------------------------------------------------------

/// Cheap engine probe: can libmpv be loaded? Never creates an mpv core.
#[tauri::command]
pub fn player_engine_status() -> serde_json::Value {
    match crate::mpv::ffi::libmpv() {
        Ok(_) => serde_json::json!({ "available": true, "error": null }),
        Err(e) => {
            eprintln!("[playback] libmpv unavailable: {e}");
            serde_json::json!({ "available": false, "error": "libmpv-2.dll not found or incompatible" })
        }
    }
}

/// Load `path` into the native engine (creating it lazily), returning the new
/// load sequence number. Playback events for this file carry this `loadSeq`.
#[tauri::command]
pub fn player_load(
    app: tauri::AppHandle,
    allow: tauri::State<'_, AllowList>,
    state: tauri::State<'_, PlayerState>,
    path: String,
) -> Result<u64, String> {
    let canonical = crate::ensure_allowed(&allow, &path)?;

    let mut guard = lock_slot(&state);
    if guard.as_ref().is_some_and(|p| p.dead.load(Ordering::SeqCst)) {
        // The core shut itself down (fatal error). Reap and re-create.
        if let Some(p) = guard.take() {
            destroy_player(p);
        }
    }
    if guard.is_none() {
        *guard = Some(create_player(&app)?);
    }
    let player = guard.as_ref().expect("player just ensured");

    // App-side duration probe for MP4-family containers (zero-duration
    // fragmented MP4s report nothing at load — see mp4probe.rs).
    let probed = matches!(
        canonical.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()),
        Some(ref e) if ["mp4", "m4v", "mov"].contains(&e.as_str())
    )
    .then(|| {
        std::fs::File::open(&canonical)
            .ok()
            .and_then(|mut f| probe_mp4_duration(&mut f).ok().flatten())
    })
    .flatten();
    *player.probe.lock().unwrap_or_else(|p| p.into_inner()) = probed;

    let seq = player.load_seq.fetch_add(1, Ordering::SeqCst) + 1;
    player.pending_first_frame.store(true, Ordering::SeqCst);
    if let Some(log) = test_log_path() {
        test_log(&Some(log), Instant::now(), &format!("ev=load path={path}"));
    }
    // Raw (non-canonical) path — same form the rest of the app uses on Windows
    // (the canonical form carries a \\?\ verbatim prefix).
    player
        .mpv
        .command(&["loadfile", &path, "replace"])
        .map_err(|e| mpv_err("player_load", e))?;
    player
        .mpv
        .set_prop_flag("pause", false)
        .map_err(|e| mpv_err("player_load: unpause", e))?;
    Ok(seq)
}

/// Stop playback and idle the core (blanks the video child window).
#[tauri::command]
pub fn player_stop(state: tauri::State<'_, PlayerState>) -> Result<(), String> {
    with_player(&state, |p| {
        p.mpv.command(&["stop"]).map_err(|e| mpv_err("player_stop", e))
    })
}

/// Absolute seek. `exact` = frame-exact (hr-seek); otherwise keyframe-fast.
#[tauri::command]
pub fn player_seek(
    state: tauri::State<'_, PlayerState>,
    position: f64,
    exact: bool,
) -> Result<(), String> {
    with_player(&state, |p| {
        let pos = format!("{position:.3}");
        let flags = if exact { "absolute+exact" } else { "absolute+keyframes" };
        p.mpv
            .command(&["seek", &pos, flags])
            .map_err(|e| mpv_err("player_seek", e))
    })
}

#[tauri::command]
pub fn player_set_pause(state: tauri::State<'_, PlayerState>, paused: bool) -> Result<(), String> {
    with_player(&state, |p| {
        p.mpv.set_prop_flag("pause", paused).map_err(|e| mpv_err("player_set_pause", e))
    })
}

#[tauri::command]
pub fn player_set_speed(state: tauri::State<'_, PlayerState>, speed: f64) -> Result<(), String> {
    with_player(&state, |p| {
        p.mpv
            .set_prop_f64_async("speed", speed.clamp(0.01, 100.0))
            .map_err(|e| mpv_err("player_set_speed", e))
    })
}

/// Volume in mpv units (0–100, the frontend converts from its 0–1 scale).
#[tauri::command]
pub fn player_set_volume(state: tauri::State<'_, PlayerState>, volume: f64) -> Result<(), String> {
    with_player(&state, |p| {
        p.mpv
            .set_prop_f64_async("volume", volume.clamp(0.0, 100.0))
            .map_err(|e| mpv_err("player_set_volume", e))
    })
}

#[tauri::command]
pub fn player_set_mute(state: tauri::State<'_, PlayerState>, mute: bool) -> Result<(), String> {
    with_player(&state, |p| {
        p.mpv.set_prop_flag_async("mute", mute).map_err(|e| mpv_err("player_set_mute", e))
    })
}

/// Whole-file loop. mpv loops internally without firing eof-reached — exactly
/// mirroring how the element's `loop` suppresses `ended`.
#[tauri::command]
pub fn player_set_loop_file(state: tauri::State<'_, PlayerState>, on: bool) -> Result<(), String> {
    with_player(&state, |p| {
        p.mpv
            .set_prop_str_async("loop-file", if on { "inf" } else { "no" })
            .map_err(|e| mpv_err("player_set_loop_file", e))
    })
}

/// Runtime hardware-decode switch (the Settings hwaccel toggle, no restart).
#[tauri::command]
pub fn player_set_hwdec(state: tauri::State<'_, PlayerState>, on: bool) -> Result<(), String> {
    with_player(&state, |p| {
        p.mpv
            .set_prop_str("hwdec", if on { "auto-safe" } else { "no" })
            .map_err(|e| mpv_err("player_set_hwdec", e))
    })
}

/// Step exactly one video frame forward/back (mpv `frame-step` /
/// `frame-back-step`, cut view, native-002). mpv pauses on completion; the
/// forward step briefly unpauses, so the event thread's pause-flip throttle
/// reset is what delivers the post-step position promptly. The back step is
/// internally an hr-seek and settles like any seek (playbackRestart).
#[tauri::command]
pub fn player_frame_step(state: tauri::State<'_, PlayerState>, back: bool) -> Result<(), String> {
    with_player(&state, |p| {
        p.mpv
            .command(&[if back { "frame-back-step" } else { "frame-step" }])
            .map_err(|e| mpv_err("player_frame_step", e))
    })
}

/// Reserve window-fraction margins around the video (cut-view deck layout,
/// native-002; the standard player passes zeros).
#[tauri::command]
pub fn player_set_video_margin_ratio(
    state: tauri::State<'_, PlayerState>,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
) -> Result<(), String> {
    with_player(&state, |p| {
        for (name, v) in [
            ("video-margin-ratio-left", left),
            ("video-margin-ratio-right", right),
            ("video-margin-ratio-top", top),
            ("video-margin-ratio-bottom", bottom),
        ] {
            p.mpv
                .set_prop_f64_async(name, v.clamp(0.0, 0.9))
                .map_err(|e| mpv_err("player_set_video_margin_ratio", e))?;
        }
        Ok(())
    })
}

/// TEST-ONLY frame oracle: mpv screenshot-to-file of the current frame.
/// Disabled (error) unless `PLAYBACK_TEST_SHOT_DIR` is set by the smoke harness.
#[tauri::command]
pub fn player_screenshot(
    state: tauri::State<'_, PlayerState>,
    mode: String,
) -> Result<String, String> {
    let dir = test_shot_dir().ok_or_else(|| "screenshots disabled".to_string())?;
    let mode = match mode.as_str() {
        "window" => "window",
        _ => "video",
    };
    let n = state.shot_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let out = dir.join(format!("shot-{n:03}.png"));
    let out_str = out.to_string_lossy().into_owned();
    with_player(&state, |p| {
        p.mpv
            .command(&["screenshot-to-file", &out_str, mode])
            .map_err(|e| mpv_err("player_screenshot", e))
    })?;
    // screenshot-to-file is synchronous in mpv, but give the filesystem a beat.
    for _ in 0..40 {
        if out.exists() {
            return Ok(out_str);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Err("screenshot not written".to_string())
}

/// Which test hooks are live (frontend binds F9/Shift+F9 iff shotEnabled).
#[tauri::command]
pub fn test_flags() -> serde_json::Value {
    serde_json::json!({ "shotEnabled": test_shot_dir().is_some() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn end_file_reasons_map_to_contract_strings() {
        assert_eq!(end_file_reason_str(ffi::MPV_END_FILE_REASON_EOF), "eof");
        assert_eq!(end_file_reason_str(ffi::MPV_END_FILE_REASON_STOP), "stop");
        assert_eq!(end_file_reason_str(ffi::MPV_END_FILE_REASON_QUIT), "quit");
        assert_eq!(end_file_reason_str(ffi::MPV_END_FILE_REASON_ERROR), "error");
        assert_eq!(end_file_reason_str(ffi::MPV_END_FILE_REASON_REDIRECT), "redirect");
        // Unknown/future reasons degrade to the ignored "stop", never a panic.
        assert_eq!(end_file_reason_str(42), "stop");
        assert_eq!(end_file_reason_str(-1), "stop");
    }

    #[test]
    fn player_event_serialization_matches_the_ipc_contract() {
        // The frontend switches on `kind` and camelCase field names; pin them.
        let loaded = serde_json::to_value(PlayerEventMsg::Loaded {
            load_seq: 3,
            duration: 30.5,
            width: 1920,
            height: 1080,
            container_fps: Some(60.0),
        })
        .unwrap();
        assert_eq!(loaded["kind"], "loaded");
        assert_eq!(loaded["loadSeq"], 3);
        assert_eq!(loaded["containerFps"], 60.0);

        let restart =
            serde_json::to_value(PlayerEventMsg::PlaybackRestart { load_seq: 7 }).unwrap();
        assert_eq!(restart["kind"], "playbackRestart");

        let end = serde_json::to_value(PlayerEventMsg::EndFile {
            load_seq: 7,
            reason: "error",
            message: Some("boom".into()),
        })
        .unwrap();
        assert_eq!(end["kind"], "endFile");
        assert_eq!(end["reason"], "error");

        let time = serde_json::to_value(PlayerEventMsg::Time { load_seq: 1, position: 1.25 }).unwrap();
        assert_eq!(time["kind"], "time");
        assert_eq!(time["position"], 1.25);

        let eof = serde_json::to_value(PlayerEventMsg::Eof { load_seq: 2 }).unwrap();
        assert_eq!(eof["kind"], "eof");

        let shutdown = serde_json::to_value(PlayerEventMsg::Shutdown).unwrap();
        assert_eq!(shutdown["kind"], "shutdown");
    }
}

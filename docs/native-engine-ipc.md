# Native engine IPC contract (native-001)

The single source of truth for the Rust⇄frontend interface of the embedded-libmpv
playback engine. The Rust side (`src-tauri/src/player.rs` + `src-tauri/src/mpv/`)
implements it; the frontend adapter (`src/lib/engine-native.ts`) mirrors it as
TypeScript types. Change BOTH sides together, and only via this document.

## Engine model

- One mpv instance, created **lazily on the first `player_load`** (never at app
  startup — the home screen/image viewer must not pay for it), embedded into the
  main window via the `wid` option (mpv creates its own auto-resizing child HWND).
- The DLL (`libmpv-2.dll`) is loaded at runtime (`libloading`); a missing/broken
  DLL is a **reported state** (`player_engine_status`), not a startup failure.
- Every mpv interaction happens while holding the `PlayerState` mutex, including
  shutdown (which `take()`s the player out under that mutex) — this is the
  concurrency-safety argument for terminate vs in-flight commands.
- On window close: `CloseRequested` is intercepted, the engine is shut down
  (quit event thread → `mpv_terminate_destroy`) **while the parent HWND still
  exists**, then the window closes.
- Spontaneous `MPV_EVENT_SHUTDOWN`: state is cleared so the next `player_load`
  lazily re-creates the engine; the frontend receives `{kind:"shutdown"}` and
  falls back to the web engine for the current file.

## Commands

All file paths go through the sec-002 `ensure_allowed` gate. All errors cross
IPC as generic strings (detail to stderr via `ipc_error`, sec-005).

| command | args | returns | mpv mapping |
|---|---|---|---|
| `player_engine_status` | — | `{ available: bool, error: string \| null }` | DLL load probe only (no `mpv_create`) |
| `player_load` | `{ path }` | `loadSeq: number` | lazy engine create + `loadfile <path> replace`; resets pause to false; runs the mp4 duration probe (see events) |
| `player_stop` | — | — | `stop` (idles core, blanks child) |
| `player_seek` | `{ position: number, exact: bool }` | — | `seek <position> absolute+exact` / `absolute+keyframes` |
| `player_set_pause` | `{ paused: bool }` | — | `pause` property |
| `player_set_speed` | `{ speed: number }` | — | `speed` property |
| `player_set_volume` | `{ volume: number }` (0–100) | — | `volume` property |
| `player_set_mute` | `{ mute: bool }` | — | `mute` property |
| `player_set_loop_file` | `{ on: bool }` | — | `loop-file` = `inf`/`no` |
| `player_set_hwdec` | `{ on: bool }` | — | `hwdec` = `auto-safe`/`no` (runtime) |
| `player_set_video_margin_ratio` | `{ left, right, top, bottom }` (0–0.9) | — | `video-margin-ratio-*` properties |
| `player_screenshot` | `{ mode: "video" \| "window" }` | shot path | `screenshot-to-file <dir>/shot-N.png <mode>`; **errors unless `PLAYBACK_TEST_SHOT_DIR` is set** |
| `test_flags` | — | `{ shotEnabled: bool }` | env probe; frontend binds F9/Shift+F9 iff true |
| `get_engine_pref` | — | `"native" \| "web"` | native pref file `engine` (next to `hwaccel`); default `"web"` |
| `set_engine_pref` | `{ engine: "native" \| "web" }` | — | writes the pref file |

Deliberately absent in native-001: generic `player_set_property`, `player_init`,
A-B loop commands (A-B stays a JS timeupdate check for engine parity), frame-step
(native-002).

## Events

One Tauri event channel: `"player-event"`. Payload is a serde-tagged union
(`kind`, camelCase). Every playback event carries the `loadSeq` of the file it
belongs to; **the frontend MUST drop events whose `loadSeq` differs from the one
returned by its latest `player_load`** (and everything while that call is still
awaiting). This is the stale-event guard for racing loads (Next-spam,
single-instance open-file).

```ts
type PlayerEvent =
  | { kind: "loaded"; loadSeq: number; duration: number; width: number;
      height: number; containerFps: number | null }
      // on MPV_EVENT_FILE_LOADED. duration = mpv duration property if known,
      // else the native mvhd/mfra probe result, else 0.
  | { kind: "duration"; loadSeq: number; duration: number }   // late/updated duration
  | { kind: "time"; loadSeq: number; position: number }       // time-pos, throttled to 250 ms in Rust
  | { kind: "pause"; loadSeq: number; paused: boolean }
  | { kind: "eof"; loadSeq: number }                          // eof-reached -> true (keep-open)
  | { kind: "playbackRestart"; loadSeq: number }              // seek/restart completed
  | { kind: "endFile"; loadSeq: number; reason: "eof" | "stop" | "quit" | "error" | "redirect";
      message?: string }                                      // frontend acts ONLY on reason=error
  | { kind: "shutdown" };
```

Frontend mapping rules (implemented as the pure `applyPlayerEvent` reducer in
`player-core.ts`):
- `eof` fires the element-parity `ended` **exactly once** per file end (latch;
  cleared by seek-away, `play()`, or a new load). `loop-file=inf` suppresses
  `eof` inside mpv — matching how element `loop` suppresses `ended`.
- `time` is ignored while a seek is in flight (no rubber-banding).
- `playbackRestart` settles the seek coalescer (at most one `player_seek` in
  flight; latest target queued; 66 ms floor). The coalescer also releases on
  invoke rejection and a 500 ms watchdog so a failed seek can never wedge it.
- `endFile` with reason `stop`/`quit`/`redirect` is ignored (fires on every
  replace-load); `error` routes to the same error surface as a remux failure.

## Engine options (set before `mpv_initialize`)

`wid=<main window HWND>`, `vo=gpu-next`, `gpu-context=d3d11`,
`hwdec=auto-safe|no` (from the existing hwaccel pref file, read natively),
`keep-open=yes`, `pause=no`, `background-color=#000000`,
`input-default-bindings=no`, `input-vo-keyboard=no`, `input-cursor=no`,
`osc=no`, `osd-level=0`, `config=no`, `terminal=no`,
`demuxer-lavf-o=use_mfra_for=pts`  ← **load-bearing**: without it lavf never
reads the tail mfra index and seeks in zero-duration fragmented MP4s land near 0.

Then any `PLAYBACK_MPV_OPTS` entries (`key=value;key=value`, **test-only**, set
by smoke scripts — e.g. `d3d11-flip=no` for a GDI-capturable presentation; the
precedent is the test-only `--disable-features=DirectCompositionVideoOverlays`
WebView2 flag).

After `mpv_initialize`: push mpv's child HWND to the bottom of the sibling
z-order (`SetWindowPos(HWND_BOTTOM)`), re-asserted on every `FILE_LOADED`, so
the WebView2 child always composites above it and keeps all input.

## Test hooks (env-gated; inert in production)

- `PLAYBACK_MPV_OPTS` — extra mpv options (capture launches only, never
  measurement launches).
- `PLAYBACK_TEST_LOG` — absolute file path; the event thread appends
  `t_ms=<since engine create> ev=<name> [k=v ...]` lines:
  `engine-init`, `file-loaded path=`, `first-frame` (first playback-restart of a
  load), `seek-done time=`, `duration value= src=demuxer|probe`.
- `PLAYBACK_TEST_SHOT_DIR` — enables `player_screenshot` + the frontend F9
  binding (mpv `screenshot-to-file`: the exact decoded frame, immune to
  MPO-black window captures).

## DOM/CSS contract (frontend)

- Window is `"transparent": true`; `body{background:transparent}`,
  `.app{background:var(--canvas)}` — visually identical everywhere except:
- `.app[data-native-video="true"]` (+ its `.stage`) go transparent, `video#video`
  is display:none, and the permanent `#video-surface` div (class
  `video video--native`, carrying the old video click handler) becomes the
  geometry/click surface. The attribute is set via **direct `setAttribute`**
  (never a Svelte binding — rAF flush stalls unfocused, see memory) and only
  after the first `playbackRestart` of the current load.

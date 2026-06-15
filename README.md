# Playback

A fully featured desktop video player built with the **Tauri 2.0** framework.

The native shell (Rust) is intentionally thin — it provides the window, the
native "Open file" dialog, drag-and-drop, and the asset protocol that streams a
local video file into the WebView. All playback UI and logic lives in the
frontend (TypeScript + Vite) driving an HTML5 `<video>` element.

## Features

- **Open a video** via a native file dialog (`O` / "Open" button) or by
  **dragging a file onto the window**.
- **Play / pause / resume** — button, click-on-video, or `Space` / `K`.
- **Fast-forward / track back** 10 seconds — buttons or `→` / `←`.
- **Scrub** with a seek bar showing progress and buffered ranges.
- **Volume + mute** — slider, `M`, and `↑` / `↓`.
- **Playback speed** cycling (0.5×–2×).
- **Fullscreen** — button or `F`.
- **Auto-hiding controls** during playback.
- **Timestamps / chapters** — open the panel (`T` or the ☰ button), paste a list
  of `HH:MM:SS Title` lines, and the player draws a clickable marker per
  timestamp on the scrubber. Click a marker (or a row in the list) to jump there;
  press `A` / `D` to jump to the previous / next timestamp.

Supported containers/codecs depend on the system WebView2 (Windows) /
WebKitGTK / WKWebView: MP4 (H.264/AAC), WebM, and Ogg are the safe set.

## Project layout

| Path | Purpose |
|------|---------|
| `index.html` | Player markup (titlebar, empty state, video stage, controls). |
| `src/player-core.ts` | **Pure**, unit-tested playback logic (no DOM/Tauri). |
| `src/player-core.test.ts` | Vitest suite for the core logic. |
| `src/main.ts` | Wires the DOM + Tauri APIs + `<video>` to `player-core`. |
| `src/styles.css` | Dark "editorial" styling (see `DESIGN.md`). |
| `src-tauri/` | Rust/Tauri 2.0 shell (dialog plugin, asset protocol). |
| `samples/sample.mp4` | A 30-second test clip with an on-screen timecode. |

## Prerequisites

- Node.js + npm
- Rust toolchain (`cargo`)
- A system WebView (WebView2 on Windows 11 — already present)

## Develop & run

```bash
npm install          # install JS deps
npm test             # run the player-core unit tests
npm run tauri:dev    # launch the app (Vite dev server + native window)
```

## Build

```bash
npm run build              # frontend: tsc type-check + Vite production build
npm run tauri:build        # full release build + installers
npm run tauri -- build --no-bundle   # release exe only (no installers)
```

## Verify

```bash
./init.sh            # install deps + run the baseline test suite
```

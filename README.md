# Playback

A fully featured desktop video player built with the **Tauri 2.0** framework.

The native shell (Rust) is intentionally thin — it provides the window, the
native "Open file" dialog, drag-and-drop, and the asset protocol that streams a
local video file into the WebView. All playback UI and logic lives in the
frontend (TypeScript + Vite) driving an HTML5 `<video>` element.

The UI is being redesigned to match `docs/DESIGN.md` — a Raycast-inspired, dark
near-black editorial look (near-black canvas, hairline-bordered cards, a single
white primary CTA, Inter with the `ss03` stylistic set, and a red hero accent).
This replaces the earlier glassmorphic theme; the redesign is in progress, so the
current build may not yet match the spec. The layout is unchanged either way: a
home / library screen when nothing is open, and a full-bleed player with the
control bar, chapters panel, and overlays once a video is loaded.

## Features

- **Home / library screen** — when no video is open, a home screen offers the
  Open button, a drag-and-drop zone, and a **Recent files** list (a local,
  account-free history kept on this machine) so you can re-open a recent file in
  one click. The player's back button (top-left) returns here.
- **Open a video** via a native file dialog (`O` / "Open" button) or by
  **dragging a file onto the window**.
- **Play / pause / resume** — button, click-on-video, or `Space` / `K`.
- **Fast-forward / track back** 10 seconds — buttons or `→` / `←`.
- **Scrub** with a seek bar showing progress and buffered ranges.
- **Volume + mute** — slider, `M`, and `↑` / `↓`.
- **Playback speed** — cycle 0.5×–2× with the rate button, or step up / down
  with `+` / `-` (clamped at the ends, no wrap).
- **Fullscreen** — button or `F`.
- **Keyboard shortcuts overlay** — press `?` (or the keyboard button) for a full,
  grouped list of shortcuts; `Esc` (or the backdrop / close button) dismisses it.
  Shortcuts stay live after you use a control: clicking a button, the scrubber,
  or a volume slider hands focus back to the player, so a key press still drives
  playback rather than being swallowed by the last-clicked element. (Typing into
  a text field — e.g. the add-timestamp box — still goes to the field, not the
  player.)
- **Auto-hiding controls** during playback.
- **Timestamps / chapters** — open the panel (`T` or the ☰ button) and click
  **Add timestamp** to enter one as `HH:MM:SS Title` (Enter adds it and keeps the
  input open for the next). Pasting several lines at once adds them all and closes
  the input. Each timestamp becomes a clickable marker on the scrubber and a row
  in the list (with a hover **×** to remove it). Click a marker or row to jump
  there; press `A` / `D` to jump to the previous / next timestamp. A
  **current-chapter pill** names the active chapter as you play; the panel's
  **Always show current chapter** toggle keeps that pill pinned to the corner
  even after the controls auto-hide (the choice is remembered across launches).
- **Livestream playback** — open a file that is still being written and Playback
  tails it in real time (via MediaSource), holding a ~5 second live delay. A
  growing file is auto-detected (no special marker needed) and playback starts
  near the live edge, so even a multi-gigabyte capture opens quickly. You can
  track back and fast-forward through the buffered window, but fast-forward stops
  at the live edge once you catch up. A **LIVE** badge shows how far behind live
  you are; press `L` (or click the badge) to jump to live. When the file finishes
  writing it becomes an ordinary, fully-seekable file. Real recorder output
  (e.g. Streamlink capturing a Twitch stream) often writes fMP4 that browsers'
  MediaSource rejects; Playback transmuxes it on the fly (injects the missing AAC
  config, rewrites fragment addressing) so it plays.

Supported containers/codecs depend on the system WebView2 (Windows) /
WebKitGTK / WKWebView: MP4 (H.264/AAC), WebM, and Ogg are the safe set.
Livestream playback feeds a MediaSource, so the growing file must be a
fragmented MP4 (fMP4) — a progressive MP4 being written (its index only finalized
at the end) cannot be tailed until recording stops.

## Project layout

| Path | Purpose |
|------|---------|
| `index.html` | App markup (home / library, video stage, controls, chapters panel, keyboard-shortcuts overlay). |
| `src/player-core.ts` | **Pure**, unit-tested playback logic (no DOM/Tauri). |
| `src/player-core.test.ts` | Vitest suite for the core logic. |
| `src/main.ts` | Wires the DOM + Tauri APIs + `<video>` to `player-core`. |
| `src/styles.css` | App styling — being reworked to the `docs/DESIGN.md` spec. |
| `docs/DESIGN.md` | Current design spec for the UI (Raycast-inspired dark editorial). |
| `src-tauri/` | Rust/Tauri 2.0 shell (dialog plugin, asset protocol, livestream byte-streaming commands). |

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
npm run tauri -- build --no-bundle   # release exe only (no installers)

# The shippable installer (NSIS). Provision the gitignored binaries first —
# the installer bundles libmpv-2.dll (the DEFAULT playback engine since
# native-003) + the LGPL notices via the src-tauri/tauri.bundle.conf.json
# overlay. Plain `npm run tauri:build` uses the base config and produces
# installers WITHOUT libmpv — every install of those silently falls back to
# the WebView engine, so don't ship them.
node scripts/fetch-ffmpeg.mjs
node scripts/fetch-libmpv.mjs
npm run tauri:bundle
```

NSIS is the only supported installer target; the MSI/WiX target is not wired
to the libmpv bundling overlay.

## Verify

```bash
npm run check                # svelte-check (0 errors / 0 warnings expected)
npm test                     # vitest suite
(cd src-tauri && cargo test) # Rust unit tests
```

## Android

Playback also builds for Android phones (Android 11 / API 30 and later). On a
phone it asks once for All-files access, lists the phone's storage (internal
storage and any SD card) on Home, and opens a folder as the same gallery of
photos, archives and videos as on desktop, with video played by the web engine.
Delete, reveal, copy image and the native (mpv) engine are not on Android yet.

The build needs, on top of the prerequisites above:

- the Android SDK and NDK `27.2.12479018`
- JDK 17
- the Rust targets: `rustup target add aarch64-linux-android x86_64-linux-android`
- `ANDROID_HOME` (the SDK), `NDK_HOME` (the NDK) and `JAVA_HOME` (the JDK) set
- on Windows, Developer Mode turned on (the build creates a symlink)

```bash
npm run tauri android build -- --apk --target aarch64            # a phone
npm run tauri android build -- --apk --debug --target x86_64     # an emulator
```

Release APKs are signed with the key named in `src-tauri/gen/android/keystore.properties`
(git-ignored), which holds `keyAlias`, `password` and `storeFile`. Without that
file a release build is left unsigned.

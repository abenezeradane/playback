/**
 * main.ts — the UI/runtime layer.
 *
 * Bridges three things:
 *   1. The DOM controls (buttons, sliders).
 *   2. The native HTMLVideoElement (the real media engine).
 *   3. Tauri's native file APIs (open dialog + drag/drop + asset protocol).
 *
 * All non-trivial decisions (clamping a seek, cycling the rate, mute logic) are
 * delegated to the pure functions in player-core so they stay unit-testable.
 */

import "./styles.css";
import {
  createInitialState,
  clamp,
  formatTime,
  togglePlay,
  fastForward,
  rewind,
  seekTo,
  sectionSeekTime,
  sliderToTime,
  timeToSlider,
  progressFraction,
  bufferedFraction,
  nextRate,
  stepRate,
  setVolume,
  toggleMute,
  effectiveVolume,
  parseTimestamps,
  mergeTimestamps,
  clearTimestamps,
  markerFraction,
  previousTimestamp,
  nextTimestamp,
  activeTimestampIndex,
  timestampKey,
  parseTimestampStore,
  serializeTimestampStore,
  readStoredTimestamps,
  writeStoredTimestamps,
  DEFAULT_FPS,
  snapFps,
  formatSmpte,
  formatFps,
  lastFrameTime,
  fractionToTime,
  rulerTicks,
  isTextEntryTarget,
  createShuttle,
  shuttleStop,
  shuttleForward,
  shuttleReverse,
  shuttleRate,
  type PlayerState,
  type Timestamp,
  type TimestampStore,
  type Shuttle,
} from "./player-core";

const VIDEO_EXTENSIONS = ["mp4", "webm", "ogg", "ogv", "mov", "m4v", "mkv", "avi"];

// ---------------------------------------------------------------------------
// Element lookup
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const app = $<HTMLDivElement>("app");
const emptyState = $<HTMLElement>("empty-state");
const emptyError = $<HTMLParagraphElement>("empty-error");
const stage = $<HTMLElement>("stage");
const video = $<HTMLVideoElement>("video");
const controls = $<HTMLDivElement>("controls");
const centerToggle = $<HTMLDivElement>("center-toggle");
// Shown over an empty player when a livestream is opened (livestream playback is
// temporarily deprecated — we detect it but do not attempt to tail/play it).
const liveNotice = $<HTMLDivElement>("live-notice");

const btnOpen = $<HTMLButtonElement>("btn-open");
const btnOpenTop = $<HTMLButtonElement>("btn-open-top");
const dropZone = $<HTMLButtonElement>("drop-zone");

const recentCards = $<HTMLDivElement>("recent-cards");
const recentEmpty = $<HTMLDivElement>("recent-empty");
const btnClearRecent = $<HTMLButtonElement>("btn-clear-recent");
const btnBack = $<HTMLButtonElement>("btn-back");
const btnPlay = $<HTMLButtonElement>("btn-play");
const btnRewind = $<HTMLButtonElement>("btn-rewind");
const btnForward = $<HTMLButtonElement>("btn-forward");
const btnMute = $<HTMLButtonElement>("btn-mute");
const btnRate = $<HTMLButtonElement>("btn-rate");
const btnFs = $<HTMLButtonElement>("btn-fs");
const btnKeys = $<HTMLButtonElement>("btn-keys");
const seek = $<HTMLInputElement>("seek");
const volume = $<HTMLInputElement>("volume");
const progress = $<HTMLDivElement>("progress");
const buffered = $<HTMLDivElement>("buffered");
const timeLabel = $<HTMLElement>("time");
const titleLabel = $<HTMLSpanElement>("title-label");
const subtitleLabel = $<HTMLSpanElement>("subtitle-label");

// Keyboard shortcuts overlay (frame 05)
const shortcutsOverlay = $<HTMLDivElement>("shortcuts-overlay");
const btnKeysClose = $<HTMLButtonElement>("btn-keys-close");

// Timestamps (play-002)
const markersLayer = $<HTMLDivElement>("markers");
const btnTimestamps = $<HTMLButtonElement>("btn-timestamps");
const btnTimestampsClose = $<HTMLButtonElement>("btn-timestamps-close");
const tsPanel = $<HTMLElement>("timestamps-panel");
const btnAddTimestamp = $<HTMLButtonElement>("btn-add-timestamp");
const tsAddInput = $<HTMLInputElement>("timestamp-input");
const tsAddHint = $<HTMLParagraphElement>("timestamp-hint");
const tsList = $<HTMLUListElement>("timestamps-list");
const tsCount = $<HTMLSpanElement>("timestamps-count");
const btnClearTimestamps = $<HTMLButtonElement>("btn-clear-timestamps");
const markerFlash = $<HTMLDivElement>("marker-flash");
const markerFlashText = $<HTMLSpanElement>("marker-flash-text");
const nowChapter = $<HTMLDivElement>("now-chapter");
const nowChapterTime = $<HTMLSpanElement>("now-chapter-time");
const nowChapterLabel = $<HTMLSpanElement>("now-chapter-label");
const pinChapterToggle = $<HTMLInputElement>("pin-chapter-toggle");

// Timeline / cut view (play-004)
const btnCut = $<HTMLButtonElement>("btn-cut");
const cutSection = $<HTMLElement>("cut");
const cutBack = $<HTMLButtonElement>("cut-back");
const cutExit = $<HTMLButtonElement>("cut-exit");
const cutKeys = $<HTMLButtonElement>("cut-keys");
const cutFs = $<HTMLButtonElement>("cut-fs");
const cutTitle = $<HTMLSpanElement>("cut-title");
const cutMeta = $<HTMLSpanElement>("cut-meta");
const cutTimeline = $<HTMLDivElement>("cut-timeline");
const cutRuler = $<HTMLDivElement>("cut-ruler");
const cutFilmstrip = $<HTMLCanvasElement>("cut-filmstrip");
const cutWaveform = $<HTMLCanvasElement>("cut-waveform");
const cutFuture = $<HTMLDivElement>("cut-future");
const cutPlayhead = $<HTMLDivElement>("cut-playhead");
const cutTcCur = $<HTMLSpanElement>("cut-tc-cur");
const cutTcTot = $<HTMLSpanElement>("cut-tc-tot");
const cutTcFps = $<HTMLSpanElement>("cut-tc-fps");
const cutShuttleState = $<HTMLSpanElement>("cut-shuttle");
const cutJumpStartBtn = $<HTMLButtonElement>("cut-jumpstart");
const cutReverseBtn = $<HTMLButtonElement>("cut-reverse");
const cutPlayBtn = $<HTMLButtonElement>("cut-play");
const cutForwardBtn = $<HTMLButtonElement>("cut-forward");
const cutJumpEndBtn = $<HTMLButtonElement>("cut-jumpend");
const cutLoopBtn = $<HTMLButtonElement>("cut-loop");
const cutRateBtn = $<HTMLButtonElement>("cut-rate");
const cutMuteBtn = $<HTMLButtonElement>("cut-mute");
const cutVolume = $<HTMLInputElement>("cut-volume");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state: PlayerState = createInitialState();
let isScrubbing = false;

// Parsed timestamps + the DOM nodes rendered for them (index-aligned), so the
// active-chapter highlight can be updated cheaply on every timeupdate.
let timestamps: Timestamp[] = [];
let markerEls: HTMLElement[] = [];
let listEls: HTMLElement[] = [];
let activeTsIndex = -1;

// Timeline / cut view (play-004) ----------------------------------------
let cutMode = false;
/** Clip frame rate, measured from playback (requestVideoFrameCallback) or default. */
let detectedFps = DEFAULT_FPS;
/** J/K/L shuttle transport state (pure model in player-core). */
let shuttle: Shuttle = createShuttle();
let shuttleRAF: number | undefined;
let shuttleLast = 0;
let loopOn = false;
/** Cached audio peaks for the waveform (0..1), redrawn on enter/resize. */
let waveformPeaks: number[] = [];
/** Captured filmstrip thumbnails (160×90 offscreen canvases), composited on draw. */
let filmFrames: (HTMLCanvasElement | null)[] = [];
/** Bump to cancel a stale async filmstrip/waveform build when the file changes. */
let filmstripToken = 0;
let waveformToken = 0;
let cutScrubbing = false;

/** Pull the canonical values from the media element into our state object. */
function syncFromVideo(): void {
  state = {
    ...state,
    isPlaying: !video.paused && !video.ended,
    currentTime: video.currentTime || 0,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    volume: video.volume,
    muted: video.muted,
    // `rate` is the user's chosen speed (the rate chip) and is the single source
    // of truth — NOT read back from the element, because the play-004 J/K/L
    // shuttle temporarily drives video.playbackRate to its own speed ladder.
    rate: state.rate,
  };
}

/** Apply audible volume + rate from state onto the element. */
function applyAudioToVideo(): void {
  video.volume = state.volume;
  video.muted = state.muted;
  video.playbackRate = state.rate;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render(): void {
  // Play / pause icon state (CSS swaps the glyph for the data attribute).
  btnPlay.dataset.playing = String(state.isPlaying);
  centerToggle.dataset.playing = String(state.isPlaying);

  // Time + scrubber against a fixed duration.
  if (!isScrubbing) {
    seek.value = String(timeToSlider(state.currentTime, state.duration, 1000));
  }
  progress.style.width = `${progressFraction(state) * 100}%`;
  timeLabel.innerHTML = `<span class="t-cur">${formatTime(state.currentTime)}</span><span class="t-sep">/</span><span class="t-tot">${formatTime(state.duration)}</span>`;

  // Buffered indicator
  if (video.buffered.length > 0 && state.duration > 0) {
    const end = video.buffered.end(video.buffered.length - 1);
    buffered.style.width = `${bufferedFraction(end, state.duration) * 100}%`;
  }

  // Volume + mute
  const audible = effectiveVolume(state);
  volume.value = String(Math.round(audible * 100));
  btnMute.dataset.muted = String(audible === 0);

  // Rate
  btnRate.textContent = `${state.rate}×`;

  // Active-chapter highlight (cheap; rebuilds nothing).
  updateActiveTimestamp();

  // Timeline / cut view mirrors the same state (play-004).
  if (cutMode) renderCut();
}

// ---------------------------------------------------------------------------
// Command helpers — each mutates state via player-core, then drives the element
// ---------------------------------------------------------------------------
function doTogglePlay(): void {
  syncFromVideo();
  state = togglePlay(state);
  if (state.isPlaying) {
    void video.play().catch(() => {});
  } else {
    video.pause();
  }
  flashCenter();
  render();
  // Surface the controls on every play/pause; they auto-hide again only while playing.
  showControls();
}

function doSkip(forward: boolean): void {
  syncFromVideo();
  state = forward ? fastForward(state) : rewind(state);
  video.currentTime = state.currentTime;
  render();
  showControls();
}

function doSeekTo(seconds: number): void {
  syncFromVideo();
  state = seekTo(state, seconds);
  video.currentTime = state.currentTime;
  render();
}

/**
 * Jump to a tenth of the video with the 0-9 number keys (play-009): digit n
 * seeks to n/10 of the duration, routed through doSeekTo (which clamps to
 * [0, duration]). The split is a seek convention only; nothing is drawn on the
 * timeline.
 */
function doSectionSeek(digit: number): void {
  syncFromVideo();
  doSeekTo(sectionSeekTime(digit, state.duration));
  showControls();
}

function doToggleMute(): void {
  syncFromVideo();
  state = toggleMute(state);
  applyAudioToVideo();
  render();
}

function doSetVolume(value0to100: number): void {
  syncFromVideo();
  state = setVolume(state, value0to100 / 100);
  applyAudioToVideo();
  render();
}

function doCycleRate(): void {
  syncFromVideo();
  state = { ...state, rate: nextRate(state.rate) };
  applyAudioToVideo();
  render();
}

/** Hotkeys +/−: step the playback speed up or down (clamped, no wrap). */
function doStepRate(direction: number): void {
  syncFromVideo();
  state = { ...state, rate: stepRate(state.rate, direction) };
  applyAudioToVideo();
  render();
  showControls();
}

/**
 * Drive the native window's fullscreen, NOT the HTML Fullscreen API. The WebView
 * exits HTML fullscreen on Esc itself, and that can't be canceled from JS — so a
 * single Esc would both close an open overlay (our handler) and drop out of
 * fullscreen (the browser). Window-level fullscreen takes the whole webview
 * fullscreen (overlays outside #stage stay visible, same as before) and leaves
 * Esc entirely under our control. Requires `core:window:allow-set-fullscreen`.
 */
async function setFullscreen(on: boolean): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(on);
  } catch {
    /* fullscreen may be unavailable; ignore */
  }
}

async function doToggleFullscreen(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
  } catch {
    /* fullscreen may be unavailable; ignore */
  }
}

// ---------------------------------------------------------------------------
// Controls auto-hide + center flash
// ---------------------------------------------------------------------------
let hideTimer: number | undefined;
let flashTimer: number | undefined;

/**
 * Single source of truth for chrome visibility. `data-chrome` on the stage lets
 * elements that live outside #controls (e.g. the pinned chapter pill) track the
 * controls' show/hide without being subject to the controls' own fade.
 */
function setChromeVisible(visible: boolean): void {
  controls.dataset.visible = String(visible);
  stage.dataset.chrome = visible ? "shown" : "hidden";
}

function showControls(): void {
  setChromeVisible(true);
  stage.dataset.idle = "false";
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (state.isPlaying) {
      setChromeVisible(false);
      stage.dataset.idle = "true";
    }
  }, 2600);
}

function flashCenter(): void {
  centerToggle.dataset.flash = "true";
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    centerToggle.dataset.flash = "false";
  }, 360);
}

// ---------------------------------------------------------------------------
// Timestamps (play-002)
// ---------------------------------------------------------------------------
let markerFlashTimer: number | undefined;

/**
 * Parse `text` (one timestamp per line) and merge the valid entries into the
 * collection, then re-render. Returns how many new timestamps were added.
 */
function addTimestampsFromText(text: string): number {
  const additions = parseTimestamps(text);
  if (additions.length === 0) return 0;
  const before = timestamps.length;
  timestamps = mergeTimestamps(timestamps, additions);
  renderTimestamps();
  persistTimestamps();
  return timestamps.length - before;
}

/** Remove the timestamp at `index` and re-render. */
function removeTimestamp(index: number): void {
  timestamps = timestamps.filter((_, i) => i !== index);
  renderTimestamps();
  persistTimestamps();
}

/**
 * Remove every timestamp at once (the bulk counterpart to per-row removal),
 * re-render, and persist — which empties the saved set for the current video
 * (writeStoredTimestamps drops the key on an empty list) so they don't reappear
 * on the next open. A no-op when there's nothing to clear.
 */
function clearAllTimestamps(): void {
  if (timestamps.length === 0) return;
  timestamps = clearTimestamps();
  renderTimestamps();
  persistTimestamps();
}

// --- Per-video persistence (play-007) ---
// Saved timestamps survive close+reopen and app restarts, scoped per video by a
// stable key. The whole store lives under one localStorage key; pure (de)serialize
// + read/write helpers live in player-core so they're unit-tested without a DOM.
const TIMESTAMPS_KEY = "playback:timestamps";

/** Identity of the video currently loaded; null on the home screen. */
let currentTimestampKey: string | null = null;

function loadTimestampStore(): TimestampStore {
  return parseTimestampStore(localStorage.getItem(TIMESTAMPS_KEY));
}

function saveTimestampStore(store: TimestampStore): void {
  try {
    localStorage.setItem(TIMESTAMPS_KEY, serializeTimestampStore(store));
  } catch {
    /* storage unavailable / quota — saved timestamps are best-effort */
  }
}

/**
 * Replace the in-memory timestamps with the saved set for `source` (a file path
 * or URL), then re-render. Called on every open so timestamps are scoped per
 * video. A no-op when the key is unchanged (e.g. a live auto-upgrade re-opens the
 * same path) so it never wipes the session's in-memory edits.
 */
function loadTimestampsFor(source: string | null): void {
  const key = source ? timestampKey(source) : null;
  if (key === currentTimestampKey) return;
  currentTimestampKey = key;
  timestamps = key ? readStoredTimestamps(loadTimestampStore(), key) : [];
  renderTimestamps();
}

/** Persist the current in-memory timestamps under the current video's key. */
function persistTimestamps(): void {
  if (currentTimestampKey === null) return;
  saveTimestampStore(writeStoredTimestamps(loadTimestampStore(), currentTimestampKey, timestamps));
}

/** Reveal the single-line add input (focused, empty) for a new entry. */
function openAddInput(): void {
  tsAddInput.value = "";
  tsAddInput.hidden = false;
  tsAddHint.hidden = false;
  tsAddInput.focus();
}

/** Hide and clear the add input. */
function closeAddInput(): void {
  tsAddInput.value = "";
  tsAddInput.hidden = true;
  tsAddHint.hidden = true;
}

/** Rebuild the scrubber markers and the panel list from `timestamps`. */
function renderTimestamps(): void {
  markersLayer.replaceChildren();
  tsList.replaceChildren();
  markerEls = [];
  listEls = [];
  activeTsIndex = -1;

  tsCount.textContent =
    timestamps.length === 0 ? "No timestamps yet." : String(timestamps.length);
  // "Clear all" is only meaningful when there's something to clear (mirror the
  // home screen's recents Clear button, which hides on the empty state).
  btnClearTimestamps.hidden = timestamps.length === 0;

  timestamps.forEach((ts, index) => {
    // Scrubber marker (a clickable tick on top of the bar).
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "marker";
    marker.style.left = `${markerFraction(ts.time, state.duration) * 100}%`;
    marker.title = `${formatTime(ts.time)} — ${ts.title}`;
    const label = document.createElement("span");
    label.className = "marker__label";
    label.textContent = `${formatTime(ts.time)}  ${ts.title}`;
    marker.appendChild(label);
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      jumpToTimestamp(ts);
    });
    markersLayer.appendChild(marker);
    markerEls.push(marker);

    // Panel list row: a jump target plus a remove button.
    const item = document.createElement("li");
    item.className = "ts-list__item";
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "ts-list__jump";
    const time = document.createElement("span");
    time.className = "ts-list__time";
    time.textContent = formatTime(ts.time);
    const title = document.createElement("span");
    title.className = "ts-list__title";
    title.textContent = ts.title;
    jump.append(time, title);
    jump.addEventListener("click", () => jumpToTimestamp(ts));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ts-list__remove";
    remove.title = "Remove timestamp";
    remove.setAttribute("aria-label", `Remove ${ts.title}`);
    remove.innerHTML =
      '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>';
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removeTimestamp(index);
    });
    item.append(jump, remove);
    tsList.appendChild(item);
    listEls.push(item);
  });

  updateActiveTimestamp();
}

/** Toggle the `data-active` flag on the marker + row for the current chapter. */
function updateActiveTimestamp(): void {
  const idx = timestamps.length === 0 ? -1 : activeTimestampIndex(timestamps, state.currentTime);
  // Keep the chrome's "now playing chapter" label in sync (cheap; only writes on
  // change), even when the highlight short-circuits below or all are removed.
  updateNowChapter(idx);
  if (idx === activeTsIndex) return;
  if (activeTsIndex >= 0) {
    markerEls[activeTsIndex]?.removeAttribute("data-active");
    listEls[activeTsIndex]?.removeAttribute("data-active");
  }
  if (idx >= 0) {
    markerEls[idx]?.setAttribute("data-active", "true");
    listEls[idx]?.setAttribute("data-active", "true");
  }
  activeTsIndex = idx;
}

// Persisted setting: pin the current-chapter pill to the bottom-left corner so
// it stays visible even when the rest of the chrome auto-hides.
const PIN_CHAPTER_KEY = "playback:pinChapter";

/** Apply the pin-chapter setting to the pill + toggle, and persist it. */
function setPinChapter(on: boolean): void {
  nowChapter.dataset.pinned = String(on);
  pinChapterToggle.checked = on;
  try {
    localStorage.setItem(PIN_CHAPTER_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable (e.g. private mode) — setting just won't persist */
  }
}

/** Restore the saved pin-chapter setting on startup. */
function loadPinChapter(): void {
  let saved = false;
  try {
    saved = localStorage.getItem(PIN_CHAPTER_KEY) === "1";
  } catch {
    /* ignore */
  }
  setPinChapter(saved);
}

/** Show the active chapter's time + title in the control chrome, or hide it. */
function updateNowChapter(idx: number): void {
  if (idx < 0) {
    if (!nowChapter.hidden) nowChapter.hidden = true;
    return;
  }
  const ts = timestamps[idx];
  if (nowChapter.hidden || nowChapterLabel.textContent !== ts.title) {
    nowChapterTime.textContent = formatTime(ts.time);
    nowChapterLabel.textContent = ts.title;
    nowChapter.hidden = false;
  }
}

/** Seek to a timestamp and surface its title briefly. */
function jumpToTimestamp(ts: Timestamp): void {
  doSeekTo(ts.time);
  flashMarker(ts.title);
  showControls();
}

/** Show the "jumped to chapter" toast for a moment. */
function flashMarker(title: string): void {
  markerFlashText.textContent = title;
  markerFlash.dataset.flash = "true";
  window.clearTimeout(markerFlashTimer);
  markerFlashTimer = window.setTimeout(() => {
    markerFlash.dataset.flash = "false";
  }, 1100);
}

/** Hotkey A: jump to the closest previous timestamp. */
function doPrevTimestamp(): void {
  if (stage.hidden || timestamps.length === 0) return;
  syncFromVideo();
  const target = previousTimestamp(timestamps, state.currentTime);
  if (target) jumpToTimestamp(target);
}

/** Hotkey D: jump to the closest upcoming timestamp. */
function doNextTimestamp(): void {
  if (stage.hidden || timestamps.length === 0) return;
  syncFromVideo();
  const target = nextTimestamp(timestamps, state.currentTime);
  if (target) jumpToTimestamp(target);
}

function setPanelOpen(open: boolean): void {
  tsPanel.dataset.open = String(open);
  tsPanel.setAttribute("aria-hidden", String(!open));
  btnTimestamps.setAttribute("aria-pressed", String(open));
  if (open) {
    // Keep the scrubber + markers on screen alongside the panel. We deliberately
    // do NOT focus a text field here, so `T` / `A` / `D` keep working.
    showControls();
  } else {
    closeAddInput();
  }
}

function togglePanel(): void {
  setPanelOpen(tsPanel.dataset.open !== "true");
}

/** Back button: tear down the current video and return to the home screen. */
function goHome(): void {
  video.pause();
  setCutMode(false);
  clearCutDeck();
  resetShuttle();
  setLoop(false);
  setPanelOpen(false);
  setShortcutsOpen(false);
  liveNotice.hidden = true;
  video.removeAttribute("src");
  video.load();
  state = createInitialState();
  loadTimestampsFor(null); // clear this video's chapters when returning home
  currentPath = null;
  app.dataset.state = "empty";
  stage.hidden = true;
  emptyState.hidden = false;
  emptyError.hidden = true;
  renderRecents();
  document.title = "Playback";
}

// --- Keyboard shortcuts overlay (frame 05) ---
function setShortcutsOpen(open: boolean): void {
  shortcutsOverlay.dataset.open = String(open);
  shortcutsOverlay.setAttribute("aria-hidden", String(!open));
}

function toggleShortcuts(): void {
  setShortcutsOpen(shortcutsOverlay.dataset.open !== "true");
}

// ---------------------------------------------------------------------------
// Livestream detection (play-003 / play-005)
//
// Livestream PLAYBACK is temporarily deprecated. We still DETECT a livestream —
// a file still being written on disk (a `.live` marker or a file that visibly
// grows) — but we no longer tail it into a MediaSource. A detected livestream
// opens the player with no media loaded (see openEmptyLivePlayer); the detection
// below decides whether a file is live before the first frame would paint.
// ---------------------------------------------------------------------------

interface StreamStatus {
  size: number;
  live: boolean;
  complete: boolean;
  /** Milliseconds since the file was last written (see lib.rs). */
  mtime_age_ms: number;
}

// --- Up-front live detection (play-005 detect-before-play) -----------------
// A file last modified within this window is a live candidate worth probing for
// active growth; anything older is treated as a finished/static file and opened
// normally with no probe delay (so ordinary opens stay instant).
const LIVE_RECENT_MS = 15_000;
// How long to watch for growth when probing a recently-written file, and how many
// new bytes must arrive in that window to count as "still being written". The
// threshold only has to clear filesystem-metadata jitter — a real capture appends
// far more — so it stays comfortably below one tick of a slow writer.
const LIVE_GROWTH_SAMPLE_MS = 400;
const LIVE_GROWTH_THRESHOLD = 8 * 1024;

/** Bytes pulled per Rust read_stream_chunk call (used by the cut-view waveform). */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Decode a base64 chunk (the `read_stream_chunk` transport) into bytes. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Timeline / cut view (play-004)
//
// An editorial review surface layered over the player: the same <video> becomes
// a bordered viewer, and a bottom "Timeline Deck" shows a timecode ruler, a
// filmstrip of thumbnails, and an audio waveform with a scrub playhead. The
// transport reports a frame-accurate SMPTE timecode and adds J/K/L shuttle,
// jump-to-start/end, and a loop toggle. All decisions are pure (player-core);
// here we drive the DOM + the real <video> (whose playbackRate can't go
// negative, so reverse shuttle steps currentTime on a rAF loop).
// ---------------------------------------------------------------------------
const FILMSTRIP_CELLS = 12;
const WAVEFORM_BARS = 240;
const WAVEFORM_MAX_BYTES = 48 * 1024 * 1024; // decode real audio only below this

/** Enter/leave the timeline view. No-op to enter when no video is loaded. */
function setCutMode(on: boolean): void {
  if (on && stage.hidden) return;
  cutMode = on;
  app.dataset.mode = on ? "cut" : "player";
  cutSection.hidden = !on;
  btnCut.setAttribute("aria-pressed", String(on));
  if (on) {
    setPanelOpen(false);
    setShortcutsOpen(false);
    // Build the filmstrip + waveform on first open (deferred from load).
    ensureCutDeckBuilt();
    // The canvases only have a size once visible — draw them now.
    drawFilmstrip();
    drawWaveform();
    renderCut();
    showControls();
  } else {
    resetShuttle();
    showControls();
  }
}

function toggleCutMode(): void {
  setCutMode(!cutMode);
}

/** Path of the clip whose deck is (to be) built, and whether it is built yet. */
let cutDeckPath: string | null = null;
let cutDeckBuilt = false;

/**
 * Note the clip for the deck. The filmstrip + waveform builds are deferred to the
 * first time the timeline view is opened (ensureCutDeckBuilt): the filmstrip
 * captures frames from the main video, so deferring lets the main video settle
 * (loaded + composited) before we seek it around to grab thumbnails.
 */
function prepareCutDeck(path: string): void {
  cutDeckPath = path;
  cutDeckBuilt = false;
  cutTitle.textContent = basename(path);
  cutMeta.textContent = "";
  resetFpsDetection();
  // The ruler is cheap (DOM ticks) and built from the loadedmetadata handler.
  if (cutMode) ensureCutDeckBuilt();
}

/** Build the filmstrip + waveform once, on demand (first cut-view open). */
function ensureCutDeckBuilt(): void {
  if (cutDeckBuilt || !cutDeckPath) return;
  cutDeckBuilt = true;
  void buildCutMedia(cutDeckPath);
}

/**
 * Build the deck media: the filmstrip (captured from the main video) and the
 * waveform (the real audio, decoded from the file bytes; synthesized as a
 * fallback for large/unreadable files so the deck always shows bars).
 */
async function buildCutMedia(path: string): Promise<void> {
  buildFilmstripFromMain();
  const token = ++waveformToken;
  try {
    const status = await tauriInvoke<StreamStatus>("stream_status", { path }).catch(() => null);
    const size = status ? status.size : 0;
    if (size > 0 && size <= WAVEFORM_MAX_BYTES) {
      const bytes = await readWholeFile(path, size);
      if (token !== waveformToken) return;
      await decodeWaveform(bytes, token);
      return;
    }
  } catch {
    /* fall through to the synthesized waveform */
  }
  if (token !== waveformToken) return;
  waveformPeaks = synthPeaks(path, WAVEFORM_BARS);
  drawWaveform();
}

/** Clear the deck when returning home / before a new clip. */
function clearCutDeck(): void {
  filmstripToken++;
  waveformToken++;
  waveformPeaks = [];
  filmFrames = [];
  cutDeckPath = null;
  cutDeckBuilt = false;
  cutRuler.replaceChildren();
  const fctx = cutFilmstrip.getContext("2d");
  if (fctx) fctx.clearRect(0, 0, cutFilmstrip.width, cutFilmstrip.height);
  const wctx = cutWaveform.getContext("2d");
  if (wctx) wctx.clearRect(0, 0, cutWaveform.width, cutWaveform.height);
  cutTitle.textContent = "";
  cutMeta.textContent = "";
}

/** Footage meta line: resolution · fps (both read from the real clip). */
function updateCutMeta(): void {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const parts: string[] = [];
  if (w && h) parts.push(`${w}×${h}`);
  parts.push(formatFps(detectedFps));
  cutMeta.textContent = parts.join("  ·  ");
  cutTcFps.textContent = `· ${formatFps(detectedFps)}`;
}

// --- Frame-rate detection via requestVideoFrameCallback -------------------
interface FrameMeta {
  mediaTime: number;
  presentedFrames: number;
}
type RVFC = (cb: (now: number, meta: FrameMeta) => void) => number;
let fpsSamples: FrameMeta[] = [];

function resetFpsDetection(): void {
  detectedFps = DEFAULT_FPS;
  fpsSamples = [];
  updateCutMeta();
  startFpsDetection();
}

/**
 * Measure the clip fps from a few presented frames (mediaTime + presentedFrames
 * deltas), snapped onto a broadcast-standard rate. HTML5 video exposes no fps in
 * metadata, so this is the reliable read; it falls back to DEFAULT_FPS when the
 * API is unavailable or the clip never plays.
 */
function startFpsDetection(): void {
  const rvfc = (video as unknown as { requestVideoFrameCallback?: RVFC })
    .requestVideoFrameCallback;
  if (typeof rvfc !== "function") return;
  const onFrame = (_now: number, meta: FrameMeta): void => {
    fpsSamples.push({ mediaTime: meta.mediaTime, presentedFrames: meta.presentedFrames });
    const first = fpsSamples[0];
    const last = fpsSamples[fpsSamples.length - 1];
    const dt = last.mediaTime - first.mediaTime;
    const df = last.presentedFrames - first.presentedFrames;
    if (dt > 0.4 && df >= 8) {
      detectedFps = snapFps(df / dt);
      updateCutMeta();
      if (cutMode) renderCut();
      return; // measured — stop sampling
    }
    if (fpsSamples.length < 300) rvfc.call(video, onFrame);
  };
  rvfc.call(video, onFrame);
}

// --- Filmstrip ------------------------------------------------------------
/** Draw a source (video/canvas) covering the box [dx,dy,dw,dh] (center-crop). */
function drawCover(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  if (!sw || !sh) return;
  const scale = Math.max(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.drawImage(src, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
  ctx.restore();
}

/**
 * Composite the captured thumbnails onto the single filmstrip canvas, sized to
 * its client box (the same proven pattern as the waveform — per-element canvases
 * did not render in this WebView). Slots without a captured frame yet show a flat
 * placeholder. Frame dividers separate the slots.
 */
function drawFilmstrip(): void {
  const cv = cutFilmstrip;
  const rect = cv.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (w <= 1 || h <= 1) return; // not visible yet
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const slotW = w / FILMSTRIP_CELLS;
  for (let k = 0; k < FILMSTRIP_CELLS; k++) {
    const x = Math.round(k * slotW);
    const x2 = Math.round((k + 1) * slotW);
    const frame = filmFrames[k];
    if (frame) {
      drawCover(ctx, frame, frame.width, frame.height, x, 0, x2 - x, h);
    } else {
      ctx.fillStyle = "#141517";
      ctx.fillRect(x, 0, x2 - x, h);
    }
    // Frame divider.
    if (k > 0) {
      ctx.fillStyle = "rgba(7,8,10,0.6)";
      ctx.fillRect(x, 0, 1, h);
    }
  }
}

/**
 * Build the filmstrip — N evenly-spaced thumbnails spanning the clip — by seeking
 * the MAIN <video> through the capture points and grabbing each presented frame.
 *
 * Why the main element and not an auxiliary one: WebView2/Chromium only reliably
 * PAINTS (and thus lets drawImage read a real frame from) the visibly-composited
 * video; a detached / off-screen / occluded generator <video> gets culled and
 * drawImage captures black (confirmed: it ran with a valid 1280px source yet
 * produced black). So we briefly scrub the on-screen viewer to grab frames into
 * offscreen 160×90 canvases, then restore the playhead + play state. Each frame
 * is grabbed on the next requestVideoFrameCallback (after the frame is actually
 * presented), not on 'seeked' (which only signals the seek data is ready).
 */
function buildFilmstripFromMain(): void {
  const token = ++filmstripToken;
  filmFrames = new Array(FILMSTRIP_CELLS).fill(null);
  drawFilmstrip();
  const dur = video.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;

  const rvfc = (video as unknown as { requestVideoFrameCallback?: (cb: () => void) => number })
    .requestVideoFrameCallback;
  const wasPaused = video.paused;
  const savedTime = video.currentTime;
  video.pause();

  let k = 0;
  let pending = false;
  let safety: number | undefined;
  const restore = (): void => {
    if (token !== filmstripToken) return; // a newer build now owns the viewer
    video.currentTime = savedTime;
    if (!wasPaused) void video.play().catch(() => {});
    render();
  };
  const grabAndNext = (): void => {
    if (!pending) return;
    pending = false;
    window.clearTimeout(safety);
    video.removeEventListener("seeked", onSeeked);
    if (token !== filmstripToken) return; // aborted by a newer build / home
    if (video.videoWidth > 0) {
      const off = document.createElement("canvas");
      off.width = 160;
      off.height = 90;
      const octx = off.getContext("2d");
      if (octx) {
        drawCover(octx, video, video.videoWidth, video.videoHeight, 0, 0, 160, 90);
        filmFrames[k] = off;
        drawFilmstrip();
      }
    }
    k++;
    if (k < FILMSTRIP_CELLS) seekNext();
    else restore();
  };
  const onSeeked = (): void => {
    // Grab on the next presented frame so drawImage reads a painted (non-black)
    // frame rather than just seek-ready data.
    if (typeof rvfc === "function") rvfc.call(video, grabAndNext);
    else grabAndNext();
  };
  function seekNext(): void {
    if (token !== filmstripToken) return;
    pending = true;
    video.addEventListener("seeked", onSeeked, { once: true });
    window.clearTimeout(safety);
    safety = window.setTimeout(grabAndNext, 1500); // don't hang if a frame never lands
    video.currentTime = ((k + 0.5) / FILMSTRIP_CELLS) * dur;
  }
  seekNext();
}

// --- Waveform -------------------------------------------------------------
/** Read the whole file as bytes (base64 chunks over the Rust command). */
async function readWholeFile(path: string, size: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let off = 0;
  while (off < size) {
    const b64 = await tauriInvoke<string>("read_stream_chunk", {
      path,
      offset: off,
      maxLen: Math.min(READ_CHUNK_BYTES, size - off),
    });
    const bytes = b64ToBytes(b64);
    if (bytes.length === 0) break;
    parts.push(bytes);
    off += bytes.length;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Peak-amplitude downsample of an AudioBuffer into `bars` normalized values. */
function downsamplePeaks(buf: AudioBuffer, bars: number): number[] {
  const ch = buf.getChannelData(0);
  const n = ch.length;
  const per = Math.max(1, Math.floor(n / bars));
  const peaks: number[] = [];
  let max = 1e-4;
  for (let i = 0; i < bars; i++) {
    const start = i * per;
    const end = Math.min(n, start + per);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const a = Math.abs(ch[j]);
      if (a > peak) peak = a;
    }
    peaks.push(peak);
    if (peak > max) max = peak;
  }
  return peaks.map((p) => p / max);
}

/** Deterministic fallback waveform (from the path) when audio can't be decoded. */
function synthPeaks(seed: string, bars: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = (h ^ seed.charCodeAt(i)) * 16777619;
  h >>>= 0;
  const peaks: number[] = [];
  for (let i = 0; i < bars; i++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const r = h / 0xffffffff;
    const env = 0.4 + 0.45 * Math.abs(Math.sin((i / bars) * Math.PI * 3 + 1));
    peaks.push(Math.min(1, (0.3 + r * 0.7) * env));
  }
  return peaks;
}

/**
 * Decode the real audio track from already-read bytes into waveform peaks. If
 * there's no audio / the decode fails, fall back to a deterministic synthesized
 * waveform so the deck always shows bars. `token` guards against a stale build.
 */
async function decodeWaveform(bytes: Uint8Array, token: number): Promise<void> {
  let peaks: number[] | null = null;
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioCtx = new Ctx();
    try {
      const decoded = await audioCtx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
      if (token === waveformToken) peaks = downsamplePeaks(decoded, WAVEFORM_BARS);
    } finally {
      void audioCtx.close();
    }
  } catch {
    peaks = null;
  }
  if (token !== waveformToken) return;
  if (!peaks || peaks.every((p) => p === 0)) peaks = synthPeaks(cutDeckPath ?? "", WAVEFORM_BARS);
  waveformPeaks = peaks;
  drawWaveform();
}

/** Paint the cached waveform peaks onto the (display-sized) canvas. */
function drawWaveform(): void {
  const cv = cutWaveform;
  const rect = cv.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (w <= 1 || h <= 1) return; // not visible yet
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const peaks = waveformPeaks;
  if (peaks.length === 0) return;
  const mid = h / 2;
  const barW = w / peaks.length;
  ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
  for (let i = 0; i < peaks.length; i++) {
    const bh = Math.max(1, peaks[i] * (h - 4));
    ctx.fillRect(i * barW, mid - bh / 2, Math.max(1, barW - 1), bh);
  }
}

// --- Ruler ----------------------------------------------------------------
/** Lay out the timecode ruler (minor ticks + labelled major ticks). */
function buildRuler(duration: number): void {
  cutRuler.replaceChildren();
  if (!Number.isFinite(duration) || duration <= 0) return;
  for (const tick of rulerTicks(duration, 8)) {
    const left = `${markerFraction(tick.time, duration) * 100}%`;
    const el = document.createElement("div");
    el.className = `cut__tick ${tick.major ? "cut__tick--major" : "cut__tick--minor"}`;
    el.style.left = left;
    cutRuler.appendChild(el);
    if (tick.major) {
      const label = document.createElement("span");
      label.className = "cut__tick-label";
      label.style.left = left;
      label.textContent = formatTime(tick.time);
      cutRuler.appendChild(label);
    }
  }
}

// --- Render the deck against the current state ----------------------------
function renderCut(): void {
  const dur = state.duration;
  const cur = state.currentTime;
  cutTcCur.textContent = formatSmpte(cur, detectedFps);
  cutTcTot.textContent = formatSmpte(dur, detectedFps);
  const frac = dur > 0 ? clamp(cur / dur, 0, 1) : 0;
  cutPlayhead.style.left = `${frac * 100}%`;
  cutFuture.style.left = `${frac * 100}%`;

  cutPlayBtn.dataset.playing = String(state.isPlaying);
  cutRateBtn.textContent = `${state.rate}×`;
  const audible = effectiveVolume(state);
  cutVolume.value = String(Math.round(audible * 100));
  cutMuteBtn.dataset.muted = String(audible === 0);
  cutLoopBtn.setAttribute("aria-pressed", String(loopOn));

  // Shuttle status: light up the active direction, show the rate badge past 1×.
  const rate = shuttleRate(shuttle);
  cutReverseBtn.setAttribute("aria-pressed", String(shuttle.direction === -1));
  cutForwardBtn.setAttribute("aria-pressed", String(shuttle.direction === 1));
  if (rate === 0 || rate === 1) {
    cutShuttleState.hidden = true;
  } else {
    cutShuttleState.hidden = false;
    cutShuttleState.textContent = `${rate < 0 ? "◀" : "▶"} ${Math.abs(rate)}×`;
  }
}

// --- Shuttle transport (J/K/L) --------------------------------------------
function stopShuttleLoop(): void {
  if (shuttleRAF !== undefined) {
    cancelAnimationFrame(shuttleRAF);
    shuttleRAF = undefined;
  }
}

/** Return the shuttle to stop and restore the user's playback speed. */
function resetShuttle(): void {
  shuttle = createShuttle();
  stopShuttleLoop();
  video.playbackRate = state.rate;
}

/** One reverse-shuttle tick: HTML5 can't play backwards, so step currentTime. */
function reverseStep(now: number): void {
  const rate = shuttleRate(shuttle);
  if (rate >= 0) {
    stopShuttleLoop();
    return;
  }
  const dt = Math.min(0.25, (now - shuttleLast) / 1000); // cap a long frame gap
  shuttleLast = now;
  const next = video.currentTime + rate * dt; // rate is negative
  if (next <= 0) {
    video.currentTime = 0;
    shuttle = shuttleStop();
    video.playbackRate = state.rate;
    syncFromVideo();
    render();
    return;
  }
  video.currentTime = next;
  syncFromVideo();
  render();
  shuttleRAF = requestAnimationFrame(reverseStep);
}

/** Apply the current shuttle state to the real <video>. */
function applyShuttle(): void {
  stopShuttleLoop();
  const rate = shuttleRate(shuttle);
  if (rate === 0) {
    video.playbackRate = state.rate;
    video.pause();
  } else if (rate > 0) {
    video.playbackRate = Math.min(rate, 16); // Chromium caps playbackRate at 16
    void video.play().catch(() => {});
  } else {
    video.playbackRate = state.rate;
    video.pause();
    shuttleLast = performance.now();
    shuttleRAF = requestAnimationFrame(reverseStep);
  }
  syncFromVideo();
  render();
  showControls();
}

/** L — play forward / step the forward speed up. */
function doShuttleForward(): void {
  shuttle = shuttleForward(shuttle);
  applyShuttle();
}

/** J — play in reverse / step the reverse speed up. */
function doShuttleReverse(): void {
  shuttle = shuttleReverse(shuttle);
  applyShuttle();
}

/** K — stop the shuttle (and pause). */
function doShuttleStop(): void {
  shuttle = shuttleStop();
  applyShuttle();
}

/** The big center transport button: plain play/pause at the user's speed. */
function cutPlayPause(): void {
  resetShuttle();
  syncFromVideo();
  if (video.paused || video.ended) void video.play().catch(() => {});
  else video.pause();
  syncFromVideo();
  render();
  showControls();
}

/** Move the playhead to the first / last frame (Home / End, or the buttons). */
function doJumpStart(): void {
  resetShuttle();
  doSeekTo(0);
  if (cutMode) renderCut();
  showControls();
}

function doJumpEnd(): void {
  resetShuttle();
  syncFromVideo();
  doSeekTo(lastFrameTime(state.duration, detectedFps));
  if (cutMode) renderCut();
  showControls();
}

/** Loop toggle: repeat playback at the clip's end. */
function setLoop(on: boolean): void {
  loopOn = on;
  video.loop = on;
  cutSection.dataset.loop = String(on);
  cutLoopBtn.setAttribute("aria-pressed", String(on));
}

function toggleLoop(): void {
  setLoop(!loopOn);
}

/** Scrub the timeline from a pointer position (shared by click + drag). */
function cutSeekFromPointer(e: PointerEvent): void {
  const rect = cutTimeline.getBoundingClientRect();
  if (rect.width <= 0) return;
  const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  doSeekTo(fractionToTime(frac, state.duration));
  renderCut();
}

// ---------------------------------------------------------------------------
// Loading a file
// ---------------------------------------------------------------------------
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The immediate parent folder name, shown as the player subtitle. */
function parentDir(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

function showError(message: string): void {
  emptyError.textContent = message;
  emptyError.hidden = false;
}

/** Load a media file by absolute filesystem path (via Tauri's asset protocol). */
// ---------------------------------------------------------------------------
// Recent files (home screen) — local file history, no account. Persisted in
// localStorage; rendered as cards on the home, click to re-open.
// ---------------------------------------------------------------------------
interface RecentFile {
  /** Identity of the source — a local file path. */
  path: string;
  name: string;
  openedAt: number;
  duration?: number;
}
const RECENTS_KEY = "playback:recents";
const RECENTS_MAX = 8;
/** Path of the file currently loaded (so we can backfill its duration). */
let currentPath: string | null = null;

function loadRecents(): RecentFile[] {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]") as RecentFile[];
    return Array.isArray(arr) ? arr.filter((r) => r && typeof r.path === "string") : [];
  } catch {
    return [];
  }
}

function saveRecents(list: RecentFile[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable / quota — recents are best-effort */
  }
}

function addRecent(path: string, name: string): void {
  const list = loadRecents().filter((r) => r.path !== path);
  list.unshift({ path, name, openedAt: Date.now() });
  if (list.length > RECENTS_MAX) list.length = RECENTS_MAX;
  saveRecents(list);
  renderRecents();
}

/** Re-open a recent local file. */
function openRecent(r: RecentFile): void {
  void loadFromPath(r.path);
}

function setRecentDuration(path: string, duration: number): void {
  if (!Number.isFinite(duration) || duration <= 0) return;
  const list = loadRecents();
  const item = list.find((r) => r.path === path);
  if (item && item.duration !== duration) {
    item.duration = duration;
    saveRecents(list);
    renderRecents();
  }
}

function clearRecents(): void {
  saveRecents([]);
  renderRecents();
}

/** "just now" / "5m ago" / "3h ago" / "yesterday" / "4 days ago" / "2 weeks ago". */
function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  const w = Math.floor(d / 7);
  return w === 1 ? "last week" : `${w} weeks ago`;
}

/** A stable accent gradient derived from the filename (stands in for a thumbnail). */
function thumbGradient(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(135deg, hsl(${hue} 60% 42%), hsl(${(hue + 38) % 360} 55% 20%))`;
}

const RECENT_PLAY_SVG =
  '<svg class="ic ic--fill" viewBox="0 0 24 24"><polygon points="8 5 19 12 8 19 8 5" /></svg>';

function renderRecents(): void {
  const list = loadRecents();
  const has = list.length > 0;
  recentCards.replaceChildren();
  recentCards.hidden = !has;
  recentEmpty.hidden = has;
  btnClearRecent.hidden = !has;

  for (const r of list) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "recent-card";
    card.title = r.path;

    const thumb = document.createElement("span");
    thumb.className = "recent-card__thumb";
    thumb.style.background = thumbGradient(r.name);
    const play = document.createElement("span");
    play.className = "recent-card__play";
    play.innerHTML = RECENT_PLAY_SVG;
    thumb.appendChild(play);
    if (r.duration) {
      const dur = document.createElement("span");
      dur.className = "recent-card__dur";
      dur.textContent = formatTime(r.duration);
      thumb.appendChild(dur);
    }

    const meta = document.createElement("span");
    meta.className = "recent-card__meta";
    const nm = document.createElement("span");
    nm.className = "recent-card__name";
    nm.textContent = r.name;
    const sub = document.createElement("span");
    sub.className = "recent-card__sub";
    sub.textContent = `Opened ${timeAgo(r.openedAt)}`;
    meta.append(nm, sub);

    card.append(thumb, meta);
    card.addEventListener("click", () => openRecent(r));
    recentCards.appendChild(card);
  }
}

async function loadFromPath(path: string): Promise<void> {
  currentPath = path;
  loadTimestampsFor(path); // seed this video's saved timestamps before it loads
  addRecent(path, basename(path));
  try {
    const status = await tauriInvoke<StreamStatus>("stream_status", { path }).catch(() => null);
    // Decide live-vs-normal BEFORE the first frame paints. Livestream playback is
    // temporarily deprecated, so a recording in progress opens an empty player
    // instead of being tailed.
    const detected = status ? await detectLive(path, status) : "normal";
    if (detected === "live-marker" || detected === "live-grow") {
      openEmptyLivePlayer(path);
      return;
    }
    // Static/finished file: play normally.
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const src = convertFileSrc(path);
    loadSrc(src, basename(path), parentDir(path));
    // Note the clip for the timeline-view deck (play-004); the filmstrip + waveform
    // are built lazily on first cut-view open.
    prepareCutDeck(path);
  } catch (err) {
    showError(`Could not open the file: ${String(err)}`);
  }
}

/**
 * Probe whether `path` is a livestream, up front (before the first frame would
 * paint), so it routes to the empty player instead of trying to play.
 *
 *  - `live-marker` — a `<path>.live` marker says a writer is appending.
 *  - `live-grow`   — no marker, but the file is recently-written AND visibly grows
 *                    during a short sample.
 *  - `normal`      — everything else: a finished or static file.
 *
 * The growth sample only runs for a recently-modified file, so ordinary opens of
 * a static file stay instant.
 */
async function detectLive(
  path: string,
  status: StreamStatus,
): Promise<"live-marker" | "live-grow" | "normal"> {
  if (status.complete) return "normal";
  if (status.live) return "live-marker";
  // Only spend time probing a file that was just written — a file last touched
  // long ago is static, so open it normally without any added latency.
  if (status.mtime_age_ms > LIVE_RECENT_MS) return "normal";
  // Confirm the file is actually still being appended to (cheap double-stat).
  await delay(LIVE_GROWTH_SAMPLE_MS);
  const after = await tauriInvoke<StreamStatus>("stream_status", { path }).catch(() => null);
  if (!after || after.complete) return "normal";
  return after.size > status.size + LIVE_GROWTH_THRESHOLD ? "live-grow" : "normal";
}

/** Promise-based delay used by the up-front live probe. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Load a media file from an already-resolved URL (asset://). */
function loadSrc(src: string, title: string, subtitle = ""): void {
  emptyError.hidden = true;
  liveNotice.hidden = true;
  video.src = src;
  titleLabel.textContent = title;
  subtitleLabel.textContent = subtitle;
  document.title = `${title} — Playback`;
  app.dataset.state = "playing";
  emptyState.hidden = true;
  stage.hidden = false;
  state = createInitialState();
  applyAudioToVideo();
  // Reset the cut-view transport for the new clip (play-004).
  resetShuttle();
  setLoop(false);
  video.load();
  void video.play().catch(() => {
    /* autoplay may be blocked; user can press play */
  });
  showControls();
}

/**
 * Livestream playback is temporarily deprecated. A file detected as a livestream
 * (a `.live` marker or an actively-growing recording) still opens the player, but
 * we do NOT attempt to play it — the viewer is left on an empty player with a
 * short notice rather than a tailing MediaSource.
 */
function openEmptyLivePlayer(path: string): void {
  const title = basename(path);
  emptyError.hidden = true;
  video.removeAttribute("src");
  video.load();
  titleLabel.textContent = title;
  subtitleLabel.textContent = "Live recording";
  document.title = `${title} — Playback`;
  app.dataset.state = "playing";
  emptyState.hidden = true;
  stage.hidden = false;
  liveNotice.hidden = false;
  state = createInitialState();
  applyAudioToVideo();
  resetShuttle();
  setLoop(false);
  showControls();
  render();
}

/** Open the native file picker (Tauri) and load the chosen file. */
async function openFileDialog(): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (typeof selected === "string") {
      await loadFromPath(selected);
    }
  } catch (err) {
    showError(`Open dialog unavailable: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Tauri drag & drop
// ---------------------------------------------------------------------------
async function registerDragAndDrop(): Promise<void> {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const webview = getCurrentWebview();
    await webview.onDragDropEvent((event) => {
      const payload = event.payload as { type: string; paths?: string[] };
      if (payload.type === "over" || payload.type === "enter") {
        app.dataset.dragover = "true";
      } else if (payload.type === "drop") {
        app.dataset.dragover = "false";
        const paths = payload.paths ?? [];
        const videoPath = paths.find((p) =>
          VIDEO_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(`.${ext}`)),
        );
        if (videoPath) void loadFromPath(videoPath);
      } else {
        app.dataset.dragover = "false";
      }
    });
  } catch {
    /* Not running under Tauri (e.g. plain `vite` preview) — drag/drop disabled. */
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wireControls(): void {
  btnOpen.addEventListener("click", () => void openFileDialog());
  btnOpenTop.addEventListener("click", () => void openFileDialog());
  dropZone.addEventListener("click", () => void openFileDialog());
  btnClearRecent.addEventListener("click", clearRecents);

  btnPlay.addEventListener("click", doTogglePlay);
  btnRewind.addEventListener("click", () => doSkip(false));
  btnForward.addEventListener("click", () => doSkip(true));
  btnMute.addEventListener("click", doToggleMute);
  btnRate.addEventListener("click", doCycleRate);
  btnFs.addEventListener("click", () => void doToggleFullscreen());
  btnBack.addEventListener("click", goHome);

  // Keyboard shortcuts overlay (frame 05)
  btnKeys.addEventListener("click", toggleShortcuts);
  btnKeysClose.addEventListener("click", () => setShortcutsOpen(false));
  shortcutsOverlay.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).dataset.close) setShortcutsOpen(false);
  });

  // Timeline / cut view (play-004)
  btnCut.addEventListener("click", toggleCutMode);
  wireCut();

  // Timestamps panel (play-002)
  btnTimestamps.addEventListener("click", togglePanel);
  btnTimestampsClose.addEventListener("click", () => setPanelOpen(false));
  // "Clear all" (play-008): bulk-remove every chapter on the current video.
  btnClearTimestamps.addEventListener("click", clearAllTimestamps);

  // "Always show current chapter" setting: pin the pill to the bottom-left.
  // Blur after toggling so Space/hotkeys aren't swallowed by the focused input.
  pinChapterToggle.addEventListener("change", () => {
    setPinChapter(pinChapterToggle.checked);
    pinChapterToggle.blur();
  });

  // "Add timestamp" reveals a one-shot input that is only focused on demand, so
  // the panel's hotkeys aren't swallowed in its default state.
  btnAddTimestamp.addEventListener("click", openAddInput);
  tsAddInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // Commit a single typed line; stay open + cleared for the next entry.
      e.preventDefault();
      addTimestampsFromText(tsAddInput.value);
      tsAddInput.value = "";
    } else if (e.key === "Escape") {
      // Close just the input (the global handler closes the panel otherwise).
      e.stopPropagation();
      closeAddInput();
    }
  });
  tsAddInput.addEventListener("paste", (e) => {
    // Pasting (often multiple lines) commits every line and closes the input.
    e.preventDefault();
    const text = e.clipboardData?.getData("text") ?? "";
    addTimestampsFromText(text);
    closeAddInput();
  });
  // Leaving the field (clicking elsewhere) dismisses it so it can't trap hotkeys.
  tsAddInput.addEventListener("blur", closeAddInput);

  video.addEventListener("click", () => {
    if (cutMode) cutPlayPause();
    else doTogglePlay();
  });

  // Scrubber: live-preview while dragging, commit on release.
  const sliderSeconds = (): number => sliderToTime(Number(seek.value), 1000, state.duration);
  const previewSeek = () => {
    isScrubbing = true;
    const t = sliderSeconds();
    timeLabel.innerHTML = `${formatTime(t)}&nbsp;/&nbsp;${formatTime(state.duration)}`;
    progress.style.width = `${(Number(seek.value) / 1000) * 100}%`;
  };
  const commitSeek = () => {
    doSeekTo(sliderSeconds());
    isScrubbing = false;
  };
  seek.addEventListener("input", previewSeek);
  seek.addEventListener("change", commitSeek);

  volume.addEventListener("input", () => doSetVolume(Number(volume.value)));

  // Reflect the media element's own events back into our state + UI.
  video.addEventListener("loadedmetadata", () => {
    syncFromVideo();
    render();
    if (currentPath) setRecentDuration(currentPath, video.duration);
    // Duration is now known — reposition markers against the real timeline.
    renderTimestamps();
    // Cut view (play-004): build the ruler now the duration + dimensions exist.
    buildRuler(video.duration);
    updateCutMeta();
    if (cutMode) renderCut();
  });
  video.addEventListener("timeupdate", () => {
    syncFromVideo();
    render();
  });
  video.addEventListener("progress", render);
  video.addEventListener("play", () => {
    syncFromVideo();
    render();
  });
  video.addEventListener("pause", () => {
    syncFromVideo();
    render();
  });
  video.addEventListener("volumechange", () => {
    syncFromVideo();
    render();
  });
  video.addEventListener("ended", () => {
    syncFromVideo();
    render();
    showControls();
  });

  // Reveal controls on mouse activity over the stage.
  stage.addEventListener("mousemove", showControls);
  stage.addEventListener("mouseleave", () => {
    if (state.isPlaying) setChromeVisible(false);
  });
}

/** Wire the timeline / cut view controls (play-004). */
function wireCut(): void {
  cutBack.addEventListener("click", goHome);
  cutExit.addEventListener("click", () => setCutMode(false));
  cutKeys.addEventListener("click", toggleShortcuts);
  cutFs.addEventListener("click", () => void doToggleFullscreen());

  // Transport
  cutJumpStartBtn.addEventListener("click", doJumpStart);
  cutReverseBtn.addEventListener("click", doShuttleReverse);
  cutPlayBtn.addEventListener("click", cutPlayPause);
  cutForwardBtn.addEventListener("click", doShuttleForward);
  cutJumpEndBtn.addEventListener("click", doJumpEnd);

  // Options
  cutLoopBtn.addEventListener("click", toggleLoop);
  cutRateBtn.addEventListener("click", doCycleRate);
  cutMuteBtn.addEventListener("click", doToggleMute);
  cutVolume.addEventListener("input", () => doSetVolume(Number(cutVolume.value)));

  // Timeline scrub: click or drag anywhere on the deck.
  cutTimeline.addEventListener("pointerdown", (e) => {
    cutScrubbing = true;
    resetShuttle();
    try {
      cutTimeline.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — drag still works via the move listener */
    }
    cutSeekFromPointer(e);
  });
  cutTimeline.addEventListener("pointermove", (e) => {
    if (cutScrubbing) cutSeekFromPointer(e);
  });
  const endScrub = (e: PointerEvent): void => {
    cutScrubbing = false;
    try {
      cutTimeline.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  cutTimeline.addEventListener("pointerup", endScrub);
  cutTimeline.addEventListener("pointercancel", endScrub);

  // The deck canvases are display-sized — repaint them when the window resizes.
  window.addEventListener("resize", () => {
    if (cutMode) {
      drawFilmstrip();
      drawWaveform();
    }
  });
}

/** DOM adapter: is this focused element a text-entry field? (See player-core.) */
function isFocusTextEntry(el: HTMLElement | null): boolean {
  return isTextEntryTarget(
    el && {
      tagName: el.tagName,
      type: (el as HTMLInputElement).type,
      isContentEditable: el.isContentEditable,
    },
  );
}

/**
 * Bugfix: after a UI element is clicked it keeps keyboard focus, which "steals"
 * the hotkeys — a focused <input type=range> (the scrubber / volume) trips
 * wireKeyboard's text-entry guard and silences every shortcut, and a focused
 * <button> re-fires on Space/Enter. So after any pointer click on a control,
 * hand focus back to the document body. Text-entry fields (the add-timestamp
 * input) are left focused so the user can keep typing.
 *
 * Bound on the document in the bubble phase so a control's own click handler
 * (e.g. "Add timestamp" focusing its input) has already run; we only blur when
 * focus did NOT land on a text field. Keyboard-synthesized clicks (Enter/Space
 * on a focused button, detail === 0) are left alone so Tab navigation keeps its
 * focus ring.
 */
function wireFocusReturn(): void {
  document.addEventListener("click", (e) => {
    if (e.detail === 0) return; // keyboard-activated click — keep focus for a11y
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !isFocusTextEntry(active)) {
      active.blur();
    }
  });
}

function wireKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    // Don't hijack typing in a text field — but ONLY a true text-entry field.
    // Range sliders (the scrubber / volume), checkboxes and buttons are also
    // <input>/focusable, and a stale focus on one of those must not disable
    // every shortcut (see isTextEntryTarget). The add-timestamp input owns its
    // own Enter/Escape locally, so we never reach the player shortcuts here.
    if (isFocusTextEntry(e.target as HTMLElement | null)) return;

    // Timeline / cut view (play-004): J/K/L drive the shuttle transport,
    // overriding the normal-mode meaning of k (play/pause) only while the
    // timeline view is open. Skip when a modifier is held.
    if (cutMode && !stage.hidden && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "j") {
        e.preventDefault();
        doShuttleReverse();
        return;
      }
      if (k === "k") {
        e.preventDefault();
        doShuttleStop();
        return;
      }
      if (k === "l") {
        e.preventDefault();
        doShuttleForward();
        return;
      }
    }

    switch (e.key) {
      case " ":
      case "k":
        e.preventDefault();
        if (!stage.hidden) doTogglePlay();
        break;
      case "ArrowRight":
        if (!stage.hidden) doSkip(true);
        break;
      case "ArrowLeft":
        if (!stage.hidden) doSkip(false);
        break;
      case "ArrowUp":
        e.preventDefault();
        doSetVolume(Math.min(100, Number(volume.value) + 5));
        break;
      case "ArrowDown":
        e.preventDefault();
        doSetVolume(Math.max(0, Number(volume.value) - 5));
        break;
      case "m":
        doToggleMute();
        break;
      case "+":
      case "=":
        if (!stage.hidden) doStepRate(1);
        break;
      case "-":
      case "_":
        if (!stage.hidden) doStepRate(-1);
        break;
      case "f":
        void doToggleFullscreen();
        break;
      case "o":
        void openFileDialog();
        break;
      case "a":
      case "A":
        doPrevTimestamp();
        break;
      case "d":
      case "D":
        doNextTimestamp();
        break;
      case "Home":
        if (!stage.hidden) {
          e.preventDefault();
          doJumpStart();
        }
        break;
      case "End":
        if (!stage.hidden) {
          e.preventDefault();
          doJumpEnd();
        }
        break;
      case "t":
      case "T":
        if (!stage.hidden) {
          e.preventDefault();
          togglePanel();
        }
        break;
      case "c":
      case "C":
        // Toggle the timeline / cut view (play-004).
        if (!stage.hidden) {
          e.preventDefault();
          toggleCutMode();
        }
        break;
      case "?":
        e.preventDefault();
        toggleShortcuts();
        break;
      case "Escape": {
        // Dismiss the topmost layer only. Close any open overlay first, and fall
        // through to leaving fullscreen only when nothing was layered on top —
        // so Esc-to-close the shortcuts modal (or chapters panel) no longer also
        // drops the user out of fullscreen. A second Esc then exits fullscreen.
        const hadOverlay =
          shortcutsOverlay.dataset.open === "true" ||
          tsPanel.dataset.open === "true";
        setShortcutsOpen(false);
        setPanelOpen(false);
        if (!hadOverlay) void setFullscreen(false); // only ever leaves fullscreen
        break;
      }
      default:
        // Number keys 0-9 jump to that tenth of the video (player-only). e.key
        // is "0".."9" for both the top row and the numpad; the single-char range
        // check excludes "F1"/"ArrowUp"/etc. Skip when a modifier is held so
        // accelerator combos (Ctrl+1, …) aren't hijacked.
        if (
          e.key.length === 1 &&
          e.key >= "0" &&
          e.key <= "9" &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.metaKey &&
          !stage.hidden
        ) {
          e.preventDefault();
          doSectionSeek(Number(e.key));
        }
        break;
    }
  });
}

/** If the app was launched with a file ("Open with…"), load it on startup. */
async function loadLaunchFile(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await invoke<string | null>("launch_path");
    if (path) await loadFromPath(path);
  } catch {
    /* Not running under Tauri, or no launch file — ignore. */
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
wireControls();
wireKeyboard();
wireFocusReturn();
loadPinChapter();
void registerDragAndDrop();
void loadLaunchFile();
renderTimestamps();
renderRecents();
render();

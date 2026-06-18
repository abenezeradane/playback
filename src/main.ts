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
  abLoopActive,
  abLoopNext,
  normalizeFrameDurations,
  animationDuration,
  loopedTime,
  frameIndexAtTime,
  frameStartTime,
  stepFrame,
  type PlayerState,
  type Timestamp,
  type TimestampStore,
  type Shuttle,
} from "./player-core";

const VIDEO_EXTENSIONS = ["mp4", "webm", "ogg", "ogv", "mov", "m4v", "mkv", "avi"];
// Animated / still image formats (play-012). The <video> engine can't decode
// these, so they route to the dedicated image viewer (openImage). `png` covers
// both APNG (which conventionally uses the .png extension) and a static PNG;
// `webp` covers both animated and still WebP.
const IMAGE_EXTENSIONS = ["gif", "webp", "apng", "png"];

/** Lowercased file extension (without the dot), or "" if there is none. */
function extensionOf(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : "";
}
function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.includes(extensionOf(path));
}
function isVideoPath(path: string): boolean {
  return VIDEO_EXTENSIONS.includes(extensionOf(path));
}
function isMediaPath(path: string): boolean {
  return isImagePath(path) || isVideoPath(path);
}
/** MIME type to hand the WebCodecs ImageDecoder, derived from the extension. */
function imageMimeType(path: string): string {
  switch (extensionOf(path)) {
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "apng":
    case "png":
      return "image/png";
    default:
      return "";
  }
}

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
// Livestream · Unavailable screen (frame 04b). Livestream playback is temporarily
// deprecated — a detected livestream opens this purpose-built screen (not an empty
// player). We still DETECT it; we just don't tail/play it.
const liveUnavailable = $<HTMLElement>("live-unavailable");
const liveoffTitle = $<HTMLSpanElement>("liveoff-title");
const liveoffMeta = $<HTMLSpanElement>("liveoff-meta");
const liveoffBack = $<HTMLButtonElement>("liveoff-back");
const liveoffOpen = $<HTMLButtonElement>("liveoff-open");
const liveoffHome = $<HTMLButtonElement>("liveoff-home");

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
// Loop / repeat (play-011)
const btnLoop = $<HTMLButtonElement>("btn-loop");
const btnLoopA = $<HTMLButtonElement>("btn-loop-a");
const btnLoopB = $<HTMLButtonElement>("btn-loop-b");
const abMarkers = $<HTMLDivElement>("ab-markers");
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
/** Off-to-the-side <video> used to capture filmstrip frames on open (play-004). */
const cutGen = $<HTMLVideoElement>("cut-gen");

// Image / GIF viewer (play-012)
const imageView = $<HTMLElement>("image-view");
const imgBack = $<HTMLButtonElement>("img-back");
const imgTitle = $<HTMLSpanElement>("img-title");
const imgMeta = $<HTMLSpanElement>("img-meta");
const imgCanvas = $<HTMLCanvasElement>("img-canvas");
const imgEl = $<HTMLImageElement>("img-el");
const imgError = $<HTMLDivElement>("img-error");
const imgPlayBtn = $<HTMLButtonElement>("img-play");
const imgStepBackBtn = $<HTMLButtonElement>("img-step-back");
const imgStepFwdBtn = $<HTMLButtonElement>("img-step-fwd");
const imgRateBtn = $<HTMLButtonElement>("img-rate");
const imgFrameInfo = $<HTMLSpanElement>("img-frameinfo");

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
// Loop / repeat (play-011). `loopOn` is the whole-clip loop — a persisted global
// preference shared with the cut-view loop toggle. `abA`/`abB` are the optional
// A-B section-loop points (per clip, not persisted).
let loopOn = false;
let abA: number | null = null;
let abB: number | null = null;

// Image / GIF viewer (play-012) ----------------------------------------
/** Don't frame-decode an image larger than this into memory; fall back to the
 *  native <img> (which streams) instead. Typical GIFs/WebP are far smaller. */
const IMAGE_MAX_BYTES = 256 * 1024 * 1024;
/** A decoded animation frame: its bitmap and how long it is shown (seconds). */
interface GifFrame {
  bitmap: ImageBitmap;
  duration: number;
}
let imgFrames: GifFrame[] = [];
/** Per-frame durations (seconds), sanitized — the timing source of truth. */
let imgDurations: number[] = [];
/** Total run time of one animation pass (seconds). */
let imgTotal = 0;
/** Elapsed animation clock (seconds); folded back over imgTotal each loop. */
let imgClock = 0;
let imgPlaying = false;
let imgRate = 1;
let imgFrameIndex = 0;
let imgRAF: number | undefined;
let imgLast = 0;
/** Bumped on every open / goHome so an in-flight async decode aborts cleanly. */
let imgToken = 0;
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
  // Drop the per-clip A-B region but KEEP the persisted whole-clip loop pref.
  clearAbLoop();
  applyLoopState();
  setPanelOpen(false);
  setShortcutsOpen(false);
  liveUnavailable.hidden = true;
  clearImageView();
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
  /** True while another process holds the file open for writing (see lib.rs). */
  being_written: boolean;
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
// A real recorder (Streamlink/OBS) flushes whole HLS segments at once, so the
// file grows in bursts with multi-second flat gaps in between. A single short
// sample usually lands in one of those gaps and sees no growth, so the growth
// probe samples repeatedly across this window (exiting early the moment growth
// appears) rather than deciding off one sample. Only reached when the instant
// writer-lock signal is unavailable (a non-Windows host, or a writer that allows
// shared writes), so it rarely runs.
const LIVE_GROWTH_WINDOW_MS = 6_000;

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
/** Wait this long after a file opens before scanning the deck media, so the
 *  generator <video> doesn't fight the main video's own startup decode. */
const CUT_DECK_BUILD_DELAY_MS = 350;

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
    // The deck media is generated in the background on file open (prepareCutDeck),
    // so entering the view just draws whatever frames/peaks are ready so far — a
    // partial filmstrip fills in as the rest stream in. The canvases only have a
    // size once visible, so (re)draw them now.
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

/** Path of the clip whose deck is being (or has been) built. */
let cutDeckPath: string | null = null;

/**
 * Note the clip for the timeline-view deck and START generating its media in the
 * BACKGROUND right now (on file open) — the filmstrip thumbnails and the audio
 * waveform.
 *
 * This is deliberately NOT deferred to the first cut-view open, and the filmstrip
 * is NOT captured from the main <video>. The old approach seeked the on-screen
 * viewer through 12 points the moment you entered the timeline, visibly dragging
 * the user along a scrub (the laggy/jittery feel). Now a dedicated generator
 * <video> is scanned off to the side, so the viewer the user is watching is never
 * touched; the deck just shows however many frames are ready and the rest stream
 * in (see captureFilmstripFromGenerator). The scan is deferred a beat so it does
 * not fight the main video's own startup decode for the hardware decoder.
 */
function prepareCutDeck(path: string): void {
  cutDeckPath = path;
  cutTitle.textContent = basename(path);
  cutMeta.textContent = "";
  resetFpsDetection();
  // New clip: invalidate any in-flight scan, reset what the deck shows.
  const ftoken = ++filmstripToken;
  const wtoken = ++waveformToken;
  filmFrames = new Array(FILMSTRIP_CELLS).fill(null);
  waveformPeaks = [];
  if (cutMode) {
    drawFilmstrip();
    drawWaveform();
  }
  // The ruler is cheap (DOM ticks) and built from the loadedmetadata handler.
  window.setTimeout(() => {
    if (ftoken !== filmstripToken) return; // a newer clip took over before we ran
    void captureFilmstripFromGenerator(path, ftoken);
    void buildWaveform(path, wtoken);
  }, CUT_DECK_BUILD_DELAY_MS);
}

/**
 * Decode the clip's audio into waveform peaks in the background. Small/medium
 * files decode their real audio; very large files fall back to a synthesized
 * waveform so the deck always shows bars without a huge read. `token` guards
 * against a stale build (a newer clip opened).
 */
async function buildWaveform(path: string, token: number): Promise<void> {
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
  // Stop any in-flight background scan and release the generator video.
  cutGen.pause();
  cutGen.removeAttribute("src");
  cutGen.load();
  cutGen.classList.remove("cut-gen--active");
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
 * a DEDICATED generator <video> (#cut-gen) through the capture points and grabbing
 * each presented frame into an offscreen 160×90 canvas. The main viewer is never
 * touched, so the user is not dragged along the scrub; this runs in the background
 * on file open.
 *
 * WebView2 caveat (hard-won): drawImage reads BLACK from a detached / off-screen /
 * occluded / transparent <video>; it only paints a real frame for a video that is
 * genuinely composited on-screen. So #cut-gen is shown as a tiny, fully-opaque,
 * non-occluded square in the corner for the duration of the scan (then hidden),
 * and each frame is grabbed on the next requestVideoFrameCallback after the seek —
 * not on 'seeked', which only means the seek *data* (not a painted frame) is ready.
 *
 * Each captured frame is drawn immediately, so a cut view opened mid-build shows a
 * partial filmstrip that fills in as the remaining frames arrive. `token` (the
 * filmstrip generation) lets a newer clip / going home abort the scan.
 */
function captureFilmstripFromGenerator(path: string, token: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const gen = cutGen;
    const rvfc = (
      gen as unknown as {
        requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
      }
    ).requestVideoFrameCallback;
    let genDur = 0;
    let k = 0;
    let safety: number | undefined;
    let done = false;

    const stale = (): boolean => token !== filmstripToken;
    const targetTime = (): number => ((k + 0.5) / FILMSTRIP_CELLS) * genDur;

    const finish = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(safety);
      gen.removeEventListener("seeked", onSeeked);
      gen.removeEventListener("loadedmetadata", onMeta);
      gen.removeEventListener("error", finish);
      // Only release the shared generator element if no newer scan has claimed it.
      if (token === filmstripToken) {
        gen.pause();
        gen.removeAttribute("src");
        gen.load();
        gen.classList.remove("cut-gen--active");
      }
      resolve();
    };

    const grab = (): void => {
      window.clearTimeout(safety);
      if (stale()) return finish();
      if (gen.videoWidth > 0) {
        const off = document.createElement("canvas");
        off.width = 160;
        off.height = 90;
        const octx = off.getContext("2d");
        if (octx) {
          drawCover(octx, gen, gen.videoWidth, gen.videoHeight, 0, 0, 160, 90);
          filmFrames[k] = off;
          if (cutMode) drawFilmstrip();
        }
      }
      k++;
      if (k < FILMSTRIP_CELLS) seekNext();
      else finish();
    };

    const onSeeked = (): void => {
      if (stale()) return finish();
      // Capture on the next presented frame (requestVideoFrameCallback), not on
      // 'seeked' itself — 'seeked' only means the seek data is ready; the frame
      // may not be painted yet (drawImage would read black). The presented frame's
      // mediaTime tells us whether the seek has actually landed: the FIRST frame
      // after 'seeked' is occasionally still the PREVIOUS one (which used to
      // produce duplicate thumbnails). A paused video only presents once per seek,
      // so we can't wait for a *second* rVFC — instead, on a stale frame, let it
      // settle briefly and then take whatever is current (the seek has landed by
      // then). No rVFC → fall back to the same short settle.
      const want = targetTime();
      const tol = Math.min(0.4, genDur / FILMSTRIP_CELLS / 2);
      if (typeof rvfc !== "function") {
        window.setTimeout(grab, 80);
        return;
      }
      rvfc.call(gen, (_now, meta) => {
        if (stale()) return finish();
        if (Math.abs(meta.mediaTime - want) <= tol) grab();
        else window.setTimeout(grab, 80);
      });
    };

    function seekNext(): void {
      if (stale()) return finish();
      gen.addEventListener("seeked", onSeeked, { once: true });
      window.clearTimeout(safety);
      safety = window.setTimeout(grab, 2500); // don't hang if a frame never lands
      gen.currentTime = targetTime();
    }

    function onMeta(): void {
      if (stale()) return finish();
      genDur = gen.duration;
      if (!Number.isFinite(genDur) || genDur <= 0) return finish();
      seekNext();
    }

    void (async () => {
      try {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        if (stale()) return finish();
        gen.classList.add("cut-gen--active");
        gen.muted = true;
        gen.addEventListener("loadedmetadata", onMeta, { once: true });
        gen.addEventListener("error", finish, { once: true });
        gen.src = convertFileSrc(path);
        gen.load();
        // Bail rather than hang if metadata never lands.
        safety = window.setTimeout(finish, 8000);
      } catch {
        finish();
      }
    })();
  });
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

// ---------------------------------------------------------------------------
// Loop / repeat (play-011)
// ---------------------------------------------------------------------------
const LOOP_STORAGE_KEY = "playback:loop";

/** Restore the persisted whole-clip loop preference at boot. */
function loadLoopPref(): void {
  try {
    loopOn = localStorage.getItem(LOOP_STORAGE_KEY) === "true";
  } catch {
    loopOn = false;
  }
  applyLoopState();
}

function persistLoopPref(): void {
  try {
    localStorage.setItem(LOOP_STORAGE_KEY, String(loopOn));
  } catch {
    /* storage unavailable — keep the in-memory state */
  }
}

/**
 * Native `video.loop` does whole-clip repeat, but ONLY when no A-B region is
 * active — an A-B section loop drives its own seek-back (maybeAbLoop) and would
 * otherwise fight a clip-end native loop when B sits at the very end.
 */
function applyLoopToVideo(): void {
  video.loop = loopOn && !abLoopActive(abA, abB);
}

/** Reflect loop + A-B state onto every loop control and the scrubber markers. */
function applyLoopState(): void {
  applyLoopToVideo();
  // Whole-clip loop button (control bar) + the cut-view loop toggle share state.
  btnLoop.setAttribute("aria-pressed", String(loopOn));
  cutSection.dataset.loop = String(loopOn);
  cutLoopBtn.setAttribute("aria-pressed", String(loopOn));
  // A-B in/out point buttons light up when their point is set.
  btnLoopA.setAttribute("aria-pressed", String(abA !== null));
  btnLoopB.setAttribute("aria-pressed", String(abB !== null));
  renderAbMarkers();
}

/** Whole-clip loop: persisted, shared with the cut-view toggle. */
function setLoop(on: boolean): void {
  loopOn = on;
  persistLoopPref();
  applyLoopState();
}

function toggleLoop(): void {
  setLoop(!loopOn);
}

/** Toggle the A-B in-point (A): set it at the current time, or clear if set. */
function toggleAbA(): void {
  abA = abA === null ? video.currentTime || 0 : null;
  applyLoopState();
  showControls();
}

/** Toggle the A-B out-point (B): set it at the current time, or clear if set. */
function toggleAbB(): void {
  abB = abB === null ? video.currentTime || 0 : null;
  applyLoopState();
  showControls();
}

/** Drop the A-B region (used when the clip changes / returning home). */
function clearAbLoop(): void {
  abA = null;
  abB = null;
}

/** Repeat [A,B]: when the playhead reaches B, jump back to A (play-011). Skipped
 *  while the user is dragging the scrubber so a manual seek isn't fought. */
function maybeAbLoop(): void {
  if (isScrubbing) return;
  const target = abLoopNext(video.currentTime, abA, abB);
  if (target !== null) video.currentTime = target;
}

/** Draw the A-B region band + end flags on the scrubber (distinct from chapters). */
function renderAbMarkers(): void {
  abMarkers.replaceChildren();
  const dur = state.duration;
  if (dur <= 0) return;
  if (abLoopActive(abA, abB)) {
    const left = markerFraction(abA as number, dur) * 100;
    const right = markerFraction(abB as number, dur) * 100;
    const region = document.createElement("div");
    region.className = "ab-region";
    region.style.left = `${left}%`;
    region.style.width = `${Math.max(0, right - left)}%`;
    abMarkers.appendChild(region);
  }
  if (abA !== null) abMarkers.appendChild(makeAbFlag(abA, dur, "A"));
  if (abB !== null) abMarkers.appendChild(makeAbFlag(abB, dur, "B"));
}

function makeAbFlag(time: number, dur: number, label: string): HTMLDivElement {
  const flag = document.createElement("div");
  flag.className = "ab-flag";
  flag.dataset.label = label;
  flag.style.left = `${markerFraction(time, dur) * 100}%`;
  return flag;
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
  addRecent(path, basename(path));
  // Animated / still images (play-012) can't be decoded by the <video> engine,
  // and the cut view / livestream detection don't apply to them, so route them
  // to the dedicated image viewer before any video/stream handling.
  if (isImagePath(path)) {
    loadTimestampsFor(null);
    await openImage(path);
    return;
  }
  loadTimestampsFor(path); // seed this video's saved timestamps before it loads
  try {
    const status = await tauriInvoke<StreamStatus>("stream_status", { path }).catch(() => null);
    // Decide live-vs-normal BEFORE the first frame paints. Livestream playback is
    // temporarily deprecated, so a recording in progress opens an empty player
    // instead of being tailed.
    const detected = status ? await detectLive(path, status) : "normal";
    if (detected !== "normal") {
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
 *  - `live-lock`   — another process holds the file open for writing (a recorder
 *                    such as Streamlink/OBS is still appending). Instant + reliable.
 *  - `live-grow`   — no marker or lock signal, but the file is recently-written AND
 *                    visibly grows while we watch it.
 *  - `normal`      — everything else: a finished or static file.
 *
 * The growth watch only runs for a recently-modified file with no lock signal, so
 * ordinary opens of a static file stay instant.
 */
async function detectLive(
  path: string,
  status: StreamStatus,
): Promise<"live-marker" | "live-lock" | "live-grow" | "normal"> {
  if (status.complete) return "normal";
  if (status.live) return "live-marker";
  // Most reliable signal: a recorder still holds the file open for writing. This
  // is instant and — unlike a size sample — is not defeated by the multi-second
  // flat gaps between an HLS recorder's segment-write bursts.
  if (status.being_written) return "live-lock";
  // Only spend time probing a file that was just written — a file last touched
  // long ago is static, so open it normally without any added latency.
  if (status.mtime_age_ms > LIVE_RECENT_MS) return "normal";
  // No lock signal but recently written: confirm the file is still being appended
  // to. A real recorder grows in bursts with multi-second flat gaps, so sample
  // repeatedly across a window and bail out the instant we see growth (or the
  // file gets locked / grows), rather than judging off a single sample that
  // usually lands in a gap.
  const deadline = Date.now() + LIVE_GROWTH_WINDOW_MS;
  do {
    await delay(LIVE_GROWTH_SAMPLE_MS);
    const after = await tauriInvoke<StreamStatus>("stream_status", { path }).catch(() => null);
    if (!after || after.complete) return "normal";
    if (after.being_written) return "live-lock";
    if (after.size > status.size + LIVE_GROWTH_THRESHOLD) return "live-grow";
  } while (Date.now() < deadline);
  return "normal";
}

/** Promise-based delay used by the up-front live probe. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Load a media file from an already-resolved URL (asset://). */
function loadSrc(src: string, title: string, subtitle = ""): void {
  emptyError.hidden = true;
  liveUnavailable.hidden = true;
  clearImageView(); // leaving any image viewer for a real video
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
  // New clip: drop any A-B region but re-apply the persisted loop pref (play-011).
  clearAbLoop();
  applyLoopState();
  video.load();
  void video.play().catch(() => {
    /* autoplay may be blocked; user can press play */
  });
  showControls();
}

/**
 * Livestream playback is temporarily deprecated. A file detected as a livestream
 * (a `.live` marker or an actively-growing recording) opens the purpose-built
 * "Livestream · Unavailable" screen (frame 04b) instead of being tailed — we play
 * nothing and route the viewer to a recorded file or back to the library.
 */
function openEmptyLivePlayer(path: string): void {
  const title = basename(path);
  const folder = parentDir(path);
  // This screen plays nothing — tear down any prior playback + player chrome.
  video.pause();
  video.removeAttribute("src");
  video.load();
  setCutMode(false);
  resetShuttle();
  setPanelOpen(false);
  clearImageView();
  emptyError.hidden = true;
  liveoffTitle.textContent = title;
  liveoffMeta.textContent = folder ? `Livestream · ${folder}` : "Livestream";
  document.title = `${title} — Playback`;
  app.dataset.state = "live-unavailable";
  emptyState.hidden = true;
  stage.hidden = true;
  liveUnavailable.hidden = false;
  state = createInitialState();
}

// ---------------------------------------------------------------------------
// Image / GIF viewer (play-012)
//
// GIF / animated-WebP / APNG are image formats the <video> engine can't decode,
// so they get a dedicated render path. The preferred (Tier 2) path frame-decodes
// the file with WebCodecs ImageDecoder and drives a <canvas> off a rAF clock —
// giving real play/pause, a speed multiplier, and frame stepping (the per-frame
// timing math is pure, in player-core). If a file can't be frame-decoded (no
// ImageDecoder, an unsupported type, or a decode error) it falls back to a
// native <img> that the WebView animates + loops itself (Tier 1, no transport).
// A still (single-frame) image opens as one frozen frame with transport off.
// ---------------------------------------------------------------------------

/** True while the image viewer is the visible surface. */
function imageViewActive(): boolean {
  return !imageView.hidden;
}

/** Reset all animation state + release decoded bitmaps (does NOT hide the view). */
function resetGifState(): void {
  imgPlaying = false;
  if (imgRAF !== undefined) {
    cancelAnimationFrame(imgRAF);
    imgRAF = undefined;
  }
  for (const f of imgFrames) f.bitmap.close();
  imgFrames = [];
  imgDurations = [];
  imgTotal = 0;
  imgClock = 0;
  imgFrameIndex = 0;
  imgRate = 1;
}

/** Tear down the image viewer entirely (abort any decode, release frames, hide). */
function clearImageView(): void {
  imgToken++; // abort any in-flight decode
  resetGifState();
  imgEl.removeAttribute("src");
  imgEl.hidden = true;
  imgCanvas.hidden = true;
  imageView.hidden = true;
}

/** Open an animated / still image in the dedicated viewer (play-012). */
async function openImage(path: string): Promise<void> {
  const token = ++imgToken;
  // Leaving any prior surface: stop the video + cut view, release old frames.
  video.pause();
  video.removeAttribute("src");
  video.load();
  setCutMode(false);
  clearCutDeck();
  resetShuttle();
  setPanelOpen(false);
  setShortcutsOpen(false);
  resetGifState();

  const title = basename(path);
  const folder = parentDir(path);
  imgTitle.textContent = title;
  imgMeta.textContent = folder || "Image";
  document.title = `${title} — Playback`;

  // Show the viewer, hide every other surface.
  app.dataset.state = "image";
  emptyState.hidden = true;
  emptyError.hidden = true;
  stage.hidden = true;
  liveUnavailable.hidden = true;
  imageView.hidden = false;
  imageView.dataset.mode = "loading";
  imgError.hidden = true;
  imgCanvas.hidden = true;
  imgEl.hidden = true;

  let src: string;
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    src = convertFileSrc(path);
  } catch {
    if (token === imgToken) showImageError();
    return;
  }
  if (token !== imgToken) return;

  // Prefer the frame-decoded transport path; fall back to a native <img>.
  const decoded = await tryDecodeAnimation(path, token);
  if (token !== imgToken) return;
  if (!decoded) showNativeImage(src, token);
}

/**
 * Try to frame-decode the image with WebCodecs ImageDecoder. On success the
 * frames are stored, the first is painted immediately, transport is enabled (a
 * multi-frame animation autoplays) or disabled (a single frozen frame), and
 * `true` is returned. Returns false — so the caller falls back to a native
 * <img> — when ImageDecoder is unavailable, the type is unsupported, the file is
 * too large / unreadable, decoding fails, or no frame could be decoded.
 *
 * The file bytes are read through the Rust `read_stream_chunk` command (same as
 * the cut-view waveform), NOT fetched: the app's CSP (`default-src 'self'`) would
 * block a fetch of the `asset:` URL.
 */
async function tryDecodeAnimation(path: string, token: number): Promise<boolean> {
  if (typeof ImageDecoder === "undefined") return false;
  const type = imageMimeType(path);
  if (!type) return false;
  try {
    if (!(await ImageDecoder.isTypeSupported(type))) return false;
    const status = await tauriInvoke<StreamStatus>("stream_status", { path }).catch(() => null);
    if (!status || status.size <= 0 || status.size > IMAGE_MAX_BYTES) return false;
    const data = await readWholeFile(path, status.size);
    if (token !== imgToken) return false;
    if (data.length === 0) return false;

    const decoder = new ImageDecoder({ data, type });
    await decoder.tracks.ready;
    if (token !== imgToken) {
      decoder.close();
      return false;
    }
    const frameCount = Math.max(1, decoder.tracks.selectedTrack?.frameCount ?? 1);

    const frames: GifFrame[] = [];
    for (let i = 0; i < frameCount; i++) {
      const result = await decoder.decode({ frameIndex: i }).catch(() => null);
      if (!result) break; // truncated / partly-corrupt: keep whatever decoded
      if (token !== imgToken) {
        result.image.close();
        for (const f of frames) f.bitmap.close();
        decoder.close();
        return false;
      }
      const frame = result.image;
      const durationS = (frame.duration ?? 0) / 1_000_000; // micros -> seconds
      const bitmap = await createImageBitmap(frame);
      frame.close();
      frames.push({ bitmap, duration: durationS });
      // Paint the first frame straight away so the viewer isn't blank while a
      // long animation finishes decoding.
      if (i === 0) {
        imgCanvas.hidden = false;
        drawBitmap(bitmap);
      }
      if (token !== imgToken) {
        for (const f of frames) f.bitmap.close();
        decoder.close();
        return false;
      }
    }
    decoder.close();
    if (frames.length === 0) return false;

    imgFrames = frames;
    imgDurations = normalizeFrameDurations(frames.map((f) => f.duration));
    imgTotal = animationDuration(imgDurations);
    imgClock = 0;
    imgFrameIndex = 0;
    imgRate = 1;
    imgRateBtn.textContent = "1×";
    imgCanvas.hidden = false;
    imgEl.hidden = true;
    imgError.hidden = true;
    drawGifFrame(0);

    if (frames.length > 1 && imgTotal > 0) {
      imageView.dataset.mode = "animated";
      startGif();
    } else {
      imageView.dataset.mode = "static"; // one frozen frame, no transport
    }
    updateGifInfo();
    return true;
  } catch {
    return false;
  }
}

/** Native fallback: let the WebView animate + loop the image itself (no transport). */
function showNativeImage(src: string, token: number): void {
  imgCanvas.hidden = true;
  imageView.dataset.mode = "native";
  imgEl.onload = () => {
    if (token !== imgToken) return;
    // A corrupt image can fire `load` with zero dimensions instead of `error`.
    if (imgEl.naturalWidth === 0) {
      showImageError();
      return;
    }
    imgEl.hidden = false;
    imgError.hidden = true;
  };
  imgEl.onerror = () => {
    if (token === imgToken) showImageError();
  };
  imgEl.hidden = false;
  imgEl.src = src;
}

/** Clear, honest error state for a corrupt / unsupported image (no broken glyph). */
function showImageError(): void {
  imageView.dataset.mode = "error";
  imgCanvas.hidden = true;
  imgEl.hidden = true;
  imgEl.removeAttribute("src");
  imgError.hidden = false;
}

/** Paint a bitmap to the canvas, sizing the canvas to the frame's pixel size. */
function drawBitmap(bitmap: ImageBitmap): void {
  if (imgCanvas.width !== bitmap.width || imgCanvas.height !== bitmap.height) {
    imgCanvas.width = bitmap.width;
    imgCanvas.height = bitmap.height;
  }
  const ctx = imgCanvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, imgCanvas.width, imgCanvas.height);
  ctx.drawImage(bitmap, 0, 0);
}

function drawGifFrame(idx: number): void {
  const f = imgFrames[idx];
  if (f) drawBitmap(f.bitmap);
}

function startGif(): void {
  if (imgFrames.length <= 1 || imgTotal <= 0) return;
  imgPlaying = true;
  imgPlayBtn.dataset.playing = "true";
  imgLast = performance.now();
  if (imgRAF === undefined) imgRAF = requestAnimationFrame(gifTick);
}

function pauseGif(): void {
  imgPlaying = false;
  imgPlayBtn.dataset.playing = "false";
  if (imgRAF !== undefined) {
    cancelAnimationFrame(imgRAF);
    imgRAF = undefined;
  }
}

function toggleGifPlay(): void {
  if (imgPlaying) pauseGif();
  else startGif();
}

/** rAF clock: advance the animation by real elapsed time × the speed multiplier. */
function gifTick(now: number): void {
  imgRAF = undefined;
  if (!imgPlaying) return;
  const dt = ((now - imgLast) / 1000) * imgRate;
  imgLast = now;
  imgClock = loopedTime(imgClock + dt, imgTotal);
  const idx = frameIndexAtTime(imgDurations, imgClock);
  if (idx !== imgFrameIndex) {
    imgFrameIndex = idx;
    drawGifFrame(idx);
    updateGifInfo();
  }
  imgRAF = requestAnimationFrame(gifTick);
}

/** Step one frame (pausing playback); wraps around the ends. */
function stepGifFrame(delta: number): void {
  if (imgFrames.length <= 1) return;
  pauseGif();
  imgFrameIndex = stepFrame(imgFrameIndex, delta, imgFrames.length);
  imgClock = frameStartTime(imgDurations, imgFrameIndex);
  drawGifFrame(imgFrameIndex);
  updateGifInfo();
}

/** Cycle the playback rate (the rate button), mirroring the video rate control. */
function cycleGifRate(): void {
  imgRate = nextRate(imgRate);
  imgRateBtn.textContent = `${imgRate}×`;
}

/** Step the playback rate up/down (the +/- hotkeys), clamped at the ends. */
function stepGifRate(dir: number): void {
  imgRate = stepRate(imgRate, dir);
  imgRateBtn.textContent = `${imgRate}×`;
}

function updateGifInfo(): void {
  imgFrameInfo.textContent =
    imgFrames.length <= 1 ? "Still image" : `Frame ${imgFrameIndex + 1} / ${imgFrames.length}`;
}

/** Image-viewer transport hotkeys; returns true if the key was handled. */
function handleImageKey(e: KeyboardEvent): boolean {
  if (imgFrames.length <= 1) return false; // static / native: no transport
  switch (e.key) {
    case " ":
    case "k":
      e.preventDefault();
      toggleGifPlay();
      return true;
    case ",":
    case "<":
      e.preventDefault();
      stepGifFrame(-1);
      return true;
    case ".":
    case ">":
      e.preventDefault();
      stepGifFrame(1);
      return true;
    case "+":
    case "=":
      e.preventDefault();
      stepGifRate(1);
      return true;
    case "-":
    case "_":
      e.preventDefault();
      stepGifRate(-1);
      return true;
    default:
      return false;
  }
}

/** Open the native file picker (Tauri) and load the chosen file. */
async function openFileDialog(): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "Media", extensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS] },
        { name: "Video", extensions: VIDEO_EXTENSIONS },
        { name: "Animated image", extensions: IMAGE_EXTENSIONS },
      ],
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
        const mediaPath = paths.find((p) => isMediaPath(p));
        if (mediaPath) void loadFromPath(mediaPath);
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

  // Image / GIF viewer (play-012)
  imgBack.addEventListener("click", goHome);
  imgPlayBtn.addEventListener("click", toggleGifPlay);
  imgStepBackBtn.addEventListener("click", () => stepGifFrame(-1));
  imgStepFwdBtn.addEventListener("click", () => stepGifFrame(1));
  imgRateBtn.addEventListener("click", cycleGifRate);

  // Loop / repeat (play-011)
  btnLoop.addEventListener("click", toggleLoop);
  btnLoopA.addEventListener("click", toggleAbA);
  btnLoopB.addEventListener("click", toggleAbB);

  // Livestream · Unavailable screen (frame 04b): both back affordances go home and
  // the primary opens a recorded file (the shortcuts overlay is reached via ?).
  liveoffBack.addEventListener("click", goHome);
  liveoffHome.addEventListener("click", goHome);
  liveoffOpen.addEventListener("click", () => void openFileDialog());

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
    // A-B loop markers also need the real duration to position (play-011).
    renderAbMarkers();
    // Cut view (play-004): build the ruler now the duration + dimensions exist.
    buildRuler(video.duration);
    updateCutMeta();
    if (cutMode) renderCut();
  });
  video.addEventListener("timeupdate", () => {
    maybeAbLoop();
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

    // Animated-image viewer (play-012): when an image is open its transport
    // hotkeys (play/pause, frame-step, speed) take precedence. Unhandled keys
    // (o, ?, Esc) fall through to the shared handlers below.
    if (imageViewActive() && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (handleImageKey(e)) return;
    }

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
      case "r":
      case "R":
        // Loop / repeat toggle (play-011), player-only.
        if (!stage.hidden) toggleLoop();
        break;
      case "i":
      case "I":
        // Set / clear the A-B loop in-point (play-011), player-only.
        if (!stage.hidden) toggleAbA();
        break;
      case "b":
      case "B":
        // Set / clear the A-B loop out-point (play-011), player-only.
        if (!stage.hidden) toggleAbB();
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
loadLoopPref();
void registerDragAndDrop();
void loadLaunchFile();
renderTimestamps();
renderRecents();
render();

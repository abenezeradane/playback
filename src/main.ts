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
  SKIP_SECONDS,
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
  LIVE_DELAY_SECONDS,
  liveEdge,
  clampToLiveWindow,
  skipLive,
  isCaughtUp,
  canFastForwardLive,
  behindLive,
  liveProgressFraction,
  type PlayerState,
  type Timestamp,
  type TimestampStore,
  type LiveWindow,
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

// Livestream (play-003)
const liveBadge = $<HTMLButtonElement>("live-badge");
const btnGoLive = $<HTMLButtonElement>("btn-golive");
const liveEdgeTick = $<HTMLDivElement>("live-edge");

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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state: PlayerState = createInitialState();
let isScrubbing = false;

// The active livestream controller (play-003), or null for a normal file.
let live: LiveStream | null = null;
// Background watcher that auto-upgrades a normal open to live if the file grows.
let growthWatch: number | undefined;
// When a live source has just been (auto-)opened, jump to the live edge as soon
// as enough has buffered (so an upgraded recording starts at "now", not the past).
let pendingGoLive = false;

// Parsed timestamps + the DOM nodes rendered for them (index-aligned), so the
// active-chapter highlight can be updated cheaply on every timeupdate.
let timestamps: Timestamp[] = [];
let markerEls: HTMLElement[] = [];
let listEls: HTMLElement[] = [];
let activeTsIndex = -1;

/** Pull the canonical values from the media element into our state object. */
function syncFromVideo(): void {
  state = {
    ...state,
    isPlaying: !video.paused && !video.ended,
    currentTime: video.currentTime || 0,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    volume: video.volume,
    muted: video.muted,
    rate: video.playbackRate,
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

  const w = activeLiveWindow();
  if (w) {
    renderLive(w);
  } else {
    // Normal file: time + scrubber against a fixed duration.
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

    // Live chrome only applies in live mode.
    if (!liveBadge.hidden) liveBadge.hidden = true;
    if (!btnGoLive.hidden) btnGoLive.hidden = true;
    if (!liveEdgeTick.hidden) liveEdgeTick.hidden = true;
    if (btnForward.disabled) btnForward.disabled = false;
  }

  // Volume + mute
  const audible = effectiveVolume(state);
  volume.value = String(Math.round(audible * 100));
  btnMute.dataset.muted = String(audible === 0);

  // Rate
  btnRate.textContent = `${state.rate}×`;

  // Active-chapter highlight (cheap; rebuilds nothing).
  updateActiveTimestamp();
}

/** Render the scrubber, time, and LIVE chrome for a still-growing stream. */
function renderLive(w: LiveWindow): void {
  const edge = liveEdge(w);
  const caught = isCaughtUp(state.currentTime, w);
  const behind = Math.round(behindLive(state.currentTime, w));

  // Scrubber maps the playhead onto the [0, available] DVR window; the buffered
  // bar fills the whole window and a tick marks the reachable live edge.
  const frac = liveProgressFraction(state.currentTime, w);
  if (!isScrubbing) seek.value = String(Math.round(frac * 1000));
  progress.style.width = `${frac * 100}%`;
  buffered.style.width = "100%";
  const edgeFrac = w.available > 0 ? clamp(edge / w.available, 0, 1) : 1;
  liveEdgeTick.hidden = false;
  liveEdgeTick.style.left = `${edgeFrac * 100}%`;

  // Time reads as "position / LIVE", with how far behind when not caught up.
  timeLabel.innerHTML = caught
    ? `<span class="t-cur">${formatTime(state.currentTime)}</span><span class="t-sep">/</span><span class="t-live">LIVE</span>`
    : `<span class="t-cur">${formatTime(state.currentTime)}</span><span class="t-sep">/</span><span class="t-live">LIVE <em>−${behind}s</em></span>`;

  // LIVE status badge (top overlay); pulses once caught up to the edge.
  liveBadge.hidden = false;
  liveBadge.dataset.caught = String(caught);

  // "GO LIVE" action appears only while behind; fast-forward is gated at the edge.
  btnGoLive.hidden = caught;
  btnForward.disabled = caught;
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
  const w = activeLiveWindow();
  if (w) {
    // Live: track back freely, but fast-forward stops at the live edge.
    if (forward && !canFastForwardLive(state.currentTime, w)) {
      flashMarker("LIVE");
      render();
      showControls();
      return;
    }
    const next = skipLive(state.currentTime, forward ? SKIP_SECONDS : -SKIP_SECONDS, w);
    state = { ...state, currentTime: next };
    video.currentTime = next;
    render();
    showControls();
    return;
  }
  state = forward ? fastForward(state) : rewind(state);
  video.currentTime = state.currentTime;
  render();
  showControls();
}

function doSeekTo(seconds: number): void {
  syncFromVideo();
  const w = activeLiveWindow();
  if (w) {
    const next = clampToLiveWindow(seconds, w);
    state = { ...state, currentTime: next };
    video.currentTime = next;
    render();
    return;
  }
  state = seekTo(state, seconds);
  video.currentTime = state.currentTime;
  render();
}

/**
 * Jump to a tenth of the video with the 0-9 number keys (play-009): digit n
 * seeks to n/10 of the duration. For a growing-file livestream we map against
 * the written window (`available`) and route through doSeekTo, which clamps to
 * the live window — so a digit past the live edge lands at the edge, never
 * beyond. The split is a seek convention only; nothing is drawn on the timeline.
 */
function doSectionSeek(digit: number): void {
  syncFromVideo();
  const w = activeLiveWindow();
  const basis = w ? w.available : state.duration;
  doSeekTo(sectionSeekTime(digit, basis));
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
  stopLive();
  stopGrowthWatch();
  setPanelOpen(false);
  setShortcutsOpen(false);
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
// Livestream (play-003)
//
// The asset protocol only sees a file's bytes as of load time, so a file that is
// still being written never grows in a plain <video src>. To watch a live
// capture we instead tail the file ourselves: poll the Rust `stream_status`
// command for the current size, pull new bytes with `read_stream_chunk`, and
// append them to a MediaSource SourceBuffer. The live edge advances as bytes
// arrive; player-core owns the windowing decisions (edge, FF gating, clamps).
// ---------------------------------------------------------------------------

interface StreamStatus {
  size: number;
  live: boolean;
  complete: boolean;
}

interface LiveStartLayout {
  size: number;
  init_end: number;
  start: number;
}

/** Bytes pulled per read; reads per poll (so a fresh window loads quickly). */
const LIVE_CHUNK_BYTES = 4 * 1024 * 1024;
const LIVE_READS_PER_POLL = 6;
const LIVE_POLL_MS = 700;
// How much of the tail to load up front — the back-trackable DVR window. Keeps a
// multi-GB stream from reading/buffering its whole history just to reach live.
const LIVE_WINDOW_BYTES = 16 * 1024 * 1024;
// Treat the stream as ended (and finalize) once it has not grown for this long
// AND has no `.live` marker. Generous, so HLS segment gaps don't trip it.
const LIVE_STALL_MS = 8000;
// Cap the buffered span to stay under the MediaSource quota on long streams;
// evict from the oldest end when exceeded (limits how far back you can track).
const LIVE_MAX_BUFFER_SECONDS = 120;
const LIVE_EVICT_SECONDS = 30;

// Fallback MediaSource MIME types if the codec can't be read from the init
// segment; the first one the WebView reports as supported wins.
const LIVE_MIME_CANDIDATES = [
  'video/mp4; codecs="avc1.64002a,mp4a.40.2"', // H.264 High@4.2 (1080p60) + AAC
  'video/mp4; codecs="avc1.64001f,mp4a.40.2"', // High@3.1 + AAC-LC
  'video/mp4; codecs="avc1.4d401f,mp4a.40.2"', // Main@3.1 + AAC-LC
  'video/mp4; codecs="avc1.42e01e,mp4a.40.2"', // Baseline@3.0 + AAC-LC
  'video/mp4; codecs="avc1.64002a"', // video-only fallbacks
  'video/mp4; codecs="avc1.64001f"',
];

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

/** Index of an ASCII needle (e.g. a box type) within a byte array, or -1. */
function indexOfAscii(bytes: Uint8Array, needle: string): number {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Minimal fragmented-MP4 transmuxing.
//
// Some real-world recorders (e.g. Streamlink capturing Twitch) write fMP4 that
// ffprobe accepts but the WebView's MediaSource refuses, for two reasons:
//   1. the audio `esds` is missing its AudioSpecificConfig (DecoderSpecificInfo),
//   2. each `tfhd` uses absolute `base-data-offset` addressing, which MSE forbids
//      (it requires movie-fragment-relative addressing).
// We fix both on the fly: inject the AAC config into the init segment, and
// rewrite each `moof` to use `default-base-is-moof`. Streams that are already
// MSE-compliant (e.g. our ffmpeg fixture) pass through these untouched.
// ---------------------------------------------------------------------------

interface Box {
  type: string;
  start: number;
  size: number;
  hs: number;
}

/** Walk the top-level boxes of `b` within [start, end). */
function walkBoxes(b: Uint8Array, start: number, end: number): Box[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  let i = start;
  while (i + 8 <= end) {
    let size = dv.getUint32(i);
    let hs = 8;
    if (size === 1) {
      if (i + 16 > end) break;
      size = Number(dv.getBigUint64(i + 8));
      hs = 16;
    }
    if (size < 8 || i + size > end) break;
    out.push({ type: boxType(b, i), start: i, size, hs });
    i += size;
  }
  return out;
}

function boxType(b: Uint8Array, i: number): string {
  return String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
}

/** Read a 4-character code at an absolute offset (not a box header). */
function fourCC(b: Uint8Array, off: number): string {
  return String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
}

const AAC_FREQS = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Read an MPEG-4 descriptor header at `p` (tag + expandable length). */
function readDescriptor(b: Uint8Array, p: number): { tag: number; len: number; payload: number; lenLastByte: number } {
  const tag = b[p];
  p++;
  let len = 0;
  let lenLastByte = p;
  let c: number;
  do {
    c = b[p];
    lenLastByte = p;
    p++;
    len = (len << 7) | (c & 0x7f);
  } while (c & 0x80);
  return { tag, len, payload: p, lenLastByte };
}

/**
 * Inject the AudioSpecificConfig into the audio track's `esds` if it is missing,
 * so MSE can decode the AAC. Derives the config (AAC-LC, sample rate, channels)
 * from the `mp4a` sample entry. Returns the (possibly unchanged) init segment.
 */
function patchInitSegment(init: Uint8Array): Uint8Array {
  const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const moov = walkBoxes(init, 0, init.length).find((b) => b.type === "moov");
  if (!moov) return init;

  let mp4a: Box | undefined;
  let esds: Box | undefined;
  const chain: Box[] = [moov];
  for (const trak of walkBoxes(init, moov.start + moov.hs, moov.start + moov.size).filter((b) => b.type === "trak")) {
    const mdia = walkBoxes(init, trak.start + trak.hs, trak.start + trak.size).find((b) => b.type === "mdia");
    if (!mdia) continue;
    const mdiaKids = walkBoxes(init, mdia.start + mdia.hs, mdia.start + mdia.size);
    const hdlr = mdiaKids.find((b) => b.type === "hdlr");
    if (!hdlr || fourCC(init, hdlr.start + hdlr.hs + 8) !== "soun") continue;
    const minf = mdiaKids.find((b) => b.type === "minf");
    if (!minf) continue;
    const stbl = walkBoxes(init, minf.start + minf.hs, minf.start + minf.size).find((b) => b.type === "stbl");
    if (!stbl) continue;
    const stsd = walkBoxes(init, stbl.start + stbl.hs, stbl.start + stbl.size).find((b) => b.type === "stsd");
    if (!stsd) continue;
    mp4a = walkBoxes(init, stsd.start + stsd.hs + 8, stsd.start + stsd.size)[0];
    if (!mp4a) continue;
    esds = walkBoxes(init, mp4a.start + 36, mp4a.start + mp4a.size).find((b) => b.type === "esds");
    if (esds) chain.push(trak, mdia, minf, stbl, stsd, mp4a, esds);
    break;
  }
  if (!esds || !mp4a) return init;

  // Walk the descriptors: ES_Descriptor(0x03) -> DecoderConfig(0x04) -> [DecSpecificInfo(0x05)?]
  const es = readDescriptor(init, esds.start + esds.hs + 4);
  if (es.tag !== 0x03) return init;
  let q = es.payload + 2; // skip ES_ID
  const flags = init[q];
  q++;
  if (flags & 0x80) q += 2;
  if (flags & 0x40) q += 1 + init[q];
  if (flags & 0x20) q += 2;
  const dc = readDescriptor(init, q);
  if (dc.tag !== 0x04) return init;
  const dcConfigEnd = dc.payload + 13; // oti(1)+streamType(1)+buffer(3)+maxBR(4)+avgBR(4)
  if (dcConfigEnd < init.length && init[dcConfigEnd] === 0x05) return init; // already has the config

  const channels = dv.getUint16(mp4a.start + 24) || 2;
  const hz = dv.getUint16(mp4a.start + 32);
  const freqIdx = AAC_FREQS.indexOf(hz) >= 0 ? AAC_FREQS.indexOf(hz) : 4;
  const asc = (2 << 11) | (freqIdx << 7) | (channels << 3); // AAC-LC
  const ascDesc = new Uint8Array([0x05, 0x02, (asc >> 8) & 0xff, asc & 0xff]);

  const out = new Uint8Array(init.length + 4);
  out.set(init.subarray(0, dcConfigEnd), 0);
  out.set(ascDesc, dcConfigEnd);
  out.set(init.subarray(dcConfigEnd), dcConfigEnd + 4);
  // Grow the two descriptor lengths and every container box that holds the esds.
  out[dc.lenLastByte] += 4;
  out[es.lenLastByte] += 4;
  const odv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (const box of chain) odv.setUint32(box.start, odv.getUint32(box.start) + 4);
  return out;
}

/**
 * Rewrite a `moof` so its `tfhd`s use movie-fragment-relative addressing: drop
 * the absolute `base-data-offset` field, set `default-base-is-moof`, and shift
 * each `trun.data_offset` to account for the removed bytes. Returns the moof
 * unchanged if it is already compliant. Assumes the original `base_data_offset`
 * equals the moof's own offset (verified for the target streams).
 */
function transmuxFragment(moof: Uint8Array): Uint8Array {
  // First pass over the unmodified moof: locate the tfhds that use absolute
  // addressing and the truns that carry a data_offset. (Box sizes must not be
  // mutated before this, or re-walking would land misaligned.)
  const src = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
  const tfhds: Box[] = [];
  const trafsToShrink: Box[] = [];
  const trunOffsets: number[] = [];
  for (const traf of walkBoxes(moof, 8, moof.length).filter((b) => b.type === "traf")) {
    const kids = walkBoxes(moof, traf.start + 8, traf.start + traf.size);
    const tfhd = kids.find((b) => b.type === "tfhd");
    const trun = kids.find((b) => b.type === "trun");
    if (tfhd && src.getUint32(tfhd.start + 8) & 0x1) {
      tfhds.push(tfhd);
      trafsToShrink.push(traf);
    }
    if (trun && src.getUint32(trun.start + 8) & 0x1) trunOffsets.push(trun.start);
  }
  if (tfhds.length === 0) return moof; // already MSE-compliant
  const removed = tfhds.length * 8;

  const m = moof.slice();
  const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
  // The moof shrinks by `removed`, so the trailing mdat moves up — shift every
  // moof-relative data_offset to match.
  for (const ts of trunOffsets) dv.setInt32(ts + 16, dv.getInt32(ts + 16) - removed);
  const removeRanges: number[] = [];
  for (let i = 0; i < tfhds.length; i++) {
    const tfhd = tfhds[i];
    const fpos = tfhd.start + 8; // version+flags
    dv.setUint32(fpos, (dv.getUint32(fpos) & ~0x1) | 0x20000); // clear base-data-offset, set default-base-is-moof
    removeRanges.push(tfhd.start + 16); // base_data_offset sits right after track_ID
    dv.setUint32(tfhd.start, dv.getUint32(tfhd.start) - 8); // shrink tfhd
    dv.setUint32(trafsToShrink[i].start, dv.getUint32(trafsToShrink[i].start) - 8); // shrink traf
  }
  dv.setUint32(0, dv.getUint32(0) - removed); // shrink moof
  // Physically drop the base_data_offset byte ranges.
  const out = new Uint8Array(m.length - removed);
  let w = 0;
  let r = 0;
  for (const cut of removeRanges.sort((a, b) => a - b)) {
    out.set(m.subarray(r, cut), w);
    w += cut - r;
    r = cut + 8;
  }
  out.set(m.subarray(r), w);
  return out;
}

/**
 * Derive the exact MediaSource MIME type from the init segment by reading the
 * H.264 parameters out of the `avcC` box (`avc1.PPCCLL`) and detecting an AAC
 * track. Returns null if it can't be parsed or the WebView can't play it.
 */
function mimeFromInit(initBytes: Uint8Array): string | null {
  const p = indexOfAscii(initBytes, "avcC");
  if (p < 0) return null;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const codec = `avc1.${hex(initBytes[p + 5])}${hex(initBytes[p + 6])}${hex(initBytes[p + 7])}`;
  const hasAudio = indexOfAscii(initBytes, "mp4a") >= 0;
  const withAudio = `video/mp4; codecs="${codec},mp4a.40.2"`;
  if (hasAudio && MediaSource.isTypeSupported(withAudio)) return withAudio;
  const videoOnly = `video/mp4; codecs="${codec}"`;
  if (MediaSource.isTypeSupported(videoOnly)) return videoOnly;
  return null;
}

/**
 * Tails a growing fragmented-MP4 file into a MediaSource. Appends the init
 * segment, then starts near the live edge (so a multi-GB stream doesn't replay
 * its whole history) and keeps appending new fragments as they are written.
 * Exposes `window()` (the snapshot the UI renders) and whether it is still `live`.
 */
class LiveStream {
  readonly path: string;
  private readonly onUpdate: () => void;
  private mediaSource = new MediaSource();
  private sourceBuffer?: SourceBuffer;
  private objectUrl = "";
  private offset = 0; // next byte to read from the file
  private queue: ArrayBuffer[] = [];
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0); // bytes not yet forming a complete box
  private pollTimer?: number;
  private stopped = false;
  private finalized = false;
  private lastSize = 0;
  private lastGrowthAt = Date.now();
  /** Seconds of media available (buffered end). Read by the UI each render. */
  available = 0;
  /** True while the file is still being written. */
  live = true;

  constructor(path: string, onUpdate: () => void) {
    this.path = path;
    this.onUpdate = onUpdate;
  }

  async start(): Promise<void> {
    // Find the init segment + a recent fragment boundary to start from.
    const layout = await tauriInvoke<LiveStartLayout>("live_start", {
      path: this.path,
      windowBytes: LIVE_WINDOW_BYTES,
    });
    if (layout.init_end >= layout.size) {
      throw new Error("This file is not a fragmented MP4 — cannot play it live.");
    }
    const initBytes = await this.readRange(0, layout.init_end);
    const mime =
      mimeFromInit(initBytes) ?? LIVE_MIME_CANDIDATES.find((m) => MediaSource.isTypeSupported(m));
    if (!mime) throw new Error("This stream's format is not supported for live playback.");

    this.objectUrl = URL.createObjectURL(this.mediaSource);
    video.src = this.objectUrl;
    await new Promise<void>((resolve) => {
      this.mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
    });
    const sb = this.mediaSource.addSourceBuffer(mime);
    // "sequence" rebases appended fragments onto a 0-based timeline, so starting
    // mid-file (not from byte 0) still yields a clean buffered range from 0.
    sb.mode = "sequence";
    this.sourceBuffer = sb;
    sb.addEventListener("updateend", () => {
      this.refreshAvailable();
      this.pump();
      this.maybeFinalize();
      this.onUpdate();
    });

    // Queue the (possibly patched) init segment, then tail from the windowed start.
    const patchedInit = patchInitSegment(initBytes);
    this.queue.push(patchedInit.slice().buffer as ArrayBuffer);
    this.offset = layout.start;
    this.lastSize = layout.size;
    this.lastGrowthAt = Date.now();
    this.pump();
    void this.poll();
  }

  /** Read the byte range [from, to) from the file, decoding the base64 chunks. */
  private async readRange(from: number, to: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let cur = from;
    while (cur < to && !this.stopped) {
      const b64 = await tauriInvoke<string>("read_stream_chunk", {
        path: this.path,
        offset: cur,
        maxLen: Math.min(LIVE_CHUNK_BYTES, to - cur),
      });
      const bytes = b64ToBytes(b64);
      if (bytes.length === 0) break;
      parts.push(bytes);
      cur += bytes.length;
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

  /**
   * Accumulate freshly-read bytes and extract complete top-level boxes. Each
   * `moof` is transmuxed to be MSE-compliant; everything else is passed through.
   * Partial boxes are held in `pending` until the rest arrives.
   */
  private feed(bytes: Uint8Array): void {
    if (this.pending.length > 0) {
      const merged = new Uint8Array(this.pending.length + bytes.length);
      merged.set(this.pending, 0);
      merged.set(bytes, this.pending.length);
      this.pending = merged;
    } else {
      this.pending = bytes;
    }

    const buf = this.pending;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off = 0;
    while (buf.length - off >= 8) {
      let size = dv.getUint32(off);
      if (size === 1) {
        if (buf.length - off < 16) break;
        size = Number(dv.getBigUint64(off + 8));
      }
      if (size < 8) {
        off = buf.length; // malformed; resync by dropping the rest of this batch
        break;
      }
      if (buf.length - off < size) break; // box not fully arrived yet
      const box = buf.subarray(off, off + size);
      const out = boxType(buf, off) === "moof" ? transmuxFragment(box) : box;
      this.queue.push(out.slice().buffer as ArrayBuffer);
      off += size;
    }
    this.pending = off > 0 ? buf.slice(off) : buf;
    this.pump();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.finalized) return;
    try {
      const status = await tauriInvoke<StreamStatus>("stream_status", { path: this.path });
      if (status.size > this.lastSize) {
        this.lastSize = status.size;
        this.lastGrowthAt = Date.now();
      }
      // Live while a `.live` marker is set or the file is still growing; ended
      // once `.done` or it has been stalled past the grace window.
      if (status.complete) this.live = false;
      else if (status.live) this.live = true;
      else this.live = Date.now() - this.lastGrowthAt < LIVE_STALL_MS;

      // Pull whatever new bytes exist (bounded per poll so we don't hog).
      let reads = 0;
      while (status.size > this.offset && reads < LIVE_READS_PER_POLL && !this.stopped) {
        const b64 = await tauriInvoke<string>("read_stream_chunk", {
          path: this.path,
          offset: this.offset,
          maxLen: LIVE_CHUNK_BYTES,
        });
        const bytes = b64ToBytes(b64);
        if (bytes.length === 0) break;
        this.offset += bytes.length;
        this.feed(bytes);
        reads++;
      }
    } catch {
      /* transient read error (e.g. mid-write); retry next tick */
    }
    this.refreshAvailable();
    this.maybeFinalize();
    this.onUpdate();
    if (!this.stopped && !this.finalized) {
      this.pollTimer = window.setTimeout(() => void this.poll(), LIVE_POLL_MS);
    }
  }

  /** Evict the oldest buffered range / append the next chunk when idle. */
  private pump(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.mediaSource.readyState !== "open") return;

    // Keep the buffered span bounded so long streams don't hit the MSE quota.
    if (sb.buffered.length > 0) {
      const span = sb.buffered.end(sb.buffered.length - 1) - sb.buffered.start(0);
      if (span > LIVE_MAX_BUFFER_SECONDS && video.currentTime > sb.buffered.start(0) + LIVE_EVICT_SECONDS) {
        try {
          sb.remove(sb.buffered.start(0), sb.buffered.start(0) + LIVE_EVICT_SECONDS);
          return; // resume appending after the remove completes (updateend)
        } catch {
          /* fall through to append */
        }
      }
    }

    if (this.queue.length === 0) return;
    const chunk = this.queue.shift()!;
    try {
      sb.appendBuffer(chunk);
    } catch (err) {
      // Out of quota — put the chunk back and evict the oldest data, then retry.
      this.queue.unshift(chunk);
      if (err instanceof Error && err.name === "QuotaExceededError" && sb.buffered.length > 0) {
        try {
          sb.remove(sb.buffered.start(0), sb.buffered.start(0) + LIVE_EVICT_SECONDS);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private refreshAvailable(): void {
    const sb = this.sourceBuffer;
    if (sb && sb.buffered.length > 0) {
      this.available = sb.buffered.end(sb.buffered.length - 1);
    }
  }

  /** Once the stream has ended and everything is appended, end the MediaSource. */
  private maybeFinalize(): void {
    if (this.finalized || this.live) return;
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.queue.length > 0 || this.offset < this.lastSize) return;
    if (this.mediaSource.readyState !== "open") return;
    this.finalized = true;
    window.clearTimeout(this.pollTimer);
    try {
      this.mediaSource.endOfStream();
    } catch {
      /* already ended */
    }
  }

  /** The live-window snapshot the UI renders against. */
  window(): LiveWindow {
    return { available: this.available, delay: LIVE_DELAY_SECONDS, live: this.live };
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.pollTimer);
    if (this.objectUrl) {
      try {
        URL.revokeObjectURL(this.objectUrl);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Tear down any active livestream (when opening another file or a normal one). */
function stopLive(): void {
  if (live) {
    live.stop();
    live = null;
  }
  pendingGoLive = false;
  app.dataset.live = "false";
  btnForward.disabled = false;
  liveBadge.hidden = true;
  btnGoLive.hidden = true;
}

/** The live window if (and only if) a stream is still being written, else null. */
function activeLiveWindow(): LiveWindow | null {
  return live && live.live ? live.window() : null;
}

/** Re-render on every poll/append tick so the LIVE badge + edge stay current. */
function onLiveUpdate(): void {
  // A freshly opened/upgraded live source: once there's more than the delay
  // buffered, snap to the live edge so we start at "now".
  if (pendingGoLive && live && live.live && live.available > LIVE_DELAY_SECONDS) {
    pendingGoLive = false;
    doJumpToLive();
  }
  // Enforce the live delay: while playing, never let the playhead outrun the
  // live edge into the trailing safety buffer (e.g. if writing momentarily
  // stalls). Tracking back and seeking are untouched.
  if (live && live.live && !video.paused) {
    const edge = liveEdge(live.window());
    if (video.currentTime > edge + 0.1) video.currentTime = edge;
  }
  syncFromVideo();
  render();
}

/** Stop the background growth watcher, if any. */
function stopGrowthWatch(): void {
  window.clearTimeout(growthWatch);
  growthWatch = undefined;
}

/**
 * Watch a normally-opened file for growth; if it is being written and is a
 * fragmented MP4 (so MediaSource can tail it), upgrade to live playback. This is
 * how a real recorder's file (no `.live` marker) is recognised as a livestream.
 */
function startGrowthWatch(path: string, baseSize: number): void {
  stopGrowthWatch();
  let last = baseSize;
  let ticks = 0;
  const GROWTH_WATCH_MS = 2000;
  const GROWTH_WATCH_MAX = 8; // give up after ~16s of no growth
  const GROWTH_THRESHOLD = 64 * 1024;
  const tick = async () => {
    ticks++;
    try {
      const s = await tauriInvoke<StreamStatus>("stream_status", { path });
      if (s.complete) return; // finished writing — it's a normal file
      if (s.size > last + GROWTH_THRESHOLD) {
        const layout = await tauriInvoke<LiveStartLayout>("live_start", {
          path,
          windowBytes: LIVE_WINDOW_BYTES,
        });
        if (layout.init_end < layout.size) await upgradeToLive(path); // fragmented -> tail it
        return; // either upgraded, or not fragmented — stop watching
      }
      last = Math.max(last, s.size);
    } catch {
      /* ignore; try again */
    }
    if (ticks < GROWTH_WATCH_MAX) growthWatch = window.setTimeout(() => void tick(), GROWTH_WATCH_MS);
  };
  growthWatch = window.setTimeout(() => void tick(), GROWTH_WATCH_MS);
}

/** Switch a file that turned out to be growing from normal to live playback. */
async function upgradeToLive(path: string): Promise<void> {
  if (live) return;
  await loadLiveFromPath(path, true);
}

/**
 * Jump to the live edge (hotkey L, or clicking the LIVE badge). Preserves the
 * play/pause state — snapping to live while paused leaves a stable frame.
 */
function doJumpToLive(): void {
  const w = activeLiveWindow();
  if (!w) return;
  syncFromVideo();
  const edge = liveEdge(w);
  state = { ...state, currentTime: edge };
  video.currentTime = edge;
  flashMarker("LIVE");
  render();
  showControls();
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
    card.addEventListener("click", () => void loadFromPath(r.path));
    recentCards.appendChild(card);
  }
}

async function loadFromPath(path: string): Promise<void> {
  stopGrowthWatch();
  currentPath = path;
  loadTimestampsFor(path); // seed this video's saved timestamps before it loads
  addRecent(path, basename(path));
  try {
    const status = await tauriInvoke<StreamStatus>("stream_status", { path }).catch(() => null);
    // A `.live` marker means a writer is actively appending — tail it right away.
    if (status && status.live && !status.complete) {
      await loadLiveFromPath(path, false);
      return;
    }
    // Otherwise play normally, but watch in the background: if the file turns out
    // to be growing (a recording in progress), auto-upgrade to live playback.
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    loadSrc(convertFileSrc(path), basename(path), parentDir(path));
    if (status && !status.complete) startGrowthWatch(path, status.size);
  } catch (err) {
    showError(`Could not open the file: ${String(err)}`);
  }
}

/** Load a media file from an already-resolved URL (asset:// or blob:). */
function loadSrc(src: string, title: string, subtitle = ""): void {
  stopLive(); // leaving any previous livestream behind
  // Note: a growth watch may be (re)started by the caller after this returns.
  emptyError.hidden = true;
  video.src = src;
  titleLabel.textContent = title;
  subtitleLabel.textContent = subtitle;
  document.title = `${title} — Playback`;
  app.dataset.state = "playing";
  emptyState.hidden = true;
  stage.hidden = false;
  state = createInitialState();
  applyAudioToVideo();
  video.load();
  void video.play().catch(() => {
    /* autoplay may be blocked; user can press play */
  });
  showControls();
}

/**
 * Open a still-being-written file as a livestream, fed through MediaSource.
 * `autoLive` snaps to the live edge once buffered (used when auto-upgrading a
 * detected-growing file); the marker path passes false to start from the top.
 */
async function loadLiveFromPath(path: string, autoLive = false): Promise<void> {
  stopGrowthWatch();
  stopLive();
  emptyError.hidden = true;
  const title = basename(path);
  titleLabel.textContent = title;
  subtitleLabel.textContent = "Live recording";
  document.title = `${title} — Playback (live)`;
  app.dataset.state = "playing";
  app.dataset.live = "true";
  emptyState.hidden = true;
  stage.hidden = false;
  state = createInitialState();
  applyAudioToVideo();
  try {
    live = new LiveStream(path, onLiveUpdate);
    pendingGoLive = autoLive;
    await live.start();
  } catch (err) {
    stopLive();
    showError(`Could not play the livestream: ${String(err)}`);
    return;
  }
  void video.play().catch(() => {
    /* autoplay may be blocked; user can press play */
  });
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
  btnGoLive.addEventListener("click", doJumpToLive);

  // Keyboard shortcuts overlay (frame 05)
  btnKeys.addEventListener("click", toggleShortcuts);
  btnKeysClose.addEventListener("click", () => setShortcutsOpen(false));
  shortcutsOverlay.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).dataset.close) setShortcutsOpen(false);
  });

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

  video.addEventListener("click", doTogglePlay);

  // Scrubber: live-preview while dragging, commit on release. In live mode the
  // slider maps onto the [0, available] DVR window instead of a fixed duration.
  const sliderSeconds = (): number => {
    const w = activeLiveWindow();
    return w
      ? (Number(seek.value) / 1000) * w.available
      : sliderToTime(Number(seek.value), 1000, state.duration);
  };
  const previewSeek = () => {
    isScrubbing = true;
    const w = activeLiveWindow();
    const t = sliderSeconds();
    const right = w ? "LIVE" : formatTime(state.duration);
    timeLabel.innerHTML = `${formatTime(t)}&nbsp;/&nbsp;${right}`;
    progress.style.width = `${(Number(seek.value) / 1000) * 100}%`;
  };
  const commitSeek = () => {
    doSeekTo(sliderSeconds()); // doSeekTo clamps into the live window when live
    isScrubbing = false;
  };
  seek.addEventListener("input", previewSeek);
  seek.addEventListener("change", commitSeek);

  // LIVE badge → jump to the live edge.
  liveBadge.addEventListener("click", doJumpToLive);

  volume.addEventListener("input", () => doSetVolume(Number(volume.value)));

  // Reflect the media element's own events back into our state + UI.
  video.addEventListener("loadedmetadata", () => {
    syncFromVideo();
    render();
    if (currentPath) setRecentDuration(currentPath, video.duration);
    // Duration is now known — reposition markers against the real timeline.
    renderTimestamps();
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

function wireKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    // Don't hijack typing in inputs.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      // Keystrokes inside a text field are handled locally (the add-timestamp
      // input owns its Enter/Escape); never trigger player shortcuts here.
      return;
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
      case "l":
      case "L":
        if (!stage.hidden) doJumpToLive();
        break;
      case "t":
      case "T":
        if (!stage.hidden) {
          e.preventDefault();
          togglePanel();
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
loadPinChapter();
void registerDragAndDrop();
void loadLaunchFile();
renderTimestamps();
renderRecents();
render();

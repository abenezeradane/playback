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
  formatTime,
  togglePlay,
  fastForward,
  rewind,
  seekTo,
  sliderToTime,
  timeToSlider,
  progressFraction,
  bufferedFraction,
  nextRate,
  setVolume,
  toggleMute,
  effectiveVolume,
  parseTimestamps,
  markerFraction,
  previousTimestamp,
  nextTimestamp,
  activeTimestampIndex,
  type PlayerState,
  type Timestamp,
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
const centerIcon = $<HTMLSpanElement>("center-icon");

const btnOpen = $<HTMLButtonElement>("btn-open");
const btnOpenTop = $<HTMLButtonElement>("btn-open-top");
const btnPlay = $<HTMLButtonElement>("btn-play");
const playGlyph = $<HTMLSpanElement>("play-glyph");
const btnRewind = $<HTMLButtonElement>("btn-rewind");
const btnForward = $<HTMLButtonElement>("btn-forward");
const btnMute = $<HTMLButtonElement>("btn-mute");
const muteGlyph = $<HTMLSpanElement>("mute-glyph");
const btnRate = $<HTMLButtonElement>("btn-rate");
const btnFs = $<HTMLButtonElement>("btn-fs");
const seek = $<HTMLInputElement>("seek");
const volume = $<HTMLInputElement>("volume");
const progress = $<HTMLDivElement>("progress");
const buffered = $<HTMLDivElement>("buffered");
const timeLabel = $<HTMLSpanElement>("time");
const titleLabel = $<HTMLSpanElement>("title-label");

// Timestamps (play-002)
const markersLayer = $<HTMLDivElement>("markers");
const btnTimestamps = $<HTMLButtonElement>("btn-timestamps");
const btnTimestampsClose = $<HTMLButtonElement>("btn-timestamps-close");
const tsPanel = $<HTMLElement>("timestamps-panel");
const tsInput = $<HTMLTextAreaElement>("timestamps-input");
const tsList = $<HTMLUListElement>("timestamps-list");
const tsCount = $<HTMLParagraphElement>("timestamps-count");
const markerFlash = $<HTMLDivElement>("marker-flash");
const markerFlashText = $<HTMLSpanElement>("marker-flash-text");

const PLAY_GLYPH = "▶"; // ▶
const PAUSE_GLYPH = "⏸"; // ⏸
const VOLUME_GLYPH = "🔊"; // 🔊
const MUTE_GLYPH = "🔇"; // 🔇

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
  // Play / pause glyphs
  playGlyph.textContent = state.isPlaying ? PAUSE_GLYPH : PLAY_GLYPH;
  centerIcon.textContent = state.isPlaying ? PLAY_GLYPH : PAUSE_GLYPH;

  // Time + scrubber
  if (!isScrubbing) {
    seek.value = String(timeToSlider(state.currentTime, state.duration, 1000));
  }
  progress.style.width = `${progressFraction(state) * 100}%`;
  timeLabel.innerHTML = `${formatTime(state.currentTime)}&nbsp;/&nbsp;${formatTime(state.duration)}`;

  // Buffered indicator
  if (video.buffered.length > 0 && state.duration > 0) {
    const end = video.buffered.end(video.buffered.length - 1);
    buffered.style.width = `${bufferedFraction(end, state.duration) * 100}%`;
  }

  // Volume + mute
  const audible = effectiveVolume(state);
  volume.value = String(Math.round(audible * 100));
  muteGlyph.textContent = audible === 0 ? MUTE_GLYPH : VOLUME_GLYPH;

  // Rate
  btnRate.textContent = `${state.rate}×`;

  // Active-chapter highlight (cheap; rebuilds nothing).
  updateActiveTimestamp();
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

async function doToggleFullscreen(): Promise<void> {
  try {
    if (!document.fullscreenElement) {
      await stage.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {
    /* fullscreen may be unavailable; ignore */
  }
}

// ---------------------------------------------------------------------------
// Controls auto-hide + center flash
// ---------------------------------------------------------------------------
let hideTimer: number | undefined;
let flashTimer: number | undefined;

function showControls(): void {
  controls.dataset.visible = "true";
  stage.dataset.idle = "false";
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (state.isPlaying) {
      controls.dataset.visible = "false";
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

/** Re-parse the textarea and rebuild the markers + list. */
function refreshTimestamps(): void {
  timestamps = parseTimestamps(tsInput.value);
  renderTimestamps();
}

/** Rebuild the scrubber markers and the panel list from `timestamps`. */
function renderTimestamps(): void {
  markersLayer.replaceChildren();
  tsList.replaceChildren();
  markerEls = [];
  listEls = [];
  activeTsIndex = -1;

  tsCount.textContent =
    timestamps.length === 0
      ? "No timestamps yet."
      : `${timestamps.length} timestamp${timestamps.length === 1 ? "" : "s"}`;

  timestamps.forEach((ts) => {
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

    // Panel list row (also a jump target).
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ts-list__item";
    const time = document.createElement("span");
    time.className = "ts-list__time";
    time.textContent = formatTime(ts.time);
    const title = document.createElement("span");
    title.className = "ts-list__title";
    title.textContent = ts.title;
    item.append(time, title);
    item.addEventListener("click", () => jumpToTimestamp(ts));
    tsList.appendChild(item);
    listEls.push(item);
  });

  updateActiveTimestamp();
}

/** Toggle the `data-active` flag on the marker + row for the current chapter. */
function updateActiveTimestamp(): void {
  if (timestamps.length === 0) return;
  const idx = activeTimestampIndex(timestamps, state.currentTime);
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
    showControls(); // keep the scrubber + markers on screen alongside the panel
    tsInput.focus();
  }
}

function togglePanel(): void {
  setPanelOpen(tsPanel.dataset.open !== "true");
}

// ---------------------------------------------------------------------------
// Loading a file
// ---------------------------------------------------------------------------
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function showError(message: string): void {
  emptyError.textContent = message;
  emptyError.hidden = false;
}

/** Load a media file by absolute filesystem path (via Tauri's asset protocol). */
async function loadFromPath(path: string): Promise<void> {
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const src = convertFileSrc(path);
    loadSrc(src, basename(path));
  } catch (err) {
    showError(`Could not open the file: ${String(err)}`);
  }
}

/** Load a media file from an already-resolved URL (asset:// or blob:). */
function loadSrc(src: string, title: string): void {
  emptyError.hidden = true;
  video.src = src;
  titleLabel.textContent = title;
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
  btnPlay.addEventListener("click", doTogglePlay);
  btnRewind.addEventListener("click", () => doSkip(false));
  btnForward.addEventListener("click", () => doSkip(true));
  btnMute.addEventListener("click", doToggleMute);
  btnRate.addEventListener("click", doCycleRate);
  btnFs.addEventListener("click", () => void doToggleFullscreen());

  // Timestamps panel (play-002)
  btnTimestamps.addEventListener("click", togglePanel);
  btnTimestampsClose.addEventListener("click", () => setPanelOpen(false));
  tsInput.addEventListener("input", refreshTimestamps);

  video.addEventListener("click", doTogglePlay);

  // Scrubber: live-preview while dragging, commit on release.
  const previewSeek = () => {
    isScrubbing = true;
    const t = sliderToTime(Number(seek.value), 1000, state.duration);
    timeLabel.innerHTML = `${formatTime(t)}&nbsp;/&nbsp;${formatTime(state.duration)}`;
    progress.style.width = `${(Number(seek.value) / 1000) * 100}%`;
  };
  const commitSeek = () => {
    const t = sliderToTime(Number(seek.value), 1000, state.duration);
    doSeekTo(t);
    isScrubbing = false;
  };
  seek.addEventListener("input", previewSeek);
  seek.addEventListener("change", commitSeek);

  volume.addEventListener("input", () => doSetVolume(Number(volume.value)));

  // Reflect the media element's own events back into our state + UI.
  video.addEventListener("loadedmetadata", () => {
    syncFromVideo();
    render();
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
    if (state.isPlaying) controls.dataset.visible = "false";
  });
}

function wireKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    // Don't hijack typing in inputs.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      // Esc still works from the textarea (to close the panel); typing is otherwise left alone.
      if (e.key === "Escape") {
        setPanelOpen(false);
        tsInput.blur();
      }
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
      case "t":
      case "T":
        if (!stage.hidden) {
          // Prevent the keystroke from leaking into the textarea we're about to focus.
          e.preventDefault();
          togglePanel();
        }
        break;
      case "Escape":
        setPanelOpen(false);
        break;
      default:
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
void registerDragAndDrop();
void loadLaunchFile();
renderTimestamps();
render();

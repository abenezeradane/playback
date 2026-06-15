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
  SKIP_SECONDS,
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

// Livestream (play-003)
const liveBadge = $<HTMLButtonElement>("live-badge");
const liveEdgeTick = $<HTMLDivElement>("live-edge");

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

// The active livestream controller (play-003), or null for a normal file.
let live: LiveStream | null = null;

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

  const w = activeLiveWindow();
  if (w) {
    renderLive(w);
  } else {
    // Normal file: time + scrubber against a fixed duration.
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

    // Live chrome only applies in live mode.
    if (!liveBadge.hidden) liveBadge.hidden = true;
    if (!liveEdgeTick.hidden) liveEdgeTick.hidden = true;
    if (btnForward.disabled) btnForward.disabled = false;
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
    ? `${formatTime(state.currentTime)}&nbsp;/&nbsp;LIVE`
    : `${formatTime(state.currentTime)}&nbsp;/&nbsp;LIVE&nbsp;(−${behind}s)`;

  // LIVE badge: bright when caught up, dim while behind; click jumps to live.
  liveBadge.hidden = false;
  liveBadge.dataset.caught = String(caught);
  liveBadge.textContent = caught ? "● LIVE" : `● GO LIVE`;

  // Cannot fast-forward past the live edge once caught up.
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

/** Bytes pulled per read, and how often we poll for more. */
const LIVE_CHUNK_BYTES = 512 * 1024;
const LIVE_POLL_MS = 350;

// Candidate MediaSource MIME types, most specific first; the first one the
// WebView reports as supported is used. Our fixture is H.264 High@3.1 + AAC-LC
// (`-c copy` of the sample), but we tolerate a few common profiles.
const LIVE_MIME_CANDIDATES = [
  'video/mp4; codecs="avc1.64001f,mp4a.40.2"', // H.264 High@3.1 + AAC-LC
  'video/mp4; codecs="avc1.4d401f,mp4a.40.2"', // Main@3.1 + AAC-LC
  'video/mp4; codecs="avc1.42e01e,mp4a.40.2"', // Baseline@3.0 + AAC-LC
  'video/mp4; codecs="avc1.640028,mp4a.40.2"', // High@4.0 + AAC-LC
  'video/mp4; codecs="avc1.64001f"', // video-only fallbacks
  'video/mp4; codecs="avc1.42e01e"',
];

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * Normalize an invoke result to an ArrayBuffer. Depending on the platform/IPC
 * transport, a Rust command returning bytes arrives as an ArrayBuffer, a typed
 * array, or (on WebView2) a plain number[] — handle all three.
 */
function toArrayBuffer(raw: unknown): ArrayBuffer {
  if (raw instanceof ArrayBuffer) return raw;
  if (raw instanceof Uint8Array) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  if (ArrayBuffer.isView(raw)) {
    const v = raw as ArrayBufferView;
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(raw)) return new Uint8Array(raw as number[]).buffer;
  return new ArrayBuffer(0);
}

/**
 * Tails a growing file into a MediaSource. Owns the byte cursor, the append
 * queue, and the poll loop; exposes `window()` (the live window snapshot the UI
 * renders) and whether the stream is still `live`.
 */
class LiveStream {
  readonly path: string;
  private readonly onUpdate: () => void;
  private mediaSource = new MediaSource();
  private sourceBuffer?: SourceBuffer;
  private objectUrl = "";
  private offset = 0; // bytes appended so far
  private queue: ArrayBuffer[] = [];
  private pollTimer?: number;
  private stopped = false;
  private finalized = false;
  /** Seconds of media available (buffered end). Read by the UI each render. */
  available = 0;
  /** True while the file is still being written. */
  live = true;

  constructor(path: string, onUpdate: () => void) {
    this.path = path;
    this.onUpdate = onUpdate;
  }

  async start(): Promise<void> {
    const mime = LIVE_MIME_CANDIDATES.find((m) => MediaSource.isTypeSupported(m));
    if (!mime) throw new Error("This stream's format is not supported for live playback.");
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    video.src = this.objectUrl;
    await new Promise<void>((resolve) => {
      this.mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
    });
    const sb = this.mediaSource.addSourceBuffer(mime);
    this.sourceBuffer = sb;
    sb.addEventListener("updateend", () => {
      this.refreshAvailable();
      this.pump();
      this.maybeFinalize();
      this.onUpdate();
    });
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.finalized) return;
    try {
      const status = await tauriInvoke<StreamStatus>("stream_status", { path: this.path });
      this.live = status.live && !status.complete;
      if (status.size > this.offset) {
        const raw = await tauriInvoke<unknown>("read_stream_chunk", {
          path: this.path,
          offset: this.offset,
          maxLen: LIVE_CHUNK_BYTES,
        });
        const buf = toArrayBuffer(raw);
        if (buf.byteLength > 0) {
          this.offset += buf.byteLength;
          this.queue.push(buf);
          this.pump();
        }
      } else if (status.complete && this.offset >= status.size) {
        // Writer is done and every byte has been read — wrap up.
        this.live = false;
        this.maybeFinalize();
      }
    } catch {
      /* transient read error (e.g. mid-write); retry next tick */
    }
    this.refreshAvailable();
    this.onUpdate();
    if (!this.stopped && !this.finalized) {
      this.pollTimer = window.setTimeout(() => void this.poll(), LIVE_POLL_MS);
    }
  }

  /** Append the next queued chunk once the SourceBuffer is idle. */
  private pump(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.queue.length === 0) return;
    if (this.mediaSource.readyState !== "open") return;
    const chunk = this.queue.shift()!;
    try {
      sb.appendBuffer(chunk);
    } catch {
      /* QuotaExceeded or transient parser state — drop this chunk's retry */
    }
  }

  private refreshAvailable(): void {
    const sb = this.sourceBuffer;
    if (sb && sb.buffered.length > 0) {
      this.available = sb.buffered.end(sb.buffered.length - 1);
    }
  }

  /** Once the writer is done and all bytes are appended, end the MediaSource. */
  private maybeFinalize(): void {
    if (this.finalized || this.live) return;
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.queue.length > 0) return;
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
  app.dataset.live = "false";
  btnForward.disabled = false;
  liveBadge.hidden = true;
}

/** The live window if (and only if) a stream is still being written, else null. */
function activeLiveWindow(): LiveWindow | null {
  return live && live.live ? live.window() : null;
}

/** Re-render on every poll/append tick so the LIVE badge + edge stay current. */
function onLiveUpdate(): void {
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

function showError(message: string): void {
  emptyError.textContent = message;
  emptyError.hidden = false;
}

/** Load a media file by absolute filesystem path (via Tauri's asset protocol). */
async function loadFromPath(path: string): Promise<void> {
  try {
    // If a writer is actively appending to this file (signalled by a sibling
    // `.live` marker), tail it as a livestream; otherwise open it normally.
    const status = await tauriInvoke<StreamStatus>("stream_status", { path }).catch(() => null);
    if (status && status.live && !status.complete) {
      await loadLiveFromPath(path);
      return;
    }
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const src = convertFileSrc(path);
    loadSrc(src, basename(path));
  } catch (err) {
    showError(`Could not open the file: ${String(err)}`);
  }
}

/** Load a media file from an already-resolved URL (asset:// or blob:). */
function loadSrc(src: string, title: string): void {
  stopLive(); // leaving any previous livestream behind
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

/** Open a still-being-written file as a livestream, fed through MediaSource. */
async function loadLiveFromPath(path: string): Promise<void> {
  stopLive();
  emptyError.hidden = true;
  const title = basename(path);
  titleLabel.textContent = title;
  document.title = `${title} — Playback (live)`;
  app.dataset.state = "playing";
  app.dataset.live = "true";
  emptyState.hidden = true;
  stage.hidden = false;
  state = createInitialState();
  applyAudioToVideo();
  try {
    live = new LiveStream(path, onLiveUpdate);
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
      case "l":
      case "L":
        if (!stage.hidden) doJumpToLive();
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

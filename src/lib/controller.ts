/**
 * controller.ts — the UI/runtime layer for the Svelte frontend (arch-001).
 *
 * This is the former main.ts logic, ported so it drives the reactive `ui` store
 * (state.svelte.ts) instead of mutating the DOM by id. It still bridges:
 *   1. The reactive UI state (`ui`) the Svelte components render.
 *   2. The native HTMLVideoElement (the real media engine), via `els`.
 *   3. Tauri's native file APIs (open dialog + drag/drop + asset protocol).
 *
 * All non-trivial decisions (clamping a seek, cycling the rate, SMPTE, shuttle,
 * GIF timing) stay delegated to the pure, unit-tested functions in player-core.
 */
import { tick } from "svelte";
import { ui, els, type RecentFile } from "./state.svelte";
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
  parseTimestampLine,
  mergeTimestamps,
  clearTimestamps,
  editTimestamp,
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
  isTransportStreamPath,
  type PlayerState,
  type Timestamp,
  type TimestampStore,
  type Shuttle,
} from "../player-core";

// ---------------------------------------------------------------------------
// File-type routing
// ---------------------------------------------------------------------------
// Natively-decodable containers plus the MPEG-TS family (ts/m2ts/mts). The TS
// containers are listed so the open dialog, drag-drop, and Recent treat them as
// video; they can't play directly (the WebView can't demux TS) so loadFromPath
// remuxes them to a temp .mp4 via the ffmpeg sidecar first (play-016).
const VIDEO_EXTENSIONS = [
  "mp4", "webm", "ogg", "ogv", "mov", "m4v", "mkv", "avi", "ts", "m2ts", "mts",
];
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
// DOM handles (set in init() from the bind:this registry) + module state
// ---------------------------------------------------------------------------
let video!: HTMLVideoElement;
let cutGen!: HTMLVideoElement;
let cutFilmstrip!: HTMLCanvasElement;
let cutWaveform!: HTMLCanvasElement;
let cutTimeline!: HTMLDivElement;
let imgCanvas!: HTMLCanvasElement;
let imgEl!: HTMLImageElement;
let tsAddInput!: HTMLInputElement;

let state: PlayerState = createInitialState();
let isScrubbing = false;

// Parsed timestamps live in `ui.timestamps` (rendered reactively). `currentTimestampKey`
// scopes the saved set per video.
let currentTimestampKey: string | null = null;

// Timeline / cut view (play-004) ----------------------------------------
/** Clip frame rate, measured from playback (requestVideoFrameCallback) or default. */
let detectedFps = DEFAULT_FPS;
/** J/K/L shuttle transport state (pure model in player-core). */
let shuttle: Shuttle = createShuttle();
let shuttleRAF: number | undefined;
let shuttleLast = 0;

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
let imgTotal = 0;
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

/** True when the standard player stage is the visible surface. */
function playerVisible(): boolean {
  return ui.view === "playing";
}

// ---------------------------------------------------------------------------
// Rendering — mirror `state` (+ derived values) into the reactive `ui` store
// ---------------------------------------------------------------------------
function render(): void {
  ui.isPlaying = state.isPlaying;
  ui.duration = state.duration;

  if (!isScrubbing) {
    ui.seekValue = timeToSlider(state.currentTime, state.duration, 1000);
    ui.progressPct = progressFraction(state) * 100;
    ui.curText = formatTime(state.currentTime);
    ui.totText = formatTime(state.duration);
  }

  if (video.buffered.length > 0 && state.duration > 0) {
    const end = video.buffered.end(video.buffered.length - 1);
    ui.bufferedPct = bufferedFraction(end, state.duration) * 100;
  }

  const audible = effectiveVolume(state);
  ui.volumeValue = Math.round(audible * 100);
  ui.muted0 = audible === 0;
  ui.rate = state.rate;

  updateActiveTimestamp();

  if (ui.cutMode) renderCut();
}

// ---------------------------------------------------------------------------
// Command helpers — each mutates state via player-core, then drives the element
// ---------------------------------------------------------------------------
export function doTogglePlay(): void {
  syncFromVideo();
  state = togglePlay(state);
  if (state.isPlaying) {
    void video.play().catch(() => {});
  } else {
    video.pause();
  }
  flashCenter();
  render();
  showControls();
}

export function doSkip(forward: boolean): void {
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
 * seeks to n/10 of the duration, routed through doSeekTo (which clamps).
 */
function doSectionSeek(digit: number): void {
  syncFromVideo();
  doSeekTo(sectionSeekTime(digit, state.duration));
  showControls();
}

export function doToggleMute(): void {
  syncFromVideo();
  state = toggleMute(state);
  applyAudioToVideo();
  render();
}

export function doSetVolume(value0to100: number): void {
  syncFromVideo();
  state = setVolume(state, value0to100 / 100);
  applyAudioToVideo();
  render();
}

export function doCycleRate(): void {
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
 * Drive the native window's fullscreen, NOT the HTML Fullscreen API — the WebView
 * exits HTML fullscreen on Esc itself and that can't be canceled from JS. Requires
 * `core:window:allow-set-fullscreen`.
 */
async function setFullscreen(on: boolean): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(on);
  } catch {
    /* fullscreen may be unavailable; ignore */
  }
}

export async function doToggleFullscreen(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
  } catch {
    /* fullscreen may be unavailable; ignore */
  }
}

// ---------------------------------------------------------------------------
// Picture-in-picture (play-015)
// ---------------------------------------------------------------------------
/** True when this WebView can put the current <video> into picture-in-picture. */
function pipSupported(): boolean {
  return (
    document.pictureInPictureEnabled === true &&
    typeof video.requestPictureInPicture === "function" &&
    !video.disablePictureInPicture
  );
}

/** Toggle picture-in-picture for the main <video> (no-op when unsupported). */
export async function doTogglePip(): Promise<void> {
  if (!ui.pipSupported) return;
  try {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
    } else {
      if (!playerVisible() || video.readyState === 0) return;
      await video.requestPictureInPicture();
    }
  } catch {
    /* user gesture missing / no video track / already transitioning — ignore */
  }
  showControls();
}

export function onEnterPip(): void {
  ui.pipActive = true;
}
export function onLeavePip(): void {
  ui.pipActive = false;
}

// ---------------------------------------------------------------------------
// Controls auto-hide + center flash
// ---------------------------------------------------------------------------
let hideTimer: number | undefined;
let flashTimer: number | undefined;

/** Single source of truth for chrome visibility. */
function setChromeVisible(visible: boolean): void {
  ui.chromeVisible = visible;
}

export function showControls(): void {
  setChromeVisible(true);
  ui.idle = false;
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (state.isPlaying) {
      setChromeVisible(false);
      ui.idle = true;
    }
  }, 2600);
}

function flashCenter(): void {
  ui.centerFlash = true;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    ui.centerFlash = false;
  }, 360);
}

export function onStageMouseMove(): void {
  showControls();
}
export function onStageMouseLeave(): void {
  if (state.isPlaying) setChromeVisible(false);
}

// ---------------------------------------------------------------------------
// Timestamps (play-002)
// ---------------------------------------------------------------------------
let markerFlashTimer: number | undefined;

/** Parse `text` (one timestamp per line), merge valid entries, persist. */
export function addTimestampsFromText(text: string): number {
  const additions = parseTimestamps(text);
  if (additions.length === 0) return 0;
  const before = ui.timestamps.length;
  ui.timestamps = mergeTimestamps(ui.timestamps, additions);
  renderTimestamps();
  persistTimestamps();
  return ui.timestamps.length - before;
}

/** Remove the timestamp at `index`. */
export function removeTimestamp(index: number): void {
  ui.editingTsIndex = -1;
  ui.timestamps = ui.timestamps.filter((_, i) => i !== index);
  renderTimestamps();
  persistTimestamps();
}

/** Remove every timestamp at once (play-008). */
export function clearAllTimestamps(): void {
  ui.editingTsIndex = -1;
  if (ui.timestamps.length === 0) return;
  ui.timestamps = clearTimestamps();
  renderTimestamps();
  persistTimestamps();
}

// --- Inline edit (play-017): change a timestamp's time/title in place ---

/** Begin inline-editing the row at `index` — reveals a pre-filled, focused field. */
export async function startEditTimestamp(index: number): Promise<void> {
  closeAddInput(); // never keep the add field and an edit field open at once
  ui.editingTsIndex = index;
  await tick(); // the field must be mounted (un-hidden) before it can take focus
  const input = els.tsEditInput;
  if (input) {
    input.focus();
    input.select();
  }
}

/**
 * Commit the inline edit at `index` from the field's text. Same `HH:MM:SS Title`
 * grammar as the add input; an unparseable value is discarded (the row reverts).
 * Idempotent: a no-op once this row is no longer the one being edited, so an
 * Enter/Escape that already closed the field makes the follow-up blur inert.
 */
export function commitEditTimestamp(index: number): void {
  if (ui.editingTsIndex !== index) return;
  const parsed = parseTimestampLine(els.tsEditInput?.value ?? "");
  ui.editingTsIndex = -1;
  if (parsed) {
    ui.timestamps = editTimestamp(ui.timestamps, index, parsed);
    renderTimestamps();
    persistTimestamps();
  }
}

/** Abandon the inline edit, leaving the timestamp unchanged. */
export function cancelEditTimestamp(): void {
  ui.editingTsIndex = -1;
}

/** Keydown on the inline edit field: Enter commits, Escape cancels (panel stays open). */
export function onEditKeydown(e: KeyboardEvent, index: number): void {
  if (e.key === "Enter") {
    e.preventDefault();
    commitEditTimestamp(index);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation(); // don't let Esc also close the Chapters panel
    cancelEditTimestamp();
  }
}

// --- Per-video persistence (play-007) ---
const TIMESTAMPS_KEY = "playback:timestamps";

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

/** Replace the in-memory timestamps with the saved set for `source`. */
function loadTimestampsFor(source: string | null): void {
  const key = source ? timestampKey(source) : null;
  if (key === currentTimestampKey) return;
  currentTimestampKey = key;
  ui.editingTsIndex = -1; // a stale row index must not carry across videos
  ui.timestamps = key ? readStoredTimestamps(loadTimestampStore(), key) : [];
  renderTimestamps();
}

/** Persist the current in-memory timestamps under the current video's key. */
function persistTimestamps(): void {
  if (currentTimestampKey === null) return;
  saveTimestampStore(
    writeStoredTimestamps(loadTimestampStore(), currentTimestampKey, ui.timestamps),
  );
}

/** Reveal the single-line add input (focused, empty) for a new entry. */
export async function openAddInput(): Promise<void> {
  ui.addInputOpen = true;
  await tick(); // the field must be un-hidden before it can take focus
  if (tsAddInput) {
    tsAddInput.value = "";
    tsAddInput.focus();
  }
}

/** Hide and clear the add input. */
export function closeAddInput(): void {
  if (tsAddInput) tsAddInput.value = "";
  ui.addInputOpen = false;
}

/** Recompute the active-chapter highlight + the now-playing pill from `state`. */
function renderTimestamps(): void {
  updateActiveTimestamp();
}

function updateActiveTimestamp(): void {
  const idx =
    ui.timestamps.length === 0 ? -1 : activeTimestampIndex(ui.timestamps, state.currentTime);
  updateNowChapter(idx);
  ui.activeTsIndex = idx;
}

// Persisted setting: pin the current-chapter pill to the bottom-left corner.
const PIN_CHAPTER_KEY = "playback:pinChapter";

/** Apply the pin-chapter setting to the pill + toggle, and persist it. */
export function setPinChapter(on: boolean): void {
  ui.pinChapter = on;
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
    ui.nowChapter = null;
    return;
  }
  const ts = ui.timestamps[idx];
  if (!ui.nowChapter || ui.nowChapter.label !== ts.title) {
    ui.nowChapter = { time: formatTime(ts.time), label: ts.title };
  }
}

/** Seek to a timestamp and surface its title briefly. */
export function jumpToTimestamp(ts: Timestamp): void {
  doSeekTo(ts.time);
  flashMarker(ts.title);
  showControls();
}

/** Show the "jumped to chapter" toast for a moment. */
function flashMarker(title: string): void {
  ui.markerFlashText = title;
  ui.markerFlash = true;
  window.clearTimeout(markerFlashTimer);
  markerFlashTimer = window.setTimeout(() => {
    ui.markerFlash = false;
  }, 1100);
}

/** Hotkey A: jump to the closest previous timestamp. */
function doPrevTimestamp(): void {
  if (!playerVisible() || ui.timestamps.length === 0) return;
  syncFromVideo();
  const target = previousTimestamp(ui.timestamps, state.currentTime);
  if (target) jumpToTimestamp(target);
}

/** Hotkey D: jump to the closest upcoming timestamp. */
function doNextTimestamp(): void {
  if (!playerVisible() || ui.timestamps.length === 0) return;
  syncFromVideo();
  const target = nextTimestamp(ui.timestamps, state.currentTime);
  if (target) jumpToTimestamp(target);
}

export function setPanelOpen(open: boolean): void {
  ui.panelOpen = open;
  if (open) {
    showControls();
  } else {
    closeAddInput();
    ui.editingTsIndex = -1; // discard any in-progress inline edit
  }
}

export function togglePanel(): void {
  setPanelOpen(!ui.panelOpen);
}

/** Back button: tear down the current video and return to the home screen. */
export function goHome(): void {
  video.pause();
  setCutMode(false);
  clearCutDeck();
  resetShuttle();
  clearAbLoop();
  applyLoopState();
  setPanelOpen(false);
  setShortcutsOpen(false);
  clearImageView();
  video.removeAttribute("src");
  video.load();
  state = createInitialState();
  loadTimestampsFor(null);
  currentPath = null;
  ui.view = "empty";
  ui.emptyError = "";
  renderRecents();
  document.title = "Playback";
}

// --- Keyboard shortcuts overlay (frame 05) ---
export function setShortcutsOpen(open: boolean): void {
  ui.shortcutsOpen = open;
}

export function toggleShortcuts(): void {
  setShortcutsOpen(!ui.shortcutsOpen);
}

// ---------------------------------------------------------------------------
// Livestream detection (play-003 / play-005)
// ---------------------------------------------------------------------------
interface StreamStatus {
  size: number;
  live: boolean;
  complete: boolean;
  mtime_age_ms: number;
  being_written: boolean;
}

const LIVE_RECENT_MS = 15_000;
const LIVE_GROWTH_SAMPLE_MS = 400;
const LIVE_GROWTH_THRESHOLD = 8 * 1024;
const LIVE_GROWTH_WINDOW_MS = 6_000;

/** Bytes pulled per Rust read_stream_chunk call (used by the cut-view waveform). */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * Authorize the directory of a file the user is opening (sec-002). The native
 * shell scopes every WebView filesystem read to directories opened this way, so
 * this must run before any stream_status / read_stream_chunk / convertFileSrc for
 * the path. `loadFromPath` is the single funnel for every open (dialog, drop,
 * launch arg, Recent), so authorizing here covers them all. Best-effort: when not
 * running under Tauri the invoke just rejects and the (also absent) read commands
 * never run.
 */
async function authorizeMediaDir(path: string): Promise<void> {
  await tauriInvoke("allow_media_dir", { path }).catch(() => {
    /* Not under Tauri, or authorization failed — reads will be rejected. */
  });
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
// ---------------------------------------------------------------------------
const FILMSTRIP_CELLS = 12;
const WAVEFORM_BARS = 240;
const WAVEFORM_MAX_BYTES = 48 * 1024 * 1024;
const CUT_DECK_BUILD_DELAY_MS = 350;

/** Enter/leave the timeline view. No-op to enter when no video is loaded. */
export function setCutMode(on: boolean): void {
  if (on && !playerVisible()) return;
  ui.cutMode = on;
  if (on) {
    setPanelOpen(false);
    setShortcutsOpen(false);
    // The deck media is generated in the background on file open; entering the
    // view just draws whatever is ready so far. Canvases only size once visible,
    // so (re)draw after the DOM reflects cut mode.
    void tick().then(() => {
      drawFilmstrip();
      drawWaveform();
      renderCut();
    });
    showControls();
  } else {
    resetShuttle();
    showControls();
  }
}

export function toggleCutMode(): void {
  setCutMode(!ui.cutMode);
}

/** Path of the clip whose deck is being (or has been) built. */
let cutDeckPath: string | null = null;

/**
 * Start generating the timeline-view deck media in the BACKGROUND on file open.
 * `path` is the decodable media source (for TS files this is the remuxed .mp4, not
 * the original); `displayName` is what the deck app bar shows (the user's filename).
 */
function prepareCutDeck(path: string, displayName: string = basename(path)): void {
  cutDeckPath = path;
  ui.cutTitle = displayName;
  ui.cutMeta = "";
  resetFpsDetection();
  const ftoken = ++filmstripToken;
  const wtoken = ++waveformToken;
  filmFrames = new Array(FILMSTRIP_CELLS).fill(null);
  waveformPeaks = [];
  if (ui.cutMode) {
    drawFilmstrip();
    drawWaveform();
  }
  window.setTimeout(() => {
    if (ftoken !== filmstripToken) return;
    void captureFilmstripFromGenerator(path, ftoken);
    void buildWaveform(path, wtoken);
  }, CUT_DECK_BUILD_DELAY_MS);
}

/** Decode the clip's audio into waveform peaks in the background. */
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
  cutGen.pause();
  cutGen.removeAttribute("src");
  cutGen.load();
  cutGen.classList.remove("cut-gen--active");
  ui.rulerTicks = [];
  const fctx = cutFilmstrip.getContext("2d");
  if (fctx) fctx.clearRect(0, 0, cutFilmstrip.width, cutFilmstrip.height);
  const wctx = cutWaveform.getContext("2d");
  if (wctx) wctx.clearRect(0, 0, cutWaveform.width, cutWaveform.height);
  ui.cutTitle = "";
  ui.cutMeta = "";
}

/** Footage meta line: resolution · fps (both read from the real clip). */
function updateCutMeta(): void {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const parts: string[] = [];
  if (w && h) parts.push(`${w}×${h}`);
  parts.push(formatFps(detectedFps));
  ui.cutMeta = parts.join("  ·  ");
  ui.fpsLabel = `· ${formatFps(detectedFps)}`;
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

function startFpsDetection(): void {
  const rvfc = (video as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback;
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
      if (ui.cutMode) renderCut();
      return;
    }
    if (fpsSamples.length < 300) rvfc.call(video, onFrame);
  };
  rvfc.call(video, onFrame);
}

// --- Filmstrip ------------------------------------------------------------
/** Draw a source covering the box [dx,dy,dw,dh] (center-crop). */
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

/** Composite the captured thumbnails onto the single filmstrip canvas. */
function drawFilmstrip(): void {
  const cv = cutFilmstrip;
  const rect = cv.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (w <= 1 || h <= 1) return;
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
    if (k > 0) {
      ctx.fillStyle = "rgba(7,8,10,0.6)";
      ctx.fillRect(x, 0, 1, h);
    }
  }
}

/** Build the filmstrip by seeking a DEDICATED generator <video> off to the side. */
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
          if (ui.cutMode) drawFilmstrip();
        }
      }
      k++;
      if (k < FILMSTRIP_CELLS) seekNext();
      else finish();
    };

    const onSeeked = (): void => {
      if (stale()) return finish();
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
      safety = window.setTimeout(grab, 2500);
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

/** Decode the real audio track from already-read bytes into waveform peaks. */
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
  if (w <= 1 || h <= 1) return;
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
  if (!Number.isFinite(duration) || duration <= 0) {
    ui.rulerTicks = [];
    return;
  }
  ui.rulerTicks = rulerTicks(duration, 8).map((tick) => ({
    left: markerFraction(tick.time, duration) * 100,
    major: tick.major,
    label: tick.major ? formatTime(tick.time) : "",
  }));
}

// --- Render the deck against the current state ----------------------------
function renderCut(): void {
  const dur = state.duration;
  const cur = state.currentTime;
  ui.smpteCur = formatSmpte(cur, detectedFps);
  ui.smpteTot = formatSmpte(dur, detectedFps);
  const frac = dur > 0 ? clamp(cur / dur, 0, 1) : 0;
  ui.playheadPct = frac * 100;

  ui.isPlaying = state.isPlaying;
  ui.rate = state.rate;
  const audible = effectiveVolume(state);
  ui.volumeValue = Math.round(audible * 100);
  ui.muted0 = audible === 0;
  // The cut-view loop / A-B buttons read ui.loopOn / ui.abA / ui.abB directly.

  const rate = shuttleRate(shuttle);
  ui.shuttleDir = shuttle.direction;
  if (rate === 0 || rate === 1) {
    ui.shuttleBadge = "";
  } else {
    ui.shuttleBadge = `${rate < 0 ? "◀" : "▶"} ${Math.abs(rate)}×`;
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
  const dt = Math.min(0.25, (now - shuttleLast) / 1000);
  shuttleLast = now;
  const next = video.currentTime + rate * dt;
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
    video.playbackRate = Math.min(rate, 16);
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

export function doShuttleForward(): void {
  shuttle = shuttleForward(shuttle);
  applyShuttle();
}

export function doShuttleReverse(): void {
  shuttle = shuttleReverse(shuttle);
  applyShuttle();
}

export function doShuttleStop(): void {
  shuttle = shuttleStop();
  applyShuttle();
}

/** The big center transport button: plain play/pause at the user's speed. */
export function cutPlayPause(): void {
  resetShuttle();
  syncFromVideo();
  if (video.paused || video.ended) void video.play().catch(() => {});
  else video.pause();
  syncFromVideo();
  render();
  showControls();
}

/** Move the playhead to the first / last frame (Home / End, or the buttons). */
export function doJumpStart(): void {
  resetShuttle();
  doSeekTo(0);
  if (ui.cutMode) renderCut();
  showControls();
}

export function doJumpEnd(): void {
  resetShuttle();
  syncFromVideo();
  doSeekTo(lastFrameTime(state.duration, detectedFps));
  if (ui.cutMode) renderCut();
  showControls();
}

// ---------------------------------------------------------------------------
// Loop / repeat (play-011)
// ---------------------------------------------------------------------------
const LOOP_STORAGE_KEY = "playback:loop";

function loadLoopPref(): void {
  try {
    ui.loopOn = localStorage.getItem(LOOP_STORAGE_KEY) === "true";
  } catch {
    ui.loopOn = false;
  }
  applyLoopState();
}

function persistLoopPref(): void {
  try {
    localStorage.setItem(LOOP_STORAGE_KEY, String(ui.loopOn));
  } catch {
    /* storage unavailable — keep the in-memory state */
  }
}

/** Native `video.loop` does whole-clip repeat, but ONLY when no A-B region is active. */
function applyLoopToVideo(): void {
  video.loop = ui.loopOn && !abLoopActive(ui.abA, ui.abB);
}

/** Reflect loop + A-B state onto the scrubber markers (controls read ui directly). */
function applyLoopState(): void {
  applyLoopToVideo();
  renderAbMarkers();
}

export function setLoop(on: boolean): void {
  ui.loopOn = on;
  persistLoopPref();
  applyLoopState();
}

export function toggleLoop(): void {
  setLoop(!ui.loopOn);
}

/** Toggle the A-B in-point (A): set it at the current time, or clear if set. */
export function toggleAbA(): void {
  ui.abA = ui.abA === null ? video.currentTime || 0 : null;
  applyLoopState();
  showControls();
}

/** Toggle the A-B out-point (B): set it at the current time, or clear if set. */
export function toggleAbB(): void {
  ui.abB = ui.abB === null ? video.currentTime || 0 : null;
  applyLoopState();
  showControls();
}

/** Drop the A-B region (used when the clip changes / returning home). */
function clearAbLoop(): void {
  ui.abA = null;
  ui.abB = null;
}

/** Repeat [A,B]: when the playhead reaches B, jump back to A (play-011). */
function maybeAbLoop(): void {
  if (isScrubbing) return;
  const target = abLoopNext(video.currentTime, ui.abA, ui.abB);
  if (target !== null) video.currentTime = target;
}

/** Build the A-B region band + end flags on the scrubber (distinct from chapters). */
function renderAbMarkers(): void {
  const dur = state.duration;
  const out: typeof ui.abMarkers = [];
  if (dur > 0) {
    if (abLoopActive(ui.abA, ui.abB)) {
      const left = markerFraction(ui.abA as number, dur) * 100;
      const right = markerFraction(ui.abB as number, dur) * 100;
      out.push({ kind: "region", left, width: Math.max(0, right - left) });
    }
    if (ui.abA !== null) out.push({ kind: "flag", left: markerFraction(ui.abA, dur) * 100, label: "A" });
    if (ui.abB !== null) out.push({ kind: "flag", left: markerFraction(ui.abB, dur) * 100, label: "B" });
  }
  ui.abMarkers = out;
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
  ui.emptyError = message;
}

// ---------------------------------------------------------------------------
// Recent files (home screen)
// ---------------------------------------------------------------------------
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
export function openRecent(r: RecentFile): void {
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

export function clearRecents(): void {
  saveRecents([]);
  renderRecents();
}

/** Refresh the reactive recents list from storage. */
function renderRecents(): void {
  ui.recents = loadRecents();
}

async function loadFromPath(path: string): Promise<void> {
  currentPath = path;
  addRecent(path, basename(path));
  // sec-002: authorize this file's directory before any native read of it.
  await authorizeMediaDir(path);
  if (isImagePath(path)) {
    loadTimestampsFor(null);
    await openImage(path);
    return;
  }
  loadTimestampsFor(path);
  try {
    const status = await tauriInvoke<StreamStatus>("stream_status", { path }).catch(() => null);
    const detected = status ? await detectLive(path, status) : "normal";
    if (detected !== "normal") {
      openEmptyLivePlayer(path);
      return;
    }
    // MPEG-TS containers can't be demuxed by the WebView's <video>; remux to a
    // temp .mp4 via the ffmpeg sidecar and play that instead (play-016). Every
    // downstream consumer (the player src AND the cut deck) uses the .mp4.
    let playPath = path;
    if (isTransportStreamPath(path)) {
      const remuxed = await remuxTransportStream(path);
      if (remuxed === null) return; // error already surfaced
      playPath = remuxed;
    }
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const src = convertFileSrc(playPath);
    loadSrc(src, basename(path), parentDir(path));
    prepareCutDeck(playPath, basename(path));
  } catch (err) {
    ui.prepping = false;
    showError(`Could not open the file: ${String(err)}`);
  }
}

/**
 * Remux a transport stream to a playable temp .mp4 via the native ffmpeg sidecar,
 * showing a progress overlay. Returns the temp .mp4 path, or null on failure (in
 * which case the error is already surfaced and the home screen is shown).
 */
async function remuxTransportStream(path: string): Promise<string | null> {
  ui.preppingLabel = basename(path);
  ui.prepping = true;
  try {
    const out = await tauriInvoke<string>("remux_ts", { path });
    if (!out) throw new Error("empty output path");
    return out;
  } catch (err) {
    ui.prepping = false;
    ui.view = "empty";
    showError(`Could not open this file: ${String(err)}`);
    return null;
  } finally {
    ui.prepping = false;
  }
}

/** Probe whether `path` is a livestream, up front (before the first frame). */
async function detectLive(
  path: string,
  status: StreamStatus,
): Promise<"live-marker" | "live-lock" | "live-grow" | "normal"> {
  if (status.complete) return "normal";
  if (status.live) return "live-marker";
  if (status.being_written) return "live-lock";
  if (status.mtime_age_ms > LIVE_RECENT_MS) return "normal";
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
  ui.emptyError = "";
  clearImageView();
  video.src = src;
  ui.title = title;
  ui.subtitle = subtitle;
  document.title = `${title} — Playback`;
  ui.view = "playing";
  state = createInitialState();
  applyAudioToVideo();
  resetShuttle();
  clearAbLoop();
  applyLoopState();
  video.load();
  void video.play().catch(() => {
    /* autoplay may be blocked; user can press play */
  });
  showControls();
}

/** A detected livestream opens the "Livestream · Unavailable" screen (frame 04b). */
function openEmptyLivePlayer(path: string): void {
  const title = basename(path);
  const folder = parentDir(path);
  video.pause();
  video.removeAttribute("src");
  video.load();
  setCutMode(false);
  resetShuttle();
  setPanelOpen(false);
  clearImageView();
  ui.emptyError = "";
  ui.liveTitle = title;
  ui.liveMeta = folder ? `Livestream · ${folder}` : "Livestream";
  document.title = `${title} — Playback`;
  ui.view = "live-unavailable";
  state = createInitialState();
}

// ---------------------------------------------------------------------------
// Image / GIF viewer (play-012)
// ---------------------------------------------------------------------------
/** True while the image viewer is the visible surface. */
function imageViewActive(): boolean {
  return ui.view === "image";
}

/** Reset all animation state + release decoded bitmaps (does NOT hide the view). */
function resetGifState(): void {
  imgPlaying = false;
  ui.imgPlaying = false;
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
  imgToken++;
  resetGifState();
  imgEl.removeAttribute("src");
  ui.imgElHidden = true;
  ui.imgCanvasHidden = true;
  // Note: the section visibility follows ui.view; callers move ui.view away.
}

/** Open an animated / still image in the dedicated viewer (play-012). */
async function openImage(path: string): Promise<void> {
  const token = ++imgToken;
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
  ui.imgTitle = title;
  ui.imgMeta = folder || "Image";
  document.title = `${title} — Playback`;

  ui.view = "image";
  ui.emptyError = "";
  ui.imgMode = "loading";
  ui.imgErrorHidden = true;
  ui.imgCanvasHidden = true;
  ui.imgElHidden = true;

  let src: string;
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    src = convertFileSrc(path);
  } catch {
    if (token === imgToken) showImageError();
    return;
  }
  if (token !== imgToken) return;

  const decoded = await tryDecodeAnimation(path, token);
  if (token !== imgToken) return;
  if (!decoded) showNativeImage(src, token);
}

/** Try to frame-decode the image with WebCodecs ImageDecoder. */
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
      if (!result) break;
      if (token !== imgToken) {
        result.image.close();
        for (const f of frames) f.bitmap.close();
        decoder.close();
        return false;
      }
      const frame = result.image;
      const durationS = (frame.duration ?? 0) / 1_000_000;
      const bitmap = await createImageBitmap(frame);
      frame.close();
      frames.push({ bitmap, duration: durationS });
      if (i === 0) {
        ui.imgCanvasHidden = false;
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
    ui.imgRateLabel = "1×";
    ui.imgCanvasHidden = false;
    ui.imgElHidden = true;
    ui.imgErrorHidden = true;
    drawGifFrame(0);

    if (frames.length > 1 && imgTotal > 0) {
      ui.imgMode = "animated";
      startGif();
    } else {
      ui.imgMode = "static";
    }
    updateGifInfo();
    return true;
  } catch {
    return false;
  }
}

/** Native fallback: let the WebView animate + loop the image itself (no transport). */
function showNativeImage(src: string, token: number): void {
  ui.imgCanvasHidden = true;
  ui.imgMode = "native";
  imgEl.onload = () => {
    if (token !== imgToken) return;
    if (imgEl.naturalWidth === 0) {
      showImageError();
      return;
    }
    ui.imgElHidden = false;
    ui.imgErrorHidden = true;
  };
  imgEl.onerror = () => {
    if (token === imgToken) showImageError();
  };
  ui.imgElHidden = false;
  imgEl.src = src;
}

/** Clear, honest error state for a corrupt / unsupported image. */
function showImageError(): void {
  ui.imgMode = "error";
  ui.imgCanvasHidden = true;
  ui.imgElHidden = true;
  imgEl.removeAttribute("src");
  ui.imgErrorHidden = false;
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
  ui.imgPlaying = true;
  imgLast = performance.now();
  if (imgRAF === undefined) imgRAF = requestAnimationFrame(gifTick);
}

function pauseGif(): void {
  imgPlaying = false;
  ui.imgPlaying = false;
  if (imgRAF !== undefined) {
    cancelAnimationFrame(imgRAF);
    imgRAF = undefined;
  }
}

export function toggleGifPlay(): void {
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
export function stepGifFrame(delta: number): void {
  if (imgFrames.length <= 1) return;
  pauseGif();
  imgFrameIndex = stepFrame(imgFrameIndex, delta, imgFrames.length);
  imgClock = frameStartTime(imgDurations, imgFrameIndex);
  drawGifFrame(imgFrameIndex);
  updateGifInfo();
}

/** Cycle the playback rate (the rate button), mirroring the video rate control. */
export function cycleGifRate(): void {
  imgRate = nextRate(imgRate);
  ui.imgRateLabel = `${imgRate}×`;
}

/** Step the playback rate up/down (the +/- hotkeys), clamped at the ends. */
function stepGifRate(dir: number): void {
  imgRate = stepRate(imgRate, dir);
  ui.imgRateLabel = `${imgRate}×`;
}

function updateGifInfo(): void {
  ui.imgFrameInfo =
    imgFrames.length <= 1 ? "Still image" : `Frame ${imgFrameIndex + 1} / ${imgFrames.length}`;
}

/** Image-viewer transport hotkeys; returns true if the key was handled. */
function handleImageKey(e: KeyboardEvent): boolean {
  if (imgFrames.length <= 1) return false;
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
export async function openFileDialog(): Promise<void> {
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
// Element-level event handlers (wired from the component templates)
// ---------------------------------------------------------------------------
// A single click on the video toggles play/pause; a quick double-click toggles
// fullscreen instead. Defer the play/pause by the double-click window so a fast
// second click can cancel it and go fullscreen.
let videoClickTimer: number | null = null;
const DOUBLE_CLICK_MS = 250;
export function onVideoClick(): void {
  if (videoClickTimer !== null) {
    clearTimeout(videoClickTimer);
    videoClickTimer = null;
    void doToggleFullscreen();
    return;
  }
  videoClickTimer = window.setTimeout(() => {
    videoClickTimer = null;
    if (ui.cutMode) cutPlayPause();
    else doTogglePlay();
  }, DOUBLE_CLICK_MS);
}

/** Scrubber: live-preview while dragging, commit on release. */
export function previewSeek(sliderValue: number): void {
  isScrubbing = true;
  const t = sliderToTime(sliderValue, 1000, state.duration);
  ui.seekValue = sliderValue;
  ui.curText = formatTime(t);
  ui.totText = formatTime(state.duration);
  ui.progressPct = (sliderValue / 1000) * 100;
}

export function commitSeek(sliderValue: number): void {
  doSeekTo(sliderToTime(sliderValue, 1000, state.duration));
  isScrubbing = false;
}

// Media element events.
export function onLoadedMetadata(): void {
  syncFromVideo();
  render();
  if (currentPath) setRecentDuration(currentPath, video.duration);
  renderTimestamps();
  renderAbMarkers();
  buildRuler(video.duration);
  updateCutMeta();
  if (ui.cutMode) renderCut();
}
export function onTimeUpdate(): void {
  maybeAbLoop();
  syncFromVideo();
  render();
}
export function onProgress(): void {
  render();
}
export function onPlay(): void {
  syncFromVideo();
  render();
}
export function onPause(): void {
  syncFromVideo();
  render();
}
export function onVolumeChange(): void {
  syncFromVideo();
  render();
}
export function onEnded(): void {
  syncFromVideo();
  render();
  showControls();
}

// Add-timestamp input events.
export function onAddKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter") {
    e.preventDefault();
    addTimestampsFromText(tsAddInput.value);
    tsAddInput.value = "";
  } else if (e.key === "Escape") {
    e.stopPropagation();
    closeAddInput();
  }
}
export function onAddPaste(e: ClipboardEvent): void {
  e.preventDefault();
  const text = e.clipboardData?.getData("text") ?? "";
  addTimestampsFromText(text);
  closeAddInput();
}

// Cut timeline scrub (pointer).
export function cutPointerDown(e: PointerEvent): void {
  cutScrubbing = true;
  resetShuttle();
  try {
    cutTimeline.setPointerCapture(e.pointerId);
  } catch {
    /* capture unsupported — drag still works via the move listener */
  }
  cutSeekFromPointer(e);
}
export function cutPointerMove(e: PointerEvent): void {
  if (cutScrubbing) cutSeekFromPointer(e);
}
export function cutPointerUp(e: PointerEvent): void {
  cutScrubbing = false;
  try {
    cutTimeline.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Global wiring (keyboard, drag-drop, context menu, focus-return) + boot
// ---------------------------------------------------------------------------
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

function wireFocusReturn(): void {
  document.addEventListener("click", (e) => {
    if (e.detail === 0) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !isFocusTextEntry(active)) {
      active.blur();
    }
  });
}

/** Suppress the WebView's native right-click context menu. Text fields keep theirs. */
function disableContextMenu(): void {
  window.addEventListener("contextmenu", (e) => {
    if (isFocusTextEntry(e.target as HTMLElement | null)) return;
    e.preventDefault();
  });
}

function wireKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    if (isFocusTextEntry(e.target as HTMLElement | null)) return;

    if (imageViewActive() && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (handleImageKey(e)) return;
    }

    if (ui.cutMode && playerVisible() && !e.ctrlKey && !e.altKey && !e.metaKey) {
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
        if (playerVisible()) doTogglePlay();
        break;
      case "ArrowRight":
        if (playerVisible()) doSkip(true);
        break;
      case "ArrowLeft":
        if (playerVisible()) doSkip(false);
        break;
      case "ArrowUp":
        e.preventDefault();
        doSetVolume(Math.min(100, ui.volumeValue + 5));
        break;
      case "ArrowDown":
        e.preventDefault();
        doSetVolume(Math.max(0, ui.volumeValue - 5));
        break;
      case "m":
        doToggleMute();
        break;
      case "r":
      case "R":
        if (playerVisible()) toggleLoop();
        break;
      case "i":
      case "I":
        if (playerVisible()) toggleAbA();
        break;
      case "b":
      case "B":
        if (playerVisible()) toggleAbB();
        break;
      case "+":
      case "=":
        if (playerVisible()) doStepRate(1);
        break;
      case "-":
      case "_":
        if (playerVisible()) doStepRate(-1);
        break;
      case "f":
        void doToggleFullscreen();
        break;
      case "p":
      case "P":
        if (playerVisible()) void doTogglePip();
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
        if (playerVisible()) {
          e.preventDefault();
          doJumpStart();
        }
        break;
      case "End":
        if (playerVisible()) {
          e.preventDefault();
          doJumpEnd();
        }
        break;
      case "t":
      case "T":
        if (playerVisible()) {
          e.preventDefault();
          togglePanel();
        }
        break;
      case "c":
      case "C":
        if (playerVisible()) {
          e.preventDefault();
          toggleCutMode();
        }
        break;
      case "?":
        e.preventDefault();
        toggleShortcuts();
        break;
      case "Escape": {
        const hadOverlay = ui.shortcutsOpen || ui.panelOpen;
        setShortcutsOpen(false);
        setPanelOpen(false);
        if (!hadOverlay) void setFullscreen(false);
        break;
      }
      default:
        if (
          e.key.length === 1 &&
          e.key >= "0" &&
          e.key <= "9" &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.metaKey &&
          playerVisible()
        ) {
          e.preventDefault();
          doSectionSeek(Number(e.key));
        }
        break;
    }
  });
}

async function registerDragAndDrop(): Promise<void> {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const webview = getCurrentWebview();
    await webview.onDragDropEvent((event) => {
      const payload = event.payload as { type: string; paths?: string[] };
      if (payload.type === "over" || payload.type === "enter") {
        ui.dragover = true;
      } else if (payload.type === "drop") {
        ui.dragover = false;
        const paths = payload.paths ?? [];
        const mediaPath = paths.find((p) => isMediaPath(p));
        if (mediaPath) void loadFromPath(mediaPath);
      } else {
        ui.dragover = false;
      }
    });
  } catch {
    /* Not running under Tauri — drag/drop disabled. */
  }
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

/** The deck canvases are display-sized — repaint them when the window resizes. */
function wireResize(): void {
  window.addEventListener("resize", () => {
    if (ui.cutMode) {
      drawFilmstrip();
      drawWaveform();
    }
  });
}

/**
 * Boot the runtime once the Svelte tree is mounted (called from App.svelte's
 * onMount, so every bind:this element handle is populated). This is the former
 * main.ts boot block: capture element handles, wire global listeners, restore
 * persisted prefs, and do the first render.
 */
export function init(): void {
  video = els.video!;
  cutGen = els.cutGen!;
  cutFilmstrip = els.cutFilmstrip!;
  cutWaveform = els.cutWaveform!;
  cutTimeline = els.cutTimeline!;
  imgCanvas = els.imgCanvas!;
  imgEl = els.imgEl!;
  tsAddInput = els.tsAddInput!;

  ui.pipSupported = pipSupported();
  // Mirror the OS PiP window's state onto the button (play-015). These events are
  // non-standard, so they're attached imperatively rather than in the template.
  if (ui.pipSupported) {
    video.addEventListener("enterpictureinpicture", onEnterPip);
    video.addEventListener("leavepictureinpicture", onLeavePip);
  }

  wireKeyboard();
  wireFocusReturn();
  disableContextMenu();
  wireResize();
  loadPinChapter();
  loadLoopPref();
  void registerDragAndDrop();
  void loadLaunchFile();
  renderRecents();
  renderTimestamps();
  render();
}

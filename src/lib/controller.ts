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
import { ui, els, type RecentFile, type QueueItem, type GalleryItem } from "./state.svelte";
import { initPerf, mark as perfMark, span as perfSpan, recordIpc } from "./perf";
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
  marginRatiosForBox,
  filmstripCellTime,
  frameStepTarget,
  ZERO_MARGINS,
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
  sortPathsNatural,
  currentIndexOf,
  nextIndex,
  prevIndex,
  parsePlaylistStore,
  serializePlaylistStore,
  createPlaylist,
  addPlaylist,
  removePlaylist,
  renamePlaylist,
  addPlaylistItems,
  removePlaylistItem,
  movePlaylistItem,
  findPlaylist,
  type PlayerState,
  type Timestamp,
  type TimestampStore,
  type Playlist,
  type PlaylistStore,
  type Shuttle,
} from "../player-core";
import { NativeEngine, type EngineSurface } from "./engine-native";

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
// Animated / still image formats (play-012, extended by gallery-001). The
// <video> engine can't decode these, so they route to the dedicated image viewer
// (openImage). `png` covers both APNG (which conventionally uses the .png
// extension) and a static PNG; `webp` covers both animated and still WebP.
// gallery-001 adds the remaining static formats a Chromium WebView can actually
// decode/display: jpg/jpeg (also WebCodecs-decoded, so they get the frame-decoded
// transport like any other still), bmp/avif/ico (native <img> fallback only —
// ImageDecoder doesn't cover them, but the browser renders them fine). TIFF is
// deliberately excluded: `<img>` can't render it at all, so it would only ever
// reach the honest error state.
const IMAGE_EXTENSIONS = ["gif", "webp", "apng", "png", "jpg", "jpeg", "bmp", "avif", "ico"];

/** Lowercased file extension (without the dot), or "" if there is none. */
function extensionOf(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : "";
}
function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.includes(extensionOf(path));
}
export function isVideoPath(path: string): boolean {
  return VIDEO_EXTENSIONS.includes(extensionOf(path));
}
function isMediaPath(path: string): boolean {
  return isImagePath(path) || isVideoPath(path);
}
/** MIME type to hand the WebCodecs ImageDecoder, derived from the extension.
 *  Formats ImageDecoder doesn't cover (bmp/avif/ico) return "" so they skip
 *  straight to the native <img> fallback (tryDecodeAnimation bails on an empty
 *  type) — the WebView still displays them fine, just without frame transport. */
/**
 * Containers that can carry more than one frame (perf-005).
 *
 * Only these justify the whole-file read + `ImageDecoder` path in
 * `tryDecodeAnimation`. `.png` stays in the list because an APNG is legally named
 * `.png` and the app must still animate it; JPEG/BMP/ICO cannot animate at all,
 * and AVIF sequences are not decoded here (a still AVIF renders fine via <img>).
 */
const ANIMATABLE_IMAGE_EXTENSIONS = ["gif", "webp", "apng", "png"];

/** True when `path`'s container can hold an animation worth decoding frame-wise. */
function isAnimatableImagePath(path: string): boolean {
  return ANIMATABLE_IMAGE_EXTENSIONS.includes(extensionOf(path));
}

function imageMimeType(path: string): string {
  switch (extensionOf(path)) {
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "apng":
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "avif":
      return "image/avif";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// DOM handles (set in init() from the bind:this registry) + module state
// ---------------------------------------------------------------------------
/**
 * The ACTIVE playback engine (native-001): either the real `<video>` element
 * (web engine) or the NativeEngine adapter (embedded libmpv), which impersonates
 * the exact member subset this controller touches. Every command helper drives
 * whichever engine loaded the current file; element-only features (PiP, rVFC)
 * use `els.video` directly and are gated off under native.
 */
let video!: EngineSurface;
/** The libmpv adapter, constructed once the native engine is first needed. */
let nativeEngine: NativeEngine | null = null;
/** Resolves once the persisted engine preference has been read (init()). */
let enginePrefReady: Promise<void> = Promise.resolve();
/** F9/Shift+F9 screenshot hotkeys — live only when the Rust test hooks are. */
let shotHotkeysEnabled = false;
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
// Deferred cut-deck build (perf-003): the deck media (filmstrip scan + waveform)
// is only built when the user actually enters the cut view, not eagerly on open.
let cutDeckPath: string | null = null;
let cutDeckBuilt = false;
let cutDeckBuildTimer: number | undefined;

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
/**
 * True when this WebView can put the current <video> into picture-in-picture.
 * PiP is a browser feature of the ELEMENT — under the native engine the pixels
 * never touch the WebView, so it is unavailable (the button hides via the
 * existing ui.pipSupported gate; native-003 tracks any future story).
 */
function pipSupported(): boolean {
  const el = els.video;
  return (
    ui.engineActive !== "native" &&
    document.pictureInPictureEnabled === true &&
    !!el &&
    typeof el.requestPictureInPicture === "function" &&
    !el.disablePictureInPicture
  );
}

/** Toggle picture-in-picture for the main <video> (no-op when unsupported). */
export async function doTogglePip(): Promise<void> {
  if (!ui.pipSupported || ui.engineActive === "native") return;
  const el = els.video!;
  try {
    if (document.pictureInPictureElement === el) {
      await document.exitPictureInPicture();
    } else {
      if (!playerVisible() || el.readyState === 0) return;
      await el.requestPictureInPicture();
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
  // The overflow menu lives inside the control bar, so it must not linger open
  // (and invisibly capturing clicks) once the chrome auto-hides (ui-005).
  if (!visible) ui.moreOpen = false;
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

// ---------------------------------------------------------------------------
// Hardware acceleration (play-010)
//
// The real source of truth is a NATIVE preference file (it has to be — the GPU
// launch flag is decided in Rust before the WebView exists). localStorage is a
// display mirror so the toggle renders even before the async native read returns.
// Flipping the toggle persists both and shows a "restart to apply" hint, because
// the WebView2 launch flag only changes on the next launch.
// ---------------------------------------------------------------------------
const HWACCEL_KEY = "playback:hwaccel";

/** Restore the hardware-acceleration setting on startup (native truth first). */
async function loadHwaccel(): Promise<void> {
  // Optimistic mirror first so the toggle isn't briefly wrong before the await.
  try {
    ui.hwaccel = localStorage.getItem(HWACCEL_KEY) !== "off";
  } catch {
    ui.hwaccel = true;
  }
  // The native file is authoritative (it drives the launch flag); reconcile to it.
  try {
    const enabled = await tauriInvoke<boolean>("get_hwaccel", {});
    ui.hwaccel = enabled;
    try {
      localStorage.setItem(HWACCEL_KEY, enabled ? "on" : "off");
    } catch {
      /* storage unavailable — keep the in-memory state */
    }
  } catch {
    /* Not running under Tauri — keep the localStorage mirror. */
  }
}

/** Set the hardware-acceleration preference. */
export function setHwaccel(enabled: boolean): void {
  ui.hwaccel = enabled;
  // Under the NATIVE engine (the default since native-003) hardware decode is
  // an mpv property applied right now — an existing core via player_set_hwdec
  // (best-effort no-op with no core), a future core from the pref file at
  // create. Only the WEB engine's WebView2 launch flag is fixed at process
  // start, so the restart hint shows when web playback is what the flip
  // affects: the next file open will use the web engine (explicit web pref,
  // or libmpv unavailable), or something is playing through the web element
  // RIGHT NOW (a web-pref file, or a URL/stream — those bypass the engine
  // choice entirely). engineActive alone can't gate this: it starts as "web"
  // before anything plays and goes stale after Back-to-home, which is how the
  // old `engineActive !== "native"` term wrongly suppressed the hint after
  // switching the pref to web mid-native-file (review finding).
  const nativeNext = ui.enginePref === "native" && ui.engineAvailable;
  const webPlayingNow = ui.view === "playing" && ui.engineActive === "web";
  ui.hwaccelRestartHint = !nativeNext || webPlayingNow;
  nativeEngine?.setHwdec(enabled);
  try {
    localStorage.setItem(HWACCEL_KEY, enabled ? "on" : "off");
  } catch {
    /* storage unavailable — the native write below is what actually matters */
  }
  // Persist natively so the next launch reads it before the WebView is created.
  void tauriInvoke("set_hwaccel", { enabled }).catch(() => {
    /* Not under Tauri — the toggle is inert outside the desktop shell. */
  });
}

// ---------------------------------------------------------------------------
// Playback-engine choice (native-001; default flipped in native-003)
//
// "native" (default) = the embedded-libmpv engine: raw-path loads with NO remux
// (the fMP4/TS instant-open win), video rendered by mpv's child window UNDER
// the transparent WebView. "web" = the original <video> path, remuxes and all —
// the compatibility fallback (PiP needs it; a missing libmpv-2.dll degrades to
// it automatically via engineForLoad's nativeEngine check).
// The pref is a native file next to `hwaccel` (smokes preseed it before launch);
// it applies per-load, so switching takes effect on the next opened file.
// ---------------------------------------------------------------------------

/** Read the persisted engine pref + wire test hooks; runs once from init(). */
async function initEngineChoice(): Promise<void> {
  try {
    const pref = await tauriInvoke<string>("get_engine_pref", {});
    ui.enginePref = pref === "native" ? "native" : "web";
  } catch {
    ui.enginePref = "web"; // not under Tauri — the web element is all there is
  }
  if (ui.enginePref === "native" && !(await ensureNativeEngine())) {
    // libmpv missing/broken under the native DEFAULT: reflect reality in the
    // UI (unchecked toggle + the unavailable hint) exactly like setEngine's
    // failure path — but ONLY in memory. The pref file stays untouched, so a
    // repaired DLL restores the native default on the next launch.
    ui.enginePref = "web";
  }
  try {
    const flags = await tauriInvoke<{ shotEnabled: boolean }>("test_flags", {});
    shotHotkeysEnabled = flags.shotEnabled === true;
  } catch {
    /* not under Tauri */
  }
}

/** Construct + wire the libmpv adapter once; false when the DLL is missing. */
async function ensureNativeEngine(): Promise<boolean> {
  if (nativeEngine) return true;
  try {
    const status = await tauriInvoke<{ available: boolean }>("player_engine_status", {});
    if (!status.available) {
      ui.engineAvailable = false;
      return false;
    }
    const engine = new NativeEngine({
      onLoadedMetadata: onNativeLoadedMetadata,
      onTimeUpdate,
      onPlay,
      onPause,
      onEnded,
      onEngineError: onNativeEngineError,
      onPresented: onNativePresented,
    });
    await engine.init();
    nativeEngine = engine;
    ui.engineAvailable = true;
    return true;
  } catch {
    ui.engineAvailable = false;
    return false;
  }
}

/** Which engine the NEXT load should use (await the pref read first). */
async function engineForLoad(): Promise<"native" | "web"> {
  await enginePrefReady;
  return ui.enginePref === "native" && nativeEngine ? "native" : "web";
}

/** The Settings "Playback engine" toggle. Applies to the next opened file. */
export async function setEngine(pref: "native" | "web"): Promise<void> {
  if (pref === "native" && !(await ensureNativeEngine())) {
    ui.enginePref = "web"; // DLL missing — stay on web; the row shows the hint
    return;
  }
  ui.enginePref = pref;
  ui.engineHint = true;
  void tauriInvoke("set_engine_pref", { engine: pref }).catch(() => {
    /* not under Tauri */
  });
}

/**
 * Open/close the transparent "hole" the native video shows through. DIRECT
 * setAttribute — a Svelte-bound attribute rides the rAF-gated render flush,
 * which stalls when the window isn't foreground (the ui-005 lesson), and this
 * flag is exactly what unfocused smoke runs assert.
 */
function syncVideoHole(on: boolean): void {
  document.getElementById("app")?.setAttribute("data-native-video", on ? "true" : "false");
}

/** First presented frame of the current native load — open the hole now (never
 *  earlier, so the desktop can't flash through between load and first frame). */
function onNativePresented(): void {
  perfMark("open.firstframe"); // perf-004: end of the user-visible open latency
  if (ui.engineActive === "native" && ui.view === "playing") {
    syncVideoHole(true);
    // The surface div only has a layout box once the hole is open, so this is
    // the first moment a load-while-in-cut-view can measure the letterbox
    // (syncCutMargins self-skips while the box is collapsed).
    syncCutMargins();
  }
}

/** Native metadata: the demuxer knows the exact container fps — no rVFC
 *  sampling needed (the web path's startFpsDetection self-disables on the
 *  adapter, which has no requestVideoFrameCallback). */
function onNativeLoadedMetadata(): void {
  const fps = nativeEngine?.containerFps;
  if (fps) {
    detectedFps = snapFps(fps);
    updateCutMeta();
  }
  onLoadedMetadata();
  // A load that lands while the timeline view is already open (auto-advance /
  // Next while reviewing) must letterbox into the deck immediately — the
  // adapter re-pushes its margin mirror after every load, but a first-ever
  // native load in cut mode has never had the box measured (native-002).
  syncCutMargins();
}

/** Native load/playback failure — same surface as a remux failure. */
function onNativeEngineError(message: string): void {
  ui.prepping = false;
  syncVideoHole(false);
  ui.view = "empty";
  showError(`Could not play this file: ${message}`);
}

export function setSettingsOpen(open: boolean): void {
  ui.settingsOpen = open;
  if (!open) {
    ui.hwaccelRestartHint = false;
    ui.engineHint = false;
  }
}

export function toggleSettings(): void {
  setSettingsOpen(!ui.settingsOpen);
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
  perfMark("nav.panel", open ? "on" : "off"); // perf-004
  ui.panelOpen = open;
  if (open) {
    ui.queueOpen = false; // the two right-side panels share a slot
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
  const endClose = perfSpan("close.total"); // perf-004: synchronous teardown cost
  syncVideoHole(false); // close the native hole before the view swaps
  video.pause();
  setCutMode(false);
  clearCutDeck();
  resetShuttle();
  clearAbLoop();
  applyLoopState();
  setPanelOpen(false);
  setShortcutsOpen(false);
  setMoreOpen(false);
  clearImageView();
  clearQueue();
  video.removeAttribute("src");
  video.load();
  state = createInitialState();
  loadTimestampsFor(null);
  currentPath = null;
  ui.view = "empty";
  ui.emptyError = "";
  ui.galleryItems = [];
  ui.galleryFolder = "";
  ui.galleryError = "";
  ui.galleryLoading = false;
  renderRecents();
  document.title = "Playback";
  endClose();
}

// --- Keyboard shortcuts overlay (frame 05) ---
export function setShortcutsOpen(open: boolean): void {
  ui.shortcutsOpen = open;
}

export function toggleShortcuts(): void {
  setShortcutsOpen(!ui.shortcutsOpen);
}

// --- Control-bar overflow "⋯ More" menu (ui-005) ---
export function setMoreOpen(open: boolean): void {
  ui.moreOpen = open;
  if (open) showControls();
}

export function toggleMore(): void {
  setMoreOpen(!ui.moreOpen);
}

// Progressive overflow: collapse a one-row flex control bar to the SMALLEST level
// whose layout fits, so it shows as many controls as fit and never wraps. The same
// engine drives BOTH the standard player bar (#controls) and the timeline-view
// transport (.cut__transport) — each lays out three flex groups on a non-wrapping
// row, and `data-collapse` (0/1/2) is the CSS hook for what each level hides.
let measureScheduled = false;
let measuring = false;

export function requestControlsMeasure(): void {
  if (measureScheduled) return;
  measureScheduled = true;
  // A microtask (not requestAnimationFrame): rAF is throttled/paused while the
  // window is occluded or not foreground, which would leave the bar stale; a
  // microtask always runs, and layout is already current after a resize/render.
  queueMicrotask(() => {
    measureScheduled = false;
    measureControlsOverflow();
  });
}

/**
 * Fit one non-wrapping flex bar: try collapse levels 0..maxLevel and KEEP the
 * smallest whose groups (the row's children) + the inter-group gaps fit the row
 * width. The groups never shrink (flex:0 0 auto), so each offsetWidth is the true
 * content width at the level being tried (the level CSS hides the collapsed
 * controls). The decision is written DIRECTLY to the DOM (`scope`'s data-collapse)
 * rather than via a Svelte binding, whose render flush is async and lags while the
 * window is not foreground — a direct write is synchronous and never overwritten.
 * Returns the chosen level. `maxLevel` is the floor (assumed to fit at the 640px
 * minimum window).
 */
function fitBar(scope: HTMLElement, row: HTMLElement, maxLevel: number): number {
  const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
  const groups = Array.from(row.children) as HTMLElement[];
  let level = maxLevel;
  for (let l = 0; l < maxLevel; l++) {
    scope.setAttribute("data-collapse", String(l));
    let needed = gap * Math.max(0, groups.length - 1);
    for (const g of groups) needed += g.offsetWidth;
    if (needed - row.clientWidth <= 1) {
      level = l;
      break;
    }
  }
  scope.setAttribute("data-collapse", String(level));
  return level;
}

function measureControlsOverflow(): void {
  if (measuring) return;
  if (ui.view !== "playing") return;
  measuring = true;

  // Standard player bar (hidden in cut mode -> getClientRects() empty -> skipped).
  const controls = document.getElementById("controls");
  const row = controls?.querySelector<HTMLElement>(".controls__row");
  if (controls && row && controls.getClientRects().length > 0) {
    const level = fitBar(controls, row, 2);
    ui.controlsOverflow = level > 0;
    if (level === 0) ui.moreOpen = false;
  }

  // Timeline-view transport (hidden outside cut mode -> getClientRects() empty).
  const cut = document.querySelector<HTMLElement>(".cut__transport");
  if (cut && cut.getClientRects().length > 0) {
    const level = fitBar(cut, cut, 2);
    if (level === 0) ui.moreOpen = false;
  }

  measuring = false;
}

function wireControlsOverflow(): void {
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => requestControlsMeasure());
    const controls = document.getElementById("controls");
    if (controls) ro.observe(controls);
    const cut = document.getElementById("cut");
    if (cut) ro.observe(cut);
  }
  window.addEventListener("resize", () => requestControlsMeasure());
  // Re-measure once webfonts land: a font swap changes the button/label text
  // widths but not the bar's box, so the ResizeObserver alone would miss it.
  document.fonts?.ready.then(() => requestControlsMeasure());
  requestControlsMeasure();
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

// ISO-BMFF (MP4-family) containers whose *fragmented* variant the WebView can't
// start playing (play-020): a finished Twitch/OBS/Streamlink recording is a
// fragmented MP4 that declares no duration in its `moov`, and Chromium's progressive
// <video> demuxer responds by scanning EVERY fragment to end-of-file before it
// reports metadata — so a multi-GB recording opens but never starts (VLC/mpv, which
// use the tail `mfra` index, play it fine). We detect those natively
// (`is_fragmented_mp4`) and remux to a plain faststart .mp4 first — but only above
// MIN_FRAGMENTED_REMUX_BYTES: a small fragmented file scans fast enough to play
// directly, so it skips the (cached) remux and its temp copy.
const ISO_BMFF_EXTENSIONS = ["mp4", "m4v", "mov"];
const MIN_FRAGMENTED_REMUX_BYTES = 256 * 1024 * 1024; // 256 MiB

function isIsoBmffPath(path: string): boolean {
  return ISO_BMFF_EXTENSIONS.includes(extensionOf(path));
}

/** Bytes pulled per Rust read_stream_chunk call (used by the image-viewer animated
 * decode via readWholeFile; the cut-view waveform now reads peaks natively — perf-002). */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  // perf-004: every command is timed at this single funnel, so a slow open can be
  // attributed to a named native command instead of guessed at. Inert unless the
  // native sink is enabled (see perf.ts).
  const started = performance.now();
  try {
    const out = await invoke<T>(cmd, args);
    recordIpc(cmd, performance.now() - started, false);
    return out;
  } catch (err) {
    recordIpc(cmd, performance.now() - started, true);
    throw err;
  }
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
const CUT_DECK_BUILD_DELAY_MS = 350;

/** Enter/leave the timeline view. No-op to enter when no video is loaded. */
export function setCutMode(on: boolean): void {
  if (on && !playerVisible()) return;
  perfMark("nav.cutMode", on ? "on" : "off"); // perf-004
  ui.cutMode = on;
  if (on) {
    setPanelOpen(false);
    setQueueOpen(false);
    setShortcutsOpen(false);
    setMoreOpen(false);
    // Build the deck media the FIRST time the user actually enters the cut view
    // (perf-003): opens that never reach it pay nothing. Guarded so toggling the
    // view on/off never re-scans. Then draw whatever is ready so far — canvases
    // only size once visible, so (re)draw after the DOM reflects cut mode; the
    // native letterbox margins are measured then too, for the same reason.
    buildCutDeck();
    void tick().then(() => {
      drawFilmstrip();
      drawWaveform();
      renderCut();
      syncCutMargins();
    });
    showControls();
  } else {
    resetShuttle();
    // Restore the full-window native video (no-op under the web engine).
    nativeEngine?.setVideoMarginRatio(ZERO_MARGINS);
    showControls();
  }
}

/**
 * Letterbox the natively-rendered video into the cut view's viewer box
 * (native-002). The web engine reframes the <video> element with pure CSS;
 * mpv's child HWND fills the whole window, so the same box is described to it
 * as window-fraction margins (video-margin-ratio). The box is measured from
 * the #video-surface div — the element the cut-mode CSS already lays out — so
 * CSS stays the single owner of the geometry. Called after the DOM reflects
 * cut mode and again on every window resize while the deck is open; leaving
 * the cut view resets to ZERO_MARGINS (setCutMode).
 */
function syncCutMargins(): void {
  if (!ui.cutMode || ui.engineActive !== "native" || !nativeEngine) return;
  const surface = document.getElementById("video-surface");
  if (!surface) return;
  const rect = surface.getBoundingClientRect();
  // The surface is display:none while the video hole is closed (every load
  // closes it until the first presented frame), so a load that lands while
  // the timeline view is open would measure a COLLAPSED box here — pushing
  // zeros and wiping the letterbox (review finding). Keep the previous
  // margins instead; onNativePresented re-measures the moment the hole opens.
  if (rect.width <= 0 || rect.height <= 0) return;
  nativeEngine.setVideoMarginRatio(
    marginRatiosForBox(
      { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      window.innerWidth,
      window.innerHeight,
    ),
  );
}

export function toggleCutMode(): void {
  setCutMode(!ui.cutMode);
}

/**
 * Register the timeline-view deck source on file open — but DON'T build it yet
 * (perf-003). Building the deck means a 12-step serial seek-and-capture scan on a
 * hidden generator <video> (the filmstrip) plus a native ffmpeg pass (the
 * waveform) — eager, per-open work that most opens never need, because most opens
 * never enter the cut view. So both builds are deferred to the first
 * `setCutMode(true)` for this clip (see `buildCutDeck`). If the user is ALREADY in
 * the cut view (e.g. auto-advance / Next while reviewing), build right away so the
 * deck repopulates for the new clip.
 *
 * `path` is the decodable media source (for TS files this is the remuxed .mp4, not
 * the original); `displayName` is what the deck app bar shows (the user's filename).
 */
function prepareCutDeck(path: string, displayName: string = basename(path)): void {
  window.clearTimeout(cutDeckBuildTimer);
  cutDeckPath = path;
  cutDeckBuilt = false;
  ui.cutTitle = displayName;
  ui.cutMeta = "";
  resetFpsDetection();
  // Invalidate any in-flight build from a previous clip and reset the deck media.
  filmstripToken++;
  waveformToken++;
  filmFrames = new Array(FILMSTRIP_CELLS).fill(null);
  waveformPeaks = [];
  if (ui.cutMode) {
    drawFilmstrip();
    drawWaveform();
    buildCutDeck();
  }
}

/**
 * Kick off the deferred deck build (perf-003): the background filmstrip scan + the
 * native waveform. Guarded by `cutDeckBuilt` so it runs at most once per clip —
 * toggling the cut view on/off for the same clip never re-scans. No-op until a clip
 * has been registered via `prepareCutDeck`.
 */
function buildCutDeck(): void {
  if (cutDeckBuilt || cutDeckPath === null) return;
  cutDeckBuilt = true;
  const path = cutDeckPath;
  const ftoken = ++filmstripToken;
  const wtoken = ++waveformToken;
  window.clearTimeout(cutDeckBuildTimer);
  cutDeckBuildTimer = window.setTimeout(() => {
    if (ftoken !== filmstripToken) return;
    // The filmstrip generator is a second <video> decode pipeline — it can't
    // decode what the WebView can't (unremuxed fMP4/TS, exactly what the
    // native engine plays), so under native the thumbnails are extracted
    // natively instead: one bounded ffmpeg-sidecar still per cell
    // (native-002). The waveform is already native and works for both.
    if (ui.engineActive === "native") {
      void captureFilmstripNative(path, ftoken);
    } else {
      void captureFilmstripFromGenerator(path, ftoken);
    }
    void buildWaveform(path, wtoken);
  }, CUT_DECK_BUILD_DELAY_MS);
}

/**
 * Build the clip's waveform peaks in the background (perf-002).
 *
 * The heavy work — decoding the whole audio track — now happens NATIVELY in the
 * ffmpeg sidecar (`compute_waveform_peaks`), which returns ONLY the WAVEFORM_BARS
 * downsampled peaks. So the WebView no longer reads the whole file over
 * `read_stream_chunk`, base64-decodes it, copies it twice, or runs `decodeAudioData`
 * over the entire clip — opening a file no longer costs O(file size) CPU + memory.
 * The 48 MiB size cap is gone too: a large clip that used to fall back to the
 * synthesized waveform now shows a real one. If the native call fails (no audio,
 * undecodable, or not under Tauri) we keep the synthesized placeholder.
 */
async function buildWaveform(path: string, token: number): Promise<void> {
  const peaks = await tauriInvoke<number[]>("compute_waveform_peaks", {
    path,
    bars: WAVEFORM_BARS,
  }).catch(() => null);
  if (token !== waveformToken) return;
  waveformPeaks =
    peaks && peaks.length > 0 && peaks.some((p) => p > 0)
      ? peaks
      : synthPeaks(path, WAVEFORM_BARS);
  drawWaveform();
}

/** Clear the deck when returning home / before a new clip. */
function clearCutDeck(): void {
  window.clearTimeout(cutDeckBuildTimer);
  cutDeckPath = null;
  cutDeckBuilt = false;
  filmstripToken++;
  waveformToken++;
  waveformPeaks = [];
  filmFrames = [];
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
    const targetTime = (): number => filmstripCellTime(k, FILMSTRIP_CELLS, genDur);

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
      // Grab as soon as the seeked frame is PRESENTED and its mediaTime matches the
      // target; if the first presented frame is still the stale pre-seek one, fall
      // back to an 80 ms settle (the proven play-004 path). Relaxing this settle was
      // evaluated for perf-003 and rejected: on a PAUSED generator the seeked frame
      // typically fires rVFC only once, so waiting for a further matching present
      // stalls to the 2.5 s per-seek safety and leaves the strip half-built — the
      // existing match fast-path already grabs immediately, so there is no latency to
      // cut on the common path. Tolerance unchanged ⇒ no duplicate/stale captures.
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

/**
 * Build the filmstrip NATIVELY (native-002): one ffmpeg-sidecar still per cell,
 * sampled at the same cell midpoints as the generator scan. The native engine
 * plays its media UNREMUXED — fragmented MP4s and MPEG-TS the generator
 * <video> cannot decode — so the extraction must not depend on a second
 * WebView decode pipeline. Cells are fetched serially (one bounded ffmpeg
 * process at a time, mirroring the generator's serial seeks) and the strip
 * repaints as each thumbnail lands; a failed cell (e.g. a time past the real
 * EOF of a still-growing estimate) keeps its dark placeholder slot.
 */
async function captureFilmstripNative(path: string, token: number): Promise<void> {
  // The deck build timer can fire before the engine reports the new clip's
  // duration (a multi-GB fragmented MP4 on a slow disk is exactly the native
  // engine's headline case) — and cutDeckBuilt has already latched, so bailing
  // here would leave the strip dark for the whole clip (review finding). Wait
  // for the duration like the web generator waits for its own loadedmetadata,
  // bounded at 10 s (the generator's safety is 8 s).
  let duration = 0;
  for (let waited = 0; waited < 10_000; waited += 250) {
    if (token !== filmstripToken) return;
    syncFromVideo();
    duration = state.duration;
    if (Number.isFinite(duration) && duration > 0) break;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  if (token !== filmstripToken) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  for (let k = 0; k < FILMSTRIP_CELLS; k++) {
    if (token !== filmstripToken) return;
    const b64 = await tauriInvoke<string>("extract_video_still", {
      path,
      time: filmstripCellTime(k, FILMSTRIP_CELLS, duration),
      width: 160,
      height: 90,
    }).catch(() => null);
    if (token !== filmstripToken) return;
    if (!b64) continue;
    // Decode the PNG bytes directly (the play-012 image-viewer pattern) — no
    // data-URL <img> round-trip, so no CSP/URL layer to fail silently.
    // (b64ToBytes always allocates a plain ArrayBuffer; the annotation narrows
    // its ArrayBufferLike so the bytes are assignable to BlobPart.)
    const bitmap = await createImageBitmap(
      new Blob([b64ToBytes(b64) as Uint8Array<ArrayBuffer>], { type: "image/png" }),
    ).catch(() => null);
    if (token !== filmstripToken || !bitmap) continue;
    // Same 160x90 offscreen-canvas cell shape the generator path stores, so
    // drawFilmstrip composites both identically.
    const off = document.createElement("canvas");
    off.width = 160;
    off.height = 90;
    off.getContext("2d")?.drawImage(bitmap, 0, 0, 160, 90);
    bitmap.close();
    filmFrames[k] = off;
    if (ui.cutMode) drawFilmstrip();
  }
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
  // Native engine: scrub commits / chapter jumps go back to frame-exact seeks.
  nativeEngine?.setSeekPrecision("exact");
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
    // Native engine: the 60 fps reverse stepper's currentTime writes funnel
    // through the adapter's seek coalescer (one in flight, latest wins) —
    // keyframe seeks keep that pacing responsive on long-GOP recordings.
    if (ui.engineActive === "native") nativeEngine?.setSeekPrecision("fast");
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

/**
 * Step exactly one frame (cut view: , / . — native-002). Native engine:
 * mpv frame-step/frame-back-step, the decoder-exact editorial step (the step
 * size is a decoder fact — variable-fps content steps correctly); a back step
 * works from the ended state too (keep-open holds the last frame and the
 * adapter clears the ended latch, like a web seek-back would). Web engine
 * (and the native forward-step-at-end edge, where mpv would just re-hit EOF):
 * pause + a frame-exact seek nudged by 1/fps at the detected/container rate.
 */
export function doFrameStep(forward: boolean): void {
  if (!playerVisible()) return;
  resetShuttle();
  if (ui.engineActive === "native" && nativeEngine && !(video.ended && forward)) {
    video.pause();
    nativeEngine.frameStep(!forward);
  } else {
    video.pause();
    syncFromVideo();
    doSeekTo(frameStepTarget(state.currentTime, detectedFps, forward));
  }
  syncFromVideo();
  render();
  showControls();
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
// Folder queue / playlist (play-013)
//
// On opening a video the app treats the other videos in the same folder as a
// queue: the native shell enumerates the siblings (list_folder_videos, scoped to
// the opened directory), the frontend sorts them with the pure natural sort, and
// auto-advances through them as each item ends. The queue is DERIVED FRESH from
// the folder on every open (no persistence — that's play-014's job), so navigating
// or the folder changing is always reflected. The index math (next/prev, clamp vs.
// wrap) lives in player-core; this layer is the thin driver. play-014 reuses it.
// ---------------------------------------------------------------------------

/** Map the opened path onto its position in the (sorted) queue. Exact match first;
 *  falls back to a case-insensitive basename match (siblings are unique per folder)
 *  so a separator/case difference between the opened path and the enumerated paths
 *  still resolves. Returns 0 when nothing matches (the opened file should always be
 *  present, but never leave a non-empty queue with no current item). */
function resolveQueueIndex(sorted: string[], openedPath: string): number {
  const exact = currentIndexOf(sorted, openedPath);
  if (exact >= 0) return exact;
  const target = basename(openedPath).toLowerCase();
  const byName = sorted.findIndex((p) => basename(p).toLowerCase() === target);
  return byName >= 0 ? byName : 0;
}

/**
 * Build the folder queue for a freshly opened video. Best-effort: if the native
 * enumeration is unavailable (not under Tauri) or empty, fall back to a one-item
 * queue holding just the opened file, so Next/Prev degrade gracefully to today's
 * single-file behavior. Guarded by `currentPath` so a slow enumeration that
 * resolves after a newer open is discarded.
 */
async function buildFolderQueue(openedPath: string): Promise<void> {
  let paths = await tauriInvoke<string[]>("list_folder_videos", { path: openedPath }).catch(
    () => null,
  );
  if (currentPath !== openedPath) return; // a newer open superseded this one
  if (!paths || paths.length === 0) paths = [openedPath];
  const sorted = sortPathsNatural(paths);
  ui.queue = sorted.map((p): QueueItem => ({ path: p, name: basename(p) }));
  ui.queueIndex = resolveQueueIndex(sorted, openedPath);
}

/** Drop the queue (returning home, or opening an image / livestream). */
function clearQueue(): void {
  ui.queue = [];
  ui.queueIndex = -1;
  ui.queueOpen = false;
  ui.queueLabel = "FOLDER QUEUE";
  playlistActive = false;
  closeNextPrompt(); // no queue -> no pending "Up Next"
}

/** Load and play the queue item at `i` (no-op when out of range). The load is
 *  flagged `fromQueue` so it keeps the current queue (a user playlist is preserved;
 *  a folder queue is rebuilt for the new path, exactly as before — see loadFromPath). */
function playQueueIndex(i: number): void {
  const item = ui.queue[i];
  if (!item) return;
  ui.queueIndex = i; // optimistic highlight; the load reconciles it
  void loadFromPath(item.path, true);
}

/** Next / Previous controls (buttons + the ] / [ hotkeys): step the queue. */
export function doNextItem(): void {
  const i = nextIndex(ui.queueIndex, ui.queue.length, ui.repeatAll);
  if (i >= 0) playQueueIndex(i);
}

export function doPrevItem(): void {
  const i = prevIndex(ui.queueIndex, ui.queue.length, ui.repeatAll);
  if (i >= 0) playQueueIndex(i);
}

/** Click a row in the queue panel: load and play that item. */
export function openQueueItem(item: QueueItem): void {
  const i = ui.queue.indexOf(item);
  if (i >= 0) playQueueIndex(i);
}

// ---------------------------------------------------------------------------
// Photo sibling nav + gallery (gallery-001)
//
// The image counterpart of the folder queue above, but for stills/animated
// images: a still never fires "ended", so there is no auto-advance — only
// manual Prev/Next (buttons + Left/Right arrows) through the current photo's
// folder. The SAME sibling list backs the full-screen Gallery grid, so opening
// the grid from the viewer costs no extra IPC call.
// ---------------------------------------------------------------------------

/**
 * Build the sibling photo queue for a freshly opened image. Derived fresh from
 * the folder on every open (mirrors buildFolderQueue). Best-effort: if the
 * native enumeration is unavailable or empty, falls back to a one-item queue
 * holding just the opened file, so Prev/Next simply don't show. Guarded by
 * `currentPath` so a slow enumeration that resolves after a newer open is
 * discarded.
 */
async function buildPhotoQueue(openedPath: string): Promise<void> {
  let paths = await tauriInvoke<string[]>("list_folder_images", { path: openedPath }).catch(
    () => null,
  );
  if (currentPath !== openedPath) return; // a newer open superseded this one
  if (!paths || paths.length === 0) paths = [openedPath];
  const sorted = sortPathsNatural(paths);
  ui.photoQueue = sorted.map((p): QueueItem => ({ path: p, name: basename(p) }));
  ui.photoIndex = resolveQueueIndex(sorted, openedPath);
}

/** Drop the photo queue (leaving the image viewer). */
function clearPhotoQueue(): void {
  ui.photoQueue = [];
  ui.photoIndex = -1;
}

/** Prev/Next controls in the image viewer (buttons + Left/Right arrows): step
 *  through the sibling photo queue. Clamps at the ends (no wrap — there is no
 *  "repeat all" concept for a photo browse). */
export function doNextPhoto(): void {
  const i = nextIndex(ui.photoIndex, ui.photoQueue.length, false);
  const item = ui.photoQueue[i];
  if (item) void loadFromPath(item.path);
}

export function doPrevPhoto(): void {
  const i = prevIndex(ui.photoIndex, ui.photoQueue.length, false);
  const item = ui.photoQueue[i];
  if (item) void loadFromPath(item.path);
}

/**
 * When the current item ends, move on in the queue (play-013). A per-item loop
 * must NOT auto-skip (play-011 interplay): a whole-clip native `video.loop`
 * already suppresses the `ended` event, and an active A-B region loops within
 * [A,B] and never reaches the end — but guard both explicitly so the contract is
 * clear.
 *
 * Autoplay (play-018) decides HOW we move on. With autoplay ON we advance
 * immediately (the original play-013 behavior). With autoplay OFF (the default)
 * we instead raise an "Up Next" prompt and wait for the user to confirm — they
 * have to ask for the next clip. Either path resolves to `advanceQueueTo`.
 */
function maybeAdvanceQueue(): void {
  if (video.loop || abLoopActive(ui.abA, ui.abB)) return;
  const next = nextIndex(ui.queueIndex, ui.queue.length, ui.repeatAll);
  if (next < 0) return;
  if (ui.autoplay) {
    advanceQueueTo(next);
  } else {
    pendingNextIndex = next;
    ui.nextPromptName = ui.queue[next]?.name ?? "";
    ui.nextPromptOpen = true;
  }
}

/** Play the resolved next queue index, or replay in place for a single-item
 *  "repeat all" queue (`next === queueIndex`). Shared by autoplay advance and the
 *  "Up Next" prompt's confirm. */
function advanceQueueTo(next: number): void {
  if (next === ui.queueIndex) {
    doSeekTo(0);
    void video.play().catch(() => {});
  } else {
    playQueueIndex(next);
  }
}

// The queue index the "Up Next" prompt would play if confirmed (-1 = no prompt).
let pendingNextIndex = -1;

/** Confirm the end-of-video "Up Next" prompt: play the queued next item. */
export function confirmNextPrompt(): void {
  const next = pendingNextIndex;
  closeNextPrompt();
  if (next >= 0) advanceQueueTo(next);
}

/** Dismiss the "Up Next" prompt without advancing (stay on the finished clip). */
export function closeNextPrompt(): void {
  ui.nextPromptOpen = false;
  ui.nextPromptName = "";
  pendingNextIndex = -1;
}

// Persisted setting: autoplay the next queue item (vs. the default end-of-video prompt).
const AUTOPLAY_KEY = "playback:autoplay";

/** Set autoplay and persist it. Turning it ON while the "Up Next" prompt is
 *  showing resolves that prompt immediately (the user just asked for auto). */
export function setAutoplay(on: boolean): void {
  ui.autoplay = on;
  try {
    localStorage.setItem(AUTOPLAY_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable (e.g. private mode) — setting just won't persist */
  }
  if (on && ui.nextPromptOpen) confirmNextPrompt();
}

export function toggleAutoplay(): void {
  setAutoplay(!ui.autoplay);
}

/** Restore the saved autoplay setting on startup. */
function loadAutoplay(): void {
  try {
    ui.autoplay = localStorage.getItem(AUTOPLAY_KEY) === "1";
  } catch {
    /* ignore — default (prompt) stands */
  }
}

/** Queue-level "repeat all": wrap last->first on auto-advance / Next / Previous. */
export function setRepeatAll(on: boolean): void {
  ui.repeatAll = on;
}

export function toggleRepeatAll(): void {
  setRepeatAll(!ui.repeatAll);
}

/** Open / close the queue panel (mutually exclusive with the Chapters panel). */
export function setQueueOpen(open: boolean): void {
  ui.queueOpen = open;
  if (open) {
    ui.panelOpen = false; // the two right-side panels share a slot
    showControls();
  }
}

export function toggleQueue(): void {
  setQueueOpen(!ui.queueOpen);
}

// ---------------------------------------------------------------------------
// User-created playlists (play-014)
//
// The user-curated counterpart to play-013's auto folder-queue: same playback
// engine (ui.queue + queueIndex + auto-advance + Next/Prev + repeat-all), but the
// list is hand-built and PERSISTED (localStorage `playback:playlists`) rather than
// derived from a folder. The pure store helpers (player-core) own creation, the
// per-playlist edits, and (de)serialization; this layer persists them and seeds the
// queue. While a playlist is playing, `playlistActive` keeps loadFromPath from
// overwriting the queue with the opened file's folder siblings.
// ---------------------------------------------------------------------------
const PLAYLISTS_KEY = "playback:playlists";

/** True while a user playlist (not the auto folder-queue) is driving ui.queue. */
let playlistActive = false;

function loadPlaylistStore(): PlaylistStore {
  return parsePlaylistStore(localStorage.getItem(PLAYLISTS_KEY));
}

function savePlaylistStore(store: PlaylistStore): void {
  try {
    localStorage.setItem(PLAYLISTS_KEY, serializePlaylistStore(store));
  } catch {
    /* storage unavailable / quota — playlists are best-effort, like recents */
  }
  ui.playlists = store; // reflect immediately (the reactive home + editor read this)
}

/** Refresh the reactive playlists list from storage. */
function renderPlaylists(): void {
  ui.playlists = loadPlaylistStore();
}

/** Generate a stable unique id for a new playlist. */
function newPlaylistId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the timestamp+random fallback */
  }
  return `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a new (empty) playlist and immediately open it in the editor. */
export function createNewPlaylist(): void {
  const pl = createPlaylist("Untitled playlist", newPlaylistId());
  savePlaylistStore(addPlaylist(loadPlaylistStore(), pl));
  openPlaylistEditor(pl.id);
}

export function openPlaylistEditor(id: string): void {
  ui.editingPlaylistId = id;
  ui.playlistEditorOpen = true;
  renderPlaylists();
}

export function closePlaylistEditor(): void {
  ui.playlistEditorOpen = false;
  ui.editingPlaylistId = null;
}

/** Rename a playlist (from the editor's name field). */
export function renamePlaylistName(id: string, name: string): void {
  savePlaylistStore(renamePlaylist(loadPlaylistStore(), id, name));
}

/** Delete a whole playlist; close the editor if it was the one being edited. */
export function deletePlaylist(id: string): void {
  savePlaylistStore(removePlaylist(loadPlaylistStore(), id));
  if (ui.editingPlaylistId === id) closePlaylistEditor();
}

/** Append already-known video paths to a playlist (drag-drop / from Recent). */
function addPathsToPlaylist(id: string, paths: string[]): void {
  const videos = paths.filter((p) => isVideoPath(p));
  if (videos.length === 0) return;
  savePlaylistStore(addPlaylistItems(loadPlaylistStore(), id, videos));
}

/** Add a single video (e.g. a Recent card) to the playlist being edited. */
export function addRecentToPlaylist(id: string, path: string): void {
  addPathsToPlaylist(id, [path]);
}

/** Open the native picker (multiple) and append the chosen videos to a playlist. */
export async function addVideosToPlaylist(id: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    const paths = Array.isArray(selected)
      ? selected
      : typeof selected === "string"
        ? [selected]
        : [];
    if (paths.length > 0) addPathsToPlaylist(id, paths);
  } catch (err) {
    showError(`Open dialog unavailable: ${String(err)}`);
  }
}

export function removeItemFromPlaylist(id: string, index: number): void {
  savePlaylistStore(removePlaylistItem(loadPlaylistStore(), id, index));
}

export function moveItemInPlaylist(id: string, index: number, delta: number): void {
  savePlaylistStore(movePlaylistItem(loadPlaylistStore(), id, index, delta));
}

/**
 * Open a playlist card from the home screen. A populated playlist seeds the
 * play-013 queue and plays its first item (auto-advance + Next/Prev then reuse the
 * shared engine); an empty playlist opens the editor instead so the user can fill it.
 */
export function activatePlaylist(id: string): void {
  const pl = findPlaylist(loadPlaylistStore(), id);
  if (!pl) return;
  if (pl.items.length === 0) {
    openPlaylistEditor(id);
    return;
  }
  playPlaylist(pl, 0);
}

/** Seed the queue from a playlist and start playing at `startIndex`. */
function playPlaylist(pl: Playlist, startIndex: number): void {
  closePlaylistEditor();
  ui.queue = pl.items.map((p): QueueItem => ({ path: p, name: basename(p) }));
  ui.queueLabel = pl.name;
  ui.queueIndex = clamp(startIndex, 0, ui.queue.length - 1);
  playlistActive = true; // keep loadFromPath from rebuilding a folder queue
  void loadFromPath(ui.queue[ui.queueIndex].path, true);
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

async function loadFromPath(path: string, fromQueue = false): Promise<void> {
  perfMark("open.begin", basename(path)); // perf-004: paired with open.firstframe
  currentPath = path;
  closeNextPrompt(); // any pending "Up Next" prompt is moot once a new clip loads
  // A fresh user-initiated open (dialog / drop / Recent / launch arg) leaves any
  // active playlist; a load that steps the current queue (Next/Prev, click-to-jump,
  // playPlaylist) passes fromQueue=true to preserve it.
  if (!fromQueue) playlistActive = false;
  addRecent(path, basename(path));
  // sec-002: authorize this file's directory before any native read of it.
  await authorizeMediaDir(path);
  if (isImagePath(path)) {
    clearQueue(); // images aren't part of the auto-advancing video queue
    loadTimestampsFor(null);
    await openImage(path);
    return;
  }
  perfMark("open.authorized"); // perf-004: phase boundaries inside the open
  loadTimestampsFor(path);
  try {
    const status = await tauriInvoke<StreamStatus>("stream_status", { path }).catch(() => null);
    const detected = status ? await detectLive(path, status) : "normal";
    perfMark("open.detected");
    if (detected !== "normal") {
      clearQueue();
      openEmptyLivePlayer(path);
      return;
    }
    let playPath = path;
    if ((await engineForLoad()) === "native") {
      // NATIVE engine (native-001): mpv demuxes fragmented MP4 / MPEG-TS / MKV
      // directly from the raw path — no remux, no asset URL, no "Preparing
      // video…" step. This is the whole point of the engine: the play-016/020
      // preprocessing below exists only for the WebView's <video>.
      loadNative(path, basename(path), parentDir(path));
      perfMark("open.dispatched");
    } else {
      // WEB engine: some containers the WebView's <video> can't start playing
      // are remuxed to a temp .mp4 via the ffmpeg sidecar first — an MPEG-TS
      // container it can't demux (play-016), or a large fragmented MP4 it would
      // otherwise stall scanning for a duration (play-020). Every downstream
      // consumer (the player src AND the cut deck) uses the remuxed .mp4.
      if (isTransportStreamPath(path) || (await needsFragmentedRemux(path, status))) {
        const remuxed = await remuxForPlayback(path);
        if (remuxed === null) return; // error already surfaced
        playPath = remuxed;
      }
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      const src = convertFileSrc(playPath);
      loadSrc(src, basename(path), parentDir(path));
    }
    prepareCutDeck(playPath, basename(path));
    if (playlistActive) {
      // A user playlist (play-014) is driving the queue — keep it; just reconcile
      // the highlight to the loaded item (already set optimistically by the caller).
      const idx = ui.queue.findIndex((q) => q.path === path);
      if (idx >= 0) ui.queueIndex = idx;
    } else {
      // Treat the folder's other videos as an auto-advancing queue (play-013). Built
      // from the ORIGINAL path (not the remuxed temp .mp4) so siblings resolve.
      void buildFolderQueue(path);
    }
  } catch (err) {
    ui.prepping = false;
    showError(`Could not open the file: ${String(err)}`);
  }
}

/**
 * True when `path` is a fragmented MP4 large enough that the WebView would stall
 * scanning it for a duration, so it must be remuxed before playing (play-020). The
 * size gate (status from the prior stream_status) keeps small fragmented files —
 * which scan quickly — on the direct, no-remux path. Best-effort: with no native
 * backend (status null / invoke rejects) it returns false (the remux is also native,
 * so there is nothing to do).
 */
async function needsFragmentedRemux(
  path: string,
  status: StreamStatus | null,
): Promise<boolean> {
  if (!status || status.size < MIN_FRAGMENTED_REMUX_BYTES) return false;
  if (!isIsoBmffPath(path)) return false;
  return tauriInvoke<boolean>("is_fragmented_mp4", { path }).catch(() => false);
}

/**
 * Remux a container the WebView can't start playing (an MPEG-TS file, play-016, or a
 * fragmented MP4, play-020) to a playable temp .mp4 via the native ffmpeg sidecar,
 * showing a progress overlay. Returns the temp .mp4 path, or null on failure (in
 * which case the error is already surfaced and the home screen is shown).
 */
async function remuxForPlayback(path: string): Promise<string | null> {
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

/** Load a media file from an already-resolved URL (asset://) — the WEB engine. */
function loadSrc(src: string, title: string, subtitle = ""): void {
  ui.emptyError = "";
  clearImageView();
  // Engine switch (native → web): silence the native engine and close its hole.
  if (nativeEngine && video === (nativeEngine as EngineSurface)) nativeEngine.stop();
  video = els.video!;
  ui.engineActive = "web";
  syncVideoHole(false);
  ui.pipSupported = pipSupported();
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

/** Load a media file into the NATIVE engine by raw path (native-001). */
function loadNative(path: string, title: string, subtitle = ""): void {
  ui.emptyError = "";
  clearImageView();
  // Engine switch (web → native): silence the idle/previous <video> element.
  const el = els.video;
  if (el) {
    el.pause();
    el.removeAttribute("src");
    el.load();
  }
  video = nativeEngine!;
  ui.engineActive = "native";
  ui.pipSupported = false; // PiP is a browser feature of the element
  ui.bufferedPct = 0; // no progressive buffer natively; the bar stays empty
  // The hole opens on the FIRST PRESENTED FRAME (onNativePresented), not here —
  // until then the stage keeps painting its opaque black, like the web player
  // before first frame.
  syncVideoHole(false);
  void nativeEngine!.loadPath(path).catch((err) => {
    onNativeEngineError(err instanceof Error ? err.message : String(err));
  });
  ui.title = title;
  ui.subtitle = subtitle;
  document.title = `${title} — Playback`;
  ui.view = "playing";
  state = createInitialState();
  applyAudioToVideo();
  resetShuttle();
  clearAbLoop();
  applyLoopState();
  showControls();
}

/** A detected livestream opens the "Livestream · Unavailable" screen (frame 04b). */
function openEmptyLivePlayer(path: string): void {
  const title = basename(path);
  const folder = parentDir(path);
  syncVideoHole(false);
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
  clearPhotoQueue();
  imgEl.removeAttribute("src");
  ui.imgElHidden = true;
  ui.imgCanvasHidden = true;
  // Note: the section visibility follows ui.view; callers move ui.view away.
}

/** Open an animated / still image in the dedicated viewer (play-012). */
async function openImage(path: string): Promise<void> {
  perfMark("image.begin", basename(path)); // perf-005
  const token = ++imgToken;
  syncVideoHole(false); // the image viewer paints on the opaque app canvas
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
  void buildPhotoQueue(path); // gallery-001: sibling Prev/Next, derived fresh

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
  // perf-005: this path reads the WHOLE file over the IPC bridge and decodes it
  // to a bitmap, which is the right trade only for a container that can actually
  // animate. JPEG/BMP/ICO never can, so they went through a multi-megabyte read
  // and a full-resolution decode purely to discover a single frame — measured at
  // ~246 ms per open on 16-25 MB photos. Those go straight to the <img> tier,
  // where Chromium decodes off the main thread and at its own scale.
  if (!isAnimatableImagePath(path)) return false;
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
        perfMark("image.shown", `decoder ${bitmap.width}x${bitmap.height}`); // perf-005
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
    perfMark("image.shown", `native ${imgEl.naturalWidth}x${imgEl.naturalHeight}`); // perf-005
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

// ---------------------------------------------------------------------------
// Gallery grid (gallery-001)
//
// A full-screen browser for every image in a folder. Entry points: the image
// viewer's Grid button (reuses the sibling queue openImage already built — no
// extra native call) and Home's "Open folder" action (a fresh list_folder_images
// call against a user-chosen directory). Clicking a tile opens that photo through
// the normal loadFromPath funnel, so sibling Prev/Next picks up from there too.
// ---------------------------------------------------------------------------

/**
 * Build the grid's items (perf-005).
 *
 * `thumbSrc` starts EMPTY and is filled in later by `fillGalleryThumbs`. It used
 * to be `convertFileSrc(originalPath)`, which made every ~200 px tile decode the
 * full-resolution original — on a folder of 51-megapixel photos that measured as
 * 2.6 s of main-thread stalls (worst single block 1130 ms) and hundreds of MB of
 * bitmap per tile. The grid now renders instantly with placeholders instead.
 */
function toGalleryItems(items: QueueItem[]): GalleryItem[] {
  return items.map((i) => ({ path: i.path, name: i.name, thumbSrc: "" }));
}

/** How many thumbnails to render at once. Each is an ffmpeg sidecar process, so
 *  this trades wall-clock against not swamping the machine mid-browse. */
const THUMB_CONCURRENCY = 4;

/** Invalidates an in-flight thumbnail fill when the gallery changes underneath it. */
let galleryToken = 0;

/**
 * Fill in each tile's thumbnail in the background, newest-visible-first order,
 * with bounded concurrency. Each thumbnail is rendered ONCE by the native sidecar
 * and cached on disk, so a second visit to the same folder is served from cache.
 * A per-item failure falls back to the original file, which is what the grid used
 * to do for everything — degraded, never broken.
 */
async function fillGalleryThumbs(token: number): Promise<void> {
  const end = perfSpan("gallery.thumbs");
  await tauriInvoke("prepare_thumb_cache", {}).catch(() => {
    /* no cache dir — each thumbnail request then fails and falls back below */
  });
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= ui.galleryItems.length || token !== galleryToken) return;
      const item = ui.galleryItems[i];
      if (!item || item.thumbSrc) continue;
      const thumb = await tauriInvoke<string>("image_thumbnail", { path: item.path }).catch(
        () => null,
      );
      if (token !== galleryToken) return;
      const current = ui.galleryItems[i];
      if (!current || current.path !== item.path) continue; // list changed under us
      current.thumbSrc = convertFileSrc(thumb ?? item.path);
    }
  };
  await Promise.all(Array.from({ length: THUMB_CONCURRENCY }, worker));
  if (token === galleryToken) end(String(ui.galleryItems.length));
}

/** Open the Gallery grid for the CURRENT photo's folder, reusing the sibling
 *  queue openImage already built (no extra native call). */
export async function openGalleryFromImage(): Promise<void> {
  if (ui.photoQueue.length === 0) return;
  perfMark("gallery.begin", ui.imgMeta || "siblings"); // perf-005
  const folder = ui.imgMeta;
  const items = ui.photoQueue;
  ui.galleryFolder = folder;
  ui.galleryError = "";
  ui.galleryLoading = false;
  setShortcutsOpen(false);
  ui.view = "gallery";
  document.title = `${folder || "Gallery"} — Playback`;
  const token = ++galleryToken;
  ui.galleryItems = toGalleryItems(items);
  perfMark("gallery.items", String(ui.galleryItems.length)); // perf-005
  void fillGalleryThumbs(token);
}

/** Open the Gallery grid for an explicitly chosen folder (Home's "Open folder"). */
export async function openGalleryForFolder(path: string): Promise<void> {
  perfMark("gallery.begin", basename(path)); // perf-005
  const token = ++galleryToken;
  const label = basename(path);
  ui.galleryItems = [];
  ui.galleryFolder = label;
  ui.galleryError = "";
  ui.galleryLoading = true;
  ui.emptyError = "";
  setPanelOpen(false);
  setShortcutsOpen(false);
  ui.view = "gallery";
  document.title = `${label} — Playback`;
  try {
    await authorizeMediaDir(path);
    const paths = await tauriInvoke<string[]>("list_folder_images", { path });
    perfMark("gallery.listed", String(paths?.length ?? 0)); // perf-005
    const sorted = sortPathsNatural(paths ?? []);
    const raw = sorted.map((p): QueueItem => ({ path: p, name: basename(p) }));
    const items = toGalleryItems(raw);
    if (ui.view !== "gallery" || ui.galleryFolder !== label) return; // superseded by a newer open
    ui.galleryItems = items;
    perfMark("gallery.items", String(items.length)); // perf-005
    void fillGalleryThumbs(token);
    if (ui.galleryItems.length === 0) ui.galleryError = "No supported images in this folder.";
  } catch (err) {
    if (ui.view === "gallery" && ui.galleryFolder === label) {
      ui.galleryError = `Could not open this folder: ${String(err)}`;
    }
  } finally {
    if (ui.view === "gallery" && ui.galleryFolder === label) ui.galleryLoading = false;
  }
}

/** Open the native folder picker (Tauri) and open the chosen folder as a gallery. */
export async function openFolderDialog(): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ multiple: false, directory: true });
    if (typeof selected === "string") await openGalleryForFolder(selected);
  } catch (err) {
    showError(`Open folder unavailable: ${String(err)}`);
  }
}

/** Click a tile in the Gallery grid: open that photo in the single-image viewer. */
export function openGalleryItem(item: GalleryItem): void {
  void loadFromPath(item.path);
}

/** Back button in the Gallery: return to the home screen. */
export function closeGallery(): void {
  goHome();
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
  // Sibling photo nav (gallery-001) and the gallery-grid hotkey work for ANY
  // opened image — animated or a single static frame — so they're checked before
  // the animated-only bail below.
  switch (e.key) {
    case "ArrowRight":
      if (ui.photoQueue.length > 1) {
        e.preventDefault();
        doNextPhoto();
        return true;
      }
      return false;
    case "ArrowLeft":
      if (ui.photoQueue.length > 1) {
        e.preventDefault();
        doPrevPhoto();
        return true;
      }
      return false;
    case "g":
    case "G":
      if (ui.photoQueue.length > 1) {
        e.preventDefault();
        void openGalleryFromImage();
        return true;
      }
      return false;
    default:
      break;
  }
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
        { name: "Image", extensions: IMAGE_EXTENSIONS },
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
  // Guard duration > 0: the native engine can report metadata before any
  // duration is known (zero-duration fragmented MP4) and re-fires this when
  // the real duration arrives — don't write a bogus 0 into recents meanwhile.
  if (currentPath && video.duration > 0) setRecentDuration(currentPath, video.duration);
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
  maybeAdvanceQueue();
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

/**
 * Dismiss the control-bar overflow menu (ui-005) on any click outside it. The
 * toggle's own onclick handles open/close, so a click on it is ignored here;
 * clicking a menu item runs that item's action and then bubbles here to close
 * the menu, and a click anywhere else closes it too.
 */
function wireMoreMenu(): void {
  document.addEventListener("click", (e) => {
    if (!ui.moreOpen) return;
    const t = e.target as HTMLElement | null;
    // The toggles (player + timeline view) manage their own open state.
    if (t && (t.closest("#btn-more") || t.closest("#cut-more"))) return;
    setMoreOpen(false);
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
      // Frame stepping (native-002): , / . — one decoder frame back / forward.
      if (e.key === ",") {
        e.preventDefault();
        doFrameStep(false);
        return;
      }
      if (e.key === ".") {
        e.preventDefault();
        doFrameStep(true);
        return;
      }
    }

    // The end-of-video "Up Next" prompt (play-018): Enter confirms (play the next
    // item), Esc dismisses (handled in the cascade below). Confirm is intercepted
    // here so Enter never falls through to the transport keys.
    if (ui.nextPromptOpen && e.key === "Enter") {
      e.preventDefault();
      confirmNextPrompt();
      return;
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
      case "]":
        if (playerVisible()) {
          e.preventDefault();
          doNextItem();
        }
        break;
      case "[":
        if (playerVisible()) {
          e.preventDefault();
          doPrevItem();
        }
        break;
      case "q":
      case "Q":
        if (playerVisible()) {
          e.preventDefault();
          toggleQueue();
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
      case "F9":
        // TEST-ONLY frame oracle (native-001): live only when the Rust side
        // reports PLAYBACK_TEST_SHOT_DIR is set by a smoke harness. F9 = the
        // decoded frame, Shift+F9 = the presented window.
        if (shotHotkeysEnabled && playerVisible()) {
          e.preventDefault();
          void tauriInvoke("player_screenshot", {
            mode: e.shiftKey ? "window" : "video",
          }).catch(() => {});
        }
        break;
      case "Escape": {
        // Esc dismisses the TOPMOST layer only. A side panel / overlay COVERS the
        // "Up Next" prompt, so an Esc that closes the panel must only reveal the
        // prompt — NOT dismiss it. Layering (top → bottom): panels/overlays →
        // the prompt → fullscreen. (The panel set here mirrors NextPrompt's
        // `covered` check.)
        const hadPanel =
          ui.shortcutsOpen ||
          ui.panelOpen ||
          ui.settingsOpen ||
          ui.queueOpen ||
          ui.playlistEditorOpen ||
          ui.moreOpen;
        if (hadPanel) {
          setShortcutsOpen(false);
          setSettingsOpen(false);
          setPanelOpen(false);
          setQueueOpen(false);
          setMoreOpen(false);
          closePlaylistEditor();
        } else if (ui.nextPromptOpen) {
          closeNextPrompt();
        } else {
          void setFullscreen(false);
        }
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
        // While the playlist editor is open, dropped videos are ADDED to that
        // playlist rather than opened (the dropzone "add" channel for play-014).
        if (ui.playlistEditorOpen && ui.editingPlaylistId) {
          addPathsToPlaylist(ui.editingPlaylistId, paths);
          return;
        }
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

/**
 * play-019: the app runs as a single instance. When the user opens another file
 * while it's already running ("Open with…" / double-click), the native shell
 * focuses this window and emits `open-file` with that path instead of spawning a
 * second window. Loading it through the same loadFromPath funnel means addRecent
 * runs in THIS (the live) window, so the recently-played list updates immediately
 * — the bug was that a second instance wrote recents to shared localStorage that
 * the running window never re-read (they only appeared after a relaunch).
 */
async function wireSecondInstance(): Promise<void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string>("open-file", (event) => {
      const path = event.payload;
      if (path) void loadFromPath(path);
    });
  } catch {
    /* Not running under Tauri — single-instance forwarding is unavailable. */
  }
}

/** The deck canvases are display-sized — repaint them when the window resizes.
 *  The native letterbox margins are window-fractions of a fixed-px layout, so
 *  they are re-measured on every resize too (native-002). */
function wireResize(): void {
  window.addEventListener("resize", () => {
    if (ui.cutMode) {
      drawFilmstrip();
      drawWaveform();
      syncCutMargins();
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

  void initPerf(); // perf-004: no-op unless PLAYBACK_PERF_LOG is set

  // Resolve the persisted engine choice (native-001) before the first load —
  // loadFromPath awaits this promise, so launch files pick the right engine.
  enginePrefReady = initEngineChoice();

  ui.pipSupported = pipSupported();
  // Mirror the OS PiP window's state onto the button (play-015). These events are
  // non-standard and element-only, so they're attached to the real <video>.
  if (ui.pipSupported) {
    els.video!.addEventListener("enterpictureinpicture", onEnterPip);
    els.video!.addEventListener("leavepictureinpicture", onLeavePip);
  }

  wireKeyboard();
  wireFocusReturn();
  wireMoreMenu();
  wireControlsOverflow();
  disableContextMenu();
  wireResize();
  loadPinChapter();
  loadLoopPref();
  loadAutoplay();
  void loadHwaccel();
  void registerDragAndDrop();
  void loadLaunchFile();
  void wireSecondInstance();
  renderRecents();
  renderPlaylists();
  renderTimestamps();
  render();
}

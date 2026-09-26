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
import {
  ui,
  els,
  actions,
  type RecentFile,
  type QueueItem,
  type GalleryItem,
  type TagTarget,
} from "./state.svelte";
import {
  initPerf,
  mark as perfMark,
  span as perfSpan,
  recordIpc,
  perfEnabled,
} from "./perf";
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
  orderGalleryEntries,
  type GalleryNode,
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
  resetImageTransform,
  fitImage,
  rotateImageBy,
  flipImage,
  toggleImageFit,
  panImageBy,
  clampImagePan,
  canPanImage,
  zoomImageAt,
  stepImageZoom,
  wheelZoomTarget,
  revealTargetPath,
  formatFileSize,
  fileExtension,
  orientationDrawMatrix,
  rotatedSize,
  imageTransformCss,
  imageZoomPercent,
  type ImageTransform,
  type ImageSize,
  naturalSortKey,
  cleanTagDraft,
  tagIdentity,
  TAG_PAGE_SIZE,
  pageForIndex,
  pageRange,
  windowBounds,
  nextThumbFillBatch,
  nearestQueuedThumb,
  deleteArmKey,
  armDelete,
  isArmedFor,
  indexAfterDelete,
  DELETE_ARM_MS,
  type DeleteArm,
  filterBlacklisted,
  isHidden,
  reviseGrid,
  mergeListing,
  folderChangeApplies,
  gridShouldRelist,
  type FolderChangeContext,
  queueIndexAfterRefresh,
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
// Archive containers browsed as directories (gallery-004). Listed here so the
// open dialog, drag-drop and Recent treat them as openable; `loadFromPath` routes
// them to the gallery rather than the player.
const ARCHIVE_EXTENSIONS = ["zip", "cbz", "rar", "cbr"];

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
export function isArchivePath(path: string): boolean {
  return ARCHIVE_EXTENSIONS.includes(extensionOf(path));
}
function isMediaPath(path: string): boolean {
  return isImagePath(path) || isVideoPath(path) || isArchivePath(path);
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
/** When the natively-animated <img> was first painted (perf-007 handover). */
let imgNativeShownAt = 0;
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
  resumeRecentThumbs(); // perf-010: this route to Home does not re-render recents
  showError(`Could not play this file: ${message}`);
}

export function setSettingsOpen(open: boolean): void {
  if (open && !actions.settings) return; // android-001: nothing to set on this platform yet
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

// ---------------------------------------------------------------------------
// Back-stack navigation (ux-001)
//
// Every view's Back button used to call goHome(), so Gallery -> tile -> photo ->
// Back dropped the user at Home instead of the gallery they came from, losing
// their place. `navStack` records how to get BACK to where a forward navigation
// started; Back and Esc pop it, and only an empty stack means Home.
//
// Entries carry a restore closure rather than a plain view id because returning
// to the gallery has to put its items AND scroll position back, which re-deriving
// from the view id alone cannot do.
// ---------------------------------------------------------------------------

interface NavEntry {
  /** Label used by tests/traces to assert where Back actually went. */
  label: string;
  restore: () => void | Promise<void>;
}

let navStack: NavEntry[] = [];

/**
 * A user opening a file from outside the current journey (the Open dialog, a
 * drop, a Recent tile, a launch argument, the single-instance handler) starts a
 * NEW journey — the old trail is no longer where "back" should lead. In-app
 * forward moves (a gallery tile, the G hotkey) push instead, so they keep theirs.
 * It also resets the TAG the gallery was scoped to (tags-002).
 */
function resetNav(): void {
  navStack = [];
  // tags-002: a fresh journey also leaves the TAG the gallery was scoped to.
  // buildPhotoQueue's tag branch keys off ui.galleryTag and reuses an
  // already-built queue; without this, a file dropped mid-tag-browse is shown
  // with the previous tag's Prev/Next still attached to it.
  ui.galleryTag = "";
  ui.galleryTagTotal = 0;
  ui.galleryTagCapped = false;
  // gallery-005: and the ARCHIVE it was scoped to, for the same reason — left set, it
  // makes folderChangeApplies reject every later event, so no direct open is ever live.
  ui.galleryArchive = "";
  ui.galleryInner = "";
  disarmPrune(); // tags-002 fix-wave: a fresh journey leaves any armed prune behind too
}

/** Record where the CURRENT view should return to, before navigating forward. */
function pushNav(entry: NavEntry): void {
  // Bound the stack: a user ping-ponging gallery<->photo for an hour must not
  // grow it without limit. The oldest entries are the least likely to be wanted.
  navStack.push(entry);
  if (navStack.length > 20) navStack.shift();
}

/** Snapshot the gallery so Back can restore it exactly, with no re-read of disk. */
function galleryNavEntry(): NavEntry {
  const items = ui.galleryItems;
  // tags-003 live hide: the unfiltered listing travels with the grid, so Back
  // can re-run the blacklist filter over it rather than trusting `items` —
  // which is what the filter left at the time, not what it leaves now.
  const listing = ui.galleryListing;
  const folder = ui.galleryFolder;
  // gallery-002: the path and breadcrumb trail are part of "where you were" too —
  // restoring a nested sub-gallery without them would show the right tiles under
  // the wrong heading, and leave `galleryPath` pointing at the folder you left.
  const path = ui.galleryPath;
  const crumbs = ui.galleryCrumbs;
  // gallery-004: which archive (and which level inside it) this grid was showing,
  // so Back into an archive restores the level rather than the parent folder.
  const archive = ui.galleryArchive;
  const inner = ui.galleryInner;
  // tags-002: a tag view is a grid like any other, but its scoping lives in
  // these fields — restoring without them shows the right tiles under the wrong
  // heading and loses the tag, exactly as gallery-004 found for archives.
  const tag = ui.galleryTag;
  const tagTotal = ui.galleryTagTotal;
  const tagCapped = ui.galleryTagCapped;
  // tags-002: the absolute index of items[0]. `cursor` below is an ABSOLUTE
  // index too, and every read of the window (`ui.galleryItems[index -
  // ui.galleryWindowStart]`) is relative to it — restoring the cursor without
  // this snaps the window back to 0 while the cursor stays wherever the user
  // had scrolled to, so every one of those reads lands at the wrong offset.
  const windowStart = ui.galleryWindowStart;
  const scrollTop = document.querySelector(".gallery__body")?.scrollTop ?? 0;
  const cursor = ui.galleryIndex; // ux-004: come back to the tile you opened
  return {
    label: `gallery:${folder}`,
    restore: () => {
      // Backing out of a DEEPER gallery leaves that gallery's thumbnail work in
      // flight against a pipeline whose observer is about to be replaced. Bump the
      // token so those results are discarded, and reset the pipeline BEFORE the
      // items land (same ordering constraint as openGalleryForFolder) so tiles
      // that never got a thumbnail can request one again instead of shimmering.
      galleryToken++;
      resetThumbPipeline();
      ui.galleryItems = items; // already-rendered tiles, thumbnails included
      // perf-009: and restart the background fill by hand. The reset above
      // cancelled it and bumped the token out from under it, and the restore
      // puts back the SAME item objects — so the keyed {#each} reuses the
      // existing tiles, `use:galleryTile` never re-runs, and nothing would
      // re-arm the pipeline on its own. Measured before this line existed: a
      // grid left mid-fill, opened into a photo and backed out of, sat at 186
      // of 3,000 tiles and never moved again.
      scheduleThumbFill();
      ui.galleryListing = listing;
      ui.galleryFolder = folder;
      ui.galleryPath = path;
      ui.galleryArchive = archive;
      ui.galleryInner = inner;
      ui.galleryTag = tag;
      ui.galleryTagTotal = tagTotal;
      ui.galleryTagCapped = tagCapped;
      ui.galleryWindowStart = windowStart;
      ui.galleryCrumbs = crumbs;
      ui.galleryError = "";
      ui.galleryLoading = false;
      setGalleryIndex(cursor);
      // tags-003 live hide: the snapshot is the grid as the blacklist filter
      // left it when the user went forward. A tag applied or removed since —
      // in the viewer, or in a deeper grid that shares this one's items — can
      // have changed what it should show, so re-derive against the hidden set
      // as it is NOW. Runs after every field above is back in place: which
      // branch it takes depends on `galleryTag`, and where the cursor lands
      // depends on the index just restored.
      applyHiddenToGrid();
      // Whichever viewer the user is backing out of, it must be torn down —
      // the grid is opaque, so a player left running under it was HEARD, not
      // seen (gallery-003 bugfix): a video tile opens into the player and
      // this restore only ever cleared the image viewer. The folder queue
      // goes with the player: with it, a pending "Up Next" could have loaded
      // the next clip into a view the user had already left.
      clearVideoView();
      clearQueue();
      clearImageView();
      ui.view = "gallery";
      document.title = `${folder || "Gallery"} — Playback`;
      // The list only has a layout box once the view is shown, so the scroll
      // restore has to wait for that render.
      void tick().then(() => {
        const body = document.querySelector(".gallery__body");
        if (body) body.scrollTop = scrollTop;
        // Put keyboard focus back on the tile that was opened, so Back leaves the
        // user exactly where they were rather than at the top of the grid.
        // Read from `ui`, not the captured `cursor`: applyHiddenToGrid may have
        // moved it onto the tile that slid into a hidden one's place.
        const landing = ui.galleryIndex;
        if (landing >= 0) {
          const grid = document.getElementById("gallery-grid");
          // Absolute index -> DOM position, converted here at the point of use —
          // same reasoning as focusGalleryTile (tags-002).
          (
            grid?.querySelector(`[data-gallery-index="${landing}"]`) as HTMLElement | null
          )?.focus({ preventScroll: true });
        }
      });
      // gallery-005: the snapshot is the grid as it was when the user went forward, and
      // disk may have moved on since. Point the watch back at this grid's folder and
      // re-list it now; the merge reads the restored `ui.galleryListing`, so surviving
      // tiles keep their thumbnails. An archive or tag grid is never watched.
      if (path && !archive && !tag) {
        void watchFolder(path);
        const carried = [...touchedWhileAway];
        touchedWhileAway.clear();
        void onFolderChanged(path, carried);
      } else {
        void watchFolder(null);
      }
    },
  };
}

/**
 * Go back one level: to wherever the current view was entered FROM, or Home when
 * that is the bottom of the stack. This is what every Back button and Esc calls.
 */
export function goBack(): void {
  const entry = navStack.pop();
  perfMark("nav.back", entry?.label ?? "home"); // ux-001
  if (!entry) {
    goHome();
    return;
  }
  void entry.restore();
}

/** Back button: tear down the current video and return to the home screen. */
export function goHome(): void {
  navStack = []; // Home is the root — nothing above it to return to
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
  void watchFolder(null); // gallery-005: nothing to keep in step with
  video.removeAttribute("src");
  video.load();
  state = createInitialState();
  loadTimestampsFor(null);
  currentPath = null;
  ui.view = "empty";
  ui.emptyError = "";
  ui.galleryItems = [];
  ui.galleryListing = [];
  ui.galleryFolder = "";
  ui.galleryArchive = ""; // gallery-005: else folderChangeApplies rejects every later event
  ui.galleryInner = "";
  ui.galleryError = "";
  ui.galleryLoading = false;
  renderRecents();
  void loadTagLibrary(); // tags-002: keep Home's Tags shelf counts current
  void loadTagBlacklist(); // tags-003: Home's shelf must know about a fully-
  // blacklisted library too — see the matching call in init() below and
  // Home.svelte's `hidden` condition for why.
  document.title = "Playback";
  endClose();
}

// --- Keyboard shortcuts overlay (frame 05) ---
export function setShortcutsOpen(open: boolean): void {
  if (open && !actions.shortcuts) return; // android-001
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
async function authorizeMediaDir(path: string, kind: "file" | "dir" = "file"): Promise<void> {
  // perf-010: the grant this produces is a DIRECTORY, and the native allow-list
  // is a HashSet that only ever grows — so a second grant for a directory
  // already authorized this session changes nothing at all. It is not free,
  // though: `allow_media_dir` is a synchronous Tauri command (it runs on the
  // main thread) and `loadFromPath` AWAITS it before the open can start. While
  // the main thread was busy, that round trip was measured at 261 ms mean and
  // 9.79 s worst case — pure queueing delay in front of every photo the user
  // stepped to. Stepping through one folder now pays it once.
  //
  // The key has to be the directory the native side will actually grant, which
  // depends on what `path` IS: a file authorizes its parent, a folder
  // authorizes itself (see allow_media_dir). Callers say which, because the
  // frontend cannot tell without a filesystem round trip of its own — and
  // guessing wrong in the "dir" direction would memo a grant that was never
  // made and leave real reads rejected.
  const granted = kind === "dir" ? path : dirnameOf(path);
  if (granted && authorizedDirs.has(granted)) return;
  try {
    await tauriInvoke("allow_media_dir", { path });
    // Only a grant that actually succeeded is remembered: a directory that
    // could not be authorized must be retried, not recorded as done.
    if (granted) authorizedDirs.add(granted);
  } catch {
    /* Not under Tauri, or authorization failed — reads will be rejected. */
  }
}

/** Directories `authorizeMediaDir` has successfully granted this session. */
const authorizedDirs = new Set<string>();

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

// --- Whole-file read (animated image decode) ------------------------------

/**
 * Read a whole file as bytes, for the animated-image decoder (its only caller).
 *
 * This costs ~100 ms for a 3.6 MB GIF (base64 inflation + the per-character
 * `b64ToBytes` loop) and TWO faster transports were measured and rejected:
 *   * fetching the asset URL — `asset.localhost` is a different origin, so
 *     `fetch(...).arrayBuffer()` needs CORS headers the asset protocol does not
 *     send. It fails with a bare "TypeError: Failed to fetch". (An `<img src>` is
 *     unaffected; images are not subject to that restriction.)
 *   * a `tauri::ipc::Response` raw-bytes command — measured THREE TIMES SLOWER
 *     (324 ms vs 102 ms) because the body did not arrive as an ArrayBuffer on this
 *     setup and fell back to a slow element-wise transfer.
 *
 * So the read stays as-is; perf-007 instead removes it from the user-visible path
 * entirely by showing the natively-animated `<img>` first (see `openImage`).
 */
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
  void watchFolder(dirnameOf(openedPath)); // gallery-005
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
async function buildPhotoQueue(openedPath: string, keepQueue = false): Promise<void> {
  // tags-002: the siblings are the whole TAG, which lives in tagRows — NOT in
  // ui.galleryItems, which is only the slice currently in the DOM. Reading the
  // window here would make Prev/Next stop at the window's edge and look like a
  // tag that ends early.
  if (ui.galleryTag) {
    // tags-002: in a tag view the queue IS the tag and its membership does not
    // change while browsing, so it is built ONCE on entry and the index is then
    // owned by doNextPhoto/doPrevPhoto. Rebuilding on every open would re-derive
    // the index from a path string, which cannot distinguish the same inner path
    // in two different archives. clearPhotoQueue() (via clearImageView) empties
    // this when the viewer is torn down, so a later entry rebuilds correctly.
    if (ui.photoQueue.length > 0) return;
    // The tag branch is fully synchronous (no await above this point), so a newer
    // open could never supersede this call mid-flight — unlike the async fetch
    // below, there is no window in which `currentPath` could have moved on.
    //
    // tagRows is sparse: a page the sliding window has never covered is still
    // `undefined` here, so this initial build only reflects whatever is loaded
    // right now (typically whatever the user scrolled through to reach this
    // tile). That is not necessarily the whole tag — doNextPhoto/doPrevPhoto
    // pull in the rest on demand (extendPhotoQueueFromTag) when a step runs off
    // the end of what this saw, rather than dead-ending at a page nobody has
    // fetched yet.
    // tags-003: filtered BEFORE `paths`/`byIdentity` are derived from it, not
    // after the map into `ui.photoQueue` — those two are computed against
    // `imageItems`'s indices, and filtering only the mapped result would leave
    // them pointing at positions from the unfiltered array while `ui.photoQueue`
    // had shrunk out from under them.
    // tags-003 final review (Finding 1): shouldFilterTagView keeps this in
    // lockstep with the grid (applyWindow) — a blacklisted tag's own queue must
    // hold every member, same as its own grid does, or Prev/Next would run off
    // the end of a queue shorter than what the grid showed.
    const imageItems = shouldFilterTagView(ui.galleryTag)
      ? filterBlacklisted(tagRowsAsImages(), hiddenKeys)
      : tagRowsAsImages();
    const paths = imageItems.map((row) => row.path);
    ui.photoQueue = imageItems.map((row): QueueItem => ({
      path: row.path,
      name: row.name,
      archive: row.archive,
    }));
    // tags-002: resolved against tagRows, NOT ui.galleryItems — galleryIndex is
    // absolute and ui.galleryItems is only the window since Task 12, so an
    // identity lookup against the window would be off by windowStart and
    // silently fall through to the ambiguous path-string match below, which
    // cannot tell the same inner path apart in two different archives.
    const opened = ui.galleryIndex >= 0 ? tagRows[ui.galleryIndex] : undefined;
    const byIdentity = opened ? imageItems.indexOf(opened) : -1;
    ui.photoIndex = byIdentity >= 0 ? byIdentity : resolveQueueIndex(paths, openedPath);
    return;
  }

  // perf-010: a SIBLING STEP within the queue this function already built is
  // the one case where the answer cannot have changed — the folder is the same
  // folder and the path being opened is already in the queue. Re-listing it
  // meant a full-folder `list_folder_images` on every arrow key (measured at
  // 496 ms mean and 9.79 s worst case while the main thread was congested),
  // only to recompute the very index `stepPhoto` had just set. A fresh open
  // (dialog, drop, Recent, launch argument) still rebuilds, so a folder whose
  // contents changed is picked up the next time the user opens into it.
  if (keepQueue && ui.photoQueue.some((q) => !q.archive && q.path === openedPath)) {
    return;
  }
  let paths = await tauriInvoke<string[]>("list_folder_images", { path: openedPath }).catch(
    () => null,
  );
  if (currentPath !== openedPath) return; // a newer open superseded this one
  if (!paths || paths.length === 0) paths = [openedPath];
  const sorted = sortPathsNatural(paths);
  // tags-003: filter the mapped QueueItems, then derive the index from that
  // SAME filtered list -- resolving against the unfiltered `sorted` would hand
  // back a position meant for a longer array than `ui.photoQueue` now is.
  const queueItems = filterBlacklisted(
    sorted.map((p): QueueItem => ({ path: p, name: basename(p) })),
    hiddenKeys,
  );
  ui.photoQueue = queueItems;
  // gallery-005: an archive page's folder is its materialized level inside the
  // thumbnail cache, not a place the user keeps files — an archive is never
  // watched. `currentArchiveOrigin` is the reliable signal here: every write to it
  // happens in the same synchronous block as the `currentPath` write of the open
  // it belongs to, and the guard above has just confirmed that open is this one.
  // (These folder-branch queue items never carry `archive`; only the tag branch's do.)
  void watchFolder(currentArchiveOrigin ? null : dirnameOf(openedPath));
  ui.photoIndex = resolveQueueIndex(
    queueItems.map((q) => q.path),
    openedPath,
  );
}

/** The images tagRows currently knows about (loaded pages only), in tag order,
 *  skipping folders/videos/archives-as-tiles that are not steppable photos and
 *  files flagged missing (tags-002). Shared by the initial photo-queue build
 *  and `extendPhotoQueueFromTag`'s rebuild once more pages have loaded. */
function tagRowsAsImages(): TaggedItem[] {
  return tagRows.filter(
    (row): row is TaggedItem => !!row && row.kind === "image" && !row.missing,
  );
}

/** Guards `extendPhotoQueueFromTag` against running twice concurrently within
 *  the SAME viewing session — two fast Prev/Next presses landing before the
 *  first fetch resolves would otherwise both walk `ensurePages` over the same
 *  unfetched pages.
 *
 *  What this guard actually guarantees, as of tags-002 fix-3 (Defect A):
 *  - `doNextPhoto`/`doPrevPhoto` decline a further press outright while an
 *    extend for their OWN session (`extendingFor`, below) is in flight, so in
 *    the common case a same-session second call never even reaches here.
 *  - If one does reach here anyway, and it belongs to the SAME session as the
 *    in-flight extend, this hands back the SAME promise rather than starting
 *    a redundant walk over the pages the first call is already fetching.
 *  - A call from a DIFFERENT session (a different tag opened, the viewer
 *    closed and a new photo opened, the same tag reopened) is NOT declined
 *    here: it falls through and starts its own extend. Fix-1's version of
 *    this guard was unconditional, which relied on doNextPhoto/doPrevPhoto's
 *    own gate being unconditional too — once fix-2 scoped that gate to the
 *    session, a different-session call could reach this line while it still
 *    unconditionally returned whichever promise was in flight, handing a NEW
 *    session an ABANDONED session's promise and freezing it until that old
 *    fetch settled. This guard has to be scoped for the same reason the
 *    stepper gate is. */
let extendingPhotoQueue: Promise<void> | null = null;
/** Which viewing session the in-flight `extendingPhotoQueue` belongs to —
 *  `galleryToken`/`imgToken` as they stood when `run` (below) was minted.
 *  Read by the stepper gate in doNextPhoto/doPrevPhoto AND by the entry guard
 *  above: both must agree on what "the current session" means, or scoping one
 *  and not the other just moves the same freeze to whichever side was left
 *  unconditional (tags-002 fix-2 scoped the steppers; fix-3 scoped this). */
let extendingFor: { gallery: number; img: number } | null = null;

/**
 * Pull ONE more not-yet-loaded page of the tag into the photo queue, in the
 * direction of travel, when a step has run off the end of what
 * `buildPhotoQueue` (or a previous extend) could see (tags-002). The initial
 * queue only reflects whatever pages the window had already loaded when the
 * viewer opened — not necessarily the whole tag — so `nextIndex`/`prevIndex`
 * returning -1 here does not yet mean "end of tag", only "end of what's
 * loaded so far".
 *
 * tags-002 fix-1 (Defect C): this used to load EVERY remaining page in one
 * call (`ensurePages(tag, 0, tagRows.length, token)`), which on a
 * 40,000-item tag is ~80 sequential `tag_items` round trips the first time a
 * step runs off the loaded window — with nothing on screen to say why.
 * Loading one page at a time, in `direction`, and stopping the moment the
 * rebuilt queue actually reaches past the current index in that direction
 * turns the common case (the very next page holds an image) into a single
 * round trip. The loop is bounded by the tag's page COUNT, not by "found an
 * image yet": a stretch of pure video in that direction holds that condition
 * false forever, so only the page count can be trusted to end the loop —
 * worst case it walks every remaining page, same as before, but that is now
 * the exception rather than the rule.
 *
 * Preserves the identity-based relocation of `ui.photoIndex` after every
 * page (not just once at the end): the queue is a filtered list, so its
 * indices shift as each new page arrives.
 *
 * Idempotent: once nothing is left to load in `direction` this is a cheap
 * no-op (the starting page is already past the tag's edge, so the loop body
 * never runs), so calling it again at a genuine tag boundary just
 * re-confirms there is nothing more.
 */
async function extendPhotoQueueFromTag(direction: 1 | -1): Promise<void> {
  // Captured BEFORE the entry guard (tags-002 fix-3, Defect A) so the guard
  // can tell "the same session re-entering" apart from "a different session
  // falling through" — see the doc comment on extendingPhotoQueue above.
  const token = galleryToken;
  // Also captured: the viewer's OWN token, bumped by clearImageView (leaving
  // the viewer) independently of galleryToken (which only moves on a gallery
  // navigation). Without this, backing out of the viewer entirely while a
  // fetch was in flight lets this resolve later and repopulate ui.photoQueue
  // after clearPhotoQueue emptied it — leaving a stale, non-empty queue that
  // makes the NEXT photo opened (in any tag, or none) skip buildPhotoQueue's
  // "already built" guard and show the wrong siblings.
  const imgTok = imgToken;
  if (extendingPhotoQueue && extendingFor?.gallery === token && extendingFor?.img === imgTok) {
    return extendingPhotoQueue;
  }
  const tag = ui.galleryTag;
  if (!tag) return;
  const current = ui.photoQueue[ui.photoIndex];
  const run = (async () => {
    const totalPages = Math.max(1, Math.ceil(tagRows.length / TAG_PAGE_SIZE));
    // Start adjacent to whatever has already been LOADED on the side facing
    // `direction`, not unconditionally at page 0 / the last page: a Prev
    // extend must not first walk forward through pages a prior Next extend
    // already fetched (and vice versa). A page that failed is NOT seeded
    // past here — it is not in `tagPagesLoaded` — so the next press starts
    // at that same page again. That is deliberate: a transient failure (a
    // momentary DB lock, an I/O blip) deserves a retry, and nothing here can
    // tell a transient failure apart from a permanent one.
    let page =
      direction > 0
        ? tagPagesLoaded.size > 0
          ? Math.max(...tagPagesLoaded) + 1
          : 0
        : tagPagesLoaded.size > 0
          ? Math.min(...tagPagesLoaded) - 1
          : totalPages - 1;
    // tags-002 fix-2 (Defect B): declared OUTSIDE the loop so it survives past
    // whichever iteration breaks it, for the post-loop check below.
    let failed = false;
    for (let steps = 0; steps < totalPages && page >= 0 && page < totalPages; steps++, page += direction) {
      const from = page * TAG_PAGE_SIZE;
      await ensurePages(tag, from, from + 1, token).catch(() => {
        // The walk stops on the first failure (checked below) rather than
        // trying the rest of the tag's pages, so a broken store costs one
        // round trip and one flash per press instead of a walk of the whole
        // tag. Nothing is recorded past this call's own `failed` flag: the
        // next press re-seeds from `tagPagesLoaded` (unchanged by a failure)
        // and so retries this SAME page — a transient failure deserves the
        // retry, and there is no way to tell one apart from a permanent
        // failure from here.
        failed = true;
      });
      // Staleness wins over failure: a session the user has already left must
      // still return SILENTLY, even if the abandoned fetch also failed — there
      // is nothing to tell them, they navigated away deliberately.
      if (galleryToken !== token || ui.galleryTag !== tag || imgToken !== imgTok) return;
      if (failed) break;
      // tags-003: same reasoning as buildPhotoQueue's tag branch -- filter
      // BEFORE deriving `idx` from `imageItems`, so the index below lands on
      // the same array `ui.photoQueue` was just built from.
      // tags-003 final review (Finding 1): same shared predicate as the grid
      // and as buildPhotoQueue, so a page pulled in mid-session cannot make
      // this extend disagree with either of them about what's visible.
      const imageItems = shouldFilterTagView(tag)
        ? filterBlacklisted(tagRowsAsImages(), hiddenKeys)
        : tagRowsAsImages();
      ui.photoQueue = imageItems.map((row): QueueItem => ({
        path: row.path,
        name: row.name,
        archive: row.archive,
      }));
      if (current) {
        const idx = imageItems.findIndex(
          (row) => (row.archive || "") === (current.archive || "") && row.path === current.path,
        );
        if (idx >= 0) ui.photoIndex = idx;
      }
      const probe =
        direction > 0
          ? nextIndex(ui.photoIndex, ui.photoQueue.length, false)
          : prevIndex(ui.photoIndex, ui.photoQueue.length, false);
      if (probe >= 0) return; // this page answered the question
    }
    // A real fetch failure (not staleness — that returned above already) is
    // the one case worth telling the user about: silently stopping here would
    // leave Prev/Next looking dead with no way to tell "the tag ends here"
    // from "this broke".
    if (failed) flashImageAction("Could not load more of this tag.");
  })();
  extendingPhotoQueue = run;
  extendingFor = { gallery: token, img: imgTok };
  try {
    await run;
  } finally {
    // Clear only if this run still OWNS the shared slot (tags-002 fix-3,
    // Defect A): once the entry guard above lets two different sessions run
    // concurrently, an older session's `finally` firing after a newer one has
    // already started must not null out the newer session's tracking.
    if (extendingPhotoQueue === run) {
      extendingPhotoQueue = null;
      extendingFor = null;
    }
  }
}

/** Drop the photo queue (leaving the image viewer). */
function clearPhotoQueue(): void {
  ui.photoQueue = [];
  ui.photoIndex = -1;
  // perf-010: a step the user asked for in a viewer they have since left must
  // not be honoured — it would re-open a photo over whatever they went to.
  // `photoStepInFlight` is owned by stepPhoto's own `finally` and is
  // deliberately NOT cleared here: the open it guards is still running, and
  // clearing the flag would let a second one start alongside it.
  photoStepWanted = -1;
}

/** Prev/Next controls in the image viewer (buttons + Left/Right arrows): step
 *  through the sibling photo queue. Clamps at the ends (no wrap — there is no
 *  "repeat all" concept for a photo browse).
 *
 *  tags-002: in a tag view, running off the end of the CURRENT queue does not
 *  necessarily mean the tag itself has ended — it may only mean the page that
 *  far in has never been fetched (see `buildPhotoQueue`). Pull more of the
 *  tag in and retry once before accepting that as the real end.
 *
 *  tags-002 fix-1 (Defect B): declined outright while a previous press's
 *  extend is still in flight, rather than computing this press's retry index
 *  from `ui.photoIndex` before that extend has had a chance to move it — two
 *  fast presses at the edge of an archive-backed tag (`stepPhoto` awaits
 *  before writing the index) would otherwise both land on the very same
 *  target, silently swallowing one of the two presses. That matches
 *  `stepPhoto`'s own decline contract: the index does not move, so the next
 *  press is simply this press, retried.
 *
 *  tags-002 fix-2 (Defect A): that decline is scoped to `extendingFor`, the
 *  session the in-flight extend actually belongs to — NOT to "any extend is
 *  in flight anywhere". `extendingPhotoQueue` is only ever set from inside a
 *  tag view, but nothing cleared it on leaving one, so an extend abandoned in
 *  a tag the user has since left (back out to a folder, open an unrelated
 *  photo) used to freeze Prev/Next in that unrelated view until the
 *  abandoned fetch resolved. Checking `extendingFor` against the CURRENT
 *  `galleryToken`/`imgToken` means only a press still inside that same
 *  session gets declined. */
export function doNextPhoto(): void {
  if (extendingPhotoQueue && extendingFor?.gallery === galleryToken && extendingFor?.img === imgToken) return;
  const i = nextIndex(ui.photoIndex, ui.photoQueue.length, false);
  if (i >= 0) {
    void stepPhoto(i);
    return;
  }
  if (ui.galleryTag) {
    void extendPhotoQueueFromTag(1)
      .then(() => {
        const retry = nextIndex(ui.photoIndex, ui.photoQueue.length, false);
        if (retry >= 0) void stepPhoto(retry);
      })
      .catch(() => {});
  }
}

export function doPrevPhoto(): void {
  if (extendingPhotoQueue && extendingFor?.gallery === galleryToken && extendingFor?.img === imgToken) return;
  const i = prevIndex(ui.photoIndex, ui.photoQueue.length, false);
  if (i >= 0) {
    void stepPhoto(i);
    return;
  }
  if (ui.galleryTag) {
    void extendPhotoQueueFromTag(-1)
      .then(() => {
        const retry = prevIndex(ui.photoIndex, ui.photoQueue.length, false);
        if (retry >= 0) void stepPhoto(retry);
      })
      .catch(() => {});
  }
}

/** Open one photo-queue entry and, unless the open was merely DECLINED, make it
 *  the current one. tags-002: a queue built from a TAG can contain pages inside an
 *  archive, whose `path` is an inner path and not a file on disk — those go
 *  through the materialize-then-load route the gallery uses. That route can
 *  decline transiently (an extraction already in flight, a superseded open), and
 *  an index moved for a step that never happened leaves the counter ahead of the
 *  picture and makes the NEXT press skip a page — so those leave the index alone.
 *  A page that FAILED to extract is different: that outcome cannot change on
 *  retry, so the index still moves onto it (there is nothing else to show, but
 *  the next press must continue past it rather than wall off the rest of the
 *  tag). */
async function stepPhoto(i: number): Promise<void> {
  const item = ui.photoQueue[i];
  if (!item) return;
  if (item.archive) {
    let outcome: ArchiveOpen;
    try {
      outcome = await openArchiveEntry({
        path: item.path,
        name: item.name,
        thumbSrc: "",
        kind: "image",
        durationLabel: "",
        archive: item.archive,
      });
    } catch {
      // Defensive: nothing throws here today, but a silent unhandled rejection
      // would leave the viewer looking frozen with no explanation.
      flashImageAction("Could not read that page from the archive.");
      return;
    }
    // A page that CANNOT be extracted still counts as stepped-onto: the picture
    // stays on the last good page (there is nothing else to show) but the index
    // moves, so the next press continues past it. Parking the index on it instead
    // would make Prev/Next unable to cross that page for the rest of the browse.
    if (outcome !== "declined") ui.photoIndex = i;
    return;
  }
  // The cursor moves now, so the counter and the Prev/Next disabled states
  // track the key even while the picture is still catching up. The title goes
  // with it: the header names the photo the cursor is ON, and `openImage` sets
  // the same value again when it actually loads.
  ui.photoIndex = i;
  ui.imgTitle = item.name;
  // perf-010: LATEST WINS. A held arrow key repeats at roughly 30/s and every
  // repeat used to start a full open -- authorize, list the folder, decode,
  // fit. Measured on 40 rapid presses: 31 opens of which 26 NEVER showed a
  // picture, because each new open superseded the previous one's decode before
  // it could finish, and the last one took 11.4 s. Now at most one open is in
  // flight; presses that arrive during it only move the cursor, and when it
  // finishes the viewer converges on wherever the key actually left off. The
  // photo the user stops on is always the one that gets loaded.
  if (photoStepInFlight) {
    photoStepWanted = i;
    return;
  }
  photoStepInFlight = true;
  photoStepWanted = -1;
  try {
    await loadFromPath(item.path, false, { keepPhotoQueue: true });
  } finally {
    photoStepInFlight = false;
  }
  // Converge. Re-read rather than trusting the index captured above: the queue
  // itself can have moved under a slow open (a blacklisted tag hiding an item,
  // a delete), and `stepPhoto` re-resolves the item from the queue anyway.
  const wanted = photoStepWanted;
  photoStepWanted = -1;
  if (wanted >= 0 && wanted !== i) void stepPhoto(wanted);
}

/** True while a sibling step's open is in flight (perf-010). */
let photoStepInFlight = false;
/** The newest index a key press asked for while an open was in flight, or -1. */
let photoStepWanted = -1;

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

/** The containing directory's full PATH (gallery-002 needs the path to list, where
 *  `parentDir` gives only the display name). Empty when there is no separator. */
function dirnameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : "";
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
  resetNav(); // ux-001: a Recent tile starts a fresh journey
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
  // tags-003: Home's recents are browsing, same as a gallery grid — a
  // blacklisted item must not linger here just because it was opened before
  // its tag was hidden.
  ui.recents = filterBlacklisted(loadRecents(), hiddenKeys);
  void fillRecentThumbs();
}

/**
 * Resolve a real poster frame for each recent card (ui-006).
 *
 * The cards used to show a colour gradient derived from the filename — the first
 * thing the app shows on launch, and the one surface still using a placeholder
 * instead of the picture. These reuse the perf-005 native thumbnail cache, so a
 * file already thumbnailed by the gallery costs nothing here, and a video gets a
 * poster frame a few seconds in (see media_thumbnail).
 *
 * Bounded at RECENTS_MAX (8) entries, sequential, and cheap after the first pass;
 * a failure simply leaves the gradient in place.
 */
async function fillRecentThumbs(): Promise<void> {
  // perf-010: these cards belong to Home. `addRecent` runs on every open, so
  // every arrow-key step used to start a pass — and the pass renders thumbnails
  // for a view the user is not looking at, competing with the open they ARE
  // waiting for. Deferred behind the same rule `runThumbFill` already keeps for
  // the grid's background fill, and re-armed when Home comes back.
  if (ui.view !== "empty") {
    recentThumbsDeferred = true;
    return;
  }
  // perf-010: a pass writes `ui.recentThumbs[path]` only when a request
  // COMPLETES, so that map cannot dedupe passes that OVERLAP — and each request
  // is a full-resolution decode that can take a second. Holding an arrow key
  // measured 284 media_thumbnail calls for 31 photo steps (mean 1136 ms, max
  // 11.3 s), of which ~215 were the same up-to-8 recents re-requested by
  // overlapping passes. Both guards below are needed: the flag stops a second
  // pass starting, and the set stops a later pass re-requesting a card whose
  // first attempt is still in flight or came back empty.
  if (fillingRecentThumbs) return;
  const wanted = ui.recents.filter(
    (r) => !ui.recentThumbs[r.path] && !recentThumbsRequested.has(r.path),
  );
  if (wanted.length === 0) return;
  fillingRecentThumbs = true;
  for (const r of wanted) recentThumbsRequested.add(r.path);
  try {
    await fillRecentThumbsPass(wanted);
  } finally {
    fillingRecentThumbs = false;
  }
}

/** True while a `fillRecentThumbs` pass is between its first await and its last. */
let fillingRecentThumbs = false;
/** Recents already asked for, so overlapping passes cannot re-request them. */
const recentThumbsRequested = new Set<string>();
/** Set when a pass was skipped because Home was not the visible view. */
let recentThumbsDeferred = false;

/**
 * Run the recents pass that `fillRecentThumbs` has already de-duplicated and
 * decided to allow. Split out only so the guard above owns one concern (may
 * this run?) and this one owns the other (do the work).
 */
async function fillRecentThumbsPass(wanted: RecentFile[]): Promise<void> {
  await tauriInvoke("prepare_thumb_cache", {}).catch(() => {
    /* no cache dir — the cards keep their gradients */
  });
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  for (const r of wanted) {
    // sec-002: on a cold launch nothing is authorized yet, so the thumbnail
    // command's scope gate would reject every recent. Authorize each recent's
    // directory first — these are paths the user demonstrably opened before, and
    // this grants nothing the frontend could not already do (every open calls
    // allow_media_dir with the path it is about to read). The WebView still only
    // ever loads the derived JPEG out of the app's own cache, never the original.
    await authorizeMediaDir(r.path);
    // gallery-004: an archive is not something ffmpeg can read, so a recent
    // archive resolves to a cover image from INSIDE it first, then goes through
    // the same media_thumbnail cache as every other card.
    let source: string | null = r.path;
    if (isArchivePath(r.path)) {
      const inner = await tauriInvoke<string | null>("archive_cover_entry", {
        archive: r.path,
        inner: "",
      }).catch(() => null);
      source = inner
        ? await tauriInvoke<string>("archive_entry_file", { archive: r.path, inner }).catch(
            () => null,
          )
        : null;
    }
    // perf-010: a card that did NOT get a picture is released from
    // `recentThumbsRequested`, so a later visit to Home can try it again. The
    // set exists to stop CONCURRENT passes duplicating work, not to remember a
    // failure for the rest of the session — a file on a drive that was
    // unplugged and plugged back in must be able to get its thumbnail.
    if (!source) {
      recentThumbsRequested.delete(r.path);
      continue;
    }
    // The recents list can change under a slow pass (a new open re-renders it);
    // only keep a result the current list still wants.
    const thumb = await tauriInvoke<string>("media_thumbnail", { path: source }).catch(() => null);
    if (!thumb) {
      recentThumbsRequested.delete(r.path);
      continue;
    }
    if (!ui.recents.some((x) => x.path === r.path)) {
      recentThumbsRequested.delete(r.path);
      continue;
    }
    ui.recentThumbs[r.path] = convertFileSrc(thumb);
  }
}

/**
 * Run the recents pass that was skipped while another view was up (perf-010).
 * Called wherever Home becomes the visible view; a no-op when nothing was
 * deferred, so it is safe to call on every return to Home.
 */
function resumeRecentThumbs(): void {
  if (!recentThumbsDeferred) return;
  recentThumbsDeferred = false;
  void fillRecentThumbs();
}

/**
 * gallery-004: where the file now open came FROM, when it came from inside an
 * archive — `null` whenever the open is an ordinary file.
 *
 * The mirror directory's whole point is that a materialized entry is an ordinary
 * file at a real path, so nearly every consumer needs no idea an archive was
 * involved. But three surfaces treat that path's DIRECTORY as meaningful, and a
 * mirror directory (`pb-ar-5f4c500c7d2181f4`) is neither a name to show a user
 * nor a folder to browse: Recents, the image viewer's subtitle, and the G key's
 * "open the grid for this photo's folder".
 *
 * MODULE STATE rather than an option threaded through `loadFromPath`, because
 * the sibling steps have nothing to thread: `doNextPhoto`/`doPrevPhoto` walk
 * `ui.photoQueue`, which holds materialized MIRROR paths, and call
 * `loadFromPath` with no other context. An options parameter would carry the
 * archive identity onto page one and lose it on page two — which is the bug
 * itself, since reading eight pages then fills all of RECENTS_MAX with cache
 * paths and evicts the comic's own card. Scoping on the mirror DIRECTORY instead
 * means every sibling on the level inherits it and any other open drops it.
 *
 * `innerDir` and `mirrorDir` describe the LEVEL, not the page, so they stay
 * correct as the user steps sideways through it.
 */
let currentArchiveOrigin: {
  archive: string;
  innerDir: string;
  mirrorDir: string;
} | null = null;

/** The inner DIRECTORY containing `inner` ("" at the archive root). Inner paths
 *  are always '/'-separated (the native side normalizes them on the way out). */
function innerDirOf(inner: string): string {
  const cut = inner.lastIndexOf("/");
  return cut >= 0 ? inner.slice(0, cut) : "";
}

/** Viewer subtitle for a page opened from inside an archive: the archive's own
 *  name, plus the level inside it when that is not the root. */
function archiveOriginMeta(origin: { archive: string; innerDir: string }): string {
  const name = basename(origin.archive);
  return origin.innerDir ? `${name} / ${origin.innerDir}` : name;
}

async function loadFromPath(
  path: string,
  fromQueue = false,
  opts: { noFolderQueue?: boolean; keepPhotoQueue?: boolean } = {},
): Promise<void> {
  perfMark("open.begin", basename(path)); // perf-004: paired with open.firstframe
  currentPath = path;
  // gallery-004: the archive origin survives a sibling step within the SAME
  // materialized level (Left/Right through a comic) and is dropped by anything
  // else, so it answers "am I still reading this archive?" rather than naming one
  // page. An exact string compare is correct here, not a loose path match:
  // `list_folder_images` deliberately roots its results at the RAW directory it
  // was given (see resolve_listing_dir), so every queue entry's dirname is the
  // very string `mirrorDir` was derived from.
  if (currentArchiveOrigin && dirnameOf(path) !== currentArchiveOrigin.mirrorDir) {
    currentArchiveOrigin = null;
  }
  closeNextPrompt(); // any pending "Up Next" prompt is moot once a new clip loads
  // A fresh user-initiated open (dialog / drop / Recent / launch arg) leaves any
  // active playlist; a load that steps the current queue (Next/Prev, click-to-jump,
  // playPlaylist) passes fromQueue=true to preserve it.
  if (!fromQueue) playlistActive = false;
  // gallery-004: a materialized page is a CACHE path — it dies with the 30-day
  // prune and with any edit to the archive. The archive is the thing worth
  // returning to, so that is what Recents records.
  if (currentArchiveOrigin) {
    addRecent(currentArchiveOrigin.archive, basename(currentArchiveOrigin.archive));
  } else {
    addRecent(path, basename(path));
  }
  // sec-002: authorize this file's directory before any native read of it.
  await authorizeMediaDir(path);
  // gallery-004: an archive is a place, not a clip. Routing it here — at the one
  // funnel every open passes through — covers the file picker, drag-drop, a
  // Recent card, the launch argument and the single-instance handler at once.
  if (isArchivePath(path)) {
    clearQueue();
    loadTimestampsFor(null);
    await openArchiveGallery(path, "");
    return;
  }
  if (isImagePath(path)) {
    clearQueue(); // images aren't part of the auto-advancing video queue
    loadTimestampsFor(null);
    await openImage(path, opts.keepPhotoQueue === true);
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
    } else if (opts.noFolderQueue) {
      // gallery-004: a clip opened from inside an archive has no honest folder
      // queue — its siblings are still compressed, and materializing the next one
      // could take gigabytes and an unbounded pause. It plays alone.
      clearQueue();
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
  // Set the title explicitly rather than relying on its default: gallery-004's
  // archive extraction shares this overlay and leaves "Extracting…" behind.
  ui.preppingTitle = "Preparing video…";
  ui.preppingLabel = basename(path);
  ui.prepping = true;
  try {
    const out = await tauriInvoke<string>("remux_ts", { path });
    if (!out) throw new Error("empty output path");
    return out;
  } catch (err) {
    ui.prepping = false;
    ui.view = "empty";
    resumeRecentThumbs(); // perf-010: as in onNativeEngineError
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
  resetImageTools(); // img-001
  cancelImageIdle();
  clearPhotoQueue();
  imgEl.removeAttribute("src");
  ui.imgElHidden = true;
  ui.imgCanvasHidden = true;
  // Note: the section visibility follows ui.view; callers move ui.view away.
}

/**
 * Tear down the video player — the counterpart of clearImageView for a view
 * that leaves the player without opening another file: silence whichever
 * engine is active (the pause + removeAttribute("src") + load() idiom the
 * native adapter maps onto a stop), close the native hole (under it `.app` is
 * transparent — the grid would draw over a still-rendering mpv surface), and
 * drop the player-only layers so the next open starts clean.
 * Like clearImageView, callers move ui.view away.
 */
function clearVideoView(): void {
  syncVideoHole(false);
  video.pause();
  video.removeAttribute("src");
  video.load();
  setCutMode(false);
  clearCutDeck();
  resetShuttle();
  setPanelOpen(false);
  setShortcutsOpen(false);
}

/** Open an animated / still image in the dedicated viewer (play-012). */
async function openImage(path: string, keepPhotoQueue = false): Promise<void> {
  perfMark("image.begin", basename(path)); // perf-005
  const token = ++imgToken;
  clearVideoView(); // the image viewer paints on the opaque app canvas
  resetGifState();
  // perf-010: the FRAMING reset used to happen here, and that was a defect of
  // its own. It clears the surface's size and drops the transform to
  // { zoom: 1, mode: "fit" } -- 100% -- while the PREVIOUS photo is still the
  // one on screen, so the outgoing picture jumped to actual size the instant
  // the arrow key was pressed. img-001's rule (a new photo never inherits the
  // last one's framing) is now kept in `revealImage`, which resets the
  // transform in the same synchronous block that installs the new picture's
  // natural size and fit -- no frame in between. The GESTURE reset still
  // belongs here: a drag in progress belongs to the photo being left.
  resetImageGestures();
  disarmDelete(); // img-003: nor the last one's arm -- the button must not claim
  // one more press deletes THIS photo when the armed press was for a different one
  showImageChrome();

  const title = basename(path);
  ui.imgTitle = title;
  // gallery-004: a materialized page's real parent IS the mirror directory
  // (`pb-ar-<hash>`), a cache implementation detail that means nothing to a
  // reader. Name the archive and the level inside it instead.
  ui.imgMeta = currentArchiveOrigin
    ? archiveOriginMeta(currentArchiveOrigin)
    : parentDir(path) || "Image";
  document.title = `${title} — Playback`;

  ui.view = "image";
  ui.emptyError = "";
  ui.imgErrorHidden = true;
  // perf-010: blank the viewer ONLY when there is nothing worth keeping. A
  // sibling step used to empty it for however long the next decode took --
  // ten seconds and worse under the load the recents storm created, which is
  // the "the images don't load" in the report. When a picture is already up,
  // the honest thing is to leave it there until its replacement is decoded and
  // fitted (`revealImage`), so the viewer always shows a real photo.
  if (!imageMeasured()) {
    ui.imgMode = "loading";
    ui.imgCanvasHidden = true;
    ui.imgElHidden = true;
  }
  void buildPhotoQueue(path, keepPhotoQueue); // gallery-001: sibling Prev/Next, derived fresh

  let src: string;
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    src = convertFileSrc(path);
  } catch {
    if (token === imgToken) showImageError();
    return;
  }
  if (token !== imgToken) return;

  // perf-007: show the browser-rendered <img> FIRST. Chromium streams and animates
  // a GIF/WebP/APNG itself, so the picture is up in ~40 ms — the same as a still.
  // The frame-accurate decode (whole-file read + every frame to an ImageBitmap,
  // ~276 ms on a 3.6 MB 200-frame GIF) then runs in the background and swaps the
  // canvas in when it is ready. Before this the viewer waited on that decode with
  // nothing on screen, which is what made opening a GIF feel slow.
  await showNativeImage(src, token);
  if (token !== imgToken) return;
  // Let the paint land before the decode takes the main thread.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  if (token !== imgToken) return;
  await tryDecodeAnimation(path, token);
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
    perfMark("image.read", String(status.size)); // whole-file IPC read
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
      if (token !== imgToken) {
        for (const f of frames) f.bitmap.close();
        decoder.close();
        return false;
      }
    }
    decoder.close();
    perfMark("image.decoded", String(frames.length)); // all frames decoded
    if (frames.length === 0) return false;

    imgFrames = frames;
    imgDurations = normalizeFrameDurations(frames.map((f) => f.duration));
    imgTotal = animationDuration(imgDurations);
    // perf-007: the browser-rendered <img> has been animating this whole time, so
    // pick the canvas up where it has got to rather than snapping back to frame 0.
    const elapsedS = (performance.now() - imgNativeShownAt) / 1000;
    imgClock = imgTotal > 0 ? loopedTime(elapsedS, imgTotal) : 0;
    imgFrameIndex = imgDurations.length > 0 ? frameIndexAtTime(imgDurations, imgClock) : 0;
    imgRate = 1;
    ui.imgRateLabel = "1×";
    ui.imgCanvasHidden = false;
    ui.imgElHidden = true;
    ui.imgErrorHidden = true;
    drawGifFrame(imgFrameIndex);

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
async function showNativeImage(src: string, token: number): Promise<void> {
  // perf-007: resolves once the picture is actually up (or has failed), so the
  // caller can hold the heavy frame decode back until then. The decode reads the
  // whole file and base64-decodes it on the main thread, which otherwise delays
  // this very paint -- measured at 108 ms for a 3.6 MB GIF, versus 40 ms when the
  // decode waits its turn.
  //
  // perf-010: the picture is loaded into a DETACHED image first and only handed
  // to the live element once it is decoded and its fit is known. Assigning `src`
  // to the live element up front caused two of the three defects in the report:
  //
  //   * THE UNFITTED FLASH. `resetImageTransform` is { zoom: 1, mode: "fit" } --
  //     the mode says fit, the scale says 100% -- because the real fit cannot be
  //     computed until the natural size is known. The natural size arrives with
  //     `onload`, but Chromium can PAINT a large progressive JPEG before then,
  //     so a 3406x5897 photo got painted at actual size in a ~1660x1000
  //     viewport and snapped down to 17% a frame or two later. Caught in the
  //     reproduction's own UI state: the zoom readout read 100% with the fit
  //     button lit (docs/evidence/photoscroll-02-during-burst.png).
  //   * THE BLANK VIEWER. The live element stops painting the old picture as
  //     soon as a new `src` is assigned, so the viewer went empty for the whole
  //     load and decode.
  //
  // Loading off to the side fixes both at once: the previous photo stays up,
  // and the frame that first shows the new one already carries its fit.
  const probe = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    probe.onload = () => resolve(true);
    probe.onerror = () => resolve(false);
    probe.src = src;
  });
  if (token !== imgToken) return;
  if (!loaded || probe.naturalWidth === 0) {
    showImageError();
    return;
  }
  // Best-effort, and deliberately not fatal: getting the decode done here keeps
  // the frame that reveals the picture from also being the frame that decodes
  // it. A rejected decode only means the paint does that work, which is what
  // always used to happen.
  await probe.decode().catch(() => {});
  if (token !== imgToken) return;
  perfMark("image.shown", `native ${probe.naturalWidth}x${probe.naturalHeight}`); // perf-005
  imgNativeShownAt = performance.now(); // perf-007: handover reference point
  revealImage(src, probe.naturalWidth, probe.naturalHeight);
}

/**
 * Put a loaded, decoded picture on screen already fitted (perf-010).
 *
 * Everything here happens in ONE synchronous block on purpose. img-001 sizes the
 * surface to the picture's natural pixels so that the transform's scale is an
 * absolute zoom, which means the element's size and the transform have to agree
 * or the zoom readout is a lie and the picture is the wrong size on screen.
 * Resetting the framing, installing the new size, fitting it, and assigning the
 * src in the same task denies the browser any frame boundary in which to paint a
 * half-applied state.
 */
function revealImage(src: string, width: number, height: number): void {
  // img-001: a new photo never inherits the last one's framing. This is the
  // reset that used to sit at the top of `openImage`, moved to the one moment
  // where dropping the old transform cannot be seen.
  imgTransform = resetImageTransform();
  setImageNaturalSize(width, height); // sizes the surface AND applies the fit
  // Observability, and it checks a real assumption rather than restating one:
  // `image.shown` is marked when the DETACHED probe finished, which says
  // nothing about the live element. This src is expected to be a cache hit off
  // the probe's own fetch, so this mark should land within a frame or two of
  // the reveal. If it ever drifts out to the probe's own load time, the asset
  // protocol has stopped being cacheable and this reveal is paying for a second
  // fetch and decode -- in which case the decoded bitmap should be handed over
  // directly instead (via the canvas tier) rather than re-requested by URL.
  if (perfEnabled()) {
    const at = performance.now();
    imgEl.addEventListener(
      "load",
      () => perfMark("image.painted", (performance.now() - at).toFixed(1)),
      { once: true },
    );
  }
  imgEl.src = src; // already loaded and decoded: a cache hit, not a second decode
  ui.imgMode = "native";
  ui.imgCanvasHidden = true;
  ui.imgElHidden = false;
  ui.imgErrorHidden = true;
}

/** Clear, honest error state for a corrupt / unsupported image. */
function showImageError(): void {
  ui.imgMode = "error";
  ui.imgCanvasHidden = true;
  ui.imgElHidden = true;
  imgEl.removeAttribute("src");
  ui.imgErrorHidden = false;
  cancelImageIdle(); // img-001: never fade the chrome over an error message
}

// ---------------------------------------------------------------------------
// Image transform tools (img-001)
//
// Zoom / pan / rotate / flip for the photo viewer. The arithmetic all lives in
// player-core (fitScale, zoomImageAt, clampImagePan, ...); this half owns the
// live value, the DOM it is written to, and the gestures that drive it.
//
// The transform is a plain module variable rather than reactive state: it is
// rewritten on every wheel tick and every pointer move while dragging, and
// waking the reactive graph at that rate to re-render a toolbar that has not
// changed is waste. `syncImageToolsUi` pushes the few values the toolbar
// actually shows into `ui` after each change.
//
// Both render tiers — the frame-decoded <canvas> and the native <img> — sit
// inside ONE wrapper (`els.imgSurface`) that carries the CSS transform, so a
// zoomed GIF keeps animating and the two tiers can never drift apart.
// ---------------------------------------------------------------------------

let imgTransform: ImageTransform = resetImageTransform();
/** The picture's intrinsic pixel size; (0,0) until a tier reports it. */
let imgNatural: ImageSize = { width: 0, height: 0 };
/** Watches the viewer box so "fit" re-fits when the window resizes. */
let imgResizeObserver: ResizeObserver | undefined;

/**
 * The box the picture is fitted into: the viewer's CONTENT box, in CSS pixels,
 * with its origin in viewport coordinates.
 *
 * The padding matters and must be subtracted. `.imgview__viewer` carries
 * `padding: 84px 48px 96px`, and that padding is the only thing keeping the
 * picture clear of the ABSOLUTELY POSITIONED header above it and the tools bar
 * below. Measuring the border box (what getBoundingClientRect returns) fitted
 * the picture to the whole window instead, so a fitted photo ran underneath
 * both — caught in the first smoke run, where the fitted picture reached the
 * top and bottom edges of the window.
 *
 * The ORIGIN is returned alongside the size because the two must agree: flex
 * centring puts the picture at the middle of the CONTENT box, so a cursor
 * anchor has to be measured from that same origin. The padding is asymmetric
 * (84 above, 96 below), so mixing the two origins would bias every zoom.
 */
function imageViewportRect(): { left: number; top: number; width: number; height: number } {
  const el = els.imgViewer;
  if (!el) return { left: 0, top: 0, width: 0, height: 0 };
  const box = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const pl = parseFloat(cs.paddingLeft) || 0;
  const pr = parseFloat(cs.paddingRight) || 0;
  const pt = parseFloat(cs.paddingTop) || 0;
  const pb = parseFloat(cs.paddingBottom) || 0;
  return {
    left: box.left + pl,
    top: box.top + pt,
    width: Math.max(0, box.width - pl - pr),
    height: Math.max(0, box.height - pt - pb),
  };
}

/** The size of that box — what every fit and clamp is measured against. */
function imageViewport(): ImageSize {
  const r = imageViewportRect();
  return { width: r.width, height: r.height };
}

/** True once a tier has reported the picture's real size — every gesture is a
 *  no-op before that, since none of the geometry means anything yet. */
function imageMeasured(): boolean {
  return imgNatural.width > 0 && imgNatural.height > 0;
}

/** Push the derived toolbar values into reactive state. */
function syncImageToolsUi(): void {
  const view = imageViewport();
  ui.imgZoomLabel = `${imageZoomPercent(imgTransform)}%`;
  ui.imgCanPan = imageMeasured() && canPanImage(imgTransform, imgNatural, view);
  ui.imgAtFit = imgTransform.mode === "fit";
  ui.imgRotation = imgTransform.rotation;
  ui.imgFlipH = imgTransform.flipH;
  ui.imgFlipV = imgTransform.flipV;
}

/** Write the current transform to the DOM and refresh the toolbar. */
function applyImageTransform(): void {
  const surface = els.imgSurface;
  if (surface) surface.style.transform = imageTransformCss(imgTransform);
  syncImageToolsUi();
}

/** Replace the transform, clamping the pan, and paint it. */
function setImageTransform(next: ImageTransform): void {
  imgTransform = imageMeasured() ? clampImagePan(next, imgNatural, imageViewport()) : next;
  applyImageTransform();
}

/**
 * Record the picture's intrinsic size and fit it to the window.
 *
 * The surface is sized to the picture's REAL pixels so the transform's scale is
 * an absolute zoom — that is what makes "100%" mean 100% and the readout
 * honest. Both tiers call this; they describe the same picture, so a second
 * call with the same size is a no-op beyond re-fitting.
 */
function setImageNaturalSize(width: number, height: number): void {
  if (!(width > 0) || !(height > 0)) return;
  imgNatural = { width, height };
  const surface = els.imgSurface;
  if (surface) {
    surface.style.width = `${width}px`;
    surface.style.height = `${height}px`;
  }
  setImageTransform(fitImage(imgTransform, imgNatural, imageViewport()));
}

/**
 * Drop every transform back to a clean fit.
 *
 * Called on each new photo: carrying a 400% zoom or a 90-degree turn into the
 * next picture would ambush the reader, who asked for THIS photo, not for the
 * last one's framing.
 */
function resetImageTools(): void {
  imgTransform = resetImageTransform();
  imgNatural = { width: 0, height: 0 };
  resetImageGestures();
  const surface = els.imgSurface;
  if (surface) {
    surface.style.width = "";
    surface.style.height = "";
  }
  applyImageTransform();
}

/**
 * Drop any in-progress pointer gesture, without touching the framing (perf-010).
 *
 * Opening the next photo needs exactly this much of the reset and no more: a
 * drag belongs to the picture it started on, but clearing the transform and the
 * surface size while the previous picture is still on screen is what made the
 * outgoing photo jump to 100% on every arrow key. `revealImage` does the
 * framing half, at the moment it cannot be seen.
 */
function resetImageGestures(): void {
  imgDragging = false;
  imgDragMoved = false;
  imgDragPointer = null;
}

/** Re-fit (or re-clamp) after the viewer box changes size. */
function onImageViewportResize(): void {
  if (!imageViewActive() || !imageMeasured()) return;
  const view = imageViewport();
  setImageTransform(
    imgTransform.mode === "fit" ? fitImage(imgTransform, imgNatural, view) : imgTransform,
  );
}

/** Watch the viewer box (window resize, fullscreen, chrome changes). */
function observeImageViewport(): void {
  const viewer = els.imgViewer;
  if (!viewer || typeof ResizeObserver === "undefined") return;
  imgResizeObserver?.disconnect();
  imgResizeObserver = new ResizeObserver(() => onImageViewportResize());
  imgResizeObserver.observe(viewer);
}

/** A pointer position in viewer coordinates — the anchor every zoom is taken
 *  about. Falls back to the viewer's centre when there is no pointer (keyboard
 *  zoom, toolbar buttons). */
/** Anything carrying viewport coordinates — a real MouseEvent, or the plain
 *  {clientX, clientY} the deferred click handler saves off. */
type ClientPoint = { clientX: number; clientY: number };

function imagePointFromEvent(e: ClientPoint | null): { x: number; y: number } {
  const r = imageViewportRect();
  if (!e) return { x: r.width / 2, y: r.height / 2 };
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// --- Gestures ---------------------------------------------------------------

/** Wheel over the picture: continuous zoom anchored at the cursor. */
export function onImageWheel(e: WheelEvent): void {
  if (!imageMeasured()) return;
  // The viewer never scrolls, so the wheel is unambiguously a zoom here.
  e.preventDefault();
  showImageChrome();
  setImageTransform(
    zoomImageAt(
      imgTransform,
      imgNatural,
      imageViewport(),
      wheelZoomTarget(imgTransform.zoom, e.deltaY),
      imagePointFromEvent(e),
    ),
  );
}

let imgDragging = false;
/** Whether this drag travelled far enough to be a pan rather than a click. */
let imgDragMoved = false;
let imgDragPointer: number | null = null;
let imgDragLast = { x: 0, y: 0 };
/** Pointer travel, in CSS pixels, past which a press is a drag and its trailing
 *  click is suppressed. Small enough that a deliberate drag always registers,
 *  large enough to survive the hand-wobble in an ordinary click. */
const IMAGE_DRAG_SLOP = 4;

export function onImagePointerDown(e: PointerEvent): void {
  // Cleared FIRST, ahead of every guard below. A drag whose release lands
  // outside the picture fires no click, so the "swallow the click that ended a
  // pan" flag would otherwise still be set when the next, unrelated click
  // arrives — and that click would vanish.
  imgDragMoved = false;
  // Left button only: the middle button is a paste on some systems and the
  // right one belongs to the context menu.
  if (e.button !== 0 || !imageMeasured()) return;
  if (!canPanImage(imgTransform, imgNatural, imageViewport())) return;
  imgDragging = true;
  imgDragPointer = e.pointerId;
  imgDragLast = { x: e.clientX, y: e.clientY };
  // Capture so a fast drag that leaves the window still delivers its moves and
  // its release — without it the picture sticks to the cursor.
  (e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId);
}

export function onImagePointerMove(e: PointerEvent): void {
  if (!imgDragging || e.pointerId !== imgDragPointer) return;
  const dx = e.clientX - imgDragLast.x;
  const dy = e.clientY - imgDragLast.y;
  imgDragLast = { x: e.clientX, y: e.clientY };
  if (Math.abs(dx) > IMAGE_DRAG_SLOP || Math.abs(dy) > IMAGE_DRAG_SLOP) imgDragMoved = true;
  setImageTransform(panImageBy(imgTransform, dx, dy, imgNatural, imageViewport()));
}

export function onImagePointerUp(e: PointerEvent): void {
  if (e.pointerId !== imgDragPointer) return;
  (e.currentTarget as Element | null)?.releasePointerCapture?.(e.pointerId);
  imgDragging = false;
  imgDragPointer = null;
  // `imgDragMoved` is read by the click handler that fires straight after this,
  // then cleared there.
}

// --- Commands (toolbar buttons + hotkeys) -----------------------------------

/** Zoom one ladder stop, about the cursor if there is one. */
export function doImageZoomStep(dir: number, e?: ClientPoint | null): void {
  if (!imageMeasured()) return;
  setImageTransform(
    zoomImageAt(
      imgTransform,
      imgNatural,
      imageViewport(),
      stepImageZoom(imgTransform.zoom, dir),
      imagePointFromEvent(e ?? null),
    ),
  );
}

/** Fit the picture to the window (the 0 key / the fit button). */
export function doImageFit(): void {
  if (!imageMeasured()) return;
  setImageTransform(fitImage(imgTransform, imgNatural, imageViewport()));
}

/** True pixel size (the 1 key), about the centre. */
export function doImageActualSize(): void {
  if (!imageMeasured()) return;
  setImageTransform(
    zoomImageAt(imgTransform, imgNatural, imageViewport(), 1, imagePointFromEvent(null)),
  );
}

/** The click / fit button toggle: fit becomes 100%, anything else returns to fit. */
export function doImageToggleFit(e?: ClientPoint | null): void {
  if (!imageMeasured()) return;
  setImageTransform(
    toggleImageFit(imgTransform, imgNatural, imageViewport(), imagePointFromEvent(e ?? null)),
  );
}

/** Turn a quarter: +1 clockwise, -1 anticlockwise. View-only — the file on disk
 *  is never touched. */
export function doImageRotate(dir: number): void {
  if (!imageMeasured()) return;
  setImageTransform(rotateImageBy(imgTransform, dir >= 0 ? 90 : -90, imgNatural, imageViewport()));
}

/** Mirror about the picture's own horizontal / vertical axis. View-only. */
export function doImageFlip(axis: "h" | "v"): void {
  if (!imageMeasured()) return;
  setImageTransform(flipImage(imgTransform, axis));
}

/** Arrow-key pan, one nudge. */
function doImagePan(dx: number, dy: number): void {
  if (!imageMeasured()) return;
  setImageTransform(panImageBy(imgTransform, dx, dy, imgNatural, imageViewport()));
}

/** Whether the arrows should pan rather than step to the next photo — true only
 *  when part of the picture is actually off-screen. */
function imageArrowsPan(): boolean {
  return imageMeasured() && canPanImage(imgTransform, imgNatural, imageViewport());
}

/** One arrow-key pan nudge, in CSS pixels. */
const IMAGE_PAN_STEP = 60;

// --- Chrome auto-hide -------------------------------------------------------
//
// Mirrors the player's `showControls` (the `idle` flag + a `data-idle`
// attribute that fades the chrome and hides the cursor). It cannot reuse it:
// the player's version only hides while a video is PLAYING, a condition that
// means nothing for a still photograph.

let imgIdleTimer: number | undefined;
/** How long the mouse must sit still before the photo is left alone. */
const IMAGE_IDLE_MS = 2600;

/** Show the image chrome and restart the idle countdown. */
export function showImageChrome(): void {
  ui.imgIdle = false;
  window.clearTimeout(imgIdleTimer);
  imgIdleTimer = window.setTimeout(() => {
    // Never hide the chrome out from under a pointer that is mid-drag, and
    // never on the error state, where the chrome is the only thing to read.
    if (imageViewActive() && !imgDragging && ui.imgMode !== "error") ui.imgIdle = true;
  }, IMAGE_IDLE_MS);
}

/** Stop the countdown and bring the chrome back (leaving the view, opening a
 *  new photo, hitting an error). */
function cancelImageIdle(): void {
  window.clearTimeout(imgIdleTimer);
  ui.imgIdle = false;
}

// ---------------------------------------------------------------------------
// Image file actions (img-002)
//
// Copy the picture, reveal it on disk, and report what is known about it. The
// three actions the transform tools (img-001) do not cover, because they act on
// the FILE rather than on the view of it.
// ---------------------------------------------------------------------------

/**
 * The pixels to copy, as an untainted source.
 *
 * The frame-decoded canvas is used directly when it is the visible tier: it
 * already holds exactly the frame on screen (which is the right answer for an
 * animated image), and it was painted from bytes this app read itself, so it is
 * not tainted.
 *
 * The <img> tier cannot be used that way. It loads through the asset protocol,
 * a different origin, which TAINTS any canvas it is drawn into — `toBlob` on
 * that canvas throws a SecurityError. So the still path re-reads the file and
 * decodes it here, where the bytes are our own and the canvas stays clean.
 */
async function currentImagePixels(): Promise<CanvasImageSource | null> {
  if (!ui.imgCanvasHidden && imgCanvas.width > 0) return imgCanvas;
  if (ui.imgElHidden || imgEl.naturalWidth === 0 || !currentPath) return null;
  const status = await tauriInvoke<StreamStatus>("stream_status", { path: currentPath }).catch(
    () => null,
  );
  if (!status || status.size <= 0 || status.size > IMAGE_MAX_BYTES) return null;
  const bytes = await readWholeFile(currentPath, status.size);
  if (bytes.length === 0) return null;
  return await createImageBitmap(new Blob([bytes as BlobPart]));
}

/**
 * Copy the picture to the clipboard.
 *
 * Orientation is baked in, so what is pasted matches what is on screen: a photo
 * turned on its side copies turned. Zoom and pan are NOT baked in — they are
 * where the reader is looking, not what the picture is, so the copy is of the
 * whole photograph at its own resolution. An animated image copies the frame
 * currently displayed.
 *
 * The picture is encoded to PNG here and crosses to the native side as base64.
 * Handing the clipboard plugin raw RGBA instead means a `Uint8Array` argument,
 * which arrives on WebView2 as a JSON `number[]` — 38 million elements for a
 * 4000x2400 photograph, measured at about six seconds for one copy. Base64 is
 * the same transport `read_stream_chunk` already uses, for the same reason.
 */
export async function doImageCopy(): Promise<void> {
  if (!actions.copyImage) return; // android-001: no image clipboard on this platform
  if (!imageMeasured()) return;
  try {
    const src = await currentImagePixels();
    if (!src) return;
    const out = rotatedSize(imgNatural, imgTransform.rotation);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(out.width);
    canvas.height = Math.round(out.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.setTransform(
      ...orientationDrawMatrix(
        imgNatural,
        imgTransform.rotation,
        imgTransform.flipH,
        imgTransform.flipV,
      ),
    );
    ctx.drawImage(src, 0, 0, imgNatural.width, imgNatural.height);
    if (src instanceof ImageBitmap) src.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
    if (!blob) throw new Error("could not encode the picture");
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("could not read the picture"));
      reader.readAsDataURL(blob);
    });
    await tauriInvoke("copy_image_to_clipboard", {
      pngBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    });
    flashImageAction("Copied");
  } catch (err) {
    // Reported HERE rather than through showError, which writes to ui.emptyError
    // — a field only the empty/home surface renders, so a failure in the image
    // viewer would be completely invisible to the reader.
    flashImageAction("Could not copy this image");
    console.error("copy image", err);
  }
}

/** Open the containing folder with this photo selected. */
export async function doImageReveal(): Promise<void> {
  if (!actions.reveal) return; // android-001
  if (!currentPath) return;
  // gallery-004: a page browsed from inside an archive lives in the thumbnail
  // cache. Reveal the ARCHIVE, which is the file the reader actually has.
  const target = revealTargetPath(currentPath, currentArchiveOrigin);
  try {
    await tauriInvoke("reveal_in_explorer", { path: target });
  } catch (err) {
    showError(`Could not open the folder: ${String(err)}`);
  }
}

/** The authoritative armed delete. `ui.imgDeleteArmed` is only its render. */
let deleteArm: DeleteArm | null = null;
let deleteArmTimer: number | undefined;

/** Drop the arm and its render. Called on expiry and after a delete lands. */
function disarmDelete(): void {
  deleteArm = null;
  ui.imgDeleteArmed = false;
  window.clearTimeout(deleteArmTimer);
  deleteArmTimer = undefined;
}

/**
 * Delete the photo on screen, to the Recycle Bin (img-003).
 *
 * Two presses, not a dialog: `window.confirm` shows nothing in this WebView2
 * build and returns true, so a single press behind one would destroy the file
 * having asked nothing. The first press arms and says so on the button; the
 * second, while still armed FOR THIS FILE, does it.
 *
 * Nothing here deletes a page inside an archive: that would mean rewriting the
 * user's .zip, which is not what this button promises.
 */
export async function doImageDelete(): Promise<void> {
  if (!actions.delete) return; // android-001: no Recycle Bin on this platform
  if (!currentPath) return;
  if (currentArchiveOrigin) {
    flashImageAction("A picture inside an archive cannot be deleted.");
    return;
  }
  const key = deleteArmKey("", currentPath);
  const name = basename(currentPath);

  if (!isArmedFor(deleteArm, key, Date.now())) {
    deleteArm = armDelete(key, Date.now(), DELETE_ARM_MS);
    ui.imgDeleteArmed = true;
    flashImageAction(`Press Delete again to move ${name} to the Recycle Bin.`);
    window.clearTimeout(deleteArmTimer);
    deleteArmTimer = window.setTimeout(disarmDelete, DELETE_ARM_MS);
    return;
  }

  const doomed = currentPath;
  disarmDelete();
  try {
    await tauriInvoke("recycle_file", { path: doomed });
  } catch (err) {
    showError(`Could not delete that file: ${String(err)}`);
    return;
  }
  perfMark("image.deleted", name);

  // Work out where to land BEFORE mutating the queue, then hand off to
  // stepPhoto — the same helper doNextPhoto and doPrevPhoto use, so the
  // viewer, title and counter update exactly as they do for any other
  // navigation. stepPhoto sets ui.photoIndex itself; do not set it here too.
  const at = ui.photoQueue.findIndex((q) => q.path === doomed);
  if (at < 0) {
    // The queue never held it (a single file opened directly). Nothing to
    // advance to.
    goBack();
    return;
  }
  const next = indexAfterDelete(at, ui.photoQueue.length);
  ui.photoQueue.splice(at, 1);

  if (next < 0) {
    // That was the last picture in the folder — there is nothing to show.
    goBack();
    return;
  }
  await stepPhoto(next);
  flashImageAction(`${name} moved to the Recycle Bin.`);
}

/** What the native side reports about the file itself. */
interface NativeImageInfo {
  sizeBytes: number;
  camera?: string | null;
  taken?: string | null;
  exposure?: string | null;
  aperture?: string | null;
  iso?: string | null;
}

/**
 * Toggle the info panel, loading its contents the first time it is opened for
 * a given photo.
 *
 * Dimensions and format come from what is already on screen; only the file size
 * and the EXIF need the native side, so the panel opens immediately with the
 * half it can answer at once and fills the rest in when it arrives.
 */
export async function doImageInfo(): Promise<void> {
  if (ui.imgInfoOpen) {
    ui.imgInfoOpen = false;
    return;
  }
  if (!imageMeasured()) return;
  ui.imgInfoOpen = true;
  ui.imgInfoRows = [
    { label: "Dimensions", value: `${imgNatural.width} × ${imgNatural.height}` },
    { label: "Format", value: (fileExtension(currentPath ?? "") || "image").toUpperCase() },
  ];
  if (!currentPath) return;
  const token = imgToken;
  const target = revealTargetPath(currentPath, currentArchiveOrigin);
  // The archive itself is the file on disk, so its size is the honest answer for
  // a page browsed inside one; its EXIF is simply absent, which the panel omits.
  const info = await tauriInvoke<NativeImageInfo>("image_info", { path: target }).catch(() => null);
  if (!info || token !== imgToken || !ui.imgInfoOpen) return;
  const rows = [...ui.imgInfoRows];
  const size = formatFileSize(info.sizeBytes);
  if (size) rows.push({ label: "File size", value: size });
  for (const [label, value] of [
    ["Camera", info.camera],
    ["Taken", info.taken],
    ["Exposure", info.exposure],
    ["Aperture", info.aperture],
    ["ISO", info.iso],
  ] as const) {
    if (value) rows.push({ label, value });
  }
  ui.imgInfoRows = rows;
  // tags-001: what this picture is tagged as, without opening the popover. Last
  // row on purpose — it is the only one that can change while the panel is open.
  const id = tagIdentity(currentPath, currentArchiveOrigin);
  const tags = await tauriInvoke<string[]>("tags_for_item", {
    archive: id.archive,
    path: id.path,
  }).catch(() => [] as string[]);
  if (token !== imgToken || !ui.imgInfoOpen) return;
  if (tags.length > 0) {
    rows.push({ label: "Tags", value: tags.join(", ") });
    // A fresh array, not a mutation of the one already assigned: ui is a $state
    // proxy, and pushing to the raw local array it wraps changes the data
    // without notifying anything, so the panel would never re-render.
    ui.imgInfoRows = [...rows];
  }
  // The panel's whole point is WHICH rows are there — a picture with no EXIF
  // must not grow camera rows out of nothing. Emitting the labels makes that
  // exactly assertable by the smoke, instead of leaving it to be guessed at
  // from how tall the panel looks (perf-004's trace, as the gallery smokes use).
  perfMark("image.info", rows.map((r) => r.label).join("|"));
}

/** Brief confirmation over the picture, for an action with no visible result of
 *  its own (copying changes nothing on screen, so without this it is impossible
 *  to tell whether the button did anything). */
let imgActionFlashTimer: number | undefined;
function flashImageAction(text: string): void {
  ui.imgActionFlash = text;
  window.clearTimeout(imgActionFlashTimer);
  imgActionFlashTimer = window.setTimeout(() => {
    ui.imgActionFlash = "";
  }, 1400);
}

// ---------------------------------------------------------------------------
// Tags (tags-001)
// ---------------------------------------------------------------------------
// The store is native (SQLite, src-tauri/src/tags.rs). Everything here is glue:
// work out WHICH item the user means from the active view, call the command, and
// render exactly what Rust returns. No local tag cache — the popover is open for
// seconds at a time and the round trip is an indexed lookup.

/** The item the active view is showing, or null when nothing is taggable. */
function currentTagTarget(): TagTarget | null {
  if (imageViewActive() && currentPath) {
    const id = tagIdentity(currentPath, currentArchiveOrigin);
    return { ...id, kind: "image", name: basename(currentPath) };
  }
  if (playerVisible() && currentPath) {
    const id = tagIdentity(currentPath, currentArchiveOrigin);
    return { ...id, kind: "video", name: basename(currentPath) };
  }
  if (ui.view === "gallery") {
    // -1 means no tile has ever been focused (ux-004: the grid's cursor starts
    // unset). Tagging tile 0 on a hunch would tag something the user never
    // pointed at, in a folder that may hold thousands — decline instead. Every
    // real entry point sets the cursor first: the arrow keys move it, and the
    // tile's own tag button sets it before opening the popover.
    if (ui.galleryIndex < 0) return null;
    // tags-002: ui.galleryIndex is ABSOLUTE (see enqueueThumb) — offset it back to
    // a position within the windowed ui.galleryItems. Load-bearing now that the
    // window (Task 12) slides: an unoffset read would tag whatever landed at
    // that array position instead of the tile the user actually pointed at.
    const item = ui.galleryItems[ui.galleryIndex - ui.galleryWindowStart];
    // tags-002 fix-1: a pending tile has no real identity yet (its `path` is a
    // synthetic "pending:N" marker) — decline rather than let the popover
    // open against it. tags-003: a hidden tile is a blacklisted item the grid
    // deliberately renders as nothing (Gallery.svelte) — the cursor can still
    // land on it via an arrow-key step across a run of hidden slots, and
    // tagging it would act on an item the user cannot see. Same silent
    // decline as `pending`, for the same reason.
    if (!item || item.pending || item.hidden) return null;
    return { archive: item.archive, path: item.path, kind: item.kind, name: item.name };
  }
  return null;
}

/** Open the popover for whatever the active view is showing. */
export function openTagPopover(): void {
  const target = currentTagTarget();
  if (!target) return;
  ui.tagTarget = target;
  ui.tagTargetTags = [];
  ui.tagDraft = "";
  ui.tagSuggestions = [];
  ui.tagSuggestIndex = -1;
  ui.tagError = "";
  ui.tagPopoverOpen = true;
  perfMark("tags.open", `${target.kind}:${target.name}`);
  void refreshTargetTags();
  void refreshSuggestions("");
}

export function closeTagPopover(): void {
  if (!ui.tagPopoverOpen) return;
  ui.tagPopoverOpen = false;
  ui.tagTarget = null;
  ui.tagDraft = "";
  ui.tagSuggestions = [];
  ui.tagError = "";
  perfMark("tags.close");
}

async function refreshTargetTags(): Promise<void> {
  const target = ui.tagTarget;
  if (!target) return;
  const tags = await tauriInvoke<string[]>("tags_for_item", {
    archive: target.archive,
    path: target.path,
  }).catch(() => null);
  // A target change while the call was in flight must not overwrite the new one.
  if (!tags || ui.tagTarget !== target) return;
  ui.tagTargetTags = tags;
  // The smoke reads this: it is the machine-readable proof of WHICH tags an item
  // carries, rather than a guess from how wide the chip row looks.
  perfMark("tags.list", tags.join("|"));
}

async function refreshSuggestions(prefix: string): Promise<void> {
  const suggestions = await tauriInvoke<{ name: string; count: number }[]>("tag_suggest", {
    prefix,
    limit: 20,
  }).catch(() => null);
  if (!suggestions || !ui.tagPopoverOpen) return;
  ui.tagSuggestions = suggestions;
  // -1, not 0: nothing is highlighted until the user explicitly arrows onto a
  // row. With a row pre-highlighted, Enter pressed straight after opening would
  // apply the library's most-used tag to whatever happens to be on screen.
  ui.tagSuggestIndex = -1;
}

/** Field input: re-query suggestions against the token being typed. */
export function onTagDraftInput(value: string): void {
  ui.tagDraft = value;
  ui.tagError = "";
  const token = value.split(",").pop() ?? "";
  void refreshSuggestions(token.trim());
}

/** Apply every tag in the draft (commas separate). */
export async function commitTagDraft(): Promise<void> {
  const tags = cleanTagDraft(ui.tagDraft);
  if (tags.length === 0) return;
  const target = ui.tagTarget;
  if (!target) return;
  const failed: string[] = [];
  let reason = "";
  for (const tag of tags) {
    const err = await applyOne(tag, target);
    if (err) {
      failed.push(tag);
      reason = err;
    }
  }
  // The popover may have moved on, or closed, while the batch was applying.
  if (ui.tagTarget !== target) return;
  // Keep the refused tags in the field so they can be corrected, and clear the
  // ones that saved. A batch that reports nothing when its third tag was
  // refused is lying by omission.
  ui.tagDraft = failed.join(", ");
  ui.tagError = failed.length === 0 ? "" : reason;
  void refreshSuggestions("");
}

/** Apply the highlighted suggestion (Enter on the list, or a click). */
export async function applySuggestion(name: string): Promise<void> {
  const target = ui.tagTarget;
  if (!target) return;
  const err = await applyOne(name, target);
  if (ui.tagTarget !== target) return;
  ui.tagError = err;
  ui.tagDraft = "";
  void refreshSuggestions("");
}

/** Apply one tag to `target`. Returns "" on success, or the reason it was
 *  refused — the CALLER decides what to surface, because a multi-tag commit must
 *  not let the last tag's outcome erase an earlier one's failure.
 *
 *  The target is a PARAMETER, not re-read from `ui`: a batch captures it once and
 *  every tag in that batch must land on the item the user pointed at. Re-reading
 *  here meant that a popover which closed and reopened on another item between
 *  two round trips wrote the remaining tags to the NEW item — and `tag_apply`
 *  does a blocking `fs::metadata` first, so a network share widens that window
 *  to seconds. */
async function applyOne(tag: string, target: TagTarget): Promise<string> {
  try {
    const tags = await tauriInvoke<string[]>("tag_apply", {
      archive: target.archive,
      path: target.path,
      kind: target.kind,
      name: target.name,
      sortKey: naturalSortKey(target.name),
      tag,
    });
    perfMark("tags.apply", `${tag}=>${tags.join("|")}`);
    // tags-003: applying a (possibly blacklisted) tag can change what browsing
    // hides. Refresh unconditionally on success — the popover-target check
    // below is only about whether the POPOVER still cares, not whether the
    // backend mutation happened.
    void refreshHiddenKeys();
    // The popover may have moved to another item while this was in flight.
    if (ui.tagTarget !== target) return "";
    ui.tagTargetTags = tags;
    return "";
  } catch (err) {
    const reason = String(err);
    perfMark("tags.reject", reason);
    return reason;
  }
}

export async function removeTagFromTarget(tag: string): Promise<void> {
  const target = ui.tagTarget;
  if (!target) return;
  const tags = await tauriInvoke<string[]>("tag_unapply", {
    archive: target.archive,
    path: target.path,
    tag,
  }).catch(() => null);
  if (!tags) return; // the call failed -- nothing changed, nothing to refresh
  // tags-003: removing the last blacklisted tag can bring this item back —
  // refresh unconditionally on success, same reasoning as applyOne above.
  void refreshHiddenKeys();
  if (ui.tagTarget !== target) return;
  ui.tagTargetTags = tags;
  perfMark("tags.remove", `${tag}=>${tags.join("|")}`);
}

/** One member of a tag as the store returns it (tags-002). */
interface TaggedItem {
  archive: string;
  path: string;
  kind: GalleryItem["kind"];
  name: string;
  missing: boolean;
}

/** The tag's members by ABSOLUTE index, sparse: only fetched pages are filled.
 *  This is the tag itself; `ui.galleryItems` is only the slice currently in the
 *  DOM. Anything that needs "the whole tag" (sibling navigation, the window)
 *  reads this, never `ui.galleryItems` (tags-002). */
let tagRows: (TaggedItem | undefined)[] = [];
/** Pages already fetched, so scrolling back over one costs no round trip. */
let tagPagesLoaded = new Set<number>();
/** Tiles kept in the DOM at once. Bounded regardless of how large the tag is.
 *  `TAG_VIEW_CAP` (player-core.ts) stays exported and documented as the
 *  fallback this replaces — reverting is dropping this window and restoring
 *  the capped loop `openGalleryForTag` used to run. */
const TAG_WINDOW = 1500;

/** Fetch any page overlapping the absolute range [from, to) that is not loaded. */
async function ensurePages(tag: string, from: number, to: number, token: number): Promise<void> {
  const firstPage = pageForIndex(from, TAG_PAGE_SIZE);
  const lastPage = pageForIndex(Math.max(from, to - 1), TAG_PAGE_SIZE);
  for (let page = firstPage; page <= lastPage; page++) {
    if (tagPagesLoaded.has(page)) continue;
    const { offset, limit } = pageRange(page, TAG_PAGE_SIZE, tagRows.length);
    if (limit <= 0) continue;
    const res = await tauriInvoke<{ total: number; offset: number; items: TaggedItem[] }>(
      "tag_items",
      { tag, limit, offset },
    );
    if (galleryToken !== token) return;
    res.items.forEach((it, i) => {
      tagRows[offset + i] = it;
    });
    tagPagesLoaded.add(page);
    await authorizePageDirs(res.items);
    if (galleryToken !== token) return;
  }
}

/** Separates an item's archive from its path when the two are joined into one
 *  identity key (tags-002): a plain concatenation of archive+path could
 *  collide (archive "ab" + path "c" reads the same as archive "a" + path
 *  "bc"). Built with fromCharCode (U+0001, a control character that cannot
 *  appear in a real path) rather than a source-level unicode escape, which
 *  this editing toolchain was observed to mangle when typed directly. */
const TAG_ID_SEP = String.fromCharCode(1);

/** The identity key for a tag row or gallery tile: which archive it came from
 *  (or "" for a real on-disk file) plus its path. Used to carry a rendered
 *  thumbnail across a window slide (applyWindow) and to key the grid's
 *  each-block in Gallery.svelte on the item itself rather than its position. */
export function tagItemKey(archive: string, path: string): string {
  return archive + TAG_ID_SEP + path;
}

/**
 * Whether a tag's own view (grid AND queue) should apply the blacklist veto
 * (tags-003 final review, Finding 1).
 *
 * A blacklisted tag's own view is the one place a user goes to un-tag its
 * members -- filtering it would empty the grid and strand them there with no
 * way back. Every OTHER tag's view must still respect the veto, or
 * blacklisting silently fails to hide anything from any other tag's grid.
 *
 * This single predicate backs BOTH the grid path (`applyWindow`) and the
 * queue path (`buildPhotoQueue`'s tag branch, `extendPhotoQueueFromTag`) —
 * written once rather than twice so the two can never disagree about which
 * members of a tag are visible. Before this fix they did: the grid showed
 * every member while the queue quietly dropped the hidden ones, so a click on
 * a tile the queue had filtered out sent `byIdentity` to -1 and left
 * `photoIndex` pointing at the wrong photo.
 */
function shouldFilterTagView(tag: string): boolean {
  return !ui.tagBlacklist.includes(tag);
}

/** Move the DOM window so it covers `focus`, fetching whatever it now needs. */
async function applyWindow(tag: string, focus: number, token: number): Promise<void> {
  const { start, end } = windowBounds(tagRows.length, focus, TAG_WINDOW);
  await ensurePages(tag, start, end, token);
  if (galleryToken !== token) return;
  // applyWindow can run many times over one tag session (every scroll
  // re-centre, every keyboard step past the edge), and always minting fresh
  // GalleryItem objects would blank thumbSrc/durationLabel for a tile that
  // stays in the window across the call: its DOM node survives (the keyed
  // {#each} in Gallery.svelte matches it by identity), but the thumbnail
  // pipeline's IntersectionObserver is one-shot and never re-fires for a node
  // that was never unmounted -- so a reset thumbSrc would never get repainted.
  // Carrying forward the existing object for an identity already on screen
  // keeps that one-shot contract honest instead of fighting it.
  const carried = new Map<string, GalleryItem>();
  for (const it of ui.galleryItems) carried.set(tagItemKey(it.archive, it.path), it);
  ui.galleryWindowStart = start;
  // Built with an explicit loop rather than `tagRows.slice(start, end).map(...)`:
  // `tagRows` is a genuinely sparse array (`new Array(total)`, holes at every
  // index `ensurePages` has never written), and both `.slice` and `.map` follow
  // the spec's hole-skipping rule — `.map` never even INVOKES its callback for
  // an index that was never assigned, so the "undefined -> placeholder" branch
  // below could never fire on a real hole; the slot would just vanish from the
  // result instead (a Svelte `{#each}` gap, or a shifted/miscounted window).
  // Pushing into a plain array first makes every slot a real (if `undefined`)
  // element, so `.map` runs its callback for all of them.
  const windowSlice: (TaggedItem | undefined)[] = [];
  for (let idx = start; idx < end; idx++) windowSlice.push(tagRows[idx]);
  // tags-003 final review (Finding 1): filter this view UNLESS `tag` itself is
  // blacklisted — see shouldFilterTagView. Computed once per call, not per
  // item: it depends only on which tag this view is, not on the item.
  const filterThisView = shouldFilterTagView(tag);
  ui.galleryItems = windowSlice.map((it, i) => {
    if (!it) {
      // A row whose page is still in flight: render a placeholder rather than
      // blocking the whole window on one request. It fills in when the page
      // lands and the window is re-applied.
      return {
        path: "pending:" + (start + i),
        name: "",
        kind: "image" as const,
        thumbSrc: "",
        durationLabel: "",
        archive: "",
        missing: false,
        pending: true,
      };
    }
    // Marked, not dropped: dropping hidden rows would shrink this array so
    // position i no longer equals absolute index (start + i), which every
    // other cursor/index computation in this file (galleryIndex - windowStart,
    // data-gallery-index, enqueueThumb) depends on. Gallery.svelte instead
    // renders nothing for a hidden slot, which hides it from browsing just as
    // completely without disturbing that arithmetic.
    const hidden = filterThisView && isHidden(it, hiddenKeys);
    const key = tagItemKey(it.archive, it.path);
    const prior = carried.get(key);
    if (prior) {
      prior.missing = it.missing; // the only fields a re-fetch could change
      prior.hidden = hidden;
      return prior;
    }
    return {
      path: it.path,
      name: it.name,
      kind: it.kind,
      thumbSrc: "",
      durationLabel: "",
      archive: it.archive,
      missing: it.missing,
      hidden,
    };
  });
  perfMark("tag.window", start + "-" + end + "/" + tagRows.length);
}

/**
 * Open the gallery grid scoped to a TAG (tags-002).
 *
 * The shape mirrors `openGalleryForFolder` deliberately: to everything below —
 * the tiles, the thumbnail pipeline, the keyboard cursor, Back — a tag view is
 * just a grid with a different source, which is why this needs no second grid.
 *
 * Members live in `tagRows`, sized to the store's own total and filled a page
 * at a time. Only a `TAG_WINDOW`-tile slice around the focus ever reaches the
 * DOM (`applyWindow`), so the grid's size no longer depends on the tag's.
 */
export async function openGalleryForTag(tag: string): Promise<void> {
  void watchFolder(null); // gallery-005: a tag's membership is not a folder's
  perfMark("tag.open", tag);
  const token = ++galleryToken;
  ui.galleryItems = [];
  ui.galleryListing = []; // tags-003 live hide: a tag view marks its rows hidden in place instead
  ui.galleryFolder = tag;
  ui.galleryPath = "";
  ui.galleryArchive = "";
  ui.galleryInner = "";
  ui.galleryTag = tag;
  ui.galleryTagTotal = 0;
  ui.galleryTagCapped = false; // tags-002: the sliding window replaced the cap
  disarmPrune(); // tags-002 fix-wave: opening a tag, even this one afresh, is a new count
  ui.galleryWindowStart = 0;
  ui.galleryCrumbs = [];
  ui.galleryError = "";
  ui.galleryLoading = true;
  ui.emptyError = "";
  setPanelOpen(false);
  setShortcutsOpen(false);
  ui.tagIndexOpen = false;
  ui.view = "gallery";
  document.title = `${tag} — Playback`;
  try {
    // One call learns `total` (needed to size tagRows before anything can be
    // paged against it) and happens to be page 0, so it is recorded as loaded
    // rather than re-fetched a moment later by applyWindow's own ensurePages.
    const first = await tauriInvoke<{ total: number; offset: number; items: TaggedItem[] }>(
      "tag_items",
      { tag, limit: TAG_PAGE_SIZE, offset: 0 },
    );
    if (galleryToken !== token) return; // superseded by a newer open
    ui.galleryTagTotal = first.total;
    tagRows = new Array(first.total);
    tagPagesLoaded = new Set<number>();
    first.items.forEach((it, i) => {
      tagRows[i] = it;
    });
    tagPagesLoaded.add(0);
    await authorizePageDirs(first.items);
    if (galleryToken !== token) return;

    setGalleryIndex(-1); // ux-004: a fresh grid starts with no keyboard cursor
    // Same ordering constraint as openGalleryForFolder: reset the thumbnail
    // pipeline BEFORE the items land, or tiles that already mounted never
    // request a thumbnail and shimmer forever.
    startGalleryThumbs(token);
    await applyWindow(tag, 0, token);
    if (galleryToken !== token) return;
    perfMark("tag.items", String(first.total));
    if (first.total === 0) ui.galleryError = "Nothing carries this tag yet.";
  } catch (err) {
    if (galleryToken === token) ui.galleryError = `Could not open this tag: ${String(err)}`;
  } finally {
    if (galleryToken === token) ui.galleryLoading = false;
  }
}

/** Brief confirmation over the grid, for a gallery action with no visible result
 *  of its own (a zero-missing prune changes nothing on screen, so without this
 *  it is impossible to tell whether the button did anything). Mirrors
 *  `flashImageAction` — its own timer, because the image viewer's field is
 *  rendered nowhere in this view and would otherwise linger to surface stale on
 *  some later photo. */
let galleryFlashTimer: number | undefined;
function flashGalleryAction(text: string): void {
  ui.galleryFlash = text;
  window.clearTimeout(galleryFlashTimer);
  galleryFlashTimer = window.setTimeout(() => {
    ui.galleryFlash = "";
  }, 1400);
}

/** How long the prune button stays armed after a first press before it
 *  disarms itself (tags-002 fix-wave). Mirrors `flashGalleryAction`'s own
 *  timer rather than inventing a second pattern for the same idea. */
const PRUNE_ARM_MS = 5000;
let galleryPruneTimer: number | undefined;

/** Disarm the prune button's two-step confirmation, wherever the count it
 *  captured could go stale: its own timeout, or the gallery moving on to a
 *  different tag, a folder, an archive, or a fresh journey entirely (tags-002
 *  fix-wave). A count that outlives what it was counted against is no longer
 *  a real confirmation — see the call sites next to the matching resets of
 *  `galleryTag`/`galleryTagTotal`/`galleryTagCapped`. */
function disarmPrune(): void {
  ui.galleryPrunePending = 0;
  window.clearTimeout(galleryPruneTimer);
  galleryPruneTimer = undefined;
}

/**
 * Remove the members of the current tag whose files are gone (tags-002).
 *
 * A two-press button, not a dialog: this codebase has no modal pattern, and
 * `window.confirm` does not work in this WebView2 build — it returns `true`
 * synchronously with nothing shown on screen, so a single press would remove
 * tag entries with no chance to cancel. The FIRST press only counts (nothing
 * is removed) and arms `ui.galleryPrunePending` with the real number, which
 * Gallery.svelte surfaces on the button itself; the SECOND press, while
 * armed, is what actually applies it. Tags are never removed as a side
 * effect of browsing — a file on an unplugged drive comes back when the
 * drive does.
 */
export async function pruneMissingFromTag(): Promise<void> {
  const tag = ui.galleryTag;
  if (!tag) return;

  if (ui.galleryPrunePending > 0) {
    // Second press: apply against the count the first press already showed.
    const removed = await tauriInvoke<number>("tag_prune_missing", { tag, apply: true }).catch(
      () => -1,
    );
    disarmPrune();
    if (removed < 0) {
      ui.galleryError = "Could not remove the missing files from this tag.";
      return;
    }
    perfMark("tag.prune.applied", String(removed));
    await openGalleryForTag(tag); // reload so the grid matches the store
    return;
  }

  // First press: count without changing anything, so the confirmation can
  // state a real number.
  const count = await tauriInvoke<number>("tag_prune_missing", { tag, apply: false }).catch(
    () => -1,
  );
  if (count < 0) {
    ui.galleryError = "Could not check this tag for missing files.";
    return;
  }
  perfMark("tag.prune.count", String(count));
  if (count === 0) {
    flashGalleryAction("Nothing is missing from this tag.");
    return;
  }
  ui.galleryPrunePending = count;
  flashGalleryAction(
    `${count} tagged ${count === 1 ? "item is" : "items are"} no longer on disk. ` +
      `Press again to remove ${count === 1 ? "it" : "them"} from "${tag}".`,
  );
  window.clearTimeout(galleryPruneTimer);
  galleryPruneTimer = window.setTimeout(disarmPrune, PRUNE_ARM_MS);
}

/**
 * Open the confirmation for deleting every file a tag carries (tags-004).
 *
 * The counts come from ONE read of the tag, and the number shown is the number
 * passed back as `expectCount` — so what the user agreed to is exactly what the
 * command verifies against. Recomputing between showing and confirming would
 * defeat the interlock.
 */
export async function openTagDeletePanel(): Promise<void> {
  if (!actions.delete) return; // android-001: no Recycle Bin on this platform
  const tag = ui.galleryTag;
  if (!tag) return;
  ui.tagDeleteError = "";
  ui.tagDeleteResult = ""; // in case a prior sweep's result was never dismissed
  const page = await tauriInvoke<{ total: number; items: TaggedItem[] }>("tag_items", {
    tag,
    limit: 1000,
    offset: 0,
  }).catch(() => null);
  if (!page) {
    ui.galleryError = "Could not read this tag.";
    return;
  }
  ui.tagDeleteCount = page.total;
  // `tag_items` caps `limit` at MAX_LIMIT (1000) natively, so for a tag larger
  // than that these two undercount — only members within the first 1000 are
  // seen. `tagDeleteCount` above is unaffected: it comes from `total`, a real
  // COUNT(*), so the interlock the command checks against is still exact.
  //
  // tags-004 code review (Finding 5, informational): `total` and this
  // archive/folder breakdown both come straight from `tag_items`, which does
  // NOT filter out members hidden by the blacklist (tags-003) — a
  // blacklisted tag hides its members from BROWSING only. This sweep is an
  // explicit, confirmed action on every member the tag names, not a browse,
  // so a member the grid currently hides is still counted here and still
  // gets recycled; deliberately not filtered — see the matching note beside
  // `tag_delete_all` in tags.rs.
  ui.tagDeleteArchived = page.items.filter((i) => i.archive).length;
  ui.tagDeleteFolders = page.items.filter((i) => i.kind === "folder").length;
  // tags-004 code review (Finding 1, CRITICAL): captured once, here, at open
  // time — confirmTagDelete reads THIS, not `ui.galleryTag` live, so a
  // confirm reached after the view has moved to a different tag cannot sweep
  // that different tag under the count shown for this one.
  ui.tagDeleteTag = tag;
  ui.tagDeleteOpen = true;
}

/**
 * Close the panel — Cancel, the header X, the backdrop, and Escape all route
 * here (tags-004 fix round 1, #2).
 *
 * A no-op while `tagDeleteBusy`: the sweep cannot be interrupted once
 * started, so a "Cancel" that only hid the panel would be a lie — the sweep
 * would keep running behind it and still land its result and `goHome()` when
 * it finished, bouncing the user Home after they believed they'd stopped it.
 *
 * `tagDeleteResult` is non-empty exactly when a sweep has FINISHED and its
 * counts are the panel's whole body (see confirmTagDelete) — dismissing that
 * view is an acknowledgement of what happened, not a cancellation of
 * something not yet done, so it is what actually triggers `goHome()`
 * (tags-004 fix round 1, #1: the result has to be SEEN before the view moves
 * on, not flashed into a grid that's about to be hidden).
 */
export function closeTagDeletePanel(): void {
  if (ui.tagDeleteBusy) return;
  const sawResult = ui.tagDeleteResult !== "";
  ui.tagDeleteOpen = false;
  ui.tagDeleteResult = "";
  ui.tagDeleteError = "";
  // tags-004 code review (Finding 1, CRITICAL): a closed panel's controls
  // used to stay in the DOM at `opacity:0` (CSS opacity does not remove a
  // node from the tab order), and this state used to be left exactly as
  // Cancel found it — so Tab+Enter reaching the invisible confirm button
  // after Cancel could fire a bulk delete for a count nobody had just seen.
  // The `{#if ui.tagDeleteOpen}` wrap in TagDeletePanel.svelte and the
  // `!ui.tagDeleteOpen` guard in confirmTagDelete are what actually close
  // that gap; resetting the counts here is defence in depth on top of both,
  // not a replacement for either.
  ui.tagDeleteCount = 0;
  ui.tagDeleteArchived = 0;
  ui.tagDeleteFolders = 0;
  ui.tagDeleteTag = "";
  ui.tagDeleteRecycled = 0;
  if (sawResult) goHome();
}

/** Run the sweep the panel described. */
export async function confirmTagDelete(): Promise<void> {
  // tags-004 code review (Finding 1, CRITICAL): the structural fix is the
  // `{#if ui.tagDeleteOpen}` wrap in TagDeletePanel.svelte, which removes the
  // confirm button from the DOM entirely while the panel is closed. This is
  // the second, independent layer — a destructive command must refuse to run
  // on its own terms, not rely solely on the caller never being able to
  // reach it, in case some future path (a shortcut, a race, a bug in the
  // wrap) ever calls this function while the panel isn't actually open.
  if (!ui.tagDeleteOpen) return;
  // tags-004 code review (Finding 1, CRITICAL): read the tag CAPTURED at open
  // time, not `ui.galleryTag` live — see the comment beside `tagDeleteTag` in
  // state.svelte.ts for what re-reading it here used to allow.
  const tag = ui.tagDeleteTag;
  if (!tag || ui.tagDeleteBusy) return;
  ui.tagDeleteBusy = true;
  ui.tagDeleteError = "";
  const res = await tauriInvoke<{
    recycled: number;
    skippedInArchive: number;
    skippedMissing: number;
    skippedFolders: number;
    failed: number;
  }>("tag_delete_all", { tag, expectCount: ui.tagDeleteCount }).catch((err) => {
    // tags-004 code review (Finding 3): phase 3 (unlink members + decide the
    // tag row) runs AFTER phase 2's recycle loop has already moved files to
    // the bin. If phase 3 itself fails, this catch is all the UI ever sees —
    // the command returns Err, discarding the TagDeleteResult it had already
    // built, so there is no count to show. Saying nothing else happened
    // would be dishonest: files are very possibly already gone from disk.
    // Say so, without inventing a number we were never actually given.
    ui.tagDeleteError = `${String(err)} Some files may already be in the Recycle Bin — reopen this tag to see what's left.`;
    return null;
  });
  ui.tagDeleteBusy = false;
  if (!res) return;
  perfMark("tag.deleted", `${res.recycled}`);
  // Report what actually happened, not "done". A sweep that skipped or failed
  // on some members is a different outcome from one that took everything.
  //
  // tags-004 fix round 1 (#1): this used to be flashGalleryAction'd into the
  // gallery grid and immediately followed by goHome() — but that flash only
  // ever renders inside Gallery.svelte, which goHome() hides in the same
  // tick, so the message was set and never once seen. It is now the panel's
  // OWN result view (TagDeletePanel.svelte) instead: the panel stays open,
  // showing these counts, until closeTagDeletePanel dismisses it — which is
  // also what runs goHome() now, so the report is unmissable before the view
  // moves on.
  const parts = [`${res.recycled} moved to the Recycle Bin`];
  if (res.skippedInArchive > 0) parts.push(`${res.skippedInArchive} skipped inside archives`);
  if (res.skippedFolders > 0) parts.push(`${res.skippedFolders} folders skipped`);
  if (res.skippedMissing > 0) parts.push(`${res.skippedMissing} already gone`);
  if (res.failed > 0) parts.push(`${res.failed} could not be deleted`);
  ui.tagDeleteResult = parts.join(" · ");
  // tags-004 code review (Finding 4): lets the panel's result heading say
  // "Done" only when something actually was — see TagDeletePanel.svelte.
  ui.tagDeleteRecycled = res.recycled;
  // The underlying data is refreshed now, not deferred to dismissal — the
  // sweep already happened; only the user's acknowledgement of it, and the
  // navigation that follows, wait on the panel being closed.
  await refreshHiddenKeys();
  await loadTagLibrary();
}

/**
 * Authorize the folders a page's items live in, and only those.
 *
 * The asset-protocol scope and the IPC read gate are both per-directory, so a
 * tag spanning drives needs its directories opened as they are reached. This
 * deliberately does NOT authorize the whole store at startup: the read gate
 * widens for what the user is actually looking at.
 */
async function authorizePageDirs(items: TaggedItem[]): Promise<void> {
  const dirs = new Set<string>();
  for (const it of items) {
    if (it.missing) continue; // nothing to authorize for a file that is gone
    // An archive page is served from the archive's own directory.
    const onDisk = it.archive || it.path;
    const cut = Math.max(onDisk.lastIndexOf("\\"), onDisk.lastIndexOf("/"));
    if (cut > 0) dirs.add(onDisk.slice(0, cut));
  }
  for (const dir of dirs) await authorizeMediaDir(dir, "dir");
}

/** The most-used tags, for Home's Tags section. Loaded when Home is shown, and
 *  after any tag mutation, so the counts do not go stale behind the user. */
export async function loadTagLibrary(): Promise<void> {
  const rows = await tauriInvoke<{ name: string; count: number }[]>("tag_list", {
    query: "",
    limit: 24,
    offset: 0,
    includeBlacklisted: false,
  }).catch(() => null);
  if (!rows) return;
  ui.tagLibrary = rows;
  perfMark("tag.library", String(rows.length));
}

/**
 * The identities of items carrying a blacklisted tag (tags-003).
 *
 * Cached rather than queried per item: this is consulted for every tile in
 * every folder, and a round trip there would undo what perf-008/009 bought.
 * Refreshed when the blacklist changes and when a tag is applied or removed —
 * either can change what is hidden.
 *
 * tags-003 final review (Finding 4): starts EMPTY, and a failed refresh
 * CLEARS it rather than keeping whatever was cached before — the previous
 * comment here claimed "a failed refresh leaves it empty", which was only
 * true of the very first refresh. `if (!rows) return;` used to keep the OLD
 * set, which fails CLOSED exactly when it matters most: right after
 * un-blacklisting, when the tag looks restored everywhere (loadTagBlacklist
 * already succeeded) but a failed refresh here would otherwise leave its
 * members hidden with nothing on screen to say why. Clearing on every
 * failure, not just the first, is what actually keeps this filter failing
 * OPEN the way the global rule requires — the tradeoff is that a transient
 * failure right after browsing with tags already blacklisted can flash
 * everything back into view for a moment, which is judged the lesser risk
 * next to silently hiding something the user just tried to un-hide.
 */
let hiddenKeys = new Set<string>();

export async function refreshHiddenKeys(): Promise<void> {
  const rows = await tauriInvoke<string[]>("tag_hidden_keys", {}).catch(() => null);
  hiddenKeys = rows ? new Set(rows) : new Set<string>(); // fail open — see above
  perfMark("tag.hidden", rows ? String(rows.length) : "failed");
  // tags-003 final review (Finding 2): Home's recents went stale two ways —
  // the session's first paint ran renderRecents() before this had ever
  // resolved, filtering against an empty set, and toggleTagBlacklist used to
  // refresh this cache without ever repainting recents at all. Recents are
  // browsing, same as a gallery grid, so every refresh (success OR failure,
  // since a failure can change hiddenKeys too — see above) repaints them
  // here, once, rather than trusting every caller of refreshHiddenKeys to
  // remember to.
  renderRecents();
  // And the grid, for the same reason: a folder grid was filtered once at load
  // and a tag grid's rows were marked once per window, so a tile tagged with a
  // blacklisted tag stayed on screen until its gallery was reopened.
  applyHiddenToGrid();
}

/**
 * Re-derive what the OPEN grid shows from the hidden set as it is now
 * (tags-003 live hide). Called after every refresh of `hiddenKeys` and when
 * Back restores a grid — the two moments the set the grid was derived from can
 * differ from the set it should reflect.
 *
 * Two grids, two mechanisms, both already established:
 *  - A tag view keeps every loaded row and marks the hidden ones (`applyWindow`
 *    explains why dropping them would break the window arithmetic); here the
 *    same mark is recomputed in place over the rows that are loaded.
 *  - A folder/archive grid DROPS hidden tiles, because every index in it is a
 *    rendered tile — End, the delete landing and `galleryTotalCount` all rely
 *    on that — so it is re-derived from the retained `ui.galleryListing`, the
 *    cursor following its tile (`reviseGrid`). Reassigning `ui.galleryItems`
 *    is safe for the thumbnail pipeline: a result in flight for an index whose
 *    tile moved is dropped by `renderThumb`'s own path check, and the fill is
 *    re-armed below so the tile it belonged to is picked up again.
 *
 * Nothing happens when the visible set is unchanged — the common case, a tag
 * that hides nothing — so this costs a key comparison, not a re-render. Any
 * change disarms a pending delete: an arm that outlives the listing it was
 * aimed at is not a confirmation (the rule disarmGalleryDelete already states).
 */
function applyHiddenToGrid(): void {
  if (ui.galleryTag) {
    const filterThisView = shouldFilterTagView(ui.galleryTag);
    let changed = false;
    for (const it of ui.galleryItems) {
      if (it.pending) continue; // no identity yet; applyWindow marks it when its page lands
      const hidden = filterThisView && isHidden(it, hiddenKeys);
      if (hidden === !!it.hidden) continue;
      it.hidden = hidden;
      changed = true;
    }
    if (!changed) return;
    disarmGalleryDelete();
    const shown = ui.galleryItems.filter((it) => !it.pending && !it.hidden).length;
    perfMark("gallery.rehide", String(shown));
    return;
  }
  if (ui.galleryListing.length === 0) return; // no folder/archive grid is loaded
  const r = reviseGrid(ui.galleryListing, hiddenKeys, ui.galleryItems, ui.galleryIndex);
  if (!r.changed) return;
  ui.galleryItems = r.items;
  setGalleryIndex(r.cursor); // the cursor moved, or its tile went — either disarms
  rearmThumbFill();
  perfMark("gallery.rehide", String(r.items.length));
}

export function openTagIndex(): void {
  ui.tagIndexOpen = true;
  ui.tagIndexQuery = "";
  ui.tagIndexRows = [];
  ui.tagIndexShowBlacklisted = false; // each visit starts in the ordinary view
  ui.tagIndexError = "";
  void loadTagBlacklist();
  void refreshTagIndex("");
}

export function closeTagIndex(): void {
  ui.tagIndexOpen = false;
  ui.tagIndexQuery = "";
  ui.tagIndexRows = [];
  ui.tagIndexError = "";
  tagIndexToken++; // a response already in flight must not repopulate a closed list
}

export function onTagIndexQuery(value: string): void {
  ui.tagIndexQuery = value;
  void refreshTagIndex(value.trim());
}

/** Bumped on every index query so a slower, older response cannot overwrite a
 *  newer one's rows — a shorter prefix can genuinely take longer to serve than
 *  the narrower one typed after it, and the stale list would not self-correct. */
let tagIndexToken = 0;

async function refreshTagIndex(query: string): Promise<void> {
  const token = ++tagIndexToken;
  const rows = await tauriInvoke<{ name: string; count: number }[]>("tag_list", {
    query,
    limit: 200,
    offset: 0,
    includeBlacklisted: ui.tagIndexShowBlacklisted,
  }).catch(() => null);
  if (!rows || !ui.tagIndexOpen || token !== tagIndexToken) return;
  ui.tagIndexRows = rows;
}

/** Load which tags are blacklisted, so the index can mark its rows. */
export async function loadTagBlacklist(): Promise<void> {
  const rows = await tauriInvoke<string[]>("tag_blacklist_list", {}).catch(() => null);
  if (!rows) return;
  ui.tagBlacklist = rows;
}

/**
 * Blacklist or un-blacklist one tag (tags-003).
 *
 * Nothing here is destructive: the tag keeps its name and its members keep the
 * tag, so this is fully reversible by pressing it again. That is why it needs
 * no confirmation, unlike anything in img-003.
 */
export async function toggleTagBlacklist(tag: string): Promise<void> {
  const on = !ui.tagBlacklist.includes(tag);
  try {
    await tauriInvoke("tag_blacklist_set", { tag, on });
  } catch {
    // Not `ui.galleryError`: Gallery.svelte is `hidden` (display:none) whenever
    // this button is reachable, since "All tags…" only opens from Home. That
    // error would be set and never seen, leaving the row's icon disagreeing
    // with the store with no visible sign anything went wrong. `tagIndexError`
    // renders in this overlay itself, mirroring `tagError` in TagPopover.svelte.
    ui.tagIndexError = "Could not change that tag.";
    return;
  }
  ui.tagIndexError = "";
  // Order matters: the blacklist list drives the index's marks, the hidden set
  // drives browsing, and Home's shelf must drop or regain the tag.
  await loadTagBlacklist();
  await refreshHiddenKeys();
  await loadTagLibrary();
  await refreshTagIndex(ui.tagIndexQuery.trim());
}

/** Show or hide blacklisted tags in the index, and reload its rows. */
export function setShowBlacklisted(on: boolean): void {
  ui.tagIndexShowBlacklisted = on;
  void refreshTagIndex(ui.tagIndexQuery.trim());
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
 * `thumbSrc` starts EMPTY and is filled in by the viewport-driven pipeline. It used
 * to be `convertFileSrc(originalPath)`, which made every ~200 px tile decode the
 * full-resolution original — on a folder of 51-megapixel photos that measured as
 * 2.6 s of main-thread stalls (worst single block 1130 ms) and hundreds of MB of
 * bitmap per tile. The grid now renders instantly with placeholders instead.
 */
function toGalleryItems(nodes: GalleryNode[], archive = ""): GalleryItem[] {
  return nodes.map((n) => ({
    path: n.path,
    name: n.name,
    kind: n.kind,
    thumbSrc: "",
    durationLabel: "",
    archive,
    // tags-002: a folder/archive listing can only contain files that exist,
    // so this is always false here — only a tag view's builder sets it.
    missing: false,
  }));
}

/** The listing behind every gallery grid (gallery-002, gallery-003): sub-folders,
 *  images and videos in one native call, ordered by the pure `orderGalleryEntries`
 *  — folders first, then photos and videos interleaved by name. */
async function readGalleryNodes(path: string): Promise<GalleryNode[]> {
  const entries = await tauriInvoke<{
    folders: string[];
    images: string[];
    videos: string[];
    archives: string[];
  }>("list_folder_entries", { path });
  const counted =
    (entries?.images?.length ?? 0) +
    (entries?.folders?.length ?? 0) +
    (entries?.videos?.length ?? 0) +
    (entries?.archives?.length ?? 0);
  perfMark("gallery.listed", String(counted)); // perf-005
  return orderGalleryEntries(
    entries?.folders ?? [],
    entries?.images ?? [],
    entries?.videos ?? [],
    entries?.archives ?? [],
  );
}

/** The listing behind an archive's grid (gallery-004). Reads the archive INDEX —
 *  no entry is decompressed — and returns inner paths, which only
 *  `archive_entry_file` can turn into real files. A nested archive inside an
 *  archive is deliberately not listed: browsing it would mean extracting an
 *  archive to read an archive. */
async function readArchiveNodes(archive: string, inner: string): Promise<GalleryNode[]> {
  const entries = await tauriInvoke<{
    folders: string[];
    images: string[];
    videos: string[];
  }>("list_archive_entries", { archive, inner });
  const counted =
    (entries?.images?.length ?? 0) +
    (entries?.folders?.length ?? 0) +
    (entries?.videos?.length ?? 0);
  perfMark("gallery.listed", String(counted));
  return orderGalleryEntries(
    entries?.folders ?? [],
    entries?.images ?? [],
    entries?.videos ?? [],
  );
}

/** How many thumbnails to render at once. Each is an ffmpeg sidecar process, so
 *  this trades wall-clock against not swamping the machine mid-browse. */
const THUMB_CONCURRENCY = 4;

/** Invalidates in-flight thumbnail work when the gallery changes underneath it. */
let galleryToken = 0;

// ---------------------------------------------------------------------------
// Viewport-driven thumbnail rendering (ux-004)
//
// perf-005 rendered every thumbnail in the folder, in index order, on open. That
// is fine for 63 images and badly wrong for a big folder: measured on a 1200-image
// folder it issued 1200 sidecar renders totalling 60.6 s of work, when only ~30
// tiles are ever on screen. (The same measurement showed the GRID itself is not a
// problem — 1200 tiles render in 1.3 ms with no main-thread blocks — so DOM
// virtualization was measured to be unnecessary and deliberately not built.)
//
// Tiles now request their thumbnail only as they approach the viewport, still at
// bounded concurrency, so cost scales with what the user actually looks at.
// ---------------------------------------------------------------------------

let thumbObserver: IntersectionObserver | null = null;
let thumbQueue: number[] = [];
let thumbActive = 0;

// perf-009 -------------------------------------------------------------------
//
// The observer above is a PRIORITY signal, not a coverage one: it fires for
// tiles near the viewport and nothing else, so a grid nobody scrolls used to
// stop at the first screenful and stay there (measured: 42 of 600 tiles, still
// 42 after thirty seconds, resuming the millisecond the wheel moved). The fill
// below is what finishes the job, walking outward from whatever the viewport is
// showing so the grid completes from what the user is looking at rather than
// from the top of the folder.
//
// This is only affordable because of perf-008. While every tile cost an ffmpeg
// process spawn, filling a whole folder in the background meant 34.2 s of
// native work for 600 photos; in process it is 11.3 s, and it yields.

/** How many tiles one background top-up adds. Small enough that a scroll's own
 *  enqueues are never stuck behind a huge batch, big enough that the pipeline
 *  is not re-armed every few milliseconds. */
const THUMB_FILL_BATCH = 48;

/** Retry delay while the gallery is not the visible view — see `runThumbFill`. */
const THUMB_FILL_IDLE_MS = 500;

/** Tiles queued but not yet started, and tiles started but not yet finished.
 *  Both are needed to dedupe: a tile is off `thumbQueue` for the whole time it
 *  is rendering, and the background fill would otherwise pick it up again
 *  because `thumbSrc` is not set until it lands. */
const thumbQueued = new Set<number>();
const thumbInFlight = new Set<number>();

/** The absolute index of the first tile the viewport is showing. Written by the
 *  grid's scroll handler (Gallery.svelte) and read as the origin for every
 *  ordering decision below. */
let thumbFocus = 0;

let thumbFillTimer = 0;
/** Set once a pass finds nothing left to render, so an already-full grid stops
 *  re-scanning itself. Any fresh enqueue clears it. */
let thumbFillDone = false;

/** Tear down the pipeline for the previous gallery. */
function resetThumbPipeline(): void {
  thumbObserver?.disconnect();
  thumbObserver = null;
  thumbQueue = [];
  thumbQueued.clear();
  thumbInFlight.clear();
  thumbActive = 0;
  thumbFocus = 0;
  thumbFillDone = false;
  cancelThumbFill();
}

/** Where the grid is scrolled to, in absolute tile indices (tags-002 windows
 *  the DOM, so this is not a position within `ui.galleryItems`). Called from
 *  the grid's rAF-throttled scroll handler. */
export function setThumbFocus(index: number): void {
  if (!Number.isFinite(index) || index < 0) return;
  thumbFocus = Math.floor(index);
  // Observability: where the eye is, over time. Comparing this against the
  // `thumb.render` marks is the only way to tell "the pipeline is slow" apart
  // from "the pipeline is busy rendering somewhere the user is not looking" —
  // the two feel identical and have opposite fixes.
  perfMark("thumb.focus", String(thumbFocus));
}

function cancelThumbFill(): void {
  if (!thumbFillTimer) return;
  clearTimeout(thumbFillTimer);
  thumbFillTimer = 0;
}

/**
 * Arm the background fill, but only when the pipeline is about to run dry —
 * topping up at the low-water mark rather than at empty is what keeps the
 * renderer saturated instead of stalling for a timer between every batch.
 */
function scheduleThumbFill(): void {
  if (thumbFillTimer || thumbFillDone) return;
  if (thumbQueue.length > THUMB_CONCURRENCY) return;
  const token = galleryToken;
  thumbFillTimer = window.setTimeout(() => {
    thumbFillTimer = 0;
    runThumbFill(token);
  }, 0);
}

/**
 * Wake the background fill after the grid's tiles moved under it (tags-003
 * live hide, `applyHiddenToGrid`). Lighter than `resetThumbPipeline`, on
 * purpose: the observer and `thumbFocus` are still right for the tiles that
 * stayed mounted, and a full reset would walk the fill out from tile 0 rather
 * than from the viewport. What a shift can leave behind is a tile whose
 * in-flight result was dropped by `renderThumb`'s path check after a pass had
 * already declared the fill done — clearing that flag is what lets the next
 * pass find it. An index still queued simply renders whichever tile is at
 * that position now, or bails if it already has one.
 */
function rearmThumbFill(): void {
  thumbFillDone = false;
  scheduleThumbFill();
}

function runThumbFill(token: number): void {
  if (token !== galleryToken) return; // a different gallery owns the pipeline now
  // Background work must not run behind another view. Opening a photo from the
  // grid leaves `ui.galleryItems` in place on purpose (Back returns to it), so
  // without this the fill would keep four decodes busy underneath the viewer —
  // exactly the "the app feels heavy" the user reported. Re-armed rather than
  // abandoned, so coming back to the grid resumes it.
  if (ui.view !== "gallery") {
    thumbFillTimer = window.setTimeout(() => {
      thumbFillTimer = 0;
      runThumbFill(token);
    }, THUMB_FILL_IDLE_MS);
    return;
  }
  const pending = pendingThumbIndices();
  if (pending.length === 0) {
    thumbFillDone = true;
    return;
  }
  for (const index of nextThumbFillBatch(pending, thumbFocus, THUMB_FILL_BATCH)) {
    enqueueThumb(index);
  }
}

/**
 * Absolute indices of loaded tiles that still need a thumbnail and are not
 * already queued or rendering. Only ever the loaded window: in a tag view the
 * rest of the tag has no DOM and no item object, and `pending` placeholders
 * have no real file to render yet (tags-002).
 */
function pendingThumbIndices(): number[] {
  const out: number[] = [];
  const start = ui.galleryWindowStart;
  for (let i = 0; i < ui.galleryItems.length; i++) {
    const item = ui.galleryItems[i];
    if (!item || item.thumbSrc || item.pending) continue;
    const index = start + i;
    if (thumbQueued.has(index) || thumbInFlight.has(index)) continue;
    out.push(index);
  }
  return out;
}

/** Prime the disk cache once per gallery open, then let the observer drive. */
function startGalleryThumbs(token: number): void {
  resetThumbPipeline();
  void tauriInvoke("prepare_thumb_cache", {}).catch(() => {
    /* no cache dir — each request then fails and falls back to the original */
  });
  void token;
}

/**
 * Svelte action on each tile: render this tile's thumbnail once it comes within
 * a screenful of the viewport. One-shot — the tile is unobserved as soon as it
 * qualifies, so scrolling back and forth never re-queues it.
 */
export function galleryTile(
  node: HTMLElement,
  index: number,
): { update(index: number): void; destroy(): void } {
  node.dataset.galleryIndex = String(index);
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          thumbObserver?.unobserve(el);
          enqueueThumb(Number(el.dataset.galleryIndex));
        }
      },
      // Scroll container, plus a screenful of lead-in so tiles are already filled
      // by the time they scroll into view.
      { root: document.querySelector(".gallery__body"), rootMargin: "600px 0px" },
    );
  }
  thumbObserver.observe(node);
  return {
    // tags-003 live hide: when a folder grid drops a hidden tile, every tile
    // after it moves up one — and the keyed {#each} keeps their DOM nodes, so
    // the index stamped at mount would go stale. A tag view never needed this
    // (a member's absolute index survives the window sliding), but here it is
    // the only thing keeping the index the observer reports (enqueueThumb) and
    // the one focusGalleryTile / the Back restore look up true for a tile that
    // has moved. Found by smoke-tag-livehide.ps1's Oracle G2: with tile 0
    // hidden, Home + Enter opened nothing, because the surviving tile still
    // answered to index 1.
    update(next: number): void {
      node.dataset.galleryIndex = String(next);
    },
    destroy(): void {
      thumbObserver?.unobserve(node);
    },
  };
}

function enqueueThumb(index: number): void {
  // tags-002: `index` is ABSOLUTE (it comes from data-gallery-index), while
  // ui.galleryItems is the windowed slice starting at galleryWindowStart. Load-
  // bearing now that the window (Task 12) slides: indexing without this offset
  // silently paints one tile's thumbnail onto another.
  const item = ui.galleryItems[index - ui.galleryWindowStart];
  // tags-002 fix-1: a pending tile has no real file yet — queuing it would
  // eventually hand `convertFileSrc` a "pending:N" marker instead of a path.
  // Once its page lands, applyWindow mints a real item under a DIFFERENT
  // tagItemKey, so Gallery.svelte's keyed {#each} swaps in a fresh DOM node
  // rather than patching this one — and that new node's own use:galleryTile
  // mount re-observes it, enqueueing the real thumbnail then.
  if (!item || item.thumbSrc || item.pending) return;
  // perf-009: the observer and the background fill both feed this queue, and a
  // tile can be revealed while it is already waiting or already rendering.
  if (thumbQueued.has(index) || thumbInFlight.has(index)) return;
  thumbQueued.add(index);
  thumbFillDone = false;
  thumbQueue.push(index);
  pumpThumbs();
}

function pumpThumbs(): void {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length > 0) {
    // perf-010: nearest-to-the-viewport, not FIFO.
    //
    // perf-009 built exactly this, measured it to change nothing, and deleted
    // it rather than ship it on theory — and that was the right call at the
    // time: it ran four probes, including a deep jump mid-fill, and BOTH BUILDS
    // EMITTED THE IDENTICAL RENDER SEQUENCE. Its reasoning still holds too. The
    // ordering normally comes from `nextThumbFillBatch`, which enqueues outward
    // from the viewport already, so while the viewport stays put
    // `nearestQueuedThumb` returns 0 and this IS a FIFO.
    //
    // That feature's own note said the question was "closed only at CURRENT
    // speeds" and named what would re-open it: thumbnails getting much slower.
    // They have. perf-009 measured 18-47 ms a thumbnail on its fixtures; a cold
    // 1,999-photo folder of 3 MB photos runs at 118 ms, and there the stale
    // batch is no longer too short to matter. Pressing End to jump the viewport
    // from tile 0 to tile 1980 rendered 49 tiles from 761-809 first and did not
    // REQUEST a single on-screen tile until 2.83 s after the jump — a full
    // THUMB_FILL_BATCH of work for a viewport the user had already left, with
    // the tiles they were looking at queued behind it by the observer.
    const next = nearestQueuedThumb(thumbQueue, thumbFocus);
    const index = thumbQueue.splice(next, 1)[0];
    thumbQueued.delete(index);
    thumbInFlight.add(index);
    void renderThumb(index);
  }
  scheduleThumbFill();
}

/**
 * Render one tile's thumbnail natively and swap it in. A failure falls back to
 * the original file — the behavior the grid had for everything before perf-005:
 * degraded (a big decode for that one tile), never broken.
 *
 * gallery-002: a FOLDER tile first asks which image inside it should be the cover,
 * then renders that through the same `media_thumbnail` command (one cache, one
 * render pipeline). A folder holding no images has no cover — `thumbSrc` stays
 * empty and the tile keeps its folder glyph, which is the correct picture for it
 * rather than a fallback.
 */
async function renderThumb(index: number): Promise<void> {
  const token = galleryToken;
  // tags-002: `index` is ABSOLUTE (passed down from enqueueThumb, itself sourced
  // from data-gallery-index) — see the comment on enqueueThumb.
  const item = ui.galleryItems[index - ui.galleryWindowStart];
  // tags-002 fix-2 (Defect C): mirrors enqueueThumb's own `|| item.pending`
  // bail (see the comment there) rather than relying on the fact that, today,
  // every caller path that could reach a pending item was already filtered by
  // enqueueThumb first. That cross-function ordering is real but implicit —
  // guarding it here too means this one function stays safe to reason about
  // on its own.
  if (!item || item.thumbSrc || item.pending) {
    // perf-009: this bail happens AFTER pumpThumbs marked the tile in flight,
    // so it has to release it or the background fill will skip that index for
    // the rest of the gallery's life.
    thumbInFlight.delete(index);
    return;
  }
  // Observability: which tile indices actually reach a render. Comparing the
  // count of these against distinct indices is how a duplicate-enqueue is caught.
  perfMark("thumb.render", String(index));
  thumbActive++;
  try {
    const source = await renderTilePoster(index, item, token);
    // gallery-003: the duration badge is a second probe, run inside the SAME
    // bounded slot rather than alongside the poster — a video tile must not double
    // the number of concurrent ffmpeg processes. It runs even when the poster
    // failed, since a tile showing a placeholder can still honestly say "1:34".
    // gallery-004: it probes the MATERIALIZED path, never an inner path — and an
    // archive video has none, so it is skipped there along with its poster.
    if (item.kind === "video" && source) {
      await renderTileDuration(index, item, source, token);
    }
  } finally {
    thumbActive--;
    thumbInFlight.delete(index);
    if (token === galleryToken) pumpThumbs();
  }
}

/**
 * The real, on-disk file a tile should be thumbnailed from — materializing an
 * archive entry when that is what the tile is (gallery-004). Returns null when
 * the tile has no picture to show, which is a legitimate outcome: a folder with
 * no images keeps its glyph.
 *
 * A VIDEO inside an archive deliberately returns null. Drawing its poster would
 * mean extracting the whole clip — potentially gigabytes — to fill a 200 px tile,
 * which is exactly the cost this feature's laziness exists to avoid. Its bytes
 * are materialized when the user actually opens it.
 */
async function tileSourcePath(item: GalleryItem): Promise<string | null> {
  // An archive TILE: cover image from anywhere inside it.
  if (item.kind === "archive") {
    const inner = await tauriInvoke<string | null>("archive_cover_entry", {
      archive: item.path,
      inner: "",
    }).catch(() => null);
    if (!inner) return null;
    return await tauriInvoke<string>("archive_entry_file", {
      archive: item.path,
      inner,
    }).catch(() => null);
  }
  if (item.archive) {
    // A folder INSIDE an archive: cover image from that subtree.
    if (item.kind === "folder") {
      const inner = await tauriInvoke<string | null>("archive_cover_entry", {
        archive: item.archive,
        inner: item.path,
      }).catch(() => null);
      if (!inner) return null;
      return await tauriInvoke<string>("archive_entry_file", {
        archive: item.archive,
        inner,
      }).catch(() => null);
    }
    if (item.kind === "video") return null; // see the doc comment above
    return await tauriInvoke<string>("archive_entry_file", {
      archive: item.archive,
      inner: item.path,
    }).catch(() => null);
  }
  // A real folder asks which image inside it should be the cover.
  if (item.kind === "folder") {
    return await tauriInvoke<string | null>("folder_cover_image", {
      path: item.path,
    }).catch(() => null);
  }
  return item.path;
}

/** The picture on one tile: a cached JPEG for an image, a poster frame for a
 *  video, a cover for a folder or archive. Returns the real source path it used
 *  (so the duration probe can reuse it), or null when the tile has no picture.
 *  Bails silently when the gallery changed underneath it. */
async function renderTilePoster(
  index: number,
  item: GalleryItem,
  token: number,
): Promise<string | null> {
  const source = await tileSourcePath(item);
  if (token !== galleryToken) return null;
  if (!source) return null;
  const thumb = await tauriInvoke<string>("media_thumbnail", { path: source }).catch(
    () => null,
  );
  if (token !== galleryToken) return null;
  // tags-002: `index` is ABSOLUTE (passed down from renderThumb) — see the
  // comment on enqueueThumb.
  const current = ui.galleryItems[index - ui.galleryWindowStart];
  if (!current || current.path !== item.path) return null; // list changed under us
  // A folder or archive never falls back to its own path (neither is an image),
  // and neither does an archive ENTRY, whose path is an inner path rather than a
  // file. Only a plain on-disk image degrades to a full-resolution decode.
  const fallback = current.kind === "image" && !current.archive ? source : null;
  const src = thumb ?? fallback;
  if (!src) return source;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  current.thumbSrc = convertFileSrc(src);
  // Observability: `thumb.render` marks where work STARTED, which says nothing
  // about when a tile got a picture. This is the completion side, and the pair
  // is what measures "how long after the viewport moved did the tiles the user
  // is looking at actually fill in".
  perfMark("thumb.shown", String(index));
  return source;
}

/** The running-time badge on one video tile (gallery-003). A container that reports
 *  no honest duration leaves the label empty, and the tile then shows no badge —
 *  never a fabricated 0:00. */
async function renderTileDuration(
  index: number,
  item: GalleryItem,
  source: string,
  token: number,
): Promise<void> {
  const seconds = await tauriInvoke<number | null>("video_duration", {
    path: source,
  }).catch(() => null);
  if (token !== galleryToken) return;
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return;
  // tags-002: `index` is ABSOLUTE (passed down from renderThumb) — see the
  // comment on enqueueThumb.
  const current = ui.galleryItems[index - ui.galleryWindowStart];
  if (!current || current.path !== item.path) return; // list changed under us
  current.durationLabel = formatTime(seconds);
  // Observability: the badge is text, which a screenshot oracle cannot read — this
  // mark is how the gallery-003 smoke asserts a real duration reached a real tile.
  perfMark("thumb.duration", current.durationLabel);
}

// --- Grid keyboard navigation (ux-004) -------------------------------------

/** Columns currently laid out, derived from the DOM (the grid is responsive).
 *  Only counts actual TILES — the sliding window's spacer rows (tags-002 Step
 *  3) are full-width grid children too, and folding one into this offsetTop
 *  scan undercounts to 1 the moment the window is not sitting at the very top
 *  (the spacer's own offsetTop is 0, so the real first tile right after it
 *  reads as a new row and the scan stops after one column). Exported so
 *  Gallery.svelte's scroll handler can size a scroll step in absolute rows
 *  without re-deriving this. */
export function galleryColumns(): number {
  const grid = document.getElementById("gallery-grid");
  const tiles = grid?.querySelectorAll(":scope > .gallery-tile");
  if (!tiles || tiles.length === 0) return 1;
  const firstTop = (tiles[0] as HTMLElement).offsetTop;
  let cols = 0;
  for (let i = 0; i < tiles.length; i++) {
    if ((tiles[i] as HTMLElement).offsetTop !== firstTop) break;
    cols++;
  }
  return Math.max(1, cols);
}

/** The count arrow-key clamping and End navigate against: the whole TAG when
 *  one is open, since `ui.galleryItems` is only the sliding window in the DOM
 *  (tags-002) — clamping against the window would stop the cursor at the
 *  window's edge and End would land on the last LOADED tile rather than the
 *  tag's actual last one. `ui.galleryTagTotal` is safe to read for this only
 *  because `openGalleryForTag` no longer caps: it used to be able to exceed
 *  what was loaded, which is exactly why this waited for the window to land.
 *  Every other gallery loads in full, so `ui.galleryItems.length` already IS
 *  its total. */
function galleryTotalCount(): number {
  return ui.galleryTag ? ui.galleryTagTotal : ui.galleryItems.length;
}

/** Move the grid cursor, scroll it into view, and give it real DOM focus (so the
 *  ux-003 focus ring shows and Enter/Space activate it natively). In a tag view
 *  this first slides the window to cover `index` (tags-002 Step 2) — keyboard
 *  navigation past the loaded window's edge must pull the next page in rather
 *  than focusing a tile that is not in the DOM yet. */
function focusGalleryTile(index: number): void {
  disarmGalleryDelete(); // img-003: the cursor moving means the arm no longer aims at anything
  const count = galleryTotalCount();
  if (count === 0) return;
  const next = Math.max(0, Math.min(count - 1, index));
  const tag = ui.galleryTag;
  const token = galleryToken;
  const place = (): void => {
    if (token !== galleryToken) return; // superseded while the window loaded
    setGalleryIndex(next);
    void tick().then(() => {
      const grid = document.getElementById("gallery-grid");
      // Absolute index -> DOM position, converted here at the point of use rather
      // than assuming child position n is item n: with a window (Task 12) and
      // spacer divs, it is not (tags-002).
      const el = grid?.querySelector(`[data-gallery-index="${next}"]`) as HTMLElement | null;
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest" });
    });
  };
  if (tag) {
    // A page fetch failing here must not leave an unhandled rejection sitting
    // on a keypress — better to leave the cursor where it was than to break
    // the next arrow key too.
    void applyWindow(tag, next, token).then(place).catch(() => {});
  } else {
    place();
  }
}

/** Arrow/Home/End navigation inside the grid. Returns true when handled. */
function handleGalleryKey(e: KeyboardEvent): boolean {
  if (ui.galleryItems.length === 0) return false;
  const cols = galleryColumns();
  const cur = ui.galleryIndex < 0 ? 0 : ui.galleryIndex;
  switch (e.key) {
    case "ArrowRight":
      focusGalleryTile(cur + 1);
      return true;
    case "ArrowLeft":
      focusGalleryTile(cur - 1);
      return true;
    case "ArrowDown":
      focusGalleryTile(cur + cols);
      return true;
    case "ArrowUp":
      focusGalleryTile(cur - cols);
      return true;
    case "Home":
      focusGalleryTile(0);
      return true;
    case "End":
      // tags-002: the real total, not the window's length — see galleryTotalCount.
      focusGalleryTile(galleryTotalCount() - 1);
      return true;
    case "#":
      openTagPopover();
      return true;
    case "Delete":
      // img-003 final review: the tag popover is not a focus trap — clicking a
      // chip or a suggestion (TagPopover.svelte) leaves focus on a <button>
      // with nothing refocusing the input, so this key still reaches here.
      // Both the armed-tile outline and the flash toast render underneath the
      // popover's scrim, so a destructive key must not fire while its own
      // feedback cannot be seen. Falls through as unhandled rather than
      // preventing default — there is nothing else bound to Delete to leak into.
      //
      // tags-004 fix round 1 (#3): the delete-tagged confirmation panel is the
      // identical case — same scrim hiding the same armed-tile outline and
      // flash toast, same non-trapped focus (its Cancel/Delete buttons don't
      // refocus the grid) — so the guard now covers both panels.
      if (ui.tagPopoverOpen || ui.tagDeleteOpen) return false;
      void doGalleryDelete();
      return true;
    default:
      return false;
  }
}

/**
 * Delete the tile under the grid's cursor, to the Recycle Bin (img-003).
 *
 * The most accident-prone surface in this feature — a bare keypress on a
 * focused grid — so it carries the same two-press arm as the viewer AND makes
 * the armed tile visibly pending. An arm legible only to a screen reader is
 * not enough when the trigger needs no pointer.
 */
export async function doGalleryDelete(): Promise<void> {
  if (!actions.delete) return; // android-001: no Recycle Bin on this platform
  // -1 means no tile has ever been focused (ux-004). Deleting tile 0 on a hunch
  // would destroy something the user never pointed at, in a folder that may hold
  // thousands. This is the same refusal currentTagTarget makes, for a much
  // higher-stakes action.
  if (ui.galleryIndex < 0) return;
  // ABSOLUTE -> windowed, exactly as currentTagTarget does: a tag view's window
  // slides, and an unoffset read would delete whatever landed at that array slot.
  const item = ui.galleryItems[ui.galleryIndex - ui.galleryWindowStart];
  if (!item || item.pending) return; // no real identity yet
  // tags-003 final review (Finding 1): a hidden slot renders no tile at all
  // (Gallery.svelte), so the only way the cursor could sit here is an
  // arrow-key step landing on a run of hidden members between two visible
  // ones — never a deliberate point at something the user can see. Same
  // silent decline as `pending`, for the same reason.
  if (item.hidden) return;
  if (item.missing) {
    flashGalleryAction("That file is already gone.");
    return;
  }
  if (item.kind === "folder" || item.kind === "archive") {
    flashGalleryAction("Only photos and videos can be deleted from here.");
    return;
  }
  if (item.archive) {
    flashGalleryAction("A page inside an archive cannot be deleted.");
    return;
  }

  const key = deleteArmKey(item.archive, item.path);
  if (!isArmedFor(galleryArm, key, Date.now())) {
    galleryArm = armDelete(key, Date.now(), DELETE_ARM_MS);
    ui.galleryDeleteArmed = ui.galleryIndex;
    flashGalleryAction(`Press Delete again to move ${item.name} to the Recycle Bin.`);
    window.clearTimeout(galleryArmTimer);
    galleryArmTimer = window.setTimeout(disarmGalleryDelete, DELETE_ARM_MS);
    return;
  }

  disarmGalleryDelete();
  // img-003 final review: captured before the reload below overwrites both —
  // the reload's own setGalleryIndex(-1) would otherwise erase the position
  // and count that indexAfterDelete needs to land the cursor afterwards.
  const deletedIndex = ui.galleryIndex;
  const countBefore = galleryTotalCount();
  try {
    await tauriInvoke("recycle_file", { path: item.path });
  } catch (err) {
    // Logged here (not just shown) because ui.galleryError only ever renders
    // "Could not delete <name>" — the backend's actual reason (refused
    // directory, path not allowed, bin unavailable), already split from the
    // public string by ipc_error on the Rust side, otherwise leaves no trace
    // at all. Same reasoning as the "copy image" console.error above.
    console.error("gallery delete", err);
    ui.galleryError = `Could not delete ${item.name}.`;
    return;
  }
  perfMark("gallery.deleted", item.name);
  flashGalleryAction(`${item.name} moved to the Recycle Bin.`);
  // Reload so the grid matches the disk, branching the way the rest of the file
  // does. This is what pruneMissingFromTag does after it applies (controller.ts
  // :4386) — there is no generic reloadGallery, and adding one for this would be
  // a third path to keep in step with the other two.
  if (ui.galleryTag) await openGalleryForTag(ui.galleryTag);
  else await openGalleryForFolder(ui.galleryPath);
  // img-003 final review: both reload paths reset the cursor to -1 (ux-004's
  // "a fresh grid starts with no keyboard cursor"), which meant every grid
  // delete dropped focus to document.body and the roving tabindex snapped
  // back to tile 0 -- so culling a folder, the actual use case for a grid
  // delete, meant re-entering and re-arrowing after every single file. Land
  // on the tile that slid into the deleted one's place instead, mirroring
  // stepPhoto's use of this same indexAfterDelete in the viewer.
  // focusGalleryTile both sets the cursor and gives the tile real DOM focus,
  // so the roving tabindex agrees with it too.
  const landing = indexAfterDelete(deletedIndex, countBefore);
  if (landing >= 0) focusGalleryTile(landing);
}

let galleryArm: DeleteArm | null = null;
let galleryArmTimer: number | undefined;

/** Drop the grid's arm. Called on expiry, on any cursor move, and whenever the
 *  listing changes underneath it — an arm that outlives what it was aimed at is
 *  not a confirmation, the rule disarmPrune already follows. */
function disarmGalleryDelete(): void {
  galleryArm = null;
  ui.galleryDeleteArmed = -1;
  window.clearTimeout(galleryArmTimer);
  galleryArmTimer = undefined;
}

/**
 * The one place `ui.galleryIndex` is allowed to change (img-003 fix round 1).
 *
 * The arm names a TILE, not a position -- it is only valid while the cursor
 * still points at the file it was armed for. `focusGalleryTile`'s own disarm
 * only covered arrow-key movement; a plain tile click (`openGalleryItem`) set
 * the cursor directly and slipped past it, leaving a stale red outline on the
 * tile that was actually armed instead of the one now under the cursor. A
 * scattered disarm call at every writer has already needed a second round to
 * find the one that got missed, so every write is routed through here instead
 * -- one choke point that stays correct even if a future call site forgets to
 * think about deletion at all.
 */
export function setGalleryIndex(next: number): void {
  ui.galleryIndex = next;
  disarmGalleryDelete();
}

/** Called by the grid's scroll handler (Gallery.svelte Step 2) when the row
 *  scrolled to leaves the middle third of the currently loaded window
 *  (tags-002). A no-op outside a tag view — only a tag view has a window to
 *  slide; every other gallery is loaded in full already. */
export function onGalleryScroll(focusIndex: number): void {
  if (!ui.galleryTag) return;
  // A page fetch failing mid-scroll must not surface as an unhandled
  // rejection — the window simply stays put until the next scroll retries it.
  void applyWindow(ui.galleryTag, focusIndex, galleryToken).catch(() => {});
}

/** Open the Gallery grid for the folder the CURRENT photo lives in (the viewer's
 *  grid button and the G key). */
export async function openGalleryFromImage(): Promise<void> {
  if (ui.photoQueue.length === 0) return;
  // ux-001: G opened the grid FROM this photo, so Back returns to this photo.
  const from = currentPath;
  if (from) {
    // gallery-004: the ORIGIN travels with the path in this closure, because Back
    // re-enters `from` through loadFromPath — and by then the origin has usually
    // moved on (descend into a nested level and open a page there) or been
    // cleared. loadFromPath's mirror-directory scoping would then find a
    // non-matching origin and drop it, silently reverting all three surfaces at
    // once: the subtitle falls back to `pb-ar-<hash>`, G reopens the mirror as a
    // real folder, and a cache path is written into PERSISTED recents — the
    // sticky one, since it outlives the session and dead-ends after the 30-day
    // prune. Capturing by reference is safe because the origin is only ever
    // REPLACED with a fresh object, never mutated in place.
    //
    // This is the only nav closure that needs it: `galleryNavEntry` restores grid
    // state and calls clearImageView() rather than re-entering a media path, and
    // every other loadFromPath call site is either a fresh user-initiated open
    // (where dropping the origin is correct) or a sibling step the mirror-directory
    // scoping already covers.
    const origin = currentArchiveOrigin;
    pushNav({
      label: `image:${basename(from)}`,
      restore: () => {
        currentArchiveOrigin = origin;
        return loadFromPath(from);
      },
    });
  }
  // gallery-004: a page inside an archive has no real folder to open — its parent
  // directory is the mirror cache. Handing that to openGalleryForFolder opened
  // the MIRROR as if it were an ordinary folder: `pb-ar-<hash>` as the title and
  // breadcrumb, `ui.galleryArchive` left "" while the grid showed archive
  // contents, and (for a zip) only whatever had been materialized so far rather
  // than the archive's real contents. Route back to the archive LEVEL instead.
  const origin = currentArchiveOrigin;
  if (origin) {
    await openArchiveGallery(origin.archive, origin.innerDir);
    return;
  }
  // gallery-002: this used to reuse `photoQueue` with no IPC at all, but that queue
  // is images-only by design (sibling Prev/Next must never land on a directory), so
  // the grid would have hidden sub-folders depending on how it was reached. It now
  // takes the same listing path as "Open folder" — one read_dir — so the same folder
  // always shows the same tiles.
  const folder = dirnameOf(ui.photoQueue[Math.max(0, ui.photoIndex)]?.path ?? from ?? "");
  await openGalleryForFolder(folder);
}

// ---------------------------------------------------------------------------
// gallery-005: keeping the open view in step with the folder behind it.
//
// One watch at a time, because one folder backs the active view. An archive
// gallery and a tag gallery are deliberately NOT watched: an archive's inside
// is not a directory, and a tag's membership comes from SQLite, not from disk.
// ---------------------------------------------------------------------------

/** The folder currently watched (""), so a re-target to the same folder is a
 *  no-op — moving from a grid into a photo in the SAME folder must not churn
 *  the native watcher. */
let watchedDir = "";

/** gallery-005: `touched` paths that arrived while the grid for `watchedDir` was not the
 *  view (the user was in the viewer or player). Back re-lists the grid, and without these a
 *  file replaced in place meanwhile would come back with its old picture — the same bug the
 *  `touched` hint exists to prevent, reintroduced through the Back button. Cleared when the
 *  watch changes target and when a restore consumes it. */
const touchedWhileAway = new Set<string>();

/** False when the native watcher could not attach (a network share, a removed
 *  drive). The poll fallback is armed instead — see `startWatchPoll`. */
let watchLive = false;

/**
 * Point the single folder watch at `path`, or drop it when `path` is null.
 * Best-effort throughout: a failure here costs liveness, never the view.
 */
async function watchFolder(path: string | null): Promise<void> {
  const want = path ?? "";
  if (want === watchedDir) return; // already pointed here — no churn
  stopWatchPoll();
  watchedDir = want;
  touchedWhileAway.clear(); // those paths belonged to the folder being left
  watchLive = false;
  if (!want) {
    await tauriInvoke<void>("unwatch_folder", {}).catch(() => {});
    return;
  }
  const status = await tauriInvoke<{ watching: boolean; reason: string }>("watch_folder", {
    path: want,
  }).catch(() => null);
  if (watchedDir !== want) return; // superseded while the call was in flight
  watchLive = !!status?.watching;
  perfMark("watch.begin", `${want}|${watchLive ? "live" : "poll"}`);
  if (!watchLive) startWatchPoll(want);
}

/** The poll fallback's timer. Only armed when the native watcher could not
 *  attach, and only ticking while the window has focus — a background window
 *  polling a network share is IO nobody asked for. */
let watchPollTimer: ReturnType<typeof setInterval> | null = null;

/** 4s: long enough not to be IO the user pays for, short enough that the
 *  feature still feels like it works on a folder that cannot be watched. */
const WATCH_POLL_MS = 4000;

/** True while a poll tick's re-list is still running. The poll exists for slow
 *  folders (a network share), where one listing can outlast the 4s interval —
 *  without this, each tick would start another on top of it and they would pile
 *  up on the main thread. A tick that finds one in flight is simply skipped. */
let watchPollInFlight = false;

function startWatchPoll(dir: string): void {
  stopWatchPoll();
  watchPollTimer = setInterval(() => {
    if (document.hidden || !document.hasFocus()) return;
    if (watchedDir !== dir) return;
    if (watchPollInFlight) return;
    // Same downstream path as the watcher, with no `touched` hint: a poll
    // cannot tell a rewritten file from an untouched one without stat-ing
    // every entry, which perf-010 measured at ~600ms on a 19,522-entry walk.
    watchPollInFlight = true;
    void onFolderChanged(dir, []).finally(() => {
      watchPollInFlight = false;
    });
  }, WATCH_POLL_MS);
}

function stopWatchPoll(): void {
  if (watchPollTimer !== null) clearInterval(watchPollTimer);
  watchPollTimer = null;
}

/**
 * The open folder changed on disk (gallery-005). Re-list it canonically and
 * merge, rather than trusting the event to say what is in there.
 *
 * ORDER MATTERS, for the same reason `showListing` documents: `ui` is a Svelte 5
 * `$state` proxy, so a merge built from raw objects would hand the grid
 * different proxies of the same items than the listing holds — a `thumbSrc`
 * written afterwards would land on one and be read from the other, and every
 * thumbnail would silently blank. The merge therefore reads its `current` FROM
 * `ui.galleryListing` and the result is assigned back BEFORE anything filters it.
 */
async function onFolderChanged(dir: string, touched: string[]): Promise<void> {
  const context = (): FolderChangeContext => ({
    dir,
    watchedDir,
    view: ui.view,
    galleryPath: ui.galleryPath,
    archive: ui.galleryArchive,
    tag: ui.galleryTag,
  });
  if (!folderChangeApplies(context())) return;

  // The canonical listing below only feeds the GRID. While the viewer or the
  // player is the view, reading it would be a full-folder walk on the main
  // thread whose result is thrown away — so skip straight to the queues, and
  // keep the `touched` hint for when Back re-lists the grid (see
  // `touchedWhileAway`).
  if (!gridShouldRelist(context())) {
    for (const p of touched) touchedWhileAway.add(p);
    await refreshOpenQueues(dir);
    return;
  }

  let nodes;
  try {
    nodes = await readGalleryNodes(dir);
  } catch {
    // REVIEW FOCUS 2: the folder was deleted or the drive was unmounted.
    // Leave the grid as it is — blanking a populated view on a transient error
    // is worse than being briefly out of date — and stop watching, so an
    // unmounted drive cannot drive an endless failing re-list loop.
    perfMark("watch.failed", dir);
    void watchFolder(null);
    return;
  }
  // Re-checked AFTER the await: the user can leave, or a newer watch can land,
  // while the listing is in flight.
  if (!folderChangeApplies(context())) return;

  if (gridShouldRelist(context())) {
    const merged = mergeListing(ui.galleryListing, toGalleryItems(nodes), new Set(touched));
    if (merged.changed) {
      ui.galleryListing = merged.listing;
      const r = reviseGrid(ui.galleryListing, hiddenKeys, ui.galleryItems, ui.galleryIndex);
      // `reviseGrid` decides "nothing moved" by comparing KEYS, which is exactly
      // right for the blacklist caller it was written for: there an item's identity
      // never changes, only whether it is shown. A disk refresh breaks that
      // assumption -- a file replaced in place keeps its path, so its key and the
      // grid's length are both unchanged while its CONTENT, and therefore the
      // thumbnail it needs, is not. In that case reviseGrid hands back the caller's
      // own stale array and the replaced tile keeps its old picture forever. We are
      // already inside `merged.changed`, so we know better than its short-circuit:
      // take the freshly-filtered listing, whose replaced entry carries no thumbSrc
      // and will therefore be re-rendered. Filtering through `ui.galleryListing`
      // (not the local `merged.listing`) keeps the proxy rule above intact.
      ui.galleryItems = r.changed ? r.items : filterBlacklisted(ui.galleryListing, hiddenKeys);
      setGalleryIndex(r.cursor);
      rearmThumbFill();
      perfMark("gallery.relist", String(ui.galleryItems.length));
    }
  } else {
    // The user left the grid while the listing was in flight — this event's
    // hint is owed to the Back re-list, exactly as in the early exit above.
    for (const p of touched) touchedWhileAway.add(p);
  }
  await refreshOpenQueues(dir);
}

/**
 * Bring the photo queue and the video folder queue back in step with `dir`
 * (gallery-005).
 *
 * This is a TARGETED exception to perf-010's `keepQueue`, not a reversal of it:
 * the queue is still never rebuilt per arrow key, only when disk actually
 * changed — and those events arrive at human speed, not at key-repeat speed.
 */
async function refreshOpenQueues(dir: string): Promise<void> {
  if (ui.galleryTag) return; // a tag's queue IS the tag; it does not come from disk

  if (ui.view === "image" && ui.photoQueue.length > 0) {
    const openIndex = ui.photoIndex;
    const open = ui.photoQueue[openIndex]?.path ?? "";
    if (dirnameOf(open) === dir) {
      const paths = await tauriInvoke<string[]>("list_folder_images", { path: dir }).catch(
        () => null,
      );
      // Re-checked AFTER the await on every count that can change during it: the
      // folder can stop being the watched one, the user can leave the viewer, and
      // they can step to a different photo. A listing measured at up to 9.8s worst
      // case is a wide window, and acting on the captured `open` afterwards would
      // re-point the queue at a photo the user has moved off -- or, through
      // openImage, drag them back into a viewer they had already left.
      if (
        paths &&
        dir === watchedDir &&
        ui.view === "image" &&
        ui.photoIndex === openIndex &&
        ui.photoQueue[openIndex]?.path === open
      ) {
        const sorted = sortPathsNatural(paths);
        // tags-003: filter the mapped QueueItems and derive the index from that
        // SAME filtered list, exactly as buildPhotoQueue does. Resolving against
        // the unfiltered `sorted` would hand back a position meant for a longer
        // array, and a blacklisted photo would reappear in the counter and in
        // Prev/Next after every live refresh.
        const queueItems = filterBlacklisted(
          sorted.map((p): QueueItem => ({ path: p, name: basename(p) })),
          hiddenKeys,
        );
        ui.photoQueue = queueItems;
        const visible = queueItems.map((q) => q.path);
        const next = queueIndexAfterRefresh(open, openIndex, visible);
        perfMark("photoqueue.relist", String(visible.length));
        if (next < 0) {
          goBack(); // nothing left to land on
        } else if (visible[next] === open) {
          ui.photoIndex = next; // the open photo survived; only its position moved
        } else {
          // The open photo is gone from disk. Land exactly as an in-app delete lands:
          // stepPhoto goes through loadFromPath, so `currentPath` follows the picture —
          // tagging, Delete, Reveal and Info then act on the photo actually on screen.
          // It owns ui.photoIndex; do not set it here too.
          void stepPhoto(next);
        }
      }
    }
  }

  // A user playlist (play-014) is not the folder's queue; a disk change must not replace it.
  if (ui.queue.length > 0 && !playlistActive) {
    const openIndex = ui.queueIndex;
    const open = ui.queue[openIndex]?.path ?? "";
    if (dirnameOf(open) === dir) {
      const paths = await tauriInvoke<string[]>("list_folder_videos", { path: open }).catch(
        () => null,
      );
      if (
        paths &&
        paths.length > 0 &&
        dir === watchedDir &&
        !playlistActive && // re-checked: a playlist can start while the listing is in flight
        ui.queue[openIndex]?.path === open
      ) {
        const sorted = sortPathsNatural(paths);
        ui.queue = sorted.map((p): QueueItem => ({ path: p, name: basename(p) }));
        // A DELIBERATE ASYMMETRY with the photo branch above: if the playing
        // file has gone, playback is LEFT ALONE. It is streaming from an open
        // handle, and taking the picture away mid-watch is worse than a stale
        // queue row. (On Windows an open file usually cannot be deleted at all.)
        ui.queueIndex = resolveQueueIndex(sorted, open);
        perfMark("queue.relist", String(sorted.length));
      }
    }
  }
}

/**
 * Open the Gallery grid for a folder: Home's "Open folder", the image viewer's G,
 * and (gallery-002) clicking a sub-folder tile all land here.
 *
 * `crumbs` is the breadcrumb trail to display; a caller descending into a
 * sub-folder passes the parent's trail plus the new leaf, and everything else
 * lets it default to just this folder.
 */
export async function openGalleryForFolder(
  path: string,
  opts: { crumbs?: string[] } = {},
): Promise<void> {
  perfMark("gallery.begin", basename(path)); // perf-005
  const token = ++galleryToken;
  const label = basename(path);
  ui.galleryItems = [];
  ui.galleryListing = [];
  ui.galleryFolder = label;
  ui.galleryPath = path;
  ui.galleryArchive = ""; // gallery-004: a real folder is not inside an archive
  ui.galleryInner = "";
  ui.galleryTag = "";
  ui.galleryTagTotal = 0;
  ui.galleryTagCapped = false;
  disarmPrune(); // tags-002 fix-wave: leaving the tag for a folder leaves any armed prune too
  // tags-002: a folder view is never windowed — every tile it renders IS the
  // gallery, so its absolute indices start at 0. Without this reset, leaving a
  // tag scrolled deep in (a non-zero windowStart) for a tagged FOLDER tile
  // would carry that stale offset into this session: Gallery.svelte's tiles
  // would carry `data-gallery-index` values starting at the stale offset while
  // focusGalleryTile/the roving tabindex assume indices start at 0, so no tile
  // would ever match and keyboard navigation would silently stop working.
  ui.galleryWindowStart = 0;
  ui.galleryCrumbs = opts.crumbs ?? [label];
  ui.galleryError = "";
  ui.galleryLoading = true;
  ui.emptyError = "";
  setPanelOpen(false);
  setShortcutsOpen(false);
  ui.view = "gallery";
  document.title = `${label} — Playback`;
  try {
    // Authorizing the folder is what extends the (non-recursive) asset-protocol
    // scope to it. The IPC read gate is a prefix check, so descending into a
    // sub-folder of an already-open gallery grants no new filesystem reach.
    await authorizeMediaDir(path, "dir");
    void watchFolder(path); // gallery-005: keep this grid in step with the folder
    const nodes = await readGalleryNodes(path);
    if (ui.view !== "gallery" || ui.galleryPath !== path) return; // superseded by a newer open
    setGalleryIndex(-1); // ux-004: a fresh grid starts with no keyboard cursor
    // Reset the thumbnail pipeline BEFORE the items land. startGalleryThumbs
    // disconnects the previous IntersectionObserver, so doing it afterwards can
    // throw away observations for tiles that already mounted — those tiles then
    // never request a thumbnail and shimmer forever.
    startGalleryThumbs(token);
    // tags-003: filtered before the length check below, so a folder that is
    // entirely blacklisted reports "nothing to show" instead of rendering an
    // unexplained empty grid.
    const items = showListing(toGalleryItems(nodes));
    perfMark("gallery.items", String(items.length)); // perf-005
    // gallery-002: a folder holding only SUB-folders is a perfectly good gallery,
    // so this is only an error when there is nothing of either kind to show.
    if (items.length === 0) ui.galleryError = "Nothing to show in this folder.";
  } catch (err) {
    if (ui.view === "gallery" && ui.galleryPath === path) {
      ui.galleryError = `Could not open this folder: ${String(err)}`;
    }
  } finally {
    if (ui.view === "gallery" && ui.galleryPath === path) ui.galleryLoading = false;
  }
}

/**
 * Open the Gallery grid for the inside of an archive (gallery-004) — an archive
 * tile, a folder tile within one, drag-drop, the file picker, or a Recent card
 * all land here.
 *
 * The shape mirrors `openGalleryForFolder` exactly, because to everything below
 * the listing an archive level IS a folder: same token guard, same thumbnail
 * pipeline reset, same empty-state message. The only differences are which
 * command lists it and that `ui.galleryArchive` is set, which is how the tile
 * handlers know their `path` is an inner path rather than a file.
 */
export async function openArchiveGallery(
  archive: string,
  inner: string,
  opts: { crumbs?: string[] } = {},
): Promise<void> {
  const label = inner === "" ? basename(archive) : pathLeafOf(inner);
  perfMark("gallery.begin", label);
  const token = ++galleryToken;
  ui.galleryItems = [];
  ui.galleryListing = [];
  ui.galleryFolder = label;
  ui.galleryPath = archive;
  ui.galleryArchive = archive;
  ui.galleryInner = inner;
  ui.galleryTag = "";
  ui.galleryTagTotal = 0;
  ui.galleryTagCapped = false;
  disarmPrune(); // tags-002 fix-wave: same as openGalleryForFolder — leaving the tag
  // tags-002: see the matching reset in openGalleryForFolder — an archive
  // level is never windowed either, so a stale non-zero windowStart carried
  // over from a tag session would break keyboard focus the same way.
  ui.galleryWindowStart = 0;
  ui.galleryCrumbs = opts.crumbs ?? [basename(archive)];
  ui.galleryError = "";
  ui.galleryLoading = true;
  ui.emptyError = "";
  setPanelOpen(false);
  setShortcutsOpen(false);
  ui.view = "gallery";
  document.title = `${label} — Playback`;
  try {
    // The ARCHIVE FILE's directory is what needs authorizing; the native side
    // gates on the archive and materializes only into its own cache.
    await authorizeMediaDir(archive);
    void watchFolder(null); // gallery-005: an archive's inside is not a directory
    const nodes = await readArchiveNodes(archive, inner);
    if (ui.view !== "gallery" || ui.galleryArchive !== archive || ui.galleryInner !== inner) {
      return; // superseded by a newer open
    }
    setGalleryIndex(-1);
    startGalleryThumbs(token);
    // tags-003: same reasoning as openGalleryForFolder — filter before the
    // length check so an entirely-blacklisted archive level reports "nothing
    // to show" instead of an unexplained empty grid.
    const items = showListing(toGalleryItems(nodes, archive));
    perfMark("gallery.items", String(items.length));
    if (items.length === 0) ui.galleryError = "Nothing to show in this archive.";
  } catch (err) {
    if (ui.view === "gallery" && ui.galleryArchive === archive && ui.galleryInner === inner) {
      ui.galleryError = `Could not open this archive: ${String(err)}`;
    }
  } finally {
    if (ui.view === "gallery" && ui.galleryArchive === archive && ui.galleryInner === inner) {
      ui.galleryLoading = false;
    }
  }
}

/**
 * Land a folder/archive listing in the grid (tags-003 live hide). The listing
 * is kept whole in `ui.galleryListing` so the blacklist filter can be re-run
 * over it later (`applyHiddenToGrid`); the grid shows what the filter leaves.
 * Returns the tiles shown, for the caller's count and empty-state message.
 *
 * ORDER MATTERS: the listing is assigned to `ui` FIRST and the filter runs over
 * `ui.galleryListing` — the reactive proxy — not over the plain array. Svelte 5
 * keeps a proxied object's writes in the proxy, not on the raw object, so a
 * grid filtered from the raw array would hold DIFFERENT proxies of the same
 * items than the listing does: a `thumbSrc` written into a tile would never
 * reach the listing's copy, and the first re-filter would blank every
 * thumbnail. Filtering through `ui` hands the grid the listing's own proxies.
 */
function showListing(listing: GalleryItem[]): GalleryItem[] {
  ui.galleryListing = listing;
  const items = filterBlacklisted(ui.galleryListing, hiddenKeys);
  ui.galleryItems = items;
  return items;
}

/** Trailing segment of an archive INNER path (always '/'-separated). */
function pathLeafOf(inner: string): string {
  const cut = inner.lastIndexOf("/");
  return cut >= 0 ? inner.slice(cut + 1) : inner;
}

/** Open the native folder picker (Tauri) and open the chosen folder as a gallery. */
export async function openFolderDialog(): Promise<void> {
  if (!actions.openDialogs) return; // android-001: the picker's content:// URIs do not fit the path model
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ multiple: false, directory: true });
    if (typeof selected === "string") {
      resetNav(); // ux-001: picking a folder starts a fresh journey
      await openGalleryForFolder(selected);
    }
  } catch (err) {
    showError(`Open folder unavailable: ${String(err)}`);
  }
}

/** Why an archive open did not put a picture on screen. `declined` is transient —
 *  an extraction already in flight, or a superseded open — so a caller stepping
 *  through a queue should leave its index alone and retry the same entry. `failed`
 *  is terminal: this entry cannot be extracted and never will be, so a stepper must
 *  move past it or it can never cross that page. */
type ArchiveOpen = "opened" | "declined" | "failed";

/**
 * Open one photo or clip from inside an archive (gallery-004).
 *
 * A PHOTO materializes its whole LEVEL first. That is what buys sibling Prev/Next
 * for free: once the level's images are real files in the mirror directory,
 * `buildPhotoQueue`'s existing `list_folder_images` call finds them all with no
 * new navigation code. It also matches the reading path — a user who opens page
 * one is about to press Right two hundred times. The cost is bounded because
 * these are images.
 *
 * A VIDEO materializes only itself: a level of clips could be many gigabytes, so
 * it plays alone (no play-013 queue).
 *
 * Returns why the open did or did not put a picture on screen — see `ArchiveOpen`.
 * tags-002: stepPhoto uses this to decide whether to move `ui.photoIndex`.
 */
async function openArchiveEntry(item: GalleryItem): Promise<ArchiveOpen> {
  // Re-entrancy guard: the .prepping overlay only blocks the POINTER, it does not
  // blur focus or mark tiles inert, so a still-focused tile can fire a native
  // Enter/Space click while the overlay is up. Without this, two calls race on
  // the shared ui.prepping flag — whichever finishes first clears it in its
  // `finally` while the other is still mid-materialization, reopening the click
  // surface before the first load has settled.
  if (ui.prepping) return "declined";
  const archive = item.archive;
  // ux-001 supersede guard. Every other open path here is guarded (galleryToken,
  // imgToken, currentPath); this one was not, and it is the one with the longest
  // await. The .prepping overlay blocks the POINTER but the global keydown
  // handler has no ui.prepping gate, so Esc during "Extracting…" reaches
  // goBack(): the user backs out to the parent grid, then the materialization
  // finishes and yanks them into the viewer of the page they abandoned.
  // galleryToken is the right token because it is bumped by exactly the two
  // things that invalidate this open — a newer gallery open, and a nav-stack
  // restore.
  const token = galleryToken;
  ui.prepping = true;
  // M1: the overlay's TITLE says what is happening; the label slot underneath is
  // the filename, in this flow as in the remux one. Before this, extraction put
  // "Extracting…" in the label and the hard-coded title still read "Preparing
  // video…", so the primary flow of this feature announced the wrong operation
  // and dropped the filename entirely.
  ui.preppingTitle = "Extracting…";
  ui.preppingLabel = basename(item.path);
  try {
    const real = await tauriInvoke<string>("archive_entry_file", {
      archive,
      inner: item.path,
    }).catch(() => null);
    if (token !== galleryToken) return "declined"; // superseded: Esc/Back left this level
    if (!real) {
      // showError writes ui.emptyError, which renders ONLY in Home.svelte — and
      // the view during an extraction is the gallery, so routing an entry failure
      // there made it completely invisible: the overlay just vanished and nothing
      // happened. That was the outcome for an encrypted entry, a cap abort and a
      // corrupt page alike. openArchiveGallery already routes LISTING failures to
      // ui.galleryError; entry failures belong on the same surface.
      // tags-002: this path is now reachable from the IMAGE viewer (stepping
      // through a tag), where ui.galleryError is never rendered. A view must not
      // write state only another view shows — Task 9 settled that when the prune
      // flash borrowed ImageView's field.
      if (ui.view === "image") flashImageAction("Could not read that page from the archive.");
      else ui.galleryError = "Could not read that file from the archive.";
      return "failed";
    }
    // tags-002: the level is materialized ONLY so buildPhotoQueue's FOLDER branch
    // finds this page's siblings in the mirror directory. A TAG view's queue comes
    // from the tag instead and that branch never runs, so the whole level would be
    // extracted and never read — and paid AGAIN on every step, since stepping
    // re-enters this function. This condition deliberately mirrors the branch
    // condition in buildPhotoQueue; if that gate changes, change this with it.
    if (item.kind === "image" && !ui.galleryTag) {
      await materializeArchiveLevel(archive, item.path, token);
    }
    if (token !== galleryToken) return "declined"; // superseded while materializing the level
    // gallery-004: record WHERE this page came from before handing the mirror
    // path to loadFromPath, so Recents, the viewer subtitle and the G key all
    // name the archive rather than the cache directory it landed in.
    currentArchiveOrigin = {
      archive,
      innerDir: innerDirOf(item.path),
      mirrorDir: dirnameOf(real),
    };
    // A VIDEO plays alone: a level of clips could be many gigabytes, so there is
    // no play-013 folder queue behind it.
    await loadFromPath(real, false, item.kind === "image" ? {} : { noFolderQueue: true });
    return "opened";
  } finally {
    ui.prepping = false;
  }
}

/** Materialize every IMAGE alongside `inner` in its archive level, so the photo
 *  viewer's sibling queue (built by `buildPhotoQueue` off the mirror directory)
 *  sees the whole level rather than only the page that was clicked. Best-effort:
 *  a page that fails to extract is simply absent from the queue.
 *
 *  `token` is the caller's `galleryToken` snapshot. The loop cannot cancel a
 *  native call already in flight, but it can stop issuing the remaining ones — so
 *  backing out of a three-hundred-page level costs one more extraction, not
 *  three hundred. */
async function materializeArchiveLevel(
  archive: string,
  inner: string,
  token: number,
): Promise<void> {
  const entries = await tauriInvoke<{ images: string[] }>("list_archive_entries", {
    archive,
    inner: innerDirOf(inner),
  }).catch(() => null);
  for (const image of entries?.images ?? []) {
    if (token !== galleryToken) return; // the user left; stop spending on this level
    if (image === inner) continue; // already materialized by the caller
    await tauriInvoke<string>("archive_entry_file", { archive, inner: image }).catch(
      () => null,
    );
  }
}

/**
 * Click (or press Enter on) a tile in the Gallery grid. An image tile opens that
 * photo in the single-image viewer; a sub-folder tile (gallery-002) re-scopes the
 * grid to that folder's contents; a video tile (gallery-003) falls through the same
 * `loadFromPath` funnel as any other open, so it lands in the player with the
 * play-013 folder queue behind it. Either way the current grid is pushed onto the
 * nav stack first, so Back walks the trail back out one level at a time.
 */
export function openGalleryItem(item: GalleryItem): void {
  // tags-002: a missing tile is shown, never opened — the file may come back
  // (an unplugged drive), and there is nothing to view until it does. Refused
  // here rather than via a `disabled` attribute on the tile button, so the
  // tile stays focusable and the roving-tabindex grid keeps every index
  // reachable by keyboard.
  // tags-002 fix-1: a pending tile (its page has not landed yet) is refused
  // the same way — its `path` is a synthetic "pending:N" marker, not a file.
  if (item.missing || item.pending) return;
  // ux-004: record which tile this was, so Back restores the cursor onto it.
  // `indexOf` is a position WITHIN `ui.galleryItems` (the window, Task 12) —
  // offset by `galleryWindowStart` to land back on an absolute index, same as
  // everywhere else the cursor is written (tags-002).
  const index = ui.galleryItems.indexOf(item);
  if (index >= 0) setGalleryIndex(ui.galleryWindowStart + index);
  // ux-001: remember the grid (items + scroll + cursor) so Back returns to it in
  // place rather than dumping the user on the home screen.
  pushNav(galleryNavEntry());
  // gallery-004: an ARCHIVE tile browses like a folder.
  if (item.kind === "archive") {
    void openArchiveGallery(item.path, "", { crumbs: [...ui.galleryCrumbs, item.name] });
    return;
  }
  // A folder INSIDE an archive descends within that archive; `item.path` is an
  // inner path, so it must not be handed to the real-folder listing.
  if (item.archive && item.kind === "folder") {
    void openArchiveGallery(item.archive, item.path, {
      crumbs: [...ui.galleryCrumbs, item.name],
    });
    return;
  }
  if (item.kind === "folder") {
    void openGalleryForFolder(item.path, { crumbs: [...ui.galleryCrumbs, item.name] });
    return;
  }
  // gallery-004: a photo or clip inside an archive must be materialized before
  // any consumer can touch it (Task 9 supplies openArchiveEntry).
  if (item.archive) {
    void openArchiveEntry(item);
    return;
  }
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
  // img-001: guarded on a real CHANGE. The canvas tier takes over from the
  // <img> at the same size, and re-fitting on every animation frame would
  // wrench a zoomed-in GIF back to fit sixty times a second.
  if (imgNatural.width !== bitmap.width || imgNatural.height !== bitmap.height) {
    setImageNaturalSize(bitmap.width, bitmap.height);
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
  // img-001: the transform tools answer for ANY image, animated or still, and
  // are checked first — zoom is the gesture a reader reaches for most.
  switch (e.key) {
    case "+":
    case "=":
      e.preventDefault();
      doImageZoomStep(1);
      return true;
    case "-":
    case "_":
      e.preventDefault();
      doImageZoomStep(-1);
      return true;
    case "0":
      e.preventDefault();
      doImageFit();
      return true;
    case "1":
      e.preventDefault();
      doImageActualSize();
      return true;
    case "r":
    case "R":
      e.preventDefault();
      doImageRotate(1);
      return true;
    case "l":
    case "L":
      e.preventDefault();
      doImageRotate(-1);
      return true;
    case "h":
    case "H":
      e.preventDefault();
      doImageFlip("h");
      return true;
    case "v":
    case "V":
      e.preventDefault();
      doImageFlip("v");
      return true;
    // img-002: actions on the file. All three are free in this view — the
    // player's own c/i bindings are gated on playerVisible().
    case "c":
    case "C":
      e.preventDefault();
      void doImageCopy();
      return true;
    case "e":
    case "E":
      e.preventDefault();
      void doImageReveal();
      return true;
    case "i":
    case "I":
      e.preventDefault();
      void doImageInfo();
      return true;
    // tags-001: '#' rather than 't' — the player already binds 't' to the
    // chapters panel, and one gesture that means the same thing everywhere beats
    // a different key per surface. Never the ONLY way in: '#' sits on different
    // physical keys across layouts, so every surface also has a button.
    case "#":
      e.preventDefault();
      openTagPopover();
      return true;
    default:
      break;
  }
  // Sibling photo nav (gallery-001) and the gallery-grid hotkey work for ANY
  // opened image — animated or a single static frame.
  //
  // img-001: the arrows are shared. While part of the picture is off-screen they
  // pan it, because that is plainly what an arrow means when you are zoomed in;
  // once the whole picture fits they go back to stepping through the folder.
  switch (e.key) {
    case "ArrowRight":
      if (imageArrowsPan()) {
        e.preventDefault();
        doImagePan(-IMAGE_PAN_STEP, 0);
        return true;
      }
      if (ui.photoQueue.length > 1) {
        e.preventDefault();
        doNextPhoto();
        return true;
      }
      return false;
    case "ArrowLeft":
      if (imageArrowsPan()) {
        e.preventDefault();
        doImagePan(IMAGE_PAN_STEP, 0);
        return true;
      }
      if (ui.photoQueue.length > 1) {
        e.preventDefault();
        doPrevPhoto();
        return true;
      }
      return false;
    case "ArrowUp":
      if (imageArrowsPan()) {
        e.preventDefault();
        doImagePan(0, IMAGE_PAN_STEP);
        return true;
      }
      return false;
    case "ArrowDown":
      if (imageArrowsPan()) {
        e.preventDefault();
        doImagePan(0, -IMAGE_PAN_STEP);
        return true;
      }
      return false;
    case "g":
    case "G":
      // gallery-002: no longer gated on having SIBLINGS. The grid now also shows
      // sub-folders, so a folder holding one photo and several albums is exactly
      // the case where you most want to get to the grid.
      if (ui.photoQueue.length > 0) {
        e.preventDefault();
        void openGalleryFromImage();
        return true;
      }
      return false;
    case "Delete":
      // img-003 final review: same guard as the gallery's Delete case — the
      // tag popover can hold focus on a plain <button> (a chip or a
      // suggestion), which does not suppress this hotkey, while the popover's
      // scrim hides both the armed toolbar button and the flash toast.
      //
      // tags-004 fix round 2: the delete-tagged confirmation panel is the
      // identical case, reached the identical way — it traps no focus either,
      // so Tab can land back on a gallery tile and Enter falls through to the
      // browser's default click, opening the image UNDER the panel while
      // tagDeleteOpen stays true. A destructive key must not fire while the
      // arm feedback it depends on is hidden behind an overlay; that rule
      // covers both panels, not just the one img-003 happened to ship first.
      if (ui.tagPopoverOpen || ui.tagDeleteOpen) return false;
      e.preventDefault();
      void doImageDelete();
      return true;
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
    // img-001 moved the rate off +/-, which now zoom every image. The rate
    // button in the transport is unchanged; these are its hotkeys.
    case "]":
      e.preventDefault();
      stepGifRate(1);
      return true;
    case "[":
      e.preventDefault();
      stepGifRate(-1);
      return true;
    default:
      return false;
  }
}

/** Open the native file picker (Tauri) and load the chosen file. */
export async function openFileDialog(): Promise<void> {
  if (!actions.openDialogs) return; // android-001: the picker's content:// URIs do not fit the path model
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Media",
          extensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...ARCHIVE_EXTENSIONS],
        },
        { name: "Video", extensions: VIDEO_EXTENSIONS },
        { name: "Image", extensions: IMAGE_EXTENSIONS },
        { name: "Archive", extensions: ARCHIVE_EXTENSIONS },
      ],
    });
    if (typeof selected === "string") {
      resetNav(); // ux-001: the Open dialog starts a fresh journey
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
/** Same single-vs-double discrimination for the image viewer (ui-007). */
let imageClickTimer: number | null = null;
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

/**
 * Click on the picture in the image viewer (ui-007).
 *
 * Mirrors `onVideoClick`: double-click toggles fullscreen. The image viewer had no
 * click handling at all, so double-clicking a photo or GIF did nothing while the
 * same gesture worked on video — the inconsistency the user reported.
 *
 * img-001 gave the single-click half a job on a STILL image: toggle fit against
 * 100%, anchored where you clicked. An ANIMATED image keeps play/pause, which
 * it has had since ui-007 — a reader watching a GIF reaches for pause far more
 * often than for a zoom, and the zoom is still on the wheel, the keys and the
 * toolbar for them.
 *
 * A click that ends a PAN is swallowed: dragging the picture around would
 * otherwise snap it to a different zoom every time you let go.
 */
export function onImageClick(e: MouseEvent): void {
  if (imgDragMoved) {
    imgDragMoved = false;
    return;
  }
  if (imageClickTimer !== null) {
    clearTimeout(imageClickTimer);
    imageClickTimer = null;
    void doToggleFullscreen();
    return;
  }
  // The event object is pooled-and-reused in some engines, so capture the
  // coordinates now rather than reading them inside the deferred callback.
  const point = { clientX: e.clientX, clientY: e.clientY };
  imageClickTimer = window.setTimeout(() => {
    imageClickTimer = null;
    if (ui.imgMode === "animated") toggleGifPlay();
    else doImageToggleFit(point);
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

    // ux-004: arrow/Home/End navigation inside the gallery grid. Checked before
    // the Esc branch so Esc still backs out, and before the player transport keys
    // so the arrows do not also seek a (paused, hidden) video.
    if (ui.view === "gallery" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (handleGalleryKey(e)) {
        e.preventDefault();
        return;
      }
    }

    // tags-001: the popover is a LAYER over the image and gallery views, whose
    // Esc backs out of the view entirely (ux-001). Without this, Esc while
    // tagging would navigate away and drop the popover with it.
    if (ui.tagPopoverOpen && e.key === "Escape") {
      e.preventDefault();
      closeTagPopover();
      return;
    }

    // tags-004: same reasoning as the tagPopoverOpen guard just above — the
    // delete-confirmation panel is a LAYER over the gallery view it was opened
    // from, whose own Esc (the check right below) backs out of the view
    // entirely. Without this, Esc while confirming would navigate away and
    // leave the panel dangling open over whatever view Back lands on, instead
    // of just cancelling the confirmation.
    if (ui.tagDeleteOpen && e.key === "Escape") {
      e.preventDefault();
      closeTagDeletePanel();
      return;
    }

    // ux-001: Esc backs out one level from the still-image and gallery views,
    // which previously swallowed it entirely (the only way out was the mouse).
    // The player's own Esc cascade below is untouched — it has layers (panels,
    // the Up Next prompt, fullscreen) that must be dismissed first.
    if ((imageViewActive() || ui.view === "gallery") && e.key === "Escape") {
      e.preventDefault();
      goBack();
      return;
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
      case "#":
        if (playerVisible()) {
          e.preventDefault();
          openTagPopover();
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
          ui.tagIndexOpen ||
          ui.moreOpen;
        if (hadPanel) {
          setShortcutsOpen(false);
          setSettingsOpen(false);
          setPanelOpen(false);
          setQueueOpen(false);
          setMoreOpen(false);
          closeTagIndex();
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
        if (mediaPath) { resetNav(); void loadFromPath(mediaPath); } // ux-001: a drop starts a fresh journey
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
    if (path) {
      resetNav(); // ux-001: a launch argument starts a fresh journey
      await loadFromPath(path);
    }
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
      if (path) {
        resetNav(); // ux-001: the single-instance handler starts a fresh journey
        void loadFromPath(path);
      }
    });
  } catch {
    /* Not running under Tauri — single-instance forwarding is unavailable. */
  }
}

/**
 * gallery-005: the native watcher's announcement that the open folder changed.
 * Mirrors `wireSecondInstance` — same event channel, same tolerance of not
 * running under Tauri.
 */
async function wireFolderWatch(): Promise<void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ dir: string; touched: string[] }>("folder-changed", (event) => {
      const { dir, touched } = event.payload ?? { dir: "", touched: [] };
      if (!dir) return;
      void onFolderChanged(dir, touched ?? []);
    });
  } catch {
    /* Not running under Tauri — a live gallery is unavailable. */
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

  observeImageViewport(); // img-001: "fit" re-fits when the window changes size
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
  void wireFolderWatch(); // gallery-005
  renderRecents();
  void loadTagLibrary(); // tags-002: the shelf must be populated on the FIRST
                         // Home paint, not only after a navigation back to it
  void refreshHiddenKeys(); // tags-003: the app must know the blacklist before
                             // the first gallery, same reasoning as above
  void loadTagBlacklist(); // tags-003: same reasoning again — Home.svelte's
  // Tags section (and its only route into the all-tags index, "All tags…")
  // is hidden when tagLibrary is empty, which now also happens when every
  // tag the user has is blacklisted, not just when they have none. Without
  // this, that first Home paint would show no button, no way back into the
  // index, and the "Show blacklisted" un-trap would be unreachable until
  // some OTHER tag got applied. See the matching call in goHome() above.
  renderPlaylists();
  renderTimestamps();
  render();
}

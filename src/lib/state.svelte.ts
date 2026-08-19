/**
 * state.svelte.ts — the single reactive store for the Svelte frontend (arch-001).
 *
 * The former imperative `main.ts` mutated the DOM by id. Here, all UI-visible
 * state lives in one `$state` object (`ui`) that components render declaratively;
 * the controller (controller.ts) mutates `ui.*` instead of poking the DOM, and
 * Svelte re-renders. Pure decisions still live in player-core.ts (untouched).
 *
 * `els` is a plain (non-reactive) registry of the few real DOM handles the
 * imperative media plumbing genuinely needs (the <video>, the deck canvases, the
 * scrub surface, the add-timestamp field) — populated via `bind:this` on mount.
 */
import type { Timestamp, Playlist } from "../player-core";

/** A recent file (home-screen history), persisted in localStorage. */
export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
  duration?: number;
}

/** A scrubber A-B marker (band or end flag), pre-positioned for the template. */
export interface AbMarker {
  kind: "region" | "flag";
  left: number;
  width?: number;
  label?: string;
}

/** A laid-out ruler tick for the cut-view timecode ruler. */
export interface RulerTick {
  left: number;
  major: boolean;
  label: string;
}

/** One entry in the folder queue (play-013): a sibling video and its display name. */
export interface QueueItem {
  path: string;
  name: string;
}

/** One tile in the Gallery grid (gallery-001): a folder image plus its resolved
 *  asset:// src, precomputed by the controller (once, when the list is built) so
 *  the template only binds an <img src> — no Tauri glue in the component.
 *
 *  gallery-002: a tile is now either an `image` to open or a `folder` to descend
 *  into. A folder's `thumbSrc` is a cover picture taken from the first image inside
 *  it, and stays empty when it has none — the tile then shows a folder glyph. */
export interface GalleryItem {
  path: string;
  name: string;
  thumbSrc: string;
  kind: "folder" | "image";
}

/** The active surface — mirrors the former `#app[data-state]` switch. */
export type View = "empty" | "playing" | "image" | "live-unavailable" | "gallery";

export const ui = $state({
  // --- Top-level view ---
  view: "empty" as View,
  cutMode: false,
  dragover: false,
  emptyError: "",
  // Transient "converting…" overlay shown while the ffmpeg sidecar remuxes a
  // transport stream (.ts/.m2ts/.mts) to a playable .mp4 on open (play-016).
  prepping: false,
  preppingLabel: "",

  // --- Standard player (play-001) ---
  isPlaying: false,
  seekValue: 0, // 0..1000 (scrubber)
  progressPct: 0, // 0..100
  bufferedPct: 0, // 0..100
  curText: "0:00",
  totText: "0:00",
  duration: 0, // seconds — used for marker positioning
  volumeValue: 100, // 0..100
  muted0: false, // audible volume is 0 (mute glyph)
  rate: 1,
  title: "",
  subtitle: "",
  chromeVisible: true,
  idle: false,
  centerFlash: false,
  markerFlash: false,
  markerFlashText: "",

  // --- Timestamps / chapters (play-002 / 007 / 008) ---
  timestamps: [] as Timestamp[],
  activeTsIndex: -1,
  // Index of the row being inline-edited (play-017), or -1 when none is.
  editingTsIndex: -1,
  nowChapter: null as { time: string; label: string } | null,
  pinChapter: false,
  panelOpen: false,
  addInputOpen: false,
  shortcutsOpen: false,
  // Overflow "⋯ More" menu in the control bar (ui-005). When the bar is too
  // narrow to fit every control, the secondary buttons relocate into this popover
  // instead of overlapping the centered transport. Open state is mouse-driven.
  moreOpen: false,
  // Whether the control bar is currently overflowing and so collapses its
  // secondary tools into the ⋯ menu. Set by a measurement pass (controller.ts)
  // so the ⋯ shows ONLY when the buttons would otherwise not fit — never when
  // there is room to display them all inline.
  controlsOverflow: false,

  // --- Settings (play-010) ---
  settingsOpen: false,
  // Hardware-accelerated video decode. Mirrors the native pref (the real source of
  // truth, since it drives the WebView2 launch flag); true = GPU decode (default).
  hwaccel: true,
  // Shown after the user flips hwaccel: the launch flag is fixed at webview
  // creation, so the change only applies on the next launch. (Suppressed while
  // the NATIVE engine is active — mpv's hwdec switches at runtime.)
  hwaccelRestartHint: false,

  // --- Playback engine (native-001; default flipped in native-003) ---
  // "native" (default) = embedded libmpv (instant fMP4/TS/MKV open, hardware
  // decode, video under the transparent WebView); "web" = the original <video>
  // path, kept as the compatibility fallback (PiP, or a broken libmpv).
  // Mirrors the native pref file; applies to the NEXT opened file.
  enginePref: "native" as "web" | "native",
  // The engine that loaded the CURRENT file (drives PiP gating, hwaccel hint).
  engineActive: "web" as "web" | "native",
  // False when libmpv-2.dll is missing/incompatible — the Settings row then
  // shows the unavailable hint and the app silently stays on the web engine.
  engineAvailable: true,
  // Shown after flipping the engine: applies to the next video opened.
  engineHint: false,

  // --- Loop / A-B (play-011) ---
  loopOn: false,
  abA: null as number | null,
  abB: null as number | null,
  abMarkers: [] as AbMarker[],

  // --- Folder queue / playlist (play-013) ---
  // The sibling videos of the opened file, in natural sort order; derived fresh
  // from the folder on every open (no persistence). `queueIndex` is the currently
  // playing item (-1 when there is no queue). `repeatAll` wraps last->first on
  // auto-advance / Next / Previous. `queueOpen` toggles the queue panel.
  queue: [] as QueueItem[],
  queueIndex: -1,
  repeatAll: false,
  queueOpen: false,
  // Label shown above the queue-panel list: "FOLDER QUEUE" for the play-013 auto
  // queue, or the playlist's name when a user-created playlist (play-014) is playing.
  queueLabel: "FOLDER QUEUE",
  // Autoplay (play-018). When false (the default) the player ASKS before playing
  // the next queue item — an end-of-video "Up Next" prompt (`nextPromptOpen`,
  // naming `nextPromptName`). When true it auto-advances silently, as play-013
  // always did. Persisted to localStorage `playback:autoplay`.
  autoplay: false,
  nextPromptOpen: false,
  nextPromptName: "",

  // --- User-created playlists (play-014) ---
  // The saved playlist collection (home-screen "Playlists" section), mirrored from
  // the `playback:playlists` localStorage store. `playlistEditorOpen` shows the
  // editor overlay for `editingPlaylistId` (create/rename, add/remove/reorder items).
  playlists: [] as Playlist[],
  playlistEditorOpen: false,
  editingPlaylistId: null as string | null,

  // --- Cut / timeline view (play-004) ---
  cutTitle: "",
  cutMeta: "",
  smpteCur: "00:00:00:00",
  smpteTot: "00:00:00:00",
  fpsLabel: "· — fps",
  playheadPct: 0,
  shuttleDir: 0, // -1 | 0 | 1
  shuttleBadge: "", // "" => hidden
  rulerTicks: [] as RulerTick[],

  // --- Picture-in-picture (play-015) ---
  pipSupported: false,
  pipActive: false,

  // --- Image / GIF viewer (play-012) ---
  imgMode: "loading",
  imgTitle: "",
  imgMeta: "",
  imgFrameInfo: "",
  imgRateLabel: "1×",
  imgPlaying: true,
  imgCanvasHidden: true,
  imgElHidden: true,
  imgErrorHidden: true,

  // --- Photo sibling nav + gallery (gallery-001) ---
  // The other images in the current photo's folder, in natural sort order —
  // derived fresh on every image open (mirrors the play-013 folder queue, but for
  // stills: images don't fire an "ended" event, so this is manual Prev/Next only,
  // never auto-advancing). `photoIndex` is the currently-viewed item (-1 = none).
  photoQueue: [] as QueueItem[],
  photoIndex: -1,
  // The full-screen grid browser: every image in a chosen folder. Populated either
  // from the image viewer's Grid button (reuses `photoQueue`, no extra IPC) or from
  // Home's "Open folder" action (a fresh `list_folder_images` call).
  galleryItems: [] as GalleryItem[],
  galleryFolder: "",
  galleryLoading: false,
  galleryError: "",
  // gallery-002: the folder path the grid is currently showing, and the trail of
  // folder names from wherever this gallery journey started down to it — the
  // header's breadcrumb, so a nested sub-gallery says where it sits.
  galleryPath: "",
  galleryCrumbs: [] as string[],
  // ux-004: the grid's keyboard cursor. Arrow keys move it, Enter opens it, and
  // it drives a roving tabindex so Tab enters/leaves the grid as ONE stop
  // instead of walking through every tile (a folder of thousands would otherwise
  // be a tab trap). -1 until the grid is first focused.
  galleryIndex: -1,

  // --- Livestream · Unavailable (frame 04b) ---
  liveTitle: "Livestream",
  liveMeta: "Livestream",

  // --- Home / recents (ui-001) ---
  recents: [] as RecentFile[],
  // ui-006: real poster frames for the recent cards, keyed by file path and
  // resolved in the background from the native thumbnail cache. Kept OUT of
  // `recents` itself because that list is persisted to localStorage and these
  // are disposable cache paths. A path with no entry falls back to the
  // deterministic colour gradient the cards used before.
  recentThumbs: {} as Record<string, string>,
});

/** Real DOM handles the imperative plumbing needs; set via bind:this on mount. */
export const els: {
  video?: HTMLVideoElement;
  cutGen?: HTMLVideoElement;
  cutFilmstrip?: HTMLCanvasElement;
  cutWaveform?: HTMLCanvasElement;
  cutTimeline?: HTMLDivElement;
  imgCanvas?: HTMLCanvasElement;
  imgEl?: HTMLImageElement;
  tsAddInput?: HTMLInputElement;
  /** The inline timestamp-edit field — mounts only while a row is being edited (play-017). */
  tsEditInput?: HTMLInputElement;
} = {};

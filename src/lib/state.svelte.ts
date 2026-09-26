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
import {
  parseFeatures,
  visibleActions,
  type VisibleActions,
  type StorageCard,
  type ImageToolPage,
} from "../platform-core";

/** android-001: this build's capabilities, injected by the native side before
 *  any script ran (see platform.rs). Fixed for the life of the process. */
const features = parseFeatures(
  (globalThis as { __PLAYBACK_FEATURES__?: unknown }).__PLAYBACK_FEATURES__,
);

/** Which controls this build renders. Non-reactive: features never change. */
export const actions: VisibleActions = visibleActions(features);

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
  /** tags-002: set only for a queue entry that lives INSIDE an archive — this
   *  is the archive's real path on disk, and `path` is then the inner path
   *  (`ch1/page01.jpg`), which is not a file until it is materialized. "" or
   *  absent for an ordinary file. */
  archive?: string;
}

/** One tile in the Gallery grid (gallery-001): a folder image plus its resolved
 *  asset:// src, precomputed by the controller (once, when the list is built) so
 *  the template only binds an <img src> — no Tauri glue in the component.
 *
 *  gallery-002: a tile is now either an `image` to open or a `folder` to descend
 *  into. A folder's `thumbSrc` is a cover picture taken from the first image inside
 *  it, and stays empty when it has none — the tile then shows a folder glyph.
 *
 *  gallery-003: a `video` tile opens in the player rather than the photo viewer.
 *  Its `thumbSrc` is a poster frame (the same `media_thumbnail` pipeline, which
 *  already seeks a few seconds in for video), and `durationLabel` is its running
 *  time — empty until probed, and STAYING empty for a file whose container reports
 *  no honest duration, so the badge is never a fabricated 0:00.
 *
 *  gallery-004: an `archive` tile (.zip/.cbz/.rar/.cbr) is browsed like a folder.
 *  An item that came from INSIDE an archive carries that archive's real path in
 *  `archive`, and its `path` is an INNER path (`ch1/page01.jpg`) — not a file on
 *  disk until it is materialized. `archive` is "" for everything else. */
export interface GalleryItem {
  path: string;
  name: string;
  thumbSrc: string;
  kind: "folder" | "image" | "video" | "archive";
  durationLabel: string;
  archive: string;
  /** tags-002: true when this item's file is gone from disk. Only a TAG view
   *  sets it — a folder listing can only contain files that exist. A missing
   *  tile renders dimmed and does not open. */
  missing?: boolean;
  /** tags-002: true for a window row whose page has not landed yet. Distinct from
   *  `missing`: the row is not gone, it is not here YET. Renders as the ordinary
   *  loading shimmer and refuses to open, tag or fetch a thumbnail. */
  pending?: boolean;
  /** tags-003 final review (Finding 1): true when this item carries a
   *  blacklisted tag AND the tag view it is in is not itself the blacklisted
   *  one (see `shouldFilterTagView` in controller.ts). Only a TAG view's grid
   *  sets it. Renders no tile at all -- unlike `missing`, which still shows a
   *  dimmed one -- because this item must disappear from browsing, not just
   *  be marked unopenable. Absolute window positions (`ui.galleryWindowStart
   *  + i`) stay unchanged for a hidden slot; only what gets drawn there does,
   *  so every other index arithmetic in this file keeps working unmodified. */
  hidden?: boolean;
}

/** The item a tag is being applied to (tags-001). `archive` is "" for a real
 *  file or folder; otherwise `path` is the path INSIDE that archive. */
export interface TagTarget {
  archive: string;
  path: string;
  kind: "folder" | "image" | "video" | "archive";
  name: string;
}

/** The active surface — mirrors the former `#app[data-state]` switch. */
export type View = "empty" | "playing" | "image" | "live-unavailable" | "gallery" | "storage-gate";

export const ui = $state({
  // --- Top-level view ---
  // android-001: a phone starts on the gate's blank canvas until the first
  // access check answers, so neither Home nor the gate flashes up wrongly.
  view: (features.storageVolumes ? "storage-gate" : "empty") as View,
  features,
  // --- android-001: storage gate + Home's Storage row ---
  storageGateReady: false, // the gate's card shows only once access is known to be off
  storageGateDenied: false, // the user came back from Settings without granting it
  storageGateBusy: false,
  storageLoading: true,
  storageError: "",
  storageCards: [] as StorageCard[],
  cutMode: false,
  dragover: false,
  emptyError: "",
  // Transient "converting…" overlay shown while the ffmpeg sidecar remuxes a
  // transport stream (.ts/.m2ts/.mts) to a playable .mp4 on open (play-016).
  // gallery-004 reuses the same overlay for archive extraction, so the TITLE is
  // state rather than hard-coded markup: the remux says "Preparing video…", an
  // archive page says "Extracting…". The LABEL slot underneath is the filename
  // in both cases — it is what tells the user WHICH file is being worked on.
  prepping: false,
  preppingTitle: "Preparing video…",
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

  // --- Image transform tools (img-001) ---
  // The live transform lives in the controller (it is read and written on every
  // wheel tick and pointer move, which has no business waking the reactive
  // graph); these are the derived values the toolbar renders. `imgZoomLabel` is
  // the readout, `imgCanPan` drives the grab cursor and tells the arrow keys
  // whether to pan or step to the next photo, and the rest are button states.
  imgZoomLabel: "100%",
  imgCanPan: false,
  imgAtFit: true,
  imgRotation: 0,
  imgFlipH: false,
  imgFlipV: false,
  // The chrome auto-hide, mirroring the player's `idle` flag: true fades the
  // header + toolbar out and hides the cursor over the picture.
  imgIdle: false,
  // android-002: the page the phone's paged toolbar is showing, which lights
  // its dot. Always null on desktop, where the bar shows every group at once.
  imgToolPage: null as ImageToolPage | null,

  // --- Image file actions (img-002) ---
  // The info panel: open state plus the rows it shows. Rows are built rather
  // than fixed because most of them are OPTIONAL — a screenshot has no EXIF, and
  // the panel omits those rows rather than printing blanks or zeroes.
  imgInfoOpen: false,
  imgInfoRows: [] as { label: string; value: string }[],
  // img-003: true while the delete button is armed — the first press has landed
  // and a second within DELETE_ARM_MS will move the file to the Recycle Bin.
  // Mirrors the authoritative keyed arm held in controller.ts; this is only what
  // the button renders from.
  imgDeleteArmed: false,
  // Brief confirmation for an action with no visible result of its own; copying
  // changes nothing on screen, so without this there is no way to tell it worked.
  imgActionFlash: "",

  // --- Tags (tags-001) ---
  // The popover is mounted once and driven from here. `tagTarget` is the item
  // being tagged — a photo, a video, a folder, an archive, or a page inside one
  // (which carries the archive's real path in `archive` and an INNER path).
  // `tagTargetTags` is always what Rust last returned, never an optimistic local
  // guess, so the chips cannot drift from the store.
  tagPopoverOpen: false,
  tagTarget: null as TagTarget | null,
  tagTargetTags: [] as string[],
  tagDraft: "",
  tagSuggestions: [] as { name: string; count: number }[],
  tagSuggestIndex: -1,
  tagError: "",

  // --- Tag browsing (tags-002) ---
  // When non-empty, the gallery grid is showing a TAG rather than a folder or an
  // archive — `galleryTag` is the tag's display name. `galleryTagTotal` is the
  // store's own count, which may exceed what is loaded. `galleryTagCapped` is
  // true when the view is showing only the first TAG_VIEW_CAP members, so the
  // header can say so rather than quietly truncating.
  galleryTag: "",
  galleryTagTotal: 0,
  galleryTagCapped: false,
  // The all-tags index overlay (Home's "All tags…").
  tagIndexOpen: false,
  tagIndexQuery: "",
  tagIndexRows: [] as { name: string; count: number }[],
  // tags-003: the index's "Show blacklisted" mode. OFF by default — the whole
  // point of a blacklist is not seeing those tags — but reachable, because a
  // tag you cannot see is a tag you cannot un-blacklist.
  tagIndexShowBlacklisted: false,
  // tags-003: display names of the blacklisted tags, so a row can mark itself.
  tagBlacklist: [] as string[],
  // tags-003: this overlay's own error surface. `galleryError` renders inside
  // Gallery.svelte, which is hidden (`[hidden] { display: none !important }`)
  // whenever the index is opened from Home — its own errors would be set but
  // never seen. See `toggleTagBlacklist`.
  tagIndexError: "",
  // Home's Tags section: the most-used tags, loaded once when Home is shown.
  tagLibrary: [] as { name: string; count: number }[],

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
  // tags-003 live hide: a folder/archive grid's WHOLE listing, blacklist filter
  // not yet applied — `galleryItems` is what that filter leaves of it. Kept so
  // the filter can be re-run when the hidden set changes under an open grid (a
  // blacklisted tag applied to, or removed from, a tile), instead of the grid
  // staying as it was filtered at load until the folder is reopened. Empty in
  // a tag view, whose members live in the controller's own `tagRows` and get
  // marked `hidden` in place rather than dropped. Lives HERE, not as a plain
  // controller array, so both lists hold the same reactive item objects: a
  // `thumbSrc` written through one is seen through the other, and a re-filter
  // never blanks a thumbnail that has already landed.
  galleryListing: [] as GalleryItem[],
  galleryFolder: "",
  galleryLoading: false,
  galleryError: "",
  // tags-002: brief confirmation for a gallery action whose result is otherwise
  // invisible — the zero-missing prune being the case in point. The image viewer
  // has its own (imgActionFlash); a view must not borrow another view's, because
  // nothing here renders that one and the value would linger until some later
  // photo surfaced it out of context.
  galleryFlash: "",
  // tags-002: the prune button's two-step confirmation. 0 = not armed, so a
  // press only counts what's missing and shows the number. N = the count the
  // FIRST press found and is now awaiting a second, confirming press to
  // actually remove; that second press is what applies it. Never persisted
  // across a different tag or a different view — see the resets alongside
  // `galleryTag` in `resetNav`, `openGalleryForTag`, `openGalleryForFolder`,
  // and `openArchiveGallery` — nor left armed indefinitely (pruneMissingFromTag
  // also arms a short timeout, the same way `flashGalleryAction` times out its
  // own message).
  galleryPrunePending: 0,
  // tags-004: the delete-everything-with-this-tag confirmation. `Count` is what
  // the panel displayed and what the command is held to (its expect_count
  // interlock), so it must never be recomputed between showing and confirming.
  // `Archived` and `Folders` are advance warnings of what the sweep will skip
  // (archive members and tagged folders are never touched — recycling one
  // would mean rewriting the archive or making a recursive-delete promise this
  // app does not make anywhere else), counted from the same first-1000-items
  // page as the archive count, so both undercount identically past that cap.
  tagDeleteOpen: false,
  tagDeleteCount: 0,
  tagDeleteArchived: 0,
  tagDeleteFolders: 0,
  tagDeleteBusy: false,
  tagDeleteError: "",
  // tags-004 code review (Finding 1, CRITICAL): the tag NAME this panel is
  // about, captured once by openTagDeletePanel and read by confirmTagDelete
  // instead of confirmTagDelete re-reading `ui.galleryTag` live. Closes the
  // gap where Cancel leaves the panel's controls sitting in the DOM (see
  // `opacity:0` in styles.css) with `tagDeleteCount` still holding its last
  // value: without a captured name, a later confirm reached through that gap
  // would sweep whatever tag the view had since moved to, using a count that
  // was never shown for it.
  tagDeleteTag: "",
  // tags-004 code review (Finding 4): how many files the last sweep actually
  // recycled, so the result heading can say "Done" only when that's true —
  // set alongside `tagDeleteResult`, reset alongside the other counts.
  tagDeleteRecycled: 0,
  // tags-004 fix round 1 (#1): non-empty once a sweep has FINISHED — the
  // panel's outcome message, replacing its confirm/cancel body with the
  // counts and a single Close button until the user dismisses it. Not a
  // flash: `flashGalleryAction`'s message only ever rendered inside
  // Gallery.svelte, which the sweep's own goHome() call hid in the same tick,
  // so it was set and never seen. Cleared by closeTagDeletePanel, whose
  // presence is also what tells that function this dismissal should run
  // goHome() rather than just cancel.
  tagDeleteResult: "",
  // gallery-002: the folder path the grid is currently showing, and the trail of
  // folder names from wherever this gallery journey started down to it — the
  // header's breadcrumb, so a nested sub-gallery says where it sits.
  galleryPath: "",
  galleryCrumbs: [] as string[],
  // gallery-004: when the grid is showing the inside of an archive, the archive's
  // real path and the level within it ("" is its root). Both are "" for a real
  // folder, which is what every other gallery path checks.
  galleryArchive: "",
  galleryInner: "",
  // ux-004: the grid's keyboard cursor. Arrow keys move it, Enter opens it, and
  // it drives a roving tabindex so Tab enters/leaves the grid as ONE stop
  // instead of walking through every tile (a folder of thousands would otherwise
  // be a tab trap). -1 until the grid is first focused. ABSOLUTE — a position in
  // the full list, not in `galleryItems` (tags-002).
  galleryIndex: -1,
  // img-003: the ABSOLUTE index of the tile whose delete is armed, or -1. Absolute
  // for the same reason galleryIndex is — a tag view's window slides underneath it,
  // and an armed position that meant "row n of what is loaded" would drift onto a
  // different file.
  galleryDeleteArmed: -1,
  // tags-002: the absolute index of `galleryItems[0]`. Every other gallery view
  // populates the whole list, so this stays 0 for them; only the tag view's
  // sliding window (Task 12) moves it. Kept here rather than local to that
  // window so the conversion of the grid's cursor/thumbnail sites to absolute
  // indices (Task 11) needed no further change once the window landed.
  galleryWindowStart: 0,

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
  /** img-001: the viewer box the picture is fitted into (the pan/zoom
   *  reference frame), and the wrapper both render tiers sit in — one CSS
   *  transform on the wrapper moves the canvas and the <img> together. */
  imgViewer?: HTMLDivElement;
  imgSurface?: HTMLDivElement;
  /** android-002: the strip the toolbar's groups sit in. On a phone it scrolls
   *  sideways, one group a page; on desktop it has no box of its own. */
  imgToolStrip?: HTMLDivElement;
  tsAddInput?: HTMLInputElement;
  /** The inline timestamp-edit field — mounts only while a row is being edited (play-017). */
  tsEditInput?: HTMLInputElement;
} = {};

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
import type { Timestamp } from "../player-core";

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

/** The active surface — mirrors the former `#app[data-state]` switch. */
export type View = "empty" | "playing" | "image" | "live-unavailable";

export const ui = $state({
  // --- Top-level view ---
  view: "empty" as View,
  cutMode: false,
  dragover: false,
  emptyError: "",

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
  nowChapter: null as { time: string; label: string } | null,
  pinChapter: false,
  panelOpen: false,
  addInputOpen: false,
  shortcutsOpen: false,

  // --- Loop / A-B (play-011) ---
  loopOn: false,
  abA: null as number | null,
  abB: null as number | null,
  abMarkers: [] as AbMarker[],

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

  // --- Livestream · Unavailable (frame 04b) ---
  liveTitle: "Livestream",
  liveMeta: "Livestream",

  // --- Home / recents (ui-001) ---
  recents: [] as RecentFile[],
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
} = {};

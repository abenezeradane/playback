/**
 * player-core.ts
 *
 * Pure, framework-free playback logic. Everything here is deterministic and
 * side-effect free so it can be unit tested without a DOM, a webview, or a real
 * <video> element. The UI layer (main.ts) maps these results onto the actual
 * HTMLMediaElement.
 */

export interface PlayerState {
  /** Whether playback is currently active. */
  isPlaying: boolean;
  /** Current playhead position, in seconds. */
  currentTime: number;
  /** Total media duration, in seconds (0 until metadata is known). */
  duration: number;
  /** Volume in the range 0..1. */
  volume: number;
  /** Whether audio is muted (independent of volume level). */
  muted: boolean;
  /** Playback speed multiplier. */
  rate: number;
}

/** Speeds cycled by the rate button, in order. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** Seconds skipped by the rewind / fast-forward controls. */
export const SKIP_SECONDS = 10;

export function createInitialState(): PlayerState {
  return {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    rate: 1,
  };
}

/** Clamp `value` into the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Format a time in seconds as `m:ss` (or `h:mm:ss` past an hour).
 * Negative or non-finite inputs render as `0:00`.
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) {
    const mm = String(m).padStart(2, "0");
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}

/** Start playback. */
export function play(state: PlayerState): PlayerState {
  return { ...state, isPlaying: true };
}

/** Pause playback. */
export function pause(state: PlayerState): PlayerState {
  return { ...state, isPlaying: false };
}

/** Toggle between playing and paused — the core of pause / resume. */
export function togglePlay(state: PlayerState): PlayerState {
  return { ...state, isPlaying: !state.isPlaying };
}

/**
 * Move the playhead by `delta` seconds, clamped to [0, duration].
 * Positive deltas fast-forward; negative deltas track back.
 */
export function skip(state: PlayerState, delta: number): PlayerState {
  const max = state.duration > 0 ? state.duration : Number.POSITIVE_INFINITY;
  const next = clamp(state.currentTime + delta, 0, max);
  return { ...state, currentTime: next };
}

/** Fast-forward by the default skip interval. */
export function fastForward(state: PlayerState): PlayerState {
  return skip(state, SKIP_SECONDS);
}

/** Track back by the default skip interval. */
export function rewind(state: PlayerState): PlayerState {
  return skip(state, -SKIP_SECONDS);
}

/** Jump directly to an absolute time, clamped to [0, duration]. */
export function seekTo(state: PlayerState, seconds: number): PlayerState {
  const max = state.duration > 0 ? state.duration : Number.POSITIVE_INFINITY;
  return { ...state, currentTime: clamp(seconds, 0, max) };
}

/**
 * Seek to a fractional position (0..1) of the total duration. Used by the
 * scrubber, which reports a normalized value rather than absolute seconds.
 */
export function seekToFraction(state: PlayerState, fraction: number): PlayerState {
  const f = clamp(fraction, 0, 1);
  return seekTo(state, f * state.duration);
}

/**
 * Target time (seconds) for the 0-9 number-key "jump to a tenth" shortcut:
 * `(digit / 10) * duration`, so 0 -> start (0%), 5 -> 50%, 9 -> 90%. Playback is
 * treated as ten equal sections (section n starts at n/10 of the duration) — but
 * purely as a seek convention; nothing is drawn on the timeline. The digit is
 * clamped to 0-9 and a non-finite or non-positive duration yields 0. The caller
 * applies the result through the usual seek path (which clamps to [0, duration]
 * for a file or to the live window for a growing stream).
 */
export function sectionSeekTime(digit: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const section = clamp(Math.floor(digit), 0, 9);
  return (section / 10) * duration;
}

/** Progress as a 0..1 fraction for rendering the scrubber fill. */
export function progressFraction(state: PlayerState): number {
  if (state.duration <= 0) return 0;
  return clamp(state.currentTime / state.duration, 0, 1);
}

/** Buffered amount as a 0..1 fraction for the buffered indicator. */
export function bufferedFraction(bufferedEnd: number, duration: number): number {
  if (duration <= 0) return 0;
  return clamp(bufferedEnd / duration, 0, 1);
}

/** Map a slider integer value to absolute seconds. */
export function sliderToTime(sliderValue: number, sliderMax: number, duration: number): number {
  if (sliderMax <= 0) return 0;
  return clamp(sliderValue / sliderMax, 0, 1) * duration;
}

/** Map absolute seconds to a slider integer value. */
export function timeToSlider(currentTime: number, duration: number, sliderMax: number): number {
  if (duration <= 0) return 0;
  return Math.round(clamp(currentTime / duration, 0, 1) * sliderMax);
}

/** Advance to the next playback speed, wrapping around the list. */
export function nextRate(rate: number): number {
  const idx = PLAYBACK_RATES.indexOf(rate as (typeof PLAYBACK_RATES)[number]);
  const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
  return next;
}

/**
 * Step one speed up (`direction > 0`) or down (`direction < 0`) without
 * wrapping — clamps at the slowest/fastest rate. Used by the +/- hotkeys, where
 * stopping at the ends is less surprising than the rate button's wrap-around.
 */
export function stepRate(rate: number, direction: number): number {
  const idx = PLAYBACK_RATES.indexOf(rate as (typeof PLAYBACK_RATES)[number]);
  const cur = idx >= 0 ? idx : PLAYBACK_RATES.indexOf(1);
  const next = clamp(cur + Math.sign(direction), 0, PLAYBACK_RATES.length - 1);
  return PLAYBACK_RATES[next];
}

/**
 * Set the volume (0..1). Setting volume above zero implicitly unmutes; setting
 * it to zero implicitly mutes — matching the behavior users expect from a slider.
 */
export function setVolume(state: PlayerState, volume: number): PlayerState {
  const v = clamp(volume, 0, 1);
  return { ...state, volume: v, muted: v === 0 };
}

/**
 * Toggle mute. Unmuting while the stored volume is zero restores a sensible
 * audible level so the user isn't left with silent "unmuted" audio.
 */
export function toggleMute(state: PlayerState): PlayerState {
  if (state.muted) {
    const restored = state.volume > 0 ? state.volume : 1;
    return { ...state, muted: false, volume: restored };
  }
  return { ...state, muted: true };
}

/** Effective audible volume after accounting for the mute flag. */
export function effectiveVolume(state: PlayerState): number {
  return state.muted ? 0 : state.volume;
}

// ---------------------------------------------------------------------------
// Timestamps (play-002)
//
// A user pastes a block of `XX:XX:XX TITLE` lines; we parse them into labeled
// points on the timeline ("chapters"). The UI renders a marker per timestamp on
// the scrubber and lets the user jump between them (click, or the A/D hotkeys).
// As with the rest of player-core, everything here is pure and DOM-free.
// ---------------------------------------------------------------------------

/** A user-defined chapter marker: a labeled point in the timeline. */
export interface Timestamp {
  /** Position in seconds from the start. */
  time: number;
  /** Human label shown on the marker and in the list. */
  title: string;
}

/**
 * A small guard, in seconds, so repeated "previous" presses keep stepping
 * backward even when the playhead is sitting essentially on top of a marker.
 */
export const NAV_EPSILON = 0.25;

/**
 * Parse a single timecode token like `HH:MM:SS`, `MM:SS`, or `SS` into seconds.
 * Each `:`-separated field is the next-larger unit, read right to left, so
 * `1:30` -> 90 and `0:01:30` -> 90. Returns null for malformed input.
 */
export function parseTimecode(token: string): number | null {
  const parts = token.split(":");
  if (parts.length === 0 || parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    seconds = seconds * 60 + Number(part);
  }
  return seconds;
}

/**
 * Parse one line of the form `XX:XX:XX TITLE` into a Timestamp. The leading
 * token is the timecode; the remainder (trimmed) is the title. Lines that are
 * blank or whose first token is not a valid timecode yield null. A line with a
 * valid timecode but no title falls back to showing the timecode itself.
 */
export function parseTimestampLine(line: string): Timestamp | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const sep = trimmed.search(/\s/);
  const codeToken = sep === -1 ? trimmed : trimmed.slice(0, sep);
  const time = parseTimecode(codeToken);
  if (time === null) return null;
  const title = sep === -1 ? "" : trimmed.slice(sep + 1).trim();
  return { time, title: title || codeToken };
}

/**
 * Parse a multi-line block of `XX:XX:XX TITLE` lines into a sorted,
 * duplicate-free list of timestamps. Invalid lines are skipped. The result is
 * sorted ascending by time so marker rendering and prev/next navigation are
 * well-defined; entries sharing an exact time collapse to the first seen.
 */
export function parseTimestamps(text: string): Timestamp[] {
  const parsed = text
    .split(/\r?\n/)
    .map(parseTimestampLine)
    .filter((t): t is Timestamp => t !== null)
    .sort((a, b) => a.time - b.time);
  return dedupeByTime(parsed);
}

/** Drop entries sharing a time with the previous one. Input must be sorted. */
function dedupeByTime(sorted: Timestamp[]): Timestamp[] {
  const out: Timestamp[] = [];
  for (const stamp of sorted) {
    if (out.length === 0 || out[out.length - 1].time !== stamp.time) out.push(stamp);
  }
  return out;
}

/**
 * Merge new timestamps into an existing collection: concatenate, sort by time,
 * and drop duplicates. On a tie the existing entry wins (its title is kept), so
 * re-adding a time already present is a no-op rather than an overwrite.
 */
export function mergeTimestamps(existing: Timestamp[], additions: Timestamp[]): Timestamp[] {
  const all = [...existing, ...additions].sort((a, b) => a.time - b.time);
  return dedupeByTime(all);
}

/**
 * Clear every timestamp at once — the bulk counterpart to per-row removal. A
 * pure helper (returns a fresh empty collection rather than mutating in place)
 * so the "Clear all" control can be wired from the UI and unit-tested DOM-free.
 */
export function clearTimestamps(): Timestamp[] {
  return [];
}

/** Marker position as a 0..1 fraction of duration, for placing it on the bar. */
export function markerFraction(time: number, duration: number): number {
  if (duration <= 0) return 0;
  return clamp(time / duration, 0, 1);
}

/**
 * The closest timestamp before `current` (greatest time < current - epsilon),
 * or null if none. The epsilon keeps repeated presses moving backward even when
 * the playhead rests on a marker. Order-independent (does not assume sorting).
 */
export function previousTimestamp(
  stamps: Timestamp[],
  current: number,
  epsilon: number = NAV_EPSILON,
): Timestamp | null {
  let best: Timestamp | null = null;
  for (const s of stamps) {
    if (s.time < current - epsilon && (best === null || s.time > best.time)) best = s;
  }
  return best;
}

/**
 * The closest timestamp after `current` (smallest time > current), or null if
 * none. Order-independent (does not assume sorting).
 */
export function nextTimestamp(stamps: Timestamp[], current: number): Timestamp | null {
  let best: Timestamp | null = null;
  for (const s of stamps) {
    if (s.time > current && (best === null || s.time < best.time)) best = s;
  }
  return best;
}

/**
 * Index of the "active" timestamp — the last one at or before `current` — or -1
 * when the playhead is before the first marker. Used to highlight the current
 * chapter in the list and on the bar.
 */
export function activeTimestampIndex(stamps: Timestamp[], current: number): number {
  let idx = -1;
  for (let i = 0; i < stamps.length; i++) {
    if (stamps[i].time <= current + NAV_EPSILON) idx = i;
    else break;
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Timestamp persistence (play-007)
//
// Timestamps added in a session are saved per video so they reappear the next
// time the same file is opened — surviving a close+reopen and a full app
// restart. The store is a flat map of a stable per-video key -> that video's
// Timestamp[]. These helpers own the keying and (de)serialization so they can
// be unit-tested without localStorage; main.ts persists the serialized string.
// ---------------------------------------------------------------------------

/** A map of per-video key -> the saved timestamps for that video. */
export type TimestampStore = Record<string, Timestamp[]>;

/**
 * Stable identity for a video, used to scope its saved timestamps. Today this is
 * just the absolute file path (or URL); it is factored out as the single place
 * to enrich the key later (e.g. with a size/mtime fingerprint so moved files
 * behave sensibly, or a normalized URL once play-006 lands).
 */
export function timestampKey(source: string): string {
  return source.trim();
}

/** Keep only well-formed Timestamp entries, then sort + de-duplicate by time. */
function sanitizeTimestamps(value: unknown): Timestamp[] {
  if (!Array.isArray(value)) return [];
  const clean: Timestamp[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { time, title } = item as Partial<Timestamp>;
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0) continue;
    if (typeof title !== "string") continue;
    clean.push({ time, title });
  }
  // Reuse the canonical sort + de-dupe so loaded data matches freshly parsed data.
  return mergeTimestamps([], clean);
}

/**
 * Parse the serialized store, dropping anything malformed. Each video's list is
 * sanitized (valid entries only, sorted, de-duplicated) and empty lists are
 * dropped. Returns an empty store for null/garbage input so a corrupt or
 * oversized value can never break loading.
 */
export function parseTimestampStore(json: string | null | undefined): TimestampStore {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const store: TimestampStore = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key) continue;
    const list = sanitizeTimestamps(value);
    if (list.length > 0) store[key] = list;
  }
  return store;
}

/** Serialize the store for persistence. */
export function serializeTimestampStore(store: TimestampStore): string {
  return JSON.stringify(store);
}

/** The saved timestamps for `key`, or an empty list when none are stored. */
export function readStoredTimestamps(store: TimestampStore, key: string): Timestamp[] {
  const list = store[key];
  return Array.isArray(list) ? list : [];
}

/**
 * Return a new store with `key` set to `stamps` (sorted + de-duplicated). An
 * empty list removes the key entirely rather than persisting an empty array, so
 * a video whose timestamps were all cleared doesn't linger in storage. The input
 * store is not mutated, so each video's set stays independent.
 */
export function writeStoredTimestamps(
  store: TimestampStore,
  key: string,
  stamps: Timestamp[],
): TimestampStore {
  const next: TimestampStore = { ...store };
  const clean = mergeTimestamps([], stamps);
  if (clean.length === 0) delete next[key];
  else next[key] = clean;
  return next;
}

// ---------------------------------------------------------------------------
// Frame-accurate timeline / cut view (play-004)
//
// An editorial "review" surface layered on the normal player: a SMPTE timecode,
// a timeline deck (ruler + filmstrip + waveform + playhead), J/K/L shuttle
// transport, and jump-to-start/end + loop. Everything that decides a number — a
// frame index, a SMPTE string, the shuttle rate ladder, the ruler tick layout —
// lives here so it is pure and unit-testable; main.ts maps it onto the DOM and
// the real <video> (whose playbackRate can't go negative, so reverse shuttle is
// a timer-driven currentTime stepper there).
// ---------------------------------------------------------------------------

/** Frame rate assumed when a clip's real fps can't be measured from metadata. */
export const DEFAULT_FPS = 30;

/** Broadcast-standard frame rates we snap a measured fps onto. */
export const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60] as const;

/**
 * Snap a noisy measured fps (e.g. from requestVideoFrameCallback) onto the
 * closest broadcast-standard rate when it is within tolerance, else round to the
 * nearest whole frame rate. A non-finite or non-positive input falls back to the
 * default. Keeps "29.97-ish" readings from rendering as 29.9704523.
 */
export function snapFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return DEFAULT_FPS;
  let best: number = STANDARD_FPS[0];
  let bestDelta = Infinity;
  for (const f of STANDARD_FPS) {
    const d = Math.abs(f - fps);
    if (d < bestDelta) {
      bestDelta = d;
      best = f;
    }
  }
  return bestDelta <= 0.6 ? best : Math.round(fps);
}

/**
 * The integer SMPTE timebase for a frame rate: fractional rates use their
 * nearest whole-number count of frames per second (29.97 -> 30, 23.976 -> 24),
 * which is how non-drop-frame SMPTE counts. Always at least 1.
 */
function timebase(fps: number): number {
  const f = !Number.isFinite(fps) || fps <= 0 ? DEFAULT_FPS : fps;
  return Math.max(1, Math.round(f));
}

/** Frame index at `time` seconds for a clip at `fps` (floored; never negative). */
export function timeToFrame(time: number, fps: number): number {
  if (!Number.isFinite(time) || time < 0) return 0;
  // A tiny epsilon absorbs float error so e.g. exactly 1s at 30fps is frame 30.
  return Math.floor(time * timebase(fps) + 1e-6);
}

/** Start time (seconds) of frame index `frame` at `fps` (never negative). */
export function frameToTime(frame: number, fps: number): number {
  const fr = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
  return fr / timebase(fps);
}

/**
 * Format `time` seconds as a frame-accurate non-drop-frame SMPTE timecode
 * `HH:MM:SS:FF` at `fps`. Negative/non-finite times render as `00:00:00:00`.
 */
export function formatSmpte(time: number, fps: number): string {
  const tb = timebase(fps);
  const totalFrames = timeToFrame(time, fps);
  const ff = totalFrames % tb;
  const totalSeconds = Math.floor(totalFrames / tb);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}:${p2(ff)}`;
}

/** Human fps label like "30 fps" or "23.976 fps" (snapped, trailing zeros trimmed). */
export function formatFps(fps: number): string {
  const f = snapFps(fps);
  const rounded = Math.round(f * 1000) / 1000;
  const text = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${text} fps`;
}

/**
 * Time (seconds) of the clip's last whole frame — where jump-to-end lands the
 * playhead so it sits on the final frame rather than past the end. Clamped into
 * the clip. A non-positive/non-finite duration yields 0.
 */
export function lastFrameTime(duration: number, fps: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const tb = timebase(fps);
  const totalFrames = Math.max(0, Math.floor(duration * tb + 1e-6));
  const lastIndex = Math.max(0, totalFrames - 1);
  return Math.min(duration, lastIndex / tb);
}

/** Absolute time (seconds) for a 0..1 timeline fraction — the ruler/filmstrip/
 * waveform/playhead all share this mapping (and scrubbing inverts it). */
export function fractionToTime(fraction: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return clamp(fraction, 0, 1) * duration;
}

// --- J/K/L shuttle transport ---------------------------------------------
// K stops; L plays forward and steps the forward speed up on each repeat; J
// plays in reverse and steps the reverse speed up on each repeat. The shuttle is
// a (direction, speedIndex) pair; the signed playback rate is derived from it.

/** Shuttle speed magnitudes stepped through by repeated J / L presses. */
export const SHUTTLE_SPEEDS = [1, 2, 4, 8, 16] as const;

export interface Shuttle {
  /** -1 reverse, 0 stopped, 1 forward. */
  direction: -1 | 0 | 1;
  /** Index into SHUTTLE_SPEEDS (only meaningful while direction !== 0). */
  speedIndex: number;
}

/** A stopped shuttle (the initial state, and what K returns). */
export function createShuttle(): Shuttle {
  return { direction: 0, speedIndex: 0 };
}

/** K — stop the shuttle. */
export function shuttleStop(): Shuttle {
  return createShuttle();
}

/**
 * L — play forward. Already forward: step the speed up one rung (clamped at the
 * fastest). From stopped or reverse: (re)start forward at the slowest speed.
 */
export function shuttleForward(s: Shuttle): Shuttle {
  if (s.direction === 1) {
    return { direction: 1, speedIndex: Math.min(s.speedIndex + 1, SHUTTLE_SPEEDS.length - 1) };
  }
  return { direction: 1, speedIndex: 0 };
}

/**
 * J — play in reverse. Already reverse: step the reverse speed up one rung
 * (clamped at the fastest). From stopped or forward: (re)start reverse slowest.
 */
export function shuttleReverse(s: Shuttle): Shuttle {
  if (s.direction === -1) {
    return { direction: -1, speedIndex: Math.min(s.speedIndex + 1, SHUTTLE_SPEEDS.length - 1) };
  }
  return { direction: -1, speedIndex: 0 };
}

/** Signed playback rate from the shuttle: 0 when stopped, else ±speed. */
export function shuttleRate(s: Shuttle): number {
  if (s.direction === 0) return 0;
  const idx = clamp(s.speedIndex, 0, SHUTTLE_SPEEDS.length - 1);
  return s.direction * SHUTTLE_SPEEDS[idx];
}

// --- Timeline ruler -------------------------------------------------------

/** A tick on the timeline ruler; major ticks carry a time label. */
export interface RulerTick {
  /** Position in seconds from the start. */
  time: number;
  /** Whether this is a labelled major tick (vs. an unlabelled minor tick). */
  major: boolean;
}

/** "Nice" round seconds-per-major-tick steps for the ruler. */
const NICE_RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/**
 * Pick a round interval (seconds) for the ruler's major ticks so that roughly
 * `approxCount` of them span the clip. Returns the smallest NICE step at or above
 * the raw spacing, capped at the largest step.
 */
export function niceTickInterval(duration: number, approxCount: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 1;
  const raw = duration / Math.max(1, approxCount);
  for (const step of NICE_RULER_STEPS) {
    if (step >= raw) return step;
  }
  return NICE_RULER_STEPS[NICE_RULER_STEPS.length - 1];
}

/**
 * Lay out the timeline ruler: minor ticks every (major / 5) seconds with every
 * fifth one flagged `major` (labelled). Spans [0, duration]. Returns [] for a
 * non-positive duration.
 */
export function rulerTicks(duration: number, approxMajorCount = 8): RulerTick[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const major = niceTickInterval(duration, approxMajorCount);
  const minor = major / 5;
  const count = Math.floor(duration / minor + 1e-6);
  const ticks: RulerTick[] = [];
  for (let i = 0; i <= count; i++) {
    ticks.push({ time: i * minor, major: i % 5 === 0 });
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// Focus / keyboard targeting
// ---------------------------------------------------------------------------

/** The bits of a focused element needed to classify it (DOM-free for testing). */
export interface FocusTarget {
  /** element.tagName (case-insensitive). */
  tagName: string;
  /** input.type for an <input>; ignored for other tags. */
  type?: string;
  /** element.isContentEditable. */
  isContentEditable?: boolean;
}

/**
 * <input> types that accept free text and so should swallow keyboard shortcuts
 * while focused. Everything NOT in this set — range, checkbox, radio, button,
 * etc. — must keep player hotkeys live even when it holds focus.
 */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
  "", // no type attribute reflects as "text" in the DOM, but guard the raw "" too
]);

/**
 * Whether a focused element is a text-entry field that should capture typing
 * (and therefore suppress player hotkeys). True for <textarea>, a
 * contentEditable host, and <input> of a text-like type — but deliberately
 * FALSE for range sliders (the scrubber / volume), checkboxes, and buttons, so
 * that clicking one of those and leaving it focused does not silently disable
 * every keyboard shortcut. Pure (no DOM) so it can be unit tested.
 */
export function isTextEntryTarget(target: FocusTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return TEXT_INPUT_TYPES.has((target.type ?? "").toLowerCase());
  return false;
}

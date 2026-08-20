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

/**
 * Replace the timestamp at `index` with `edited` (play-017) — the in-place
 * counterpart to delete-then-re-add. The edit can change the time and/or the
 * title; the collection is re-sorted so marker order and prev/next navigation
 * stay well-defined. If the new time lands on a DIFFERENT existing entry's time
 * the explicit edit wins (that other entry is dropped), keeping the "one marker
 * per time" invariant. Out-of-range indices return the input unchanged. Pure:
 * the input array is never mutated; a fresh sorted array is returned.
 */
export function editTimestamp(
  stamps: Timestamp[],
  index: number,
  edited: Timestamp,
): Timestamp[] {
  if (index < 0 || index >= stamps.length) return stamps;
  const others = stamps.filter((_, i) => i !== index);
  const merged = [...others.filter((s) => s.time !== edited.time), edited].sort(
    (a, b) => a.time - b.time,
  );
  return dedupeByTime(merged);
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

// --- A-B section loop (play-011) ------------------------------------------
// Whole-clip looping is the native `video.loop` property. The optional A-B
// section loop repeats only the range [A, B]: when the playhead reaches B it
// seeks back to A. Both decisions are pure so they can be unit-tested and the
// runtime stays a thin driver around `abLoopNext`.

/**
 * An A-B loop is engaged only when both points are set and ordered (A strictly
 * before B). A null point — or B at/behind A (a zero-or-negative span) — means
 * no section loop, so playback falls back to the whole-clip loop / normal end.
 */
export function abLoopActive(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && b > a;
}

/**
 * Decide where an A-B loop should seek back to, or null to keep playing. Once the
 * playhead reaches/passes B the loop jumps back to A; before B (or with no active
 * region) it returns null. Forward-only: tracking back below A is left alone.
 */
export function abLoopNext(
  currentTime: number,
  a: number | null,
  b: number | null,
): number | null {
  if (!abLoopActive(a, b)) return null;
  return currentTime >= (b as number) ? (a as number) : null;
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

// ---------------------------------------------------------------------------
// Animated-image frame timing (play-012)
//
// GIF / animated-WebP / APNG are image formats: the HTML5 <video> engine cannot
// decode them, so they are frame-decoded (WebCodecs ImageDecoder) and driven by
// a canvas clock. An animation is modelled as an ordered list of per-frame
// shown-durations (seconds). All the timing math — total run time, which frame
// is visible at an elapsed clock time, folding the clock back over a loop, the
// start time of a frame, and stepping frames — lives here so the runtime stays a
// thin canvas driver and every decision is unit-testable without a DOM.
// ---------------------------------------------------------------------------

/** Fallback shown-duration (seconds) for a frame that reports a zero / invalid
 *  delay — matches the long-standing browser default for 0-delay GIF frames. */
export const DEFAULT_FRAME_DURATION = 0.1;

/**
 * Sanitize raw per-frame durations (seconds): a non-finite or non-positive delay
 * becomes `fallback` (the classic 100ms GIF default), so a malformed file still
 * animates at a sane rate instead of freezing on a zero-length frame or spinning
 * the clock. Returns [] for an empty list.
 */
export function normalizeFrameDurations(
  raw: number[],
  fallback: number = DEFAULT_FRAME_DURATION,
): number[] {
  return raw.map((d) => (Number.isFinite(d) && d > 0 ? d : fallback));
}

/** Total time for one pass through the animation (sum of the frame durations). */
export function animationDuration(durations: number[]): number {
  let total = 0;
  for (const d of durations) if (Number.isFinite(d) && d > 0) total += d;
  return total;
}

/**
 * Fold an ever-growing play clock back into a single animation pass [0, total).
 * A GIF loops forever, so the canvas clock can grow unbounded and this wraps it.
 * Returns 0 for a non-positive total or a non-positive time.
 */
export function loopedTime(time: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(time) || time <= 0) return 0;
  return time % total;
}

/**
 * Which frame index is visible at elapsed `time` within ONE pass — NOT looping,
 * so compose with `loopedTime` first for a looping clock. Clamped: a time at or
 * after the end shows the last frame, a time at or before 0 shows the first.
 * Returns 0 for an empty animation.
 */
export function frameIndexAtTime(durations: number[], time: number): number {
  if (durations.length === 0) return 0;
  if (!Number.isFinite(time) || time <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < durations.length; i++) {
    acc += Math.max(0, durations[i] || 0);
    if (time < acc) return i;
  }
  return durations.length - 1;
}

/** Start time (seconds, from the animation's beginning) of frame `index`,
 *  clamped to the valid range. Returns 0 for an empty animation. */
export function frameStartTime(durations: number[], index: number): number {
  const n = durations.length;
  if (n === 0) return 0;
  const i = Math.max(0, Math.min(Math.trunc(index), n - 1));
  let acc = 0;
  for (let k = 0; k < i; k++) acc += Math.max(0, durations[k] || 0);
  return acc;
}

/**
 * Step a frame index by `delta`, wrapping around both ends — a looping animation
 * has no hard first/last frame when stepping (stepping back from frame 0 lands on
 * the last frame, and forward off the end returns to 0). Returns 0 for a
 * non-positive frame count.
 */
export function stepFrame(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

// ---------------------------------------------------------------------------
// Filesystem allow-list (sec-002 — scope reads to the opened media directory)
// ---------------------------------------------------------------------------
//
// The native shell (src-tauri/src/lib.rs) is the real security boundary: it
// canonicalizes every caller-supplied path with std::fs::canonicalize (which
// resolves symlinks AND `..` against the real filesystem) before checking it
// against an allow-list of roots held in tauri::State, and tightens the asset
// protocol scope to the opened file's directory. This is the pure, DOM/FS-free
// mirror of that containment decision so it can be unit-tested headlessly.

/**
 * Lexically normalize an absolute path into a comparable shape:
 *   - `\` and `/` are both treated as separators,
 *   - `.` segments are dropped and `..` segments pop the previous one,
 *   - a leading Windows drive letter is lower-cased (Windows paths are
 *     case-insensitive on the drive, and canonicalize normalizes its case),
 * Returns null for a non-string, empty, or non-absolute path (deny-by-default).
 */
function normalizeAbsPath(p: unknown): { drive: string; segs: string[] } | null {
  if (typeof p !== "string") return null;
  const trimmed = p.trim();
  if (trimmed === "") return null;
  let s = trimmed.replace(/\\/g, "/");
  let drive = "";
  const win = /^([A-Za-z]):\//.exec(s);
  if (win) {
    drive = win[1].toLowerCase();
    s = s.slice(win[0].length - 1); // keep the leading "/"
  } else if (!s.startsWith("/")) {
    return null; // not absolute — never trusted
  }
  const segs: string[] = [];
  for (const part of s.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      segs.pop(); // climb up; popping past the root just stays at the root
      continue;
    }
    segs.push(part);
  }
  return { drive, segs };
}

/**
 * Decide whether `candidate` resolves inside one of the allowed `roots` — the
 * pure core of the sec-002 filesystem allow-list. Inputs are absolute paths;
 * `..`/`.` segments are folded out lexically so a traversal that escapes a root
 * is rejected, and a symlink-escape is rejected once its target (the resolved
 * path the Rust canonicalize step produces) is passed in. The comparison is on
 * whole path segments, so a sibling that merely shares a name prefix
 * (".../videos-secret" vs an allowed ".../videos") is NOT treated as inside.
 *
 * Deny-by-default: an empty root list, or a non-absolute / empty candidate,
 * returns false.
 */
export function isPathWithinRoots(roots: string[], candidate: string): boolean {
  const cand = normalizeAbsPath(candidate);
  if (!cand) return false;
  for (const rootStr of roots) {
    const root = normalizeAbsPath(rootStr);
    if (!root) continue;
    if (root.drive !== cand.drive) continue;
    if (cand.segs.length < root.segs.length) continue;
    let within = true;
    for (let i = 0; i < root.segs.length; i++) {
      if (root.segs[i] !== cand.segs[i]) {
        within = false;
        break;
      }
    }
    if (within) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Transport-stream classification (play-016)
// ---------------------------------------------------------------------------
/**
 * MPEG-2 Transport Stream container extensions. Chromium's <video> can decode the
 * H.264/AAC elementary streams inside these but cannot demux the TS container, so
 * the app remuxes them to a temporary .mp4 (via the ffmpeg sidecar) before playing.
 * `.ts` is the plain transport stream; `.m2ts`/`.mts` are the AVCHD/Blu-ray variant.
 */
export const TRANSPORT_STREAM_EXTENSIONS = ["ts", "m2ts", "mts"] as const;

/** Lowercased file extension (without the dot), or "" when there is none. */
export function fileExtension(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : "";
}

/**
 * True when `path` is an MPEG-TS container that needs remuxing before it can play
 * in the WebView. Pure string check on the extension.
 */
export function isTransportStreamPath(path: string): boolean {
  return (TRANSPORT_STREAM_EXTENSIONS as readonly string[]).includes(
    fileExtension(path),
  );
}

// ---------------------------------------------------------------------------
// Folder queue / playlist (play-013)
//
// When a video is opened the app treats the other videos in the same folder as a
// queue and auto-advances through them. The native shell enumerates the folder
// (list_folder_videos); everything that DECIDES an order or an index lives here so
// it is pure and unit-testable: the natural sort that orders the queue, finding
// the current item, and the next/previous index math (clamp at the ends, or wrap
// when "repeat all" is on). play-014 (user-created playlists) reuses this same
// index math, so it is the shared queue engine.
// ---------------------------------------------------------------------------

/**
 * Compare two strings with numeric-aware "natural" ordering, so e.g.
 * `clip2.mp4` sorts before `clip10.mp4` (a plain lexical sort puts "10" before
 * "2" because it compares "1" < "2"). Runs of digits are compared by numeric
 * value; other characters are compared case-insensitively. A case-insensitive tie
 * falls back to a case-sensitive comparison so the order is total and stable
 * (deterministic regardless of the input order). Pure.
 */
export function compareNatural(a: string, b: string): number {
  const ai = a.toLowerCase();
  const bi = b.toLowerCase();
  let i = 0;
  let j = 0;
  while (i < ai.length && j < bi.length) {
    const ca = ai[i];
    const cb = bi[j];
    const da = ca >= "0" && ca <= "9";
    const db = cb >= "0" && cb <= "9";
    if (da && db) {
      // Compare two digit runs by numeric value, ignoring leading zeros.
      let si = i;
      let sj = j;
      while (si < ai.length && ai[si] >= "0" && ai[si] <= "9") si++;
      while (sj < bi.length && bi[sj] >= "0" && bi[sj] <= "9") sj++;
      let na = ai.slice(i, si).replace(/^0+(?=\d)/, "");
      let nb = bi.slice(j, sj).replace(/^0+(?=\d)/, "");
      if (na.length !== nb.length) return na.length - nb.length;
      if (na !== nb) return na < nb ? -1 : 1;
      i = si;
      j = sj;
    } else {
      if (ca !== cb) return ca < cb ? -1 : 1;
      i++;
      j++;
    }
  }
  if (i < ai.length) return 1;
  if (j < bi.length) return -1;
  // Case-insensitively equal — break the tie with the raw strings so the sort is
  // total (e.g. "A.mp4" vs "a.mp4" always order the same way).
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Sort file paths into natural order (a fresh array; the input is not mutated). */
export function sortPathsNatural(paths: string[]): string[] {
  return [...paths].sort(compareNatural);
}

/** One node in the Gallery grid (gallery-002): a sub-folder to descend into, or an
 *  image to open. `kind` is what a tile's click, icon, and thumbnail all branch on.
 *
 *  gallery-003 adds `video` — a tile that opens in the player rather than the photo
 *  viewer, and that carries a play badge and a duration.
 *
 *  gallery-004 adds `archive` — a `.zip`/`.cbz`/`.rar`/`.cbr` tile that browses as
 *  a directory, so it sorts with the folders rather than with the media. */
export interface GalleryNode {
  path: string;
  name: string;
  kind: "folder" | "image" | "video" | "archive";
}

/** Trailing path segment of `path`, for either separator. */
function pathLeaf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/**
 * Order a gallery folder's contents for display (gallery-002): sub-folders first
 * as a block, then the media, each block independently natural-sorted.
 * Folders-first is the convention every file browser uses — it keeps the way
 * *deeper* from being scattered through a long run of pictures.
 *
 * gallery-003: images and videos share ONE media block rather than getting a block
 * each. A camera roll interleaves the two by name (IMG_001.jpg, IMG_002.mp4), and
 * sorting by kind first would tear that sequence apart.
 *
 * gallery-004: archives join the FOLDERS block and natural-sort together with
 * real folders, rather than forming a block of their own. An archive is a
 * directory to a reader, so `book.cbz` belongs exactly where a folder named
 * `book` would be — a reader scanning for it looks there.
 *
 * Pure; no input array is mutated. `videos` and `archives` are optional so the
 * older call shapes still mean "none of those".
 */
export function orderGalleryEntries(
  folders: string[],
  images: string[],
  videos: string[] = [],
  archives: string[] = [],
): GalleryNode[] {
  const nodes = (paths: string[], kind: GalleryNode["kind"]): GalleryNode[] =>
    paths.map((path) => ({ path, name: pathLeaf(path), kind }));
  const sorted = (list: GalleryNode[]): GalleryNode[] =>
    [...list].sort((a, b) => compareNatural(a.path, b.path));
  return [
    ...sorted([...nodes(folders, "folder"), ...nodes(archives, "archive")]),
    ...sorted([...nodes(images, "image"), ...nodes(videos, "video")]),
  ];
}

/**
 * The Gallery header's one-line summary of what a folder holds — "2 folders ·
 * 1 archive · 12 photos · 3 videos" — omitting whichever kinds are absent, so a plain photo
 * folder still reads exactly as it did before gallery-002/003/004 added the others.
 *
 * An entirely empty folder falls back to "0 photos" rather than an empty string,
 * so the header never renders as a bare separator. Pure.
 */
export function galleryMeta(
  folders: number,
  photos: number,
  videos: number,
  archives = 0,
): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (folders > 0) parts.push(plural(folders, "folder"));
  if (archives > 0) parts.push(plural(archives, "archive"));
  if (photos > 0) parts.push(plural(photos, "photo"));
  if (videos > 0) parts.push(plural(videos, "video"));
  return parts.length > 0 ? parts.join(" · ") : "0 photos";
}

/** Index of `path` in `queue` (exact match), or -1 when it is not present. */
export function currentIndexOf(queue: string[], path: string): number {
  return queue.indexOf(path);
}

/**
 * Index of the next item to play after `current`, or -1 when there is none. Past
 * the last item the queue wraps to the first when `repeatAll` is on, otherwise it
 * returns -1 (stop / no-op). A `current` of -1 (nothing selected) advances to the
 * first item. Returns -1 for an empty queue. Pure.
 */
export function nextIndex(current: number, length: number, repeatAll: boolean): number {
  if (length <= 0) return -1;
  if (current + 1 < length) return current + 1;
  return repeatAll ? 0 : -1;
}

/**
 * Index of the previous item before `current`, or -1 when there is none. Before
 * the first item the queue wraps to the last when `repeatAll` is on, otherwise it
 * returns -1 (no-op). Returns -1 for an empty queue. Pure.
 */
export function prevIndex(current: number, length: number, repeatAll: boolean): number {
  if (length <= 0) return -1;
  if (current - 1 >= 0) return current - 1;
  return repeatAll ? length - 1 : -1;
}

// ---------------------------------------------------------------------------
// User-created playlists (play-014)
//
// The user-curated counterpart to play-013's auto folder-queue: the SAME playback
// engine (the ordered list + current index + auto-advance + next/prev + "repeat
// all" above), but the list is hand-built and PERSISTED rather than derived from a
// folder. A playlist is { id, name, ordered video paths }; the whole collection is
// stored as a flat array. These helpers own creation, the per-playlist edits
// (rename, add/remove/reorder items), and the (de)serialization — all pure and
// DOM/storage-free so they can be unit-tested headlessly, exactly like the play-007
// timestamp store. The controller persists the serialized string to localStorage
// (key `playback:playlists`) and seeds the play-013 queue from a playlist's items.
// ---------------------------------------------------------------------------

/** A named, ordered list of video file paths the user curates and saves. */
export interface Playlist {
  /** Stable unique id (generated once on creation; the storage/lookup key). */
  id: string;
  /** Human label shown on the home card and the editor. */
  name: string;
  /** Ordered video file paths; de-duplicated, played in this order. */
  items: string[];
}

/** The whole saved collection — a flat, ordered array of playlists. */
export type PlaylistStore = Playlist[];

/** Upper bound on a playlist name length (defensive against pasted garbage). */
export const MAX_PLAYLIST_NAME = 80;

/**
 * Normalize a playlist name: collapse whitespace, trim, cap the length, and fall
 * back to a sensible default for an empty/blank value so a playlist is never
 * nameless. Pure.
 */
export function sanitizePlaylistName(name: unknown): string {
  const text = typeof name === "string" ? name : "";
  const trimmed = text.replace(/\s+/g, " ").trim().slice(0, MAX_PLAYLIST_NAME);
  return trimmed || "Untitled playlist";
}

/** Keep only non-empty string paths, de-duplicated, preserving first-seen order. */
function sanitizePlaylistItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** Coerce an unknown value into a well-formed Playlist, or null if unusable. */
function sanitizePlaylist(value: unknown): Playlist | null {
  if (!value || typeof value !== "object") return null;
  const { id, name, items } = value as Partial<Playlist>;
  if (typeof id !== "string" || id.trim() === "") return null;
  return { id, name: sanitizePlaylistName(name), items: sanitizePlaylistItems(items) };
}

/**
 * Parse the serialized playlist store, dropping anything malformed: non-array
 * input, entries without a string id, duplicate ids, and per-playlist garbage
 * items are all discarded. Returns an empty store for null/corrupt JSON so a bad
 * stored value can never break loading. Mirrors `parseTimestampStore` (play-007).
 */
export function parsePlaylistStore(json: string | null | undefined): PlaylistStore {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: PlaylistStore = [];
  const seenIds = new Set<string>();
  for (const value of raw) {
    const pl = sanitizePlaylist(value);
    if (!pl || seenIds.has(pl.id)) continue;
    seenIds.add(pl.id);
    out.push(pl);
  }
  return out;
}

/** Serialize the store for persistence. */
export function serializePlaylistStore(store: PlaylistStore): string {
  return JSON.stringify(store);
}

/** A fresh, empty playlist with the given id and (sanitized) name. Pure: the
 *  caller supplies the id so id generation stays out of the testable core. */
export function createPlaylist(name: string, id: string): Playlist {
  return { id, name: sanitizePlaylistName(name), items: [] };
}

/** Append a playlist to the store (returns a new array; input not mutated). */
export function addPlaylist(store: PlaylistStore, playlist: Playlist): PlaylistStore {
  return [...store, playlist];
}

/** Remove the playlist with `id` entirely. */
export function removePlaylist(store: PlaylistStore, id: string): PlaylistStore {
  return store.filter((p) => p.id !== id);
}

/** Rename the playlist with `id` (name re-sanitized); others untouched. */
export function renamePlaylist(store: PlaylistStore, id: string, name: string): PlaylistStore {
  return store.map((p) => (p.id === id ? { ...p, name: sanitizePlaylistName(name) } : p));
}

/**
 * Append `paths` to the playlist with `id`, in order, skipping blanks and any
 * path already present (a playlist is a de-duplicated ordered set). Returns a new
 * store; the input is not mutated.
 */
export function addPlaylistItems(
  store: PlaylistStore,
  id: string,
  paths: string[],
): PlaylistStore {
  return store.map((p) => {
    if (p.id !== id) return p;
    const seen = new Set(p.items);
    const items = [...p.items];
    for (const raw of paths) {
      if (typeof raw !== "string") continue;
      const path = raw.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      items.push(path);
    }
    return items.length === p.items.length ? p : { ...p, items };
  });
}

/** Remove the item at `index` from the playlist with `id`. Out-of-range is a no-op. */
export function removePlaylistItem(
  store: PlaylistStore,
  id: string,
  index: number,
): PlaylistStore {
  return store.map((p) =>
    p.id === id ? { ...p, items: p.items.filter((_, i) => i !== index) } : p,
  );
}

/**
 * Move the item at `index` by `delta` positions within the playlist with `id`
 * (delta -1 = up, +1 = down). A move that would leave the list bounds is a no-op,
 * so the up/down controls clamp at the ends. Returns a new store; not mutated.
 */
export function movePlaylistItem(
  store: PlaylistStore,
  id: string,
  index: number,
  delta: number,
): PlaylistStore {
  return store.map((p) => {
    if (p.id !== id) return p;
    const to = index + delta;
    if (index < 0 || index >= p.items.length || to < 0 || to >= p.items.length) return p;
    const items = [...p.items];
    const [moved] = items.splice(index, 1);
    items.splice(to, 0, moved);
    return { ...p, items };
  });
}

/** The playlist with `id`, or undefined when none matches. */
export function findPlaylist(store: PlaylistStore, id: string): Playlist | undefined {
  return store.find((p) => p.id === id);
}

// ===========================================================================
// Native (libmpv) engine — pure event/seek logic (native-001)
// ===========================================================================
// The native engine adapter (src/lib/engine-native.ts) is a thin shell around
// these pure functions so the decision logic — stale-event dropping, the
// ended latch, seek coalescing — is unit-tested here. The event payloads
// mirror docs/native-engine-ipc.md exactly.

/** The adapter's authoritative playback snapshot (element-parity semantics). */
export interface EngineSnapshot {
  /** The current load's sequence number; -1 = nothing loaded / load awaiting. */
  loadSeq: number;
  /** True once the current load's `loaded` event arrived. */
  loaded: boolean;
  paused: boolean;
  /** The element-parity `ended` latch: set once per file end, cleared by
   *  seek-away / play() / a new load — so `onEnded` fires exactly once. */
  ended: boolean;
  currentTime: number;
  /** 0 until known (mirrors syncFromVideo's finite-or-zero read). */
  duration: number;
  width: number;
  height: number;
  containerFps: number | null;
  /** True while a player_seek is unsettled (time events are dropped so the
   *  scrubber can't rubber-band back to a stale position). */
  seekInFlight: boolean;
}

export function createEngineSnapshot(): EngineSnapshot {
  return {
    loadSeq: -1,
    loaded: false,
    paused: true,
    ended: false,
    currentTime: 0,
    duration: 0,
    width: 0,
    height: 0,
    containerFps: null,
    seekInFlight: false,
  };
}

/** The tagged player-event union emitted by the Rust engine (see the IPC doc). */
export type NativePlayerEvent =
  | { kind: "loaded"; loadSeq: number; duration: number; width: number; height: number; containerFps: number | null }
  | { kind: "duration"; loadSeq: number; duration: number }
  | { kind: "time"; loadSeq: number; position: number }
  | { kind: "pause"; loadSeq: number; paused: boolean }
  | { kind: "eof"; loadSeq: number }
  | { kind: "playbackRestart"; loadSeq: number }
  | { kind: "endFile"; loadSeq: number; reason: string; message?: string }
  | { kind: "shutdown" };

/** What the adapter should DO after applying an event (element-event parity). */
export type EngineEffect =
  | "loadedmetadata"
  | "timeupdate"
  | "play"
  | "pause"
  | "ended"
  | "seekSettled"
  | "error"
  | "shutdown";

export interface AppliedPlayerEvent {
  snapshot: EngineSnapshot;
  effects: EngineEffect[];
  /** Set with the "error" effect (endFile reason=error). */
  errorMessage?: string;
}

/** Slack (seconds) when deciding a position is "before the end" — clears the
 *  ended latch on seek-away without a frame-exact comparison. */
const ENDED_CLEAR_EPSILON = 0.25;

/**
 * Apply one engine event to the snapshot, returning the new snapshot and the
 * element-parity effects to fire. STALE-EVENT GUARD: any event carrying a
 * loadSeq that does not match the snapshot's is dropped (events from a
 * replaced file racing a new load — Next-spam, single-instance open-file);
 * while a load is awaiting (loadSeq -1) everything is dropped. `shutdown`
 * carries no seq and always applies.
 */
export function applyPlayerEvent(
  snap: EngineSnapshot,
  ev: NativePlayerEvent,
): AppliedPlayerEvent {
  if (ev.kind === "shutdown") {
    return { snapshot: { ...createEngineSnapshot() }, effects: ["shutdown"] };
  }
  if (snap.loadSeq < 0 || ev.loadSeq !== snap.loadSeq) {
    return { snapshot: snap, effects: [] };
  }
  switch (ev.kind) {
    case "loaded":
      return {
        snapshot: {
          ...snap,
          loaded: true,
          ended: false,
          paused: false,
          currentTime: 0,
          duration: Number.isFinite(ev.duration) && ev.duration > 0 ? ev.duration : 0,
          width: ev.width,
          height: ev.height,
          containerFps: ev.containerFps,
        },
        effects: ["loadedmetadata"],
      };
    case "duration": {
      if (!(Number.isFinite(ev.duration) && ev.duration > 0)) {
        return { snapshot: snap, effects: [] };
      }
      // A late/refined duration (zero-duration fragmented MP4) re-runs the
      // idempotent loadedmetadata path (recent-duration, ruler, cut meta).
      // NEVER let it shrink: mpv's estimate for such files GROWS as fragments
      // demux and can undercut the mfra probe's value — a lower bound of the
      // real duration — which would re-clamp seeks (observed in the smoke).
      const duration = Math.max(snap.duration, ev.duration);
      if (duration === snap.duration) return { snapshot: snap, effects: [] };
      return {
        snapshot: { ...snap, duration },
        effects: snap.loaded ? ["loadedmetadata"] : [],
      };
    }
    case "time": {
      // Ignore until loaded (stray events from the replaced file can carry the
      // new seq for a beat) and while a seek is unsettled (no rubber-banding).
      if (!snap.loaded || snap.seekInFlight) return { snapshot: snap, effects: [] };
      const awayFromEnd =
        snap.duration > 0 && ev.position < snap.duration - ENDED_CLEAR_EPSILON;
      return {
        snapshot: {
          ...snap,
          currentTime: ev.position,
          ended: snap.ended && !awayFromEnd,
        },
        effects: ["timeupdate"],
      };
    }
    case "pause": {
      // Defense in depth vs stale events racing a load (the Rust side latches
      // seqs at file boundaries, but pre-loaded state changes are meaningless
      // to the UI either way — `loaded` itself establishes paused=false).
      if (!snap.loaded) return { snapshot: snap, effects: [] };
      return {
        snapshot: { ...snap, paused: ev.paused },
        effects: [ev.paused ? "pause" : "play"],
      };
    }
    case "eof": {
      // Same guard: an eof that arrives before this load's `loaded` can only
      // belong to a replaced file — acting on it would auto-advance the queue
      // past the file the user just opened.
      if (!snap.loaded) return { snapshot: snap, effects: [] };
      if (snap.ended) return { snapshot: snap, effects: [] }; // the once-latch
      return {
        snapshot: {
          ...snap,
          ended: true,
          paused: true,
          currentTime: snap.duration > 0 ? snap.duration : snap.currentTime,
        },
        effects: ["ended"],
      };
    }
    case "playbackRestart": {
      const awayFromEnd =
        snap.duration > 0 && snap.currentTime < snap.duration - ENDED_CLEAR_EPSILON;
      return {
        snapshot: {
          ...snap,
          seekInFlight: false,
          ended: snap.ended && !awayFromEnd,
        },
        effects: ["seekSettled", "timeupdate"],
      };
    }
    case "endFile": {
      if (ev.reason === "error") {
        return {
          snapshot: { ...snap, loaded: false, paused: true },
          effects: ["error"],
          errorMessage: ev.message ?? "playback failed",
        };
      }
      // stop/quit/redirect fire on every replace-load — deliberately ignored.
      return { snapshot: snap, effects: [] };
    }
  }
}

// --- Seek coalescing --------------------------------------------------------
// At most ONE native seek is in flight; while unsettled only the LATEST target
// is remembered. Settling happens on playbackRestart, on invoke rejection, or
// via a watchdog timeout — so a failed seek can never wedge the scrubber or
// the reverse shuttle (which issues ~60 requests/s and relies on this pacing).

export interface SeekCoalescer {
  inFlight: boolean;
  /** Monotonic ms when the in-flight seek was issued (watchdog input). */
  issuedAt: number;
  /** The newest requested target while in flight, or null. */
  pending: number | null;
  lastIssuedAt: number;
}

/** Minimum ms between issued seeks — bounds the reverse-shuttle/scrub rate. */
export const SEEK_MIN_INTERVAL_MS = 50;
/** An in-flight seek older than this is presumed failed and released. */
export const SEEK_WATCHDOG_MS = 500;

export function createSeekCoalescer(): SeekCoalescer {
  return { inFlight: false, issuedAt: 0, pending: null, lastIssuedAt: -SEEK_MIN_INTERVAL_MS };
}

export interface SeekDecision {
  coalescer: SeekCoalescer;
  /** A target to actually issue now (invoke player_seek), or null. */
  issue: number | null;
}

/** Request a seek to `target` at monotonic time `now`. */
export function seekRequest(c: SeekCoalescer, target: number, now: number): SeekDecision {
  if (c.inFlight || now - c.lastIssuedAt < SEEK_MIN_INTERVAL_MS) {
    return { coalescer: { ...c, pending: target }, issue: null };
  }
  return {
    coalescer: { ...c, inFlight: true, issuedAt: now, lastIssuedAt: now, pending: null },
    issue: target,
  };
}

/**
 * Settle the in-flight seek (playbackRestart arrived, the invoke rejected, or
 * the watchdog fired). Issues the newest pending target, if any.
 */
export function seekSettle(c: SeekCoalescer, now: number): SeekDecision {
  const released = { ...c, inFlight: false };
  if (released.pending === null) {
    return { coalescer: released, issue: null };
  }
  const target = released.pending;
  return {
    coalescer: { ...released, inFlight: true, issuedAt: now, lastIssuedAt: now, pending: null },
    issue: target,
  };
}

/** True when the in-flight seek should be presumed failed (watchdog). */
export function seekTimedOut(c: SeekCoalescer, now: number): boolean {
  return c.inFlight && now - c.issuedAt >= SEEK_WATCHDOG_MS;
}

// --- Small mapping helpers ---------------------------------------------------

/** Element volume (0–1) → mpv `volume` (0–100), clamped. */
export function volumeToMpv(v01: number): number {
  if (!Number.isFinite(v01)) return 100;
  return Math.min(100, Math.max(0, v01 * 100));
}

/** mpv `volume` (0–100) → element volume (0–1), clamped. */
export function mpvToVolume(v100: number): number {
  if (!Number.isFinite(v100)) return 1;
  return Math.min(1, Math.max(0, v100 / 100));
}

// --- Cut-view geometry / filmstrip helpers (native-002) -----------------------

/** Window-fraction margins around the video, in mpv `video-margin-ratio-*`
 *  order. Zeros = the video fills the window (the standard player). */
export interface MarginRatios {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const ZERO_MARGINS: MarginRatios = { left: 0, right: 0, top: 0, bottom: 0 };

/** mpv requires each opposing margin pair to sum below 1.0; cap the pair at
 *  this so at least 10% of the window is always left for the video. */
const MARGIN_PAIR_MAX = 0.9;

/**
 * Convert the cut-view viewer box (CSS pixels, window coordinates) into mpv
 * `video-margin-ratio-*` window fractions, so the natively-rendered video is
 * letterboxed into the same box the web engine's `object-fit: contain` uses.
 * Degenerate inputs (zero-sized window/box, box outside the window) yield
 * ZERO_MARGINS rather than margins mpv would reject; an oversized opposing
 * pair is scaled down proportionally to keep its sum below 1.0.
 */
export function marginRatiosForBox(
  box: { left: number; top: number; right: number; bottom: number },
  winW: number,
  winH: number,
): MarginRatios {
  if (!(winW > 0) || !(winH > 0)) return ZERO_MARGINS;
  if (!(box.right > box.left) || !(box.bottom > box.top)) return ZERO_MARGINS;
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  let left = clamp01(box.left / winW);
  let right = clamp01((winW - box.right) / winW);
  let top = clamp01(box.top / winH);
  let bottom = clamp01((winH - box.bottom) / winH);
  const h = left + right;
  if (h > MARGIN_PAIR_MAX) {
    left *= MARGIN_PAIR_MAX / h;
    right *= MARGIN_PAIR_MAX / h;
  }
  const v = top + bottom;
  if (v > MARGIN_PAIR_MAX) {
    top *= MARGIN_PAIR_MAX / v;
    bottom *= MARGIN_PAIR_MAX / v;
  }
  return { left, right, top, bottom };
}

/** Midpoint time of filmstrip cell `k` of `cells` — the single definition both
 *  the web generator scan and the native ffmpeg still extraction sample at, so
 *  the two engines produce the same strip for the same clip. */
export function filmstripCellTime(k: number, cells: number, duration: number): number {
  if (!(cells > 0) || !Number.isFinite(duration) || duration <= 0) return 0;
  return ((k + 0.5) / cells) * duration;
}

/** One frame-step's target time for engines without a native frame-step (the
 *  web `<video>`): the current time nudged by one frame at `fps`, floored at 0. */
export function frameStepTarget(current: number, fps: number, forward: boolean): number {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const dt = 1 / rate;
  return Math.max(0, (Number.isFinite(current) ? current : 0) + (forward ? dt : -dt));
}

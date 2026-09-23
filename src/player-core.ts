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

/**
 * A sort key whose plain lexicographic (byte) order reproduces `compareNatural`
 * (tags-001). SQL cannot page through a comparator, so the tag store keeps a
 * precomputed key per item and orders by that.
 *
 * Digit runs are emitted length-prefixed — three decimal digits of length, then the
 * digits with leading zeros stripped — so `page7` sorts before `page10`.
 * Because that prefix is ITSELF a digit character for every run length from 0 to 999,
 * a digit run keeps its position relative to letters and punctuation exactly as
 * `compareNatural` orders it; a fixed-width zero pad would break the moment a real
 * filename carried a longer number (a 17-digit timestamp does).
 *
 * The key ends with U+0001 and the RAW name, which reproduces the comparator's
 * case-sensitive tie-break and keeps the order total. U+0001 (not U+0000: an
 * embedded NUL is a hazard in SQLite TEXT; not a space: a space is a legal
 * filename character) sorts below every character a Windows filename may hold.
 *
 * Accepted limit: a digit run longer than 999 digits clamps its prefix length, so
 * the length prefix no longer separates such runs and the digits themselves decide
 * the comparison lexicographically. The relative order of two runs past 999 digits
 * is therefore UNSPECIFIED — it can disagree with `compareNatural` (1000 nines and
 * 1001 eights order one way here and the other way there). No filename sorts by a
 * 1000-digit number.
 */
export function naturalSortKey(name: string): string {
  const lower = name.toLowerCase();
  let out = "";
  let i = 0;
  while (i < lower.length) {
    const c = lower[i];
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < lower.length && lower[j] >= "0" && lower[j] <= "9") j++;
      const digits = lower.slice(i, j).replace(/^0+(?=\d)/, "");
      const len = Math.min(digits.length, 999);
      out += String(len).padStart(3, "0") + digits;
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return `${out}\u0001${name}`;
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

/** Upper bound on a tag name (defensive against pasted garbage), mirrored by
 *  MAX_TAG_NAME in src-tauri/src/tags.rs — Rust is the authority, this is the
 *  client-side courtesy that stops a doomed round trip. */
export const MAX_TAG_NAME = 64;

/**
 * Turn what the user typed into the tags they meant (tags-001).
 *
 * Commas separate, so three tags can be typed in one go. Cleaning only: this
 * decides nothing about identity — Rust folds and de-duplicates against what is
 * already stored. The in-draft de-duplication here just stops one field from
 * sending the same tag twice.
 */
export function cleanTagDraft(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(",")) {
    const cleaned = piece
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) continue;
    const capped = cleaned.slice(0, MAX_TAG_NAME);
    const key = capped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(capped);
  }
  return out;
}

/**
 * The identity a tag is attached to (tags-001): `{ archive, path }`.
 *
 * For a plain file that is its path on disk and an empty archive. For a page
 * browsed inside an archive it is the ARCHIVE plus the path INSIDE it — never
 * the materialized mirror path, which lives in a cache directory the 30-day
 * prune will eventually delete and which would take the tag with it.
 */
export function tagIdentity(
  path: string,
  origin: ArchiveOrigin | null | undefined,
): { archive: string; path: string } {
  if (!origin || !origin.archive) return { archive: "", path };
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const leaf = cut >= 0 ? path.slice(cut + 1) : path;
  return {
    archive: origin.archive,
    path: origin.innerDir ? `${origin.innerDir}/${leaf}` : leaf,
  };
}

/** Rows per `tag_items` request (tags-002). Large enough that scrolling rarely
 *  waits, small enough that one page's missing-file stat stays cheap. */
export const TAG_PAGE_SIZE = 500;

/** The hard cap the tag view used to put on how many tiles it would ever put
 *  in the DOM, before the sliding window (Task 12) replaced it — the window
 *  has no such ceiling, so `ui.galleryTagCapped` is never set true anywhere
 *  today and the header never shows a cap notice. Retained, unused, as the
 *  documented fallback: reverting to this cap is dropping the window, not a
 *  rewrite. Do not delete this or `galleryTagCapped` on that account. */
export const TAG_VIEW_CAP = 2000;

/** Which page holds an absolute index. A negative index (the grid's cursor
 *  before any tile is focused) means the first page, not an error. */
export function pageForIndex(index: number, pageSize: number): number {
  if (index <= 0) return 0;
  return Math.floor(index / pageSize);
}

/** The `{ offset, limit }` to request for a page, clipped to `total` so the last
 *  page does not ask for rows that cannot exist. A page past the end yields a
 *  limit of 0, which the caller can skip without a round trip. */
export function pageRange(
  page: number,
  pageSize: number,
  total: number,
): { offset: number; limit: number } {
  const offset = Math.max(0, page) * pageSize;
  if (offset >= total) return { offset, limit: 0 };
  return { offset, limit: Math.min(pageSize, total - offset) };
}

/** The absolute `[start, end)` slice of a list to keep in the DOM, centred on
 *  the focused index and clamped to the ends without shrinking (tags-002). */
export function windowBounds(
  total: number,
  focus: number,
  windowSize: number,
): { start: number; end: number } {
  if (total <= windowSize) return { start: 0, end: total };
  const half = Math.floor(windowSize / 2);
  const wanted = Math.max(0, focus - half);
  const start = Math.min(wanted, total - windowSize);
  return { start, end: start + windowSize };
}

/** The tag header's meta line. Deliberately counts ITEMS only — a global missing
 *  count would cost a full filesystem scan of the tag on every open. */
export function tagMeta(total: number): string {
  if (total <= 0) return "No items";
  if (total === 1) return "1 item";
  return `${total.toLocaleString("en-US")} items`;
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

// --- Image viewer transform tools (img-001) ----------------------------------
//
// The photo viewer's zoom / pan / rotate / flip state and the geometry that
// keeps it honest. Pure by design: the viewer owns one ImageTransform value and
// every gesture is a function from one transform to the next, so the awkward
// parts (anchoring a zoom at the cursor, fitting a ROTATED box, clamping a pan
// so the window never shows dead space beside the picture) are unit-testable
// without a DOM.
//
// Conventions used throughout this section:
//   * `zoom` is ABSOLUTE scale against the image's natural pixel size, so 1 is
//     true 100% and the on-screen readout is honest.
//   * `x`/`y` are the picture's centre offset from the viewport centre, in CSS
//     pixels. (0, 0) is centred, which is where "fit" always sits.
//   * "rendered" means the on-screen box: the rotated size times the zoom.

/** Quarter turns are the only rotations the viewer offers (no free rotate). */
export type ImageRotation = 0 | 90 | 180 | 270;

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImagePoint {
  x: number;
  y: number;
}

export interface ImageTransform {
  zoom: number;
  x: number;
  y: number;
  rotation: ImageRotation;
  flipH: boolean;
  flipV: boolean;
  /** "fit" re-derives zoom from the viewport on every resize; "free" is the
   *  user's own zoom and survives a resize untouched. */
  mode: "fit" | "free";
}

/** The state every freshly-opened photo starts in (and that 0 returns to). */
export function resetImageTransform(): ImageTransform {
  return { zoom: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false, mode: "fit" };
}

function isPositiveSize(s: ImageSize): boolean {
  return (
    Number.isFinite(s.width) && Number.isFinite(s.height) && s.width > 0 && s.height > 0
  );
}

/** The picture's footprint after rotation — width and height swap on a quarter
 *  turn. Everything that measures the picture on screen goes through this. */
export function rotatedSize(natural: ImageSize, rotation: ImageRotation): ImageSize {
  return rotation === 90 || rotation === 270
    ? { width: natural.height, height: natural.width }
    : { width: natural.width, height: natural.height };
}

/**
 * The zoom at which the picture just fits the viewport, measured against the
 * ROTATED box — a landscape photo turned on its side fits by height, not width.
 *
 * Capped at 1: "fit" shrinks a picture too big for the window but never blows a
 * small one up, which is exactly what the `max-width/max-height: 100%` CSS this
 * replaced did. Degenerate sizes yield 1 rather than 0 or Infinity.
 */
export function fitScale(
  natural: ImageSize,
  viewport: ImageSize,
  rotation: ImageRotation,
): number {
  if (!isPositiveSize(natural) || !isPositiveSize(viewport)) return 1;
  const box = rotatedSize(natural, rotation);
  return Math.min(1, Math.min(viewport.width / box.width, viewport.height / box.height));
}

/** The picture's on-screen box under `t`. */
export function renderedSize(natural: ImageSize, t: ImageTransform): ImageSize {
  const box = rotatedSize(natural, t.rotation);
  return { width: box.width * t.zoom, height: box.height * t.zoom };
}

/** Zoom range the viewer allows. Below the floor a photo is an unreadable
 *  speck; above the ceiling a 24MP image is a wall of single pixels. */
export const IMAGE_ZOOM_MIN = 0.1;
export const IMAGE_ZOOM_MAX = 16;

/** The stops the +/- keys and the toolbar buttons walk between. The wheel is
 *  continuous and ignores these, which is why stepImageZoom has to cope with a
 *  starting zoom that sits between two stops. */
export const IMAGE_ZOOM_STOPS = [
  0.1, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16,
] as const;

/** Float slack for comparing a zoom against a ladder stop. */
const ZOOM_EPSILON = 1e-6;

export function clampImageZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, zoom));
}

/**
 * The next ladder stop past `zoom` in direction `dir` (+1 up, -1 down).
 *
 * "Past" is strict, so a zoom already sitting on a stop moves off it, and a
 * wheel-zoom's off-ladder value (0.83, say) snaps to the first stop in the
 * direction pressed rather than to the nearest one — pressing + must never
 * make the picture smaller.
 */
export function stepImageZoom(zoom: number, dir: number): number {
  const from = clampImageZoom(zoom);
  if (dir > 0) {
    for (const stop of IMAGE_ZOOM_STOPS) if (stop > from + ZOOM_EPSILON) return stop;
    return IMAGE_ZOOM_MAX;
  }
  for (let i = IMAGE_ZOOM_STOPS.length - 1; i >= 0; i--) {
    const stop = IMAGE_ZOOM_STOPS[i];
    if (stop < from - ZOOM_EPSILON) return stop;
  }
  return IMAGE_ZOOM_MIN;
}

/**
 * Hold the pan inside the picture's own edges: you may drag as far as the
 * hidden overflow and no further, so the window never shows dead space beside
 * a picture bigger than it. A picture SMALLER than the window has no slack at
 * all and snaps back to centred.
 */
export function clampImagePan(
  t: ImageTransform,
  natural: ImageSize,
  viewport: ImageSize,
): ImageTransform {
  const r = renderedSize(natural, t);
  const slackX = Math.max(0, (r.width - viewport.width) / 2);
  const slackY = Math.max(0, (r.height - viewport.height) / 2);
  // `+ 0` normalizes the -0 that clamping a negative pan against a zero slack
  // produces, so a centred picture is always exactly 0 rather than "-0px" in
  // the CSS transform.
  const axis = (v: number, slack: number): number =>
    Number.isFinite(v) ? Math.min(slack, Math.max(-slack, v)) + 0 : 0;
  return { ...t, x: axis(t.x, slackX), y: axis(t.y, slackY) };
}

/** Whether any of the picture is off-screen — the test for whether panning is
 *  meaningful at all. The arrow keys use it to decide between panning and
 *  stepping to the next photo. */
export function canPanImage(
  t: ImageTransform,
  natural: ImageSize,
  viewport: ImageSize,
): boolean {
  const r = renderedSize(natural, t);
  // Half a pixel of slack: a picture that fills the window EXACTLY hides
  // nothing, and float noise must not make it look pannable.
  return r.width > viewport.width + 0.5 || r.height > viewport.height + 0.5;
}

/**
 * Zoom to `nextZoom` while keeping whatever image point sits under `anchor`
 * (viewport coordinates) fixed under it — the wheel-zoom and click-to-zoom
 * behaviour. Centre-anchored zoom, the naive version, slides the thing you were
 * looking at out from under the cursor.
 *
 * The result is pan-clamped, so a zoom that stops overflowing the window
 * re-centres rather than leaving the picture hanging off to one side.
 */
export function zoomImageAt(
  t: ImageTransform,
  natural: ImageSize,
  viewport: ImageSize,
  nextZoom: number,
  anchor: ImagePoint,
): ImageTransform {
  const zoom = clampImageZoom(nextZoom);
  if (!isPositiveSize(natural) || !isPositiveSize(viewport) || !(t.zoom > 0)) {
    return { ...t, zoom, mode: "free" };
  }
  const k = zoom / t.zoom;
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  // Vector from the picture's centre to the anchor, scaled by the zoom change.
  const dx = anchor.x - (cx + t.x);
  const dy = anchor.y - (cy + t.y);
  const moved: ImageTransform = {
    ...t,
    zoom,
    x: anchor.x - k * dx - cx,
    y: anchor.y - k * dy - cy,
    mode: "free",
  };
  return clampImagePan(moved, natural, viewport);
}

/** Snap any multiple of 90 (positive or negative) into the 0/90/180/270 set. */
function normalizeRotation(deg: number): ImageRotation {
  const q = (((Math.round(deg / 90) % 4) + 4) % 4) * 90;
  return q as ImageRotation;
}

/**
 * Turn by `delta` degrees (±90 in practice).
 *
 * Two things travel with the turn. The pan resets, because a picture left
 * panned into a corner lands somewhere unrecognisable once its axes swap. And
 * a picture in fit mode re-fits to the NEW box — a wide photo stood on its end
 * fits by height, and keeping the old zoom would run it off the window.
 */
export function rotateImageBy(
  t: ImageTransform,
  delta: number,
  natural: ImageSize,
  viewport: ImageSize,
): ImageTransform {
  const rotation = normalizeRotation(t.rotation + delta);
  const zoom = t.mode === "fit" ? fitScale(natural, viewport, rotation) : t.zoom;
  return clampImagePan({ ...t, rotation, zoom, x: 0, y: 0 }, natural, viewport);
}

/** Toggle one mirror. The axis is the picture's own, not the screen's — see
 *  imageTransformCss for where that is actually decided. */
export function flipImage(t: ImageTransform, axis: "h" | "v"): ImageTransform {
  return axis === "h" ? { ...t, flipH: !t.flipH } : { ...t, flipV: !t.flipV };
}

/** Back to fit-to-window, centred. Rotation and mirrors are the user's stated
 *  intent about the picture itself, so they survive. */
export function fitImage(
  t: ImageTransform,
  natural: ImageSize,
  viewport: ImageSize,
): ImageTransform {
  return {
    ...t,
    zoom: fitScale(natural, viewport, t.rotation),
    x: 0,
    y: 0,
    mode: "fit",
  };
}

/**
 * The click / actual-size gesture: fit becomes 100% under the cursor, anything
 * else returns to fit.
 *
 * For a picture smaller than the window the two are the same zoom, so this is a
 * no-op — deliberate, rather than inventing an arbitrary magnification.
 */
export function toggleImageFit(
  t: ImageTransform,
  natural: ImageSize,
  viewport: ImageSize,
  anchor: ImagePoint,
): ImageTransform {
  const fit = fitScale(natural, viewport, t.rotation);
  const atFit = t.mode === "fit" || Math.abs(t.zoom - fit) < ZOOM_EPSILON;
  return atFit ? zoomImageAt(t, natural, viewport, 1, anchor) : fitImage(t, natural, viewport);
}

/** Drag / arrow-key pan: shift by a delta and stop at the picture's edge. */
export function panImageBy(
  t: ImageTransform,
  dx: number,
  dy: number,
  natural: ImageSize,
  viewport: ImageSize,
): ImageTransform {
  return clampImagePan({ ...t, x: t.x + dx, y: t.y + dy }, natural, viewport);
}

/** Trim binary-float noise so the CSS reads "scale(0.3)", not "scale(0.30000000000000004)". */
function cssNumber(v: number): number {
  return Number.isFinite(v) ? Number(v.toFixed(4)) : 0;
}

/**
 * The single CSS transform both render tiers wear.
 *
 * ORDER IS LOAD-BEARING. CSS applies a transform list right-to-left against the
 * element's own axes, so the mirror written LAST is applied FIRST — mirroring
 * the picture about its own horizontal axis before the rotation turns it. Move
 * the mirror ahead of the rotate and "flip horizontal" on a picture turned 90
 * degrees mirrors it vertically on screen, which is not what the button says.
 */
export function imageTransformCss(t: ImageTransform): string {
  const sx = t.flipH ? -1 : 1;
  const sy = t.flipV ? -1 : 1;
  return (
    `translate(${cssNumber(t.x)}px, ${cssNumber(t.y)}px) ` +
    `scale(${cssNumber(t.zoom)}) ` +
    `rotate(${t.rotation}deg) ` +
    `scale(${sx}, ${sy})`
  );
}

/** The toolbar's zoom readout, in whole percent. */
export function imageZoomPercent(t: ImageTransform): number {
  return Math.round((Number.isFinite(t.zoom) ? t.zoom : 1) * 100);
}

/** How much one full wheel notch (deltaY ≈ 100) magnifies. */
const WHEEL_ZOOM_PER_NOTCH = 1.2;
/** Cap on a single event's effect, in notches — high-resolution wheels and
 *  trackpad flings report deltaY in the thousands and would otherwise slam
 *  straight to the end of the range in one gesture. Three notches (1.2^3, about
 *  1.73x) keeps the biggest single event short of a doubling. */
const WHEEL_MAX_NOTCHES = 3;

/**
 * The zoom one wheel event asks for. Multiplicative, so a notch moves by the
 * same RATIO at 0.2x as at 12x — an additive step crawls when zoomed in and
 * lurches when zoomed out — and so scrolling back down returns exactly where it
 * started.
 */
export function wheelZoomTarget(zoom: number, deltaY: number): number {
  const from = clampImageZoom(zoom);
  if (!Number.isFinite(deltaY) || deltaY === 0) return from;
  const notches = Math.max(
    -WHEEL_MAX_NOTCHES,
    Math.min(WHEEL_MAX_NOTCHES, -deltaY / 100),
  );
  return clampImageZoom(from * Math.pow(WHEEL_ZOOM_PER_NOTCH, notches));
}

// --- Image file actions (img-002) --------------------------------------------

/** Where a photo browsed from inside an archive really came from (gallery-004). */
export interface ArchiveOrigin {
  archive: string;
  innerDir: string;
  mirrorDir: string;
}

/**
 * The path "Reveal in Explorer" should select.
 *
 * For a photo opened from inside an archive that is the ARCHIVE, never the
 * materialized page. A page lives in the thumbnail cache under `pb-ar-<hash>`,
 * a directory that means nothing to a reader and that the 30-day prune will
 * eventually delete — revealing it would point them at something disposable
 * instead of at their file.
 */
export function revealTargetPath(
  photoPath: string,
  origin: ArchiveOrigin | null | undefined,
): string {
  return origin && origin.archive ? origin.archive : photoPath;
}

/**
 * A file size for the info panel, scaled to a sensible unit.
 *
 * An unknown or nonsensical size yields "" rather than "NaN bytes", so the
 * panel can drop the row instead of printing a non-answer.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return bytes === 1 ? "1 byte" : `${Math.round(bytes)} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * The canvas transform that bakes a picture's rotation and mirroring into a
 * copy: `ctx.setTransform(...m)` then `drawImage(src, 0, 0)` paints it correctly
 * oriented into a canvas of `rotatedSize(natural, rotation)`.
 *
 * The composition order matches `imageTransformCss` deliberately — mirror first,
 * in the picture's own axes, then rotate. Composed the other way a mirrored,
 * turned photo copies mirrored across the wrong axis and the pasted picture does
 * not match the one on screen.
 *
 * Zoom and pan are deliberately NOT baked in. They are where the reader is
 * looking, not what the picture is; a copy is of the photograph, at its own
 * resolution.
 */
export function orientationDrawMatrix(
  natural: ImageSize,
  rotation: ImageRotation,
  flipH: boolean,
  flipV: boolean,
): [number, number, number, number, number, number] {
  const rad = (rotation * Math.PI) / 180;
  // Exact at the quarter turns; Math.cos(Math.PI / 2) is 6.1e-17, not 0.
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  const sx = flipH ? -1 : 1;
  const sy = flipV ? -1 : 1;
  // Rotation composed with the mirror: R * S. The `+ 0` on each component
  // normalizes the -0 that a zeroed sine or a negated zero produces, so a
  // quarter-turn matrix reads [0, 1, -1, 0] rather than [-0, 1, -1, 0].
  const a = cos * sx + 0;
  const b = sin * sx + 0;
  const c = -sin * sy + 0;
  const d = cos * sy + 0;
  const out = rotatedSize(natural, rotation);
  // Place the picture's centre at the output's centre.
  const e = out.width / 2 + (a * -(natural.width / 2) + c * -(natural.height / 2));
  const f = out.height / 2 + (b * -(natural.width / 2) + d * -(natural.height / 2));
  return [a, b, c, d, e + 0, f + 0];
}


// --- perf-009: which tile the thumbnail pipeline renders next ---------------
//
// The background fill enqueues work in the order it should be done: outward
// from the tile the viewport is actually showing, so a grid finishes from
// what the user is looking at rather than from the top of the folder.
//
// A companion helper that RE-ordered the queue at dequeue time was written,
// unit-tested, and then deleted: across four constructed scenarios it could
// not be told apart from plain FIFO, and the render-order traces of the two
// builds came out identical. The reason is below — by the time work reaches
// the queue it is already ordered, and the queue is never long enough for
// re-sorting to change anything. See perf-009 in docs/feature_list.json.

/**
 * The next slice of still-unrendered tiles to top the queue up with, walking
 * OUTWARD from `focus` so a background fill spreads from what is on screen
 * rather than restarting at the top of the folder.
 *
 * `pending` is ascending and holds only tiles that still need a thumbnail, so
 * it is not contiguous — the walk orders strictly by distance rather than
 * assuming a gap means the end. A tie goes to the tile ABOVE the focus, which
 * on a downward scroll is the one just left behind.
 */
export function nextThumbFillBatch(
  pending: readonly number[],
  focus: number,
  batch: number,
): number[] {
  const out: number[] = [];
  if (batch <= 0) return out;
  // The first candidate at or after the focus; everything before it is the
  // other half of the walk.
  let hi = 0;
  while (hi < pending.length && pending[hi] < focus) hi++;
  let lo = hi - 1;
  while (out.length < batch && (lo >= 0 || hi < pending.length)) {
    if (lo < 0) {
      out.push(pending[hi++]);
    } else if (hi >= pending.length) {
      out.push(pending[lo--]);
    } else if (focus - pending[lo] <= pending[hi] - focus) {
      out.push(pending[lo--]);
    } else {
      out.push(pending[hi++]);
    }
  }
  return out;
}

/**
 * Which QUEUED tile the thumbnail pipeline should pick up next: the position in
 * `queue` of the entry closest to `focus`, or -1 when the queue is empty
 * (perf-010).
 *
 * `nextThumbFillBatch` above puts work INTO the queue in outward order from the
 * focus, so while the viewport stays put this returns 0 and the queue drains as
 * a plain FIFO — which is why perf-009 measured its predecessor to change
 * nothing and deleted it. What that measurement did not cover is the focus
 * MOVING after a batch was enqueued. The queue is then in outward order from a
 * viewport the user has left, and the tiles they are actually looking at (put
 * there by the grid's IntersectionObserver) sit BEHIND up to a full batch of
 * work nobody wants any more.
 *
 * Measured on a cold 1,999-photo folder, pressing End to jump the viewport from
 * tile 0 to tile 1980: 49 stale tiles (761-809, one THUMB_FILL_BATCH plus the
 * one in flight) rendered first, and the first on-screen tile was not even
 * REQUESTED until 2.83 s after the jump. perf-009's own note named this the
 * condition that would re-open the question -- its measurements ran at 18-47 ms
 * a thumbnail, and this folder runs at 118 ms, so one stale batch costs seconds
 * rather than a fraction of one.
 *
 * Ties go to the earlier entry, so equal-distance tiles drain in the order they
 * were queued instead of oscillating. Linear, and deliberately so: the queue is
 * held near the low-water mark (see scheduleThumbFill), a few dozen entries at
 * most, so the scan is cheaper than keeping a sorted structure correct.
 */
export function nearestQueuedThumb(queue: readonly number[], focus: number): number {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < queue.length; i++) {
    const distance = Math.abs(queue[i] - focus);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Deleting a file (img-003)
// ---------------------------------------------------------------------------
// `window.confirm` is unusable in this WebView2 build — it returns true
// synchronously with nothing drawn on screen (see pruneMissingFromTag in
// controller.ts). So a delete is confirmed the way a prune is: press once to
// arm, press again to act.
//
// The arm is KEYED on the file's identity rather than being a bare boolean,
// and that is the load-bearing part for SAFETY: arming on one photo and
// pressing Del after moving to the next must not delete the next one — with
// a keyed arm that falls out of `isArmedFor` for free, because the key check
// simply refuses to match. No reset call site is needed to prevent a
// wrong-file delete.
//
// The shipped tree still resets the arm at three call sites (openImage,
// focusGalleryTile, setGalleryIndex) — those exist for DISPLAY, not safety.
// Without them the key check still protects the file, but the armed toolbar
// button or tile outline would keep pointing at a file that is no longer
// under the cursor, telling the user a second press destroys something other
// than what it actually would. The resets keep what is SHOWN honest; they are
// not what keeps the delete itself correct.

/** How long a delete stays armed after the first press. Mirrors
 *  PRUNE_ARM_MS in controller.ts rather than inventing a second duration for
 *  the same idea. */
export const DELETE_ARM_MS = 5000;

/** An armed delete: which file, and until when. */
export interface DeleteArm {
  key: string;
  expires: number;
}

/** The identity a delete is armed against. `archive` is "" for a real file;
 *  otherwise `path` is the path INSIDE that archive, and the two are different
 *  things that must never collide. The separator is a NUL, which cannot occur
 *  in a Windows path. */
export function deleteArmKey(archive: string, path: string): string {
  return `${archive}\u0000${path}`;
}

/** Arm a delete for `key`, expiring `ttlMs` from `now`. */
export function armDelete(key: string, now: number, ttlMs: number): DeleteArm {
  return { key, expires: now + ttlMs };
}

/** True only when `arm` is for this exact file and has not expired. */
export function isArmedFor(arm: DeleteArm | null, key: string, now: number): boolean {
  if (!arm) return false;
  if (arm.key !== key) return false;
  return now < arm.expires;
}

/**
 * Where the cursor goes after the item at `index` is deleted from a queue of
 * `length`, or -1 when that emptied it.
 *
 * Deleting from the middle keeps the index: the NEXT photo slides into the
 * slot, which is what "delete and keep going" means. Deleting the last one has
 * no next, so it steps back to the new end.
 */
export function indexAfterDelete(index: number, length: number): number {
  if (length <= 1) return -1;
  return Math.min(index, length - 2);
}

/**
 * The delete button's title and accessible name (img-003).
 *
 * Armed, the control itself says what a second press does — the same reasoning
 * as `pruneButtonText` in Gallery.svelte: the toast that announced the arm
 * fades after 1.4s but the arm lasts 5s, so a screen reader reaching the
 * button after the toast has gone must still learn it is armed.
 */
export function deleteButtonText(
  armed: boolean,
  name: string,
): { title: string; label: string } {
  if (!armed) {
    return {
      title: "Delete (Del)",
      label: `Delete ${name} — moves it to the Recycle Bin`,
    };
  }
  return {
    title: `Press again to delete ${name}`,
    label: `Press again to move ${name} to the Recycle Bin`,
  };
}

// ---------------------------------------------------------------------------
// The blacklist browsing filter (tags-003)
// ---------------------------------------------------------------------------
// Blacklisting a tag hides the items carrying it from BROWSING. It deletes
// nothing and un-tags nothing, so turning it off restores everything exactly.
//
// The set of hidden identities comes from Rust in one call per blacklist change
// (tags.rs `hidden_keys`), not per item — an item-by-item lookup would put a
// database round trip on the gallery's hot path, which perf-008/009 spent two
// features clearing.
//
// Rust is the sole authority on the key format. These helpers rebuild it only
// to look items up in a set Rust produced; if the two ever disagreed, nothing
// would be hidden — a fail-open the filter's own tests pin down.

/** The identity of one item, matching what tags.rs `hidden_keys` returns.
 *  `archive` is "" for a real file; otherwise `path` is the path INSIDE that
 *  archive. NUL separates them because it cannot occur in a path, so an
 *  archive page can never collide with a real file of the joined name. */
export function hiddenKey(archive: string, path: string): string {
  return `${archive}\u0000${path}`;
}

/** True when this item carries a blacklisted tag. An absent `archive` field is
 *  an ordinary file, keyed the same as an explicit "". */
export function isHidden(
  item: { archive?: string; path: string },
  hidden: Set<string>,
): boolean {
  return hidden.has(hiddenKey(item.archive ?? "", item.path));
}

/** Drop every item carrying a blacklisted tag, preserving order and element
 *  type. Generic because the three places items enter the UI carry three
 *  different shapes — a gallery tile, a photo-queue entry and a recent file —
 *  which agree only on `path` and an optional `archive`. */
export function filterBlacklisted<T extends { archive?: string; path: string }>(
  items: T[],
  hidden: Set<string>,
): T[] {
  if (hidden.size === 0) return items; // the overwhelmingly common case
  return items.filter((item) => !isHidden(item, hidden));
}

/**
 * Re-derive an OPEN folder/archive grid after the hidden set changes under it
 * — a blacklisted tag applied to, or removed from, a tile while the grid is
 * up. The grid used to be `filterBlacklisted(listing)` computed once at load,
 * so a tile tagged with a blacklisted tag stayed on screen until the folder
 * was reopened; this is that same derivation, re-run against the retained
 * `listing` with what is currently `shown` and where the `cursor` sits.
 *
 * Returns `changed: false` (and `shown` itself) when the visible set is the
 * same, so the caller can skip every side effect in the common case of a tag
 * that hides nothing. Tiles are matched by identity key, never by reference:
 * the grid holds reactive proxies of the listing's objects, so reference
 * equality is exactly what a live grid cannot offer.
 *
 * The cursor follows its own tile. When that tile was hidden out from under
 * it, it lands on the nearest tile still shown — the one after it first, then
 * the one before — which is where `indexAfterDelete` lands after a delete, for
 * the same reason: what slid into the gap is what the user is now looking at.
 * -1 when there was no cursor, or nothing is left to point at.
 */
export function reviseGrid<T extends { archive?: string; path: string }>(
  listing: T[],
  hidden: Set<string>,
  shown: T[],
  cursor: number,
): { items: T[]; cursor: number; changed: boolean } {
  const items = filterBlacklisted(listing, hidden);
  const keyOf = (it: T): string => hiddenKey(it.archive ?? "", it.path);
  const same =
    items.length === shown.length && items.every((it, i) => keyOf(it) === keyOf(shown[i]));
  if (same) return { items: shown, cursor, changed: false };
  if (cursor < 0 || shown.length === 0) return { items, cursor: -1, changed: true };
  const at = new Map(items.map((it, i) => [keyOf(it), i]));
  const from = Math.min(cursor, shown.length - 1);
  for (let j = from; j < shown.length; j++) {
    const idx = at.get(keyOf(shown[j]));
    if (idx !== undefined) return { items, cursor: idx, changed: true };
  }
  for (let j = from - 1; j >= 0; j--) {
    const idx = at.get(keyOf(shown[j]));
    if (idx !== undefined) return { items, cursor: idx, changed: true };
  }
  return { items, cursor: -1, changed: true };
}

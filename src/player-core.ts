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
  const out: Timestamp[] = [];
  for (const stamp of parsed) {
    if (out.length === 0 || out[out.length - 1].time !== stamp.time) out.push(stamp);
  }
  return out;
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
// Livestream (play-003)
//
// A "live" source is a file still being written on disk: bytes keep arriving and
// the playable region grows over time. The UI feeds those growing bytes into a
// MediaSource (see main.ts); this module owns the *decisions* about the moving
// live window so they can be unit-tested without a real stream.
//
// The model: `available` is how many seconds of media have actually been written
// (the buffered end). We deliberately hold the playhead a `delay` (~5s) behind
// that write head — the "live edge" — so playback never runs into not-yet-written
// bytes and stalls. A viewer may seek/track back anywhere in [0, liveEdge] but
// cannot fast-forward past the live edge while the stream is still live. Once the
// stream completes it behaves like an ordinary file: the whole thing is seekable.
// ---------------------------------------------------------------------------

/** How far behind the write head the live edge sits, in seconds. */
export const LIVE_DELAY_SECONDS = 5;

/**
 * Tolerance, in seconds, for "close enough to the live edge to count as caught
 * up". Keeps the FF gate and the LIVE indicator from flickering as `available`
 * grows fractionally between polls.
 */
export const LIVE_EDGE_EPSILON = 0.75;

/** A snapshot of the moving live window the UI hands to these helpers. */
export interface LiveWindow {
  /** Seconds of media written so far (the buffered end of the growing file). */
  available: number;
  /** Safety delay the live edge is held behind the write head. */
  delay: number;
  /** True while the file is still being written; false once it has finalized. */
  live: boolean;
}

/** Build a LiveWindow with the default delay. */
export function createLiveWindow(available = 0, live = true): LiveWindow {
  return { available, delay: LIVE_DELAY_SECONDS, live };
}

/**
 * The furthest playable / seekable point. While live this is `available - delay`
 * (never below 0); once the stream has finalized the whole of `available` is
 * reachable.
 */
export function liveEdge(w: LiveWindow): number {
  if (!w.live) return w.available;
  return Math.max(0, w.available - w.delay);
}

/** Clamp a requested seek target into the live window [0, liveEdge]. */
export function clampToLiveWindow(target: number, w: LiveWindow): number {
  return clamp(target, 0, liveEdge(w));
}

/**
 * Live-aware skip: move by `delta` seconds, clamped to [0, liveEdge] rather than
 * to a fixed duration (which is unknown for a growing stream). Tracking back
 * always works; fast-forward stops at the live edge.
 */
export function skipLive(currentTime: number, delta: number, w: LiveWindow): number {
  return clampToLiveWindow(currentTime + delta, w);
}

/**
 * Whether the playhead has caught up to the live edge. Only meaningful while the
 * stream is live; a finalized stream is never "caught up" (it is just a file).
 */
export function isCaughtUp(
  currentTime: number,
  w: LiveWindow,
  epsilon: number = LIVE_EDGE_EPSILON,
): boolean {
  if (!w.live) return false;
  return currentTime >= liveEdge(w) - epsilon;
}

/**
 * Whether fast-forward is allowed. Always allowed for a finalized stream; while
 * live it is blocked once the viewer has caught up to the live edge.
 */
export function canFastForwardLive(
  currentTime: number,
  w: LiveWindow,
  epsilon: number = LIVE_EDGE_EPSILON,
): boolean {
  if (!w.live) return true;
  return !isCaughtUp(currentTime, w, epsilon);
}

/** How many seconds the playhead is behind the live edge (never negative). */
export function behindLive(currentTime: number, w: LiveWindow): number {
  return Math.max(0, liveEdge(w) - currentTime);
}

/**
 * Playhead position as a 0..1 fraction of the live window for the scrubber. The
 * window spans [0, available] so the trailing `delay` shows as a small gap on the
 * right between the playhead's reachable edge and the very live tip.
 */
export function liveProgressFraction(currentTime: number, w: LiveWindow): number {
  if (w.available <= 0) return 0;
  return clamp(currentTime / w.available, 0, 1);
}

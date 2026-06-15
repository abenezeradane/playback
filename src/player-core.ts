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

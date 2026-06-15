import { describe, it, expect } from "vitest";
import {
  createInitialState,
  clamp,
  formatTime,
  play,
  pause,
  togglePlay,
  skip,
  fastForward,
  rewind,
  seekTo,
  seekToFraction,
  progressFraction,
  bufferedFraction,
  sliderToTime,
  timeToSlider,
  nextRate,
  setVolume,
  toggleMute,
  effectiveVolume,
  PLAYBACK_RATES,
  SKIP_SECONDS,
  type PlayerState,
} from "./player-core";

const base = (overrides: Partial<PlayerState> = {}): PlayerState => ({
  ...createInitialState(),
  duration: 100,
  ...overrides,
});

describe("clamp", () => {
  it("constrains values to the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
  it("returns the min for NaN", () => {
    expect(clamp(NaN, 2, 10)).toBe(2);
  });
});

describe("formatTime", () => {
  it("formats sub-hour times as m:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(600)).toBe("10:00");
  });
  it("formats hour-plus times as h:mm:ss", () => {
    expect(formatTime(3661)).toBe("1:01:01");
    expect(formatTime(3600)).toBe("1:00:00");
  });
  it("guards against negative and non-finite input", () => {
    expect(formatTime(-10)).toBe("0:00");
    expect(formatTime(NaN)).toBe("0:00");
    expect(formatTime(Infinity)).toBe("0:00");
  });
});

describe("play / pause / resume", () => {
  it("play sets isPlaying true", () => {
    expect(play(base()).isPlaying).toBe(true);
  });
  it("pause sets isPlaying false", () => {
    expect(pause(base({ isPlaying: true })).isPlaying).toBe(false);
  });
  it("togglePlay flips the state (pause then resume)", () => {
    const start = base({ isPlaying: false });
    const paused = togglePlay(start); // -> playing
    expect(paused.isPlaying).toBe(true);
    const resumed = togglePlay(paused); // -> paused
    expect(resumed.isPlaying).toBe(false);
  });
  it("does not mutate the input state", () => {
    const start = base({ isPlaying: false });
    play(start);
    expect(start.isPlaying).toBe(false);
  });
  it("preserves currentTime across pause/resume", () => {
    const s = base({ currentTime: 42, isPlaying: true });
    const paused = pause(s);
    const resumed = play(paused);
    expect(paused.currentTime).toBe(42);
    expect(resumed.currentTime).toBe(42);
  });
});

describe("fast-forward / track back (skip)", () => {
  it("fast-forwards by SKIP_SECONDS", () => {
    const s = base({ currentTime: 20 });
    expect(fastForward(s).currentTime).toBe(20 + SKIP_SECONDS);
  });
  it("tracks back by SKIP_SECONDS", () => {
    const s = base({ currentTime: 20 });
    expect(rewind(s).currentTime).toBe(20 - SKIP_SECONDS);
  });
  it("does not rewind past the start", () => {
    const s = base({ currentTime: 3 });
    expect(rewind(s).currentTime).toBe(0);
  });
  it("does not fast-forward past the end", () => {
    const s = base({ currentTime: 95, duration: 100 });
    expect(fastForward(s).currentTime).toBe(100);
  });
  it("skip handles arbitrary deltas", () => {
    const s = base({ currentTime: 50 });
    expect(skip(s, 25).currentTime).toBe(75);
    expect(skip(s, -30).currentTime).toBe(20);
  });
  it("when duration is unknown, forward skip is not clamped to zero", () => {
    const s = base({ currentTime: 10, duration: 0 });
    expect(fastForward(s).currentTime).toBe(10 + SKIP_SECONDS);
  });
});

describe("seek", () => {
  it("seekTo clamps to [0, duration]", () => {
    const s = base();
    expect(seekTo(s, 50).currentTime).toBe(50);
    expect(seekTo(s, -5).currentTime).toBe(0);
    expect(seekTo(s, 250).currentTime).toBe(100);
  });
  it("seekToFraction maps 0..1 onto duration", () => {
    const s = base({ duration: 200 });
    expect(seekToFraction(s, 0).currentTime).toBe(0);
    expect(seekToFraction(s, 0.5).currentTime).toBe(100);
    expect(seekToFraction(s, 1).currentTime).toBe(200);
    expect(seekToFraction(s, 1.5).currentTime).toBe(200);
  });
});

describe("progress + buffered fractions", () => {
  it("progressFraction reflects position", () => {
    expect(progressFraction(base({ currentTime: 25, duration: 100 }))).toBeCloseTo(0.25);
  });
  it("progressFraction is 0 when duration unknown", () => {
    expect(progressFraction(base({ currentTime: 25, duration: 0 }))).toBe(0);
  });
  it("bufferedFraction clamps to 1", () => {
    expect(bufferedFraction(50, 100)).toBeCloseTo(0.5);
    expect(bufferedFraction(150, 100)).toBe(1);
    expect(bufferedFraction(50, 0)).toBe(0);
  });
});

describe("slider <-> time mapping", () => {
  it("sliderToTime maps the slider domain to seconds", () => {
    expect(sliderToTime(500, 1000, 100)).toBeCloseTo(50);
    expect(sliderToTime(0, 1000, 100)).toBe(0);
    expect(sliderToTime(1000, 1000, 100)).toBeCloseTo(100);
  });
  it("timeToSlider is the inverse", () => {
    expect(timeToSlider(50, 100, 1000)).toBe(500);
    expect(timeToSlider(0, 100, 1000)).toBe(0);
    expect(timeToSlider(100, 100, 1000)).toBe(1000);
  });
  it("timeToSlider is 0 when duration unknown", () => {
    expect(timeToSlider(50, 0, 1000)).toBe(0);
  });
});

describe("playback rate", () => {
  it("cycles through the rate list and wraps", () => {
    expect(nextRate(1)).toBe(1.25);
    expect(nextRate(2)).toBe(PLAYBACK_RATES[0]);
  });
  it("falls back to the first rate for an unknown value", () => {
    expect(nextRate(3)).toBe(PLAYBACK_RATES[0]);
  });
});

describe("volume + mute", () => {
  it("setVolume clamps and mutes at zero", () => {
    const s = base();
    expect(setVolume(s, 0.5).volume).toBe(0.5);
    expect(setVolume(s, 0.5).muted).toBe(false);
    expect(setVolume(s, 0).muted).toBe(true);
    expect(setVolume(s, 2).volume).toBe(1);
  });
  it("toggleMute mutes then unmutes", () => {
    const s = base({ volume: 0.8 });
    const muted = toggleMute(s);
    expect(muted.muted).toBe(true);
    const unmuted = toggleMute(muted);
    expect(unmuted.muted).toBe(false);
    expect(unmuted.volume).toBe(0.8);
  });
  it("unmuting from a zero volume restores audible level", () => {
    const s = base({ volume: 0, muted: true });
    const unmuted = toggleMute(s);
    expect(unmuted.muted).toBe(false);
    expect(unmuted.volume).toBe(1);
  });
  it("effectiveVolume respects the mute flag", () => {
    expect(effectiveVolume(base({ volume: 0.7, muted: false }))).toBe(0.7);
    expect(effectiveVolume(base({ volume: 0.7, muted: true }))).toBe(0);
  });
});

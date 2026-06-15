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
  parseTimecode,
  parseTimestampLine,
  parseTimestamps,
  mergeTimestamps,
  markerFraction,
  previousTimestamp,
  nextTimestamp,
  activeTimestampIndex,
  createLiveWindow,
  liveEdge,
  clampToLiveWindow,
  skipLive,
  isCaughtUp,
  canFastForwardLive,
  behindLive,
  liveProgressFraction,
  PLAYBACK_RATES,
  SKIP_SECONDS,
  LIVE_DELAY_SECONDS,
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

describe("timestamps — parsing", () => {
  it("parseTimecode reads HH:MM:SS / MM:SS / SS into seconds", () => {
    expect(parseTimecode("00:01:30")).toBe(90);
    expect(parseTimecode("1:30")).toBe(90);
    expect(parseTimecode("90")).toBe(90);
    expect(parseTimecode("01:02:03")).toBe(3723);
  });
  it("parseTimecode rejects malformed tokens", () => {
    expect(parseTimecode("")).toBeNull();
    expect(parseTimecode("aa:bb")).toBeNull();
    expect(parseTimecode("1:2:3:4")).toBeNull();
    expect(parseTimecode("1.5")).toBeNull();
  });
  it("parseTimestampLine splits the timecode from the title", () => {
    expect(parseTimestampLine("00:01:30 Chapter one")).toEqual({ time: 90, title: "Chapter one" });
    expect(parseTimestampLine("  0:05   Intro  ")).toEqual({ time: 5, title: "Intro" });
  });
  it("parseTimestampLine falls back to the timecode when no title is given", () => {
    expect(parseTimestampLine("00:00:10")).toEqual({ time: 10, title: "00:00:10" });
  });
  it("parseTimestampLine returns null for blank or non-timecode lines", () => {
    expect(parseTimestampLine("")).toBeNull();
    expect(parseTimestampLine("   ")).toBeNull();
    expect(parseTimestampLine("not a timestamp")).toBeNull();
  });
  it("parseTimestamps sorts, skips junk, and de-duplicates by time", () => {
    const text = [
      "00:00:20 Second",
      "garbage line",
      "00:00:05 First",
      "",
      "00:00:20 Dup (dropped)",
      "00:00:40 Third",
    ].join("\n");
    expect(parseTimestamps(text)).toEqual([
      { time: 5, title: "First" },
      { time: 20, title: "Second" },
      { time: 40, title: "Third" },
    ]);
  });
  it("mergeTimestamps adds, re-sorts, and keeps the existing entry on a tie", () => {
    const existing = [
      { time: 5, title: "First" },
      { time: 20, title: "Second" },
    ];
    const merged = mergeTimestamps(existing, [
      { time: 12, title: "Mid" },
      { time: 5, title: "Dupe (ignored)" },
    ]);
    expect(merged).toEqual([
      { time: 5, title: "First" },
      { time: 12, title: "Mid" },
      { time: 20, title: "Second" },
    ]);
  });
});

describe("timestamps — markers + navigation", () => {
  const stamps = [
    { time: 5, title: "First" },
    { time: 20, title: "Second" },
    { time: 40, title: "Third" },
  ];

  it("markerFraction maps a time onto 0..1 of the duration", () => {
    expect(markerFraction(20, 100)).toBeCloseTo(0.2);
    expect(markerFraction(0, 100)).toBe(0);
    expect(markerFraction(200, 100)).toBe(1); // clamped
    expect(markerFraction(20, 0)).toBe(0); // unknown duration
  });

  it("nextTimestamp finds the closest upcoming marker", () => {
    expect(nextTimestamp(stamps, 0)).toEqual({ time: 5, title: "First" });
    expect(nextTimestamp(stamps, 10)).toEqual({ time: 20, title: "Second" });
    expect(nextTimestamp(stamps, 20)).toEqual({ time: 40, title: "Third" });
    expect(nextTimestamp(stamps, 40)).toBeNull();
  });

  it("previousTimestamp finds the closest earlier marker", () => {
    expect(previousTimestamp(stamps, 100)).toEqual({ time: 40, title: "Third" });
    expect(previousTimestamp(stamps, 25)).toEqual({ time: 20, title: "Second" });
    expect(previousTimestamp(stamps, 5)).toBeNull();
  });

  it("previousTimestamp steps back when resting on a marker (epsilon guard)", () => {
    // Playhead sitting on the 20s marker should step to the 5s marker, not stay.
    expect(previousTimestamp(stamps, 20)).toEqual({ time: 5, title: "First" });
  });

  it("activeTimestampIndex reports the current chapter", () => {
    expect(activeTimestampIndex(stamps, 0)).toBe(-1);
    expect(activeTimestampIndex(stamps, 5)).toBe(0);
    expect(activeTimestampIndex(stamps, 30)).toBe(1);
    expect(activeTimestampIndex(stamps, 999)).toBe(2);
  });
});

describe("livestream — live window", () => {
  it("createLiveWindow uses the default delay and is live by default", () => {
    const w = createLiveWindow(30);
    expect(w).toEqual({ available: 30, delay: LIVE_DELAY_SECONDS, live: true });
    expect(createLiveWindow().available).toBe(0);
    expect(createLiveWindow(10, false).live).toBe(false);
  });

  it("liveEdge holds the edge `delay` seconds behind the write head", () => {
    expect(liveEdge(createLiveWindow(30))).toBe(30 - LIVE_DELAY_SECONDS);
    expect(liveEdge(createLiveWindow(12))).toBe(7);
  });

  it("liveEdge never goes below zero before enough is written", () => {
    expect(liveEdge(createLiveWindow(3))).toBe(0);
    expect(liveEdge(createLiveWindow(0))).toBe(0);
  });

  it("a finalized stream exposes its whole length as the edge", () => {
    expect(liveEdge(createLiveWindow(30, false))).toBe(30);
  });

  it("clampToLiveWindow keeps seeks inside [0, liveEdge]", () => {
    const w = createLiveWindow(30); // edge = 25
    expect(clampToLiveWindow(10, w)).toBe(10);
    expect(clampToLiveWindow(-5, w)).toBe(0);
    expect(clampToLiveWindow(40, w)).toBe(25); // cannot pass the live edge
  });

  it("skipLive tracks back freely but fast-forward stops at the live edge", () => {
    const w = createLiveWindow(30); // edge = 25
    expect(skipLive(10, 10, w)).toBe(20);
    expect(skipLive(20, 10, w)).toBe(25); // clamped to the edge, not 30
    expect(skipLive(4, -10, w)).toBe(0); // clamped to start
  });

  it("isCaughtUp is true only at/after the live edge while live", () => {
    const w = createLiveWindow(30); // edge = 25
    expect(isCaughtUp(10, w)).toBe(false);
    expect(isCaughtUp(25, w)).toBe(true);
    expect(isCaughtUp(24.9, w)).toBe(true); // within the epsilon tolerance
    expect(isCaughtUp(25, createLiveWindow(30, false))).toBe(false); // finalized: never "live"
  });

  it("canFastForwardLive gates FF on the live edge but never blocks a finished stream", () => {
    const w = createLiveWindow(30); // edge = 25
    expect(canFastForwardLive(10, w)).toBe(true);
    expect(canFastForwardLive(25, w)).toBe(false);
    expect(canFastForwardLive(25, createLiveWindow(30, false))).toBe(true);
  });

  it("behindLive reports the gap back to the live edge", () => {
    const w = createLiveWindow(30); // edge = 25
    expect(behindLive(10, w)).toBe(15);
    expect(behindLive(25, w)).toBe(0);
    expect(behindLive(30, w)).toBe(0); // never negative
  });

  it("liveProgressFraction maps the playhead onto the [0, available] window", () => {
    const w = createLiveWindow(40);
    expect(liveProgressFraction(10, w)).toBeCloseTo(0.25);
    expect(liveProgressFraction(0, w)).toBe(0);
    expect(liveProgressFraction(80, w)).toBe(1); // clamped
    expect(liveProgressFraction(10, createLiveWindow(0))).toBe(0); // nothing written yet
  });
});

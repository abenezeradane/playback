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
  sectionSeekTime,
  progressFraction,
  bufferedFraction,
  sliderToTime,
  timeToSlider,
  nextRate,
  stepRate,
  setVolume,
  toggleMute,
  effectiveVolume,
  parseTimecode,
  parseTimestampLine,
  parseTimestamps,
  mergeTimestamps,
  clearTimestamps,
  markerFraction,
  previousTimestamp,
  nextTimestamp,
  activeTimestampIndex,
  timestampKey,
  parseTimestampStore,
  serializeTimestampStore,
  readStoredTimestamps,
  writeStoredTimestamps,
  snapFps,
  timeToFrame,
  frameToTime,
  formatSmpte,
  formatFps,
  lastFrameTime,
  fractionToTime,
  createShuttle,
  shuttleStop,
  shuttleForward,
  shuttleReverse,
  shuttleRate,
  abLoopActive,
  abLoopNext,
  niceTickInterval,
  rulerTicks,
  isTextEntryTarget,
  DEFAULT_FPS,
  SHUTTLE_SPEEDS,
  PLAYBACK_RATES,
  SKIP_SECONDS,
  type PlayerState,
  type Shuttle,
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

describe("section seek — 0-9 number keys (play-009)", () => {
  it("maps each digit to its tenth of the duration", () => {
    expect(sectionSeekTime(0, 200)).toBe(0);
    expect(sectionSeekTime(1, 200)).toBe(20);
    expect(sectionSeekTime(5, 200)).toBe(100);
    expect(sectionSeekTime(9, 200)).toBeCloseTo(180);
  });
  it("9 is the maximum (90%); never reaches 100%", () => {
    expect(sectionSeekTime(9, 100)).toBeCloseTo(90);
  });
  it("clamps the digit to 0-9 and floors fractional digits", () => {
    expect(sectionSeekTime(-3, 200)).toBe(0);
    expect(sectionSeekTime(12, 200)).toBeCloseTo(180); // clamps to 9 -> 90%
    expect(sectionSeekTime(5.9, 200)).toBe(100); // floor(5.9) -> 5
  });
  it("guards a non-finite or non-positive duration with 0", () => {
    expect(sectionSeekTime(5, 0)).toBe(0);
    expect(sectionSeekTime(5, -10)).toBe(0);
    expect(sectionSeekTime(5, Number.NaN)).toBe(0);
    expect(sectionSeekTime(5, Number.POSITIVE_INFINITY)).toBe(0);
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
  it("stepRate moves one speed up/down without wrapping", () => {
    expect(stepRate(1, 1)).toBe(1.25);
    expect(stepRate(1, -1)).toBe(0.75);
  });
  it("stepRate clamps at the slowest and fastest rates", () => {
    const min = PLAYBACK_RATES[0];
    const max = PLAYBACK_RATES[PLAYBACK_RATES.length - 1];
    expect(stepRate(min, -1)).toBe(min);
    expect(stepRate(max, 1)).toBe(max);
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
  it("clearTimestamps returns an empty collection (bulk Clear all, play-008)", () => {
    expect(clearTimestamps()).toEqual([]);
    // Independent fresh array each call — never an aliased shared reference.
    expect(clearTimestamps()).not.toBe(clearTimestamps());
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

describe("timestamps — persistence (play-007)", () => {
  const a = [
    { time: 8, title: "Intro" },
    { time: 16, title: "Chorus" },
  ];
  const b = [{ time: 4, title: "Cold open" }];

  it("timestampKey is the trimmed source identity", () => {
    expect(timestampKey("C:/videos/clip.mp4")).toBe("C:/videos/clip.mp4");
    expect(timestampKey("  /tmp/x.mp4  ")).toBe("/tmp/x.mp4");
  });

  it("writeStoredTimestamps stores a sorted, de-duplicated list under the key", () => {
    const store = writeStoredTimestamps({}, "clipA", [
      { time: 16, title: "Chorus" },
      { time: 8, title: "Intro" },
      { time: 8, title: "Dupe" }, // same time as Intro — collapses, first kept
    ]);
    expect(store).toEqual({ clipA: a });
  });

  it("writeStoredTimestamps does not mutate the input store and keeps videos independent", () => {
    const original = { clipA: a };
    const next = writeStoredTimestamps(original, "clipB", b);
    expect(original).toEqual({ clipA: a }); // untouched
    expect(next).toEqual({ clipA: a, clipB: b }); // both scoped separately
  });

  it("writeStoredTimestamps removes the key when the list is emptied", () => {
    const store = { clipA: a, clipB: b };
    const next = writeStoredTimestamps(store, "clipA", []);
    expect(next).toEqual({ clipB: b });
    expect("clipA" in next).toBe(false); // not a lingering empty array
  });

  it("readStoredTimestamps returns the saved set or an empty list", () => {
    expect(readStoredTimestamps({ clipA: a }, "clipA")).toEqual(a);
    expect(readStoredTimestamps({ clipA: a }, "missing")).toEqual([]);
  });

  it("round-trips through serialize + parse", () => {
    const store = writeStoredTimestamps(writeStoredTimestamps({}, "clipA", a), "clipB", b);
    const restored = parseTimestampStore(serializeTimestampStore(store));
    expect(restored).toEqual(store);
  });

  it("parseTimestampStore yields an empty store for null/garbage input", () => {
    expect(parseTimestampStore(null)).toEqual({});
    expect(parseTimestampStore("")).toEqual({});
    expect(parseTimestampStore("not json{")).toEqual({});
    expect(parseTimestampStore("[1,2,3]")).toEqual({}); // an array isn't a store
    expect(parseTimestampStore("42")).toEqual({});
  });

  it("parseTimestampStore drops malformed entries and empty lists, sorting the rest", () => {
    const json = JSON.stringify({
      clipA: [
        { time: 16, title: "Chorus" },
        { time: 8, title: "Intro" },
        { time: -3, title: "Negative" }, // invalid time — dropped
        { time: "x", title: "NaN" }, // non-number — dropped
        { time: 5 }, // missing title — dropped
        { title: "no time" }, // missing time — dropped
      ],
      clipB: [], // empty — whole key dropped
      clipC: "not an array", // dropped
      "": [{ time: 1, title: "blank key" }], // empty key — dropped
    });
    expect(parseTimestampStore(json)).toEqual({ clipA: a });
  });
});

// ---------------------------------------------------------------------------
// Frame-accurate timeline / cut view (play-004)
// ---------------------------------------------------------------------------
describe("frame-accurate timecode — fps + SMPTE (play-004)", () => {
  it("snapFps locks a noisy reading onto the nearest broadcast rate", () => {
    expect(snapFps(29.9704)).toBe(29.97);
    expect(snapFps(23.976023)).toBe(23.976);
    expect(snapFps(30.0001)).toBe(30);
    expect(snapFps(59.94)).toBe(59.94);
  });
  it("snapFps rounds an off-standard rate to a whole number, and guards bad input", () => {
    expect(snapFps(12)).toBe(12); // far from any standard -> rounded whole number
    expect(snapFps(0)).toBe(DEFAULT_FPS);
    expect(snapFps(-5)).toBe(DEFAULT_FPS);
    expect(snapFps(NaN)).toBe(DEFAULT_FPS);
  });

  it("timeToFrame floors to the frame index at the clip fps", () => {
    expect(timeToFrame(0, 30)).toBe(0);
    expect(timeToFrame(1, 30)).toBe(30); // exactly 1s = frame 30 (epsilon absorbs float error)
    expect(timeToFrame(1.0334, 30)).toBe(31); // 31.0 -> 31
    expect(timeToFrame(-2, 30)).toBe(0); // never negative
    expect(timeToFrame(NaN, 30)).toBe(0);
  });
  it("frameToTime is the inverse (whole frames, never negative)", () => {
    expect(frameToTime(30, 30)).toBeCloseTo(1);
    expect(frameToTime(0, 24)).toBe(0);
    expect(frameToTime(-4, 30)).toBe(0);
    expect(frameToTime(48, 24)).toBeCloseTo(2);
  });

  it("formatSmpte renders HH:MM:SS:FF, counting frames within the second", () => {
    expect(formatSmpte(0, 30)).toBe("00:00:00:00");
    expect(formatSmpte(1, 30)).toBe("00:00:01:00");
    expect(formatSmpte(1.5, 30)).toBe("00:00:01:15"); // half a second at 30fps = frame 15
    expect(formatSmpte(61, 24)).toBe("00:01:01:00");
    expect(formatSmpte(3661.5, 30)).toBe("01:01:01:15");
  });
  it("formatSmpte uses a whole-number timebase for fractional rates (29.97 -> 30)", () => {
    // 29.97 counts 30 frames per labelled second (non-drop-frame).
    expect(formatSmpte(1, 29.97)).toBe("00:00:01:00");
    expect(formatSmpte(0.5, 29.97)).toBe("00:00:00:15"); // floor(0.5 * 30) = frame 15
  });
  it("formatSmpte guards negative / non-finite times", () => {
    expect(formatSmpte(-3, 30)).toBe("00:00:00:00");
    expect(formatSmpte(NaN, 24)).toBe("00:00:00:00");
  });

  it("formatFps renders a clean label", () => {
    expect(formatFps(30)).toBe("30 fps");
    expect(formatFps(24)).toBe("24 fps");
    expect(formatFps(29.9704)).toBe("29.97 fps");
    expect(formatFps(23.976023)).toBe("23.976 fps");
  });

  it("lastFrameTime lands on the clip's final whole frame, inside the clip", () => {
    // 10s at 30fps = 300 frames (0..299); last frame index 299 -> 299/30 s.
    expect(lastFrameTime(10, 30)).toBeCloseTo(299 / 30);
    expect(lastFrameTime(10, 30)).toBeLessThan(10);
    expect(lastFrameTime(0, 30)).toBe(0);
    expect(lastFrameTime(-5, 30)).toBe(0);
  });

  it("fractionToTime maps a 0..1 timeline position to seconds (clamped)", () => {
    expect(fractionToTime(0.5, 200)).toBe(100);
    expect(fractionToTime(0, 200)).toBe(0);
    expect(fractionToTime(1.4, 200)).toBe(200); // clamped
    expect(fractionToTime(-1, 200)).toBe(0);
    expect(fractionToTime(0.5, 0)).toBe(0); // unknown duration
  });
});

describe("J/K/L shuttle transport (play-004)", () => {
  it("starts stopped (rate 0)", () => {
    const s = createShuttle();
    expect(s.direction).toBe(0);
    expect(shuttleRate(s)).toBe(0);
  });

  it("L plays forward at 1x, then steps the forward speed up the ladder", () => {
    let s = shuttleForward(createShuttle());
    expect(shuttleRate(s)).toBe(1);
    s = shuttleForward(s);
    expect(shuttleRate(s)).toBe(2);
    s = shuttleForward(s);
    expect(shuttleRate(s)).toBe(4);
  });

  it("forward speed clamps at the fastest rung (no overrun)", () => {
    let s: Shuttle = { direction: 1, speedIndex: SHUTTLE_SPEEDS.length - 1 };
    const max = SHUTTLE_SPEEDS[SHUTTLE_SPEEDS.length - 1];
    expect(shuttleRate(s)).toBe(max);
    s = shuttleForward(s);
    expect(shuttleRate(s)).toBe(max); // still max
  });

  it("J plays in reverse at -1x, then steps the reverse speed up", () => {
    let s = shuttleReverse(createShuttle());
    expect(shuttleRate(s)).toBe(-1);
    s = shuttleReverse(s);
    expect(shuttleRate(s)).toBe(-2);
    s = shuttleReverse(s);
    expect(shuttleRate(s)).toBe(-4);
  });

  it("flipping direction restarts the new direction at the slowest speed", () => {
    let s = shuttleForward(shuttleForward(shuttleForward(createShuttle()))); // forward 4x
    expect(shuttleRate(s)).toBe(4);
    s = shuttleReverse(s); // J flips to reverse, slowest
    expect(shuttleRate(s)).toBe(-1);
    s = shuttleForward(s); // L flips back to forward, slowest
    expect(shuttleRate(s)).toBe(1);
  });

  it("K stops from any state (rate 0)", () => {
    const fast = shuttleForward(shuttleForward(createShuttle()));
    expect(shuttleRate(shuttleStop())).toBe(0);
    expect(shuttleStop().direction).toBe(0);
    // stop is independent of the prior state
    expect(shuttleRate(shuttleStop())).toBe(0);
    expect(shuttleRate(fast)).toBe(2);
  });
});

describe("A-B section loop (play-011)", () => {
  it("abLoopActive needs both points set and ordered A < B", () => {
    expect(abLoopActive(2, 8)).toBe(true);
    expect(abLoopActive(null, 8)).toBe(false);
    expect(abLoopActive(2, null)).toBe(false);
    expect(abLoopActive(null, null)).toBe(false);
    // B at or behind A is not a valid region
    expect(abLoopActive(8, 2)).toBe(false);
    expect(abLoopActive(5, 5)).toBe(false);
    // A at 0 is a legitimate in-point
    expect(abLoopActive(0, 4)).toBe(true);
  });

  it("abLoopNext seeks back to A once the playhead reaches B", () => {
    // Before B: keep playing.
    expect(abLoopNext(2, 2, 8)).toBe(null);
    expect(abLoopNext(7.99, 2, 8)).toBe(null);
    // At/past B: jump back to A.
    expect(abLoopNext(8, 2, 8)).toBe(2);
    expect(abLoopNext(9.5, 2, 8)).toBe(2);
  });

  it("abLoopNext is inert without an active region", () => {
    expect(abLoopNext(10, null, 8)).toBe(null);
    expect(abLoopNext(10, 2, null)).toBe(null);
    expect(abLoopNext(10, null, null)).toBe(null);
    // Inverted / zero-length span never loops, even past 'B'.
    expect(abLoopNext(10, 8, 2)).toBe(null);
    expect(abLoopNext(5, 5, 5)).toBe(null);
  });
});

describe("timeline ruler ticks (play-004)", () => {
  it("niceTickInterval picks a round seconds-per-major spacing", () => {
    expect(niceTickInterval(30, 6)).toBe(5); // 30/6 = 5 -> 5
    expect(niceTickInterval(100, 10)).toBe(10); // 10 -> 10
    expect(niceTickInterval(7, 8)).toBe(1); // raw < 1 -> smallest step
    expect(niceTickInterval(0, 8)).toBe(1);
  });

  it("rulerTicks spans [0,duration] with every 5th tick flagged major", () => {
    const ticks = rulerTicks(30, 6); // major every 5s, minor every 1s
    expect(ticks[0]).toEqual({ time: 0, major: true });
    expect(ticks.find((t) => t.major && t.time === 5)).toBeTruthy();
    expect(ticks.find((t) => !t.major && t.time === 3)).toBeTruthy();
    // last tick is within the clip
    expect(ticks[ticks.length - 1].time).toBeLessThanOrEqual(30 + 1e-6);
    // majors are every 5 minor steps
    const majors = ticks.filter((t) => t.major).map((t) => t.time);
    expect(majors).toEqual([0, 5, 10, 15, 20, 25, 30]);
  });

  it("rulerTicks returns [] for a non-positive duration", () => {
    expect(rulerTicks(0)).toEqual([]);
    expect(rulerTicks(-10)).toEqual([]);
    expect(rulerTicks(NaN)).toEqual([]);
  });
});

describe("isTextEntryTarget — keyboard-shortcut focus guard (bugfix)", () => {
  it("is true for text-entry fields that should swallow shortcuts", () => {
    expect(isTextEntryTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "number" })).toBe(true);
    // no type attribute reflects as "text" in the DOM
    expect(isTextEntryTarget({ tagName: "INPUT", type: "" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "INPUT" })).toBe(true);
    // contentEditable host, regardless of tag
    expect(isTextEntryTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("is false for sliders / checkboxes / buttons — these must NOT kill hotkeys", () => {
    // The core of the bug: a focused range slider (scrubber / volume) used to
    // swallow every shortcut.
    expect(isTextEntryTarget({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "radio" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "button" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "DIV" })).toBe(false);
  });

  it("is case-insensitive on tag and type, and false for no target", () => {
    expect(isTextEntryTarget({ tagName: "input", type: "TEXT" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "input", type: "RANGE" })).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isTextEntryTarget(undefined)).toBe(false);
  });
});

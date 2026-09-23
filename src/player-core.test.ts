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
  editTimestamp,
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
  normalizeFrameDurations,
  animationDuration,
  loopedTime,
  frameIndexAtTime,
  frameStartTime,
  stepFrame,
  isPathWithinRoots,
  fileExtension,
  isTransportStreamPath,
  compareNatural,
  naturalSortKey,
  sortPathsNatural,
  orderGalleryEntries,
  galleryMeta,
  currentIndexOf,
  nextIndex,
  prevIndex,
  parsePlaylistStore,
  serializePlaylistStore,
  sanitizePlaylistName,
  createPlaylist,
  addPlaylist,
  removePlaylist,
  renamePlaylist,
  addPlaylistItems,
  removePlaylistItem,
  movePlaylistItem,
  findPlaylist,
  MAX_PLAYLIST_NAME,
  cleanTagDraft,
  tagIdentity,
  MAX_TAG_NAME,
  pageForIndex,
  pageRange,
  tagMeta,
  windowBounds,
  nextThumbFillBatch,
  nearestQueuedThumb,
  type PlaylistStore,
  DEFAULT_FRAME_DURATION,
  DEFAULT_FPS,
  SHUTTLE_SPEEDS,
  PLAYBACK_RATES,
  SKIP_SECONDS,
  type PlayerState,
  type Shuttle,
  type Timestamp,
  createEngineSnapshot,
  applyPlayerEvent,
  createSeekCoalescer,
  seekRequest,
  seekSettle,
  seekTimedOut,
  SEEK_MIN_INTERVAL_MS,
  SEEK_WATCHDOG_MS,
  volumeToMpv,
  mpvToVolume,
  marginRatiosForBox,
  filmstripCellTime,
  frameStepTarget,
  ZERO_MARGINS,
  resetImageTransform,
  rotatedSize,
  fitScale,
  renderedSize,
  clampImageZoom,
  stepImageZoom,
  zoomImageAt,
  clampImagePan,
  canPanImage,
  IMAGE_ZOOM_MIN,
  IMAGE_ZOOM_MAX,
  rotateImageBy,
  flipImage,
  fitImage,
  toggleImageFit,
  panImageBy,
  imageTransformCss,
  imageZoomPercent,
  wheelZoomTarget,
  revealTargetPath,
  formatFileSize,
  orientationDrawMatrix,
  type EngineSnapshot,
  type NativePlayerEvent,
  deleteArmKey,
  armDelete,
  isArmedFor,
  indexAfterDelete,
  deleteButtonText,
  DELETE_ARM_MS,
  hiddenKey,
  isHidden,
  filterBlacklisted,
  reviseGrid,
  mergeListing,
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

describe("timestamps — edit in place (play-017)", () => {
  const sample = (): Timestamp[] => [
    { time: 5, title: "First" },
    { time: 20, title: "Second" },
    { time: 40, title: "Third" },
  ];
  it("edits the title while keeping the same time and position", () => {
    expect(editTimestamp(sample(), 1, { time: 20, title: "Renamed" })).toEqual([
      { time: 5, title: "First" },
      { time: 20, title: "Renamed" },
      { time: 40, title: "Third" },
    ]);
  });
  it("edits the time and re-sorts the collection", () => {
    expect(editTimestamp(sample(), 0, { time: 30, title: "First" })).toEqual([
      { time: 20, title: "Second" },
      { time: 30, title: "First" },
      { time: 40, title: "Third" },
    ]);
  });
  it("on a collision with another entry's time, the explicit edit wins (other dropped)", () => {
    expect(editTimestamp(sample(), 0, { time: 20, title: "Now here" })).toEqual([
      { time: 20, title: "Now here" },
      { time: 40, title: "Third" },
    ]);
  });
  it("editing an entry to its own time keeps it (does not drop itself)", () => {
    expect(editTimestamp(sample(), 2, { time: 40, title: "Third (edited)" })).toEqual([
      { time: 5, title: "First" },
      { time: 20, title: "Second" },
      { time: 40, title: "Third (edited)" },
    ]);
  });
  it("returns the input unchanged for an out-of-range index", () => {
    const input = sample();
    expect(editTimestamp(input, 5, { time: 1, title: "x" })).toBe(input);
    expect(editTimestamp(input, -1, { time: 1, title: "x" })).toBe(input);
  });
  it("does not mutate the input array", () => {
    const input = sample();
    const snapshot = JSON.parse(JSON.stringify(input));
    editTimestamp(input, 0, { time: 99, title: "Moved" });
    expect(input).toEqual(snapshot);
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

describe("animated-image frame timing (play-012)", () => {
  // A 3-frame animation: 100ms, 200ms, 100ms -> 0.4s total.
  const D = [0.1, 0.2, 0.1];

  it("normalizeFrameDurations replaces zero / invalid delays with the 100ms default", () => {
    expect(normalizeFrameDurations([0.1, 0.2, 0.1])).toEqual([0.1, 0.2, 0.1]);
    expect(normalizeFrameDurations([0, -1, NaN, Infinity])).toEqual([
      DEFAULT_FRAME_DURATION,
      DEFAULT_FRAME_DURATION,
      DEFAULT_FRAME_DURATION,
      DEFAULT_FRAME_DURATION,
    ]);
    // a custom fallback is honoured; valid delays are kept untouched
    expect(normalizeFrameDurations([0, 0.5], 0.04)).toEqual([0.04, 0.5]);
    expect(normalizeFrameDurations([])).toEqual([]);
  });

  it("animationDuration sums the frame durations (ignoring junk)", () => {
    expect(animationDuration(D)).toBeCloseTo(0.4, 9);
    expect(animationDuration([])).toBe(0);
    expect(animationDuration([0.1, NaN, 0.2, -3])).toBeCloseTo(0.3, 9);
  });

  it("loopedTime folds an unbounded clock back into [0, total)", () => {
    expect(loopedTime(0, 0.4)).toBe(0);
    expect(loopedTime(0.3, 0.4)).toBeCloseTo(0.3, 9);
    expect(loopedTime(0.4, 0.4)).toBeCloseTo(0, 9); // exactly one pass wraps to 0
    expect(loopedTime(0.5, 0.4)).toBeCloseTo(0.1, 9); // 1.25 passes
    expect(loopedTime(2.05, 0.4)).toBeCloseTo(0.05, 9);
    // guards
    expect(loopedTime(5, 0)).toBe(0);
    expect(loopedTime(-1, 0.4)).toBe(0);
    expect(loopedTime(NaN, 0.4)).toBe(0);
  });

  it("frameIndexAtTime maps an elapsed time to a frame (clamped, no looping)", () => {
    expect(frameIndexAtTime(D, 0)).toBe(0);
    expect(frameIndexAtTime(D, 0.05)).toBe(0); // within frame 0 [0,0.1)
    expect(frameIndexAtTime(D, 0.1)).toBe(1); // boundary -> next frame
    expect(frameIndexAtTime(D, 0.25)).toBe(1); // within frame 1 [0.1,0.3)
    expect(frameIndexAtTime(D, 0.35)).toBe(2); // within frame 2 [0.3,0.4)
    expect(frameIndexAtTime(D, 0.4)).toBe(2); // at/after end clamps to last
    expect(frameIndexAtTime(D, 99)).toBe(2);
    expect(frameIndexAtTime([], 1)).toBe(0); // empty
  });

  it("frameStartTime returns the cumulative start of a frame, clamped", () => {
    expect(frameStartTime(D, 0)).toBeCloseTo(0, 9);
    expect(frameStartTime(D, 1)).toBeCloseTo(0.1, 9);
    expect(frameStartTime(D, 2)).toBeCloseTo(0.3, 9);
    expect(frameStartTime(D, 5)).toBeCloseTo(0.3, 9); // clamp to last
    expect(frameStartTime(D, -2)).toBe(0); // clamp to first
    expect(frameStartTime([], 0)).toBe(0);
    // round-trips with frameIndexAtTime: the start of a frame lands on that frame
    expect(frameIndexAtTime(D, frameStartTime(D, 1))).toBe(1);
    expect(frameIndexAtTime(D, frameStartTime(D, 2))).toBe(2);
  });

  it("stepFrame wraps around both ends of a looping animation", () => {
    expect(stepFrame(0, 1, 3)).toBe(1);
    expect(stepFrame(2, 1, 3)).toBe(0); // forward off the end wraps to 0
    expect(stepFrame(0, -1, 3)).toBe(2); // back off the start wraps to last
    expect(stepFrame(1, -1, 3)).toBe(0);
    expect(stepFrame(0, 4, 3)).toBe(1); // multi-step wraps
    expect(stepFrame(5, 0, 1)).toBe(0); // single-frame (static) image stays at 0
    expect(stepFrame(0, 1, 0)).toBe(0); // no frames
  });
});

describe("isPathWithinRoots (sec-002 filesystem allow-list)", () => {
  const VID = ["C:/Users/me/Videos"];

  it("allows a file directly inside an allowed root", () => {
    expect(isPathWithinRoots(VID, "C:/Users/me/Videos/clip.mp4")).toBe(true);
    // nested deeper is still inside
    expect(isPathWithinRoots(VID, "C:/Users/me/Videos/sub/clip.mp4")).toBe(true);
    // the root directory itself counts as within
    expect(isPathWithinRoots(VID, "C:/Users/me/Videos")).toBe(true);
  });

  it("denies a path outside every allowed root", () => {
    expect(isPathWithinRoots(VID, "C:/Windows/System32/config/SAM")).toBe(false);
    expect(isPathWithinRoots(VID, "C:/Users/me/.ssh/id_rsa")).toBe(false);
  });

  it("denies a sibling that merely shares a name prefix (segment-boundary match)", () => {
    // "Videos-secret" must NOT be considered inside "Videos"
    expect(isPathWithinRoots(VID, "C:/Users/me/Videos-secret/x.mp4")).toBe(false);
    expect(isPathWithinRoots(["C:/a/video"], "C:/a/videos/x")).toBe(false);
  });

  it("rejects a ../ traversal that escapes the root", () => {
    expect(
      isPathWithinRoots(VID, "C:/Users/me/Videos/../.ssh/id_rsa"),
    ).toBe(false);
    // traversal that climbs out then back in is fine (still lands inside)
    expect(
      isPathWithinRoots(VID, "C:/Users/me/Videos/sub/../clip.mp4"),
    ).toBe(true);
  });

  it("rejects a symlink-escape (its resolved target is outside the root)", () => {
    // The Rust canonicalize step resolves a symlink to its real target before
    // the check; passing that resolved out-of-root path here is denied.
    const roots = ["C:/Users/me/Videos"];
    const resolvedSymlinkTarget = "C:/secrets/passwords.txt";
    expect(isPathWithinRoots(roots, resolvedSymlinkTarget)).toBe(false);
  });

  it("matches across separator styles and drive-letter case", () => {
    expect(isPathWithinRoots(["C:\\Users\\me\\Videos"], "C:/Users/me/Videos/clip.mp4")).toBe(true);
    expect(isPathWithinRoots(["c:/Users/me/Videos"], "C:/Users/me/Videos/clip.mp4")).toBe(true);
    // a different drive is never inside
    expect(isPathWithinRoots(VID, "D:/Users/me/Videos/clip.mp4")).toBe(false);
  });

  it("supports POSIX-style absolute roots", () => {
    expect(isPathWithinRoots(["/home/me/Videos"], "/home/me/Videos/clip.mp4")).toBe(true);
    expect(isPathWithinRoots(["/home/me/Videos"], "/etc/passwd")).toBe(false);
    expect(isPathWithinRoots(["/home/me/Videos"], "/home/me/Videos/../.ssh/key")).toBe(false);
  });

  it("denies by default: empty roots, or a non-absolute / empty candidate", () => {
    expect(isPathWithinRoots([], "C:/Users/me/Videos/clip.mp4")).toBe(false);
    expect(isPathWithinRoots(VID, "clip.mp4")).toBe(false); // relative
    expect(isPathWithinRoots(VID, "")).toBe(false);
    expect(isPathWithinRoots(VID, "   ")).toBe(false);
  });

  it("allows when any one of several roots contains the candidate", () => {
    const roots = ["C:/Users/me/Videos", "D:/Footage", "/mnt/media"];
    expect(isPathWithinRoots(roots, "D:/Footage/take1.mov")).toBe(true);
    expect(isPathWithinRoots(roots, "/mnt/media/a.mp4")).toBe(true);
    expect(isPathWithinRoots(roots, "E:/other/a.mp4")).toBe(false);
  });
});

describe("transport-stream classification (play-016)", () => {
  it("extracts the lowercased extension, or '' when none", () => {
    expect(fileExtension("C:/clips/movie.TS")).toBe("ts");
    expect(fileExtension("/media/a.b.c.mp4")).toBe("mp4");
    expect(fileExtension("no-extension")).toBe("");
    expect(fileExtension("trailing.dot.")).toBe("");
  });

  it("recognises MPEG-TS containers (case-insensitive) across separators", () => {
    expect(isTransportStreamPath("C:/Footage/capture.ts")).toBe(true);
    expect(isTransportStreamPath("C:\\Footage\\capture.TS")).toBe(true);
    expect(isTransportStreamPath("/avchd/00001.m2ts")).toBe(true);
    expect(isTransportStreamPath("/avchd/00001.MTS")).toBe(true);
  });

  it("does not flag containers the WebView plays natively", () => {
    for (const p of ["a.mp4", "a.webm", "a.mkv", "a.mov", "a.gif", "a.png", "noext"]) {
      expect(isTransportStreamPath(p)).toBe(false);
    }
  });
});

describe("folder queue / playlist (play-013)", () => {
  describe("compareNatural + sortPathsNatural", () => {
    it("orders embedded numbers by value, not lexically", () => {
      // A plain string sort would put clip10 before clip2 ("1" < "2").
      const sorted = sortPathsNatural(["clip10.mp4", "clip2.mp4", "clip1.mp4"]);
      expect(sorted).toEqual(["clip1.mp4", "clip2.mp4", "clip10.mp4"]);
    });
    it("handles zero-padded and multi-digit runs by value", () => {
      const sorted = sortPathsNatural(["ep-100.mkv", "ep-9.mkv", "ep-010.mkv"]);
      // By numeric value 9 < 10 (the leading zero is ignored) < 100.
      expect(sorted).toEqual(["ep-9.mkv", "ep-010.mkv", "ep-100.mkv"]);
    });
    it("breaks an equal-value tie deterministically (raw string order)", () => {
      // "9" and "09" are equal by value, so the raw strings settle the order
      // ('0' < '9'); the comparison is consistent so the sort never thrashes.
      expect(compareNatural("ep-09.mkv", "ep-9.mkv")).toBeLessThan(0);
      expect(compareNatural("ep-9.mkv", "ep-09.mkv")).toBeGreaterThan(0);
    });
    it("is case-insensitive for letters but total/stable on ties", () => {
      // 'B' sorts after 'a' despite the case difference (case-folded comparison).
      expect(compareNatural("Bravo", "alpha")).toBeGreaterThan(0);
      expect(compareNatural("alpha", "Bravo")).toBeLessThan(0);
      // Case-insensitively equal -> a non-zero, antisymmetric raw tie-break.
      expect(compareNatural("alpha", "ALPHA")).not.toBe(0);
      expect(Math.sign(compareNatural("alpha", "ALPHA"))).toBe(
        -Math.sign(compareNatural("ALPHA", "alpha")),
      );
      expect(compareNatural("same", "same")).toBe(0);
    });
    it("orders gallery entries folders-first, each naturally sorted (gallery-002)", () => {
      const nodes = orderGalleryEntries(
        ["C:/P/Sub 10", "C:/P/Sub 2", "C:/P/Album"],
        ["C:/P/pic10.jpg", "C:/P/pic2.jpg"],
      );
      // Folders come first as a block (a file browser's convention), and each
      // block is naturally sorted independently — 2 before 10 in both.
      expect(nodes).toEqual([
        { path: "C:/P/Album", name: "Album", kind: "folder" },
        { path: "C:/P/Sub 2", name: "Sub 2", kind: "folder" },
        { path: "C:/P/Sub 10", name: "Sub 10", kind: "folder" },
        { path: "C:/P/pic2.jpg", name: "pic2.jpg", kind: "image" },
        { path: "C:/P/pic10.jpg", name: "pic10.jpg", kind: "image" },
      ]);
    });
    it("interleaves videos with photos in one media block (gallery-003)", () => {
      const nodes = orderGalleryEntries(
        ["C:/P/Album"],
        ["C:/P/IMG_001.jpg", "C:/P/IMG_003.png"],
        ["C:/P/IMG_002.mp4", "C:/P/IMG_010.mov"],
      );
      // Folders still lead. Photos and videos then share ONE naturally-sorted
      // block rather than getting a block each: a shoot that produced
      // IMG_001.jpg and IMG_002.mp4 must show them side by side, which splitting
      // by kind would break.
      expect(nodes).toEqual([
        { path: "C:/P/Album", name: "Album", kind: "folder" },
        { path: "C:/P/IMG_001.jpg", name: "IMG_001.jpg", kind: "image" },
        { path: "C:/P/IMG_002.mp4", name: "IMG_002.mp4", kind: "video" },
        { path: "C:/P/IMG_003.png", name: "IMG_003.png", kind: "image" },
        { path: "C:/P/IMG_010.mov", name: "IMG_010.mov", kind: "video" },
      ]);
    });
    it("handles a folder of videos only, and omitted videos (gallery-003)", () => {
      expect(orderGalleryEntries([], [], ["C:/P/b.mp4", "C:/P/a.mkv"])).toEqual([
        { path: "C:/P/a.mkv", name: "a.mkv", kind: "video" },
        { path: "C:/P/b.mp4", name: "b.mp4", kind: "video" },
      ]);
      // Omitting the argument entirely is the gallery-002 call shape, unchanged.
      expect(orderGalleryEntries([], ["C:/P/a.png"])).toEqual([
        { path: "C:/P/a.png", name: "a.png", kind: "image" },
      ]);
    });
    it("sorts archives among the folders, not as their own block (gallery-004)", () => {
      const nodes = orderGalleryEntries(
        ["C:/P/Zeta", "C:/P/Alpha"],
        ["C:/P/m-1.jpg"],
        [],
        ["C:/P/book.cbz"],
      );
      // An archive IS a directory to a reader, so it sorts WITH the folders by
      // name — between Alpha and Zeta here. Giving archives their own block
      // would put book.cbz after Zeta, and sorting it with the media would put
      // it after m-1.jpg; both are wrong.
      expect(nodes).toEqual([
        { path: "C:/P/Alpha", name: "Alpha", kind: "folder" },
        { path: "C:/P/book.cbz", name: "book.cbz", kind: "archive" },
        { path: "C:/P/Zeta", name: "Zeta", kind: "folder" },
        { path: "C:/P/m-1.jpg", name: "m-1.jpg", kind: "image" },
      ]);
    });
    it("keeps the gallery-002/003 call shapes working (gallery-004)", () => {
      // Omitting `archives` entirely must behave exactly as before.
      expect(orderGalleryEntries([], ["C:/P/a.png"], ["C:/P/b.mp4"])).toEqual([
        { path: "C:/P/a.png", name: "a.png", kind: "image" },
        { path: "C:/P/b.mp4", name: "b.mp4", kind: "video" },
      ]);
      expect(orderGalleryEntries([], [], [], ["C:/P/only.cbz"])).toEqual([
        { path: "C:/P/only.cbz", name: "only.cbz", kind: "archive" },
      ]);
    });
    it("counts archives in the header summary (gallery-004)", () => {
      // The exact string the smoke asserts against the fixture folder.
      expect(galleryMeta(2, 1, 0, 1)).toBe("2 folders · 1 archive · 1 photo");
      expect(galleryMeta(0, 0, 0, 3)).toBe("3 archives");
      expect(galleryMeta(1, 2, 3, 4)).toBe("1 folder · 4 archives · 2 photos · 3 videos");
      // Omitting the count is the gallery-003 call shape, unchanged.
      expect(galleryMeta(1, 2, 3)).toBe("1 folder · 2 photos · 3 videos");
      expect(galleryMeta(0, 0, 0)).toBe("0 photos");
    });
    it("handles either gallery block being empty, and backslash paths", () => {
      // A folder holding only sub-folders is a legitimate gallery, not an error.
      expect(orderGalleryEntries(["C:\\P\\Only"], [])).toEqual([
        { path: "C:\\P\\Only", name: "Only", kind: "folder" },
      ]);
      // ...as is the gallery-001 shape, with no sub-folders at all.
      expect(orderGalleryEntries([], ["C:\\P\\a.png"])).toEqual([
        { path: "C:\\P\\a.png", name: "a.png", kind: "image" },
      ]);
      expect(orderGalleryEntries([], [])).toEqual([]);
    });
    it("does not mutate its inputs", () => {
      const folders = ["C:/P/b", "C:/P/a"];
      const images = ["C:/P/b.png", "C:/P/a.png"];
      const videos = ["C:/P/b.mp4", "C:/P/a.mp4"];
      orderGalleryEntries(folders, images, videos);
      expect(folders).toEqual(["C:/P/b", "C:/P/a"]);
      expect(images).toEqual(["C:/P/b.png", "C:/P/a.png"]);
      expect(videos).toEqual(["C:/P/b.mp4", "C:/P/a.mp4"]);
    });
    it("summarises a gallery's contents, omitting empty kinds (gallery-003)", () => {
      expect(galleryMeta(2, 12, 3)).toBe("2 folders · 12 photos · 3 videos");
      // Singulars, and each kind dropping out when it is zero.
      expect(galleryMeta(1, 0, 1)).toBe("1 folder · 1 video");
      expect(galleryMeta(0, 0, 4)).toBe("4 videos");
      // gallery-001/002 shapes read exactly as they did before videos existed —
      // the two gallery smokes assert on this exact string.
      expect(galleryMeta(0, 3, 0)).toBe("3 photos");
      expect(galleryMeta(2, 5, 0)).toBe("2 folders · 5 photos");
      // An empty folder still says something rather than rendering blank.
      expect(galleryMeta(0, 0, 0)).toBe("0 photos");
    });
    it("sorts full sibling paths by their (shared-prefix) tail", () => {
      const sorted = sortPathsNatural([
        "C:/V/part 3.mp4",
        "C:/V/part 1.mp4",
        "C:/V/part 20.mp4",
      ]);
      expect(sorted).toEqual([
        "C:/V/part 1.mp4",
        "C:/V/part 3.mp4",
        "C:/V/part 20.mp4",
      ]);
    });
    it("does not mutate the input array", () => {
      const input = ["b.mp4", "a.mp4"];
      const out = sortPathsNatural(input);
      expect(input).toEqual(["b.mp4", "a.mp4"]);
      expect(out).toEqual(["a.mp4", "b.mp4"]);
    });
  });

  describe("currentIndexOf", () => {
    it("finds an exact path, or -1 when absent", () => {
      const q = ["/v/a.mp4", "/v/b.mp4", "/v/c.mp4"];
      expect(currentIndexOf(q, "/v/b.mp4")).toBe(1);
      expect(currentIndexOf(q, "/v/missing.mp4")).toBe(-1);
      expect(currentIndexOf([], "/v/a.mp4")).toBe(-1);
    });
  });

  describe("nextIndex / prevIndex (clamp vs. wrap for repeat-all)", () => {
    it("steps forward and stops at the last item when not repeating", () => {
      expect(nextIndex(0, 3, false)).toBe(1);
      expect(nextIndex(1, 3, false)).toBe(2);
      expect(nextIndex(2, 3, false)).toBe(-1); // at the end -> stop
    });
    it("wraps from the last item to the first when repeat-all is on", () => {
      expect(nextIndex(2, 3, true)).toBe(0);
      expect(nextIndex(0, 3, true)).toBe(1);
    });
    it("steps backward and stops at the first item when not repeating", () => {
      expect(prevIndex(2, 3, false)).toBe(1);
      expect(prevIndex(1, 3, false)).toBe(0);
      expect(prevIndex(0, 3, false)).toBe(-1); // at the start -> no-op
    });
    it("wraps from the first item to the last when repeat-all is on", () => {
      expect(prevIndex(0, 3, true)).toBe(2);
      expect(prevIndex(1, 3, true)).toBe(0);
    });
    it("advances a fresh (current = -1) selection to the first item", () => {
      expect(nextIndex(-1, 3, false)).toBe(0);
    });
    it("returns -1 for an empty queue regardless of repeat-all", () => {
      expect(nextIndex(0, 0, false)).toBe(-1);
      expect(nextIndex(0, 0, true)).toBe(-1);
      expect(prevIndex(0, 0, true)).toBe(-1);
    });
    it("single-item queue: repeat-all loops the one item, else stops", () => {
      expect(nextIndex(0, 1, false)).toBe(-1);
      expect(nextIndex(0, 1, true)).toBe(0); // wrap onto itself = replay the queue
      expect(prevIndex(0, 1, true)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// User-created playlists (play-014)
// ---------------------------------------------------------------------------
describe("playlist store (play-014)", () => {
  const sample = (): PlaylistStore => [
    { id: "a", name: "Favorites", items: ["/v/clip-01.mp4", "/v/clip-02.mp4"] },
    { id: "b", name: "Watch later", items: ["/v/clip-03.mp4"] },
  ];

  describe("sanitizePlaylistName", () => {
    it("trims, collapses whitespace, and caps the length", () => {
      expect(sanitizePlaylistName("  My   Mix  ")).toBe("My Mix");
      expect(sanitizePlaylistName("x".repeat(200)).length).toBe(MAX_PLAYLIST_NAME);
    });
    it("falls back to a default for blank / non-string input", () => {
      expect(sanitizePlaylistName("")).toBe("Untitled playlist");
      expect(sanitizePlaylistName("   ")).toBe("Untitled playlist");
      expect(sanitizePlaylistName(null as unknown as string)).toBe("Untitled playlist");
      expect(sanitizePlaylistName(42 as unknown as string)).toBe("Untitled playlist");
    });
  });

  describe("parsePlaylistStore", () => {
    it("round-trips a serialized store", () => {
      const store = sample();
      expect(parsePlaylistStore(serializePlaylistStore(store))).toEqual(store);
    });
    it("returns an empty store for null / garbage / corrupt JSON", () => {
      expect(parsePlaylistStore(null)).toEqual([]);
      expect(parsePlaylistStore(undefined)).toEqual([]);
      expect(parsePlaylistStore("")).toEqual([]);
      expect(parsePlaylistStore("not json {{{")).toEqual([]);
      expect(parsePlaylistStore("{}")).toEqual([]); // an object, not an array
      expect(parsePlaylistStore("42")).toEqual([]);
    });
    it("drops entries without a string id and de-duplicates ids", () => {
      const json = JSON.stringify([
        { id: "a", name: "Keep", items: ["/v/1.mp4"] },
        { name: "No id", items: ["/v/2.mp4"] },
        { id: "", name: "Empty id", items: [] },
        { id: "a", name: "Dupe id dropped", items: ["/v/x.mp4"] },
      ]);
      const out = parsePlaylistStore(json);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({ id: "a", name: "Keep", items: ["/v/1.mp4"] });
    });
    it("sanitizes per-playlist items (drops blanks/non-strings, de-dupes, names)", () => {
      const json = JSON.stringify([
        { id: "a", name: "  ", items: ["/v/1.mp4", "", 7, "/v/1.mp4", "/v/2.mp4", null] },
      ]);
      const out = parsePlaylistStore(json);
      expect(out[0].name).toBe("Untitled playlist");
      expect(out[0].items).toEqual(["/v/1.mp4", "/v/2.mp4"]);
    });
  });

  describe("CRUD on the store", () => {
    it("createPlaylist makes an empty, named playlist with the given id", () => {
      expect(createPlaylist("  My Mix  ", "id-1")).toEqual({
        id: "id-1",
        name: "My Mix",
        items: [],
      });
    });
    it("addPlaylist appends without mutating the input", () => {
      const store = sample();
      const pl = createPlaylist("New", "c");
      const next = addPlaylist(store, pl);
      expect(next).toHaveLength(3);
      expect(next[2]).toBe(pl);
      expect(store).toHaveLength(2); // not mutated
    });
    it("removePlaylist deletes by id only", () => {
      const next = removePlaylist(sample(), "a");
      expect(next.map((p) => p.id)).toEqual(["b"]);
    });
    it("renamePlaylist re-sanitizes the target name, leaving others", () => {
      const next = renamePlaylist(sample(), "b", "  Renamed  Mix ");
      expect(findPlaylist(next, "b")?.name).toBe("Renamed Mix");
      expect(findPlaylist(next, "a")?.name).toBe("Favorites");
    });
    it("renamePlaylist falls back to the default for a blank name", () => {
      expect(findPlaylist(renamePlaylist(sample(), "a", "   "), "a")?.name).toBe(
        "Untitled playlist",
      );
    });
  });

  describe("per-playlist item edits", () => {
    it("addPlaylistItems appends in order, skipping blanks and duplicates", () => {
      const next = addPlaylistItems(sample(), "b", [
        "/v/clip-03.mp4", // already present -> skipped
        "/v/clip-04.mp4",
        "  ", // blank -> skipped
        "/v/clip-05.mp4",
        "/v/clip-04.mp4", // duplicate within the batch -> skipped
      ]);
      expect(findPlaylist(next, "b")?.items).toEqual([
        "/v/clip-03.mp4",
        "/v/clip-04.mp4",
        "/v/clip-05.mp4",
      ]);
    });
    it("addPlaylistItems returns the same playlist reference when nothing changes", () => {
      const store = sample();
      const next = addPlaylistItems(store, "a", ["/v/clip-01.mp4"]); // already present
      expect(findPlaylist(next, "a")).toBe(findPlaylist(store, "a"));
    });
    it("removePlaylistItem drops the item at the index", () => {
      const next = removePlaylistItem(sample(), "a", 0);
      expect(findPlaylist(next, "a")?.items).toEqual(["/v/clip-02.mp4"]);
    });
    it("removePlaylistItem ignores an out-of-range index", () => {
      const next = removePlaylistItem(sample(), "a", 9);
      expect(findPlaylist(next, "a")?.items).toEqual(["/v/clip-01.mp4", "/v/clip-02.mp4"]);
    });
    it("movePlaylistItem reorders up/down and clamps at the ends", () => {
      const three: PlaylistStore = [{ id: "a", name: "n", items: ["x", "y", "z"] }];
      expect(findPlaylist(movePlaylistItem(three, "a", 2, -1), "a")?.items).toEqual([
        "x",
        "z",
        "y",
      ]);
      expect(findPlaylist(movePlaylistItem(three, "a", 0, 1), "a")?.items).toEqual([
        "y",
        "x",
        "z",
      ]);
      // Out-of-bounds moves are no-ops (clamp at the ends).
      expect(findPlaylist(movePlaylistItem(three, "a", 0, -1), "a")?.items).toEqual([
        "x",
        "y",
        "z",
      ]);
      expect(findPlaylist(movePlaylistItem(three, "a", 2, 1), "a")?.items).toEqual([
        "x",
        "y",
        "z",
      ]);
    });
    it("does not mutate the input store on any edit", () => {
      const store = sample();
      addPlaylistItems(store, "a", ["/v/new.mp4"]);
      removePlaylistItem(store, "a", 0);
      movePlaylistItem(store, "a", 0, 1);
      renamePlaylist(store, "a", "changed");
      expect(store).toEqual(sample());
    });
  });
});

// ---------------------------------------------------------------------------
// Native (libmpv) engine — pure event/seek logic (native-001)
// ---------------------------------------------------------------------------
const engineSnap = (overrides: Partial<EngineSnapshot> = {}): EngineSnapshot => ({
  ...createEngineSnapshot(),
  loadSeq: 1,
  loaded: true,
  duration: 100,
  ...overrides,
});

describe("native engine — stale-event guard (native-001)", () => {
  it("drops an event whose loadSeq does not match the snapshot's", () => {
    const s = engineSnap({ currentTime: 10 });
    const before = JSON.parse(JSON.stringify(s));
    const out = applyPlayerEvent(s, { kind: "time", loadSeq: 2, position: 50 });
    expect(out.effects).toEqual([]);
    expect(out.snapshot).toBe(s); // untouched — same object, zero effects
    expect(s).toEqual(before);
    // a stale eof from the replaced file must not latch ended either
    const eof = applyPlayerEvent(s, { kind: "eof", loadSeq: 0 });
    expect(eof.effects).toEqual([]);
    expect(eof.snapshot.ended).toBe(false);
  });

  it("drops every event while a load is awaiting (loadSeq -1)", () => {
    const fresh = createEngineSnapshot();
    const events: NativePlayerEvent[] = [
      { kind: "loaded", loadSeq: -1, duration: 60, width: 640, height: 480, containerFps: 30 },
      { kind: "duration", loadSeq: 0, duration: 60 },
      { kind: "time", loadSeq: -1, position: 5 },
      { kind: "pause", loadSeq: 1, paused: false },
      { kind: "eof", loadSeq: -1 },
      { kind: "playbackRestart", loadSeq: 0 },
      { kind: "endFile", loadSeq: -1, reason: "error", message: "boom" },
    ];
    for (const ev of events) {
      const out = applyPlayerEvent(fresh, ev);
      expect(out.effects).toEqual([]);
      expect(out.snapshot).toBe(fresh);
    }
    expect(fresh).toEqual(createEngineSnapshot()); // nothing leaked through
  });

  it("shutdown applies regardless of loadSeq and resets to a fresh snapshot", () => {
    const busy = engineSnap({ currentTime: 42, ended: true, seekInFlight: true });
    const out = applyPlayerEvent(busy, { kind: "shutdown" });
    expect(out.effects).toEqual(["shutdown"]);
    expect(out.snapshot).toEqual(createEngineSnapshot());
  });
});

describe("native engine — loaded + late duration (native-001)", () => {
  it("loaded sets metadata, clears ended, and fires loadedmetadata", () => {
    const s = engineSnap({ loaded: false, ended: true, paused: true, currentTime: 42, duration: 0 });
    const out = applyPlayerEvent(s, {
      kind: "loaded",
      loadSeq: 1,
      duration: 120,
      width: 1920,
      height: 1080,
      containerFps: 29.97,
    });
    expect(out.effects).toEqual(["loadedmetadata"]);
    expect(out.snapshot.loaded).toBe(true);
    expect(out.snapshot.ended).toBe(false);
    expect(out.snapshot.paused).toBe(false);
    expect(out.snapshot.currentTime).toBe(0);
    expect(out.snapshot.duration).toBe(120);
    expect(out.snapshot.width).toBe(1920);
    expect(out.snapshot.height).toBe(1080);
    expect(out.snapshot.containerFps).toBe(29.97);
  });

  it("loaded guards a non-positive or non-finite duration with 0", () => {
    const s = engineSnap({ loaded: false, duration: 0 });
    for (const duration of [0, -5, NaN, Infinity]) {
      const out = applyPlayerEvent(s, {
        kind: "loaded",
        loadSeq: 1,
        duration,
        width: 640,
        height: 480,
        containerFps: null,
      });
      expect(out.snapshot.duration).toBe(0);
      expect(out.effects).toEqual(["loadedmetadata"]);
    }
  });

  it("a late duration updates and re-fires loadedmetadata only once loaded", () => {
    // The zero-duration fragmented-MP4 case: duration refines after loaded.
    const loaded = engineSnap({ duration: 0 });
    const out = applyPlayerEvent(loaded, { kind: "duration", loadSeq: 1, duration: 90 });
    expect(out.snapshot.duration).toBe(90);
    expect(out.effects).toEqual(["loadedmetadata"]);
    // Before loaded, the event fires nothing.
    const early = engineSnap({ loaded: false, duration: 0 });
    expect(applyPlayerEvent(early, { kind: "duration", loadSeq: 1, duration: 90 }).effects).toEqual([]);
  });

  it("a late duration of zero or less is dropped", () => {
    const s = engineSnap();
    for (const duration of [0, -1, NaN]) {
      const out = applyPlayerEvent(s, { kind: "duration", loadSeq: 1, duration });
      expect(out.snapshot).toBe(s);
      expect(out.effects).toEqual([]);
    }
  });

  it("eof and pause before loaded are dropped (stale events racing a load)", () => {
    // Review-found race: an old file's queued eof/pause drained after a new
    // player_load could otherwise auto-advance the queue past the file the
    // user just opened, or flip the paused UI, before `loaded` arrives.
    const awaitingMeta = engineSnap({ loaded: false, ended: false });
    const eof = applyPlayerEvent(awaitingMeta, { kind: "eof", loadSeq: 1 });
    expect(eof.snapshot).toBe(awaitingMeta);
    expect(eof.effects).toEqual([]);
    const pause = applyPlayerEvent(awaitingMeta, { kind: "pause", loadSeq: 1, paused: true });
    expect(pause.snapshot).toBe(awaitingMeta);
    expect(pause.effects).toEqual([]);
  });

  it("a shrinking duration estimate never reduces the known duration", () => {
    // Found live in the native smoke: for a zero-duration fragmented MP4,
    // mpv's demuxer estimate GROWS as fragments demux (8.3 s of a 60 s file)
    // and can undercut the mfra probe's value — accepting it re-clamped every
    // arrow-key seek to the partial estimate. Lower estimates must be ignored.
    const s = engineSnap({ duration: 58.4 }); // the mfra probe's lower bound
    const lower = applyPlayerEvent(s, { kind: "duration", loadSeq: 1, duration: 12.5 });
    expect(lower.snapshot.duration).toBe(58.4);
    expect(lower.effects).toEqual([]); // nothing changed -> nothing re-fires
    const higher = applyPlayerEvent(s, { kind: "duration", loadSeq: 1, duration: 60.02 });
    expect(higher.snapshot.duration).toBe(60.02);
    expect(higher.effects).toEqual(["loadedmetadata"]);
  });
});

describe("native engine — eof / ended latch (native-001)", () => {
  it("the first eof fires ended once, pauses, and pins currentTime to the duration", () => {
    const s = engineSnap({ paused: false, currentTime: 99.9 });
    const out = applyPlayerEvent(s, { kind: "eof", loadSeq: 1 });
    expect(out.effects).toEqual(["ended"]);
    expect(out.snapshot.ended).toBe(true);
    expect(out.snapshot.paused).toBe(true);
    expect(out.snapshot.currentTime).toBe(100);
  });

  it("a second eof is dropped (pause-toggle re-notify at EOF)", () => {
    const first = applyPlayerEvent(engineSnap({ paused: false }), { kind: "eof", loadSeq: 1 });
    const second = applyPlayerEvent(first.snapshot, { kind: "eof", loadSeq: 1 });
    expect(second.effects).toEqual([]);
    expect(second.snapshot).toBe(first.snapshot);
  });

  it("seek-away clears the latch so a later eof fires ended again", () => {
    const atEnd = applyPlayerEvent(engineSnap({ paused: false }), { kind: "eof", loadSeq: 1 }).snapshot;
    expect(atEnd.ended).toBe(true);
    // Seeking well before the end clears the latch...
    const seekedAway = applyPlayerEvent(atEnd, { kind: "time", loadSeq: 1, position: 10 });
    expect(seekedAway.effects).toEqual(["timeupdate"]);
    expect(seekedAway.snapshot.ended).toBe(false);
    // ...so ending the file again fires ended a second time.
    const again = applyPlayerEvent(seekedAway.snapshot, { kind: "eof", loadSeq: 1 });
    expect(again.effects).toEqual(["ended"]);
    expect(again.snapshot.ended).toBe(true);
  });
});

describe("native engine — time events (native-001)", () => {
  it("updates currentTime and fires timeupdate", () => {
    const out = applyPlayerEvent(engineSnap(), { kind: "time", loadSeq: 1, position: 33.5 });
    expect(out.snapshot.currentTime).toBe(33.5);
    expect(out.effects).toEqual(["timeupdate"]);
  });

  it("is dropped before loaded", () => {
    const s = engineSnap({ loaded: false });
    const out = applyPlayerEvent(s, { kind: "time", loadSeq: 1, position: 33.5 });
    expect(out.snapshot).toBe(s);
    expect(out.effects).toEqual([]);
  });

  it("is dropped while a seek is in flight (no rubber-banding)", () => {
    const s = engineSnap({ seekInFlight: true, currentTime: 80 });
    const out = applyPlayerEvent(s, { kind: "time", loadSeq: 1, position: 12 });
    expect(out.snapshot).toBe(s);
    expect(out.snapshot.currentTime).toBe(80);
    expect(out.effects).toEqual([]);
  });

  it("near the very end it does not clear the ended latch", () => {
    // Within 0.25s of the duration is not "away from the end".
    const s = engineSnap({ ended: true, currentTime: 100 });
    const out = applyPlayerEvent(s, { kind: "time", loadSeq: 1, position: 99.9 });
    expect(out.snapshot.ended).toBe(true);
    expect(out.snapshot.currentTime).toBe(99.9);
    expect(out.effects).toEqual(["timeupdate"]);
  });
});

describe("native engine — pause / playbackRestart / endFile (native-001)", () => {
  it("pause events set paused and map to pause/play effects", () => {
    const paused = applyPlayerEvent(engineSnap({ paused: false }), {
      kind: "pause",
      loadSeq: 1,
      paused: true,
    });
    expect(paused.snapshot.paused).toBe(true);
    expect(paused.effects).toEqual(["pause"]);
    const playing = applyPlayerEvent(paused.snapshot, { kind: "pause", loadSeq: 1, paused: false });
    expect(playing.snapshot.paused).toBe(false);
    expect(playing.effects).toEqual(["play"]);
  });

  it("playbackRestart settles the seek and re-emits the position", () => {
    const s = engineSnap({ seekInFlight: true, currentTime: 40 });
    const out = applyPlayerEvent(s, { kind: "playbackRestart", loadSeq: 1 });
    expect(out.snapshot.seekInFlight).toBe(false);
    expect(out.effects).toContain("seekSettled");
    expect(out.effects).toContain("timeupdate");
  });

  it("playbackRestart clears ended away from the end, keeps it at the end", () => {
    const away = applyPlayerEvent(engineSnap({ ended: true, currentTime: 10, seekInFlight: true }), {
      kind: "playbackRestart",
      loadSeq: 1,
    });
    expect(away.snapshot.ended).toBe(false);
    const atEnd = applyPlayerEvent(engineSnap({ ended: true, currentTime: 100, seekInFlight: true }), {
      kind: "playbackRestart",
      loadSeq: 1,
    });
    expect(atEnd.snapshot.ended).toBe(true);
  });

  it("endFile reason error fires error with the message and unloads", () => {
    const out = applyPlayerEvent(engineSnap({ paused: false }), {
      kind: "endFile",
      loadSeq: 1,
      reason: "error",
      message: "demuxer: corrupt stream",
    });
    expect(out.effects).toEqual(["error"]);
    expect(out.errorMessage).toBe("demuxer: corrupt stream");
    expect(out.snapshot.loaded).toBe(false);
    expect(out.snapshot.paused).toBe(true);
  });

  it("endFile reason error falls back to 'playback failed' without a message", () => {
    const out = applyPlayerEvent(engineSnap(), { kind: "endFile", loadSeq: 1, reason: "error" });
    expect(out.effects).toEqual(["error"]);
    expect(out.errorMessage).toBe("playback failed");
  });

  it("endFile stop/quit/redirect are ignored (fire on every replace-load)", () => {
    const s = engineSnap();
    for (const reason of ["stop", "quit", "redirect"]) {
      const out = applyPlayerEvent(s, { kind: "endFile", loadSeq: 1, reason });
      expect(out.snapshot).toBe(s);
      expect(out.effects).toEqual([]);
      expect(out.errorMessage).toBeUndefined();
    }
  });
});

describe("native engine — seek coalescing (native-001)", () => {
  it("the first request issues immediately", () => {
    const d = seekRequest(createSeekCoalescer(), 12, 0);
    expect(d.issue).toBe(12);
    expect(d.coalescer.inFlight).toBe(true);
    expect(d.coalescer.pending).toBeNull();
  });

  it("requests while in flight stash only the latest target", () => {
    const first = seekRequest(createSeekCoalescer(), 12, 0);
    const second = seekRequest(first.coalescer, 20, 10);
    expect(second.issue).toBeNull();
    expect(second.coalescer.pending).toBe(20);
    const third = seekRequest(second.coalescer, 30, 20); // the later target wins
    expect(third.issue).toBeNull();
    expect(third.coalescer.pending).toBe(30);
    expect(third.coalescer.inFlight).toBe(true);
  });

  it("settling with a pending target issues it and stays in flight", () => {
    const first = seekRequest(createSeekCoalescer(), 12, 0);
    const stashed = seekRequest(first.coalescer, 30, 10);
    const settled = seekSettle(stashed.coalescer, 100);
    expect(settled.issue).toBe(30);
    expect(settled.coalescer.inFlight).toBe(true);
    expect(settled.coalescer.pending).toBeNull();
    expect(settled.coalescer.issuedAt).toBe(100);
  });

  it("settling without a pending target just releases", () => {
    const first = seekRequest(createSeekCoalescer(), 12, 0);
    const settled = seekSettle(first.coalescer, 100);
    expect(settled.issue).toBeNull();
    expect(settled.coalescer.inFlight).toBe(false);
    expect(settled.coalescer.pending).toBeNull();
  });

  it("a request sooner than SEEK_MIN_INTERVAL_MS after the last issue is stashed, even when idle", () => {
    const first = seekRequest(createSeekCoalescer(), 12, 0);
    const idle = seekSettle(first.coalescer, 10).coalescer; // released, nothing pending
    expect(idle.inFlight).toBe(false);
    const tooSoon = seekRequest(idle, 45, SEEK_MIN_INTERVAL_MS - 1);
    expect(tooSoon.issue).toBeNull();
    expect(tooSoon.coalescer.pending).toBe(45);
    // At the interval boundary the request goes out.
    const onTime = seekRequest(idle, 45, SEEK_MIN_INTERVAL_MS);
    expect(onTime.issue).toBe(45);
  });

  it("seekTimedOut trips at the watchdog deadline only while in flight", () => {
    const inFlight = seekRequest(createSeekCoalescer(), 12, 0).coalescer;
    expect(seekTimedOut(inFlight, SEEK_WATCHDOG_MS - 1)).toBe(false);
    expect(seekTimedOut(inFlight, SEEK_WATCHDOG_MS)).toBe(true);
    expect(seekTimedOut(inFlight, SEEK_WATCHDOG_MS + 1000)).toBe(true);
    // Not in flight -> never timed out, no matter how old.
    expect(seekTimedOut(createSeekCoalescer(), 1e9)).toBe(false);
  });
});

describe("native engine — volume mapping (native-001)", () => {
  it("maps element volume (0-1) to mpv (0-100) and back", () => {
    expect(volumeToMpv(0)).toBe(0);
    expect(volumeToMpv(1)).toBe(100);
    expect(volumeToMpv(0.5)).toBe(50);
    expect(mpvToVolume(0)).toBe(0);
    expect(mpvToVolume(100)).toBe(1);
    expect(mpvToVolume(50)).toBe(0.5);
  });

  it("clamps out-of-range values", () => {
    expect(volumeToMpv(1.5)).toBe(100);
    expect(volumeToMpv(-1)).toBe(0);
    expect(mpvToVolume(150)).toBe(1);
    expect(mpvToVolume(-10)).toBe(0);
  });

  it("guards NaN with the neutral full volume", () => {
    expect(volumeToMpv(NaN)).toBe(100);
    expect(mpvToVolume(NaN)).toBe(1);
  });

  it("round-trips through both directions", () => {
    expect(mpvToVolume(volumeToMpv(0.3))).toBeCloseTo(0.3, 9);
    expect(volumeToMpv(mpvToVolume(70))).toBeCloseTo(70, 9);
  });
});

describe("native engine — cut-view margin ratios (native-002)", () => {
  it("converts the viewer box to window-fraction margins", () => {
    // 1600x1000 window, viewer box: 24px gutters, 74px above, 278px below —
    // the cut view's CSS layout at the smoke's window size.
    const m = marginRatiosForBox({ left: 24, top: 74, right: 1576, bottom: 722 }, 1600, 1000);
    expect(m.left).toBeCloseTo(24 / 1600, 9);
    expect(m.right).toBeCloseTo(24 / 1600, 9);
    expect(m.top).toBeCloseTo(74 / 1000, 9);
    expect(m.bottom).toBeCloseTo(278 / 1000, 9);
  });

  it("returns zero margins for degenerate windows and boxes", () => {
    expect(marginRatiosForBox({ left: 24, top: 74, right: 1576, bottom: 722 }, 0, 0)).toEqual(
      ZERO_MARGINS,
    );
    // Collapsed box (display:none / not laid out yet).
    expect(marginRatiosForBox({ left: 0, top: 0, right: 0, bottom: 0 }, 1600, 1000)).toEqual(
      ZERO_MARGINS,
    );
    // Inverted box.
    expect(marginRatiosForBox({ left: 100, top: 100, right: 50, bottom: 50 }, 1600, 1000)).toEqual(
      ZERO_MARGINS,
    );
  });

  it("keeps each opposing pair below mpv's sum-of-1.0 limit at tiny window sizes", () => {
    // A 300px-tall window squeezes the viewer to a 6px-tall box: raw margins
    // would be top 74/300 + bottom 220/300 = 0.98 > 0.9 — mpv rejects opposing
    // pairs summing to ~1. They must scale down preserving the proportion.
    const m = marginRatiosForBox({ left: 24, top: 74, right: 376, bottom: 80 }, 400, 300);
    expect(m.top + m.bottom).toBeLessThanOrEqual(0.9 + 1e-9);
    expect(m.top / m.bottom).toBeCloseTo(74 / 220, 6);
    // A box partly outside the window clamps instead of going negative.
    const off = marginRatiosForBox({ left: -50, top: 10, right: 500, bottom: 290 }, 400, 300);
    expect(off.left).toBe(0);
    expect(off.right).toBe(0);
  });
});

describe("native engine — filmstrip cell times + frame step (native-002)", () => {
  it("samples cell midpoints exactly like the web generator scan", () => {
    // The web path's targetTime(): ((k + 0.5) / cells) * duration.
    expect(filmstripCellTime(0, 12, 60)).toBeCloseTo(2.5, 9);
    expect(filmstripCellTime(5, 12, 60)).toBeCloseTo(27.5, 9);
    expect(filmstripCellTime(11, 12, 60)).toBeCloseTo(57.5, 9);
  });

  it("yields 0 for unknown/invalid durations (the cell stays a dark slot)", () => {
    expect(filmstripCellTime(3, 12, 0)).toBe(0);
    expect(filmstripCellTime(3, 12, NaN)).toBe(0);
    expect(filmstripCellTime(3, 0, 60)).toBe(0);
  });

  it("steps one frame at the container rate, flooring at 0", () => {
    expect(frameStepTarget(10, 30, true)).toBeCloseTo(10 + 1 / 30, 9);
    expect(frameStepTarget(10, 30, false)).toBeCloseTo(10 - 1 / 30, 9);
    expect(frameStepTarget(0.01, 30, false)).toBe(0);
    // Unknown fps falls back to the app default 30.
    expect(frameStepTarget(10, NaN, true)).toBeCloseTo(10 + 1 / 30, 9);
    expect(frameStepTarget(10, 0, false)).toBeCloseTo(10 - 1 / 30, 9);
  });
});

// ---------------------------------------------------------------------------
// Image viewer transform tools (img-001)
// ---------------------------------------------------------------------------

describe("image transform — geometry basics (img-001)", () => {
  it("starts fit to the window, unzoomed, unrotated, unflipped", () => {
    const t = resetImageTransform();
    expect(t.zoom).toBe(1);
    expect(t.x).toBe(0);
    expect(t.y).toBe(0);
    expect(t.rotation).toBe(0);
    expect(t.flipH).toBe(false);
    expect(t.flipV).toBe(false);
    expect(t.mode).toBe("fit");
  });

  it("swaps width and height for the quarter turns only", () => {
    const nat = { width: 400, height: 300 };
    expect(rotatedSize(nat, 0)).toEqual({ width: 400, height: 300 });
    expect(rotatedSize(nat, 90)).toEqual({ width: 300, height: 400 });
    expect(rotatedSize(nat, 180)).toEqual({ width: 400, height: 300 });
    expect(rotatedSize(nat, 270)).toEqual({ width: 300, height: 400 });
  });

  it("fits by the tighter axis of the ROTATED box", () => {
    // A 400x300 landscape photo in a 200x200 window fits by WIDTH: 200/400.
    expect(fitScale({ width: 400, height: 300 }, { width: 200, height: 200 }, 0)).toBeCloseTo(0.5, 9);
    // Turned 90 degrees it is 300x400 on screen, so it fits by HEIGHT: 200/400.
    // This is the case a naive fitScale gets wrong — it would still say 0.5 by
    // width and overflow the window vertically.
    expect(fitScale({ width: 400, height: 300 }, { width: 200, height: 200 }, 90)).toBeCloseTo(0.5, 9);
    // Make the asymmetry visible: a wide window, where the two answers differ.
    expect(fitScale({ width: 400, height: 200 }, { width: 800, height: 400 }, 0)).toBeCloseTo(1, 9);
    expect(fitScale({ width: 400, height: 200 }, { width: 800, height: 400 }, 90)).toBeCloseTo(1, 9);
    expect(fitScale({ width: 1000, height: 200 }, { width: 800, height: 400 }, 90)).toBeCloseTo(0.4, 9);
  });

  it("never upscales a small picture past 100%, matching the old CSS letterbox", () => {
    // The pre-img-001 rendering was max-width/max-height: 100%, which shrinks a
    // big photo and leaves a small one alone. A 50x50 icon must not be blown up
    // to fill a 1000x800 window.
    expect(fitScale({ width: 50, height: 50 }, { width: 1000, height: 800 }, 0)).toBe(1);
  });

  it("falls back to 100% for degenerate sizes rather than 0 or Infinity", () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 800, height: 600 }, 0)).toBe(1);
    expect(fitScale({ width: 400, height: 300 }, { width: 0, height: 0 }, 0)).toBe(1);
    expect(fitScale({ width: NaN, height: 300 }, { width: 800, height: 600 }, 0)).toBe(1);
  });

  it("reports the on-screen box as the rotated size times the zoom", () => {
    const t = { ...resetImageTransform(), zoom: 2, rotation: 90 as const };
    expect(renderedSize({ width: 400, height: 300 }, t)).toEqual({ width: 600, height: 800 });
  });
});

describe("image transform — zoom ladder and cursor-anchored zoom (img-001)", () => {
  it("clamps a zoom into the usable range and rejects nonsense", () => {
    expect(clampImageZoom(500)).toBe(IMAGE_ZOOM_MAX);
    expect(clampImageZoom(0.0001)).toBe(IMAGE_ZOOM_MIN);
    expect(clampImageZoom(NaN)).toBe(1);
    expect(clampImageZoom(0)).toBe(IMAGE_ZOOM_MIN);
    expect(clampImageZoom(2)).toBe(2);
  });

  it("steps to the next ladder stop, in both directions", () => {
    expect(stepImageZoom(1, 1)).toBeCloseTo(1.5, 9);
    expect(stepImageZoom(1, -1)).toBeCloseTo(0.67, 9);
    expect(stepImageZoom(2, 1)).toBeCloseTo(3, 9);
  });

  it("steps to the nearest stop BEYOND an off-ladder zoom, never back onto itself", () => {
    // Wheel zoom lands anywhere; a following +/- press must still move, and must
    // move in the direction pressed.
    expect(stepImageZoom(0.83, 1)).toBeCloseTo(1, 9);
    expect(stepImageZoom(0.83, -1)).toBeCloseTo(0.67, 9);
    expect(stepImageZoom(2.4, 1)).toBeCloseTo(3, 9);
    expect(stepImageZoom(2.4, -1)).toBeCloseTo(2, 9);
  });

  it("stops at the ends of the ladder instead of running away", () => {
    expect(stepImageZoom(IMAGE_ZOOM_MAX, 1)).toBe(IMAGE_ZOOM_MAX);
    expect(stepImageZoom(IMAGE_ZOOM_MIN, -1)).toBe(IMAGE_ZOOM_MIN);
  });

  it("keeps the point under the cursor under the cursor", () => {
    // 400x300 photo at 100% in an 800x600 viewport: centred, so the picture's
    // centre is at screen (400, 300). The cursor sits 100px to its right.
    const t = { ...resetImageTransform(), zoom: 1 };
    const nat = { width: 400, height: 300 };
    const view = { width: 800, height: 600 };
    const next = zoomImageAt(t, nat, view, 4, { x: 500, y: 300 });
    expect(next.zoom).toBe(4);
    // That image point is now 4 x 100 = 400px right of the picture's centre, so
    // the centre must move to 500 - 400 = screen x 100, i.e. 300px left of the
    // viewport centre.
    expect(next.x).toBeCloseTo(-300, 9);
    expect(next.y).toBeCloseTo(0, 9);
    expect(next.mode).toBe("free");
  });

  it("leaves the pan alone when the cursor is already at the centre", () => {
    const t = { ...resetImageTransform(), zoom: 1 };
    const next = zoomImageAt(t, { width: 400, height: 300 }, { width: 800, height: 600 }, 4, {
      x: 400,
      y: 300,
    });
    expect(next.x).toBeCloseTo(0, 9);
    expect(next.y).toBeCloseTo(0, 9);
  });

  it("re-centres when the zoomed picture no longer overflows the window", () => {
    // Zooming 400x300 to 2x fills an 800x600 viewport EXACTLY. Nothing is hidden,
    // so the cursor-anchored offset must be clamped away rather than leaving the
    // picture off-centre with dead space beside it.
    const t = { ...resetImageTransform(), zoom: 1 };
    const next = zoomImageAt(t, { width: 400, height: 300 }, { width: 800, height: 600 }, 2, {
      x: 500,
      y: 300,
    });
    expect(next.x).toBe(0);
    expect(next.y).toBe(0);
  });

  it("clamps a zoom request into range as it applies it", () => {
    const t = resetImageTransform();
    const next = zoomImageAt(t, { width: 400, height: 300 }, { width: 800, height: 600 }, 9999, {
      x: 400,
      y: 300,
    });
    expect(next.zoom).toBe(IMAGE_ZOOM_MAX);
  });
});

describe("image transform — pan clamping (img-001)", () => {
  const nat = { width: 400, height: 300 };
  const view = { width: 800, height: 600 };

  it("stops the pan at the picture's edge", () => {
    // At 4x the picture is 1600x1200 in an 800x600 window: 400px of slack each
    // way horizontally, 300px vertically.
    const t = { ...resetImageTransform(), zoom: 4, x: 1000, y: 1000, mode: "free" as const };
    const c = clampImagePan(t, nat, view);
    expect(c.x).toBe(400);
    expect(c.y).toBe(300);
    const c2 = clampImagePan({ ...t, x: -1000, y: -1000 }, nat, view);
    expect(c2.x).toBe(-400);
    expect(c2.y).toBe(-300);
  });

  it("leaves a pan that is already inside the slack untouched", () => {
    const t = { ...resetImageTransform(), zoom: 4, x: 120, y: -80, mode: "free" as const };
    const c = clampImagePan(t, nat, view);
    expect(c.x).toBe(120);
    expect(c.y).toBe(-80);
  });

  it("re-centres a picture smaller than the window", () => {
    const t = { ...resetImageTransform(), zoom: 0.5, x: 300, y: 300, mode: "free" as const };
    const c = clampImagePan(t, nat, view);
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
  });

  it("measures the slack against the ROTATED box", () => {
    // Turned 90 degrees at 4x the picture is 1200x1600, so the slack is 200px
    // horizontally and 500px vertically — the opposite shape to the unrotated case.
    const t = {
      ...resetImageTransform(),
      zoom: 4,
      rotation: 90 as const,
      x: 1000,
      y: 1000,
      mode: "free" as const,
    };
    const c = clampImagePan(t, nat, view);
    expect(c.x).toBe(200);
    expect(c.y).toBe(500);
  });

  it("reports panning as possible only when something is actually hidden", () => {
    expect(canPanImage({ ...resetImageTransform(), zoom: 4 }, nat, view)).toBe(true);
    expect(canPanImage({ ...resetImageTransform(), zoom: 0.5 }, nat, view)).toBe(false);
    // Exactly filling the window hides nothing, so the arrow keys must keep
    // navigating to the next photo rather than silently becoming a pan.
    expect(canPanImage({ ...resetImageTransform(), zoom: 2 }, nat, view)).toBe(false);
    // Overflowing in ONE axis is enough.
    expect(canPanImage({ ...resetImageTransform(), zoom: 2.5 }, nat, view)).toBe(true);
  });
});

describe("image transform — rotate, flip and fit (img-001)", () => {
  const wide = { width: 1000, height: 300 };
  const view = { width: 800, height: 600 };

  it("turns by quarters and wraps at both ends", () => {
    const t = resetImageTransform();
    expect(rotateImageBy(t, 90, wide, view).rotation).toBe(90);
    expect(rotateImageBy({ ...t, rotation: 270 }, 90, wide, view).rotation).toBe(0);
    expect(rotateImageBy(t, -90, wide, view).rotation).toBe(270);
    expect(rotateImageBy({ ...t, rotation: 180 }, -90, wide, view).rotation).toBe(90);
  });

  it("re-fits to the turned box while in fit mode", () => {
    // 1000x300 in an 800x600 window fits by width at 0.8. Stood on its end it is
    // 300x1000 and fits by HEIGHT at 0.6. Keeping 0.8 would run it off the top
    // and bottom of the window.
    const fitted = fitImage(resetImageTransform(), wide, view);
    expect(fitted.zoom).toBeCloseTo(0.8, 9);
    const turned = rotateImageBy(fitted, 90, wide, view);
    expect(turned.zoom).toBeCloseTo(0.6, 9);
    expect(turned.mode).toBe("fit");
  });

  it("keeps the user's own zoom when turning outside fit mode", () => {
    const zoomed = { ...resetImageTransform(), zoom: 3, mode: "free" as const };
    expect(rotateImageBy(zoomed, 90, wide, view).zoom).toBe(3);
  });

  it("re-centres when it turns, so the view is never left off in a corner", () => {
    const panned = { ...resetImageTransform(), zoom: 4, x: 300, y: 200, mode: "free" as const };
    const turned = rotateImageBy(panned, 90, wide, view);
    expect(turned.x).toBe(0);
    expect(turned.y).toBe(0);
  });

  it("toggles each mirror independently", () => {
    const t = resetImageTransform();
    expect(flipImage(t, "h").flipH).toBe(true);
    expect(flipImage(t, "h").flipV).toBe(false);
    expect(flipImage(flipImage(t, "h"), "h").flipH).toBe(false);
    expect(flipImage(t, "v").flipV).toBe(true);
    const both = flipImage(flipImage(t, "h"), "v");
    expect(both.flipH).toBe(true);
    expect(both.flipV).toBe(true);
  });

  it("returns to fit centred, keeping rotation and mirrors", () => {
    const messy = {
      ...resetImageTransform(),
      zoom: 7,
      x: 120,
      y: -90,
      rotation: 90 as const,
      flipH: true,
      mode: "free" as const,
    };
    const f = fitImage(messy, wide, view);
    expect(f.zoom).toBeCloseTo(0.6, 9);
    expect(f.x).toBe(0);
    expect(f.y).toBe(0);
    expect(f.mode).toBe("fit");
    expect(f.rotation).toBe(90);
    expect(f.flipH).toBe(true);
  });

  it("clicking a fitted picture goes to 100% under the cursor, and back", () => {
    const fitted = fitImage(resetImageTransform(), wide, view);
    const zoomed = toggleImageFit(fitted, wide, view, { x: 700, y: 300 });
    expect(zoomed.zoom).toBe(1);
    expect(zoomed.mode).toBe("free");
    const back = toggleImageFit(zoomed, wide, view, { x: 700, y: 300 });
    expect(back.zoom).toBeCloseTo(0.8, 9);
    expect(back.mode).toBe("fit");
    expect(back.x).toBe(0);
  });

  it("does nothing on a picture already smaller than the window", () => {
    // Fit and 100% are the same thing for a small picture, so the click has
    // nowhere to go. Recorded deliberately: a no-op, not an accident.
    const small = { width: 120, height: 80 };
    const fitted = fitImage(resetImageTransform(), small, view);
    expect(fitted.zoom).toBe(1);
    const clicked = toggleImageFit(fitted, small, view, { x: 400, y: 300 });
    expect(clicked.zoom).toBe(1);
  });

  it("pans by a delta and stops at the edge", () => {
    const t = { ...resetImageTransform(), zoom: 4, mode: "free" as const };
    // 1000x300 at 4x is 4000x1200 in an 800x600 window: 1600px of horizontal
    // slack, 300px of vertical.
    const moved = panImageBy(t, 200, 100, wide, view);
    expect(moved.x).toBe(200);
    expect(moved.y).toBe(100);
    const pinned = panImageBy(moved, 9999, 9999, wide, view);
    expect(pinned.x).toBe(1600);
    expect(pinned.y).toBe(300);
  });
});

describe("image transform — CSS projection (img-001)", () => {
  it("writes an identity transform for a fresh picture", () => {
    expect(imageTransformCss(resetImageTransform())).toBe(
      "translate(0px, 0px) scale(1) rotate(0deg) scale(1, 1)",
    );
  });

  it("mirrors in IMAGE space: the flip is applied before the rotation", () => {
    // CSS applies a transform list right-to-left, so the mirror sitting LAST in
    // the string is the first thing applied to the picture's own axes. Move it
    // ahead of the rotate and a flipped-then-turned photo mirrors across the
    // screen's axes instead of its own.
    const t = { ...resetImageTransform(), rotation: 90 as const, flipH: true, zoom: 2, x: 10, y: -5 };
    expect(imageTransformCss(t)).toBe(
      "translate(10px, -5px) scale(2) rotate(90deg) scale(-1, 1)",
    );
  });

  it("trims float noise out of the numbers it writes", () => {
    const t = { ...resetImageTransform(), zoom: 0.30000000000000004, x: 1 / 3 };
    expect(imageTransformCss(t)).toBe("translate(0.3333px, 0px) scale(0.3) rotate(0deg) scale(1, 1)");
  });

  it("reads out whole percentages for the toolbar", () => {
    expect(imageZoomPercent({ ...resetImageTransform(), zoom: 1 })).toBe(100);
    expect(imageZoomPercent({ ...resetImageTransform(), zoom: 0.6666 })).toBe(67);
    expect(imageZoomPercent({ ...resetImageTransform(), zoom: 16 })).toBe(1600);
  });
});

describe("image transform — wheel zoom (img-001)", () => {
  it("scrolls up to magnify and down to shrink", () => {
    // A wheel event's deltaY is NEGATIVE scrolling up/away from the user.
    expect(wheelZoomTarget(1, -100)).toBeGreaterThan(1);
    expect(wheelZoomTarget(1, 100)).toBeLessThan(1);
  });

  it("moves by the same ratio at every zoom level", () => {
    // Constant-ratio zoom feels even; a constant ADDITION would crawl at 16x and
    // lurch at 0.1x.
    const up = wheelZoomTarget(1, -100) / 1;
    const upFar = wheelZoomTarget(4, -100) / 4;
    expect(upFar).toBeCloseTo(up, 6);
  });

  it("comes back to where it started after a scroll up and down", () => {
    expect(wheelZoomTarget(wheelZoomTarget(2, -100), 100)).toBeCloseTo(2, 6);
  });

  it("caps one event's jump so a trackpad flick does not slam to the limit", () => {
    // Some trackpads and high-resolution wheels report deltaY in the thousands.
    const huge = wheelZoomTarget(1, -5000);
    expect(huge).toBeLessThanOrEqual(2);
    expect(huge).toBeGreaterThan(1);
  });

  it("stays inside the zoom range and survives a nonsense delta", () => {
    expect(wheelZoomTarget(IMAGE_ZOOM_MAX, -100)).toBe(IMAGE_ZOOM_MAX);
    expect(wheelZoomTarget(IMAGE_ZOOM_MIN, 100)).toBe(IMAGE_ZOOM_MIN);
    expect(wheelZoomTarget(1, NaN)).toBe(1);
    expect(wheelZoomTarget(1, 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Image file actions (img-002)
// ---------------------------------------------------------------------------

describe("image file actions — what Explorer should select (img-002)", () => {
  it("selects the photo itself for an ordinary file", () => {
    expect(revealTargetPath("C:\photos\a.jpg", null)).toBe("C:\photos\a.jpg");
  });

  it("selects the ARCHIVE, not the cache mirror, for a page browsed inside one", () => {
    // A page from a .cbz lives in the thumbnail cache under pb-ar-<hash>. That
    // directory is an implementation detail with a 30-day prune on it — revealing
    // it shows the reader a folder that means nothing and will not be there later.
    // gallery-004 fixed this same class of bug twice; the archive is the artifact.
    const origin = {
      archive: "D:\comics\book.cbz",
      innerDir: "chapter-1",
      mirrorDir: "C:\cache\pb-ar-9f3c",
    };
    expect(revealTargetPath("C:\cache\pb-ar-9f3c\chapter-1\p-1.jpg", origin)).toBe(
      "D:\comics\book.cbz",
    );
  });

  it("falls back to the photo when the origin carries no archive", () => {
    expect(
      revealTargetPath("C:\photos\a.jpg", { archive: "", innerDir: "", mirrorDir: "" }),
    ).toBe("C:\photos\a.jpg");
  });
});

describe("image file actions — file size for the info panel (img-002)", () => {
  it("scales the unit to the size", () => {
    expect(formatFileSize(0)).toBe("0 bytes");
    expect(formatFileSize(1)).toBe("1 byte");
    expect(formatFileSize(842)).toBe("842 bytes");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(3_774_873)).toBe("3.6 MB");
    expect(formatFileSize(5_368_709_120)).toBe("5.0 GB");
  });

  it("does not print a misleading decimal on a whole unit", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1_048_576)).toBe("1.0 MB");
  });

  it("reports nothing rather than NaN for an unknown size", () => {
    expect(formatFileSize(NaN)).toBe("");
    expect(formatFileSize(-5)).toBe("");
  });
});

describe("image file actions — baking orientation into a copy (img-002)", () => {
  // The clipboard copy renders the picture into an offscreen canvas with the
  // rotation and mirroring baked in, so what is pasted matches what is on screen.
  // These matrices are what ctx.setTransform gets before a drawImage at (0, 0).
  const nat = { width: 400, height: 300 };

  it("is the identity for an untouched picture", () => {
    expect(orientationDrawMatrix(nat, 0, false, false)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("carries the top-left corner to the top-right on a quarter turn clockwise", () => {
    // The output canvas is 300x400 (the rotated box). Turned clockwise, the
    // picture's own top-left corner must land at the output's TOP-RIGHT, so the
    // translation is (300, 0).
    expect(orientationDrawMatrix(nat, 90, false, false)).toEqual([0, 1, -1, 0, 300, 0]);
  });

  it("carries it to the bottom-right on a half turn", () => {
    expect(orientationDrawMatrix(nat, 180, false, false)).toEqual([-1, 0, 0, -1, 400, 300]);
  });

  it("mirrors across the picture's own axis, not the screen's", () => {
    // Unrotated, a horizontal mirror sends the top-left corner to the top-right.
    expect(orientationDrawMatrix(nat, 0, true, false)).toEqual([-1, 0, 0, 1, 400, 0]);
    // Vertical sends it to the bottom-left.
    expect(orientationDrawMatrix(nat, 0, false, true)).toEqual([1, 0, 0, -1, 0, 300]);
  });

  it("applies the mirror BEFORE the rotation, matching the on-screen transform", () => {
    // Same order as imageTransformCss: mirror in the picture's own axes, then
    // turn. Composed the other way round the result is mirrored across the wrong
    // axis, and a copied photo would not match the one on screen.
    expect(orientationDrawMatrix(nat, 90, true, false)).toEqual([0, -1, -1, 0, 300, 400]);
  });
});

describe("naturalSortKey", () => {
  // The whole point of the key: sorting BY IT must equal sorting by the
  // comparator, or the tag view's SQL ordering silently disagrees with every
  // other list in the app.
  const NAMES = [
    "clip2.mp4", "clip10.mp4", "clip1.mp4", "Clip2.mp4", "CLIP1.mp4",
    "page03.png", "page3.png", "page30.png",
    "007.jpg", "7.jpg", "70.jpg",
    "a1.jpg", "ab.jpg", "a!.jpg", "a.jpg", "a:.jpg",
    "IMG_20240819123456789.jpg", "IMG_2.jpg",
    "", "1", "z",
    "9".repeat(160) + ".jpg", ":.jpg", "9".repeat(200) + ".jpg", "123.jpg",
    "9".repeat(1000) + ".jpg",
  ];

  it("orders exactly like compareNatural", () => {
    const byKey = [...NAMES].sort((a, b) => {
      const ka = naturalSortKey(a);
      const kb = naturalSortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const byComparator = [...NAMES].sort(compareNatural);
    expect(byKey).toEqual(byComparator);
  });

  it("puts clip2 before clip10 (the reason the key exists)", () => {
    expect(naturalSortKey("clip2.mp4") < naturalSortKey("clip10.mp4")).toBe(true);
  });

  it("keeps a digit run ordered against punctuation the way the comparator does", () => {
    // '!' (0x21) sorts before a digit; ':' (0x3A) sorts after one. The key's
    // length prefix is itself a digit character, which is what preserves this.
    expect(naturalSortKey("a!.jpg") < naturalSortKey("a1.jpg")).toBe(true);
    expect(naturalSortKey("a1.jpg") < naturalSortKey("a:.jpg")).toBe(true);
  });

  it("breaks a case-insensitive tie the same way the comparator does", () => {
    expect(Math.sign(compareNatural("A.jpg", "a.jpg"))).toBe(
      naturalSortKey("A.jpg") < naturalSortKey("a.jpg") ? -1 : 1,
    );
  });

  it("does not emit U+0000, which SQLite string functions treat as a terminator", () => {
    expect(naturalSortKey("clip1.mp4")).not.toContain("\u0000");
  });
});


describe("cleanTagDraft", () => {
  it("splits on commas and trims", () => {
    expect(cleanTagDraft("trip 2024, keep , edit")).toEqual(["trip 2024", "keep", "edit"]);
  });

  it("collapses inner whitespace", () => {
    expect(cleanTagDraft("trip    2024")).toEqual(["trip 2024"]);
  });

  it("drops empty pieces rather than creating blank tags", () => {
    expect(cleanTagDraft(" , ,keep, ")).toEqual(["keep"]);
    expect(cleanTagDraft("   ")).toEqual([]);
  });

  it("de-duplicates case-insensitively within one draft", () => {
    expect(cleanTagDraft("Keep, keep, KEEP")).toEqual(["Keep"]);
  });

  it("caps a pasted monster at MAX_TAG_NAME", () => {
    const out = cleanTagDraft("x".repeat(500));
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(MAX_TAG_NAME);
  });

  it("strips control characters instead of storing them", () => {
    expect(cleanTagDraft("ke\u0001ep")).toEqual(["ke ep"]);
  });
});

describe("tagIdentity", () => {
  it("identifies a plain file by its path, with no archive", () => {
    expect(tagIdentity("C:\\photos\\a.jpg", null)).toEqual({
      archive: "",
      path: "C:\\photos\\a.jpg",
    });
  });

  it("identifies an archive page by the archive plus its INNER path", () => {
    // The materialized mirror path is disposable cache; the identity must be
    // the archive and the path inside it, or the tag dies with the cache.
    const origin = {
      archive: "C:\\comics\\vol1.cbz",
      innerDir: "ch1",
      mirrorDir: "C:\\cache\\pb-ar-abc",
    };
    expect(tagIdentity("C:\\cache\\pb-ar-abc\\page01.jpg", origin)).toEqual({
      archive: "C:\\comics\\vol1.cbz",
      path: "ch1/page01.jpg",
    });
  });

  it("handles a page at the archive root (no inner directory)", () => {
    const origin = {
      archive: "C:\\comics\\vol1.cbz",
      innerDir: "",
      mirrorDir: "C:\\cache\\pb-ar-abc",
    };
    expect(tagIdentity("C:\\cache\\pb-ar-abc\\page01.jpg", origin)).toEqual({
      archive: "C:\\comics\\vol1.cbz",
      path: "page01.jpg",
    });
  });
});

describe("tag page arithmetic", () => {
  it("maps an absolute index to the page holding it", () => {
    expect(pageForIndex(0, 500)).toBe(0);
    expect(pageForIndex(499, 500)).toBe(0);
    expect(pageForIndex(500, 500)).toBe(1);
    expect(pageForIndex(1234, 500)).toBe(2);
  });

  it("treats a negative index as the first page rather than throwing", () => {
    // The grid's cursor is -1 until a tile is focused, and that value reaches
    // here through the sibling-navigation path.
    expect(pageForIndex(-1, 500)).toBe(0);
  });

  it("clips the last page to the total", () => {
    expect(pageRange(0, 500, 1200)).toEqual({ offset: 0, limit: 500 });
    expect(pageRange(2, 500, 1200)).toEqual({ offset: 1000, limit: 200 });
  });

  it("returns an empty range for a page past the end", () => {
    expect(pageRange(9, 500, 1200)).toEqual({ offset: 4500, limit: 0 });
  });

  it("formats the tag header's count with a thousands separator", () => {
    expect(tagMeta(0)).toBe("No items");
    expect(tagMeta(1)).toBe("1 item");
    expect(tagMeta(1248)).toBe("1,248 items");
  });
});

describe("windowBounds", () => {
  it("covers the whole list when it fits", () => {
    expect(windowBounds(800, 0, 1500)).toEqual({ start: 0, end: 800 });
  });

  it("centres the window on the focused index", () => {
    expect(windowBounds(40000, 20000, 1500)).toEqual({ start: 19250, end: 20750 });
  });

  it("clamps at the start without shrinking", () => {
    expect(windowBounds(40000, 10, 1500)).toEqual({ start: 0, end: 1500 });
  });

  it("clamps at the end without shrinking", () => {
    expect(windowBounds(40000, 39990, 1500)).toEqual({ start: 38500, end: 40000 });
  });

  it("treats an unset cursor as the top of the list", () => {
    expect(windowBounds(40000, -1, 1500)).toEqual({ start: 0, end: 1500 });
  });

  it("rounds the half-window down on an odd window size", () => {
    // 1501 is odd: floor gives 750, ceil would give 751 and shift the window.
    expect(windowBounds(40000, 20000, 1501)).toEqual({ start: 19250, end: 20751 });
  });

  it("clamps at the end when only one row of slack exists", () => {
    // total - windowSize is 1, so an off-by-one in the clamp cannot hide.
    expect(windowBounds(1501, 1500, 1500)).toEqual({ start: 1, end: 1501 });
  });

  it("starts sliding exactly when the focus clears the half-window", () => {
    expect(windowBounds(40000, 750, 1500)).toEqual({ start: 0, end: 1500 });
    expect(windowBounds(40000, 751, 1500)).toEqual({ start: 1, end: 1501 });
  });
});

// --- perf-009: which tile the thumbnail pipeline renders next --------------

describe("nextThumbFillBatch", () => {
  it("walks outward from the focus so the fill spreads from what is on screen", () => {
    // Ascending candidates, focus in the middle: nearest first, alternating
    // below/above rather than restarting at index 0.
    expect(nextThumbFillBatch([0, 1, 2, 3, 4, 5, 6], 3, 5)).toEqual([3, 2, 4, 1, 5]);
  });

  it("takes only what the batch allows", () => {
    expect(nextThumbFillBatch([10, 11, 12, 13], 10, 2)).toEqual([10, 11]);
  });

  it("returns everything when the batch is larger than the candidates", () => {
    expect(nextThumbFillBatch([7, 8], 7, 99)).toEqual([7, 8]);
  });

  it("is empty when nothing is left to fill", () => {
    expect(nextThumbFillBatch([], 5, 10)).toEqual([]);
  });

  it("works when the focus is below every candidate", () => {
    // A tag window scrolled far in: every loaded tile sits above the cursor.
    expect(nextThumbFillBatch([100, 101, 102], 0, 2)).toEqual([100, 101]);
  });

  it("works when the focus is above every candidate", () => {
    expect(nextThumbFillBatch([100, 101, 102], 999, 2)).toEqual([102, 101]);
  });

  it("skips gaps left by tiles that already have a thumbnail", () => {
    // The candidate list is only the tiles still needing one, so the walk must
    // not assume they are contiguous — it orders by DISTANCE, not by which
    // side of the focus a tile happens to sit on. 0 is 9 away and 20 is 11, so
    // 0 comes first even though it means going back up past a filled gap.
    expect(nextThumbFillBatch([0, 5, 9, 20], 9, 3)).toEqual([9, 5, 0]);
  });
});

// --- perf-010: which QUEUED tile the pipeline picks up next ----------------
//
// nextThumbFillBatch above decides what to ENQUEUE, in outward order from the
// focus at that moment. This decides what to DEQUEUE, and it only earns its
// keep when the focus has MOVED since that batch was enqueued — then the queue
// is in outward order from a viewport the user has already left.
//
// perf-009 built this helper, measured it to change nothing, and deleted it. It
// is back because the measurement that closed the question has been re-run at
// four times the per-thumbnail cost and no longer holds: see that feature's
// note, which named this exact condition as the one that would re-open it.

describe("nearestQueuedThumb", () => {
  it("picks the queued tile closest to the focus, not the oldest", () => {
    // The shape of a stale background batch (761..809, enqueued when the
    // viewport was there) with the tile the user is now looking at appended
    // behind it by the IntersectionObserver.
    expect(nearestQueuedThumb([761, 762, 763, 1980], 1980)).toBe(3);
  });

  it("is a plain FIFO when the focus is where the queue was built", () => {
    // The settled case, and the common one: an outward batch already in the
    // right order must not be reshuffled. Index 0 is the head.
    expect(nearestQueuedThumb([50, 49, 51, 48, 52], 50)).toBe(0);
  });

  it("returns -1 for an empty queue", () => {
    expect(nearestQueuedThumb([], 7)).toBe(-1);
  });

  it("breaks a tie toward the tile that has waited longer", () => {
    // 8 and 12 are both 2 away from 10. The earlier entry wins, so the queue
    // still drains in a stable order rather than oscillating.
    expect(nearestQueuedThumb([12, 8], 10)).toBe(0);
    expect(nearestQueuedThumb([8, 12], 10)).toBe(0);
  });

  it("handles a focus below and above everything queued", () => {
    expect(nearestQueuedThumb([100, 101, 102], 0)).toBe(0);
    expect(nearestQueuedThumb([100, 101, 102], 999)).toBe(2);
  });
});

describe("img-003 delete confirmation", () => {
  describe("deleteArmKey", () => {
    it("distinguishes a file on disk from a page inside an archive", () => {
      expect(deleteArmKey("", "C:\\pics\\a.jpg")).not.toBe(
        deleteArmKey("C:\\pics\\book.cbz", "C:\\pics\\a.jpg"),
      );
    });

    it("is stable for the same identity", () => {
      expect(deleteArmKey("", "C:\\pics\\a.jpg")).toBe(deleteArmKey("", "C:\\pics\\a.jpg"));
    });
  });

  describe("isArmedFor", () => {
    const key = deleteArmKey("", "C:\\pics\\a.jpg");

    it("is not armed when nothing has been pressed", () => {
      expect(isArmedFor(null, key, 1000)).toBe(false);
    });

    it("is armed for the same file within the window", () => {
      const arm = armDelete(key, 1000, DELETE_ARM_MS);
      expect(isArmedFor(arm, key, 1000 + DELETE_ARM_MS - 1)).toBe(true);
    });

    it("disarms once the window has passed", () => {
      const arm = armDelete(key, 1000, DELETE_ARM_MS);
      expect(isArmedFor(arm, key, 1000 + DELETE_ARM_MS)).toBe(false);
    });

    // This is the whole reason the arm is keyed rather than a bare boolean:
    // arming on one photo and pressing Del on the NEXT one must not delete it.
    it("is not armed for a different file, however recently it was armed", () => {
      const arm = armDelete(key, 1000, DELETE_ARM_MS);
      const other = deleteArmKey("", "C:\\pics\\b.jpg");
      expect(isArmedFor(arm, other, 1001)).toBe(false);
    });
  });

  describe("indexAfterDelete", () => {
    it("stays put in the middle, so the next photo slides in under the cursor", () => {
      expect(indexAfterDelete(1, 3)).toBe(1);
    });

    it("steps back when the last item was deleted", () => {
      expect(indexAfterDelete(2, 3)).toBe(1);
    });

    it("stays at the front when the first was deleted", () => {
      expect(indexAfterDelete(0, 3)).toBe(0);
    });

    it("reports an empty queue when the only item was deleted", () => {
      expect(indexAfterDelete(0, 1)).toBe(-1);
    });
  });

  describe("deleteButtonText", () => {
    it("names the action when unarmed and does not threaten a file", () => {
      const t = deleteButtonText(false, "a.jpg");
      expect(t.title).toBe("Delete (Del)");
      expect(t.label).toBe("Delete a.jpg — moves it to the Recycle Bin");
    });

    // The armed state must be legible to a screen reader on the control
    // itself: the .imgview__flash toast that announced it fades after 1.4s
    // while the arm lasts 5s, exactly as pruneButtonText documents.
    it("says what a second press will do once armed", () => {
      const t = deleteButtonText(true, "a.jpg");
      expect(t.title).toBe("Press again to delete a.jpg");
      expect(t.label).toBe("Press again to move a.jpg to the Recycle Bin");
    });
  });
});

describe("tags-003 blacklist filter", () => {
  // Rust builds these strings (tags.rs hidden_keys) and is the authority on the
  // format; these fixtures mirror exactly what it returns.
  const hidden = new Set([
    "\u0000C:\\pics\\a.jpg",
    "C:\\pics\\book.cbz\u0000page1.jpg",
  ]);

  describe("hiddenKey", () => {
    it("matches the key Rust builds for a real file", () => {
      expect(hiddenKey("", "C:\\pics\\a.jpg")).toBe("\u0000C:\\pics\\a.jpg");
    });

    it("matches the key Rust builds for a page inside an archive", () => {
      expect(hiddenKey("C:\\pics\\book.cbz", "page1.jpg")).toBe(
        "C:\\pics\\book.cbz\u0000page1.jpg",
      );
    });

    // A real file whose path happens to spell out an archive identity must not
    // collide with the archive page. NUL cannot occur in a path, which is why.
    it("cannot collide an archive page with a real file", () => {
      expect(hiddenKey("", "C:\\pics\\book.cbzpage1.jpg")).not.toBe(
        hiddenKey("C:\\pics\\book.cbz", "page1.jpg"),
      );
    });
  });

  describe("isHidden", () => {
    it("hides a blacklisted real file", () => {
      expect(isHidden({ path: "C:\\pics\\a.jpg" }, hidden)).toBe(true);
    });

    it("hides a blacklisted archive page", () => {
      expect(
        isHidden({ archive: "C:\\pics\\book.cbz", path: "page1.jpg" }, hidden),
      ).toBe(true);
    });

    it("leaves anything not on the list alone", () => {
      expect(isHidden({ path: "C:\\pics\\b.jpg" }, hidden)).toBe(false);
    });

    // An item with no `archive` field at all is an ordinary file (a recent, a
    // queue entry) — it must key the same as one with archive: "".
    it("treats a missing archive field as an empty one", () => {
      expect(isHidden({ path: "C:\\pics\\a.jpg" }, hidden)).toBe(
        isHidden({ archive: "", path: "C:\\pics\\a.jpg" }, hidden),
      );
    });

    it("hides nothing when the blacklist is empty", () => {
      expect(isHidden({ path: "C:\\pics\\a.jpg" }, new Set())).toBe(false);
    });
  });

  describe("filterBlacklisted", () => {
    it("drops hidden items and keeps the rest in order", () => {
      const items = [
        { path: "C:\\pics\\a.jpg", name: "a" },
        { path: "C:\\pics\\b.jpg", name: "b" },
        { path: "C:\\pics\\c.jpg", name: "c" },
      ];
      expect(filterBlacklisted(items, hidden).map((i) => i.name)).toEqual(["b", "c"]);
    });

    it("returns the list untouched when nothing is blacklisted", () => {
      const items = [{ path: "C:\\pics\\a.jpg" }, { path: "C:\\pics\\b.jpg" }];
      expect(filterBlacklisted(items, new Set())).toHaveLength(2);
    });

    it("survives an empty list", () => {
      expect(filterBlacklisted([], hidden)).toEqual([]);
    });

    it("keeps the caller's element type intact", () => {
      const items = [{ path: "C:\\pics\\b.jpg", kind: "image" as const, extra: 7 }];
      const out = filterBlacklisted(items, hidden);
      expect(out[0].extra).toBe(7);
      expect(out[0].kind).toBe("image");
    });
  });

  // Live re-filter of an OPEN folder/archive grid, after the hidden set changes
  // under it (a blacklisted tag applied or removed while the grid is up). The
  // grid used to be filtered once at load, so a tile tagged with a blacklisted
  // tag stayed on screen until the folder was reopened.
  describe("reviseGrid", () => {
    const a = { path: "/pics/a.jpg", name: "a" };
    const b = { path: "/pics/b.jpg", name: "b" };
    const c = { path: "/pics/c.jpg", name: "c" };
    const listing = [a, b, c];
    const names = (xs: { name: string }[]) => xs.map((x) => x.name);
    const hiding = (...paths: string[]) => new Set(paths.map((p) => hiddenKey("", p)));

    it("reports no change and hands back the grid as it is when nothing new is hidden", () => {
      const shown = [a, b, c];
      const r = reviseGrid(listing, new Set(), shown, 1);
      expect(r.changed).toBe(false);
      expect(r.items).toBe(shown);
      expect(r.cursor).toBe(1);
    });

    it("drops a tile that just became hidden", () => {
      const r = reviseGrid(listing, hiding("/pics/b.jpg"), [a, b, c], -1);
      expect(r.changed).toBe(true);
      expect(names(r.items)).toEqual(["a", "c"]);
    });

    it("keeps the cursor on its own tile when an earlier tile is hidden", () => {
      // cursor on c (index 2); a goes -> c is now index 1
      const r = reviseGrid(listing, hiding("/pics/a.jpg"), [a, b, c], 2);
      expect(r.cursor).toBe(1);
    });

    it("leaves the cursor alone when a later tile is hidden", () => {
      const r = reviseGrid(listing, hiding("/pics/c.jpg"), [a, b, c], 0);
      expect(r.cursor).toBe(0);
    });

    it("lands the cursor on the tile that slid into its hidden tile's place", () => {
      // cursor on b (1); b goes -> c slides into index 1, exactly where a delete lands
      const r = reviseGrid(listing, hiding("/pics/b.jpg"), [a, b, c], 1);
      expect(names(r.items)).toEqual(["a", "c"]);
      expect(r.cursor).toBe(1);
    });

    it("lands the cursor on the new last tile when its hidden tile was last", () => {
      const r = reviseGrid(listing, hiding("/pics/c.jpg"), [a, b, c], 2);
      expect(r.cursor).toBe(1);
    });

    it("clears the cursor when every tile is hidden", () => {
      const r = reviseGrid(listing, hiding("/pics/a.jpg", "/pics/b.jpg", "/pics/c.jpg"), [a, b, c], 1);
      expect(r.changed).toBe(true);
      expect(r.items).toEqual([]);
      expect(r.cursor).toBe(-1);
    });

    it("keeps a cleared cursor cleared", () => {
      const r = reviseGrid(listing, hiding("/pics/a.jpg"), [a, b, c], -1);
      expect(r.cursor).toBe(-1);
    });

    it("brings a tile back, in listing order, once it is no longer hidden", () => {
      // b was hidden when the grid loaded; its blacklisted tag has since been
      // removed. Cursor on c (index 1 of what was shown) follows c to index 2.
      const r = reviseGrid(listing, new Set(), [a, c], 1);
      expect(r.changed).toBe(true);
      expect(names(r.items)).toEqual(["a", "b", "c"]);
      expect(r.cursor).toBe(2);
    });

    it("compares tiles by identity key, never by object reference", () => {
      // The grid holds reactive proxies of the listing's objects, so reference
      // equality is exactly what a live grid cannot offer.
      const copies = listing.map((x) => ({ ...x }));
      expect(reviseGrid(listing, new Set(), copies, 0).changed).toBe(false);
    });

    it("hands back the listing's own objects, not copies", () => {
      const r = reviseGrid(listing, hiding("/pics/a.jpg"), [a, b, c], -1);
      expect(r.items[0]).toBe(b);
    });
  });

  // gallery-005: the listing itself changing under an open grid — files added,
  // removed or replaced outside the app. Surviving items must keep their OWN
  // objects so a rendered thumbnail is not thrown away; on a 1,999-photo folder
  // re-rendering everything for one added file is seconds of churn.
  describe("mergeListing", () => {
    const item = (name: string, thumb = "") => ({
      path: `/pics/${name}`,
      name,
      thumbSrc: thumb,
      archive: "",
    });
    const names = (xs: { name: string }[]) => xs.map((x) => x.name);
    const none = new Set<string>();

    it("reports no change and hands back the listing as it is when disk matches", () => {
      const a = item("a.jpg", "asset://a");
      const b = item("b.jpg", "asset://b");
      const current = [a, b];
      const r = mergeListing(current, [item("a.jpg"), item("b.jpg")], none);
      expect(r.changed).toBe(false);
      expect(r.listing).toBe(current);
    });

    it("keeps a surviving item's own object, so its thumbnail survives", () => {
      const a = item("a.jpg", "asset://a");
      const r = mergeListing([a], [item("a.jpg"), item("b.jpg")], none);
      expect(r.changed).toBe(true);
      expect(r.listing[0]).toBe(a);
      expect(r.listing[0].thumbSrc).toBe("asset://a");
    });

    it("adds a file that appeared, in the fresh listing's order", () => {
      const a = item("a.jpg", "asset://a");
      const c = item("c.jpg", "asset://c");
      const r = mergeListing([a, c], [item("a.jpg"), item("b.jpg"), item("c.jpg")], none);
      expect(names(r.listing)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
      expect(r.listing[1].thumbSrc).toBe(""); // the new one has no picture yet
    });

    it("drops a file that disappeared", () => {
      const a = item("a.jpg", "asset://a");
      const b = item("b.jpg", "asset://b");
      const r = mergeListing([a, b], [item("a.jpg")], none);
      expect(r.changed).toBe(true);
      expect(names(r.listing)).toEqual(["a.jpg"]);
    });

    it("takes order from the fresh listing, never from the current one", () => {
      const a = item("a.jpg", "asset://a");
      const b = item("b.jpg", "asset://b");
      const r = mergeListing([b, a], [item("a.jpg"), item("b.jpg")], none);
      expect(names(r.listing)).toEqual(["a.jpg", "b.jpg"]);
      expect(r.changed).toBe(true);
    });

    it("replaces a touched item, so a file rewritten in place loses its stale picture", () => {
      // The thumb DISK cache is keyed on path+size+mtime so it re-renders, but
      // the in-memory thumbSrc is keyed on path alone — without `touched` this
      // file would keep showing the previous picture.
      const a = item("a.jpg", "asset://a-old");
      const r = mergeListing([a], [item("a.jpg")], new Set(["/pics/a.jpg"]));
      expect(r.changed).toBe(true);
      expect(r.listing[0]).not.toBe(a);
      expect(r.listing[0].thumbSrc).toBe("");
    });

    it("ignores a touched path that is no longer in the folder", () => {
      // REVIEW FOCUS 4: created then deleted inside one quiet window.
      const a = item("a.jpg", "asset://a");
      const r = mergeListing([a], [item("a.jpg")], new Set(["/pics/ghost.jpg"]));
      expect(r.changed).toBe(false);
      expect(r.listing[0]).toBe(a);
    });

    it("handles an emptied folder", () => {
      const r = mergeListing([item("a.jpg", "asset://a")], [], none);
      expect(r.changed).toBe(true);
      expect(r.listing).toEqual([]);
    });

    it("handles a folder that was empty and now is not", () => {
      const r = mergeListing([], [item("a.jpg")], none);
      expect(r.changed).toBe(true);
      expect(names(r.listing)).toEqual(["a.jpg"]);
    });

    it("keys items by archive as well as path", () => {
      // Two archives can hold the same inner path; they are different items.
      const inner = { path: "p/1.jpg", name: "1.jpg", thumbSrc: "t", archive: "/a.cbz" };
      const fresh = { path: "p/1.jpg", name: "1.jpg", thumbSrc: "", archive: "/b.cbz" };
      const r = mergeListing([inner], [fresh], none);
      expect(r.changed).toBe(true);
      expect(r.listing[0]).toBe(fresh);
    });
  });
});

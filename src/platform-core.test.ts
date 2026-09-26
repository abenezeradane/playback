import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DESKTOP_FEATURES,
  parseFeatures,
  visibleActions,
  storageCards,
  backAction,
  withTimeout,
  imageToolPages,
  imageToolPageFor,
  tapOnlyRevealsChrome,
  type PlatformFeatures,
} from "./platform-core";

const PHONE: PlatformFeatures = {
  mobile: true,
  nativeEngine: false,
  sidecar: false,
  recycle: false,
  reveal: false,
  clipboardImage: false,
  storageVolumes: true,
};

describe("parseFeatures", () => {
  it("accepts a complete record from the native side", () => {
    expect(parseFeatures({ ...PHONE })).toEqual(PHONE);
  });

  it("falls back to desktop when nothing was injected (a browser, vitest)", () => {
    expect(parseFeatures(undefined)).toEqual(DESKTOP_FEATURES);
    expect(parseFeatures(null)).toEqual(DESKTOP_FEATURES);
    expect(parseFeatures("mobile")).toEqual(DESKTOP_FEATURES);
  });

  it("falls back to desktop wholesale when any key is missing or mistyped, never a mix", () => {
    const partial: Partial<PlatformFeatures> = { ...PHONE };
    delete partial.storageVolumes;
    expect(parseFeatures(partial)).toEqual(DESKTOP_FEATURES);
    expect(parseFeatures({ ...PHONE, recycle: "no" })).toEqual(DESKTOP_FEATURES);
  });

  it("ignores unknown keys", () => {
    expect(parseFeatures({ ...PHONE, somethingNew: true })).toEqual(PHONE);
  });

  it("returns a fresh object, never the frozen default itself", () => {
    expect(parseFeatures(undefined)).not.toBe(DESKTOP_FEATURES);
  });

  // The exact record Rust's init script hands a phone (pinned by
  // the_init_script_hands_the_page_a_frozen_camel_case_record in
  // src-tauri/src/platform.rs). A key added on one side only must fail here,
  // not silently turn a phone back into a desktop.
  const RUST_PHONE_RECORD =
    '{"mobile":true,"nativeEngine":false,"sidecar":false,"recycle":false,"reveal":false,"clipboardImage":false,"storageVolumes":true}';

  it("reads the record Rust injects on a phone as the phone, key for key", () => {
    const parsed = parseFeatures(JSON.parse(RUST_PHONE_RECORD));
    expect(parsed).toEqual(PHONE);
    expect(JSON.stringify(parsed)).toBe(RUST_PHONE_RECORD);
  });
});

describe("visibleActions", () => {
  it("shows every desktop control on a desktop build, and no Storage row", () => {
    expect(visibleActions(DESKTOP_FEATURES)).toEqual({
      delete: true,
      reveal: true,
      copyImage: true,
      engineSetting: true,
      hwaccelSetting: true,
      settings: true,
      shortcuts: true,
      fullscreen: true,
      openDialogs: true,
      storageRow: false,
    });
  });

  it("renders no dead control on a phone, and a Storage row instead of the pickers", () => {
    expect(visibleActions(PHONE)).toEqual({
      delete: false,
      reveal: false,
      copyImage: false,
      engineSetting: false,
      hwaccelSetting: false,
      settings: false,
      shortcuts: false,
      fullscreen: false,
      openDialogs: false,
      storageRow: true,
    });
  });

  it("brings the engine, hardware-acceleration and Settings rows back once a phone has the native engine", () => {
    const a = visibleActions({ ...PHONE, nativeEngine: true });
    expect([a.engineSetting, a.hwaccelSetting, a.settings]).toEqual([true, true, true]);
    expect(a.shortcuts).toBe(false);
    expect(a.fullscreen).toBe(false);
  });

  it("keeps hardware acceleration on a desktop without the native engine (it drives WebView2)", () => {
    const a = visibleActions({ ...DESKTOP_FEATURES, nativeEngine: false });
    expect([a.engineSetting, a.hwaccelSetting, a.settings]).toEqual([false, true, true]);
  });
});

describe("storageCards", () => {
  it("puts internal storage first, then removable volumes by name", () => {
    const cards = storageCards([
      { label: "USB drive", path: "/storage/AAAA-1111", removable: true },
      { label: "Internal shared storage", path: "/storage/emulated/0", removable: false },
      { label: "SD card", path: "/storage/1A2B-3C4D", removable: true },
    ]);
    expect(cards.map((c) => c.label)).toEqual(["Internal shared storage", "SD card", "USB drive"]);
  });

  it("drops a volume with no path and collapses duplicate paths", () => {
    const cards = storageCards([
      { label: "Internal shared storage", path: "/storage/emulated/0", removable: false },
      { label: "Internal again", path: "/storage/emulated/0", removable: false },
      { label: "Ghost", path: "", removable: true },
    ]);
    expect(cards).toEqual([{ label: "Internal shared storage", path: "/storage/emulated/0", removable: false }]);
  });

  it("gives a blank label a plain name instead of an empty card", () => {
    const cards = storageCards([
      { label: "  ", path: "/storage/emulated/0", removable: false },
      { label: "", path: "/storage/1A2B-3C4D", removable: true },
    ]);
    expect(cards.map((c) => c.label)).toEqual(["Internal storage", "Removable storage"]);
  });

  it("is empty for no volumes", () => {
    expect(storageCards([])).toEqual([]);
  });
});

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles with the call's own value when it answers in time", async () => {
    vi.useFakeTimers();
    const call = withTimeout(Promise.resolve({ granted: true }), 8000);
    await expect(call).resolves.toEqual({ granted: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the call's own failure through when it fails in time", async () => {
    vi.useFakeTimers();
    const call = withTimeout(Promise.reject(new Error("host said no")), 8000);
    await expect(call).rejects.toThrow("host said no");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up on a call that never answers once the time is up, not before", async () => {
    vi.useFakeTimers();
    let settled = false;
    const call = withTimeout(new Promise<never>(() => {}), 8000);
    const outcome = call.then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("timed out after 8000 ms");
  });
});

describe("backAction", () => {
  it("closes an open layer before anything else, in every view", () => {
    for (const view of ["empty", "gallery", "image", "playing"]) {
      expect(backAction(view, true)).toBe("close-layer");
    }
  });

  it("steps back through the journey from gallery, photo and player", () => {
    for (const view of ["gallery", "image", "playing", "live-unavailable"]) {
      expect(backAction(view, false)).toBe("step");
    }
  });

  it("backgrounds the app at Home instead of finishing it", () => {
    expect(backAction("empty", false)).toBe("background");
  });

  it("backgrounds from the storage gate, which has nowhere to go back to", () => {
    expect(backAction("storage-gate", false)).toBe("background");
    expect(backAction("storage-gate", true)).toBe("background");
  });
});

describe("imageToolPages", () => {
  it("gives a still picture zoom, then rotate and flip, then info and tags", () => {
    expect(imageToolPages("static")).toEqual(["zoom", "orient", "file"]);
  });

  it("puts an animation's playback controls first", () => {
    expect(imageToolPages("animated")).toEqual(["playback", "zoom", "orient", "file"]);
  });

  it("has no playback page for a picture the WebView draws itself (a JPEG, a GIF it animates)", () => {
    expect(imageToolPages("native")).toEqual(["zoom", "orient", "file"]);
  });

  it("has no pages while loading or after an error, when there is no toolbar", () => {
    expect(imageToolPages("loading")).toEqual([]);
    expect(imageToolPages("error")).toEqual([]);
  });
});

describe("imageToolPageFor", () => {
  const STILL = imageToolPages("static");
  const ANIMATED = imageToolPages("animated");

  it("opens on the first page until one has been chosen", () => {
    expect(imageToolPageFor(null, STILL)).toBe("zoom");
    expect(imageToolPageFor(null, ANIMATED)).toBe("playback");
  });

  it("keeps the chosen page for every picture that has it", () => {
    expect(imageToolPageFor("orient", STILL)).toBe("orient");
    expect(imageToolPageFor("orient", ANIMATED)).toBe("orient");
    expect(imageToolPageFor("file", STILL)).toBe("file");
  });

  it("falls back to the first page when this picture lacks the chosen one", () => {
    expect(imageToolPageFor("playback", STILL)).toBe("zoom");
  });

  it("has no page when there is no toolbar", () => {
    expect(imageToolPageFor("orient", [])).toBeNull();
    expect(imageToolPageFor(null, [])).toBeNull();
  });
});

describe("tapOnlyRevealsChrome", () => {
  it("a touch on a picture whose chrome has faded only brings the chrome back", () => {
    expect(tapOnlyRevealsChrome("touch", true)).toBe(true);
    expect(tapOnlyRevealsChrome("pen", true)).toBe(true);
  });

  it("a touch while the chrome is showing does its usual job", () => {
    expect(tapOnlyRevealsChrome("touch", false)).toBe(false);
    expect(tapOnlyRevealsChrome("pen", false)).toBe(false);
  });

  it("a mouse click never does: desktop behaviour is unchanged", () => {
    expect(tapOnlyRevealsChrome("mouse", true)).toBe(false);
    expect(tapOnlyRevealsChrome("mouse", false)).toBe(false);
  });
});

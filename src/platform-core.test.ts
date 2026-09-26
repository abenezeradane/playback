import { describe, it, expect } from "vitest";
import {
  DESKTOP_FEATURES,
  parseFeatures,
  visibleActions,
  storageCards,
  backAction,
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
      openDialogs: false,
      storageRow: true,
    });
  });

  it("brings the engine, hardware-acceleration and Settings rows back once a phone has the native engine", () => {
    const a = visibleActions({ ...PHONE, nativeEngine: true });
    expect([a.engineSetting, a.hwaccelSetting, a.settings]).toEqual([true, true, true]);
    expect(a.shortcuts).toBe(false);
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

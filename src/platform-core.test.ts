import { describe, it, expect } from "vitest";
import {
  DESKTOP_FEATURES,
  parseFeatures,
  visibleActions,
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

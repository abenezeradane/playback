/**
 * platform-core.ts — pure decisions about what this build of Playback can do
 * and how a phone behaves (android-001). No DOM, no Tauri: every function here
 * is unit-tested in platform-core.test.ts.
 */

/** Compile-time capabilities, mirroring Rust's `PlatformFeatures` (camelCase). */
export interface PlatformFeatures {
  mobile: boolean;
  nativeEngine: boolean;
  sidecar: boolean;
  recycle: boolean;
  reveal: boolean;
  clipboardImage: boolean;
  storageVolumes: boolean;
}

/** What a Windows desktop build reports. Also the fallback when nothing was
 *  injected, so desktop behaviour never depends on the injection working. */
export const DESKTOP_FEATURES: Readonly<PlatformFeatures> = Object.freeze({
  mobile: false,
  nativeEngine: true,
  sidecar: true,
  recycle: true,
  reveal: true,
  clipboardImage: true,
  storageVolumes: false,
});

const FEATURE_KEYS = Object.keys(DESKTOP_FEATURES) as (keyof PlatformFeatures)[];

/** Validate the injected `window.__PLAYBACK_FEATURES__`. Anything malformed
 *  falls back to desktop wholesale, never a mix, so a half-broken injection can
 *  never hide controls on a desktop build. */
export function parseFeatures(raw: unknown): PlatformFeatures {
  if (!raw || typeof raw !== "object") return { ...DESKTOP_FEATURES };
  const record = raw as Record<string, unknown>;
  if (FEATURE_KEYS.some((k) => typeof record[k] !== "boolean")) return { ...DESKTOP_FEATURES };
  const out = { ...DESKTOP_FEATURES };
  for (const k of FEATURE_KEYS) out[k] = record[k] as boolean;
  return out;
}

/** Which controls exist on this build. A control whose capability is missing
 *  is not rendered at all: no dead buttons (android-001). */
export interface VisibleActions {
  /** Viewer + grid delete, and a tag's Delete-all. */
  delete: boolean;
  reveal: boolean;
  copyImage: boolean;
  engineSetting: boolean;
  hwaccelSetting: boolean;
  /** The Settings button, which only exists when it has a row to show. */
  settings: boolean;
  /** The keyboard-shortcuts button and overlay. */
  shortcuts: boolean;
  /** The Fullscreen buttons and the F / double-click toggle. A phone's window
   *  cannot go fullscreen (the Android window backend ignores the request). */
  fullscreen: boolean;
  /** The native pickers: Open file, Gallery, the drop zone hero, a playlist's
   *  Add videos. */
  openDialogs: boolean;
  /** Home's Storage row of volume cards. */
  storageRow: boolean;
}

export function visibleActions(f: PlatformFeatures): VisibleActions {
  const engineSetting = f.nativeEngine;
  // Desktop: the toggle drives WebView2's decode flag even with no engine. A
  // phone: it only means something once there is an mpv hwdec to toggle.
  const hwaccelSetting = !f.mobile || f.nativeEngine;
  return {
    delete: f.recycle,
    reveal: f.reveal,
    copyImage: f.clipboardImage,
    engineSetting,
    hwaccelSetting,
    settings: engineSetting || hwaccelSetting,
    shortcuts: !f.mobile,
    fullscreen: !f.mobile,
    openDialogs: !f.storageVolumes,
    storageRow: f.storageVolumes,
  };
}

/** How long a call to the Android host may take before the page stops waiting
 *  for it. Only for the quick checks (access, volumes): never for the access
 *  request, where the user may sit in system Settings for minutes. */
export const HOST_CALL_TIMEOUT_MS = 8000;

/** Settle as `call` does, or reject once `ms` pass without an answer, so a host
 *  call that never settles cannot leave a screen waiting forever. */
export function withTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    call.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** A storage volume as the Android host reports it. */
export interface StorageVolume {
  label: string;
  path: string;
  removable: boolean;
}

/** One card in Home's Storage row. */
export type StorageCard = StorageVolume;

/** Home's Storage cards: internal storage first, then removable volumes by
 *  name. A volume without a path is dropped, duplicate paths collapse to the
 *  first, and a blank label gets a plain name rather than an empty card. */
export function storageCards(volumes: readonly StorageVolume[]): StorageCard[] {
  const seen = new Set<string>();
  const cards: StorageCard[] = [];
  for (const v of volumes) {
    if (!v.path || seen.has(v.path)) continue;
    seen.add(v.path);
    const label = v.label.trim() || (v.removable ? "Removable storage" : "Internal storage");
    cards.push({ label, path: v.path, removable: v.removable });
  }
  return cards.sort(
    (a, b) => Number(a.removable) - Number(b.removable) || a.label.localeCompare(b.label),
  );
}

/** What the Android Back gesture does (android-001). */
export type BackAction = "close-layer" | "step" | "background";

/** Layers (panels, popovers, prompts) close first, in the order Esc closes them
 *  on desktop. Then Back walks the ux-001 journey. At Home, and on the storage
 *  gate, which has nowhere to go back to, it sends the app to the background
 *  rather than finishing it, so coming back is not a cold start. */
export function backAction(view: string, layerOpen: boolean): BackAction {
  if (view === "storage-gate") return "background";
  if (layerOpen) return "close-layer";
  if (view === "empty") return "background";
  return "step";
}

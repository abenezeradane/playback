/**
 * perf.ts — opt-in runtime performance tracing (perf-004).
 *
 * The app ships this INERT. Tracing turns on only when the native side reports a
 * sink (the `PLAYBACK_PERF_LOG` env var names a file); until then every entry
 * point below is a single boolean test — no timers, no allocation, no IPC — so
 * normal launches pay nothing.
 *
 * What it records:
 *   * `span(name)` / `mark(name)` — phase timings the controller brackets around
 *     opening, closing, and view switches (the paths users report as slow).
 *   * every Tauri IPC command, timed at the `tauriInvoke` funnel, so a slow open
 *     can be attributed to a specific native command rather than guessed at.
 *   * main-thread jank: `longtask` entries (>50 ms blocks) and per-frame deltas
 *     sampled from rAF, which is how paint/compositing cost (e.g. backdrop-filter
 *     over a transparent window) shows up — it never appears in IPC timings.
 *
 * Records buffer in memory and flush to the native sink on a short timer, so
 * tracing itself stays off the measured path as much as practical.
 */

interface PerfRecord {
  /** ms since navigation start, when the event ENDED */
  t: number;
  kind: "span" | "mark" | "ipc" | "longtask" | "frame";
  name: string;
  /** duration in ms (absent for marks) */
  ms?: number;
  detail?: string;
}

let enabled = false;
let buffer: PerfRecord[] = [];
let flushTimer = 0;

/** True once the native sink is known to exist. Cheap to call in hot paths. */
export function perfEnabled(): boolean {
  return enabled;
}

/**
 * Ask the native side whether tracing is on, and if so start the jank samplers.
 * Called once from the controller's init; failure (not under Tauri) leaves
 * tracing off.
 */
export async function initPerf(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    enabled = (await invoke<boolean>("perf_enabled", {})) === true;
  } catch {
    enabled = false;
  }
  if (!enabled) return;
  observeLongTasks();
  sampleFrames();
  mark("perf.start", navigator.userAgent);
}

/** Record a zero-duration event. */
export function mark(name: string, detail?: string): void {
  if (!enabled) return;
  push({ t: performance.now(), kind: "mark", name, detail });
}

/**
 * Start timing a phase. Returns the closer — call it when the phase ends.
 * The returned function is safe to call when tracing is off (it is a no-op).
 */
export function span(name: string): (detail?: string) => void {
  if (!enabled) return () => {};
  const started = performance.now();
  return (detail?: string) => {
    const now = performance.now();
    push({ t: now, kind: "span", name, ms: now - started, detail });
  };
}

/** Record one completed IPC command. Called from the `tauriInvoke` funnel. */
export function recordIpc(cmd: string, ms: number, failed: boolean): void {
  if (!enabled) return;
  push({ t: performance.now(), kind: "ipc", name: cmd, ms, detail: failed ? "error" : undefined });
}

/**
 * Main-thread blocks over 50 ms. These are what a user feels as "the UI froze";
 * they are invisible to IPC timing because the stall is in script/layout/paint.
 */
function observeLongTasks(): void {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        push({ t: e.startTime + e.duration, kind: "longtask", name: "longtask", ms: e.duration });
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* longtask unsupported — frame sampling still catches sustained jank */
  }
}

/**
 * Per-frame deltas. A healthy compositor holds ~16.7 ms; sustained higher deltas
 * while nothing is animating point at paint cost (blur/transparency), not script.
 * Only frames slower than 32 ms (a dropped frame) are recorded, to keep the log
 * small and the sampler itself cheap.
 */
function sampleFrames(): void {
  let prev = performance.now();
  const tick = (now: number): void => {
    const dt = now - prev;
    prev = now;
    if (dt > 32) push({ t: now, kind: "frame", name: "slowframe", ms: dt });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function push(rec: PerfRecord): void {
  buffer.push(rec);
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    void flush();
  }, 250);
}

/** Ship the buffered records to the native sink. */
export async function flush(): Promise<void> {
  if (!enabled || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("perf_log", { lines: batch.map((r) => JSON.stringify(r)) });
  } catch {
    /* sink went away — drop the batch rather than grow unboundedly */
  }
}

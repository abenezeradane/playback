/**
 * engine-native.ts — the native (embedded libmpv) playback engine adapter
 * (native-001).
 *
 * `NativeEngine` impersonates the exact HTMLVideoElement member subset the
 * controller touches (`EngineSurface`), so the controller's module-level
 * `video` variable can point at either the real element (web engine) or this
 * adapter (native engine) with the command helpers unchanged. Reads are served
 * synchronously from a local snapshot; writes update the snapshot optimistically
 * (so the very next `syncFromVideo()` sees them, exactly like the element) and
 * fire-and-forget the Tauri invoke.
 *
 * All DECISION logic — stale-event dropping (loadSeq guard), the ended latch,
 * seek coalescing — lives in pure, vitest-covered functions in player-core.ts;
 * this file is the impure shell (invokes, listeners, timers). The Rust side of
 * the contract is docs/native-engine-ipc.md.
 */
import {
  createEngineSnapshot,
  applyPlayerEvent,
  createSeekCoalescer,
  seekRequest,
  seekSettle,
  seekTimedOut,
  volumeToMpv,
  SEEK_MIN_INTERVAL_MS,
  ZERO_MARGINS,
  type EngineSnapshot,
  type MarginRatios,
  type NativePlayerEvent,
  type SeekCoalescer,
} from "../player-core";

/** Minimal TimeRanges stand-in (native local playback has no buffer ranges). */
export interface TimeRangesLike {
  readonly length: number;
  end(i: number): number;
}

/**
 * The HTMLVideoElement member subset controller.ts actually uses (derived by
 * exhaustive audit of `video.` accesses). HTMLVideoElement is structurally
 * assignable to this, so the controller's `video` var can hold either engine.
 */
export interface EngineSurface {
  readonly paused: boolean;
  readonly ended: boolean;
  currentTime: number;
  readonly duration: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  loop: boolean;
  readonly buffered: TimeRangesLike;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly readyState: number;
  src: string;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
}

/** Controller callbacks — the element-event handlers, re-fired by the adapter. */
export interface EngineCallbacks {
  onLoadedMetadata: () => void;
  onTimeUpdate: () => void;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  /** endFile reason=error (or a spontaneous engine shutdown mid-file). */
  onEngineError: (message: string) => void;
  /** First frame of the CURRENT load presented — flips the video hole open. */
  onPresented: () => void;
}

const NO_RANGES: TimeRangesLike = { length: 0, end: () => 0 };

/** How often the watchdog sweeps an unsettled seek (see SEEK_WATCHDOG_MS). */
const SEEK_WATCHDOG_SWEEP_MS = 250;

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export class NativeEngine implements EngineSurface {
  private snap: EngineSnapshot = createEngineSnapshot();
  private coalescer: SeekCoalescer = createSeekCoalescer();
  private callbacks: EngineCallbacks;
  private invoke: InvokeFn | null = null;
  private unlisten: (() => void) | null = null;
  // Write-only mirrors (the app is the single writer of these — no echo needed).
  private volume0 = 1;
  private muted0 = false;
  private rate0 = 1;
  private loop0 = false;
  private margins0: MarginRatios = ZERO_MARGINS;
  private seekExact = true;
  /** Events that arrived while player_load was still awaiting its loadSeq. */
  private preloadQueue: NativePlayerEvent[] = [];
  private awaitingLoad = false;
  /** Fires onPresented exactly once per load (the video-hole gate). */
  private presentedThisLoad = false;
  private watchdogTimer: number | undefined;

  constructor(callbacks: EngineCallbacks) {
    this.callbacks = callbacks;
  }

  /** Wire the Tauri IPC (call once; safe to await before first use). */
  async init(): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    this.invoke = invoke as InvokeFn;
    this.unlisten = await listen<NativePlayerEvent>("player-event", (e) => {
      this.onEvent(e.payload);
    });
  }

  /** Detach the event listener (the adapter is app-lifetime; used by tests/HMR). */
  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  // --- Event pump -----------------------------------------------------------

  private onEvent(ev: NativePlayerEvent): void {
    if (this.awaitingLoad && ev.kind !== "shutdown") {
      // player_load hasn't returned its loadSeq yet — park events; they are
      // replayed (and seq-filtered) as soon as the seq is known.
      this.preloadQueue.push(ev);
      return;
    }
    this.apply(ev);
  }

  private apply(ev: NativePlayerEvent): void {
    const { snapshot, effects, errorMessage } = applyPlayerEvent(this.snap, ev);
    this.snap = snapshot;
    for (const effect of effects) {
      switch (effect) {
        case "loadedmetadata":
          this.callbacks.onLoadedMetadata();
          break;
        case "timeupdate":
          this.callbacks.onTimeUpdate();
          break;
        case "play":
          this.callbacks.onPlay();
          break;
        case "pause":
          this.callbacks.onPause();
          break;
        case "ended":
          this.callbacks.onEnded();
          break;
        case "seekSettled": {
          if (!this.presentedThisLoad) {
            this.presentedThisLoad = true;
            this.callbacks.onPresented();
          }
          const { coalescer, issue } = seekSettle(this.coalescer, performance.now());
          this.coalescer = coalescer;
          if (issue !== null) this.issueSeek(issue);
          break;
        }
        case "error":
          this.callbacks.onEngineError(errorMessage ?? "playback failed");
          break;
        case "shutdown":
          // The core died. Reset locally; the controller falls back to the
          // web engine for the current file.
          this.coalescer = createSeekCoalescer();
          this.callbacks.onEngineError("the native engine stopped");
          break;
      }
    }
  }

  // --- Loading / teardown ----------------------------------------------------

  /** Load a media file by RAW filesystem path (no asset URL, no remux). */
  async loadPath(path: string): Promise<void> {
    this.snap = { ...createEngineSnapshot() };
    this.coalescer = createSeekCoalescer();
    this.presentedThisLoad = false;
    this.awaitingLoad = true;
    this.preloadQueue = [];
    try {
      const seq = (await this.mustInvoke("player_load", { path })) as number;
      this.snap = { ...this.snap, loadSeq: seq };
    } finally {
      this.awaitingLoad = false;
    }
    // Replay anything that raced the invoke round-trip (seq-filtered inside).
    const queued = this.preloadQueue;
    this.preloadQueue = [];
    for (const ev of queued) this.apply(ev);
    // Push the app's current audio/rate/loop state onto the fresh load.
    this.applyAudioState();
  }

  /** Stop playback and idle the engine (blanks the native video child). */
  stop(): void {
    this.snap = { ...createEngineSnapshot() };
    this.coalescer = createSeekCoalescer();
    this.presentedThisLoad = false;
    void this.tryInvoke("player_stop", {});
  }

  private applyAudioState(): void {
    void this.tryInvoke("player_set_volume", { volume: volumeToMpv(this.volume0) });
    void this.tryInvoke("player_set_mute", { mute: this.muted0 });
    void this.tryInvoke("player_set_speed", { speed: this.rate0 });
    void this.tryInvoke("player_set_loop_file", { on: this.loop0 });
    // Margins are properties of the mpv core, not the load — but the core is
    // created lazily and can be reaped/re-created, so re-push the mirror after
    // every load exactly like the audio state (keeps the cut-view letterbox
    // if a load happens while the timeline view is open).
    void this.tryInvoke("player_set_video_margin_ratio", { ...this.margins0 });
  }

  // --- Extra (non-element) controls used by new controller code --------------

  /** True when the engine reported the container's frame rate. */
  get containerFps(): number | null {
    return this.snap.containerFps;
  }

  /** Runtime hardware-decode switch (Settings hwaccel toggle, no restart). */
  setHwdec(on: boolean): void {
    void this.tryInvoke("player_set_hwdec", { on });
  }

  /**
   * Seek precision for subsequent currentTime writes: "exact" (frame-exact
   * hr-seek — scrub commits, chapter jumps) or "fast" (keyframe — the reverse
   * shuttle's high-rate stepping).
   */
  setSeekPrecision(mode: "exact" | "fast"): void {
    this.seekExact = mode === "exact";
  }

  /**
   * Letterbox the natively-rendered video into a sub-box of the window (the
   * cut-view viewer, native-002) via mpv video-margin-ratio; ZERO_MARGINS
   * restores the full-window video. Mirrored and re-pushed after every load.
   */
  setVideoMarginRatio(margins: MarginRatios): void {
    this.margins0 = margins;
    void this.tryInvoke("player_set_video_margin_ratio", { ...margins });
  }

  /**
   * Step exactly one video frame (mpv frame-step/frame-back-step, native-002).
   * mpv pauses on completion; the echoed pause + throttle-reset time events
   * bring the snapshot up to date (no optimistic time write — the step size is
   * a decoder fact the adapter cannot know). A back step from the very end is
   * a step AWAY from it, so it clears the element-parity ended latch (mirrors
   * how any element seek-back clears `ended` on the web engine); a target
   * parked in the seek coalescer is dropped — the step is the newer intent,
   * and re-issuing the stale target afterwards would visibly undo the step.
   */
  frameStep(back: boolean): void {
    this.coalescer = { ...this.coalescer, pending: null };
    this.snap = { ...this.snap, paused: true, ended: back ? false : this.snap.ended };
    void this.tryInvoke("player_frame_step", { back });
  }

  // --- EngineSurface ----------------------------------------------------------

  get paused(): boolean {
    return this.snap.paused;
  }

  get ended(): boolean {
    return this.snap.ended;
  }

  get currentTime(): number {
    return this.snap.currentTime;
  }

  set currentTime(t: number) {
    const target = Math.max(0, Number.isFinite(t) ? t : 0);
    const awayFromEnd = this.snap.duration > 0 && target < this.snap.duration - 0.25;
    this.snap = {
      ...this.snap,
      currentTime: target,
      seekInFlight: true,
      ended: this.snap.ended && !awayFromEnd,
    };
    const { coalescer, issue } = seekRequest(this.coalescer, target, performance.now());
    this.coalescer = coalescer;
    if (issue !== null) this.issueSeek(issue);
    this.armWatchdog();
  }

  get duration(): number {
    return this.snap.duration;
  }

  get volume(): number {
    return this.volume0;
  }

  set volume(v: number) {
    this.volume0 = Math.min(1, Math.max(0, v));
    void this.tryInvoke("player_set_volume", { volume: volumeToMpv(this.volume0) });
  }

  get muted(): boolean {
    return this.muted0;
  }

  set muted(m: boolean) {
    this.muted0 = m;
    void this.tryInvoke("player_set_mute", { mute: m });
  }

  get playbackRate(): number {
    return this.rate0;
  }

  set playbackRate(r: number) {
    this.rate0 = r;
    void this.tryInvoke("player_set_speed", { speed: r });
  }

  get loop(): boolean {
    return this.loop0;
  }

  set loop(on: boolean) {
    this.loop0 = on;
    void this.tryInvoke("player_set_loop_file", { on });
  }

  get buffered(): TimeRangesLike {
    return NO_RANGES; // native local playback: render() skips the buffered bar
  }

  get videoWidth(): number {
    return this.snap.width;
  }

  get videoHeight(): number {
    return this.snap.height;
  }

  get readyState(): number {
    return this.snap.loaded ? 4 : 0;
  }

  // src is never used on the native path (loadPath takes the raw file path);
  // the setter exists only for interface compatibility.
  get src(): string {
    return "";
  }

  set src(_v: string) {
    /* no-op — native loads go through loadPath */
  }

  play(): Promise<void> {
    if (this.snap.ended) {
      // HTML parity: play() on an ended element restarts from the beginning
      // (this is what makes replay-after-end and single-item repeat work).
      this.currentTime = 0;
      this.snap = { ...this.snap, ended: false };
    }
    this.snap = { ...this.snap, paused: false };
    void this.tryInvoke("player_set_pause", { paused: false });
    return Promise.resolve();
  }

  pause(): void {
    this.snap = { ...this.snap, paused: true };
    void this.tryInvoke("player_set_pause", { paused: true });
  }

  load(): void {
    /* no-op — the element uses load() to (re)parse src; natives have none */
  }

  removeAttribute(name: string): void {
    // The controller's teardown idiom is pause() + removeAttribute("src") +
    // load(); map the src removal onto a native stop.
    if (name === "src") this.stop();
  }

  // --- Internals ---------------------------------------------------------------

  private issueSeek(target: number): void {
    void this.mustInvoke("player_seek", { position: target, exact: this.seekExact }).catch(() => {
      // A rejected seek (e.g. during load, unseekable stream) settles the
      // coalescer so later seeks aren't wedged behind it.
      const { coalescer, issue } = seekSettle(this.coalescer, performance.now());
      this.coalescer = coalescer;
      if (issue !== null) this.issueSeek(issue);
    });
    this.armWatchdog();
  }

  /**
   * Sweep for (a) a seek whose playbackRestart never came (failed/ignored)
   * and (b) a target parked by the rate floor while NOTHING was in flight —
   * without this second case a seek requested within SEEK_MIN_INTERVAL_MS of
   * the previous one's settle would sit as `pending` forever: seekSettle only
   * runs on restart/rejection of an IN-FLIGHT seek, freezing the time display
   * (seekInFlight latched), the A-B loop-back, and the final scrub commit
   * (found by the native-001 code review).
   */
  private armWatchdog(): void {
    if (this.watchdogTimer !== undefined) return;
    this.watchdogTimer = window.setTimeout(() => {
      this.watchdogTimer = undefined;
      const now = performance.now();
      const idleParked =
        !this.coalescer.inFlight &&
        this.coalescer.pending !== null &&
        now - this.coalescer.lastIssuedAt >= SEEK_MIN_INTERVAL_MS;
      if (seekTimedOut(this.coalescer, now) || idleParked) {
        if (!idleParked) this.snap = { ...this.snap, seekInFlight: false };
        const { coalescer, issue } = seekSettle(this.coalescer, now);
        this.coalescer = coalescer;
        if (issue !== null) this.issueSeek(issue);
      }
      if (this.coalescer.inFlight || this.coalescer.pending !== null) {
        this.armWatchdog();
      }
    }, SEEK_WATCHDOG_SWEEP_MS);
  }

  private mustInvoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.invoke) return Promise.reject(new Error("engine not initialized"));
    return this.invoke(cmd, args);
  }

  private tryInvoke(cmd: string, args: Record<string, unknown>): Promise<void> {
    return this.mustInvoke(cmd, args).then(
      () => undefined,
      () => undefined, // property writes are best-effort; errors surface via events
    );
  }
}

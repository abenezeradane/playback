<script lang="ts">
  import { ui, els } from "./state.svelte";
  import ChaptersPanel from "./ChaptersPanel.svelte";
  import QueuePanel from "./QueuePanel.svelte";
  import NextPrompt from "./NextPrompt.svelte";
  import CutView from "./CutView.svelte";
  import {
    goHome,
    onVideoClick,
    onLoadedMetadata,
    onTimeUpdate,
    onProgress,
    onPlay,
    onPause,
    onVolumeChange,
    onEnded,
    onStageMouseMove,
    onStageMouseLeave,
    doToggleMute,
    doSetVolume,
    doSkip,
    doTogglePlay,
    doCycleRate,
    toggleLoop,
    toggleAbA,
    toggleAbB,
    toggleCutMode,
    togglePanel,
    toggleQueue,
    doPrevItem,
    doNextItem,
    toggleShortcuts,
    toggleMore,
    requestControlsMeasure,
    doTogglePip,
    doToggleFullscreen,
    previewSeek,
    commitSeek,
    jumpToTimestamp,
  } from "./controller";
  import { markerFraction, formatTime } from "../player-core";

  // Re-check whether the control bars fit whenever the present button set (queue
  // prev/next/queue, PiP), the speed-pill text, the cut-view fps label, or the
  // active view/mode changes. Width changes are handled by a ResizeObserver in the
  // controller. The ⋯ menu then shows only when controls would actually overflow —
  // on both the standard player bar and the timeline-view transport (ui-005).
  $effect(() => {
    void ui.view;
    void ui.cutMode;
    void ui.queue.length;
    void ui.pipSupported;
    void ui.rate;
    void ui.fpsLabel;
    requestControlsMeasure();
  });
</script>

<!-- ===================== PLAYER STAGE (frames 02 / 03 / 04) ===================== -->
<main
  id="stage"
  class="stage"
  data-chrome={ui.chromeVisible ? "shown" : "hidden"}
  data-idle={ui.idle}
  hidden={ui.view !== "playing"}
  onmousemove={onStageMouseMove}
  onmouseleave={onStageMouseLeave}
>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    id="video"
    class="video"
    playsinline
    bind:this={els.video}
    onclick={onVideoClick}
    onloadedmetadata={onLoadedMetadata}
    ontimeupdate={onTimeUpdate}
    onprogress={onProgress}
    onplay={onPlay}
    onpause={onPause}
    onvolumechange={onVolumeChange}
    onended={onEnded}
  ></video>

  <!-- Native-engine video surface (native-001). When the libmpv engine presents
       (mpv's child HWND paints BELOW the transparent WebView), this permanent div
       replaces the <video> as the geometry + click surface: same .video class so
       every layout rule applies, same click handler (single = play/pause, double
       = fullscreen). Permanently rendered — visibility is CSS-keyed on the
       .app[data-native-video] flag, never a Svelte conditional, so it cannot
       stall on the rAF-gated flush when the window isn't foreground. -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div id="video-surface" class="video video--native" role="presentation" onclick={onVideoClick}></div>

  <div class="scrim scrim--top" aria-hidden="true"></div>
  <div class="scrim scrim--bottom" aria-hidden="true"></div>

  <!-- Top overlay: back + title -->
  <div class="overlay-top" data-tauri-drag-region>
    <button id="btn-back" class="glass-btn" type="button" title="Back to library" onclick={goHome}>
      <svg class="ic" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
    </button>
    <div class="overlay-top__title">
      <div class="overlay-top__heading">
        <span id="title-label" class="title-main">{ui.title}</span>
      </div>
      <span id="subtitle-label" class="title-sub">{ui.subtitle}</span>
    </div>
  </div>

  <!-- Big center play/pause flash -->
  <div id="center-toggle" class="center-toggle" data-playing={ui.isPlaying} data-flash={ui.centerFlash} aria-hidden="true">
    <svg class="ic ic--fill ic-play" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4" /></svg>
    <svg class="ic ic--fill ic-pause" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
  </div>

  <!-- Transient toast shown when jumping (A / D / click) -->
  <div id="marker-flash" class="toast" data-flash={ui.markerFlash} aria-live="polite">
    <span class="toast__icon" aria-hidden="true">
      <svg class="ic" viewBox="0 0 24 24"><path d="m6 17 5-5-5-5" /><path d="m13 17 5-5-5-5" /></svg>
    </span>
    <span class="toast__body">
      <span class="toast__label">JUMPED TO</span>
      <span id="marker-flash-text" class="toast__text">{ui.markerFlashText}</span>
    </span>
  </div>

  <!-- Current chapter (play-002): the active timestamp. Lives outside #controls
       so the "always show" setting can keep it pinned to the bottom-left corner
       even when the rest of the chrome auto-hides. -->
  <div id="now-chapter" class="now-chapter" aria-live="polite" data-pinned={ui.pinChapter} hidden={!ui.nowChapter}>
    <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12H3" /><path d="M16 6H3" /><path d="M12 18H3" /><path d="m16 12 5 3-5 3z" /></svg>
    <span id="now-chapter-time" class="now-chapter__time">{ui.nowChapter?.time ?? ""}</span>
    <span id="now-chapter-label" class="now-chapter__label">{ui.nowChapter?.label ?? ""}</span>
  </div>

  <!-- Bottom control bar. data-collapse (0/1/2) is owned imperatively by the
       controller's measurement (controller.ts measureControlsOverflow), NOT bound
       here, so the collapse applies synchronously and never lags the async render
       flush. Default 0 = everything inline until the first measure. -->
  <div id="controls" class="controls" data-visible={ui.chromeVisible} data-collapse="0">
    <!-- Scrubber -->
    <div class="scrubber">
      <div class="scrubber__track" aria-hidden="true">
        <div id="buffered" class="scrubber__buffered" style:width="{ui.bufferedPct}%"></div>
        <div id="progress" class="scrubber__progress" style:width="{ui.progressPct}%"></div>
      </div>
      <!-- A-B section-loop region + flags (play-011), drawn beneath the chapter ticks. -->
      <div id="ab-markers" class="scrubber__ab" aria-hidden="true">
        {#each ui.abMarkers as m}
          {#if m.kind === "region"}
            <div class="ab-region" style:left="{m.left}%" style:width="{m.width}%"></div>
          {:else}
            <div class="ab-flag" data-label={m.label} style:left="{m.left}%"></div>
          {/if}
        {/each}
      </div>
      <!-- Timestamp markers (play-002). -->
      <div id="markers" class="scrubber__markers">
        {#each ui.timestamps as ts, i (ts.time + " " + ts.title)}
          <button
            type="button"
            class="marker"
            style:left="{markerFraction(ts.time, ui.duration) * 100}%"
            title="{formatTime(ts.time)} — {ts.title}"
            data-active={i === ui.activeTsIndex ? "true" : undefined}
            onclick={(e) => { e.stopPropagation(); jumpToTimestamp(ts); }}
          >
            <span class="marker__label">{formatTime(ts.time)}  {ts.title}</span>
          </button>
        {/each}
      </div>
      <input
        id="seek"
        class="scrubber__range"
        type="range"
        min="0"
        max="1000"
        value={ui.seekValue}
        step="1"
        aria-label="Seek"
        oninput={(e) => previewSeek(Number(e.currentTarget.value))}
        onchange={(e) => commitSeek(Number(e.currentTarget.value))}
      />
    </div>

    <!-- Controls row: left (transport · volume · time) · center · right (actions) -->
    <div class="controls__row">
      <div class="controls__left">
        <button id="btn-mute" class="iconbtn iconbtn--sm" type="button" data-muted={ui.muted0} title="Mute (M)" onclick={doToggleMute}>
          <svg class="ic ic-vol" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></svg>
          <svg class="ic ic-muted" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="22" x2="16" y1="9" y2="15" /><line x1="16" x2="22" y1="9" y2="15" /></svg>
        </button>
        <input id="volume" class="volume__range" type="range" min="0" max="100" value={ui.volumeValue} step="1" aria-label="Volume" oninput={(e) => doSetVolume(Number(e.currentTarget.value))} />
        <div id="time" class="timerow"><span class="t-cur">{ui.curText}</span><span class="t-sep">/</span><span class="t-tot">{ui.totText}</span></div>
      </div>

      <div class="controls__center">
        <!-- Previous video in the folder queue (play-013); shown only for a real queue. -->
        <button id="btn-prev-item" class="iconbtn iconbtn--sm" type="button" title="Previous video ([)" hidden={ui.queue.length <= 1} onclick={doPrevItem}>
          <svg class="ic" viewBox="0 0 24 24"><path d="m11 17-5-5 5-5" /><path d="m18 17-5-5 5-5" /></svg>
        </button>
        <button id="btn-rewind" class="iconbtn" type="button" title="Back 10s (←)" onclick={() => doSkip(false)}>
          <svg class="ic" viewBox="0 0 24 24"><polygon points="19 20 9 12 19 4 19 20" /><line x1="5" x2="5" y1="19" y2="5" /></svg>
        </button>
        <button id="btn-play" class="iconbtn iconbtn--primary" type="button" data-playing={ui.isPlaying} title="Play / Pause (Space)" onclick={doTogglePlay}>
          <svg class="ic ic--fill ic-play" viewBox="0 0 24 24"><polygon points="7 4 20 12 7 20 7 4" /></svg>
          <svg class="ic ic--fill ic-pause" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
        </button>
        <button id="btn-forward" class="iconbtn" type="button" title="Forward 10s (→)" onclick={() => doSkip(true)}>
          <svg class="ic" viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4" /><line x1="19" x2="19" y1="5" y2="19" /></svg>
        </button>
        <!-- Next video in the folder queue (play-013); shown only for a real queue. -->
        <button id="btn-next-item" class="iconbtn iconbtn--sm" type="button" title="Next video (])" hidden={ui.queue.length <= 1} onclick={doNextItem}>
          <svg class="ic" viewBox="0 0 24 24"><path d="m6 17 5-5-5-5" /><path d="m13 17 5-5-5-5" /></svg>
        </button>
      </div>

      <div class="controls__right">
        <!-- Overflow "More" toggle (ui-005): shown only when the bar is too narrow
             to fit every control. Opens the .controls__more popover below. -->
        <button
          id="btn-more"
          class="iconbtn iconbtn--sm controls__more-toggle"
          type="button"
          title="More controls"
          aria-haspopup="menu"
          aria-expanded={ui.moreOpen}
          aria-pressed={ui.moreOpen}
          onclick={toggleMore}
        >
          <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
        </button>

        <!-- Secondary tools. On a wide bar these flow inline (display:contents);
             when space runs short they relocate into the ⋯ popover (ui-005) so
             they can never overlap the centered transport. -->
        <div id="controls-more" class="controls__more" data-open={ui.moreOpen} role="menu" aria-label="More controls">
          <button id="btn-rate" class="pill pill--ghost pill--sm" type="button" title="Playback speed" onclick={doCycleRate}>
            <svg class="ic ic--more-only" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></svg>
            <span class="iconbtn__more-label">Playback speed</span>
            <span class="rate-val">{ui.rate}&times;</span>
          </button>
          <!-- Loop / repeat (play-011): whole-clip loop toggle + A-B in-/out-point buttons. -->
          <button id="btn-loop-a" class="iconbtn iconbtn--sm loopbtn loopbtn--ab" type="button" title="Set / clear A-B loop in point (I)" aria-pressed={ui.abA !== null} onclick={toggleAbA}><span class="loopbtn__glyph">A</span><span class="iconbtn__more-label">A-B loop · set in (I)</span></button>
          <button id="btn-loop-b" class="iconbtn iconbtn--sm loopbtn loopbtn--ab" type="button" title="Set / clear A-B loop out point (B)" aria-pressed={ui.abB !== null} onclick={toggleAbB}><span class="loopbtn__glyph">B</span><span class="iconbtn__more-label">A-B loop · set out (B)</span></button>
          <button id="btn-loop" class="iconbtn iconbtn--sm" type="button" title="Loop (R)" aria-pressed={ui.loopOn} onclick={toggleLoop}>
            <svg class="ic" viewBox="0 0 24 24"><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></svg>
            <span class="iconbtn__more-label">Loop (R)</span>
          </button>
          <button id="btn-cut" class="iconbtn iconbtn--sm" type="button" title="Timeline view (C)" aria-pressed={ui.cutMode} onclick={toggleCutMode}>
            <svg class="ic" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M7 3v18" /><path d="M3 7.5h4" /><path d="M3 12h18" /><path d="M3 16.5h4" /><path d="M17 3v18" /><path d="M17 7.5h4" /><path d="M17 16.5h4" /></svg>
            <span class="iconbtn__more-label">Timeline view (C)</span>
          </button>
          <!-- Picture-in-picture (play-015). Hidden when the WebView can't do PiP. -->
          <button id="btn-pip" class="iconbtn iconbtn--sm" type="button" title="Picture-in-picture (P)" aria-pressed={ui.pipActive} hidden={!ui.pipSupported} onclick={() => void doTogglePip()}>
            <svg class="ic" viewBox="0 0 24 24"><path d="M21 9V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /><rect width="10" height="7" x="12" y="13" rx="2" /></svg>
            <span class="iconbtn__more-label">Picture-in-picture (P)</span>
          </button>
          <button id="btn-keys" class="iconbtn iconbtn--sm" type="button" title="Keyboard shortcuts (?)" onclick={toggleShortcuts}>
            <svg class="ic" viewBox="0 0 24 24"><rect width="20" height="16" x="2" y="4" rx="2" /><path d="M6 8h.01" /><path d="M10 8h.01" /><path d="M14 8h.01" /><path d="M18 8h.01" /><path d="M8 12h.01" /><path d="M12 12h.01" /><path d="M16 12h.01" /><path d="M7 16h10" /></svg>
            <span class="iconbtn__more-label">Keyboard shortcuts (?)</span>
          </button>
        </div>

        <button id="btn-timestamps" class="iconbtn iconbtn--sm" type="button" title="Chapters (T)" aria-pressed={ui.panelOpen} onclick={togglePanel}>
          <svg class="ic" viewBox="0 0 24 24"><path d="M12 12H3" /><path d="M16 6H3" /><path d="M12 18H3" /><path d="m16 12 5 3-5 3z" /></svg>
        </button>
        <!-- Folder queue / playlist (play-013); shown only when the folder has >1 video. -->
        <button id="btn-queue" class="iconbtn iconbtn--sm" type="button" title="Queue (Q)" aria-pressed={ui.queueOpen} hidden={ui.queue.length <= 1} onclick={toggleQueue}>
          <svg class="ic" viewBox="0 0 24 24"><line x1="10" x2="21" y1="6" y2="6" /><line x1="10" x2="21" y1="12" y2="12" /><line x1="10" x2="21" y1="18" y2="18" /><path d="M4 6h1v4" /><path d="M4 10h2" /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" /></svg>
        </button>
        <button id="btn-fs" class="iconbtn iconbtn--sm" type="button" title="Fullscreen (F)" onclick={() => void doToggleFullscreen()}>
          <svg class="ic" viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
        </button>
      </div>
    </div>
  </div>

  <ChaptersPanel />

  <QueuePanel />

  <NextPrompt />

  <CutView />
</main>

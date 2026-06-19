<script lang="ts">
  import { ui, els } from "./state.svelte";
  import {
    goHome,
    setCutMode,
    toggleShortcuts,
    doToggleFullscreen,
    doJumpStart,
    doShuttleReverse,
    cutPlayPause,
    doShuttleForward,
    doJumpEnd,
    toggleLoop,
    doCycleRate,
    doToggleMute,
    doSetVolume,
    toggleMore,
    cutPointerDown,
    cutPointerMove,
    cutPointerUp,
  } from "./controller";
</script>

<!-- ===================== TIMELINE / CUT VIEW (frame 02b) ===================== -->
<!-- An editorial review surface layered over the player (play-004). The same
     #video sits in the central viewer (positioned via CSS in cut mode); this
     adds the app bar and the bottom Timeline Deck + transport. -->
<section id="cut" class="cut" data-loop={ui.loopOn} data-shuttle="stopped" hidden={!ui.cutMode}>
  <!-- (transport collapse level is set imperatively on .cut__transport by the
       controller's measurement — see measureControlsOverflow, ui-005) -->
  <!-- App bar -->
  <header class="cut__appbar" data-tauri-drag-region>
    <button id="cut-back" class="glass-btn" type="button" title="Back to library" onclick={goHome}>
      <svg class="ic" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
    </button>
    <div class="cut__appbar-title">
      <span id="cut-title" class="cut__filename">{ui.cutTitle}</span>
      <span id="cut-meta" class="cut__meta">{ui.cutMeta}</span>
    </div>
    <div class="cut__appbar-actions">
      <button id="cut-exit" class="cut__chip" type="button" title="Back to player view" onclick={() => setCutMode(false)}>
        <svg class="ic" viewBox="0 0 24 24"><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /><path d="m10 8 5 3-5 3z" /></svg>
        Player view
      </button>
      <button id="cut-keys" class="iconbtn iconbtn--sm" type="button" title="Keyboard shortcuts (?)" onclick={toggleShortcuts}>
        <svg class="ic" viewBox="0 0 24 24"><rect width="20" height="16" x="2" y="4" rx="2" /><path d="M6 8h.01" /><path d="M10 8h.01" /><path d="M14 8h.01" /><path d="M18 8h.01" /><path d="M8 12h.01" /><path d="M12 12h.01" /><path d="M16 12h.01" /><path d="M7 16h10" /></svg>
      </button>
      <button id="cut-fs" class="iconbtn iconbtn--sm" type="button" title="Fullscreen (F)" onclick={() => void doToggleFullscreen()}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
      </button>
    </div>
  </header>

  <!-- Timeline Deck -->
  <div class="cut__deck">
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      id="cut-timeline"
      class="cut__timeline"
      role="slider"
      aria-label="Scrub timeline"
      aria-valuenow={Math.round(ui.playheadPct)}
      tabindex="-1"
      bind:this={els.cutTimeline}
      onpointerdown={cutPointerDown}
      onpointermove={cutPointerMove}
      onpointerup={cutPointerUp}
      onpointercancel={cutPointerUp}
    >
      <div id="cut-ruler" class="cut__ruler" aria-hidden="true">
        {#each ui.rulerTicks as t}
          <div class="cut__tick {t.major ? 'cut__tick--major' : 'cut__tick--minor'}" style:left="{t.left}%"></div>
          {#if t.major}
            <span class="cut__tick-label" style:left="{t.left}%">{t.label}</span>
          {/if}
        {/each}
      </div>
      <canvas id="cut-filmstrip" class="cut__filmstrip" aria-hidden="true" bind:this={els.cutFilmstrip}></canvas>
      <canvas id="cut-waveform" class="cut__waveform" aria-hidden="true" bind:this={els.cutWaveform}></canvas>
      <div id="cut-future" class="cut__future" aria-hidden="true" style:left="{ui.playheadPct}%"></div>
      <div id="cut-playhead" class="cut__playhead" aria-hidden="true" style:left="{ui.playheadPct}%"><span class="cut__playhead-cap"></span></div>
    </div>

    <!-- Transport. A non-wrapping flex row; data-collapse (0/1/2) is set by the
         controller's measurement so it never wraps/overflows (ui-005). -->
    <div class="cut__transport" data-collapse="0">
      <div class="cut__tc">
        <span id="cut-tc-cur" class="cut__tc-cur">{ui.smpteCur}</span>
        <span class="cut__tc-sep">/</span>
        <span id="cut-tc-tot" class="cut__tc-tot">{ui.smpteTot}</span>
        <span id="cut-tc-fps" class="cut__tc-fps">{ui.fpsLabel}</span>
        <span id="cut-shuttle" class="cut__shuttle-state" hidden={!ui.shuttleBadge}>{ui.shuttleBadge}</span>
      </div>

      <div class="cut__buttons">
        <button id="cut-jumpstart" class="cut__tbtn" type="button" title="Jump to start" onclick={doJumpStart}>
          <svg class="ic ic--fill" viewBox="0 0 24 24"><polygon points="19 20 9 12 19 4 19 20" /><rect x="4" y="4" width="2.4" height="16" rx="1" /></svg>
        </button>
        <button id="cut-reverse" class="cut__tbtn" type="button" title="Reverse shuttle (J)" aria-pressed={ui.shuttleDir === -1} onclick={doShuttleReverse}>
          <svg class="ic ic--fill" viewBox="0 0 24 24"><polygon points="11 19 2 12 11 5 11 19" /><polygon points="22 19 13 12 22 5 22 19" /></svg>
        </button>
        <button id="cut-play" class="cut__play" type="button" data-playing={ui.isPlaying} title="Play / Pause (K)" onclick={cutPlayPause}>
          <svg class="ic ic--fill ic-play" viewBox="0 0 24 24"><polygon points="7 4 20 12 7 20 7 4" /></svg>
          <svg class="ic ic--fill ic-pause" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
        </button>
        <button id="cut-forward" class="cut__tbtn" type="button" title="Forward shuttle (L)" aria-pressed={ui.shuttleDir === 1} onclick={doShuttleForward}>
          <svg class="ic ic--fill" viewBox="0 0 24 24"><polygon points="13 19 22 12 13 5 13 19" /><polygon points="2 19 11 12 2 5 2 19" /></svg>
        </button>
        <button id="cut-jumpend" class="cut__tbtn" type="button" title="Jump to end" onclick={doJumpEnd}>
          <svg class="ic ic--fill" viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4" /><rect x="17.6" y="4" width="2.4" height="16" rx="1" /></svg>
        </button>
      </div>

      <div class="cut__options">
        <span class="cut__shuttle-hint" aria-hidden="true">SHUTTLE <kbd class="kbd">J</kbd><kbd class="kbd">K</kbd><kbd class="kbd">L</kbd></span>

        <!-- Overflow "More" toggle: shown only when the transport must collapse. -->
        <button
          id="cut-more"
          class="cut__opt cut__more-toggle"
          type="button"
          title="More controls"
          aria-haspopup="menu"
          aria-expanded={ui.moreOpen}
          aria-pressed={ui.moreOpen}
          onclick={toggleMore}
        >
          <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
        </button>

        <!-- Secondary options. Inline on a wide bar (display:contents); they
             relocate into this ⋯ popover when the transport is too narrow. -->
        <div class="cut__more" data-open={ui.moreOpen} role="menu" aria-label="More controls">
          <button id="cut-loop" class="cut__opt" type="button" aria-pressed={ui.loopOn} title="Loop playback" onclick={toggleLoop}>
            <svg class="ic" viewBox="0 0 24 24"><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></svg>
            <span class="cut__more-label">Loop (R)</span>
          </button>
          <button id="cut-rate" class="pill pill--ghost pill--sm" type="button" title="Playback speed" onclick={doCycleRate}>
            <svg class="ic ic--more-only" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></svg>
            <span class="cut__more-label">Playback speed</span>
            <span class="rate-val">{ui.rate}&times;</span>
          </button>
          <button id="cut-mute" class="cut__opt" type="button" data-muted={ui.muted0} title="Mute (M)" onclick={doToggleMute}>
            <svg class="ic ic-vol" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></svg>
            <svg class="ic ic-muted" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="22" x2="16" y1="9" y2="15" /><line x1="16" x2="22" y1="9" y2="15" /></svg>
            <span class="cut__more-label">Mute (M)</span>
          </button>
        </div>

        <input id="cut-volume" class="volume__range" type="range" min="0" max="100" value={ui.volumeValue} step="1" aria-label="Volume" oninput={(e) => doSetVolume(Number(e.currentTarget.value))} />
      </div>
    </div>
  </div>
</section>

<script lang="ts">
  import { ui, actions } from "./state.svelte";
  import { goBack, goHome, openFileDialog } from "./controller";
</script>

<!-- ===================== LIVESTREAM · UNAVAILABLE (frame 04b) ===================== -->
<!-- Livestream playback is temporarily deprecated. A file detected as a
     livestream opens this purpose-built screen (not an empty player). -->
<section id="live-unavailable" class="liveoff" hidden={ui.view !== "live-unavailable"}>
  <!-- Top overlay: back + title — mirrors the normal player's #stage header. -->
  <header class="overlay-top" data-tauri-drag-region>
    <button id="liveoff-back" class="glass-btn" type="button" title="Back" onclick={goBack}>
      <svg class="ic" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
    </button>
    <div class="overlay-top__title">
      <div class="overlay-top__heading">
        <span id="liveoff-title" class="title-main">{ui.liveTitle}</span>
      </div>
      <span id="liveoff-meta" class="title-sub">{ui.liveMeta}</span>
    </div>
  </header>

  <div class="liveoff__body">
    <div class="liveoff__notice">
      <span class="liveoff__icon" aria-hidden="true">
        <svg class="ic" viewBox="0 0 24 24"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" /><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" /><circle cx="12" cy="12" r="2" /><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" /><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" /></svg>
      </span>
      <div class="liveoff__text">
        <span class="liveoff__badge">Temporarily disabled</span>
        <h1 class="liveoff__heading">Livestreams are paused for now</h1>
        <p class="liveoff__copy">Live playback is temporarily turned off while we rebuild it. You can still open and watch any recorded video file.</p>
      </div>
      <div class="liveoff__actions">
        {#if actions.openDialogs}
          <button id="liveoff-open" class="pill pill--primary" type="button" onclick={() => void openFileDialog()}>Open a video file</button>
        {/if}
        <button id="liveoff-home" class="pill pill--ghost" type="button" onclick={goHome}>Back to library</button>
      </div>
      <p class="liveoff__hint">Live playback will return in a future update.</p>
    </div>
  </div>
</section>

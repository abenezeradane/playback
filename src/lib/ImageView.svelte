<script lang="ts">
  import { ui, els } from "./state.svelte";
  import { goHome, toggleGifPlay, stepGifFrame, cycleGifRate } from "./controller";
</script>

<!-- ===================== IMAGE / GIF VIEWER (play-012) ===================== -->
<section id="image-view" class="imgview" data-mode={ui.imgMode} hidden={ui.view !== "image"}>
  <!-- Top overlay: back + title — mirrors the normal player's #stage header. -->
  <header class="overlay-top" data-tauri-drag-region>
    <button id="img-back" class="glass-btn" type="button" title="Back to library" onclick={goHome}>
      <svg class="ic" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
    </button>
    <div class="overlay-top__title">
      <div class="overlay-top__heading">
        <span id="img-title" class="title-main">{ui.imgTitle}</span>
      </div>
      <span id="img-meta" class="title-sub">{ui.imgMeta}</span>
    </div>
  </header>

  <div class="imgview__viewer">
    <!-- Frame-decoded path (Tier 2): the canvas the ImageDecoder frames paint to. -->
    <canvas id="img-canvas" class="imgview__canvas" aria-hidden="true" hidden={ui.imgCanvasHidden} bind:this={els.imgCanvas}></canvas>
    <!-- Native fallback (Tier 1): the WebView animates + loops the GIF itself. -->
    <img id="img-el" class="imgview__img" alt="" hidden={ui.imgElHidden} bind:this={els.imgEl} />
    <!-- Error / unsupported state. -->
    <div id="img-error" class="imgview__error" role="alert" hidden={ui.imgErrorHidden}>
      <span class="imgview__error-icon" aria-hidden="true">
        <svg class="ic" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="m3 16 5-5 4 4 3-3 6 6" /><circle cx="9" cy="9" r="1.6" /><path d="M3 3l18 18" /></svg>
      </span>
      <span class="imgview__error-text">This image could not be opened.</span>
    </div>
  </div>

  <!-- Transport (shown only for an animated, frame-decoded image). -->
  <div id="img-controls" class="imgview__controls">
    <button id="img-step-back" class="iconbtn iconbtn--sm" type="button" title="Previous frame (,)" onclick={() => stepGifFrame(-1)}>
      <svg class="ic ic--fill" viewBox="0 0 24 24"><polygon points="11 19 2 12 11 5 11 19" /><rect x="13" y="5" width="2.4" height="14" rx="1" /></svg>
    </button>
    <button id="img-play" class="iconbtn iconbtn--primary" type="button" data-playing={ui.imgPlaying} title="Play / Pause (Space)" onclick={toggleGifPlay}>
      <svg class="ic ic--fill ic-play" viewBox="0 0 24 24"><polygon points="7 4 20 12 7 20 7 4" /></svg>
      <svg class="ic ic--fill ic-pause" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
    </button>
    <button id="img-step-fwd" class="iconbtn iconbtn--sm" type="button" title="Next frame (.)" onclick={() => stepGifFrame(1)}>
      <svg class="ic ic--fill" viewBox="0 0 24 24"><polygon points="13 5 22 12 13 19 13 5" /><rect x="8.6" y="5" width="2.4" height="14" rx="1" /></svg>
    </button>
    <button id="img-rate" class="pill pill--ghost pill--sm" type="button" title="Playback speed (+ / -)" onclick={cycleGifRate}>{ui.imgRateLabel}</button>
    <span id="img-frameinfo" class="imgview__frameinfo" aria-live="polite">{ui.imgFrameInfo}</span>
  </div>
</section>

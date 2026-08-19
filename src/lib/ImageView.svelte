<script lang="ts">
  import { ui, els } from "./state.svelte";
  import {
    goBack,
    toggleGifPlay,
    stepGifFrame,
    cycleGifRate,
    doPrevPhoto,
    doNextPhoto,
    openGalleryFromImage,
    onImageClick,
  } from "./controller";
</script>

<!-- ===================== IMAGE / GIF VIEWER (play-012, gallery-001) ===================== -->
<section id="image-view" class="imgview" data-mode={ui.imgMode} hidden={ui.view !== "image"}>
  <!-- Top overlay: back + title — mirrors the normal player's #stage header. -->
  <header class="overlay-top" data-tauri-drag-region>
    <button id="img-back" class="glass-btn" type="button" title="Back" onclick={goBack}>
      <svg class="ic" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
    </button>
    <div class="overlay-top__title">
      <div class="overlay-top__heading">
        <span id="img-title" class="title-main">{ui.imgTitle}</span>
      </div>
      <span id="img-meta" class="title-sub">{ui.imgMeta}</span>
    </div>
    {#if ui.photoQueue.length > 0}
      <!-- Sibling photo nav (gallery-001): a folder count + a jump into the grid. -->
      <div class="imgview__nav-actions">
        <!-- The "2 / 7" counter only means something with siblings to count, but the
             grid button does not: gallery-002 made the grid show SUB-FOLDERS too, so
             a lone photo in a folder of albums still has somewhere to go. -->
        {#if ui.photoQueue.length > 1}
          <span id="img-photo-count" class="imgview__count">{ui.photoIndex + 1} / {ui.photoQueue.length}</span>
        {/if}
        <button id="img-gallery" class="glass-btn" type="button" title="Gallery grid (G)" onclick={() => void openGalleryFromImage()}>
          <svg class="ic" viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>
        </button>
      </div>
    {/if}
  </header>

  <div class="imgview__viewer">
    <!-- Frame-decoded path (Tier 2): the canvas the ImageDecoder frames paint to. -->
    <!-- ui-007: double-click the picture for fullscreen, mirroring the video view.
         The handlers sit on the media elements themselves, not the whole viewer, so
         the floating prev/next chevrons over the same area are unaffected. -->
    <canvas
      id="img-canvas"
      class="imgview__canvas"
      aria-hidden="true"
      hidden={ui.imgCanvasHidden}
      bind:this={els.imgCanvas}
      onclick={onImageClick}
    ></canvas>
    <!-- Native fallback (Tier 1): the WebView animates + loops the GIF itself. -->
    <!-- role="presentation": the picture is decorative chrome for the click target
         (alt=""), and fullscreen is already reachable from the keyboard via F, so a
         keyboard handler here would be a redundant tab stop. Mirrors the
         video-surface div in Player.svelte. -->
    <img
      id="img-el"
      class="imgview__img"
      alt=""
      role="presentation"
      hidden={ui.imgElHidden}
      bind:this={els.imgEl}
      onclick={onImageClick}
    />
    <!-- Error / unsupported state. -->
    <div id="img-error" class="imgview__error" role="alert" hidden={ui.imgErrorHidden}>
      <span class="imgview__error-icon" aria-hidden="true">
        <svg class="ic" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="m3 16 5-5 4 4 3-3 6 6" /><circle cx="9" cy="9" r="1.6" /><path d="M3 3l18 18" /></svg>
      </span>
      <span class="imgview__error-text">This image could not be opened.</span>
    </div>

    {#if ui.photoQueue.length > 1}
      <!-- Sibling photo nav (gallery-001): floating prev/next, clamped at the ends. -->
      <button id="img-prev" class="imgview__navbtn imgview__navbtn--prev" type="button" title="Previous photo (←)" aria-label="Previous photo" disabled={ui.photoIndex <= 0} onclick={doPrevPhoto}>
        <svg class="ic" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <button id="img-next" class="imgview__navbtn imgview__navbtn--next" type="button" title="Next photo (→)" aria-label="Next photo" disabled={ui.photoIndex >= ui.photoQueue.length - 1} onclick={doNextPhoto}>
        <svg class="ic" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    {/if}
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

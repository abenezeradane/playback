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
    onImageWheel,
    onImagePointerDown,
    onImagePointerMove,
    onImagePointerUp,
    doImageZoomStep,
    doImageToggleFit,
    doImageRotate,
    doImageFlip,
    showImageChrome,
  } from "./controller";
</script>

<!-- ===================== IMAGE / GIF VIEWER (play-012, gallery-001) ===================== -->
<!-- img-001: `data-idle` fades the chrome and hides the cursor once the mouse has
     been still, mirroring the player's stage. Any pointer movement anywhere in the
     view brings it back — the listener is here rather than on the picture so the
     chrome also returns when the mouse moves over the letterbox beside it. -->
<section
  id="image-view"
  class="imgview"
  data-mode={ui.imgMode}
  data-idle={ui.imgIdle}
  hidden={ui.view !== "image"}
  aria-label="Image viewer"
  onpointermove={showImageChrome}
>
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

  <!-- img-001: `imgViewer` is the box the picture is fitted into and the frame all
       pan/zoom coordinates are measured against; a ResizeObserver on it re-fits
       when the window changes size. -->
  <div class="imgview__viewer" data-canpan={ui.imgCanPan} bind:this={els.imgViewer}>
    <!-- img-001: ONE transform wrapper for both render tiers, sized to the
         picture's real pixels so the transform's scale is an absolute zoom (100%
         means 100%). Whichever tier is visible is moved by the same transform, so
         a zoomed GIF keeps animating and the tiers can never drift apart.
         Gestures live here rather than on the media elements so a drag that runs
         off the edge of the picture still pans. -->
    <div
      class="imgview__surface"
      role="presentation"
      bind:this={els.imgSurface}
      onwheel={onImageWheel}
      onpointerdown={onImagePointerDown}
      onpointermove={onImagePointerMove}
      onpointerup={onImagePointerUp}
      onpointercancel={onImagePointerUp}
    >
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
    </div>
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

  <!-- img-001: the tools bar. Always present for a real picture (the transform
       tools apply to every image); the GIF transport in the middle appears only
       when the image animates, which is what `data-mode` on the section gates. -->
  <div id="img-controls" class="imgview__controls">
    <div class="imgview__tools imgview__tools--zoom">
      <button id="img-zoom-out" class="iconbtn iconbtn--sm" type="button" title="Zoom out (-)" aria-label="Zoom out" onclick={() => doImageZoomStep(-1)}>
        <svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6" /></svg>
      </button>
      <button id="img-zoom-level" class="pill pill--ghost pill--sm" type="button" title="Fit to window / actual size (0 / 1)" onclick={() => doImageToggleFit()}>{ui.imgZoomLabel}</button>
      <button id="img-zoom-in" class="iconbtn iconbtn--sm" type="button" title="Zoom in (+)" aria-label="Zoom in" onclick={() => doImageZoomStep(1)}>
        <svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6M11 8v6" /></svg>
      </button>
      <button id="img-fit" class="iconbtn iconbtn--sm" type="button" data-on={ui.imgAtFit} title="Fit to window (0)" aria-label="Fit to window" onclick={() => doImageToggleFit()}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
      </button>
    </div>

    <!-- Transport (shown only for an animated, frame-decoded image). -->
    <div class="imgview__tools imgview__tools--transport">
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
      <button id="img-rate" class="pill pill--ghost pill--sm" type="button" title="Playback speed ([ / ])" onclick={cycleGifRate}>{ui.imgRateLabel}</button>
      <span id="img-frameinfo" class="imgview__frameinfo" aria-live="polite">{ui.imgFrameInfo}</span>
    </div>

    <!-- Rotate + mirror. View-only: nothing here writes to the file on disk. -->
    <div class="imgview__tools imgview__tools--orient">
      <button id="img-rotate-left" class="iconbtn iconbtn--sm" type="button" title="Rotate left (L)" aria-label="Rotate left" onclick={() => doImageRotate(-1)}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 1 3 6.7" /><path d="M3 5v5h5" /></svg>
      </button>
      <button id="img-rotate-right" class="iconbtn iconbtn--sm" type="button" title="Rotate right (R)" aria-label="Rotate right" onclick={() => doImageRotate(1)}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 0-3 6.7" /><path d="M21 5v5h-5" /></svg>
      </button>
      <button id="img-flip-h" class="iconbtn iconbtn--sm" type="button" data-on={ui.imgFlipH} title="Flip horizontal (H)" aria-label="Flip horizontal" onclick={() => doImageFlip("h")}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M12 3v18" /><path d="M9 7 4 12l5 5V7Z" /><path d="M15 7l5 5-5 5V7Z" /></svg>
      </button>
      <button id="img-flip-v" class="iconbtn iconbtn--sm" type="button" data-on={ui.imgFlipV} title="Flip vertical (V)" aria-label="Flip vertical" onclick={() => doImageFlip("v")}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M3 12h18" /><path d="M7 9 12 4l5 5H7Z" /><path d="M7 15l5 5 5-5H7Z" /></svg>
      </button>
    </div>
  </div>
</section>

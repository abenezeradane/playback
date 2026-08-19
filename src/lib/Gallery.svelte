<script lang="ts">
  import { ui } from "./state.svelte";
  import { goHome, openGalleryItem } from "./controller";
</script>

<!-- ===================== GALLERY GRID (gallery-001) ===================== -->
<!-- A full-screen browser for every image in a folder — reached either from the
     image viewer's grid button (the current photo's siblings) or from Home's
     "Open folder" action. Clicking a tile opens that photo full-screen, where
     sibling Prev/Next (ImageView.svelte) picks up from there. -->
<section id="gallery-view" class="gallery" hidden={ui.view !== "gallery"}>
  <header class="overlay-top gallery__head" data-tauri-drag-region>
    <button id="gallery-back" class="glass-btn" type="button" title="Back to library" onclick={goHome}>
      <svg class="ic" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
    </button>
    <div class="overlay-top__title">
      <div class="overlay-top__heading">
        <span id="gallery-title" class="title-main">{ui.galleryFolder || "Gallery"}</span>
      </div>
      <span id="gallery-meta" class="title-sub">
        {#if ui.galleryLoading}
          Loading…
        {:else}
          {ui.galleryItems.length === 1 ? "1 photo" : `${ui.galleryItems.length} photos`}
        {/if}
      </span>
    </div>
  </header>

  <div class="gallery__body">
    {#if ui.galleryLoading}
      <div class="gallery__status" role="status" aria-live="polite">
        <div class="prepping__spinner" aria-hidden="true"></div>
        <span>Reading folder…</span>
      </div>
    {:else if ui.galleryError}
      <div class="gallery__status gallery__status--error" role="alert">
        <span class="imgview__error-icon" aria-hidden="true">
          <svg class="ic" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="m3 16 5-5 4 4 3-3 6 6" /><circle cx="9" cy="9" r="1.6" /><path d="M3 3l18 18" /></svg>
        </span>
        <span>{ui.galleryError}</span>
      </div>
    {:else}
      <div id="gallery-grid" class="gallery__grid">
        {#each ui.galleryItems as item (item.path)}
          <button type="button" class="gallery-tile" title={item.name} onclick={() => openGalleryItem(item)}>
            <!-- perf-005: thumbSrc is filled in by the background thumbnail pass,
                 so a tile shows a quiet placeholder until its cached JPEG exists
                 rather than blocking the grid on a full-resolution decode. -->
            {#if item.thumbSrc}
              <img class="gallery-tile__img" src={item.thumbSrc} alt="" loading="lazy" />
            {:else}
              <span class="gallery-tile__placeholder" aria-hidden="true"></span>
            {/if}
            <span class="gallery-tile__name">{item.name}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</section>

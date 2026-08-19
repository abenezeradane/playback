<script lang="ts">
  import { ui } from "./state.svelte";
  import { goBack, openGalleryItem, galleryTile } from "./controller";

  // Folders are always the leading block of the list (orderGalleryEntries), so a
  // count is all the header needs to split "N folders" from "N photos".
  const folderCount = $derived(ui.galleryItems.filter((i) => i.kind === "folder").length);
</script>

<script module lang="ts">
  /** "2 folders · 12 photos" — omitting whichever half is zero, so a plain photo
   *  folder still reads exactly as it did before gallery-002. */
  function galleryMeta(folders: number, photos: number): string {
    const parts: string[] = [];
    if (folders > 0) parts.push(folders === 1 ? "1 folder" : `${folders} folders`);
    if (photos > 0 || folders === 0) parts.push(photos === 1 ? "1 photo" : `${photos} photos`);
    return parts.join(" · ");
  }
</script>

<!-- ============== GALLERY GRID (gallery-001, gallery-002) ============== -->
<!-- A full-screen browser for a folder's contents — reached from the image
     viewer's grid button, from Home's "Open folder" action, or by clicking a
     sub-folder tile inside another gallery. An image tile opens that photo
     full-screen, where sibling Prev/Next (ImageView.svelte) picks up from there;
     a folder tile re-scopes this grid to that folder. -->
<section id="gallery-view" class="gallery" hidden={ui.view !== "gallery"}>
  <header class="overlay-top gallery__head" data-tauri-drag-region>
    <button id="gallery-back" class="glass-btn" type="button" title="Back" onclick={goBack}>
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
          <!-- gallery-002: once you are inside a sub-gallery, the trail says where
               that folder sits — the folder name alone is ambiguous when several
               albums have a "Raw" or "Edits" inside them. -->
          {#if ui.galleryCrumbs.length > 1}
            <span id="gallery-crumbs" class="gallery__crumbs">{ui.galleryCrumbs.join(" / ")}</span>
            <span aria-hidden="true"> · </span>
          {/if}
          {galleryMeta(folderCount, ui.galleryItems.length - folderCount)}
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
        {#each ui.galleryItems as item, i (item.path)}
          <!-- ux-004: `galleryTile` renders this tile's thumbnail only once it
               nears the viewport, and the roving tabindex makes the whole grid a
               single Tab stop (arrows move within it) so a folder of thousands is
               not a tab trap. -->
          <button
            type="button"
            class="gallery-tile"
            class:gallery-tile--folder={item.kind === "folder"}
            title={item.kind === "folder" ? `Folder: ${item.name}` : item.name}
            aria-label={item.kind === "folder" ? `Folder: ${item.name}` : item.name}
            tabindex={i === (ui.galleryIndex < 0 ? 0 : ui.galleryIndex) ? 0 : -1}
            use:galleryTile={i}
            onclick={() => openGalleryItem(item)}
          >
            <!-- perf-005: thumbSrc is filled in by the background thumbnail pass,
                 so a tile shows a quiet placeholder until its cached JPEG exists
                 rather than blocking the grid on a full-resolution decode.
                 gallery-002: for a FOLDER that src is a cover taken from the first
                 image inside; a folder with none keeps the glyph below instead. -->
            {#if item.thumbSrc}
              <img class="gallery-tile__img" src={item.thumbSrc} alt="" loading="lazy" />
            {:else if item.kind === "folder"}
              <span class="gallery-tile__glyph" aria-hidden="true">
                <svg class="ic" viewBox="0 0 24 24">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                </svg>
              </span>
            {:else}
              <span class="gallery-tile__placeholder" aria-hidden="true"></span>
            {/if}
            <!-- The badge marks a folder even when a cover picture fills the tile,
                 so a folder is never mistaken for one of the photos inside it. -->
            {#if item.kind === "folder"}
              <span class="gallery-tile__badge" aria-hidden="true">
                <svg class="ic" viewBox="0 0 24 24">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                </svg>
              </span>
            {/if}
            <span class="gallery-tile__name">{item.name}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</section>

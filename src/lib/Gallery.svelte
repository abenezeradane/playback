<script lang="ts">
  import { ui } from "./state.svelte";
  import {
    goBack,
    openGalleryItem,
    galleryTile,
    openTagPopover,
    pruneMissingFromTag,
    galleryColumns,
    onGalleryScroll,
    tagItemKey,
  } from "./controller";
  import { galleryMeta, tagMeta } from "../player-core";
  import type { GalleryItem } from "./state.svelte";

  // The header counts each kind rather than assuming block boundaries: gallery-003
  // interleaves photos and videos by name, so only folders are still a contiguous
  // leading block. `galleryMeta` (player-core, unit-tested) turns these into the
  // "2 folders · 12 photos · 3 videos" line.
  const folderCount = $derived(ui.galleryItems.filter((i) => i.kind === "folder").length);
  const videoCount = $derived(ui.galleryItems.filter((i) => i.kind === "video").length);
  const archiveCount = $derived(ui.galleryItems.filter((i) => i.kind === "archive").length);
  const photoCount = $derived(
    ui.galleryItems.length - folderCount - videoCount - archiveCount,
  );

  /** A tile's accessible name. Folders and videos say so, because the picture alone
   *  cannot: a folder cover and a video poster are both just stills. */
  function tileLabel(kind: GalleryItem["kind"], name: string): string {
    if (kind === "folder") return `Folder: ${name}`;
    if (kind === "video") return `Video: ${name}`;
    if (kind === "archive") return `Archive: ${name}`;
    return name;
  }

  /**
   * The tag header's meta line (tags-002). `tagMeta` counts items only — never
   * missing, which would cost a full scan of the tag on every open — so the
   * cap notice is appended here, from what the grid actually loaded, rather
   * than silently truncating.
   */
  function tagMetaLine(total: number, capped: boolean, shown: number): string {
    const base = tagMeta(total);
    if (!capped) return base;
    return `${base} · showing the first ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
  }

  // --- Sliding window: scroll-driven re-centring + scrollbar spacers (tags-002 Step 2/3) ---
  //
  // A tag view keeps only a TAG_WINDOW-tile slice of the tag in the DOM
  // (controller.ts's applyWindow); everything below exists so the scrollbar
  // and the keyboard/scroll experience still read as one continuous grid the
  // size of the whole tag, not the size of whatever's currently loaded.

  // Row height (tile height + row gap) and column count are DOM measurements,
  // not reactive state, so they are cached rather than re-read on every scroll
  // tick — the cache is invalidated when a fresh tag opens (a new grid can lay
  // out at a different tile size) or the window resizes (a responsive grid
  // changes both its column count and, via `aspect-ratio: 1/1`, its tile
  // height along with it).
  let cachedRowHeight = 0;
  let measuredForTag = "";

  function invalidateRowHeightCache(): void {
    cachedRowHeight = 0;
  }

  function currentRowHeight(): number {
    if (ui.galleryTag !== measuredForTag) {
      measuredForTag = ui.galleryTag;
      cachedRowHeight = 0;
    }
    if (cachedRowHeight > 0) return cachedRowHeight;
    const grid = document.getElementById("gallery-grid");
    const tile = grid?.querySelector(".gallery-tile") as HTMLElement | null;
    if (!grid || !tile) return 0;
    const gap = parseFloat(getComputedStyle(grid).rowGap || "0") || 0;
    cachedRowHeight = tile.offsetHeight + gap;
    return cachedRowHeight;
  }

  let spacerTop = $state(0);
  let spacerBottom = $state(0);

  /** tags-002 Step 3: without these two spacers the scrollbar reports only the
   *  loaded window's height rather than the whole tag's, and scrolling snaps
   *  every time the window re-centres. Both are grid-column-spanning (styles.css
   *  `.gallery__spacer`) so they occupy whole phantom rows rather than sitting
   *  inside one column. */
  function recomputeSpacers(): void {
    if (!ui.galleryTag) {
      spacerTop = 0;
      spacerBottom = 0;
      return;
    }
    const rh = currentRowHeight();
    const cols = galleryColumns();
    if (rh <= 0 || cols <= 0) return;
    const start = ui.galleryWindowStart;
    const end = start + ui.galleryItems.length;
    const total = ui.galleryTagTotal;
    spacerTop = Math.ceil(start / cols) * rh;
    spacerBottom = Math.ceil(Math.max(0, total - end) / cols) * rh;
  }

  // Reruns whenever the window moves (galleryWindowStart/galleryItems.length),
  // the tag's own total changes, or the tag itself changes — every reactive
  // read inside recomputeSpacers (called synchronously here) is what drives
  // that, including the ones made through currentRowHeight/galleryColumns'
  // callers below.
  $effect(() => {
    recomputeSpacers();
  });

  $effect(() => {
    const onResize = (): void => {
      invalidateRowHeightCache();
      recomputeSpacers();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  let scrollScheduled = false;

  /** tags-002 Step 2: computes the row scrolled to from scrollTop/rowHeight and
   *  slides the window (via controller's `onGalleryScroll`) when that row
   *  leaves the middle third of the currently loaded window. rAF-throttled so
   *  a fast scroll/wheel gesture — which can fire many "scroll" events per
   *  frame — costs one recentre check per frame, not one per event. A no-op
   *  outside a tag view: every other gallery is loaded in full already, so
   *  there is no window to slide. */
  function onGridScroll(): void {
    if (!ui.galleryTag || scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      const body = document.querySelector(".gallery__body") as HTMLElement | null;
      const rh = currentRowHeight();
      const cols = galleryColumns();
      if (!body || rh <= 0 || cols <= 0) return;
      const row = Math.floor(body.scrollTop / rh);
      const focus = row * cols;
      const windowStart = ui.galleryWindowStart;
      const windowSize = ui.galleryItems.length;
      const third = windowSize / 3;
      if (focus < windowStart + third || focus >= windowStart + windowSize - third) {
        onGalleryScroll(focus);
      }
    });
  }
</script>

<!-- ========= GALLERY GRID (gallery-001, gallery-002, gallery-003) ========= -->
<!-- A full-screen browser for a folder's contents — reached from the image
     viewer's grid button, from Home's "Open folder" action, or by clicking a
     sub-folder tile inside another gallery. An image tile opens that photo
     full-screen, where sibling Prev/Next (ImageView.svelte) picks up from there;
     a folder tile re-scopes this grid to that folder; and a video tile opens in
     the player, where the play-013 folder queue picks up from there. Each viewer
     walks its own kind — Prev/Next never crosses from a photo into a clip. -->
<section id="gallery-view" class="gallery" hidden={ui.view !== "gallery"}>
  <header class="overlay-top gallery__head" data-tauri-drag-region>
    <button id="gallery-back" class="glass-btn" type="button" title="Back" onclick={goBack}>
      <svg class="ic" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
    </button>
    <div class="overlay-top__title">
      <div class="overlay-top__heading">
        {#if ui.galleryTag}
          <!-- tags-002: a tag view is a grid like any other, but it is scoped by
               tag rather than by folder — the title says so, the way gallery-002's
               crumb trail says which folder a sub-gallery sits in. -->
          <span id="gallery-title" class="title-main">Tag · {ui.galleryTag}</span>
        {:else}
          <span id="gallery-title" class="title-main">{ui.galleryFolder || "Gallery"}</span>
        {/if}
      </div>
      <span id="gallery-meta" class="title-sub">
        {#if ui.galleryLoading}
          Loading…
        {:else if ui.galleryTag}
          {tagMetaLine(ui.galleryTagTotal, ui.galleryTagCapped, ui.galleryItems.length)}
        {:else}
          <!-- gallery-002: once you are inside a sub-gallery, the trail says where
               that folder sits — the folder name alone is ambiguous when several
               albums have a "Raw" or "Edits" inside them. -->
          {#if ui.galleryCrumbs.length > 1}
            <span id="gallery-crumbs" class="gallery__crumbs">{ui.galleryCrumbs.join(" / ")}</span>
            <span aria-hidden="true"> · </span>
          {/if}
          {galleryMeta(folderCount, photoCount, videoCount, archiveCount)}
        {/if}
      </span>
    </div>
    {#if ui.galleryTag}
      <!-- tags-002: pruning counts before it deletes (pruneMissingFromTag makes
           two calls on purpose) and only ever removes the TAG, never the file —
           a file on an unplugged drive comes back when the drive does. -->
      <button
        id="gallery-prune"
        class="glass-btn"
        type="button"
        title="Remove missing items from this tag"
        aria-label="Remove missing items from this tag — the files themselves are not deleted"
        onclick={() => void pruneMissingFromTag()}
      >
        <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71" /><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71" /><line x1="8" x2="8" y1="2" y2="5" /><line x1="2" x2="5" y1="8" y2="8" /><line x1="16" x2="16" y1="19" y2="22" /><line x1="19" x2="22" y1="16" y2="16" /></svg>
      </button>
    {/if}
  </header>

  <div class="gallery__body" onscroll={onGridScroll}>
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
        {#if ui.galleryTag && spacerTop > 0}
          <!-- tags-002 Step 3: stands in for every tag member ABOVE the loaded
               window so the scrollbar reflects the tag's full length, not just
               what's currently in the DOM. Grid-column-spanning (styles.css)
               so it occupies whole phantom rows. -->
          <div class="gallery__spacer" style="height: {spacerTop}px" aria-hidden="true"></div>
        {/if}
        {#each ui.galleryItems as item, i (tagItemKey(item.archive, item.path))}
          <!-- ux-004: `galleryTile` renders this tile's thumbnail only once it
               nears the viewport, and the roving tabindex makes the whole grid a
               single Tab stop (arrows move within it) so a folder of thousands is
               not a tab trap. -->
          <button
            type="button"
            class="gallery-tile"
            class:gallery-tile--folder={item.kind === "folder"}
            class:gallery-tile--video={item.kind === "video"}
            class:gallery-tile--archive={item.kind === "archive"}
            class:gallery-tile--missing={item.missing}
            title={tileLabel(item.kind, item.name)}
            aria-label={tileLabel(item.kind, item.name)}
            aria-disabled={item.missing ? "true" : undefined}
            tabindex={ui.galleryWindowStart + i ===
            (ui.galleryIndex < 0 ? 0 : ui.galleryIndex)
              ? 0
              : -1}
            use:galleryTile={ui.galleryWindowStart + i}
            onclick={() => openGalleryItem(item)}
          >
            <!-- perf-005: thumbSrc is filled in by the background thumbnail pass,
                 so a tile shows a quiet placeholder until its cached JPEG exists
                 rather than blocking the grid on a full-resolution decode.
                 gallery-002: for a FOLDER that src is a cover taken from the first
                 image inside; a folder with none keeps the glyph below instead. -->
            {#if item.thumbSrc}
              <img class="gallery-tile__img" src={item.thumbSrc} alt="" loading="lazy" />
            {:else if item.kind === "folder" || item.kind === "archive"}
              <span class="gallery-tile__glyph" aria-hidden="true">
                {#if item.kind === "archive"}
                  <svg class="ic" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" /><path d="M10 13h4" /></svg>
                {:else}
                  <svg class="ic" viewBox="0 0 24 24">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                  </svg>
                {/if}
              </span>
            {:else}
              <span class="gallery-tile__placeholder" aria-hidden="true"></span>
            {/if}
            <!-- The badge marks a folder even when a cover picture fills the tile,
                 so a folder is never mistaken for one of the photos inside it.
                 gallery-003: a video gets the same treatment with a play mark — its
                 poster frame is a still, and without this a tile of a paused scene
                 is indistinguishable from a photograph. -->
            {#if item.kind === "folder"}
              <span class="gallery-tile__badge" aria-hidden="true">
                <svg class="ic" viewBox="0 0 24 24">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                </svg>
              </span>
            {:else if item.kind === "archive"}
              <!-- gallery-004: a cover picture comes from INSIDE the archive, so
                   without this badge an archive is indistinguishable from a
                   folder whose cover happens to be the same picture. -->
              <span class="gallery-tile__badge" aria-hidden="true">
                <svg class="ic" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" /><path d="M10 13h4" /></svg>
              </span>
            {:else if item.kind === "video"}
              <span class="gallery-tile__badge gallery-tile__badge--video" aria-hidden="true">
                <svg class="ic" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5Z" /></svg>
              </span>
              <!-- Empty until the probe answers, and permanently empty for a file
                   whose container reports no duration — the badge is omitted rather
                   than showing an invented 0:00. -->
              {#if item.durationLabel}
                <span class="gallery-tile__duration">{item.durationLabel}</span>
              {/if}
            {/if}
            {#if item.missing}
              <!-- tags-002: the duration badge owns top-right, the folder/archive
                   badge owns top-left, and the filename strip owns the bottom
                   edge — bottom-left is the one corner none of them claim. -->
              <span class="gallery-tile__missing" aria-hidden="true">Missing</span>
            {/if}
            <!-- tags-001: the grid's own way in. The tile is itself a <button>,
                 so this is a SPAN with a click handler rather than a nested
                 button, which is invalid HTML and swallows the tile's own
                 activation. -->
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <span
              class="gallery-tile__tag"
              title="Tags (#)"
              onclick={(e) => {
                e.stopPropagation();
                // tags-002: `i` is a position within `ui.galleryItems` (the
                // window, once Task 12 lands) — same conversion as every other
                // cursor write in this file/controller.ts, so this one does not
                // regress silently when that window lands.
                ui.galleryIndex = ui.galleryWindowStart + i;
                openTagPopover();
              }}
            >
              <svg class="ic" viewBox="0 0 24 24"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>
            </span>
            <span class="gallery-tile__name">{item.name}</span>
          </button>
        {/each}
        {#if ui.galleryTag && spacerBottom > 0}
          <!-- tags-002 Step 3: the same stand-in as the top spacer, for every
               tag member BELOW the loaded window. -->
          <div class="gallery__spacer" style="height: {spacerBottom}px" aria-hidden="true"></div>
        {/if}
      </div>
    {/if}
  </div>

  {#if ui.galleryFlash}
    <!-- tags-002: a zero-missing prune changes nothing in the grid, so it says so
         here — mirrors ImageView's .imgview__flash, but bottom-centred rather
         than screen-centred: the header sits at the top of this view and the
         grid's first row starts right under it, so the bottom is the free space. -->
    <div class="gallery__flash" role="status">{ui.galleryFlash}</div>
  {/if}
</section>

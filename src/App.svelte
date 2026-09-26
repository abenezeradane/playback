<script lang="ts">
  import { onMount } from "svelte";
  import { ui, els, actions } from "./lib/state.svelte";
  import { init } from "./lib/controller";
  import Home from "./lib/Home.svelte";
  import StorageGate from "./lib/StorageGate.svelte";
  import Player from "./lib/Player.svelte";
  import ImageView from "./lib/ImageView.svelte";
  import Gallery from "./lib/Gallery.svelte";
  import LiveUnavailable from "./lib/LiveUnavailable.svelte";
  import ShortcutsOverlay from "./lib/ShortcutsOverlay.svelte";
  import Settings from "./lib/Settings.svelte";
  import PlaylistEditor from "./lib/PlaylistEditor.svelte";
  import TagPopover from "./lib/TagPopover.svelte";
  import TagIndex from "./lib/TagIndex.svelte";
  import TagDeletePanel from "./lib/TagDeletePanel.svelte";

  // Boot the runtime once the whole tree (and every bind:this handle) is mounted.
  // This replaces main.ts's former imperative boot block; global listeners (the
  // keyboard handler, Tauri drag-drop + launch_path, context menu) are wired from
  // here — always client-side, since plain Svelte has no SSR.
  onMount(() => {
    init();
  });
</script>

<div
  id="app"
  class="app"
  data-state={ui.view}
  data-mode={ui.cutMode ? "cut" : "player"}
  data-dragover={ui.dragover}
>
  <Home />
  <StorageGate />
  <Player />
  <ImageView />
  <Gallery />
  <LiveUnavailable />
  {#if actions.shortcuts}<ShortcutsOverlay />{/if}
  <Settings />
  <PlaylistEditor />
  <TagPopover />
  <TagIndex />
  <TagDeletePanel />

  {#if ui.prepping}
    <!-- Transport-stream remux progress (play-016): a non-blocking overlay shown
         while the ffmpeg sidecar converts a .ts/.m2ts/.mts to a playable .mp4.
         gallery-004 shares it for archive extraction, so the title comes from
         state rather than being hard-coded here — the label below is always the
         filename. -->
    <div class="prepping" role="status" aria-live="polite">
      <div class="prepping__card">
        <div class="prepping__spinner" aria-hidden="true"></div>
        <div class="prepping__text">
          <div class="prepping__title">{ui.preppingTitle}</div>
          <div class="prepping__sub">{ui.preppingLabel}</div>
        </div>
      </div>
    </div>
  {/if}
</div>

<!-- Background filmstrip generator (play-004). A dedicated <video> scanned off to
     the side on file open so the timeline's thumbnails are captured WITHOUT
     seeking the main viewer. Kept out of the layout; shown only as a tiny,
     fully-opaque on-screen square for the duration of a scan. -->
<!-- svelte-ignore a11y_media_has_caption -->
<video id="cut-gen" class="cut-gen" muted playsinline preload="auto" aria-hidden="true" tabindex="-1" bind:this={els.cutGen}></video>

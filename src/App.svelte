<script lang="ts">
  import { onMount } from "svelte";
  import { ui, els } from "./lib/state.svelte";
  import { init } from "./lib/controller";
  import Home from "./lib/Home.svelte";
  import Player from "./lib/Player.svelte";
  import ImageView from "./lib/ImageView.svelte";
  import LiveUnavailable from "./lib/LiveUnavailable.svelte";
  import ShortcutsOverlay from "./lib/ShortcutsOverlay.svelte";

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
  <Player />
  <ImageView />
  <LiveUnavailable />
  <ShortcutsOverlay />
</div>

<!-- Background filmstrip generator (play-004). A dedicated <video> scanned off to
     the side on file open so the timeline's thumbnails are captured WITHOUT
     seeking the main viewer. Kept out of the layout; shown only as a tiny,
     fully-opaque on-screen square for the duration of a scan. -->
<!-- svelte-ignore a11y_media_has_caption -->
<video id="cut-gen" class="cut-gen" muted playsinline preload="auto" aria-hidden="true" tabindex="-1" bind:this={els.cutGen}></video>

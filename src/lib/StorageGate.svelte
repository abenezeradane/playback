<script lang="ts">
  import { ui } from "./state.svelte";
  import { requestStorageAccess } from "./controller";
</script>

<!-- android-001: the first-run gate. Playback cannot browse a phone without
     All-files access, so rather than an empty Home it says why, once, and asks. -->
<section id="storage-gate" class="gate" data-ready={ui.storageGateReady} hidden={ui.view !== "storage-gate"} aria-labelledby="gate-title">
  <div class="gate__card">
    <span class="gate__chip" aria-hidden="true">
      <svg class="ic" viewBox="0 0 24 24"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></svg>
    </span>
    <h1 id="gate-title" class="gate__title">Let Playback see your files</h1>
    <p class="gate__body">Playback browses the folders on this phone, its SD card and USB drives the way it does on a computer: pick a folder and see everything in it.</p>
    <p class="gate__body gate__body--quiet">Nothing is uploaded and nothing here uses the network. Android calls this permission "All files access".</p>
    {#if ui.storageGateDenied}
      <p id="gate-denied" class="gate__denied" role="status">Access is still off. Turn on "Allow access to manage all files" for Playback, then come back.</p>
    {/if}
    <button id="gate-grant" class="pill pill--primary gate__cta" type="button" disabled={ui.storageGateBusy} onclick={() => void requestStorageAccess()}>
      Grant access
    </button>
  </div>
</section>

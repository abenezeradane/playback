<script lang="ts">
  import { ui } from "./state.svelte";
  import { closeTagDeletePanel, confirmTagDelete } from "./controller";
</script>

<!-- ===================== DELETE EVERY FILE WITH A TAG (tags-004) =====================
     A panel rather than a two-press button: this destroys files, and the user
     has to be told the count, where they go, and what will be skipped BEFORE
     anything happens. `window.confirm` shows nothing in this WebView2 build.
     No local Escape handler: unlike TagPopover/TagIndex this panel holds no
     text field, so (as for Settings/ShortcutsOverlay) Esc is caught by the
     global keydown cascade in controller.ts — the `ui.tagDeleteOpen` guard
     placed beside `tagPopoverOpen`'s, for the identical reason: this panel is
     a layer over the gallery view, whose own Esc would otherwise navigate away
     and strand the panel open over wherever Back lands. -->
<div id="tag-delete" class="shortcuts" data-open={ui.tagDeleteOpen} aria-hidden={!ui.tagDeleteOpen}>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <!-- closeTagDeletePanel is itself a no-op while tagDeleteBusy (tags-004 fix
       round 1, #2) -- the sweep cannot be interrupted once started, so the
       backdrop staying clickable but inert is deliberate, not an oversight. -->
  <div class="shortcuts__backdrop" data-close="true" onclick={closeTagDeletePanel}></div>
  <div class="shortcuts__panel" role="dialog" aria-label="Delete every file with this tag">
    <div class="shortcuts__head">
      <div class="shortcuts__heading">
        <div>
          {#if ui.tagDeleteResult}
            <h2 class="shortcuts__title">Done</h2>
          {:else}
            <h2 class="shortcuts__title">Delete {ui.tagDeleteCount.toLocaleString("en-US")} files?</h2>
          {/if}
          <p class="shortcuts__sub">Everything tagged "{ui.galleryTag}"</p>
        </div>
      </div>
      <button
        id="tag-delete-close"
        class="iconbtn iconbtn--sm"
        type="button"
        title={ui.tagDeleteResult ? "Close (Esc)" : "Cancel (Esc)"}
        disabled={ui.tagDeleteBusy}
        onclick={closeTagDeletePanel}
      >
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
    </div>

    <div class="tagpop__body">
      {#if ui.tagDeleteResult}
        <!-- tags-004 fix round 1 (#1): the sweep's own outcome, replacing the
             question with the answer in the same panel — the only place these
             counts are shown to the user at all. -->
        <p class="tagdel__line" role="status">{ui.tagDeleteResult}</p>
        <div class="tagdel__actions">
          <button id="tag-delete-done" class="pill pill--primary" type="button" onclick={closeTagDeletePanel}>
            Close
          </button>
        </div>
      {:else}
        <p class="tagdel__line">They move to the <strong>Recycle Bin</strong>, so you can get them back from Windows.</p>
        {#if ui.tagDeleteArchived > 0}
          <p class="tagdel__line tagdel__line--note">
            {ui.tagDeleteArchived.toLocaleString("en-US")} inside archives will be skipped — deleting one would mean rewriting the archive.
          </p>
        {/if}
        {#if ui.tagDeleteFolders > 0}
          <!-- tags-004 code review: a tagged FOLDER is skipped, never recursively
               recycled — deleting one file is a far smaller promise than deleting
               a whole tree. Said here, before the sweep runs, for the same reason
               the archive line is: a skip reported only afterward reads as the
               app silently ignoring what it was asked to do. -->
          <p class="tagdel__line tagdel__line--note">
            {ui.tagDeleteFolders.toLocaleString("en-US")} {ui.tagDeleteFolders === 1 ? "folder" : "folders"} will be skipped — this deletes files, never whole directories.
          </p>
        {/if}
        <p class="tagdel__line tagdel__line--note">The tag itself is removed once nothing it names is left.</p>
        {#if ui.tagDeleteError}
          <p class="tagpop__error" role="alert">{ui.tagDeleteError}</p>
        {/if}
        <div class="tagdel__actions">
          <!-- tags-004 fix round 1 (#2): disabled rather than left clickable-but-
               inert while busy -- the sweep genuinely cannot be interrupted once
               started, so a live Cancel button would be an offer this app can't
               honor. -->
          <button id="tag-delete-cancel" class="pill pill--ghost" type="button" disabled={ui.tagDeleteBusy} onclick={closeTagDeletePanel}>
            Cancel
          </button>
          <button
            id="tag-delete-confirm"
            class="pill pill--danger"
            type="button"
            disabled={ui.tagDeleteBusy || ui.tagDeleteCount === 0}
            onclick={() => void confirmTagDelete()}
          >
            {ui.tagDeleteBusy ? "Deleting…" : `Delete ${ui.tagDeleteCount.toLocaleString("en-US")} files`}
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>

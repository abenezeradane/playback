<script lang="ts">
  import { ui } from "./state.svelte";
  import { closeTagIndex, onTagIndexQuery, openGalleryForTag } from "./controller";

  /** Focus the field the moment the index opens — the same use: action
   *  TagPopover.svelte uses. Parking focus in a text entry also suppresses the
   *  app's global hotkeys for free (the existing isFocusTextEntry guard). */
  function focusOnOpen(node: HTMLInputElement) {
    node.focus();
    return {};
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeTagIndex();
    }
  }
</script>

<!-- ===================== ALL-TAGS INDEX (tags-002) =====================
     Home's Tags shelf only shows the top 24, most-used first; this is the
     searchable view of every tag in the library. Reuses the .shortcuts
     backdrop/panel/head chrome exactly as Settings.svelte and TagPopover.svelte
     do, so it matches every other overlay in the app. -->
<div id="tag-index" class="shortcuts" data-open={ui.tagIndexOpen} aria-hidden={!ui.tagIndexOpen}>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="shortcuts__backdrop" data-close="true" onclick={closeTagIndex}></div>
  <div class="shortcuts__panel" role="dialog" aria-label="All tags">
    <div class="shortcuts__head">
      <div class="shortcuts__heading">
        <span class="shortcuts__icon" aria-hidden="true">
          <svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
        </span>
        <div>
          <h2 class="shortcuts__title">All tags</h2>
          <p class="shortcuts__sub">Search the whole library</p>
        </div>
      </div>
      <button id="tag-index-close" class="iconbtn iconbtn--sm" type="button" title="Close (Esc)" onclick={closeTagIndex}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
    </div>

    <div class="tagpop__body">
      {#if ui.tagIndexOpen}
        <input
          id="tag-index-input"
          class="tagpop__input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="Search tags"
          value={ui.tagIndexQuery}
          use:focusOnOpen
          oninput={(e) => onTagIndexQuery(e.currentTarget.value)}
          onkeydown={onKey}
        />
      {/if}

      <ul id="tag-index-rows" class="tagindex__rows">
        {#each ui.tagIndexRows as row (row.name)}
          <li>
            <button type="button" class="tagpop__suggestion" onclick={() => void openGalleryForTag(row.name)}>
              <span class="tagpop__suggestion-name">{row.name}</span>
              <!-- The count is the point here too: it is how a search across the
                   whole library still tells landscapes (4,000) apart from
                   landscape (1) at a glance. -->
              <span class="tagpop__suggestion-count">{row.count}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  </div>
</div>

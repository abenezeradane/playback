<script lang="ts">
  import { ui } from "./state.svelte";
  import {
    closeTagIndex,
    onTagIndexQuery,
    openGalleryForTag,
    setShowBlacklisted,
    toggleTagBlacklist,
  } from "./controller";

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

      <label class="tagindex__showbl">
        <input
          id="tag-index-showbl"
          type="checkbox"
          checked={ui.tagIndexShowBlacklisted}
          onchange={(e) => setShowBlacklisted(e.currentTarget.checked)}
        />
        <span>Show blacklisted</span>
      </label>

      {#if ui.tagIndexError}
        <p class="tagpop__error" role="alert">{ui.tagIndexError}</p>
      {/if}

      <ul id="tag-index-rows" class="tagindex__rows">
        {#each ui.tagIndexRows as row (row.name)}
          <li class="tagindex__row" class:tagindex__row--blacklisted={ui.tagBlacklist.includes(row.name)}>
            <button type="button" class="tagpop__suggestion" onclick={() => void openGalleryForTag(row.name)}>
              <span class="tagpop__suggestion-name">{row.name}</span>
              <!-- The count is the point here too: it is how a search across the
                   whole library still tells landscapes (4,000) apart from
                   landscape (1) at a glance. -->
              <span class="tagpop__suggestion-count">{row.count}</span>
            </button>
            <!-- tags-003: reversible, so no confirmation. Pressing it again
                 restores the tag and its items exactly. -->
            <button
              type="button"
              class="iconbtn iconbtn--sm"
              title={ui.tagBlacklist.includes(row.name) ? `Show "${row.name}" again` : `Blacklist "${row.name}"`}
              aria-label={ui.tagBlacklist.includes(row.name)
                ? `Stop hiding ${row.name} and its items`
                : `Blacklist ${row.name} — hides the tag and its items from browsing, deletes nothing`}
              onclick={() => void toggleTagBlacklist(row.name)}
            >
              {#if ui.tagBlacklist.includes(row.name)}
                <svg class="ic" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
              {:else}
                <svg class="ic" viewBox="0 0 24 24"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.4 0 10 7 10 7a18 18 0 0 1-2.16 3.19M6.6 6.6A18 18 0 0 0 2 11s3.6 7 10 7a9 9 0 0 0 5.4-1.6" /><path d="m2 2 20 20" /></svg>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </div>
  </div>
</div>

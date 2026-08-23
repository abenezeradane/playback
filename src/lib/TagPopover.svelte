<script lang="ts">
  import { ui } from "./state.svelte";
  import {
    closeTagPopover,
    commitTagDraft,
    removeTagFromTarget,
    onTagDraftInput,
    applySuggestion,
  } from "./controller";

  /** Focus the field the moment the popover opens: the whole interaction is
   *  typing, and it also parks focus in a text entry, which suppresses the
   *  global hotkeys for free (the existing isFocusTextEntry guard). */
  function focusOnOpen(node: HTMLInputElement) {
    node.focus();
    return {};
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeTagPopover();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const picked = ui.tagSuggestions[ui.tagSuggestIndex];
      // Enter takes the highlighted suggestion when the field matches nothing
      // else — otherwise it creates exactly what was typed.
      if (picked && ui.tagDraft.trim() === "") void applySuggestion(picked.name);
      else void commitTagDraft();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = ui.tagSuggestions.length;
      if (n === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      ui.tagSuggestIndex = (ui.tagSuggestIndex + step + n) % n;
      return;
    }
    if (e.key === "Backspace" && ui.tagDraft === "" && ui.tagTargetTags.length > 0) {
      e.preventDefault();
      void removeTagFromTarget(ui.tagTargetTags[ui.tagTargetTags.length - 1]);
    }
  }
</script>

<!-- ===================== TAG POPOVER (tags-001) =====================
     One component for every surface: the image viewer, the player and the
     gallery grid all open THIS, for whichever item they are showing. Reuses the
     .shortcuts overlay chrome so it matches Settings and the shortcuts dialog. -->
<div id="tag-popover" class="shortcuts" data-open={ui.tagPopoverOpen} aria-hidden={!ui.tagPopoverOpen}>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="shortcuts__backdrop" data-close="true" onclick={closeTagPopover}></div>
  <div class="shortcuts__panel tagpop__panel" role="dialog" aria-label="Tags">
    <div class="shortcuts__head">
      <div class="shortcuts__heading">
        <span class="shortcuts__icon" aria-hidden="true">
          <svg class="ic" viewBox="0 0 24 24"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>
        </span>
        <div>
          <h2 class="shortcuts__title">Tags</h2>
          <p class="shortcuts__sub">{ui.tagTarget?.name ?? ""}</p>
        </div>
      </div>
      <button id="tag-close" class="iconbtn iconbtn--sm" type="button" title="Close (Esc)" onclick={closeTagPopover}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
    </div>

    <div class="tagpop__body">
      <div id="tag-chips" class="tagpop__chips">
        {#each ui.tagTargetTags as tag (tag)}
          <button
            type="button"
            class="tagpop__chip"
            title="Remove {tag}"
            aria-label="Remove {tag}"
            onclick={() => void removeTagFromTarget(tag)}
          >
            <span class="tagpop__chip-name">{tag}</span>
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        {/each}
        {#if ui.tagTargetTags.length === 0}
          <span class="tagpop__empty">No tags yet</span>
        {/if}
      </div>

      {#if ui.tagPopoverOpen}
        <input
          id="tag-input"
          class="tagpop__input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="Type a tag, comma to add another"
          value={ui.tagDraft}
          use:focusOnOpen
          oninput={(e) => onTagDraftInput(e.currentTarget.value)}
          onkeydown={onKey}
        />
      {/if}

      {#if ui.tagError}
        <p class="tagpop__error" role="alert">{ui.tagError}</p>
      {/if}

      <ul id="tag-suggestions" class="tagpop__suggestions">
        {#each ui.tagSuggestions as s, i (s.name)}
          <li>
            <button
              type="button"
              class="tagpop__suggestion"
              class:tagpop__suggestion--active={i === ui.tagSuggestIndex}
              onclick={() => void applySuggestion(s.name)}
            >
              <span class="tagpop__suggestion-name">{s.name}</span>
              <!-- The count is the point: it is what stops a second spelling of a
                   tag 4,000 things already use. -->
              <span class="tagpop__suggestion-count">{s.count}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  </div>
</div>

<script lang="ts">
  import { ui, els } from "./state.svelte";
  import {
    setPanelOpen,
    openAddInput,
    closeAddInput,
    onAddKeydown,
    onAddPaste,
    setPinChapter,
    clearAllTimestamps,
    jumpToTimestamp,
    removeTimestamp,
    startEditTimestamp,
    commitEditTimestamp,
    onEditKeydown,
  } from "./controller";
  import { formatTime } from "../player-core";
</script>

<!-- Timestamps / chapters panel (play-002, frame 03) -->
<aside id="timestamps-panel" class="ts-panel" data-open={ui.panelOpen} aria-hidden={!ui.panelOpen}>
  <div class="ts-panel__head">
    <h2 class="ts-panel__title">Chapters</h2>
    <div class="ts-panel__head-right">
      <span id="timestamps-count" class="badge">{ui.timestamps.length === 0 ? "No timestamps yet." : ui.timestamps.length}</span>
      <button id="btn-timestamps-close" class="iconbtn iconbtn--sm" type="button" title="Close (Esc)" onclick={() => setPanelOpen(false)}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
    </div>
  </div>
  <div class="ts-panel__add">
    <button id="btn-add-timestamp" class="ts-panel__addbtn" type="button" onclick={() => void openAddInput()}>
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
      Add timestamp
    </button>
    <input
      id="timestamp-input"
      class="ts-panel__input"
      type="text"
      spellcheck="false"
      autocomplete="off"
      placeholder="00:01:30 Chapter title"
      hidden={!ui.addInputOpen}
      bind:this={els.tsAddInput}
      onkeydown={onAddKeydown}
      onpaste={onAddPaste}
      onblur={closeAddInput}
    />
    <p id="timestamp-hint" class="ts-panel__hint" hidden={!ui.addInputOpen}>
      Type <code>HH:MM:SS Title</code> and press Enter, or paste several lines at once.
    </p>
  </div>
  <label class="ts-setting">
    <input
      id="pin-chapter-toggle"
      class="ts-setting__input"
      type="checkbox"
      checked={ui.pinChapter}
      onchange={(e) => {
        setPinChapter(e.currentTarget.checked);
        e.currentTarget.blur();
      }}
    />
    <span class="ts-setting__switch" aria-hidden="true"></span>
    <span class="ts-setting__text">Always show current chapter</span>
  </label>
  <div class="ts-panel__list-head">
    <p class="ts-panel__label">JUMP TO CHAPTER</p>
    <button id="btn-clear-timestamps" class="ts-panel__clear" type="button" hidden={ui.timestamps.length === 0} onclick={clearAllTimestamps}>
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
      Clear all
    </button>
  </div>
  <ul id="timestamps-list" class="ts-list" aria-label="Timestamps">
    {#each ui.timestamps as ts, i (ts.time + " " + ts.title)}
      {@const editing = i === ui.editingTsIndex}
      {@const tc = formatTime(ts.time)}
      <li
        class="ts-list__item"
        data-active={i === ui.activeTsIndex ? "true" : undefined}
        data-editing={editing ? "true" : undefined}
      >
        {#if editing}
          <input
            class="ts-list__edit"
            type="text"
            spellcheck="false"
            autocomplete="off"
            aria-label="Edit timestamp {ts.title}"
            value={ts.title && ts.title !== tc ? `${tc} ${ts.title}` : tc}
            bind:this={els.tsEditInput}
            onkeydown={(e) => onEditKeydown(e, i)}
            onblur={() => commitEditTimestamp(i)}
          />
        {:else}
          <button type="button" class="ts-list__jump" onclick={() => jumpToTimestamp(ts)}>
            <span class="ts-list__time">{tc}</span>
            <span class="ts-list__title">{ts.title}</span>
          </button>
          <button type="button" class="ts-list__edit-btn" title="Edit timestamp" aria-label="Edit {ts.title}" onclick={(e) => { e.stopPropagation(); void startEditTimestamp(i); }}>
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          </button>
          <button type="button" class="ts-list__remove" title="Remove timestamp" aria-label="Remove {ts.title}" onclick={(e) => { e.stopPropagation(); removeTimestamp(i); }}>
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        {/if}
      </li>
    {/each}
  </ul>
</aside>

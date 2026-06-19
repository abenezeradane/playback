<script lang="ts">
  import { ui } from "./state.svelte";
  import { setQueueOpen, setRepeatAll, setAutoplay, openQueueItem } from "./controller";
</script>

<!-- Folder queue / playlist panel (play-013). Right-side panel mirroring the
     Chapters panel: the folder's videos in order, current item highlighted,
     click any row to jump. Mutually exclusive with the Chapters panel. -->
<aside id="queue-panel" class="ts-panel q-panel" data-open={ui.queueOpen} aria-hidden={!ui.queueOpen}>
  <div class="ts-panel__head">
    <h2 class="ts-panel__title">Up Next</h2>
    <div class="ts-panel__head-right">
      <span class="badge">{ui.queue.length === 0 ? "No videos" : `${ui.queueIndex + 1} / ${ui.queue.length}`}</span>
      <button id="btn-queue-close" class="iconbtn iconbtn--sm" type="button" title="Close (Esc)" onclick={() => setQueueOpen(false)}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
    </div>
  </div>

  <label class="ts-setting">
    <input
      id="autoplay-toggle"
      class="ts-setting__input"
      type="checkbox"
      checked={ui.autoplay}
      onchange={(e) => {
        setAutoplay(e.currentTarget.checked);
        e.currentTarget.blur();
      }}
    />
    <span class="ts-setting__switch" aria-hidden="true"></span>
    <span class="ts-setting__text">
      Autoplay next
      <span class="ts-setting__hint">{ui.autoplay ? "plays the next video automatically" : "asks before the next video"}</span>
    </span>
  </label>

  <label class="ts-setting">
    <input
      id="repeat-all-toggle"
      class="ts-setting__input"
      type="checkbox"
      checked={ui.repeatAll}
      onchange={(e) => {
        setRepeatAll(e.currentTarget.checked);
        e.currentTarget.blur();
      }}
    />
    <span class="ts-setting__switch" aria-hidden="true"></span>
    <span class="ts-setting__text">Repeat all</span>
  </label>

  <div class="ts-panel__list-head">
    <p class="ts-panel__label">{ui.queueLabel}</p>
  </div>

  <ul id="queue-list" class="ts-list q-list" aria-label="Folder queue">
    {#each ui.queue as item, i (item.path)}
      <li class="ts-list__item q-list__item" data-active={i === ui.queueIndex ? "true" : undefined}>
        <button type="button" class="ts-list__jump q-list__jump" title={item.path} onclick={() => openQueueItem(item)}>
          <span class="q-list__index" aria-hidden="true">
            {#if i === ui.queueIndex}
              <svg class="ic ic--fill" viewBox="0 0 24 24"><polygon points="8 5 19 12 8 19 8 5" /></svg>
            {:else}
              {i + 1}
            {/if}
          </span>
          <span class="q-list__name">{item.name}</span>
        </button>
      </li>
    {/each}
  </ul>
</aside>

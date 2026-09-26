<script lang="ts">
  import { ui, actions } from "./state.svelte";
  import {
    closePlaylistEditor,
    renamePlaylistName,
    deletePlaylist,
    addVideosToPlaylist,
    addRecentToPlaylist,
    removeItemFromPlaylist,
    moveItemInPlaylist,
    activatePlaylist,
    isVideoPath,
  } from "./controller";
  import { findPlaylist } from "../player-core";

  /** The playlist currently being edited (re-derived as the store changes). */
  const pl = $derived(
    ui.editingPlaylistId ? findPlaylist(ui.playlists, ui.editingPlaylistId) : undefined,
  );

  /** Recent videos not already in this playlist — the "add from Recent" channel. */
  const recentToAdd = $derived(
    pl ? ui.recents.filter((r) => isVideoPath(r.path) && !pl.items.includes(r.path)) : [],
  );

  function basename(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
  }

  // Focus + select the name field when the editor opens (a fresh playlist starts
  // as "Untitled playlist", so select-all lets the user type a name straight away).
  let nameInput: HTMLInputElement | undefined = $state();
  $effect(() => {
    if (ui.playlistEditorOpen && nameInput) {
      nameInput.focus();
      nameInput.select();
    }
  });

  function onNameKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePlaylistEditor();
    }
  }
</script>

<!-- ===================== PLAYLIST EDITOR (play-014) =====================
     Reuses the .shortcuts overlay chrome (backdrop/panel/head). Create/rename a
     playlist, add videos (open dialog / drag-drop / from Recent), reorder with
     up/down, and remove items. Opening a playlist seeds the play-013 queue. -->
<div id="playlist-editor" class="shortcuts" data-open={ui.playlistEditorOpen} aria-hidden={!ui.playlistEditorOpen}>
  <button class="shortcuts__backdrop" type="button" aria-label="Close playlist editor" data-close="true" onclick={closePlaylistEditor}></button>
  <div class="shortcuts__panel pl-editor" role="dialog" aria-label="Edit playlist">
    {#if pl}
      {@const count = pl.items.length}
      <div class="shortcuts__head">
        <div class="shortcuts__heading">
          <span class="shortcuts__icon" aria-hidden="true">
            <svg class="ic" viewBox="0 0 24 24"><path d="M21 15V6" /><path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" /><path d="M12 12H3" /><path d="M16 6H3" /><path d="M12 18H3" /></svg>
          </span>
          <div class="pl-editor__heading">
            <input
              id="playlist-name"
              class="pl-editor__name"
              type="text"
              spellcheck="false"
              autocomplete="off"
              aria-label="Playlist name"
              maxlength="80"
              value={pl.name}
              bind:this={nameInput}
              onchange={(e) => renamePlaylistName(pl.id, e.currentTarget.value)}
              onkeydown={onNameKeydown}
            />
            <p class="shortcuts__sub">{count === 1 ? "1 video" : `${count} videos`} · saved locally</p>
          </div>
        </div>
        <div class="pl-editor__head-actions">
          <button id="btn-playlist-play" class="pill pill--primary pill--sm" type="button" disabled={count === 0} onclick={() => activatePlaylist(pl.id)}>
            <svg class="ic ic--fill" viewBox="0 0 24 24"><polygon points="8 5 19 12 8 19 8 5" /></svg>
            Play
          </button>
          <button id="btn-playlist-close" class="iconbtn iconbtn--sm" type="button" title="Close (Esc)" onclick={closePlaylistEditor}>
            <svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        </div>
      </div>

      <div class="pl-editor__body">
        <!-- android-001: a phone has no picker that fits the path model and no
             window to drag files into, so it adds from Recent only. -->
        {#if actions.openDialogs}
          <div class="pl-editor__toolbar">
            <button id="btn-add-videos" class="ts-panel__addbtn" type="button" onclick={() => void addVideosToPlaylist(pl.id)}>
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
              Add videos
            </button>
            <span class="pl-editor__hint">or drag files into the window</span>
          </div>
        {/if}

        <!-- "Add from Recent" sits above the items list so its rows stay put as the
             list below grows — a stable add zone (also what the smoke drives). -->
        {#if recentToAdd.length > 0}
          <div class="pl-editor__recent">
            <p class="ts-panel__label">ADD FROM RECENT</p>
            <ul id="playlist-recent" class="ts-list pl-recent" aria-label="Add from recent">
              {#each recentToAdd as r (r.path)}
                <li class="ts-list__item pl-recent-row">
                  <span class="pl-item__name" title={r.path}>{r.name}</span>
                  <button type="button" class="pl-recent__add" onclick={() => addRecentToPlaylist(pl.id, r.path)}>
                    <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
                    Add
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        <p class="ts-panel__label pl-items__label">PLAYLIST ORDER</p>
        <ul id="playlist-items" class="ts-list pl-items" aria-label="Playlist items">
          {#each pl.items as path, i (path)}
            <li class="ts-list__item pl-item">
              <span class="q-list__index" aria-hidden="true">{i + 1}</span>
              <span class="pl-item__name" title={path}>{basename(path)}</span>
              <button type="button" class="pl-item__move" title="Move up" aria-label="Move up" disabled={i === 0} onclick={() => moveItemInPlaylist(pl.id, i, -1)}>
                <svg class="ic" viewBox="0 0 24 24"><path d="m18 15-6-6-6 6" /></svg>
              </button>
              <button type="button" class="pl-item__move" title="Move down" aria-label="Move down" disabled={i === count - 1} onclick={() => moveItemInPlaylist(pl.id, i, 1)}>
                <svg class="ic" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              <button type="button" class="ts-list__remove pl-item__remove" title="Remove" aria-label="Remove {basename(path)}" onclick={() => removeItemFromPlaylist(pl.id, i)}>
                <svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </li>
          {/each}
          {#if count === 0}
            <li class="pl-empty-row">
              {actions.openDialogs
                ? "No videos yet — add some above, drag files in, or pick from Recent."
                : "No videos yet — pick some from Recent."}
            </li>
          {/if}
        </ul>

        <div class="pl-editor__footer">
          <button id="btn-delete-playlist" class="ts-panel__clear" type="button" onclick={() => deletePlaylist(pl.id)}>
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            Delete playlist
          </button>
          <button class="pill pill--ghost pill--sm" type="button" onclick={closePlaylistEditor}>Done</button>
        </div>
      </div>
    {/if}
  </div>
</div>

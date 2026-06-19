<script lang="ts">
  import { ui } from "./state.svelte";
  import { setSettingsOpen, setHwaccel } from "./controller";
</script>

<!-- ===================== SETTINGS OVERLAY (play-010) =====================
     Reuses the .shortcuts overlay chrome (backdrop/panel/head) so it matches the
     keyboard-shortcuts dialog; the body holds the Hardware acceleration toggle. -->
<div id="settings-overlay" class="shortcuts" data-open={ui.settingsOpen} aria-hidden={!ui.settingsOpen}>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="shortcuts__backdrop" data-close="true" onclick={() => setSettingsOpen(false)}></div>
  <div class="shortcuts__panel" role="dialog" aria-label="Settings">
    <div class="shortcuts__head">
      <div class="shortcuts__heading">
        <span class="shortcuts__icon" aria-hidden="true">
          <svg class="ic" viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
        </span>
        <div>
          <h2 class="shortcuts__title">Settings</h2>
          <p class="shortcuts__sub">Preferences are stored locally — no account.</p>
        </div>
      </div>
      <button id="btn-settings-close" class="iconbtn iconbtn--sm" type="button" title="Close (Esc)" onclick={() => setSettingsOpen(false)}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
    </div>

    <div class="settings__body">
      <p class="shortcuts__group">PLAYBACK</p>
      <label class="settings__row">
        <span class="settings__row-text">
          <span class="settings__row-title">Hardware acceleration</span>
          <span class="settings__row-desc">Use the GPU to decode video for smooth high-resolution playback and low CPU. Turn off if your GPU/driver shows green, black or torn frames.</span>
        </span>
        <input
          id="hwaccel-toggle"
          class="ts-setting__input"
          type="checkbox"
          checked={ui.hwaccel}
          onchange={(e) => {
            setHwaccel(e.currentTarget.checked);
            e.currentTarget.blur();
          }}
        />
        <span class="ts-setting__switch" aria-hidden="true"></span>
      </label>

      {#if ui.hwaccelRestartHint}
        <p class="settings__hint" role="status" aria-live="polite">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
          Restart Playback to apply this change.
        </p>
      {/if}
    </div>
  </div>
</div>

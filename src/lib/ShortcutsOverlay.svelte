<script lang="ts">
  import { ui } from "./state.svelte";
  import { setShortcutsOpen } from "./controller";
</script>

<!-- ===================== KEYBOARD SHORTCUTS OVERLAY (frame 05) ===================== -->
<div id="shortcuts-overlay" class="shortcuts" data-open={ui.shortcutsOpen} aria-hidden={!ui.shortcutsOpen}>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="shortcuts__backdrop" data-close="true" onclick={() => setShortcutsOpen(false)}></div>
  <div class="shortcuts__panel" role="dialog" aria-label="Keyboard shortcuts">
    <div class="shortcuts__head">
      <div class="shortcuts__heading">
        <span class="shortcuts__icon" aria-hidden="true">
          <svg class="ic" viewBox="0 0 24 24"><rect width="20" height="16" x="2" y="4" rx="2" /><path d="M6 8h.01" /><path d="M10 8h.01" /><path d="M14 8h.01" /><path d="M18 8h.01" /><path d="M8 12h.01" /><path d="M12 12h.01" /><path d="M16 12h.01" /><path d="M7 16h10" /></svg>
        </span>
        <div>
          <h2 class="shortcuts__title">Keyboard shortcuts</h2>
          <p class="shortcuts__sub">Control playback without touching the mouse.</p>
        </div>
      </div>
      <button id="btn-keys-close" class="iconbtn iconbtn--sm" type="button" title="Close (Esc)" onclick={() => setShortcutsOpen(false)}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
    </div>
    <div class="shortcuts__cols">
      <div class="shortcuts__col">
        <p class="shortcuts__group">PLAYBACK</p>
        <ul class="keys">
          <li><span>Play / pause</span><span class="keys__caps"><kbd class="kbd">Space</kbd></span></li>
          <li><span>Back / forward 10s</span><span class="keys__caps"><kbd class="kbd">&larr;</kbd><kbd class="kbd">&rarr;</kbd></span></li>
          <li><span>Jump to %</span><span class="keys__caps"><kbd class="kbd">0</kbd><kbd class="kbd">&ndash;</kbd><kbd class="kbd">9</kbd></span></li>
          <li><span>Volume up / down</span><span class="keys__caps"><kbd class="kbd">&uarr;</kbd><kbd class="kbd">&darr;</kbd></span></li>
          <li><span>Speed up / down</span><span class="keys__caps"><kbd class="kbd">+</kbd><kbd class="kbd">&minus;</kbd></span></li>
          <li><span>Mute</span><span class="keys__caps"><kbd class="kbd">M</kbd></span></li>
          <li><span>Loop / repeat</span><span class="keys__caps"><kbd class="kbd">R</kbd></span></li>
          <li><span>Set A-B loop in / out</span><span class="keys__caps"><kbd class="kbd">I</kbd><kbd class="kbd">B</kbd></span></li>
          <li><span>Fullscreen</span><span class="keys__caps"><kbd class="kbd">F</kbd></span></li>
          <li><span>Picture-in-picture</span><span class="keys__caps"><kbd class="kbd">P</kbd></span></li>
          <li><span>Open a file</span><span class="keys__caps"><kbd class="kbd">O</kbd></span></li>
        </ul>
      </div>
      <div class="shortcuts__col">
        <p class="shortcuts__group">CHAPTERS &amp; TIMESTAMPS</p>
        <ul class="keys">
          <li><span>Previous / next chapter</span><span class="keys__caps"><kbd class="kbd">A</kbd><kbd class="kbd">D</kbd></span></li>
          <li><span>Toggle chapters panel</span><span class="keys__caps"><kbd class="kbd">T</kbd></span></li>
        </ul>
        <p class="shortcuts__group">TIMELINE (CUT VIEW)</p>
        <ul class="keys">
          <li><span>Toggle timeline view</span><span class="keys__caps"><kbd class="kbd">C</kbd></span></li>
          <li><span>Shuttle reverse / stop / forward</span><span class="keys__caps"><kbd class="kbd">J</kbd><kbd class="kbd">K</kbd><kbd class="kbd">L</kbd></span></li>
          <li><span>Jump to start / end</span><span class="keys__caps"><kbd class="kbd">Home</kbd><kbd class="kbd">End</kbd></span></li>
        </ul>
        <p class="shortcuts__group">ANIMATED IMAGE (GIF)</p>
        <ul class="keys">
          <li><span>Play / pause</span><span class="keys__caps"><kbd class="kbd">Space</kbd></span></li>
          <li><span>Previous / next frame</span><span class="keys__caps"><kbd class="kbd">,</kbd><kbd class="kbd">.</kbd></span></li>
          <li><span>Speed up / down</span><span class="keys__caps"><kbd class="kbd">+</kbd><kbd class="kbd">&minus;</kbd></span></li>
        </ul>
        <p class="shortcuts__group">GENERAL</p>
        <ul class="keys">
          <li><span>This help</span><span class="keys__caps"><kbd class="kbd">?</kbd></span></li>
          <li><span>Close panel / help</span><span class="keys__caps"><kbd class="kbd">Esc</kbd></span></li>
        </ul>
      </div>
    </div>
  </div>
</div>

<script lang="ts">
  import { ui } from "./state.svelte";
  import { confirmNextPrompt, closeNextPrompt } from "./controller";
</script>

<!-- End-of-video "Up Next" prompt (play-018). Shown when a queue item ends while
     autoplay is OFF (the default): instead of auto-advancing, ask the user whether
     to play the next clip. Enter confirms / Esc dismisses (wired in the keyboard
     handler); the autoplay toggle in the queue panel skips this prompt entirely. -->
{#if ui.nextPromptOpen}
  <div id="next-prompt" class="next-prompt" role="dialog" aria-label="Play next video" aria-live="polite">
    <div class="next-prompt__card">
      <p class="next-prompt__label">UP NEXT</p>
      <p class="next-prompt__name" title={ui.nextPromptName}>{ui.nextPromptName}</p>
      <div class="next-prompt__actions">
        <button
          id="btn-next-confirm"
          type="button"
          class="next-prompt__btn next-prompt__btn--primary"
          onclick={confirmNextPrompt}
        >
          <svg class="ic ic--fill" viewBox="0 0 24 24" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4" /></svg>
          Play next
        </button>
        <button id="btn-next-dismiss" type="button" class="next-prompt__btn" onclick={closeNextPrompt}>
          Not now
        </button>
      </div>
      <p class="next-prompt__hint">Turn on “Autoplay next” in the queue panel to skip this.</p>
    </div>
  </div>
{/if}

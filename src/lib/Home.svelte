<script lang="ts">
  import { ui } from "./state.svelte";
  import { openFileDialog, clearRecents, openRecent } from "./controller";
  import { formatTime } from "../player-core";

  /** "just now" / "5m ago" / "3h ago" / "yesterday" / … (former main.ts helper). */
  function timeAgo(ts: number): string {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d === 1) return "yesterday";
    if (d < 7) return `${d} days ago`;
    const w = Math.floor(d / 7);
    return w === 1 ? "last week" : `${w} weeks ago`;
  }

  /** A stable accent gradient derived from the filename (stands in for a thumbnail). */
  function thumbGradient(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return `linear-gradient(135deg, hsl(${hue} 60% 42%), hsl(${(hue + 38) % 360} 55% 20%))`;
  }
</script>

<!-- ===================== HOME / EMPTY STATE (frame 01) ===================== -->
<section id="empty-state" class="home" hidden={ui.view !== "empty"}>
  <div class="home__ambient" aria-hidden="true"></div>
  <div class="home__glow" aria-hidden="true"></div>

  <div class="home__main">
    <!-- Top bar -->
    <header class="home__top" data-tauri-drag-region>
      <div class="home__brand">
        <span class="home__mark" aria-hidden="true">
          <svg class="ic ic--fill" viewBox="0 0 24 24"><polygon points="7 4 20 12 7 20 7 4" /></svg>
        </span>
        <span class="home__name">Playback</span>
      </div>
      <button id="btn-open-top" class="home__openfile" type="button" onclick={() => void openFileDialog()}>
        <svg class="ic" viewBox="0 0 24 24"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></svg>
        Open file
      </button>
    </header>

    <div class="home__body">
      <!-- Hero / Drop Zone — single centered card -->
      <section class="home-hero">
        <button id="drop-zone" class="dropzone" type="button" aria-label="Open a video" onclick={() => void openFileDialog()}></button>
        <div class="home-hero__inner">
          <span class="dropzone__chip" aria-hidden="true">
            <svg class="ic" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M7 3v18" /><path d="M3 7.5h4" /><path d="M3 12h18" /><path d="M3 16.5h4" /><path d="M17 3v18" /><path d="M17 7.5h4" /><path d="M17 16.5h4" /></svg>
          </span>
          <span class="dropzone__title">Open a video to begin</span>
          <span class="dropzone__sub">Drag and drop a file anywhere in the window, or browse your computer. MP4, WebM, MKV, MOV, animated GIF and more — no account, all local.</span>
          <div class="home-hero__cta">
            <button id="btn-open" class="pill pill--primary" type="button" onclick={() => void openFileDialog()}>
              <svg class="ic" viewBox="0 0 24 24"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></svg>
              Open a video
            </button>
            <span class="home-hero__hint"><kbd class="kbd">O</kbd> to open</span>
          </div>

          <span class="dropzone__formats" aria-hidden="true"><span>MP4</span><span>WEBM</span><span>MKV</span><span>MOV</span><span>AVI</span><span>GIF</span></span>
        </div>
      </section>

      <!-- Recent (local file history; no account) -->
      <section class="recent">
        <div class="recent__head">
          <div class="recent__title">
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></svg>
            Recent
          </div>
          <button id="btn-clear-recent" class="recent__clear" type="button" hidden={ui.recents.length === 0} onclick={clearRecents}>
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            Clear
          </button>
        </div>
        <div id="recent-cards" class="recent__cards" hidden={ui.recents.length === 0}>
          {#each ui.recents as r (r.path)}
            <button type="button" class="recent-card" title={r.path} onclick={() => openRecent(r)}>
              <span class="recent-card__thumb" style="background: {thumbGradient(r.name)}">
                <span class="recent-card__play">
                  <svg class="ic ic--fill" viewBox="0 0 24 24"><polygon points="8 5 19 12 8 19 8 5" /></svg>
                </span>
                {#if r.duration}
                  <span class="recent-card__dur">{formatTime(r.duration)}</span>
                {/if}
              </span>
              <span class="recent-card__meta">
                <span class="recent-card__name">{r.name}</span>
                <span class="recent-card__sub">Opened {timeAgo(r.openedAt)}</span>
              </span>
            </button>
          {/each}
        </div>
        <div id="recent-empty" class="recent__empty" hidden={ui.recents.length > 0}>
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="m10 13 4 2.5L10 18z" /></svg>
          <span>Recently opened files will appear here.</span>
        </div>
      </section>

      <!-- Features -->
      <section class="features">
        <div class="feature-card">
          <span class="feature-card__chip" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24"><path d="M12 12H3" /><path d="M16 6H3" /><path d="M12 18H3" /><path d="m16 12 5 3-5 3z" /></svg></span>
          <h3 class="feature-card__title">Chapters &amp; timestamps</h3>
          <p class="feature-card__desc">Jump to any chapter and edit timestamps inline.</p>
        </div>
        <div class="feature-card">
          <span class="feature-card__chip" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" /><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" /><circle cx="12" cy="12" r="2" /><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" /><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" /></svg></span>
          <h3 class="feature-card__title">Livestream</h3>
          <p class="feature-card__desc">Livestream playback is temporarily unavailable.</p>
        </div>
        <div class="feature-card">
          <span class="feature-card__chip" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24"><rect width="20" height="16" x="2" y="4" rx="2" /><path d="M6 8h.01" /><path d="M10 8h.01" /><path d="M14 8h.01" /><path d="M18 8h.01" /><path d="M8 12h.01" /><path d="M12 12h.01" /><path d="M16 12h.01" /><path d="M7 16h10" /></svg></span>
          <h3 class="feature-card__title">Keyboard shortcuts</h3>
          <p class="feature-card__desc">Control playback fully from the keyboard.</p>
        </div>
      </section>

      <p id="empty-error" class="home__error" role="alert" hidden={!ui.emptyError}>{ui.emptyError}</p>
    </div>
  </div>
</section>

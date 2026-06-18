import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Plain Svelte (no SvelteKit): this is a single-window Tauri SPA with no server,
// so there is no adapter/SSR/routing here. vitePreprocess enables
// <script lang="ts"> in components, keeping TypeScript across the app.
export default {
  preprocess: vitePreprocess(),
};

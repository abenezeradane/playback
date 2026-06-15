import { defineConfig } from "vite";

// Tauri expects a fixed dev port and a relative base so the built assets
// resolve correctly inside the webview.
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

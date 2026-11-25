import { defineConfig } from "vite";
import { resolve } from "node:path";

// MV3 extension build.
// - HTML pages (panel, options) are emitted at their source-relative paths under dist/.
// - The background service worker is emitted as dist/background.js (module worker).
// - The deterministic extractor is NOT a build entry: it is a self-contained function
//   bundled into the panel and injected at runtime via chrome.scripting.executeScript({ func }).
// - public/ (manifest.json, icons) is copied verbatim into dist/.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
    modulePreload: false,
    rollupOptions: {
      input: {
        panel: resolve(__dirname, "src/panel/index.html"),
        options: resolve(__dirname, "src/options/index.html"),
        studio: resolve(__dirname, "src/studio/index.html"),
        background: resolve(__dirname, "src/background/service-worker.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});

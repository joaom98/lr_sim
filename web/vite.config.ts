import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // Shared data files live in ../data, outside the web root.
  server: { fs: { allow: [".."] } },
  build: {
    target: "es2022",
    // three.js alone is ~500 kB; the range page is one scene, so one chunk is fine.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        calculator: resolve(__dirname, "index.html"),
        range: resolve(__dirname, "range.html"),
      },
    },
  },
});

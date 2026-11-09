import { defineConfig } from "vite";

export default defineConfig({
  // Shared data files live in ../data, outside the web root.
  server: { fs: { allow: [".."] } },
  build: { target: "es2022" },
});

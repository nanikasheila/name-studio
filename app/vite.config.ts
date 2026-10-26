/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Tauri expects a fixed dev server port and serves the built files itself.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  // The structure test reads every module through import.meta.glob: a module
  // cache kept between runs would miss a module added or removed since.
  test: { fsModuleCache: false },
});

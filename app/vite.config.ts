/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Tauri expects a fixed dev server port and serves the built files itself.
export default defineConfig({
  clearScreen: false,
  // The 相談's help reads the user guide (../docs/guide.md) as text.
  server: { port: 1420, strictPort: true, fs: { allow: [".", "../docs"] } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  // The structure test reads every module through import.meta.glob: a module
  // cache kept between runs would miss a module added or removed since.
  // styles.css is read as text by look.test.ts (Vitest gives a stylesheet no text otherwise).
  test: { fsModuleCache: false, css: { include: [/styles\.css/] } },
});

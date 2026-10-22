import { defineConfig } from "vite";

// Tauri expects a fixed dev server port and serves the built files itself.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});

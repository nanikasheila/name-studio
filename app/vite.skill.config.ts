import { defineConfig } from "vite";

// The Skills' command line: src/skill/cli.ts with the name code it uses, as
// one file Node runs (skills/name-studio/scripts/namestudio.mjs).
export default defineConfig({
  clearScreen: false,
  logLevel: "warn",
  build: {
    ssr: "src/skill/cli.ts",
    outDir: "../skills/name-studio/scripts",
    emptyOutDir: false,
    target: "node18",
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: "namestudio.mjs",
        format: "es",
        banner: "#!/usr/bin/env node\n// Name Studio の .namestudio を読み書きするコマンド（GPL-3.0-or-later）。\n// app/src から `npm run build:skill` で作るので、直接は直さないこと。",
      },
    },
  },
  ssr: { noExternal: true },
});

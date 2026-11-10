/// <reference types="vite/client" />
// Keeps the module structure as designed: a folder is a pace layer, the name
// data's types (model/) at the bottom, and no import cycles, so that a module
// can be read, tested and changed without the ones above it.
import { describe, expect, it } from "vitest";

/**
 * Pace layers, slowest first: a module may import from its own layer and the
 * ones below, never from above. The name data's types change least (they are
 * the file format); the screens change most. A module's folder is its layer,
 * so a new one is placed on purpose.
 */
const LAYERS = {
  /** The name data's types and plane geometry: the file format. */
  model: "model",
  /**
   * The name and what can be done to it: panels, dialogue, rough lines, the
   * story, reading and writing its formats. Pure computation, no browser, no
   * storage, no Rust side, and nothing of the editor's screen.
   */
  domain: "domain",
  /**
   * The editor's own computation, still pure: where pages lie on screen and
   * what is under the pointer, the view, undo, the open name, the commands,
   * keys, tools and their help (which change with the screens, faster than the
   * name's vocabulary).
   */
  editing: "editing",
  /** This computer and the Rust side: storage, settings, commands, the page's elements. */
  platform: "platform",
  /** Drawing a name on a canvas (the screen and the export share it). */
  render: "render",
  /** Work done for the screens: saving in the background, writing out. */
  service: "service",
  /** The screens. */
  ui: "ui",
  /** Starting the app: puts the rest together (main.ts, beside the folders). */
  app: "",
} as const;

/**
 * How long these modules may grow before they are split again. Lines are counted
 * as the formatter lays them out (`npm run format`), so the numbers mean the same
 * for everyone.
 */
const WORKBENCH_LINES = 1100;
const BOARD_LINES = 720;
const EDITOR_LINES = 1400;
const EDITOR_PART_LINES = 650;

const ORDER = Object.keys(LAYERS) as (keyof typeof LAYERS)[];
const FOLDERS: string[] = ORDER.map((layer) => LAYERS[layer]);

/** Every module (not the tests), by its path from here: "ui/editor.ts", "main.ts". */
const sources: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(["./*.ts", "./*/*.ts", "!./**/*.test.ts", "!./**/*.d.ts", "!./generated/**", "!./skill/**"], {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([path, source]) => [path.slice(2), source]),
);

/** What is not a layer: written by the Rust side's tools (types only), and the AI skill's own entry. */
const OUTSIDE = ["generated", "skill"];

const folderOf = (file: string): string => (file.includes("/") ? file.slice(0, file.indexOf("/")) : "");
const rankOf = (file: string): number => FOLDERS.indexOf(folderOf(file));

/** The path a module's import points at, from src: ("ui/editor.ts", "../domain/koma") → "domain/koma.ts". */
function resolve(from: string, spec: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const step of spec.split("/")) {
    if (step === "..") parts.pop();
    else if (step !== ".") parts.push(step);
  }
  return `${parts.join("/")}.ts`;
}

/** Local modules each module imports (types too). */
function imports(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [file, source] of Object.entries(sources)) {
    const found = [...source.matchAll(/^(?:import|export)\b[^;]*?from "(\.\.?\/[\w/.-]+)"/gms)]
      .map((m) => resolve(file, m[1]))
      .filter((other) => !OUTSIDE.includes(folderOf(other)));
    graph.set(file, [...new Set(found)]);
  }
  return graph;
}

describe("module structure", () => {
  it("has every module in a layer's folder", () => {
    const folders = [...new Set(Object.keys(sources).map(folderOf))].sort();
    expect(folders).toEqual([...FOLDERS].sort());
    // Beside the folders: only the entry.
    expect(Object.keys(sources).filter((file) => !file.includes("/"))).toEqual(["main.ts"]);
  });

  it("imports only modules that are there", () => {
    const missing = [...imports()].flatMap(([file, used]) =>
      used.filter((other) => !(other in sources)).map((other) => `${file} → ${other}`),
    );
    expect(missing).toEqual([]);
  });

  it("has the name data's types at the bottom", () => {
    expect(imports().get("model/model.ts")).toEqual([]);
  });

  it("has geometry depend on the types only", () => {
    expect(imports().get("model/geometry.ts")).toEqual(["model/model.ts"]);
  });

  it("calls the Rust side only through backend.ts", () => {
    const callers = Object.entries(sources)
      .filter(([, source]) => source.includes('"@tauri-apps/api/core"'))
      .map(([file]) => file);
    expect(callers).toEqual(["platform/backend.ts"]);
  });

  it("opens the system's dialogs only through dialogs.ts", () => {
    // A file is picked on the Rust side, which remembers the place (the commands that write take no other).
    const callers = Object.entries(sources)
      .filter(([, source]) => source.includes('"@tauri-apps/plugin-dialog"'))
      .map(([file]) => file);
    expect(callers).toEqual(["platform/dialogs.ts"]);
  });

  it("keeps the editor around the pages to putting its parts together", () => {
    // The bars, the 資料 pictures, the changes the palettes ask for: their own modules.
    expect(sources["ui/workbench.ts"].split("\n").length).toBeLessThan(WORKBENCH_LINES);
  });

  it("keeps each lane of 物語の帯 in its own module", () => {
    // board.ts puts the lanes on one page axis; each lane draws and edits in board*.ts.
    for (const [file, source] of Object.entries(sources)) {
      if (/^ui\/board\w*\.ts$/.test(file)) expect(source.split("\n").length, file).toBeLessThan(BOARD_LINES);
      if (/^ui\/board\w+\.ts$/.test(file)) expect(source, file).not.toMatch(/from "\.\/board"/);
    }
  });

  it("keeps each tool's press and drags out of the page editor", () => {
    // Tools live in tool*.ts behind tools.ts; editor.ts dispatches, screendraw.ts draws.
    const editor = sources["ui/editor.ts"];
    expect(editor.split("\n").length).toBeLessThan(EDITOR_LINES);
    expect(editor).not.toMatch(/(?:tool|drag) satisfies never/);
    for (const [file, source] of Object.entries(sources)) {
      if (/^ui\/tool\w*\.ts$/.test(file)) expect(source, file).not.toMatch(/from "\.\/editor"/);
    }
  });

  it("keeps the page editor's parts apart", () => {
    // The pages on screen (editorstage), what is picked (editorpicks) and the drawing (editorpaint):
    // each knows the ones before it, none knows the editor that puts them together and hands out the input.
    const knows = (file: string) =>
      imports()
        .get(`ui/${file}`)
        ?.filter((other) => /^ui\/editor(?!core)\w*\.ts$/.test(other)) ?? [];
    expect(knows("editorstage.ts")).toEqual([]);
    expect(knows("editorpicks.ts")).toEqual(["ui/editorstage.ts"]);
    expect(knows("editorpaint.ts").sort()).toEqual(["ui/editorpicks.ts", "ui/editorstage.ts"]);
    for (const part of ["editorstage", "editorpicks", "editorpaint"])
      expect(sources[`ui/${part}.ts`].split("\n").length, part).toBeLessThan(EDITOR_PART_LINES);
    // Only the drawing draws: the other two have no canvas calls of their own.
    expect(sources["ui/editorpicks.ts"]).not.toMatch(/\bctx\b/);
  });

  it("imports only from the same pace layer or slower ones", () => {
    const upward: string[] = [];
    for (const [file, used] of imports()) {
      for (const other of used) {
        if (rankOf(other) > rankOf(file)) upward.push(`${file} (${ORDER[rankOf(file)]}) → ${other} (${ORDER[rankOf(other)]})`);
      }
    }
    expect(upward).toEqual([]);
  });

  it("keeps the browser, its storage and the Rust side out of the types and the computation", () => {
    const browser =
      /\b(?:document|window|localStorage|sessionStorage|createImageBitmap|requestAnimationFrame)\b|\bnew Image\b|"@tauri-apps\//;
    const found = Object.entries(sources)
      .filter(([file]) => rankOf(file) <= ORDER.indexOf("editing"))
      .filter(([, source]) => browser.test(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")))
      .map(([file]) => file);
    expect(found).toEqual([]);
  });

  it("has no import cycles", () => {
    const graph = imports();
    const cycles: string[] = [];
    const state = new Map<string, "open" | "done">();
    const visit = (file: string, trail: string[]): void => {
      if (state.get(file) === "done") return;
      if (state.get(file) === "open") {
        cycles.push([...trail.slice(trail.indexOf(file)), file].join(" → "));
        return;
      }
      state.set(file, "open");
      for (const next of graph.get(file) ?? []) visit(next, [...trail, file]);
      state.set(file, "done");
    };
    for (const file of graph.keys()) visit(file, []);
    expect(cycles).toEqual([]);
  });
});

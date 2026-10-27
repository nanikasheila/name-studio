/// <reference types="vite/client" />
// Keeps the module structure as designed: the name data's types (model.ts)
// and plane geometry (geometry.ts) at the bottom, and no import cycles, so
// that a module can be read, tested and changed without the ones above it.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["./*.ts", "!./*.test.ts"], { query: "?raw", import: "default", eager: true });

/** Local modules each module imports (types too), by file name. */
function imports(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [path, source] of Object.entries(sources)) {
    const found = [...source.matchAll(/^(?:import|export)\b[^;]*?from "\.\/([\w-]+)"/gms)].map((m) => `${m[1]}.ts`);
    graph.set(path.slice(2), [...new Set(found)]);
  }
  return graph;
}

/**
 * Pace layers, slowest first: a module may import from its own layer and the
 * ones below, never from above. The name data's types change least (they are
 * the file format); the screens change most. Every module is listed, so a new
 * one is placed on purpose.
 */
const LAYERS = {
  /** The name data's types and plane geometry: the file format. */
  model: ["model", "types", "geometry"],
  /** Working on a name: pure computation, no browser, no storage, no Rust side. */
  core: [
    "alternatives", "arrange", "aside", "autotail", "balloon", "brush", "callouts", "cast", "commands", "csppage", "dialogue", "export", "exportmemory", "fonts",
    "helptopics", "history", "hold", "koma", "komaedit", "layout", "mask", "mininame", "minisplit", "namecheck", "namedefaults", "pagebox", "pages", "panelfolders", "panels", "pen",
    "plotimport", "project", "projectjson", "readback", "readingorder", "recent", "references", "removal", "reorder", "repair", "roughlayers", "scriptimport",
    "savestate", "series", "session", "shapes", "shortcuts", "sketchpanels", "snapping", "snapshot", "springtool", "stickies", "story", "strokes", "structures", "style", "tidy", "transform", "viewport", "wrap",
  ],
  /** This computer and the Rust side: storage, settings, commands, the page's elements. */
  platform: ["backend", "dom", "errorlog", "prefs", "settings"],
  /** Drawing a name on a canvas (the screen and the export share it). */
  render: ["asidedraw", "glyph", "notedraw", "pagedraw", "pagethumb", "pictures", "render", "screendraw", "strokecache"],
  /** Work done for the screens: saving in the background, writing out. */
  service: ["autosave", "batch", "flatpage", "nameexport", "roughcache"],
  /** The screens. */
  ui: [
    "actions", "alerts", "altdialog", "board", "boarddock", "boardemotion", "boardpages", "boardscene", "boardshape", "boardview", "brushdialog", "controlbar", "cursors", "dock", "dragsort", "drophint", "editor", "editorcore", "exportdialog", "fontpicker", "helpbar", "helpoverlay", "imageimport", "inplace", "inspector",
    "layers", "livefields", "markbar", "nameedits", "palette", "palettes", "pendialog", "reader", "readbackpick", "referencebar", "roughpanel", "scriptdialog", "seriespanel", "settingsdialog", "sheetexport", "shortcutdialog", "sidelists", "startscreen", "toolaside", "tooleraser", "toolfill",
    "toolmark", "toolpanels", "toolpen", "toolreference", "tools", "toolselect", "toolsticky", "tooltext", "tooltransform", "tour", "updater", "versiondialog",
    "viewer", "workbench",
  ],
  /** Starting the app: puts the rest together. */
  app: ["main"],
} as const;

const ORDER = Object.keys(LAYERS) as (keyof typeof LAYERS)[];
const layerOf = new Map<string, number>(ORDER.flatMap((layer, rank) => LAYERS[layer].map((name) => [`${name}.ts`, rank] as [string, number])));

describe("module structure", () => {
  it("has the name data's types at the bottom", () => {
    expect(imports().get("model.ts")).toEqual([]);
  });

  it("has geometry depend on the types only", () => {
    expect(imports().get("geometry.ts")).toEqual(["model.ts"]);
  });

  it("calls the Rust side only through backend.ts", () => {
    const callers = Object.entries(sources)
      .filter(([, source]) => source.includes('"@tauri-apps/api/core"'))
      .map(([path]) => path.slice(2));
    expect(callers).toEqual(["backend.ts"]);
  });

  it("keeps the editor around the pages to putting its parts together", () => {
    // The bars, the 資料 pictures, the changes the palettes ask for: their own modules.
    expect(sources["./workbench.ts"].split("\n").length).toBeLessThan(1000);
  });

  it("keeps each lane of 物語の帯 in its own module", () => {
    // board.ts puts the lanes on one page axis; each lane draws and edits in board*.ts.
    for (const [path, source] of Object.entries(sources)) {
      if (/^\.\/board\w*\.ts$/.test(path)) expect(source.split("\n").length, path).toBeLessThan(650);
      if (/^\.\/board\w+\.ts$/.test(path)) expect(source, path).not.toMatch(/from "\.\/board"/);
    }
  });

  it("keeps each tool's press and drags out of the page editor", () => {
    // Tools live in tool*.ts behind tools.ts; editor.ts dispatches, screendraw.ts draws.
    const editor = sources["./editor.ts"];
    expect(editor.split("\n").length).toBeLessThan(2400);
    expect(editor).not.toMatch(/(?:tool|drag) satisfies never/);
    for (const [path, source] of Object.entries(sources)) {
      if (/^\.\/tool\w*\.ts$/.test(path)) expect(source, path).not.toMatch(/from "\.\/editor"/);
    }
  });

  it("places every module in a pace layer", () => {
    const unplaced = [...imports().keys()].filter((file) => !layerOf.has(file));
    const gone = [...layerOf.keys()].filter((file) => !imports().has(file));
    expect({ unplaced, gone }).toEqual({ unplaced: [], gone: [] });
  });

  it("imports only from the same pace layer or slower ones", () => {
    const upward: string[] = [];
    for (const [file, used] of imports()) {
      const rank = layerOf.get(file) ?? 0;
      for (const other of used) {
        const otherRank = layerOf.get(other) ?? 0;
        if (otherRank > rank) upward.push(`${file} (${ORDER[rank]}) → ${other} (${ORDER[otherRank]})`);
      }
    }
    expect(upward).toEqual([]);
  });

  it("keeps the browser, its storage and the Rust side out of the types and the computation", () => {
    const browser = /\b(?:document|window|localStorage|sessionStorage|createImageBitmap|requestAnimationFrame)\b|\bnew Image\b|"@tauri-apps\//;
    const found = [...layerOf]
      .filter(([, rank]) => rank <= ORDER.indexOf("core"))
      .filter(([file]) => browser.test(sources[`./${file}`].replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")))
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

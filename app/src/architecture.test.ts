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

describe("module structure", () => {
  it("has the name data's types at the bottom", () => {
    expect(imports().get("model.ts")).toEqual([]);
  });

  it("has geometry depend on the types only", () => {
    expect(imports().get("geometry.ts")).toEqual(["model.ts"]);
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

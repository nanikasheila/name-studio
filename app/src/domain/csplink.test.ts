import { describe, expect, it } from "vitest";
import { addBrushes, brushFromSubTool, type CspSubTool } from "./brush";
import { brushFor, groupKey, settingsStamp, stateOf, syncPlan, takeTools, untold } from "./csplink";
import { newProject } from "./project";

function tool(uuid: string, name: string, settings: Record<string, number> = { BrushSize: 10 }, group = ["ペン", "ペン"]): CspSubTool {
  return {
    uuid,
    name,
    group,
    kind: "pen",
    size: { value: settings.BrushSize ?? 10, unit: "px" },
    sizeDynamics: null,
    opacity: 1,
    opacityDynamics: null,
    flow: 1,
    flowDynamics: null,
    hardness: 1,
    antiAlias: 2,
    stabilization: 6,
    stabilizationBySpeed: false,
    postCorrection: 0,
    taperIn: null,
    taperOut: null,
    taperMin: 0,
    interval: 10,
    thickness: 100,
    rotation: 0,
    tipMaterial: null,
    tip: null,
    vectorErase: null,
    csp: { settings: { ...settings }, node: { NodeName: name, NodeInputOp: 10, NodeOutputOp: 10 }, manager: {}, dpi: 0 },
  };
}

describe("settingsStamp", () => {
  it("does not depend on the order of the columns, and changes with a value", () => {
    expect(settingsStamp({ A: 1, B: "x" })).toBe(settingsStamp({ B: "x", A: 1 }));
    expect(settingsStamp({ A: 1, B: "x" })).not.toBe(settingsStamp({ A: 2, B: "x" }));
    expect(settingsStamp({ A: { blob: "AAAA" } })).not.toBe(settingsStamp({ A: { blob: "AAAB" } }));
    expect(settingsStamp({})).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("taking CSP's sub tools", () => {
  it("links what is taken, and takes it again over the same brush", () => {
    const project = newProject("ペン", 1);
    const [g] = takeTools(project, [tool("aa", "Gペン")], 600);
    expect(g.cspLink).toEqual({ uuid: "aa", stamp: settingsStamp({ BrushSize: 10 }), name: "Gペン" });
    expect(g.sizeMm).toBeCloseTo((10 * 25.4) / 600);
    project.pages[0].strokes.push({ id: "s1", points: [], widthMm: 1, closed: false, brush: g.id });

    // Changed in CSP: the same brush (lines drawn with it follow), at the resolution it had.
    const [again] = takeTools(project, [tool("aa", "Gペン", { BrushSize: 20 })], 300);
    expect(project.brushes).toHaveLength(1);
    expect(again.id).toBe(g.id);
    expect(again.sizeMm).toBeCloseTo((20 * 25.4) / 600);
    expect(again.cspLink?.stamp).toBe(settingsStamp({ BrushSize: 20 }));
  });

  it("keeps a name changed here, and follows a name changed in CSP", () => {
    const project = newProject("ペン", 1);
    const [g] = takeTools(project, [tool("aa", "Gペン")], 600);
    takeTools(project, [tool("aa", "Gペン改")], 600);
    expect(g.name).toBe("Gペン改");
    g.name = "主線";
    takeTools(project, [tool("aa", "Gペン改２", { BrushSize: 12 })], 600);
    expect(g.name).toBe("主線");
    expect(g.cspLink?.name).toBe("Gペン改２");
  });

  it("finds brushes taken before links by their name and place, and links them when taken again", () => {
    const project = newProject("ペン", 1);
    const old = { ...tool("aa", "丸ペン") };
    addBrushes(project, [brushFromSubTool(old, 600, "")]);
    expect(brushFor(project.brushes, old)).toBe(project.brushes[0]);
    expect(stateOf(old, project.brushes[0])).toBe("same");
    expect(stateOf(tool("aa", "丸ペン", { BrushSize: 3 }), project.brushes[0])).toBe("differs");
    takeTools(project, [old], 600);
    expect(project.brushes).toHaveLength(1);
    expect(project.brushes[0].cspLink?.uuid).toBe("aa");
  });
});

describe("how a sub tool stands, and what reading CSP again changes", () => {
  const project = newProject("ペン", 1);
  const [a, b, c] = takeTools(project, [tool("a", "A"), tool("b", "B"), tool("c", "C")], 600);
  // A changed in CSP; B changed here; C changed on both sides.
  b.csp!.settings.BrushSize = 99;
  c.csp!.settings.BrushSize = 98;
  const now = [
    tool("a", "A", { BrushSize: 11 }),
    tool("b", "B"),
    tool("c", "C", { BrushSize: 12 }),
    tool("d", "D"),
    tool("e", "E", {}, ["筆", "墨"]),
  ];

  it("tells each state", () => {
    expect(now.map((t) => stateOf(t, brushFor(project.brushes, t)))).toEqual(["changed", "edited", "both", "new", "new"]);
    expect([a, b, c].every((brush) => brush.cspLink)).toBe(true);
  });

  it("follows CSP's changes only, names the ones changed on both sides, and takes in what is new to followed groups", () => {
    const plan = syncPlan(now, project.brushes, new Set([groupKey(now[4])]));
    expect(plan.updates.map(({ tool }) => tool.name)).toEqual(["A"]);
    expect(plan.conflicts.map(({ tool }) => tool.name)).toEqual(["C"]);
    expect(plan.additions.map((tool) => tool.name)).toEqual(["E"]);
    const told = new Set<string>();
    expect(untold(plan, told)).toEqual(plan);
    // Told once: not again, but again when CSP changes it once more.
    expect(untold(plan, told)).toEqual({ updates: [], conflicts: [], additions: [] });
    now[0].csp.settings.BrushSize = 13;
    expect(untold(syncPlan(now, project.brushes, new Set()), told).updates.map(({ tool }) => tool.name)).toEqual(["A"]);
  });
});

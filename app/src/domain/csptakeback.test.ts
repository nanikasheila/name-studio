import { describe, expect, it } from "vitest";
import type { CspLine, CspPageContent, LineRecord } from "../generated/ipc";
import { rectShape } from "../model/geometry";
import type { Project, Stroke } from "../model/model";
import {
  adoptions,
  allRefs,
  applyCspTakeBack,
  baselineOf,
  changeCount,
  type CspLayerNames,
  CSP_LINE_SOURCE,
  type PageRead,
  type Unrecorded,
  panelKey,
  pickCspTakeBack,
  planCspTakeBack,
  startsUnticked,
  strokeKey,
} from "./csptakeback";
import { lineSignature, shapeSignature, valueHash } from "./linesig";
import { addPanel } from "./panels";
import { newProject } from "./project";

const SCALE = 10;
const px = (points: readonly (readonly number[])[]) => points.map(([x, y, p]) => [x * SCALE, y * SCALE, p ?? 1]);
const names: CspLayerNames = {
  rough: new Map([["ラフ線", { layer: "rough", over: false }]]),
  panels: "コマ枠",
  frames: "コマ枠フォルダー",
  own: new Set(["フキダシ"]),
};
const cspLine = (points: number[][], closed = false): CspLine => ({
  sig: lineSignature(points),
  points: points as [number, number, number][],
  widthPx: 5,
  color: [0, 0, 0],
  closed,
});

function stroke(id: string, y: number): Stroke {
  return {
    id,
    points: [
      [30, y, 0.5],
      [90, y + 10, 0.5],
    ],
    widthMm: 0.5,
    closed: false,
  };
}

/** A name of one page with three rough lines and two panels, as exported. */
function exported() {
  const project = newProject("t", 1);
  const page = project.pages[0];
  addPanel(project, page, rectShape([20, 20, 160, 100]));
  addPanel(project, page, rectShape([20, 110, 160, 200]));
  page.strokes.push(stroke("a", 40), stroke("b", 60), stroke("c", 80));
  const rough = page.strokes.map((s) => cspLine(px(s.points)));
  const frames = page.panels.map((panel) => cspLine(px([...panel.shape, panel.shape[0]]), true));
  const record: Record<string, LineRecord[]> = {
    ラフ線: page.strokes.map((s, i) => ({ sig: rough[i].sig, key: strokeKey(s) })),
    コマ枠: page.panels.map((panel, i) => ({ sig: frames[i].sig, key: panelKey(panel) })),
  };
  return { project, rough, frames, record };
}

function read(
  project: Project,
  layers: Record<string, CspLine[]>,
  lines: Record<string, LineRecord[]>,
  extra: Partial<CspPageContent> = {},
): PageRead {
  return {
    path: "out/page0001.clip",
    places: [{ page: 0, m: { scale: SCALE, x: 0, y: 0 }, right: true }],
    gutterPx: null,
    content: {
      dialogue: { texts: [], written: null, adoptedFrom: null },
      record: { lines, pageIds: [project.pages[0].id] },
      vectors: Object.entries(layers).map(([name, list]) => ({ name, visible: true, lines: list })),
      frames: [],
      rasters: [],
      widthPx: 2000,
      heightPx: 3000,
      ...extra,
    },
  };
}

const none = () => null;

describe("CSP から読み戻す（線・コマ）", () => {
  it("finds nothing on a page as written", () => {
    const { project, rough, frames, record } = exported();
    const plan = planCspTakeBack(project, [read(project, { ラフ線: rough, コマ枠: frames }, record)], names, none);
    expect(changeCount(plan)).toBe(0);
    expect(plan.conflicts).toEqual([]);
  });

  it("takes lines drawn, moved and deleted in CSP as rough lines", () => {
    const { project, rough, frames, record } = exported();
    const moved = cspLine(rough[1].points.map(([x, y, p]) => [x + 40, y, p]));
    const drawn = cspLine(rough[2].points.map(([x, y, p]) => [x, y + 300, p]));
    const plan = planCspTakeBack(project, [read(project, { ラフ線: [moved, rough[2], drawn], コマ枠: frames }, record)], names, none);
    expect(plan.strokesRemoved.map((r) => r.stroke)).toEqual(["a"]);
    expect(plan.strokesChanged.map((c) => [c.stroke, c.points[0][0]])).toEqual([["b", 34]]);
    expect(plan.strokesAdded.map((a) => [a.layer, a.stroke.points[0][1]])).toEqual([["rough", 110]]);
    // Removing a line is ticked; only removing panels and hidden layers start unticked.
    expect(startsUnticked(plan).size).toBe(0);

    const made = applyCspTakeBack(project, plan);
    const page = project.pages[0];
    expect(page.strokes.map((s) => s.id).slice(0, 2)).toEqual(["b", "c"]);
    expect(page.strokes).toHaveLength(3);
    expect(page.strokes[0].points[0][0]).toBe(34);
    const brush = project.brushes.find((b) => b.source === CSP_LINE_SOURCE);
    expect(brush?.sizePressure?.min).toBe(0);
    expect(page.strokes[2].brush).toBe(brush?.id);
    // What is recorded now: every line CSP has, keyed to what it is in the name.
    const [adopted] = adoptions(plan, made);
    expect(adopted.adoption.lines.ラフ線.map((line) => line.key).sort()).toEqual(page.strokes.map(strokeKey).sort());
    expect(adopted.adoption.made).toHaveLength(2);

    // Read again with that record: nothing new.
    const again = planCspTakeBack(
      project,
      [read(project, { ラフ線: [moved, rough[2], drawn], コマ枠: frames }, adopted.adoption.lines)],
      names,
      none,
    );
    expect(changeCount(again)).toBe(0);
  });

  it("leaves a line the name changed too as the name has it", () => {
    const { project, rough, frames, record } = exported();
    project.pages[0].strokes[1].widthMm = 1;
    const moved = cspLine(rough[1].points.map(([x, y, p]) => [x + 40, y, p]));
    const plan = planCspTakeBack(project, [read(project, { ラフ線: [rough[0], moved, rough[2]], コマ枠: frames }, record)], names, none);
    expect(changeCount(plan)).toBe(0);
    expect(plan.conflicts).toHaveLength(1);
  });

  it("reads a new layer's lines onto a rough layer of that name, and leaves the balloons", () => {
    const { project, rough, frames, record } = exported();
    const line = cspLine(
      px([
        [40, 40],
        [50, 50],
      ]),
    );
    const plan = planCspTakeBack(
      project,
      [read(project, { ラフ線: rough, コマ枠: frames, "背景/人物": [line], フキダシ: [line] }, record)],
      names,
      none,
    );
    expect(plan.strokesAdded.map((a) => [a.cspLayer, a.layer, a.newLayer])).toEqual([["人物", null, "人物"]]);
    expect(plan.notes).toHaveLength(1);
    applyCspTakeBack(project, plan);
    const layer = project.roughLayers?.find((l) => l.name === "人物");
    expect(project.pages[0].strokes.at(-1)?.layer).toBe(layer?.id);
  });

  it("takes コマ枠 changes as panels: a moved frame, a line across, a deleted frame (unticked)", () => {
    const { project, rough, frames, record } = exported();
    const [first, second] = project.pages[0].panels;
    const moved = cspLine(
      frames[0].points.map(([x, y, p]) => [x + 30, y, p]),
      true,
    );
    const across = cspLine(
      px([
        [90, 100],
        [90, 210],
      ]),
    );
    const plan = planCspTakeBack(project, [read(project, { ラフ線: rough, コマ枠: [moved, frames[1], across] }, record)], names, none);
    expect(plan.panelsChanged.map((c) => [c.panel, c.shape[0][0]])).toEqual([[first.id, 23]]);
    expect(plan.panelSketches).toHaveLength(1);
    applyCspTakeBack(project, plan);
    expect(project.pages[0].panels).toHaveLength(3);
    expect(project.pages[0].panels.some((panel) => panel.id === second.id && panel.shape === second.shape)).toBe(false);

    const { project: other, rough: r2, frames: f2, record: rec2 } = exported();
    const removed = planCspTakeBack(other, [read(other, { ラフ線: r2, コマ枠: [f2[0]] }, rec2)], names, none);
    expect(removed.panelsRemoved.map((r) => r.panel)).toEqual([other.pages[0].panels[1].id]);
    expect([...startsUnticked(removed)]).toEqual(allRefs(removed));
    expect(changeCount(pickCspTakeBack(removed, new Set()))).toBe(0);
  });

  it("leaves the name's own layers of a page written before lines were recorded, and takes layers made in CSP", () => {
    const { project, rough, frames } = exported();
    const skip: Unrecorded = (_read, layer) => (layer === "ラフ線" || layer === "コマ枠" ? "skip" : null);
    const ink = cspLine(
      px([
        [40, 40],
        [50, 50],
      ]),
    );
    const moved = cspLine(rough[1].points.map(([x, y, p]) => [x + 40, y, p]));
    const plan = planCspTakeBack(project, [read(project, { ラフ線: [moved], コマ枠: frames.slice(1), ペン入れ: [ink] }, {})], names, skip);
    expect([plan.strokesRemoved.length, plan.strokesChanged.length, plan.panelsRemoved.length]).toEqual([0, 0, 0]);
    expect(plan.strokesAdded.map((a) => a.newLayer)).toEqual(["ペン入れ"]);
    expect(plan.notes).toHaveLength(2);
    // Nothing recorded of the layers left be: they are left be next time too.
    expect(Object.keys(plan.pending[0].lines)).toEqual(["ペン入れ"]);
  });

  it("does not take part of a panel's outline moved in CSP as its shape", () => {
    const { project, rough, frames, record } = exported();
    // The first panel drawn as its bottom edge only (as a 裁ち切り panel is), then moved in CSP.
    const edge = cspLine(
      px([
        [20, 100],
        [160, 100],
      ]),
    );
    const lines = { ...record, コマ枠: [{ sig: edge.sig, key: panelKey(project.pages[0].panels[0]) }, record.コマ枠[1]] };
    const moved = cspLine(edge.points.map(([x, y, p]) => [x + 30, y, p]));
    const plan = planCspTakeBack(project, [read(project, { ラフ線: rough, コマ枠: [moved, frames[1]] }, lines)], names, none);
    expect(changeCount(plan)).toBe(0);
    expect(plan.notes).toHaveLength(1);
    expect(plan.pending[0].lines.コマ枠.map((line) => line.key)).toEqual(lines.コマ枠.map((line) => line.key).reverse());
  });

  it("starts from before the last take-back once the name undid it", () => {
    const { project, record } = exported();
    const taken = { keys: ["s:stroke9:00000000"], lines: { ラフ線: record.ラフ線.slice(0, 1) }, pixels: { 下描き: "1:0" } };
    const content = read(project, {}, { ラフ線: [] }, {}).content;
    content.record.taken = taken;
    expect(baselineOf(project, content)).toEqual({ lines: taken.lines, pixels: taken.pixels });
    // Still in the name: the record as it is.
    project.pages[0].strokes.push({ ...stroke("stroke9", 10) });
    content.record.taken = { ...taken, keys: [strokeKey(project.pages[0].strokes.at(-1)!)] };
    expect(baselineOf(project, content).lines).toEqual({ ラフ線: [] });
  });
});

describe("指紋", () => {
  it("is csp-format's shape_signature, as the Rust side computes it", () => {
    // crates/clip-core/src/write/manifest.rs `the_line_signature_is_the_apps`.
    expect(
      lineSignature([
        [10.4, 20.5],
        [-3.5, 7],
      ]),
    ).toBe("1:beb2c96895f00314");
    expect(shapeSignature([])).toBe("0:cbf29ce484222325");
    expect(valueHash({ a: 1 })).toMatch(/^[0-9a-f]{8}$/);
  });
});

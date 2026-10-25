import { describe, expect, it } from "vitest";
import { newId, newProject } from "./project";
import type { Stroke } from "./model";
import {
  addRoughLayer,
  layerOf,
  layerStrokeCount,
  moveRoughLayer,
  moveStrokesToLayer,
  removeRoughLayer,
  renameRoughLayer,
  ROUGH_BASE,
  roughExportNames,
  roughLayersOf,
  setRoughLayer,
  shownStrokes,
  strokeEditable,
  strokesOn,
} from "./roughlayers";

const line = (id: string, layer?: string): Stroke => ({
  id,
  points: [
    [0, 0, 1],
    [10, 10, 1],
  ],
  widthMm: 0.5,
  closed: false,
  ...(layer ? { layer } : {}),
});

describe("ラフ線のレイヤー", () => {
  it("has one layer holding every line until another is added", () => {
    const project = newProject("t", 1);
    expect(roughLayersOf(project).map((layer) => layer.id)).toEqual([ROUGH_BASE]);
    expect(layerOf(project, line("a")).id).toBe(ROUGH_BASE);
    expect(strokeEditable(project, line("a"))).toBe(true);
    expect(project.roughLayers).toBeUndefined();
  });

  it("adds, renames, moves and removes layers, the lines going with them", () => {
    const project = newProject("t", 2);
    const people = addRoughLayer(project, "人物", () => newId(project, "rough"));
    const back = addRoughLayer(project, "背景", () => newId(project, "rough"), ROUGH_BASE);
    // Above the layer picked: 背景 goes between ラフ線 and 人物.
    expect(roughLayersOf(project).map((layer) => layer.name)).toEqual(["ラフ線", "背景", "人物"]);
    // Names stay apart.
    renameRoughLayer(project, back.id, "人物");
    expect(layerOf(project, { layer: back.id }).name).toBe("人物 2");
    expect(moveRoughLayer(project, back.id, 1)).toBe(true);
    expect(moveRoughLayer(project, back.id, 1)).toBe(false);
    expect(roughLayersOf(project).map((layer) => layer.id)).toEqual([ROUGH_BASE, people.id, back.id]);

    const [first, second] = project.pages;
    first.strokes = [line("a"), line("b"), line("c", "gone")];
    second.strokes = [line("d")];
    expect(moveStrokesToLayer(project, first, ["a", "b"], people.id)).toBe(2);
    // A line on a layer that is gone is on the first layer.
    expect(layerOf(project, first.strokes[2]).id).toBe(ROUGH_BASE);
    expect(layerStrokeCount(project, people.id)).toBe(2);
    expect(strokesOn(project, first.strokes, roughLayersOf(project)[1]).map((s) => s.id)).toEqual(["a", "b"]);
    // Back on the first layer the line has no layer of its own.
    moveStrokesToLayer(project, first, ["b"], ROUGH_BASE);
    expect(first.strokes[1].layer).toBeUndefined();

    // 下と結合: the lines go onto the layer below.
    expect(removeRoughLayer(project, people.id, true)).toBe(1);
    expect(first.strokes.map((s) => layerOf(project, s).id)).toEqual([ROUGH_BASE, ROUGH_BASE, ROUGH_BASE]);
    // Removed with its lines.
    moveStrokesToLayer(project, second, ["d"], back.id);
    expect(removeRoughLayer(project, back.id, false)).toBe(1);
    expect(second.strokes).toEqual([]);
    // The last layer stays, and as it began the name has no list of its own.
    expect(removeRoughLayer(project, ROUGH_BASE, false)).toBe(0);
    expect(project.roughLayers).toBeUndefined();
  });

  it("keeps hidden and locked layers from being drawn on, erased or picked", () => {
    const project = newProject("t", 1);
    const people = addRoughLayer(project, "人物", () => newId(project, "rough"));
    const strokes = [line("a"), line("b", people.id)];
    setRoughLayer(project, people.id, { locked: true, opacity: 0.4 });
    expect(strokes.map((s) => strokeEditable(project, s))).toEqual([true, false]);
    expect(shownStrokes(project, strokes)).toBe(strokes);
    setRoughLayer(project, people.id, { locked: false, hidden: true });
    expect(shownStrokes(project, strokes).map((s) => s.id)).toEqual(["a"]);
    expect(strokeEditable(project, strokes[1])).toBe(false);
    // Back to the defaults: nothing is kept.
    setRoughLayer(project, people.id, { hidden: false, opacity: 1 });
    expect(roughLayersOf(project)[1]).toEqual({ id: people.id, name: "人物" });
  });

  it("names each layer's CSP layers apart from the page's other layers", () => {
    const project = newProject("t", 1);
    expect([...roughExportNames(project, ["コマ枠"]).values()]).toEqual([{ under: "ラフ線", over: "はみ出し（ラフ線）" }]);
    addRoughLayer(project, "コマ枠", () => newId(project, "rough"));
    expect([...roughExportNames(project, ["コマ枠"]).values()]).toEqual([
      { under: "ラフ線", over: "はみ出し（ラフ線）" },
      { under: "コマ枠 2", over: "はみ出し（コマ枠 2）" },
    ]);
  });
});

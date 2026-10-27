import { describe, expect, it } from "vitest";
import { newId, newProject } from "./project";
import type { Stroke } from "./model";
import {
  addMarkLayer,
  addRoughLayer,
  hasMarks,
  isMark,
  layerOf,
  markColor,
  markLayerFor,
  markLayersOf,
  MARK_COLORS,
  moveRoughLayer,
  removeRoughLayer,
  ROUGH_BASE,
  roughExportNames,
  roughLayersOf,
  setRoughLayer,
  strokesOn,
  withoutMarks,
} from "./roughlayers";
import { eraseWith } from "./strokes";

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

describe("指示のレイヤー", () => {
  it("is made by the first 指示, red and named 指示, on top and apart from the rough", () => {
    const project = newProject("t", 1);
    expect(markLayersOf(project)).toEqual([]);
    const layer = markLayerFor(project, "", () => newId(project, "rough"));
    expect(layer).toMatchObject({ name: "指示", marks: true });
    expect(markColor(layer)).toBe(MARK_COLORS[0]);
    // The rough keeps its one layer; the 指示 are not among its layers.
    expect(roughLayersOf(project).map((one) => one.id)).toEqual([ROUGH_BASE]);
    expect(project.roughLayers?.map((one) => one.id)).toEqual([ROUGH_BASE, layer.id]);
    // Asked again: the same layer, not another.
    expect(markLayerFor(project, "", () => newId(project, "rough"))).toBe(layer);
  });

  it("keeps 指示 out of the rough's lines and the rough out of the 指示", () => {
    const project = newProject("t", 1);
    const marks = addMarkLayer(project, () => newId(project, "rough"));
    const page = project.pages[0];
    page.strokes = [line("a"), line("m", marks.id)];
    expect(isMark(project, page.strokes[0])).toBe(false);
    expect(isMark(project, page.strokes[1])).toBe(true);
    expect(withoutMarks(project, page.strokes).map((s) => s.id)).toEqual(["a"]);
    expect(strokesOn(project, page.strokes, roughLayersOf(project)[0]).map((s) => s.id)).toEqual(["a"]);
    expect(strokesOn(project, page.strokes, marks).map((s) => s.id)).toEqual(["m"]);
    expect(hasMarks(project)).toBe(true);
    page.strokes = [line("a")];
    expect(hasMarks(project)).toBe(false);
  });

  it("gives each new 指示のレイヤー the next colour, named by it", () => {
    const project = newProject("t", 1);
    const red = addMarkLayer(project, () => newId(project, "rough"));
    const blue = addMarkLayer(project, () => newId(project, "rough"));
    expect(red.color).toBeUndefined();
    expect(blue).toMatchObject({ name: "指示（青）", color: MARK_COLORS[1] });
    // Colours change in place; red is none.
    setRoughLayer(project, blue.id, { color: MARK_COLORS[2] });
    expect(markColor(blue)).toBe(MARK_COLORS[2]);
    setRoughLayer(project, blue.id, { color: MARK_COLORS[0] });
    expect(blue.color).toBeUndefined();
    // A rough layer has no colour.
    setRoughLayer(project, ROUGH_BASE, { color: MARK_COLORS[1] });
    expect(layerOf(project, {}).color).toBeUndefined();
  });

  it("moves and merges among its own kind only", () => {
    const project = newProject("t", 1);
    const red = addMarkLayer(project, () => newId(project, "rough"));
    const people = addRoughLayer(project, "人物", () => newId(project, "rough"));
    const blue = addMarkLayer(project, () => newId(project, "rough"));
    // [ラフ線, 指示, 人物, 指示（青）]: 人物 goes down past 指示 to below ラフ線's place.
    expect(moveRoughLayer(project, people.id, -1)).toBe(true);
    expect(roughLayersOf(project).map((one) => one.name)).toEqual(["人物", "ラフ線"]);
    expect(moveRoughLayer(project, people.id, -1)).toBe(false);
    expect(moveRoughLayer(project, blue.id, -1)).toBe(true);
    expect(markLayersOf(project).map((one) => one.id)).toEqual([blue.id, red.id]);
    // 下と結合 of the top 指示 goes into the 指示 below, never a rough layer.
    project.pages[0].strokes = [line("m", red.id), line("a", people.id)];
    expect(removeRoughLayer(project, red.id, true)).toBe(1);
    expect(project.pages[0].strokes.map((s) => s.layer)).toEqual([blue.id, people.id]);
    // The last 指示のレイヤー can go (the rough keeps one).
    expect(removeRoughLayer(project, blue.id, false)).toBe(1);
    expect(markLayersOf(project)).toEqual([]);
    expect(project.pages[0].strokes.map((s) => s.id)).toEqual(["a"]);
  });

  it("leaves a line with no layer on the rough even when 指示 come first", () => {
    const project = newProject("t", 1);
    project.roughLayers = [{ id: "m", name: "指示", marks: true }, { id: "r2", name: "人物" }];
    expect(layerOf(project, {}).id).toBe("r2");
    expect(isMark(project, {})).toBe(false);
  });

  it("names 指示のレイヤー for CSP apart from the rough's", () => {
    const project = newProject("t", 1);
    const marks = addMarkLayer(project, () => newId(project, "rough"));
    const names = roughExportNames(project, ["メモ（ネーム）"]);
    expect(names.get(marks.id)).toEqual({ under: "指示", over: "" });
    expect(names.get(ROUGH_BASE)).toEqual({ under: "ラフ線", over: "はみ出し（ラフ線）" });
  });

  it("is erased by the 指示 tool's eraser only", () => {
    const project = newProject("t", 1);
    const marks = addMarkLayer(project, () => newId(project, "rough"));
    const page = project.pages[0];
    page.strokes = [line("a"), line("m", marks.id)];
    // The eraser: everything but the 指示.
    expect(eraseWith(project, page, [5, 5], 1, "whole", (s) => !isMark(project, s))).toBe(1);
    expect(page.strokes.map((s) => s.id)).toEqual(["m"]);
    page.strokes = [line("a"), line("m", marks.id)];
    expect(eraseWith(project, page, [5, 5], 1, "whole", (s) => isMark(project, s))).toBe(1);
    expect(page.strokes.map((s) => s.id)).toEqual(["a"]);
  });
});

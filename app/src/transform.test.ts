import { describe, expect, it } from "vitest";
import { addLine, addPanel, addStroke, bounds, newProject, panelContents, rectShape } from "./project";
import { applyAffine, baseBounds, densify, straightEnd, copySelection, pasteClip, rotation, scaling, transformBase, transformItems } from "./transform";

function sample() {
  const project = newProject("t", 2);
  const page = project.pages[0];
  const panel = addPanel(project, page, rectShape([20, 20, 100, 100]));
  const stroke = addStroke(project, page, [[30, 30, 1], [50, 30, 1], [50, 50, 1]], 0.4)!;
  const line = addLine(project, page, [70, 60], "やあ");
  line.tails = [{ tip: [60, 90] }];
  return { project, page, panel, stroke, line };
}

describe("affine", () => {
  it("scales and turns about a point", () => {
    expect(applyAffine(scaling(2, 3, [10, 10]), [11, 12])).toEqual([12, 16]);
    const [x, y] = applyAffine(rotation(Math.PI / 2, [0, 0]), [1, 0]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
  });
});

describe("transforming a selection", () => {
  it("scales rough lines with their width; dialogue keeps its size and moves with its centre", () => {
    const { page, stroke, line } = sample();
    const items = [{ kind: "stroke" as const, id: stroke.id }, { kind: "line" as const, id: line.id }];
    const base = transformBase(page, items);
    const box = baseBounds(base)!;
    const [w, h] = [line.box[2] - line.box[0], line.box[3] - line.box[1]];
    transformItems(page, base, scaling(2, 2, [box[0], box[1]]));
    expect(stroke.points[1].slice(0, 2)).toEqual([box[0] + (50 - box[0]) * 2, box[1] + (30 - box[1]) * 2]);
    expect(stroke.widthMm).toBeCloseTo(0.8);
    expect(line.box[2] - line.box[0]).toBeCloseTo(w);
    expect(line.box[3] - line.box[1]).toBeCloseTo(h);
    const tip = line.tails![0].tip;
    expect(tip).toEqual(applyAffine(scaling(2, 2, [box[0], box[1]]), [60, 90]));
  });

  it("flips from the base each time, so repeated drags do not add up", () => {
    const { page, stroke } = sample();
    const base = transformBase(page, [{ kind: "stroke", id: stroke.id }]);
    const flip = scaling(-1, 1, [40, 40]);
    transformItems(page, base, flip);
    transformItems(page, base, flip);
    expect(stroke.points.map((p) => p.slice(0, 2))).toEqual([[50, 30], [30, 30], [30, 50]]);
    // Pressure stays.
    expect(stroke.points[0][2]).toBe(1);
  });
});

describe("copy and paste", () => {
  it("copies a panel with what is in it and pastes it with new ids", () => {
    const { project, page, panel } = sample();
    const clip = copySelection(page, { kind: "panel", pageId: page.id, id: panel.id }, panelContents(page, panel))!;
    expect(clip.panels).toHaveLength(1);
    expect(clip.strokes).toHaveLength(1);
    expect(clip.lines).toHaveLength(1);
    const other = project.pages[1];
    const pasted = pasteClip(project, other, clip);
    expect(other.panels).toHaveLength(1);
    expect(other.panels[0].id).not.toBe(panel.id);
    expect(bounds(other.panels[0].shape)).toEqual([20, 20, 100, 100]);
    expect(other.lines[0].panel).toBe(other.panels[0].id);
    expect(pasted.strokes).toHaveLength(1);
  });

  it("moves a paste by the offset and keeps links only inside the paste", () => {
    const { project, page, line } = sample();
    const second = addLine(project, page, [40, 80], "うん");
    second.linkTo = line.id;
    const clip = copySelection(page, { kind: "line", pageId: page.id, id: second.id })!;
    const pasted = pasteClip(project, page, clip, [5, 5]);
    const copy = page.lines.find((l) => l.id === pasted.lines[0])!;
    expect(copy.linkTo).toBeUndefined();
    expect(copy.box[0]).toBeCloseTo(second.box[0] + 5);
    const both = copySelection(page, { kind: "group", pageId: page.id, id: "group", items: [{ kind: "line", id: line.id }, { kind: "line", id: second.id }] })!;
    const again = pasteClip(project, page, both);
    const linked = page.lines.find((l) => again.lines.includes(l.id) && l.linkTo);
    expect(again.lines).toContain(linked!.linkTo);
  });

  it("copies nothing from an empty selection", () => {
    const { page } = sample();
    expect(copySelection(page, { kind: "stroke", pageId: page.id, id: "none" })).toBeNull();
  });
});

describe("straight lines", () => {
  it("snaps to 45° steps when close, and not otherwise", () => {
    const [x, y] = straightEnd([0, 0, 1], [10, 0.3]);
    expect(x).toBeCloseTo(Math.hypot(10, 0.3));
    expect(y).toBeCloseTo(0);
    expect(straightEnd([0, 0], [10, 3])).toEqual([10, 3]);
  });

  it("puts points along the line with pressure going evenly", () => {
    const points = densify([[0, 0, 0.2], [2, 0, 1]]);
    expect(points).toHaveLength(5);
    expect(points[2][0]).toBeCloseTo(1);
    expect(points[2][2]).toBeCloseTo(0.6);
  });
});

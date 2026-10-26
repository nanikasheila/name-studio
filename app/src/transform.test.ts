import { describe, expect, it } from "vitest";
import { star } from "./balloon";
import { addLine } from "./dialogue";
import { bounds, rectShape } from "./geometry";
import type { Point } from "./model";
import { addPanel, carryContents, followPanel, movePanel, panelContents } from "./panels";
import { newProject } from "./project";
import { addFill, addStroke, eraseInside, pickInside } from "./strokes";
import { applyAffine, baseBounds, densify, straightEnd, copySelection, moveItems, pasteClip, rotation, scaling, toggleItem, transformBase, transformItems, withContents } from "./transform";

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

describe("fills", () => {
  it("are made, erased by the lasso eraser, follow their panel and paste", () => {
    const { project, page, panel } = sample();
    const fill = addFill(project, page, rectShape([30, 60, 40, 70]), "gray");
    expect(fill.tone).toBe("gray");
    expect(addFill(project, page, rectShape([60, 60, 70, 70]), "black").tone).toBeUndefined();
    const carried = carryContents(page, panel);
    movePanel(panel, 10, 0);
    followPanel(page, panel, carried);
    expect(bounds(page.fills![0].shape)[0]).toBeCloseTo(40);
    const clip = copySelection(page, { kind: "fill", pageId: page.id, id: fill.id })!;
    const pasted = pasteClip(project, project.pages[1], clip);
    expect(project.pages[1].fills).toHaveLength(1);
    expect(pasted.fills).toHaveLength(1);
    expect(eraseInside(project, page, rectShape([35, 55, 60, 75]))).toBeGreaterThanOrEqual(1);
    expect(page.fills!.map((f) => f.id)).not.toContain(fill.id);
  });
});

describe("transforming panels, balloons and free deform", () => {
  it("scales a panel with what is drawn in it", () => {
    const { page, panel, stroke } = sample();
    const items = [{ kind: "panel" as const, id: panel.id }, { kind: "stroke" as const, id: stroke.id }];
    transformItems(page, transformBase(page, items), scaling(0.5, 0.5, [20, 20]));
    expect(bounds(panel.shape)).toEqual([20, 20, 60, 60]);
    expect(stroke.points[1].slice(0, 2)).toEqual([35, 25]);
  });

  it("keeps a flipped panel the same way round, with its bleed on the mirrored edge", () => {
    const { page, panel } = sample();
    // Bleed the left edge (x = 20).
    const left = panel.shape.findIndex(([x], i, s) => x === 20 && s[(i + 1) % s.length][0] === 20);
    panel.openEdges = [left];
    const turn = (shape: number[][]) => {
      let sum = 0;
      for (let i = 0; i < shape.length; i++) {
        const [a, b] = [shape[i], shape[(i + 1) % shape.length]];
        sum += a[0] * b[1] - b[0] * a[1];
      }
      return Math.sign(sum);
    };
    const before = turn(panel.shape);
    transformItems(page, transformBase(page, [{ kind: "panel", id: panel.id }]), scaling(-1, 1, [60, 60]));
    expect(turn(panel.shape)).toBe(before);
    const i = panel.openEdges![0];
    const [a, b] = [panel.shape[i], panel.shape[(i + 1) % panel.shape.length]];
    // The bled edge is now on the right (x = 100).
    expect([a[0], b[0]]).toEqual([100, 100]);
  });

  it("grows a balloon on its own with its text", () => {
    const { page, line } = sample();
    const size = line.fontSizePt;
    const [w] = [line.box[2] - line.box[0]];
    const centre = [(line.box[0] + line.box[2]) / 2, (line.box[1] + line.box[3]) / 2];
    transformItems(page, transformBase(page, [{ kind: "line", id: line.id }], "withText"), scaling(1.5, 1.5, centre as [number, number]));
    expect(line.fontSizePt).toBeCloseTo(size * 1.5, 1);
    expect(line.box[2] - line.box[0]).toBeCloseTo(w * 1.5, 2);
  });

  it("can change a balloon on its own without its text: wider, or taller, alone", () => {
    const { page, line } = sample();
    const size = line.fontSizePt;
    const box = [...line.box];
    const width = (outline: Point[]) => Math.max(...outline.map(([x]) => x)) - Math.min(...outline.map(([x]) => x));
    const height = (outline: Point[]) => Math.max(...outline.map(([, y]) => y)) - Math.min(...outline.map(([, y]) => y));
    const before = star(line)!.samples.map((sample) => sample.point);
    const centre: Point = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    transformItems(page, transformBase(page, [{ kind: "line", id: line.id }], "balloonOnly"), scaling(1.6, 1, centre));
    expect(line.fontSizePt).toBe(size);
    line.box.forEach((value, i) => expect(value).toBeCloseTo(box[i], 2));
    expect(line.balloonScale).toEqual([1.6, 1]);
    const after = star(line)!.samples.map((sample) => sample.point);
    expect(width(after)).toBeCloseTo(width(before) * 1.6, 1);
    expect(height(after)).toBeCloseTo(height(before), 1);
    expect(width(line.balloon!)).toBeCloseTo(width(after), 3);
    // Back to its usual size: nothing kept.
    transformItems(page, transformBase(page, [{ kind: "line", id: line.id }], "balloonOnly"), scaling(1 / 1.6, 1, centre));
    expect(line.balloonScale).toBeUndefined();
  });

  it("deforms freely by the four corners", () => {
    const { page, panel } = sample();
    const base = transformBase(page, [{ kind: "panel", id: panel.id }]);
    // Pull the top right corner up and out: a slanted top.
    transformItems(page, base, { box: [20, 20, 100, 100], corners: [[20, 20], [110, 5], [100, 100], [20, 100]] });
    expect(panel.shape).toEqual(expect.arrayContaining([[110, 5], [20, 20], [100, 100], [20, 100]]));
  });
});

describe("picking several things", () => {
  it("takes along what is drawn in the picked panels, each thing once", () => {
    const { page, panel, stroke, line } = sample();
    const items = withContents(page, [{ kind: "panel", id: panel.id }, { kind: "line", id: line.id }], true);
    expect(items).toEqual([
      { kind: "panel", id: panel.id },
      { kind: "line", id: line.id },
      { kind: "stroke", id: stroke.id },
    ]);
    expect(withContents(page, [{ kind: "panel", id: panel.id }], false)).toEqual([{ kind: "panel", id: panel.id }]);
  });

  it("moves panels, fills and はみ出し with rough lines and dialogue", () => {
    const { project, page, panel, stroke, line } = sample();
    const fill = addFill(project, page, rectShape([30, 60, 40, 70]), "black");
    page.breakouts.push({ id: "b1", shape: rectShape([90, 90, 110, 110]) });
    const items = withContents(page, [{ kind: "panel", id: panel.id }, { kind: "breakout", id: "b1" }], true);
    const box = [...line.box];
    moveItems(page, items, 5, -2);
    expect(bounds(panel.shape)).toEqual([25, 18, 105, 98]);
    expect(bounds(fill.shape)).toEqual([35, 58, 45, 68]);
    expect(bounds(page.breakouts[0].shape)).toEqual([95, 88, 115, 108]);
    expect(stroke.points[0].slice(0, 2)).toEqual([35, 28]);
    expect(line.box).toEqual([box[0] + 5, box[1] - 2, box[2] + 5, box[3] - 2]);
  });

  it("adds a thing with Shift + click and takes it out again", () => {
    const one = { kind: "panel" as const, id: "p1" };
    const two = { kind: "line" as const, id: "l1" };
    expect(toggleItem([one], two)).toEqual([one, two]);
    expect(toggleItem([one, two], one)).toEqual([two]);
  });

  it("picks panels, fills and はみ出し wholly inside the lasso, not halves of 見開き panels", () => {
    const { project, page, panel } = sample();
    const fill = addFill(project, page, rectShape([30, 60, 40, 70]), "black");
    const outside = addPanel(project, page, rectShape([120, 20, 170, 100]));
    const half = addPanel(project, page, rectShape([20, 110, 100, 150]));
    half.spread = "x";
    const picked = pickInside(page, rectShape([10, 10, 110, 160]));
    expect(picked.panels).toEqual([panel.id]);
    expect(picked.fills).toEqual([fill.id]);
    expect(picked.panels).not.toContain(outside.id);
  });

  it("copies a 範囲選択 with its panels, fills and はみ出し", () => {
    const { project, page, panel, stroke } = sample();
    addFill(project, page, rectShape([30, 60, 40, 70]), "black");
    page.breakouts.push({ id: "b1", shape: rectShape([90, 90, 110, 110]) });
    const items = withContents(page, [{ kind: "panel", id: panel.id }, { kind: "breakout", id: "b1" }], true);
    const clip = copySelection(page, { kind: "group", pageId: page.id, id: "group", items })!;
    expect(clip.panels).toHaveLength(1);
    expect(clip.breakouts).toHaveLength(1);
    expect(clip.fills).toHaveLength(1);
    expect(clip.strokes.map((s) => s.id)).toEqual([stroke.id]);
    const pasted = pasteClip(project, project.pages[1], clip);
    expect(pasted.panels).toHaveLength(1);
    expect(pasted.breakouts).toHaveLength(1);
    expect(pasted.fills).toHaveLength(1);
  });
});

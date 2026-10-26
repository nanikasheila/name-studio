import { describe, expect, it } from "vitest";
import { arrangePage, arrangePanel, fitSpills, layOut, placingBox, spills } from "./arrange";
import { balloonExtent } from "./balloon";
import { addLine, fitLine, setDefaultShape, setLineKind } from "./dialogue";
import { boxCenter, insidePolygon, rectShape } from "./geometry";
import type { BoxMm, Point } from "./model";
import { basicBox, trimBox } from "./pagebox";
import { addPanel } from "./panels";
import { newProject } from "./project";
import { addStroke } from "./strokes";

describe("セリフの並べ直し", () => {
  it("lays a panel's dialogue out right to left in reading order, broken into short lines, inside the panel", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const panel = addPanel(project, page, rectShape([40, 40, 160, 120]));
    const first = addLine(project, page, [60, 100], "数か月前、この街の空から星がひとつ消えた。");
    const second = addLine(project, page, [150, 50], "えっ");
    // Reading order: the top right one first.
    expect(arrangePanel(project, page, panel)).toBe(2);
    expect(first.text).toContain("\n");
    for (const line of [first, second]) expect(insidePolygon(panel.shape, boxCenter(line.box))).toBe(true);
    expect(boxCenter(second.box)[0]).toBeGreaterThan(boxCenter(first.box)[0]);
  });

  it("keeps dialogue of a 裁ち切り panel inside the basic frame", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const [tx0, ty0, tx1] = trimBox(project.pageFormat);
    const panel = addPanel(project, page, rectShape([tx0 - 5, ty0 - 5, tx1 + 5, 120]));
    const box = placingBox(project, panel);
    const frame = basicBox(project.pageFormat);
    expect(box[0]).toBeGreaterThanOrEqual(frame[0]);
    expect(box[1]).toBeGreaterThanOrEqual(frame[1]);
    const line = addLine(project, page, [tx0, ty0], "数か月前――");
    arrangePage(project, page);
    expect(line.box[1]).toBeGreaterThanOrEqual(frame[1]);
    expect(line.box[2]).toBeLessThanOrEqual(frame[2]);
  });
});

describe("斜めのコマ", () => {
  it("moves a balloon along from the narrow end of a slanted panel to where it fits inside", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    // Tall on the left, narrowing to the right, where the reading starts.
    const [fx, fy] = basicBox(project.pageFormat);
    const panel = addPanel(project, page, [
      [fx + 10, fy + 10],
      [fx + 130, fy + 10],
      [fx + 130, fy + 32],
      [fx + 10, fy + 70],
    ]);
    const line = addLine(project, page, [fx + 120, fy + 20], "あれを先に\n手にすれば");
    arrangePanel(project, page, panel);
    expect(spills(balloonExtent(line), panel.shape)).toBe(false);
    expect(line.text).toBe("あれを先に\n手にすれば");
    // Only as far along as it takes: still in the right half.
    expect(boxCenter(line.box)[0]).toBeGreaterThan(fx + 70);
  });
});

describe("ラフの顔を避ける", () => {
  const overlaps = (a: BoxMm, b: BoxMm) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  it("puts the balloon beside a face drawn at the top right, not over it", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const [fx, fy] = basicBox(project.pageFormat);
    const panel = addPanel(project, page, rectShape([fx + 10, fy + 10, fx + 130, fy + 90]));
    // A stick figure on the right, its head near the top of the panel.
    const [hx, hy] = [fx + 120, fy + 20];
    const head: Point[] = Array.from({ length: 12 }, (_, i) => [hx + 4 * Math.cos((i / 12) * 2 * Math.PI), hy + 4 * Math.sin((i / 12) * 2 * Math.PI)]);
    for (const stroke of [head, [[hx, hy + 4], [hx, hy + 35]] as Point[]]) addStroke(project, page, stroke.map(([x, y]) => [x, y, 0.5]), 0.5);
    const line = addLine(project, page, [fx + 60, fy + 60], "えっ");
    arrangePanel(project, page, panel);
    expect(overlaps(balloonExtent(line), [hx - 4, hy - 4, hx + 4, hy + 4])).toBe(false);
    expect(insidePolygon(panel.shape, boxCenter(line.box))).toBe(true);
    // Still up at the top, beside the face.
    expect(line.box[1]).toBeLessThan(hy);
  });

  it("breaks a line the app broke another way when that keeps it off a face", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    // A narrow panel with a face across its top right: broken tall and thin
    // the balloon fits neither beside the face nor below it, wider and
    // shorter it fits below.
    const box: BoxMm = [0, 0, 42, 90];
    const face: BoxMm = [10, 0, 42, 30];
    const said = "あの子のそばにいてくれればそれでいい";
    const line = addLine(project, page, [20, 50], said);
    layOut([line], box, undefined, true, [face]);
    expect(overlaps(balloonExtent(line), face)).toBe(false);
    expect(line.text.replace(/\n/g, "")).toBe(said);
    const [x0, y0, x1, y1] = balloonExtent(line);
    expect(x0).toBeGreaterThanOrEqual(box[0]);
    expect(x1).toBeLessThanOrEqual(box[2]);
    expect(y0).toBeGreaterThan(face[3]);
    expect(y1).toBeLessThanOrEqual(box[3]);
    // Broken by hand: kept as it is, even where it covers some of the face.
    const byHand = "あの子の\nそばに\nいてくれれば\nそれでいい";
    line.text = byHand;
    fitLine(line);
    layOut([line], box, undefined, true, [face]);
    expect(line.text).toBe(byHand);
  });
});

describe("はみ出しを直す", () => {
  it("breaks dialogue narrower to fit a short strip, and redoes lines that spill past the border", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    // A strip of a flashback: wide and short.
    const panel = addPanel(project, page, rectShape([40, 40, 200, 75]));
    const line = addLine(project, page, [150, 50], "私も、あの人と同じ場所に立てる");
    arrangePanel(project, page, panel);
    expect(spills(balloonExtent(line), panel.shape)).toBe(false);
    // Broken by hand too long for the strip: fixed by breaking it again.
    line.text = "私も、あの人と\n同じ場所に立てる";
    fitLine(line);
    arrangePanel(project, page, panel);
    expect(spills(balloonExtent(line), panel.shape)).toBe(true);
    expect(fitSpills(project)).toBe(1);
    expect(spills(balloonExtent(line), panel.shape)).toBe(false);
    expect(line.text.replace(/\n/g, "")).toBe("私も、あの人と同じ場所に立てる");
  });
});

describe("フキダシの既定の形", () => {
  it("gives new and usual-shaped lines of a kind the work's shape, and follows kind changes", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const usual = addLine(project, page, [50, 50], "うーん", "thought");
    const own = addLine(project, page, [80, 50], "ふむ", "thought");
    own.balloonShape = "dashed";
    expect(setDefaultShape(project, "thought", "polygon")).toBe(1);
    expect(usual.balloonShape).toBe("polygon");
    expect(own.balloonShape).toBe("dashed");
    expect(addLine(project, page, [20, 20], "…", "thought").balloonShape).toBe("polygon");
    // A thought turned into speech loses the thought's shape; back again, it gets it.
    setLineKind(project, usual, "speech");
    expect(usual.balloonShape).toBeUndefined();
    setLineKind(project, usual, "thought");
    expect(usual.balloonShape).toBe("polygon");
    expect(setDefaultShape(project, "thought", "auto")).toBe(2);
    expect(project.lineShapes).toBeUndefined();
  });
});

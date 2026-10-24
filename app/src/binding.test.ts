import { describe, expect, it } from "vitest";
import { arrangePanel } from "./arrange";
import { addAutoTails } from "./autotail";
import { facingPage, patternPanels } from "./koma";
import { onLeftHand, spreads } from "./pages";
import { addLine, addPanel, addStroke, assignPanels, basicBox, boxCenter, bounds, insidePolygon, newProject, rectShape, setBinding, sortLines, type Point } from "./project";
import { panelBoxes } from "./scriptimport";

/** A stick figure: head circle and body, `x` its middle, standing on `y`. */
function figure(x: number, y: number): Point[][] {
  const head: Point[] = Array.from({ length: 12 }, (_, i) => [x + 4 * Math.cos((i / 12) * 2 * Math.PI), y - 36 + 4 * Math.sin((i / 12) * 2 * Math.PI)]);
  return [head, [[x, y - 32], [x, y - 12]], [[x, y - 12], [x - 5, y]], [[x, y - 12], [x + 5, y]]];
}

describe("左綴じ", () => {
  it("puts page 1 on the right and the second page of a pair on the right-hand side", () => {
    const [first, second] = spreads(5, true);
    expect(onLeftHand(first, 1, "right")).toBe(true);
    expect(onLeftHand(first, 1, "left")).toBe(false);
    expect(onLeftHand(second, 2, "left")).toBe(true);
    expect(onLeftHand(second, 3, "left")).toBe(false);
  });

  it("finds the facing page across the gutter on the other side", () => {
    const project = newProject("t", 4);
    project.binding = "left";
    // Pages 2 (left) and 3 (right) face each other; the gutter is on 2's right.
    expect(facingPage(project, project.pages[1], true)).toMatchObject({ page: project.pages[2], gutter: "right" });
    expect(facingPage(project, project.pages[2], true)).toMatchObject({ page: project.pages[1], gutter: "left" });
  });

  it("numbers panels and lines from the top left", () => {
    const project = newProject("t", 1);
    project.binding = "left";
    const page = project.pages[0];
    const right = addPanel(project, page, rectShape([110, 20, 200, 100]));
    const left = addPanel(project, page, rectShape([20, 20, 100, 100]));
    expect(left.order).toBe(1);
    expect(right.order).toBe(2);
    const later = addLine(project, page, [80, 40], "あと");
    const first = addLine(project, page, [40, 40], "さき");
    expect(page.lines).toEqual([first, later]);
    // New dialogue is written across.
    expect(first.vertical).toBe(false);
  });

  it("switches an existing name over: order again, and the usual text direction", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const right = addPanel(project, page, rectShape([110, 20, 200, 100]));
    const left = addPanel(project, page, rectShape([20, 20, 100, 100]));
    const spoken = addLine(project, page, [150, 50], "やあ");
    const sign = addLine(project, page, [60, 50], "OPEN");
    sign.vertical = false;
    expect(right.order).toBe(1);
    setBinding(project, "left");
    expect(project.binding).toBe("left");
    expect(left.order).toBe(1);
    expect(page.lines[0]).toBe(sign);
    expect(spoken.vertical).toBe(false);
    expect(sign.vertical).toBe(false);
    setBinding(project, "right", false);
    expect(right.order).toBe(1);
    expect(spoken.vertical).toBe(false);
  });

  it("mirrors the panel patterns so the first cell is top left", () => {
    const project = newProject("t", 1);
    const manga = patternPanels(project, "basic4");
    project.binding = "left";
    const comic = patternPanels(project, "basic4");
    const [bx0, , bx1] = basicBox(project.pageFormat);
    expect(comic.length).toBe(manga.length);
    manga.forEach((panel, i) => {
      const [x0, y0, x1, y1] = bounds(panel.shape);
      const mirrored = bounds(comic[i].shape);
      expect(mirrored[0]).toBeCloseTo(bx0 + bx1 - x1);
      expect(mirrored[2]).toBeCloseTo(bx0 + bx1 - x0);
      expect(mirrored[1]).toBeCloseTo(y0);
      expect(mirrored[3]).toBeCloseTo(y1);
    });
    // The first cell of the first row is on the left.
    expect(bounds(comic[0].shape)[0]).toBeLessThan(bounds(comic[1].shape)[0]);
  });

  it("deals a script's panels out from the left", () => {
    const [first, second] = panelBoxes([0, 0, 102, 100], 5, { across: 2, down: 5 }, "left");
    expect(first[0]).toBeLessThan(second[0]);
  });

  it("lays a panel's dialogue out left to right", () => {
    const project = newProject("t", 1);
    project.binding = "left";
    const page = project.pages[0];
    const panel = addPanel(project, page, rectShape([40, 40, 160, 120]));
    const first = addLine(project, page, [150, 100], "Where did the star go?");
    const second = addLine(project, page, [50, 50], "Look!");
    sortLines(page, project.binding);
    expect(page.lines[0]).toBe(second);
    expect(arrangePanel(project, page, panel)).toBe(2);
    // Reading order: the top left one first, the next one to its right.
    expect(boxCenter(second.box)[0]).toBeLessThan(boxCenter(first.box)[0]);
    for (const line of [first, second]) expect(insidePolygon(panel.shape, boxCenter(line.box))).toBe(true);
  });

  it("aims the first to speak at the leftmost figure", () => {
    const project = newProject("t", 1);
    project.binding = "left";
    const page = project.pages[0];
    addPanel(project, page, rectShape([60, 60, 240, 160]));
    for (const stroke of [...figure(200, 155), ...figure(100, 155)]) addStroke(project, page, stroke.map(([x, y]) => [x, y, 0.5]), 0.5);
    const a = addLine(project, page, [110, 80], "Hi");
    a.speaker = "a";
    const b = addLine(project, page, [190, 80], "Hello");
    b.speaker = "b";
    assignPanels(page);
    expect(addAutoTails(page, project.binding)).toBe(2);
    expect(a.tails![0].tip[0]).toBeLessThan(150);
    expect(b.tails![0].tip[0]).toBeGreaterThan(150);
  });
});

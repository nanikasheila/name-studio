import { describe, expect, it } from "vitest";
import { area, bounds, rectShape } from "./geometry";
import type { Point } from "./model";
import { basicBox } from "./pagebox";
import { addPanel } from "./panels";
import { newProject } from "./project";
import { applySketch, fitOutline, readSketch } from "./sketchpanels";

/** A wobble that is the same each run. */
function wobble(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state / 2147483647 - 0.5) * 2;
  };
}

/** A box drawn round by hand: wobbly sides, rounded corners, the ends not quite meeting. */
function drawnBox([x0, y0, x1, y1]: [number, number, number, number], seed = 7): Point[] {
  const noise = wobble(seed);
  const points: Point[] = [];
  const side = (a: Point, b: Point) => {
    for (let t = 0; t < 1; t += 0.05) points.push([a[0] + (b[0] - a[0]) * t + noise() * 0.6, a[1] + (b[1] - a[1]) * t + noise() * 0.6]);
  };
  const r = 3;
  side([x0 + r, y0], [x1 - r, y0 + 1]);
  side([x1, y0 + r], [x1 - 1, y1 - r]);
  side([x1 - r, y1], [x0 + r, y1 - 1]);
  side([x0, y1 - r], [x0 + 1, y0 + r + 2]);
  return points;
}

/** A line drawn across by hand. */
function drawnLine(a: Point, b: Point, seed = 3): Point[] {
  const noise = wobble(seed);
  const points: Point[] = [];
  for (let t = 0; t <= 1.0001; t += 0.04) points.push([a[0] + (b[0] - a[0]) * t + noise() * 0.5, a[1] + (b[1] - a[1]) * t + noise() * 0.5]);
  return points;
}

/** ぐしゃぐしゃ back and forth over a spot. */
function scribble([cx, cy]: Point, across: number, turns = 8): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= turns * 10; i++) {
    const t = i / 10;
    points.push([cx + Math.sin(t * Math.PI) * across, cy + (t - turns / 2) * 0.8]);
  }
  return points;
}

describe("なぐり描きのコマ割り", () => {
  it("reads a box drawn round as a four-cornered panel", () => {
    const shape = fitOutline(drawnBox([60, 80, 150, 160]));
    expect(shape).toHaveLength(4);
    const [x0, y0, x1, y1] = bounds(shape);
    expect(x0).toBeCloseTo(60, -0.5);
    expect(y1).toBeCloseTo(160, -0.5);
    // Level and upright exactly.
    expect(shape.every(([x, y]) => [x0, x1].includes(x) && [y0, y1].includes(y))).toBe(true);
  });

  it("keeps a slanted side drawn on purpose", () => {
    const noise = wobble(11);
    const points: Point[] = [];
    const corners: Point[] = [[60, 80], [150, 80], [150, 130], [60, 110]];
    corners.forEach((a, i) => {
      const b = corners[(i + 1) % 4];
      for (let t = 0; t < 1; t += 0.05) points.push([a[0] + (b[0] - a[0]) * t + noise() * 0.4, a[1] + (b[1] - a[1]) * t + noise() * 0.4]);
    });
    const shape = fitOutline(points);
    expect(shape).toHaveLength(4);
    const lefts = shape.filter(([x]) => x < 100).map(([, y]) => y);
    const rights = shape.filter(([x]) => x > 100).map(([, y]) => y);
    expect(Math.max(...rights) - Math.max(...lefts)).toBeGreaterThan(15);
  });

  it("makes a 仮のコマ from a box drawn on an empty page", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const done = applySketch(project, page, drawnBox([60, 80, 150, 160]));
    expect(done.changed).toBe(true);
    expect(page.panels).toHaveLength(1);
    expect(page.panels[0].draft).toBe(true);
    expect(page.panels[0].id).toBe(done.panelId);
  });

  it("cuts the 基本枠 when a line is drawn across an empty page", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const done = applySketch(project, page, drawnLine([50, 200], [245, 203]));
    expect(done.changed).toBe(true);
    expect(page.panels).toHaveLength(2);
    expect(page.panels.every((panel) => panel.draft)).toBe(true);
    const [fx0, fy0, fx1, fy1] = basicBox(project.pageFormat);
    const boxes = page.panels.map((panel) => bounds(panel.shape));
    expect(boxes[0]).toEqual([fx0, fy0, fx1, expect.closeTo(197, 0)]);
    expect(boxes[1][3]).toBe(fy1);
  });

  it("cuts panels a line crosses, and leaves an empty page empty when it reads nothing", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    addPanel(project, page, rectShape([60, 80, 230, 300]));
    expect(applySketch(project, page, drawnLine([140, 70], [142, 310])).changed).toBe(true);
    expect(page.panels).toHaveLength(2);
    expect(page.panels.every((panel) => panel.draft)).toBe(true);
    const empty = newProject("t", 1).pages[0];
    expect(readSketch(empty, [[10, 10], [11, 11]]).kind).toBe("none");
  });

  it("joins the panels a scribble over their gutter touches", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    addPanel(project, page, rectShape([60, 80, 140, 160]));
    addPanel(project, page, rectShape([142, 80, 230, 160]));
    addPanel(project, page, rectShape([60, 166, 230, 300]));
    const reading = readSketch(page, scribble([141, 120], 6));
    expect(reading.kind).toBe("join");
    const done = applySketch(project, page, scribble([141, 120], 6));
    expect(done.changed).toBe(true);
    expect(page.panels).toHaveLength(2);
    expect(bounds(page.panels.find((p) => p.id === done.panelId)!.shape)).toEqual([60, 80, 230, 160]);
  });

  it("joins 仮のコマ drawn not quite in line", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const a = addPanel(project, page, [[60, 80], [140, 81], [139, 160], [60, 158]]);
    const b = addPanel(project, page, [[144, 79], [230, 80], [231, 163], [143, 161]]);
    a.draft = b.draft = true;
    const done = applySketch(project, page, scribble([142, 120], 6));
    expect(done.changed).toBe(true);
    expect(page.panels).toHaveLength(1);
    expect(area(page.panels[0].shape)).toBeGreaterThan(80 * 170);
  });

  it("does not take a box drawn twice round in empty space for a scribble", () => {
    const page = newProject("t", 1).pages[0];
    const twice = [...drawnBox([60, 80, 85, 100], 5), ...drawnBox([60, 80, 85, 100], 9)];
    expect(readSketch(page, twice).kind).toBe("panel");
  });
});

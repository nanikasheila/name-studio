import { describe, expect, it } from "vitest";
import { joinedShape, moveSeam, neighbours, seamAt, seamBase, seamOf, snapSeam } from "./komaedit";
import { addPanel, area, bounds, cutPanels, newProject, rectShape, type Page, type Point } from "./project";

function pageWith(...boxes: [number, number, number, number][]): { page: Page; ids: string[] } {
  const project = newProject("t", 1);
  const page = project.pages[0];
  const ids = boxes.map((box) => addPanel(project, page, rectShape(box)).id);
  return { page, ids };
}

const box = (page: Page, id: string) => bounds(page.panels.find((p) => p.id === id)!.shape);

describe("borders between panels", () => {
  it("moves both sides of a gutter together, keeping its width", () => {
    // Left and right, a 2 mm gutter at x 100..102.
    const { page, ids } = pageWith([20, 20, 100, 100], [102, 20, 180, 100]);
    const seam = seamAt(page, [101, 50], 0.5)!;
    expect(seam.between).toBe(true);
    expect(seam.edges).toHaveLength(2);
    moveSeam(page, seamBase(page, seam), seam, seam.normal[0] * 10);
    expect(box(page, ids[0])).toEqual([20, 20, 110, 100]);
    expect(box(page, ids[1])).toEqual([112, 20, 180, 100]);
  });

  it("takes every panel along a gutter across the page", () => {
    // Two panels over one wide panel.
    const { page, ids } = pageWith([20, 20, 99, 100], [101, 20, 180, 100], [20, 106, 180, 200]);
    const seam = seamAt(page, [60, 103], 0.5)!;
    expect(new Set(seam.edges.map((edge) => edge.panelId))).toEqual(new Set(ids));
    moveSeam(page, seamBase(page, seam), seam, 20 * seam.normal[1]);
    expect(box(page, ids[0])[3]).toBeCloseTo(120);
    expect(box(page, ids[1])[3]).toBeCloseTo(120);
    expect(box(page, ids[2])[1]).toBeCloseTo(126);
  });

  it("keeps gutters on one line apart when a gutter crosses between them", () => {
    // 2 x 2: the upper and lower down-gutters are on one line.
    const { page, ids } = pageWith([20, 20, 99, 100], [101, 20, 180, 100], [20, 106, 99, 200], [101, 106, 180, 200]);
    const seam = seamAt(page, [100, 50], 0.5)!;
    expect(new Set(seam.edges.map((edge) => edge.panelId))).toEqual(new Set([ids[0], ids[1]]));
  });

  it("slides a lone edge on its own", () => {
    const { page, ids } = pageWith([20, 20, 100, 100], [102, 20, 180, 100]);
    const seam = seamAt(page, [20, 50], 0.5)!;
    expect(seam.between).toBe(false);
    expect(seam.edges).toHaveLength(1);
    moveSeam(page, seamBase(page, seam), seam, 5 * -seam.normal[0]);
    expect(box(page, ids[0])).toEqual([15, 20, 100, 100]);
    expect(box(page, ids[1])).toEqual([102, 20, 180, 100]);
  });

  it("finds the panel across the gutter, not the far side of a thin panel", () => {
    // A thin 5 mm panel (間) between two others.
    const { page, ids } = pageWith([20, 20, 90, 100], [92, 20, 97, 100], [99, 20, 180, 100]);
    const seam = seamOf(page, { panelId: ids[1], edge: page.panels.find((p) => p.id === ids[1])!.shape.findIndex(([x], i, s) => x === 97 && s[(i + 1) % s.length][0] === 97) })!;
    expect(new Set(seam.edges.map((edge) => edge.panelId))).toEqual(new Set([ids[1], ids[2]]));
  });

  it("stops before a panel gets too thin", () => {
    const { page, ids } = pageWith([20, 20, 100, 100], [102, 20, 180, 100]);
    const seam = seamAt(page, [101, 50], 0.5)!;
    const moved = moveSeam(page, seamBase(page, seam), seam, seam.normal[0] * 200);
    expect(Math.abs(moved)).toBeLessThan(80);
    const [x0, , x1] = box(page, ids[1]);
    expect(x1 - x0).toBeGreaterThanOrEqual(2.99);
  });

  it("keeps a slanted gutter slanted and its width", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    addPanel(project, page, rectShape([20, 20, 180, 200]));
    cutPanels(project, page, [10, 90], [190, 120]);
    const [upper, lower] = [...page.panels].sort((a, b) => bounds(a.shape)[1] - bounds(b.shape)[1]);
    const seam = seamAt(page, [100, 105.5], 0.5)!;
    expect(seam.between).toBe(true);
    const gap = (from: Point[], to: Point[]) => {
      // Distance between the two slanted edges along the normal.
      const project1 = (p: Point) => (p[0] - seam.origin[0]) * seam.normal[0] + (p[1] - seam.origin[1]) * seam.normal[1];
      const a = Math.max(...from.map(project1).filter((v) => Math.abs(v) < 20));
      const b = Math.min(...to.map(project1).filter((v) => Math.abs(v) < 20 && v > a - 0.01));
      return b - a;
    };
    const before = gap(upper.shape, lower.shape);
    const areaBefore = area(upper.shape);
    moveSeam(page, seamBase(page, seam), seam, 15 * Math.sign(seam.normal[1]));
    expect(area(upper.shape)).toBeGreaterThan(areaBefore);
    expect(gap(upper.shape, lower.shape)).toBeCloseTo(before, 3);
    // Still the frame's sides: x stays 20 and 180.
    for (const [x] of [...upper.shape, ...lower.shape]) expect([20, 180]).toContain(Math.round(x * 1000) / 1000);
  });

  it("snaps a straight border onto the frame lines", () => {
    const { page } = pageWith([20, 20, 100, 100]);
    const seam = seamAt(page, [20, 50], 0.5)!;
    const { distance, guide } = snapSeam(seam, -9.2 * seam.normal[0], { xs: [{ at: 10, guide: true }], ys: [], grid: null }, 1);
    expect(20 + seam.normal[0] * distance).toBeCloseTo(10);
    expect(guide).toBe(10);
  });

  it("snaps a straight border onto the grid when no line is near", () => {
    const { page } = pageWith([20, 20, 100, 100]);
    const seam = seamAt(page, [20, 50], 0.5)!;
    const { distance, guide } = snapSeam(seam, -3.7 * seam.normal[0], { xs: [], ys: [], grid: { x0: 0, y0: 0, step: 5 } }, 1);
    expect(20 + seam.normal[0] * distance).toBeCloseTo(15);
    expect(guide).toBeNull();
  });

  it("is nothing inside a panel", () => {
    const { page } = pageWith([20, 20, 100, 100]);
    expect(seamAt(page, [60, 60], 0.5)).toBeNull();
  });
});

describe("joining panels", () => {
  it("joins two panels side by side over their gutter", () => {
    const { page, ids } = pageWith([20, 20, 100, 100], [102, 20, 180, 100]);
    const [a, b] = ids.map((id) => page.panels.find((p) => p.id === id)!);
    const shape = joinedShape(a, b)!;
    expect(shape).toHaveLength(4);
    expect(bounds(shape)).toEqual([20, 20, 180, 100]);
  });

  it("does not join panels that do not line up", () => {
    const { page, ids } = pageWith([20, 20, 180, 100], [20, 106, 99, 200]);
    const [a, b] = ids.map((id) => page.panels.find((p) => p.id === id)!);
    expect(joinedShape(a, b)).toBeNull();
  });

  it("lists the neighbours across each border", () => {
    const { page, ids } = pageWith([20, 20, 99, 100], [101, 20, 180, 100], [20, 106, 180, 200]);
    const first = page.panels.find((p) => p.id === ids[0])!;
    const found = neighbours(page, first).map(({ panel, side }) => [panel.id, side]);
    expect(found).toEqual(expect.arrayContaining([[ids[1], "right"], [ids[2], "bottom"]]));
  });
});

describe("joinPanels", () => {
  it("keeps the first panel with the shape over both, and its bleed", async () => {
    const { joinPanels } = await import("./komaedit");
    const { page, ids } = pageWith([20, 20, 100, 100], [102, 20, 180, 100], [20, 106, 180, 200]);
    const [a, b] = ids.map((id) => page.panels.find((p) => p.id === id)!);
    // Top edges bled.
    for (const panel of [a, b]) panel.openEdges = [panel.shape.findIndex(([, y], i, s) => y === 20 && s[(i + 1) % s.length][1] === 20)];
    b.note = "引き";
    expect(joinPanels(page, a, b, "right")).toBe(true);
    expect(page.panels).toHaveLength(2);
    expect(bounds(a.shape)).toEqual([20, 20, 180, 100]);
    expect(a.openEdges).toHaveLength(1);
    const [p, q] = [a.shape[a.openEdges![0]], a.shape[(a.openEdges![0] + 1) % a.shape.length]];
    expect(p[1]).toBe(20);
    expect(q[1]).toBe(20);
    expect(a.note).toBe("引き");
  });
});

import { describe, expect, it } from "vitest";
import { CAPTION, GRID_GAP_MM, MARGIN, GRID_GAP_PX, extent, fitContinuous, fittedTo, layoutPages, nearestTo, onStage, pageGapPx, rowCount, slotAt, spreadWidth, toPage, type Arrangement, type Pair, type Slot } from "./layout";
import type { Project } from "./model";
import { trimBox } from "./pagebox";
import { newProject } from "./project";

const view = (change: Partial<Arrangement> = {}): Arrangement => ({ single: false, continuous: false, rows: 1, zoom: 1, pan: [0, 0], width: 1200, height: 800, ...change });
const onScreen = (slot: Slot, [x, y]: [number, number]): [number, number] => [slot.x + x * slot.scale, slot.y + y * slot.scale];

function project(binding: Project["binding"], pages = 8): Project {
  const p = newProject("t", pages);
  p.binding = binding;
  return p;
}

describe("the pages on screen", () => {
  it("puts the first page of a spread on the right with right binding, meeting at the gutter", () => {
    const p = project("right");
    const [trimX0, , trimX1] = trimBox(p.pageFormat);
    const [left, right] = layoutPages(p, [[2, 3]], 0, view()).sort((a, b) => a.x - b.x);
    expect([right.index, left.index]).toEqual([1, 2]);
    expect(left.shown).toEqual([0, trimX1]);
    expect(right.shown).toEqual([trimX0, p.pageFormat.canvasMm[0]]);
    expect(onScreen(left, [trimX1, 0])[0]).toBeCloseTo(onScreen(right, [trimX0, 0])[0]);
  });

  it("mirrors the spread with left binding", () => {
    const [left, right] = layoutPages(project("left"), [[2, 3]], 0, view()).sort((a, b) => a.x - b.x);
    expect([left.index, right.index]).toEqual([1, 2]);
  });

  it("puts the spread in the middle, and moves it with the pan", () => {
    const p = project("right");
    const slots = layoutPages(p, [[2, 3]], 0, view());
    const box = extent(slots, p.pageFormat.canvasMm[1])!;
    expect((box[0] + box[2]) / 2).toBeCloseTo(600);
    expect(box[2] - box[0]).toBeCloseTo(spreadWidth(p.pageFormat) * slots[0].scale);
    const moved = layoutPages(p, [[2, 3]], 0, view({ pan: [30, -20] }));
    expect(moved.map((slot) => [slot.x - 30, slot.y + 20])).toEqual(slots.map((slot) => [slot.x, slot.y]));
  });

  it("shows a page alone, whole, in the middle", () => {
    const p = project("right");
    const [slot] = layoutPages(p, [[1, null]], 0, view({ single: true }));
    const [pageW] = p.pageFormat.canvasMm;
    expect(slot.shown).toEqual([0, pageW]);
    expect(slot.x + (pageW * slot.scale) / 2).toBeCloseTo(600);
  });

  it("shows nothing for a spread that is not there", () => {
    expect(layoutPages(project("right"), [[1, null]], 3, view())).toEqual([]);
  });

  it("lays every spread out in reading order on one canvas (連続)", () => {
    const p = project("right", 8);
    const list: Pair[] = [[1, null], [2, 3], [4, 5], [6, 7]];
    const slots = layoutPages(p, list, 0, view({ continuous: true, rows: 2 }));
    const at = (page: number) => slots.find((slot) => slot.index === page - 1)!;
    // Right binding: along a row from right to left, then the next row down.
    expect(at(2).x).toBeLessThan(at(1).x);
    expect(at(2).y).toBe(at(1).y);
    expect(at(4).y).toBeGreaterThan(at(1).y);
    // The right pages of a column line up.
    expect(at(4).x).toBeCloseTo(at(1).x);
    // 単独 does not split the canvas into pages: 連続 wins.
    expect(layoutPages(p, list, 0, view({ continuous: true, single: true, rows: 2 }))).toEqual(slots);
  });

  it("keeps the rows between one and the number of spreads", () => {
    expect([rowCount(0, 5), rowCount(3, 5), rowCount(9, 5), rowCount(2, 0)]).toEqual([1, 3, 5, 1]);
  });
});

describe("points on the screen and on a page", () => {
  const p = project("right");
  const slots = layoutPages(p, [[2, 3]], 0, view());
  const [left, right] = [...slots].sort((a, b) => a.x - b.x);

  it("goes from the screen to the page and back", () => {
    const [sx, sy] = onScreen(right, [100, 120]);
    expect(slotAt(slots, sx, sy, p.pageFormat)).toBe(right);
    const [x, y] = toPage(right, sx, sy);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(120);
  });

  it("finds the facing page across the gutter, not the hidden part of this one", () => {
    const [trimX0] = trimBox(p.pageFormat);
    const [sx, sy] = onScreen(right, [trimX0 - 2, 100]);
    expect(slotAt(slots, sx, sy, p.pageFormat)).toBe(left);
  });

  it("finds a page a little outside its edge, and none far away", () => {
    const [sx, sy] = onScreen(left, [-5, 100]);
    expect(slotAt(slots, sx, sy, p.pageFormat)).toBe(left);
    const [fx, fy] = onScreen(left, [-50, 100]);
    expect(slotAt(slots, fx, fy, p.pageFormat)).toBeNull();
  });

  it("knows the room for the page numbers and whether a page is on screen", () => {
    const [, pageH] = p.pageFormat.canvasMm;
    const box = extent([left], pageH)!;
    expect(box[3]).toBeCloseTo(left.y + pageH * left.scale + CAPTION);
    expect(onStage(left, pageH, 1200, 800, 0)).toBe(true);
    const away = { ...left, x: left.x + 5000 };
    expect(onStage(away, pageH, 1200, 800, 0)).toBe(false);
  });
});

describe("the room between spreads (連続)", () => {
  it("is the set mm at the scale, a little more while small, and none for 0", () => {
    expect(pageGapPx(GRID_GAP_MM, 2)).toBeCloseTo(GRID_GAP_MM * 2 + GRID_GAP_PX);
    expect(pageGapPx(0, 2)).toBe(0);
    expect(pageGapPx(6, 2)).toBeCloseTo(12 + GRID_GAP_PX / 2);
  });

  it("puts spreads that far apart", () => {
    const p = project("right");
    const pairs: Pair[] = [[1, 2], [3, 4]];
    const xs = (gapMm: number) => {
      const slots = layoutPages(p, pairs, 0, view({ continuous: true, rows: 1, gapMm }));
      const first = slots.filter((s) => s.index < 2);
      const second = slots.filter((s) => s.index >= 2);
      // Right binding: the second spread is to the left of the first.
      const leftEdgeOfFirst = Math.min(...first.map((s) => s.x + s.shown[0] * s.scale));
      const rightEdgeOfSecond = Math.max(...second.map((s) => s.x + s.shown[1] * s.scale));
      return { gap: leftEdgeOfFirst - rightEdgeOfSecond, scale: first[0].scale };
    };
    expect(xs(0).gap).toBeCloseTo(0);
    const wide = xs(30);
    expect(wide.gap).toBeCloseTo(pageGapPx(30, wide.scale));
  });

  it("finds the page nearest a point of the stage, and the point of it there, on or off the page", () => {
    const p = project("right");
    const slots = layoutPages(p, [[1, 2], [3, 4]], 0, view({ continuous: true }));
    const third = slots.find((s) => s.index === 2)!;
    expect(nearestTo(slots, p.pageFormat, onScreen(third, [50, 60]))).toEqual({ index: 2, point: [expect.closeTo(50), expect.closeTo(60)] });
    // Just above a page: that page, at a point above its top.
    const above = nearestTo(slots, p.pageFormat, onScreen(third, [50, -5]));
    expect(above?.index).toBe(2);
    expect(above?.point[1]).toBeCloseTo(-5);
    expect(nearestTo([], p.pageFormat, [0, 0])).toBeNull();
  });

  it("fits 連続 to the stage: every page, or the rows as tall as it, and tells which it was", () => {
    const p = project("right", 16);
    const pairs: Pair[] = [[1, null], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 13], [14, 15], [16, null]];
    const stage = view({ continuous: true, width: 1000, height: 600 });
    const pageH = p.pageFormat.canvasMm[1];
    const laid = (fit: { zoom: number; pan: [number, number] }) => layoutPages(p, pairs, 0, { ...stage, ...fit });
    const all = fitContinuous(p, pairs, stage, "all", () => null) as { zoom: number; pan: [number, number] };
    const box = extent(laid(all), pageH)!;
    expect(box[0]).toBeGreaterThanOrEqual(MARGIN - 1);
    expect(box[2]).toBeLessThanOrEqual(1000 - MARGIN + 1);
    expect(fittedTo(laid(all), pageH, 1000, 600, all.zoom)).toBe("all");
    // One row of nine spreads: as tall as the stage, wider than it, the given x in the middle.
    const rows = fitContinuous(p, pairs, stage, "rows", (slots) => slots[0].x) as { zoom: number; pan: [number, number] };
    const tall = extent(laid(rows), pageH)!;
    expect(tall[3] - tall[1]).toBeCloseTo(600 - 2 * MARGIN, 0);
    expect(laid(rows)[0].x).toBeCloseTo(500);
    expect(fittedTo(laid(rows), pageH, 1000, 600, rows.zoom)).toBe("rows");
    // Moved or zoomed by hand: neither.
    expect(fittedTo(laid({ zoom: rows.zoom, pan: [rows.pan[0], rows.pan[1] + 40] }), pageH, 1000, 600, rows.zoom)).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { besideCorners, DEFAULT_SNAP, loadSnap, saveSnap, SNAP_KEY, snapBox, snapPointTo, snapTargets, snapValue, type SnapSettings } from "./snapping";
import { basicBox, DEFAULT_GUTTERS, newProject, rectShape, trimBox, type Page } from "./project";
import { writeText } from "./settings";

const only = (change: Partial<SnapSettings>): SnapSettings => ({ axis: false, panels: false, frame: false, grid: false, gridMm: 5, ...change });

function pageWith(...boxes: [number, number, number, number][]): Page {
  const project = newProject("t", 1);
  const page = project.pages[0];
  boxes.forEach((box, i) => page.panels.push({ id: `panel${i + 1}`, shape: rectShape(box), order: i + 1 }));
  return page;
}

describe("吸着", () => {
  const format = newProject("t", 1).pageFormat;

  it("snaps to the frames of the page", () => {
    const targets = snapTargets(null, format, only({ frame: true }), DEFAULT_GUTTERS);
    const [bx0, by0] = basicBox(format);
    expect(snapPointTo([bx0 + 1.5, by0 - 2], targets, 3).point).toEqual([bx0, by0]);
    const trim = trimBox(format);
    expect(snapPointTo([trim[2] - 0.5, 200], targets, 3).point[0]).toBe(trim[2]);
    // Out of reach: unchanged.
    expect(snapPointTo([bx0 + 10, 200], targets, 3).point[0]).toBe(bx0 + 10);
  });

  it("snaps to other panels' edges and a gutter away from them, leaving out the panels being changed", () => {
    const page = pageWith([40, 40, 100, 120], [60, 200, 160, 260]);
    const targets = snapTargets(page, format, only({ panels: true }), DEFAULT_GUTTERS, new Set(["panel2"]));
    // The edge itself: x = 100.
    expect(snapPointTo([101, 0], targets, 2).point[0]).toBe(100);
    // A gutter right of it (2 mm across) and below it (6 mm down).
    expect(snapPointTo([102.5, 0], targets, 1).point[0]).toBe(102);
    expect(snapPointTo([0, 125.5], targets, 1).point[1]).toBe(126);
    // Only outside the panel: nothing a gutter inside its left side (x = 42).
    expect(snapPointTo([42.3, 0], targets, 1).point[0]).toBe(42.3);
    // panel2 is left out: nothing at its x = 160.
    expect(snapPointTo([160.4, 0], targets, 1).point[0]).toBe(160.4);
    // The guide shows where it snapped.
    expect(snapPointTo([101, 39], targets, 2).guides).toEqual({ xs: [100], ys: [40] });
  });

  it("lines a corner up with the corners beside it (水平・垂直)", () => {
    const shape = rectShape([40, 40, 100, 120]);
    const beside = besideCorners(shape, 2);
    expect(beside).toEqual([[100, 40], [40, 120]]);
    const { point } = snapPointTo([101.5, 118], { xs: [], ys: [], grid: null }, 3, beside);
    expect(point).toEqual([100, 120]);
  });

  it("snaps to the grid from the basic frame when no line is near, lines first", () => {
    const targets = snapTargets(null, format, only({ grid: true, gridMm: 5 }), DEFAULT_GUTTERS);
    const [bx0, by0] = basicBox(format);
    expect(snapPointTo([bx0 + 7.4, by0 + 12.6], targets, 1).point).toEqual([bx0 + 5, by0 + 15]);
    expect(snapValue(10.6, [{ at: 10.5, guide: true }], { origin: 0, step: 5 }, 1)).toEqual({ value: 10.5, guide: 10.5 });
    expect(snapValue(12.6, [{ at: 10.5, guide: true }], { origin: 0, step: 5 }, 1)).toEqual({ value: 15, guide: null });
  });

  it("moves a box so that its nearest side lands on a line", () => {
    const page = pageWith([40, 40, 100, 120]);
    const targets = snapTargets(page, format, only({ panels: true }), DEFAULT_GUTTERS, new Set());
    // A box just short of a gutter right of panel1: its left side goes to 102.
    const shift = snapBox([101.6, 300, 141.6, 340], targets, 2);
    expect(shift.dx).toBeCloseTo(0.4);
    expect(shift.guides.xs).toEqual([102]);
    // Its top lines up with panel1's top.
    expect(snapBox([200, 41.5, 240, 80], targets, 2).dy).toBeCloseTo(-1.5);
    expect(snapBox([200, 300, 240, 340], targets, 2)).toEqual({ dx: 0, dy: 0, guides: { xs: [], ys: [] } });
  });

  describe("settings", () => {
    beforeEach(() => {
      const items = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, String(value)),
        removeItem: (key: string) => void items.delete(key),
      });
      writeText(SNAP_KEY, null);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("starts with the defaults and keeps changes", () => {
      expect(loadSnap()).toEqual(DEFAULT_SNAP);
      saveSnap({ ...DEFAULT_SNAP, grid: true, gridMm: 2.5 });
      expect(loadSnap()).toEqual({ ...DEFAULT_SNAP, grid: true, gridMm: 2.5 });
    });

    it("reads what it cannot use as the defaults", () => {
      writeText(SNAP_KEY, JSON.stringify({ axis: "yes", gridMm: 900 }));
      expect(loadSnap()).toEqual(DEFAULT_SNAP);
      writeText(SNAP_KEY, "{");
      expect(loadSnap()).toEqual(DEFAULT_SNAP);
    });
  });
});

import { describe, expect, it } from "vitest";
import { badgeAt, cornerAt, linesAt, panelAt, panelBadge, pickAt, tailAt, type PickState } from "./hittest";
import type { Slot } from "./layout";
import type { Line, Page, Point } from "./model";
import { emptyPage } from "./project";
import { tailGeometry } from "./balloon";

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const line = (id: string, box: [number, number, number, number], extra: Partial<Line> = {}): Line => ({ id, text: "あ", kind: "speech", box, fontSizePt: 9, vertical: true, ...extra });
const state = (more: Partial<PickState> = {}): PickState => ({ open: () => false, selectedLine: null, editable: () => true, ...more });

/** A page: a panel over the whole of it with an inset, a fill, a rough line across, two lines, and a 付箋 beside the page. */
function page(): Page {
  return {
    ...emptyPage("p"),
    panels: [
      { id: "whole", shape: rect(0, 0, 100, 100), order: 0 },
      { id: "inset", shape: rect(60, 60, 90, 90), order: 1, z: 1 },
    ],
    fills: [{ id: "fill", shape: rect(10, 60, 30, 80), tone: "black" }] as Page["fills"],
    strokes: [{ id: "stroke", points: [[0, 50, 1], [100, 50, 1]], widthMm: 0.5, closed: false }],
    lines: [line("a", [40, 10, 50, 30]), line("b", [45, 20, 55, 40])],
    stickies: [{ id: "sticky", text: "メモ", at: [110, 5] }],
  };
}

describe("クリックで選ぶもの", () => {
  it("takes the topmost thing under the point, in the order things lie", () => {
    const p = page();
    const at = (point: Point) => pickAt(p, point, 4, state());
    expect(at([112, 6])).toEqual({ kind: "sticky", id: "sticky" });
    expect(at([42, 12])).toEqual({ kind: "line", id: "a" });
    expect(at([20, 50.2])).toEqual({ kind: "stroke", id: "stroke" });
    expect(at([20, 70])).toEqual({ kind: "fill", id: "fill" });
    expect(at([70, 70])).toEqual({ kind: "panel", id: "inset" });
    expect(at([20, 20])).toEqual({ kind: "panel", id: "whole" });
    expect(at([120, 60])).toBeNull();
  });

  it("keeps the selected one of overlapping balloons, else the top one", () => {
    const p = page();
    expect(linesAt(p, [48, 25])).toEqual(["b", "a"]);
    expect(pickAt(p, [48, 25], 4, state())?.id).toBe("b");
    expect(pickAt(p, [48, 25], 4, state({ selectedLine: "a" }))?.id).toBe("a");
  });

  it("passes over rough lines that cannot be edited, to what is under them", () => {
    expect(pickAt(page(), [20, 50.2], 4, state({ editable: () => false }))).toEqual({ kind: "panel", id: "whole" });
  });

  it("reaches farther from a line when the page is shown small", () => {
    const p = page();
    expect(pickAt(p, [20, 52], 4, state())?.kind).toBe("panel");
    expect(pickAt(p, [20, 52], 1, state())?.kind).toBe("stroke");
  });

  it("points at all of an open 付箋's text", () => {
    const p = page();
    p.stickies![0].text = "一行目\n二行目\n三行目\n四行目\n五行目";
    const low: Point = [112, 42];
    expect(pickAt(p, low, 4, state())?.kind).not.toBe("sticky");
    expect(pickAt(p, low, 4, state({ open: () => true }))?.kind).toBe("sticky");
  });

  it("finds the inset panel over its panel", () => {
    expect(panelAt(page(), [70, 70])?.id).toBe("inset");
    expect(panelAt(page(), [30, 30])?.id).toBe("whole");
  });

  it("takes a panel laid on top before a smaller one under it", () => {
    const p = page();
    p.panels.push({ id: "over", shape: rect(50, 50, 100, 100), order: 2, z: 2 });
    expect(pickAt(p, [70, 70], 4, state())).toEqual({ kind: "panel", id: "over" });
  });
});

describe("取っ手", () => {
  const slot = (p: Page, scale = 2): Slot => ({ page: p, index: 0, x: 100, y: 50, scale, shown: [0, 100] });

  it("finds a panel's corner on screen within the handle", () => {
    const p = page();
    expect(cornerAt(slot(p), p.panels[1], 100 + 90 * 2 + 4, 50 + 60 * 2 - 3)).toBe(1);
    expect(cornerAt(slot(p), p.panels[1], 100 + 90 * 2 + 12, 50 + 60 * 2)).toBe(-1);
  });

  it("keeps a panel's number inside the page when the panel runs off it", () => {
    const p = page();
    p.panels[0].shape = rect(0, -20, 140, 100);
    const s = slot(p);
    const badge = panelBadge(s, p.panels[0], undefined, 100);
    expect(badge.x).toBeLessThan(s.x + 100 * s.scale);
    expect(badge.y).toBeGreaterThan(s.y);
    expect(badgeAt(s, undefined, 100, badge.x, badge.y)?.id).toBe("whole");
    expect(badgeAt(s, undefined, 100, badge.x + badge.radius + 5, badge.y)).toBeUndefined();
  });

  it("finds a tail's tip on any line, and its middle and root only on the line shown", () => {
    const p = emptyPage("p");
    p.lines = [line("a", [40, 40, 50, 60], { tails: [{ tip: [20, 80] }] })];
    const s = slot(p, 4);
    const screen = ([x, y]: Point): [number, number] => [s.x + x * s.scale, s.y + y * s.scale];
    expect(tailAt(s, ...screen([20, 80]), new Set())).toEqual({ lineId: "a", index: 0, part: "tip" });
    // The middle of the tail: the bend handle when the line is shown, else the tail's body (to drag it).
    const middle = tailGeometry(p.lines[0], p.lines[0].tails![0])!.middle;
    expect(tailAt(s, ...screen(middle), new Set())?.part).toBe("body");
    expect(tailAt(s, ...screen(middle), new Set(["a"]))?.part).toBe("bend");
    // Inside the balloon, right by where the tail leaves it: the balloon, not the tail.
    const root = tailGeometry(p.lines[0], p.lines[0].tails![0])!.root;
    const inward = Math.hypot(45 - root[0], 50 - root[1]);
    expect(tailAt(s, ...screen([root[0] + (45 - root[0]) / inward, root[1] + (50 - root[1]) / inward]), new Set())).toBeNull();
    expect(tailAt(s, ...screen([45, 50]), new Set())).toBeNull();
    expect(tailAt(s, ...screen([90, 10]), new Set())).toBeNull();
  });
});

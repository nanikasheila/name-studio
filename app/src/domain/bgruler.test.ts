import { describe, expect, it } from "vitest";
import type { Panel, Point } from "../model/model";
import { cameraFit } from "./bgcamera";
import { instructionWords } from "./bgrequest";
import {
  drawGuide,
  drawHorizon,
  horizonEnds,
  horizonTilt,
  moveGuide,
  moveHorizon,
  moveVanishing,
  placeVanishing,
  removeVanishing,
  rulerOf,
  rulerPartAt,
  setPerspective,
  turnHorizon,
} from "./bgruler";

const panel = (): Panel => ({
  id: "panel1",
  order: 1,
  shape: [
    [0, 0],
    [200, 0],
    [200, 100],
    [0, 100],
  ],
});

/** How far `p` is from the line through `a` and `b`. */
function away(p: Point, [a, b]: [Point, Point]): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.hypot(dx, dy);
}

/** Every point on the eye level (but the third) and on the line(s) aimed at it. */
function holdsTogether(one: Panel): void {
  const ruler = rulerOf(one);
  ruler.vanishing.forEach((point, i) => {
    if (i < 2) expect(away(point, ruler.horizon!)).toBeLessThan(0.05);
  });
  ruler.guides.forEach((line, k) => expect(away(ruler.vanishing[Math.min(k, 2)], line)).toBeLessThan(0.05));
}

describe("透視の定規", () => {
  it("lays out 2点 with both points on the eye level beyond the panel, and a line in the panel for each", () => {
    const one = panel();
    setPerspective(one, 2);
    const ruler = rulerOf(one);
    expect(ruler.points).toBe(2);
    expect(ruler.horizon![0][1]).toBeCloseTo(45);
    expect(ruler.vanishing[0][0]).toBeLessThan(0);
    expect(ruler.vanishing[1][0]).toBeGreaterThan(200);
    expect(ruler.guides).toHaveLength(2);
    for (const line of ruler.guides) for (const [x, y] of line) expect(x >= 0 && x <= 200 && y >= 0 && y <= 100).toBe(true);
    holdsTogether(one);
  });

  it("slides the points along their lines when the eye level moves", () => {
    const one = panel();
    setPerspective(one, 2);
    const start = rulerOf(one);
    moveHorizon(one, start, [100, 45], [100, 30]);
    const ruler = rulerOf(one);
    expect(ruler.horizon![0][1]).toBeCloseTo(30);
    // The lines stay as drawn; the points are where they meet the new eye level.
    expect(ruler.guides).toEqual(start.guides);
    holdsTogether(one);
    expect(ruler.vanishing[0][0]).not.toBeCloseTo(start.vanishing[0][0]);
  });

  it("takes the eye level with a point dragged off it, and turns the lines to the points", () => {
    const one = panel();
    setPerspective(one, 2);
    const start = rulerOf(one);
    moveVanishing(one, start, 1, [400, 20]);
    const ruler = rulerOf(one);
    expect(ruler.vanishing[1]).toEqual([400, 20]);
    expect(ruler.horizon![0][1]).toBeCloseTo(20);
    expect(ruler.vanishing[0][1]).toBeCloseTo(20);
    holdsTogether(one);
  });

  it("sets a point beyond the panel from a line inside it (where the line meets the eye level)", () => {
    const one = panel();
    setPerspective(one, 1);
    const start = rulerOf(one);
    // A line along a wall's top, going up to the right: it meets the eye level (y 45) at x 350.
    moveGuide(one, start, 0, 0, [100, 70]);
    moveGuide(one, rulerOf(one), 0, 1, [150, 65]);
    const ruler = rulerOf(one);
    expect(ruler.vanishing[0][0]).toBeCloseTo(350, 0);
    expect(ruler.vanishing[0][1]).toBeCloseTo(45);
    expect(ruler.guides[0]).toEqual([
      [100, 70],
      [150, 65],
    ]);
    // A line drawn with 線 for Y makes it 2点.
    drawGuide(one, "Y", [
      [120, 80],
      [60, 70],
    ]);
    const two = rulerOf(one);
    expect(two.points).toBe(2);
    expect(two.vanishing[1][0]).toBeCloseTo(-90, 0);
    holdsTogether(one);
  });

  it("keeps the third point between the others and off the eye level, and finds the camera looking down", () => {
    const one = panel();
    setPerspective(one, 3);
    const ruler = rulerOf(one);
    expect(ruler.vanishing).toHaveLength(3);
    expect(ruler.guides).toHaveLength(4);
    // The eye level above the middle: looking down, the uprights meet below.
    expect(ruler.vanishing[2][1]).toBeGreaterThan(100);
    holdsTogether(one);
    const fit = cameraFit(one, [0, 0, 200, 100], 254)!;
    expect(fit.mode).toBe("tilt");
    expect(fit.tiltDeg).toBeGreaterThan(0);
    // Dragged beside a point and onto the eye level: held between them and off it.
    moveVanishing(one, ruler, 2, [ruler.vanishing[1][0] + 50, 46]);
    const held = rulerOf(one);
    expect(held.vanishing[2][0]).toBeLessThan(held.vanishing[1][0]);
    expect(Math.abs(held.vanishing[2][1] - 45)).toBeGreaterThanOrEqual(24.9);
    holdsTogether(one);
  });

  it("makes a 1点 ruler with the first click, drops points one at a time, and holds old instructions together", () => {
    const one = panel();
    expect(placeVanishing(one, [150, 40])).toBe(0);
    expect(rulerOf(one).points).toBe(1);
    expect(rulerOf(one).horizon![0][1]).toBe(40);
    setPerspective(one, 3);
    removeVanishing(one, 2);
    expect(rulerOf(one).points).toBe(2);
    expect(rulerOf(one).guides).toHaveLength(2);
    setPerspective(one, 0);
    expect(one.background).toBeUndefined();
    // Made before the ruler: a point off the eye level is read onto it.
    const old: Panel = {
      ...panel(),
      background: {
        horizon: [
          [0, 50],
          [200, 50],
        ],
        vanishing: [
          [300, 58],
          [-80, 49],
        ],
      },
    };
    const ruler = rulerOf(old);
    expect(ruler.points).toBe(2);
    expect(ruler.vanishing[0]).toEqual([300, 50]);
    holdsTogether(old);
  });

  it("finds a point, an end of a line and the eye level under the pointer; drawing the eye level anew keeps the lines", () => {
    const one = panel();
    setPerspective(one, 2);
    const ruler = rulerOf(one);
    expect(rulerPartAt(one, ruler.vanishing[1], 2)).toEqual({ kind: "vanishing", index: 1 });
    expect(rulerPartAt(one, ruler.guides[0][1], 2)).toEqual({ kind: "guide", index: 0, end: 1 });
    expect(rulerPartAt(one, [100, 45.5], 2)).toEqual({ kind: "horizon" });
    expect(rulerPartAt(one, [100, 90], 2)).toBeNull();
    drawHorizon(one, [0, 60], [200, 50]);
    expect(rulerOf(one).guides).toEqual(ruler.guides);
    holdsTogether(one);
  });

  it("keeps the eye level beyond the panel, found there and on towards its points", () => {
    const one = panel();
    setPerspective(one, 2);
    const start = rulerOf(one);
    // Dragged up past the panel's top: kept there, the points on it.
    moveHorizon(one, start, [100, 45], [100, -30]);
    const ruler = rulerOf(one);
    expect(ruler.horizon![0][1]).toBeCloseTo(-30);
    holdsTogether(one);
    expect(rulerPartAt(one, [100, -30], 2)).toEqual({ kind: "horizon" });
    expect(instructionWords(one)).toContain("アイレベル（地平線・カメラの高さ）: y = -30mm（コマの外・上へ 30mm。コマの中はすべてアイレベルより下）");
    // Out beside the panel, towards a point beyond it.
    const x = (ruler.vanishing[1][0] + 200) / 2;
    expect(rulerPartAt(one, [x, -30], 2)).toEqual({ kind: "horizon" });
    expect(rulerPartAt(one, [ruler.vanishing[1][0] + 200, -30], 2)).toBeNull();
  });

  it("turns the eye level by an end about the other, snapping level near it, the points sliding along their lines", () => {
    const one = panel();
    setPerspective(one, 2);
    const start = rulerOf(one);
    const [left, right] = horizonEnds(one, start.horizon!);
    expect(left).toEqual([0, 45]);
    expect(right).toEqual([200, 45]);
    expect(rulerPartAt(one, [200, 45.5], 2)).toEqual({ kind: "horizonEnd", end: 1 });
    expect(rulerPartAt(one, [0.5, 45], 2)).toEqual({ kind: "horizonEnd", end: 0 });
    // The right end down 20mm: about the left end.
    turnHorizon(one, start, 1, [200, 65]);
    let ruler = rulerOf(one);
    const ends = horizonEnds(one, ruler.horizon!);
    expect(ends[0][1]).toBeCloseTo(45);
    expect(ends[1][1]).toBeCloseTo(65);
    expect(horizonTilt(ruler.horizon!)).toBeCloseTo((Math.atan2(20, 200) * 180) / Math.PI);
    expect(ruler.guides).toEqual(start.guides);
    holdsTogether(one);
    // Near level: level (not with Alt).
    turnHorizon(one, start, 0, [0, 47]);
    ruler = rulerOf(one);
    expect(horizonTilt(ruler.horizon!)).toBe(0);
    turnHorizon(one, start, 0, [0, 47], true);
    expect(horizonTilt(rulerOf(one).horizon!)).not.toBe(0);
    // An eye level alone (no points) turns too.
    const alone = panel();
    drawHorizon(alone, [50, 50], [50, 50]);
    turnHorizon(alone, rulerOf(alone), 1, [200, 30]);
    expect(horizonEnds(alone, rulerOf(alone).horizon!)[1][1]).toBeCloseTo(30);
  });
});

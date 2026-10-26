import { describe, expect, it } from "vitest";
import { pageBalloons } from "./balloon";
import { clipClosed, clipOpen, insetConvex, isConvex, maskShape } from "./mask";
import { addLine } from "./dialogue";
import { bounds, rectShape } from "./geometry";
import type { Point } from "./model";
import { addPanel } from "./panels";
import { newProject } from "./project";

const square: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

describe("コマ枠でマスク", () => {
  it("insets a convex panel and clips outlines and lines to it", () => {
    expect(isConvex(square)).toBe(true);
    expect(isConvex([[0, 0], [10, 0], [5, 2], [10, 10], [0, 10]])).toBe(false);
    expect(insetConvex(square, 1)).toEqual([[1, 1], [9, 1], [9, 9], [1, 9]]);
    // Either way round.
    expect(insetConvex([...square].reverse(), 1).map(([x, y]) => [Math.round(x), Math.round(y)])).toEqual([[1, 9], [9, 9], [9, 1], [1, 1]]);
    const cut = clipClosed([[5, 5], [15, 5], [15, 8], [5, 8]], square);
    expect(bounds(cut)).toEqual([5, 5, 10, 8]);
    expect(clipClosed([[20, 20], [30, 20], [30, 30]], square)).toEqual([]);
    expect(clipOpen([[-5, 5], [5, 5], [5, 15], [8, 15], [8, 5]], square)).toEqual([
      [[0, 5], [5, 5], [5, 10]],
      [[8, 10], [8, 5]],
    ]);
  });

  it("cuts a masked balloon at its panel's border, inside half the border's width", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const panel = addPanel(project, page, rectShape([20, 20, 100, 100]));
    const line = addLine(project, page, [96, 60], "はみ出すセリフ");
    line.panel = panel.id;
    const whole = bounds(pageBalloons(page)[0].outline);
    expect(whole[2]).toBeGreaterThan(100);
    line.mask = true;
    const masked = bounds(pageBalloons(page)[0].outline);
    expect(masked[2]).toBeCloseTo(100 - 0.3, 5);
    expect(maskShape({ ...panel, shape: [[0, 0], [10, 0], [5, 2], [10, 10], [0, 10]] })).toBeNull();
  });
});

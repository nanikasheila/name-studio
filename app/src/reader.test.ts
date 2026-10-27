import { describe, expect, it } from "vitest";
import { newProject } from "./project";
import { placeSpread, readingSpreads, swipeTurn, tapTurn, turnOf } from "./reader";
import { trimBox } from "./pagebox";

describe("読む表示", () => {
  it("turns on to the left in a right-bound book, to the right in a left-bound one", () => {
    expect(turnOf("ArrowLeft", true)).toBe(1);
    expect(turnOf("ArrowRight", true)).toBe(-1);
    expect(turnOf("ArrowLeft", false)).toBe(-1);
    expect(turnOf("ArrowRight", false)).toBe(1);
    expect(turnOf(" ", true)).toBe(1);
    expect(turnOf("PageUp", false)).toBe(-1);
    expect(turnOf("a", true)).toBe(0);
    expect(tapTurn(100, 1000, true)).toBe(1);
    expect(tapTurn(900, 1000, true)).toBe(-1);
    expect(tapTurn(900, 1000, false)).toBe(1);
  });

  it("turns on when the page is pulled the way it was read from", () => {
    expect(swipeTurn(120, true)).toBe(1);
    expect(swipeTurn(-120, true)).toBe(-1);
    expect(swipeTurn(-120, false)).toBe(1);
    expect(swipeTurn(10, true)).toBe(0);
  });

  it("reads the spreads as bound, a 縦スクロール strip piece by piece", () => {
    const project = newProject("t", 4);
    expect(readingSpreads(project, true)).toEqual([[null, 1], [2, 3], [4, null]]);
    expect(readingSpreads({ ...project, scroll: true }, true)).toEqual([[1, null], [2, null], [3, null], [4, null]]);
  });

  it("puts the first page read on the right of a right-bound spread, the trims meeting at the gutter", () => {
    const project = newProject("t", 4);
    const [x0, , x1] = trimBox(project.pageFormat);
    const [left, right] = placeSpread(project, [2, 3], 1600, 1000);
    expect(left.index).toBe(2);
    expect(right.index).toBe(1);
    expect(right.left).toBeCloseTo(left.left + (x1 - x0) * left.scale);
    // As big as the window lets the spread be, in the middle.
    expect(left.left).toBeCloseTo(1600 - (right.left + (x1 - x0) * right.scale));
    const mirrored = placeSpread({ ...project, binding: "left" }, [2, 3], 1600, 1000);
    expect(mirrored.map((p) => p.index)).toEqual([1, 2]);
    // A page on its own stays on its side of the spread: page 1 alone is a left page.
    const [alone] = placeSpread(project, [null, 1], 1600, 1000);
    expect(alone).toMatchObject({ index: 0 });
    expect(alone.left).toBeCloseTo(left.left);
  });
});

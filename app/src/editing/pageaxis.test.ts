import { describe, expect, it } from "vitest";
import { boundaryX, cellX, pageAt, spanX } from "./pageaxis";

describe("the strip's page axis", () => {
  const ltr = { count: 4, column: 50, reversed: false };
  const rtl = { ...ltr, reversed: true };

  it("runs from the left out of the box", () => {
    expect([0, 1, 2, 3].map((i) => cellX(ltr, i))).toEqual([0, 50, 100, 150]);
    expect(boundaryX(ltr, 0)).toBe(0);
    expect(boundaryX(ltr, 4)).toBe(200);
    expect(spanX(ltr, 1, 2)).toEqual({ left: 50, width: 100 });
  });

  it("runs from the right as the canvas of a 右綴じ name does", () => {
    expect([0, 1, 2, 3].map((i) => cellX(rtl, i))).toEqual([150, 100, 50, 0]);
    // Before page 1 is the right end; after the last page the left end.
    expect(boundaryX(rtl, 0)).toBe(200);
    expect(boundaryX(rtl, 4)).toBe(0);
    expect(spanX(rtl, 1, 2)).toEqual({ left: 50, width: 100 });
  });

  it("finds the page and the nearest boundary under the pointer either way", () => {
    expect(pageAt(ltr, 60)).toEqual({ index: 1, boundary: 1 });
    expect(pageAt(rtl, 60)).toEqual({ index: 2, boundary: 3 });
    expect(pageAt(rtl, 190)).toEqual({ index: 0, boundary: 0 });
    expect(pageAt(rtl, 10)).toEqual({ index: 3, boundary: 4 });
    // Past the ends: clamped.
    expect(pageAt(rtl, -30)).toEqual({ index: 3, boundary: 4 });
    expect(pageAt(rtl, 260)).toEqual({ index: 0, boundary: 0 });
  });
});

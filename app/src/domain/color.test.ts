import { describe, expect, it } from "vitest";
import { hsvToRgb, isBlack, normalHex, ownColor, parseHex, rgbToHsv, toHex } from "./color";

describe("colours", () => {
  it("reads and writes #rrggbb", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("3A7BD5")).toEqual([58, 123, 213]);
    expect(parseHex("#12345")).toBeNull();
    expect(toHex([58, 123, 213])).toBe("#3a7bd5");
    expect(normalHex(" #ABC ")).toBe("#aabbcc");
  });

  it("goes RGB → HSV → RGB unchanged", () => {
    for (const rgb of [
      [0, 0, 0],
      [255, 255, 255],
      [229, 56, 59],
      [58, 123, 213],
      [76, 175, 80],
      [242, 194, 48],
    ] as [number, number, number][]) {
      expect(hsvToRgb(rgbToHsv(rgb))).toEqual(rgb);
    }
    expect(rgbToHsv([255, 0, 0])).toEqual([0, 1, 1]);
    expect(hsvToRgb([120, 1, 1])).toEqual([0, 255, 0]);
  });

  it("keeps no colour for black", () => {
    expect(isBlack(undefined)).toBe(true);
    expect(isBlack("#000")).toBe(true);
    expect(isBlack("#e5383b")).toBe(false);
    expect(ownColor("#000000")).toBeUndefined();
    expect(ownColor("#E5383B")).toBe("#e5383b");
  });
});

import { describe, expect, it } from "vitest";
import { contrast, DARK_INK, inkOn, LIGHT_INK, parseHex } from "./inkon";
import { PART_COLORS } from "../domain/shapes";

describe("words on a colour of the name", () => {
  it("reads hex colours short and long", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("#2a78d6")).toEqual([42, 120, 214]);
    expect(parseHex("rgb(1, 2, 3)")).toBeNull();
  });

  it("knows black on white", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBe(1);
  });

  it("is dark on light colours and white on dark ones", () => {
    expect(inkOn("#ffd400")).toBe(DARK_INK);
    expect(inkOn("#ffffff")).toBe(DARK_INK);
    expect(inkOn("#10213f")).toBe(LIGHT_INK);
    expect(inkOn("not a colour")).toBe(LIGHT_INK);
  });

  it("stands out on every colour the parts of a story shape take", () => {
    for (const color of PART_COLORS) expect(contrast(color, inkOn(color)), color).toBeGreaterThanOrEqual(4.5);
  });

  it("stands out on any colour at all", () => {
    for (let v = 0; v <= 255; v += 5) {
      const hex = v.toString(16).padStart(2, "0");
      for (const color of [`#${hex}${hex}${hex}`, `#${hex}0000`, `#00${hex}00`, `#0000${hex}`, `#${hex}${hex}00`])
        expect(contrast(color, inkOn(color)), color).toBeGreaterThanOrEqual(4.5);
    }
  });
});

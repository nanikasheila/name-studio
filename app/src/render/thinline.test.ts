import { describe, expect, it } from "vitest";
import { FAINTEST, thinLine } from "./thinline";

describe("thinLine", () => {
  it("leaves a line as wide as the thinnest shown, or wider, as it is", () => {
    expect(thinLine(2, 0.7)).toEqual([2, 1]);
    expect(thinLine(0.7, 0.7)).toEqual([0.7, 1]);
    expect(thinLine(0.3, 0)).toEqual([0.3, 1]);
  });

  it("draws a thinner line at the thinnest width, as much fainter as it is thinner", () => {
    const [width, ink] = thinLine(0.35, 0.7);
    expect(width).toBe(0.7);
    expect(width * ink).toBeCloseTo(0.35);
  });

  it("keeps a very thin line faintly seen", () => {
    expect(thinLine(0.001, 0.7)[1]).toBe(FAINTEST);
  });

  it("for small pictures, draws a thinner line wider at full ink", () => {
    expect(thinLine(0.2, { widen: 0.5 })).toEqual([0.5, 1]);
    expect(thinLine(2, { widen: 0.5 })).toEqual([2, 1]);
  });
});

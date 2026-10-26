import { describe, expect, it } from "vitest";
import { adjustPressure, defaultPenSettings, fitPressureCurve, normalizeCurve, parsePenSettings, LINEAR } from "./pen";
import { PenPreferences } from "./prefs";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

describe("tablet settings", () => {
  it("falls back to the defaults for what is missing or broken", () => {
    expect(parsePenSettings(null)).toEqual(defaultPenSettings());
    expect(parsePenSettings("{oops")).toEqual(defaultPenSettings());
    const read = parsePenSettings(JSON.stringify({ tilt: false, sideButton: "fly", pressureCurve: [[0, 2]], touch: "draw" }));
    expect(read.tilt).toBe(false);
    expect(read.sideButton).toBe("pan");
    expect(read.pressureCurve).toEqual(LINEAR);
    expect(read.touch).toBe("draw");
  });

  it("keeps a curve's points in order, its ends where they were put (下限・上限)", () => {
    expect(normalizeCurve([[0.6, 0.4], [0.1, 0.2], [0.9, 1]])).toEqual([[0.1, 0.2], [0.6, 0.4], [0.9, 1]]);
    // Ends on top of each other are pulled apart.
    expect(normalizeCurve([[0.5, 0], [0.5, 1]])).toEqual([[0, 0], [1, 1]]);
  });

  it("stays flat below the lower end and above the upper one", () => {
    const curve: [number, number][] = [[0.2, 0], [0.8, 1]];
    expect(adjustPressure(curve, 0.1)).toBe(0);
    expect(adjustPressure(curve, 0.5)).toBeCloseTo(0.5);
    expect(adjustPressure(curve, 0.9)).toBe(1);
  });

  it("passes pressure through the curve", () => {
    expect(adjustPressure(LINEAR, 0.3)).toBeCloseTo(0.3);
    const soft: [number, number][] = [[0, 0], [0.25, 0.6], [1, 1]];
    expect(adjustPressure(soft, 0.3)).toBeGreaterThan(0.4);
    expect(adjustPressure(soft, 1)).toBeCloseTo(1);
  });

  it("fits a curve to how hard the pen is usually pressed", () => {
    // A light hand: mostly 0.2–0.4, rarely above 0.5.
    const samples = Array.from({ length: 200 }, (_, i) => 0.2 + (i % 20) * 0.0105 + (i % 50 === 0 ? 0.3 : 0));
    const curve = fitPressureCurve(samples)!;
    expect(adjustPressure(curve, 0.3)).toBeGreaterThan(0.4);
    expect(adjustPressure(curve, 0.45)).toBeGreaterThan(0.8);
    expect(fitPressureCurve([0.5, 0.5])).toBeNull();
  });

  it("is kept and read back", () => {
    const storage = new MemoryStorage() as unknown as Storage;
    const first = new PenPreferences(storage);
    let heard = 0;
    first.onChange(() => heard++);
    first.update({ cursor: "dot", pressureCurve: [[0, 0], [0.5, 0.8], [1, 1]] });
    expect(heard).toBe(1);
    const again = new PenPreferences(storage);
    expect(again.settings.cursor).toBe("dot");
    expect(again.settings.pressureCurve).toEqual([[0, 0], [0.5, 0.8], [1, 1]]);
  });
});

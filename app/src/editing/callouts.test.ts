import { describe, expect, it } from "vitest";
import { placeCallouts, type Box, type CalloutRequest } from "./callouts";

const view = { width: 1200, height: 800 };
const overlap = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

describe("画面のヘルプの言葉の置き場所", () => {
  // A column of nine tool buttons and a bar of buttons along the top, as on the editor.
  const tools: CalloutRequest[] = Array.from({ length: 9 }, (_, i) => ({ anchor: { left: 280, top: 50 + i * 50, width: 56, height: 48 }, side: "right", width: 200, height: 34 }));
  const bar: CalloutRequest[] = Array.from({ length: 8 }, (_, i) => ({ anchor: { left: 10 + i * 90, top: 8, width: 80, height: 28 }, side: "below", width: 170, height: 34 }));
  const area: CalloutRequest = { anchor: { left: 340, top: 80, width: 860, height: 600 }, side: "inside", width: 300, height: 50 };
  const head: Box = { left: 900, top: 650, width: 290, height: 140 };
  const placed = placeCallouts([...tools, ...bar, area], view, [head]);

  it("puts no words over other words, over a part named or over the header", () => {
    const labels = placed.map((p) => p.label);
    for (const [i, a] of labels.entries()) {
      for (const b of labels.slice(i + 1)) expect(overlap(a, b)).toBe(false);
      expect(overlap(a, head)).toBe(false);
      for (const r of [...tools, ...bar]) expect(overlap(a, r.anchor)).toBe(false);
    }
  });

  it("keeps them in the window", () => {
    for (const { label } of placed) {
      expect(label.left).toBeGreaterThanOrEqual(0);
      expect(label.top).toBeGreaterThanOrEqual(0);
      expect(label.left + label.width).toBeLessThanOrEqual(view.width);
      expect(label.top + label.height).toBeLessThanOrEqual(view.height);
    }
  });

  it("puts the tools' words beside their buttons, in their order, with a line to each", () => {
    const tops = placed.slice(0, 9).map((p) => p.label.top);
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    for (const [i, p] of placed.slice(0, 9).entries()) {
      expect(p.label.left).toBeGreaterThanOrEqual(336);
      expect(Math.abs(p.label.top + 17 - (tools[i].anchor.top + 24))).toBeLessThan(60);
      expect(p.line).not.toBeNull();
    }
    expect(placed.at(-1)!.line).toBeNull();
  });

  it("puts a bar's words under it", () => {
    for (const p of placed.slice(9, 17)) expect(p.label.top).toBeGreaterThan(36);
  });
});

describe("the help's words in a small window", () => {
  it("go to the nearest clear place when there is no room beside the part", () => {
    // A part inside a wall of words to its right: nothing free within reach across (160 px).
    const view = { width: 900, height: 300 };
    const wall = { left: 40, top: 0, width: 400, height: 300 };
    const [placed] = placeCallouts([{ anchor: { left: 0, top: 100, width: 30, height: 30 }, side: "inside", width: 120, height: 40 }], view, [wall]);
    const { label } = placed;
    const apart = label.left >= wall.left + wall.width || label.left + label.width <= wall.left;
    expect(apart).toBe(true);
    expect(label.left + label.width).toBeLessThanOrEqual(view.width);
  });
});

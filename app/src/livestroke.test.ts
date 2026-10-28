import { describe, expect, it } from "vitest";
import { drawStroke, LiveLine } from "./pagedraw";
import type { Brush, StrokePoint } from "./model";

/** A 2D context that writes down what is drawn (the parts a round line uses). */
function recorder() {
  const calls: string[] = [];
  const ctx = {
    lineWidth: 1,
    globalAlpha: 1,
    strokeStyle: "",
    lineCap: "",
    lineJoin: "",
    save() {},
    restore() {},
    beginPath() {},
    moveTo: (x: number, y: number) => calls.push(`M${x.toFixed(3)},${y.toFixed(3)}`),
    lineTo: (x: number, y: number) => calls.push(`L${x.toFixed(3)},${y.toFixed(3)}`),
    stroke() {
      calls.push(`S${ctx.lineWidth.toFixed(4)}/${ctx.globalAlpha.toFixed(4)}`);
    },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const brush: Brush = { id: "b", name: "ペン", kind: "pen", sizeMm: 1, opacity: 0.8, hardness: 100, stabilization: 0, taperInMm: 4, taperOutMm: 4, thickness: 100, rotation: 0, sizePressure: { min: 0.2 }, opacityPressure: { min: 0.5 } };
const points: StrokePoint[] = Array.from({ length: 40 }, (_, i) => [10 + i * 0.7, 20 + Math.sin(i / 4) * 3, 0.2 + (i % 7) / 10]);
const m = { scale: 3, x: 5, y: 7 };

describe("a line painted as it is drawn", () => {
  it("paints in pieces what drawing it whole paints, with the end left open", () => {
    // Longer than the brush's 入り and 抜き together: drawn whole, the 入り is as long as it is set.
    const whole = recorder();
    drawStroke(whole.ctx, { id: "", points, widthMm: 1, closed: false, brush: "b", cut: [false, true] }, m, "#000", 0.7, brush);
    const pieces = recorder();
    const live = new LiveLine(pieces.ctx);
    for (const end of [1, 2, 5, 6, 17, 30, 40]) expect(live.paint(points.slice(0, end), 1, m, "#000", brush)).toBe(true);
    expect(pieces.calls).toEqual(whole.calls);
  });

  it("starts again when the view moved", () => {
    const { ctx, calls } = recorder();
    const live = new LiveLine(ctx);
    live.paint(points.slice(0, 10), 1, m, "#000");
    expect(live.paint(points.slice(0, 12), 1, { ...m, scale: 4 }, "#000")).toBe(false);
    calls.length = 0;
    live.paint(points.slice(0, 12), 1, { ...m, scale: 4 }, "#000");
    expect(calls).toEqual([]);
    live.paint(points.slice(0, 13), 1, { ...m, scale: 4 }, "#000");
    expect(calls.filter((c) => c.startsWith("S"))).toHaveLength(1);
  });

  it("shows the line on through where the pen is about to be, and keeps none of it", () => {
    const { ctx, calls } = recorder();
    const live = new LiveLine(ctx);
    live.paint(points.slice(0, 10), 1, m, "#000");
    calls.length = 0;
    live.ahead(ctx, points.slice(0, 10), points.slice(10, 12), 1, m, "#000");
    expect(calls.filter((c) => c.startsWith("S"))).toHaveLength(2);
    calls.length = 0;
    live.paint(points.slice(0, 11), 1, m, "#000");
    expect(calls.filter((c) => c.startsWith("S"))).toHaveLength(1);
  });
});

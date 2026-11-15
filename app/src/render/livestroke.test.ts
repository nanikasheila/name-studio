import { describe, expect, it } from "vitest";
import { drawStroke, LiveLine } from "./pagedraw";
import type { Brush, StrokePoint } from "../model/model";

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

/** The segments drawn, each with the width and opacity it was stroked with (however they were put into paths). */
function segments(calls: string[]): string[] {
  const out: string[] = [];
  let path: string[] = [];
  for (const call of calls) {
    if (call.startsWith("M")) path = [call.slice(1)];
    else if (call.startsWith("L")) path.push(call.slice(1));
    else if (call.startsWith("S")) for (let i = 1; i < path.length; i++) out.push(`${path[i - 1]}>${path[i]}@${call.slice(1)}`);
  }
  return out;
}

const brush: Brush = {
  id: "b",
  name: "ペン",
  kind: "pen",
  sizeMm: 1,
  opacity: 0.8,
  hardness: 100,
  stabilization: 0,
  taperInMm: 4,
  taperOutMm: 4,
  thickness: 100,
  rotation: 0,
  sizePressure: { min: 0.2 },
  opacityPressure: { min: 0.5 },
};
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
    expect(segments(pieces.calls)).toEqual(segments(whole.calls));
    expect(segments(whole.calls)).toHaveLength(points.length - 1);
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
    expect(segments(calls)).toHaveLength(1);
  });

  it("shows the line on through where the pen is about to be, and keeps none of it", () => {
    const { ctx, calls } = recorder();
    const live = new LiveLine(ctx);
    live.paint(points.slice(0, 10), 1, m, "#000");
    calls.length = 0;
    live.ahead(ctx, points.slice(0, 10), points.slice(10, 12), 1, m, "#000");
    expect(segments(calls)).toHaveLength(2);
    calls.length = 0;
    live.paint(points.slice(0, 11), 1, m, "#000");
    expect(segments(calls)).toHaveLength(1);
  });
});

describe("lines thinner than the screen shows", () => {
  const plain: StrokePoint[] = Array.from({ length: 30 }, (_, i) => [10 + i * 0.2, 20 + Math.sin(i / 5), 1]);
  const draw = (scale: number, pixelRatio = 2) => {
    const { ctx, calls } = recorder();
    (ctx as unknown as { getTransform: () => DOMMatrix }).getTransform = () =>
      ({ a: pixelRatio, b: 0, c: 0, d: pixelRatio, e: 0, f: 0 }) as DOMMatrix;
    drawStroke(ctx, { id: "", points: plain, widthMm: 0.4, closed: false }, { scale, x: 0, y: 0 }, "#000", 0.7);
    return calls;
  };

  it("are drawn at the thinnest width but fainter, with the ink of their real width", () => {
    // 0.4 mm at 0.5 px/mm is 0.2 px: drawn 0.7 px wide at 0.2 / 0.7 of the ink, not 0.7 px of full ink.
    const strokes = draw(0.5).filter((c) => c.startsWith("S"));
    const [width, alpha] = strokes[0].slice(1).split("/").map(Number);
    expect(width).toBeCloseTo(0.75, 2);
    expect(width * alpha).toBeCloseTo(0.2, 1);
  });

  it("go as one path while their width stays the same, so close points do not darken them", () => {
    const calls = draw(0.5);
    expect(calls.filter((c) => c.startsWith("S"))).toHaveLength(1);
    expect(segments(calls)).toHaveLength(plain.length - 1);
  });

  it("thick enough are drawn as wide as they are, at full ink", () => {
    const strokes = draw(10).filter((c) => c.startsWith("S"));
    expect(strokes).toHaveLength(1);
    const [width, alpha] = strokes[0].slice(1).split("/").map(Number);
    expect(width).toBeCloseTo(4, 1);
    expect(alpha).toBe(1);
  });

  it("never vanish", () => {
    const strokes = draw(0.01).filter((c) => c.startsWith("S"));
    expect(Number(strokes[0].split("/")[1])).toBeGreaterThan(0.15);
  });
});

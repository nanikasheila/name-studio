import { describe, expect, it } from "vitest";
import {
  addBrushes,
  brushFromSubTool,
  curveAt,
  followFactor,
  opacityFactors,
  postCorrect,
  pressureFactor,
  widthFactors,
  type CspSubTool,
} from "./brush";
import { vectorLines } from "./nameexport";
import { addStroke, eraseWith, newProject, type Brush, type Stroke } from "./project";

const noInput = {
  tilt: false,
  tiltMin: 1,
  tiltCurve: [],
  velocity: false,
  velocityMin: 1,
  velocityCurve: [[0, 1], [1, 0]] as [number, number][],
  random: false,
  randomMin: 1,
};

/** 丸ペン as CSP EX 5.1.4 exports it (sizes in px). */
const maruPen: CspSubTool = {
  name: "丸ペン",
  group: ["ペン", "ペン"],
  kind: "pen",
  size: { value: 5, unit: "px" },
  sizeDynamics: {
    pressure: true,
    pressureMin: 0,
    pressureCurve: [[0, 0], [0.6636, 0.0818], [1, 1]],
    ...noInput,
  },
  opacity: 1,
  opacityDynamics: { pressure: false, pressureMin: 1, pressureCurve: [], ...noInput },
  flow: 1,
  flowDynamics: null,
  hardness: 1,
  antiAlias: 2,
  stabilization: 6,
  taperIn: { value: 20, unit: "px" },
  taperOut: { value: 20, unit: "px" },
  interval: 10,
  thickness: 100,
  rotation: 0,
  tipMaterial: null,
  tip: null,
  vectorErase: null,
};

function brush(overrides: Partial<Brush> = {}): Brush {
  return {
    id: "brush1",
    name: "b",
    kind: "pen",
    sizeMm: 1,
    opacity: 1,
    hardness: 1,
    stabilization: 0,
    taperInMm: 0,
    taperOutMm: 0,
    thickness: 100,
    rotation: 0,
    ...overrides,
  };
}

describe("pressure curves", () => {
  it("is the straight line without control points", () => {
    expect(curveAt(undefined, 0.3)).toBeCloseTo(0.3);
    expect(curveAt([[0, 0], [1, 1]], 0.7)).toBeCloseTo(0.7);
  });

  it("bends towards the middle point like CSP's graph", () => {
    // Three points: a quadratic Bézier; at t = 0.45 it is at (0.531, 0.243).
    const curve: [number, number][] = [[0, 0], [0.664, 0.082], [1, 1]];
    expect(curveAt(curve, 0.531)).toBeCloseTo(0.243, 2);
    expect(curveAt(curve, 0)).toBe(0);
    expect(curveAt(curve, 1)).toBeCloseTo(1);
    // Never passes through the control point itself.
    expect(curveAt(curve, 0.664)).toBeGreaterThan(0.082);
  });

  it("goes from the minimum to the full value", () => {
    expect(pressureFactor(undefined, 0.1)).toBe(1);
    expect(pressureFactor({ min: 0.4 }, 0)).toBeCloseTo(0.4);
    expect(pressureFactor({ min: 0.4 }, 0.5)).toBeCloseTo(0.7);
    expect(pressureFactor({ min: 0.4 }, 1)).toBeCloseTo(1);
  });
});

describe("widths along a stroke", () => {
  const line: Stroke = {
    id: "s",
    points: [[0, 0, 1], [1, 0, 1], [2, 0, 1], [5, 0, 1], [8, 0, 1], [9, 0, 1], [10, 0, 1]],
    widthMm: 1,
    closed: false,
  };

  it("keeps the old thinning for strokes without a brush", () => {
    expect(widthFactors({ ...line, points: [[0, 0, 0], [1, 0, 1]] }, undefined)).toEqual([0.35, 1]);
  });

  it("tapers both ends over the 入り抜き lengths", () => {
    const factors = widthFactors(line, brush({ taperInMm: 2, taperOutMm: 2 }));
    expect(factors[0]).toBeCloseTo(0.02);
    expect(factors[1]).toBeCloseTo(0.5);
    expect(factors[3]).toBeCloseTo(1);
    expect(factors[5]).toBeCloseTo(0.5);
    expect(factors[6]).toBeCloseTo(0.02);
  });

  it("shares a short stroke between the tapers", () => {
    const short: Stroke = { ...line, points: [[0, 0, 1], [1, 0, 1], [2, 0, 1]] };
    const factors = widthFactors(short, brush({ taperInMm: 3, taperOutMm: 1 }));
    // 2 mm long: 1.5 mm in, 0.5 mm out; the middle is 2/3 of the way in.
    expect(factors[1]).toBeCloseTo(1 / 1.5);
  });

  it("applies the opacity curve", () => {
    const stroke: Stroke = { id: "s", points: [[0, 0, 0.5]], widthMm: 1, closed: false };
    expect(opacityFactors(stroke, brush({ opacity: 0.5, opacityPressure: { min: 0 } }))[0]).toBeCloseTo(0.25);
    expect(opacityFactors(stroke, undefined)).toEqual([1]);
  });

  it("stabilizes harder with a larger 手ブレ補正", () => {
    expect(followFactor(0)).toBe(1);
    expect(followFactor(20)).toBeLessThan(followFactor(6));
  });
});

describe("taking CSP sub tools over", () => {
  it("measures px sizes at the chosen resolution", () => {
    const pen = brushFromSubTool(maruPen, 600, "brush9");
    expect(pen.sizeMm).toBeCloseTo((5 * 25.4) / 600);
    expect(pen.taperInMm).toBeCloseTo((20 * 25.4) / 600);
    expect(pen.sizePressure).toEqual({ min: 0, curve: maruPen.sizeDynamics!.pressureCurve });
    expect(pen.opacityPressure).toBeUndefined();
    expect(pen.source).toBe("CSP: ペン / 丸ペン");
    expect(pen.erase).toBeUndefined();
    expect(brushFromSubTool({ ...maruPen, size: { value: 0.5, unit: "mm" } }, 350, "b").sizeMm).toBe(0.5);
  });

  it("keeps how erasers erase and the tip picture", () => {
    const eraser = brushFromSubTool({ ...maruPen, name: "硬め", kind: "eraser", vectorErase: "intersection" }, 600, "e");
    expect(eraser.kind).toBe("eraser");
    expect(eraser.erase).toBe("intersection");
    const tipped = brushFromSubTool({ ...maruPen, tip: { width: 4, height: 2, pngBase64: "AAAA" }, interval: 25 }, 600, "t");
    expect(tipped.tip).toEqual({ width: 4, height: 2, pngBase64: "AAAA", interval: 25, enabled: true });
  });

  it("replaces a brush taken again instead of adding a copy", () => {
    const project = newProject("t", 1);
    const [first] = addBrushes(project, [brushFromSubTool(maruPen, 600, "")]);
    expect(first.id).toMatch(/^brush/);
    const [again] = addBrushes(project, [brushFromSubTool({ ...maruPen, size: { value: 10, unit: "px" } }, 600, "")]);
    expect(project.brushes).toHaveLength(1);
    expect(again.id).toBe(first.id);
    expect(project.brushes[0].sizeMm).toBeCloseTo((10 * 25.4) / 600);
  });

  it("writes brush widths into CSP vector lines", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const [pen] = addBrushes(project, [brush({ sizePressure: { min: 0.5 } })]);
    addStroke(project, page, [[0, 0, 0], [5, 0, 1]], 1, pen.id);
    const [line] = vectorLines(page, "strokes", { scale: 10, x: 0, y: 0 }, project.brushes);
    expect(line.points.map((point) => point[2])).toEqual([0.5, 1]);
  });
});

describe("tilt, speed and chance", () => {
  const pen = brush({
    sizeTilt: { min: 0.5, curve: [[0, 1], [1, 0]] },
    sizeSpeed: { min: 0.2, curve: [[0, 1], [1, 0]] },
  });

  it("thins the line as the pen tilts and speeds up", () => {
    const stroke: Stroke = {
      id: "s",
      points: [[0, 0, 1, 0, 0], [5, 0, 1, 1, 0], [10, 0, 1, 0, 1]],
      widthMm: 1,
      closed: false,
    };
    expect(widthFactors(stroke, pen)).toEqual([1, 0.5, 0.2]);
  });

  it("takes lines without tilt and speed as upright and slow", () => {
    const stroke: Stroke = { id: "s", points: [[0, 0, 1], [5, 0, 1]], widthMm: 1, closed: false };
    expect(widthFactors(stroke, pen)).toEqual([1, 1]);
  });

  it("changes randomly but the same way each time", () => {
    const random = brush({ sizeRandom: { min: 0.4 } });
    const stroke: Stroke = { id: "s", points: Array.from({ length: 50 }, (_, i) => [i, 0, 1]), widthMm: 1, closed: false };
    const factors = widthFactors(stroke, random);
    expect(widthFactors(stroke, random)).toEqual(factors);
    expect(Math.min(...factors)).toBeGreaterThanOrEqual(0.4);
    expect(Math.max(...factors) - Math.min(...factors)).toBeGreaterThan(0.2);
  });

  it("takes the inputs over from CSP", () => {
    const tool: CspSubTool = {
      ...maruPen,
      sizeDynamics: { ...maruPen.sizeDynamics!, tilt: true, tiltMin: 0.85, tiltCurve: [[0, 1], [1, 0]], velocity: true, velocityMin: 0.7, random: true, randomMin: 0.3 },
      opacityDynamics: null,
      flowDynamics: { ...maruPen.opacityDynamics!, velocity: true, velocityMin: 0.5 },
    };
    const taken = brushFromSubTool(tool, 600, "b");
    expect(taken.sizeTilt).toEqual({ min: 0.85, curve: [[0, 1], [1, 0]] });
    expect(taken.sizeSpeed).toEqual({ min: 0.7, curve: [[0, 1], [1, 0]] });
    expect(taken.sizeRandom).toEqual({ min: 0.3 });
    expect(taken.opacitySpeed).toEqual({ min: 0.5, curve: [[0, 1], [1, 0]] });
    expect(taken.opacityPressure).toBeUndefined();
  });

  it("keeps tilt and speed through the eraser", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    addStroke(project, page, [[0, 0, 1, 0, 0], [10, 0, 1, 1, 1]], 0.2);
    eraseWith(project, page, [5, 0], 0.5, "touched");
    for (const piece of page.strokes) for (const point of piece.points) expect(point).toHaveLength(5);
    const right = page.strokes[1].points[0];
    expect(right[3]).toBeCloseTo(right[0] / 10);
  });
});

describe("erasers", () => {
  function setup() {
    const project = newProject("t", 1);
    const page = project.pages[0];
    // A horizontal line crossed by two vertical ones at x = 3 and x = 7.
    addStroke(project, page, [[0, 5, 1], [10, 5, 1]], 0.2);
    addStroke(project, page, [[3, 0, 1], [3, 10, 1]], 0.2);
    addStroke(project, page, [[7, 0, 1], [7, 10, 1]], 0.2);
    return { project, page };
  }

  it("cuts out only the touched part", () => {
    const { project, page } = setup();
    expect(eraseWith(project, page, [5, 5], 0.5, "touched")).toBe(1);
    const pieces = page.strokes.filter((stroke) => stroke.points.every((p) => p[1] === 5));
    expect(pieces).toHaveLength(2);
    const ends = pieces.map((piece) => piece.points.map((p) => p[0]));
    expect(Math.max(...ends[0])).toBeLessThan(4.5);
    expect(Math.min(...ends[1])).toBeGreaterThan(5.5);
    expect(new Set(page.strokes.map((s) => s.id)).size).toBe(page.strokes.length);
  });

  it("erases up to the crossings", () => {
    const { project, page } = setup();
    eraseWith(project, page, [5, 5], 0.5, "intersection");
    const pieces = page.strokes.filter((stroke) => stroke.points.every((p) => p[1] === 5));
    expect(pieces.map((piece) => [piece.points[0][0], piece.points[piece.points.length - 1][0]])).toEqual([
      [0, 3],
      [7, 10],
    ]);
  });

  it("erases a line with no crossings whole, and whole lines in whole mode", () => {
    const { project, page } = setup();
    eraseWith(project, page, [3, 1], 0.5, "intersection");
    // The upper part of the line at x = 3, down to the crossing, is gone.
    const left = page.strokes.find((stroke) => stroke.points.every((p) => p[0] === 3))!;
    expect(left.points[0][1]).toBeCloseTo(5);
    eraseWith(project, page, [7, 1], 0.5, "whole");
    expect(page.strokes.some((stroke) => stroke.points.every((p) => p[0] === 7))).toBe(false);
  });
});

describe("ends left by an eraser", () => {
  it("are not tapered, while the line's own ends still are", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const [pen] = addBrushes(project, [brush({ taperInMm: 1, taperOutMm: 1 })]);
    addStroke(project, page, [[0, 0, 1], [2, 0, 1], [4, 0, 1], [6, 0, 1], [8, 0, 1], [10, 0, 1]], 0.2, pen.id);
    eraseWith(project, page, [5, 0], 0.4, "touched");
    expect(page.strokes).toHaveLength(2);
    const [left, right] = page.strokes;
    expect(left.cut).toEqual([false, true]);
    expect(right.cut).toEqual([true, false]);
    const leftFactors = widthFactors(left, pen);
    expect(leftFactors[0]).toBeCloseTo(0.02);
    expect(leftFactors[leftFactors.length - 1]).toBe(1);
    expect(widthFactors(right, pen)[0]).toBe(1);
  });
});

describe("補正", () => {
  it("速度による手ブレ補正 holds a fast pen back less", () => {
    expect(followFactor(20)).toBeCloseTo(1 / 6);
    expect(followFactor(20, 1, false)).toBeCloseTo(1 / 6);
    expect(followFactor(20, 0, true)).toBeCloseTo(1 / 6);
    expect(followFactor(20, 1, true)).toBeCloseTo(1 / 2.25);
  });

  it("後補正 smooths the wobble and keeps the ends", () => {
    const zigzag: [number, number, number][] = [0, 1, 2, 3, 4, 5, 6].map((x) => [x, x % 2 ? 1 : -1, 0.5]);
    const smoothed = postCorrect(zigzag, 20);
    expect(smoothed[0]).toEqual(zigzag[0]);
    expect(smoothed[6]).toEqual(zigzag[6]);
    const wobble = (points: number[][]) => Math.max(...points.slice(1, -1).map((p) => Math.abs(p[1])));
    expect(wobble(smoothed)).toBeLessThan(0.5);
    expect(smoothed[3][2]).toBe(0.5);
    expect(postCorrect(zigzag, 0)).toBe(zigzag);
  });
});

// Pens and erasers: taking them over from CLIP STUDIO PAINT sub tools
// (crates/clip-core/src/subtool.rs reads the files), and how a brush turns
// pen pressure and the stroke's length into width and opacity.
import type { Brush, PressureCurve, Project, Stroke, StrokePoint } from "./model";
import { newId } from "./project";

/** What the Rust side reads from a .sut or CSP's tool database. */
export interface CspLength {
  value: number;
  unit: "px" | "mm";
}

export interface CspDynamics {
  pressure: boolean;
  pressureMin: number;
  pressureCurve: [number, number][];
  tilt: boolean;
  tiltMin: number;
  tiltCurve: [number, number][];
  velocity: boolean;
  velocityMin: number;
  velocityCurve: [number, number][];
  random: boolean;
  randomMin: number;
}

export interface CspSubTool {
  name: string;
  group: string[];
  kind: "pen" | "eraser" | "other";
  size: CspLength | null;
  sizeDynamics: CspDynamics | null;
  opacity: number;
  opacityDynamics: CspDynamics | null;
  flow: number;
  flowDynamics: CspDynamics | null;
  hardness: number;
  antiAlias: number;
  stabilization: number;
  stabilizationBySpeed?: boolean;
  postCorrection?: number;
  taperIn: CspLength | null;
  taperOut: CspLength | null;
  interval: number;
  thickness: number;
  rotation: number;
  tipMaterial: string | null;
  tip: { width: number; height: number; pngBase64: string } | null;
  vectorErase: "touched" | "intersection" | "whole" | null;
}

/** Resolution CSP brush sizes in pixels are measured at, unless chosen otherwise. */
export const DEFAULT_BRUSH_DPI = 600;

export function lengthMm(length: CspLength | null, dpi: number): number {
  if (!length) return 0;
  return length.unit === "mm" ? length.value : (length.value * 25.4) / dpi;
}

type Input = "pressure" | "tilt" | "velocity" | "random";

/** The curve of one input of a CSP setting, if the input is on. */
function inputOf(dynamics: CspDynamics | null, input: Input): PressureCurve | undefined {
  if (!dynamics?.[input]) return undefined;
  const curve: PressureCurve = { min: dynamics[`${input}Min`] };
  const points = input === "random" ? [] : dynamics[`${input}Curve`];
  if (points.length) curve.curve = points;
  return curve;
}

export function sourceLabel(tool: CspSubTool): string {
  return `CSP: ${[...tool.group.slice(-1), tool.name].join(" / ")}`;
}

/** A name-studio brush with the CSP sub tool's settings; sizes become mm at `dpi`. */
export function brushFromSubTool(tool: CspSubTool, dpi: number, id: string): Brush {
  const brush: Brush = {
    id,
    name: tool.name,
    kind: tool.kind === "eraser" ? "eraser" : "pen",
    // A few (ドットペン) leave the size to the tool above them.
    sizeMm: tool.size ? Math.max(lengthMm(tool.size, dpi), 0.01) : 0.5,
    opacity: tool.opacity,
    hardness: tool.hardness,
    stabilization: tool.stabilization,
    ...(tool.stabilizationBySpeed ? { stabilizationBySpeed: true } : {}),
    ...(tool.postCorrection ? { postCorrection: tool.postCorrection } : {}),
    taperInMm: lengthMm(tool.taperIn, dpi),
    taperOutMm: lengthMm(tool.taperOut, dpi),
    thickness: tool.thickness || 100,
    rotation: tool.rotation,
    source: sourceLabel(tool),
  };
  const keys = { pressure: "Pressure", tilt: "Tilt", velocity: "Speed", random: "Random" } as const;
  for (const input of ["pressure", "tilt", "velocity", "random"] as const) {
    const size = inputOf(tool.sizeDynamics, input);
    if (size) brush[`size${keys[input]}`] = size;
    // ブラシ濃度 works much like opacity on a name page.
    const opacity = inputOf(tool.opacityDynamics, input) ?? inputOf(tool.flowDynamics, input);
    if (opacity) brush[`opacity${keys[input]}`] = opacity;
  }
  if (tool.tip) {
    brush.tip = { ...tool.tip, interval: tool.interval || 10, enabled: true };
  }
  if (brush.kind === "eraser") brush.erase = tool.vectorErase ?? "touched";
  return brush;
}

/** Add brushes to the project; one with the same source and name is replaced in place. */
export function addBrushes(project: Project, brushes: Brush[]): Brush[] {
  const added: Brush[] = [];
  for (const brush of brushes) {
    const existing = project.brushes.find((b) => b.source === brush.source && b.name === brush.name && b.kind === brush.kind);
    if (existing) {
      Object.assign(existing, { ...brush, id: existing.id });
      added.push(existing);
    } else {
      const copy = { ...brush, id: newId(project, "brush") };
      project.brushes.push(copy);
      added.push(copy);
    }
  }
  return added;
}

export function brushOf(project: Project | null, stroke: Stroke): Brush | undefined {
  return stroke.brush ? project?.brushes.find((brush) => brush.id === stroke.brush) : undefined;
}

// --- pressure curves ---------------------------------------------------------------

const curveTables = new WeakMap<object, [number, number][]>();

/**
 * The curve through control points as CSP draws it: a quadratic B-spline from
 * the first point to the last that bends towards the ones in between, sampled
 * into a table.
 */
function curveTable(points: [number, number][]): [number, number][] {
  const cached = curveTables.get(points);
  if (cached) return cached;
  const table: [number, number][] = [];
  const n = points.length - 1;
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (n < 2) {
    table.push(points[0] ?? [0, 0], points[n] ?? [1, 1]);
  } else {
    for (let k = 1; k < n; k++) {
      const start = k === 1 ? points[0] : mid(points[k - 1], points[k]);
      const end = k === n - 1 ? points[n] : mid(points[k], points[k + 1]);
      const control = points[k];
      for (let i = k === 1 ? 0 : 1; i <= 16; i++) {
        const t = i / 16;
        const u = 1 - t;
        table.push([
          u * u * start[0] + 2 * u * t * control[0] + t * t * end[0],
          u * u * start[1] + 2 * u * t * control[1] + t * t * end[1],
        ]);
      }
    }
  }
  curveTables.set(points, table);
  return table;
}

/** Output of a pressure graph at input `x` (both 0..1). */
export function curveAt(points: [number, number][] | undefined, x: number): number {
  if (!points || points.length < 2) return x;
  const table = curveTable(points);
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

/** Share of the full value at `pressure`: `min` at none, 1 at full. */
export function pressureFactor(curve: PressureCurve | undefined, pressure: number): number {
  if (!curve) return 1;
  const value = curveAt(curve.curve, Math.max(0, Math.min(1, pressure)));
  return curve.min + (1 - curve.min) * Math.max(0, Math.min(1, value));
}

/** Whether lines drawn with the brush need the pen's tilt and speed kept. */
export function usesMotion(brush: Brush | undefined): boolean {
  return !!(brush && (brush.sizeTilt || brush.sizeSpeed || brush.opacityTilt || brush.opacitySpeed));
}

/** Pen speed (page mm per second) that counts as the fastest on a speed graph. */
export const FULL_SPEED_MM = 400;

/** Same random value for the same line and point every time it is drawn. */
function chance(seed: string, index: number): number {
  let hash = 2166136261 ^ index;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  hash = Math.imul(hash ^ (hash >>> 15), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

/** Share of the full value at a point from pressure, tilt, speed and chance. */
function inputFactor(
  curves: { pressure?: PressureCurve; tilt?: PressureCurve; speed?: PressureCurve; random?: PressureCurve },
  point: StrokePoint,
  seed: string,
  index: number,
): number {
  let factor = pressureFactor(curves.pressure, point[2]);
  // Lines drawn without tilt and speed kept are taken as upright and slow.
  if (curves.tilt) factor *= pressureFactor(curves.tilt, point[3] ?? 0);
  if (curves.speed) factor *= pressureFactor(curves.speed, point[4] ?? 0);
  if (curves.random) factor *= pressureFactor(curves.random, chance(seed, index));
  return factor;
}

/** Width share of each point of a stroke: pen pressure, tilt, speed, then 入り抜き at the ends. */
export function widthFactors(stroke: Stroke, brush: Brush | undefined): number[] {
  const points = stroke.points;
  if (!brush) return points.map(([, , p]) => 0.35 + 0.65 * p);
  const along = [0];
  for (let i = 1; i < points.length; i++) {
    along.push(along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const total = along[along.length - 1];
  // Ends an eraser left keep their width.
  let taperIn = stroke.cut?.[0] ? 0 : brush.taperInMm;
  let taperOut = stroke.cut?.[1] ? 0 : brush.taperOutMm;
  // A short stroke shares its length between the two tapers.
  if (taperIn + taperOut > total && taperIn + taperOut > 0) {
    const share = total / (taperIn + taperOut);
    taperIn *= share;
    taperOut *= share;
  }
  const curves = { pressure: brush.sizePressure, tilt: brush.sizeTilt, speed: brush.sizeSpeed, random: brush.sizeRandom };
  return points.map((point, i) => {
    let factor = inputFactor(curves, point, stroke.id, i);
    if (taperIn > 0) factor *= Math.min(1, along[i] / taperIn);
    if (taperOut > 0) factor *= Math.min(1, (total - along[i]) / taperOut);
    return Math.max(factor, 0.02);
  });
}

/** Opacity of each point of a stroke. */
export function opacityFactors(stroke: Stroke, brush: Brush | undefined): number[] {
  if (!brush) return stroke.points.map(() => 1);
  const curves = { pressure: brush.opacityPressure, tilt: brush.opacityTilt, speed: brush.opacitySpeed, random: brush.opacityRandom };
  // Offset so the random change differs from the size's.
  const seed = `${stroke.id}/opacity`;
  return stroke.points.map((point, i) => Math.max(0, Math.min(1, brush.opacity * inputFactor(curves, point, seed, i))));
}

/** Tilt input of a pointer event: 0 upright, 1 lying flat (0 for a mouse). */
export function tiltOf(event: PointerEvent): number {
  if (event.pointerType !== "pen") return 0;
  const altitude = (event as PointerEvent & { altitudeAngle?: number }).altitudeAngle;
  if (typeof altitude === "number") return Math.max(0, Math.min(1, 1 - altitude / (Math.PI / 2)));
  const x = Math.tan((event.tiltX * Math.PI) / 180);
  const y = Math.tan((event.tiltY * Math.PI) / 180);
  return Math.max(0, Math.min(1, Math.atan(Math.hypot(x, y)) / (Math.PI / 2)));
}

/**
 * 手ブレ補正 while drawing: how far each new point moves towards the pen (1 = all the way).
 * With 速度による手ブレ補正 a fast pen (speed 0–1 of {@link FULL_SPEED_MM}) is held back less,
 * so quick lines keep up while slow ones stay steady.
 */
export function followFactor(stabilization: number, speed = 0, bySpeed = false): number {
  const strength = Math.max(0, stabilization) * (bySpeed ? 1 - 0.75 * Math.min(1, Math.max(0, speed)) : 1);
  return 1 / (1 + strength / 4);
}

/**
 * 後補正: once the line is drawn, smooth its wobble (positions only; the ends stay put).
 * `strength` is CSP's 0–100; every 5 is one more pass.
 */
export function postCorrect<T extends number[]>(points: T[], strength: number): T[] {
  const passes = Math.min(20, Math.round(Math.max(0, strength) / 5));
  if (passes === 0 || points.length < 3) return points;
  let current = points;
  for (let pass = 0; pass < passes; pass++) {
    current = current.map((point, i) => {
      if (i === 0 || i === current.length - 1) return point;
      const [before, after] = [current[i - 1], current[i + 1]];
      const moved = [...point] as T;
      moved[0] = before[0] * 0.25 + point[0] * 0.5 + after[0] * 0.25;
      moved[1] = before[1] * 0.25 + point[1] * 0.5 + after[1] * 0.25;
      return moved;
    });
  }
  return current;
}

/** The library with `brushes` added; one from the same source, name and kind is replaced. */
export function withBrushes(library: readonly Brush[], brushes: readonly Brush[]): Brush[] {
  const merged = [...library];
  for (const brush of brushes) {
    const index = merged.findIndex((b) => b.source === brush.source && b.name === brush.name && b.kind === brush.kind);
    if (index >= 0) merged[index] = brush;
    else merged.push(brush);
  }
  return merged;
}

// Pens and erasers: taking them over from CLIP STUDIO PAINT sub tools
// (crates/clip-core/src/subtool.rs reads the files), and how a brush turns
// pen pressure and the stroke's length into width and opacity.
import { newId, type Brush, type PressureCurve, type Project, type Stroke } from "./project";

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
  velocity: boolean;
  random: boolean;
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

function pressureOf(dynamics: CspDynamics | null): PressureCurve | undefined {
  if (!dynamics?.pressure) return undefined;
  const curve: PressureCurve = { min: dynamics.pressureMin };
  if (dynamics.pressureCurve.length) curve.curve = dynamics.pressureCurve;
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
    sizeMm: Math.max(lengthMm(tool.size, dpi), 0.01),
    opacity: tool.opacity,
    hardness: tool.hardness,
    stabilization: tool.stabilization,
    taperInMm: lengthMm(tool.taperIn, dpi),
    taperOutMm: lengthMm(tool.taperOut, dpi),
    thickness: tool.thickness || 100,
    rotation: tool.rotation,
    source: sourceLabel(tool),
  };
  const size = pressureOf(tool.sizeDynamics);
  if (size) brush.sizePressure = size;
  // ブラシ濃度 works much like opacity on a name page.
  const opacity = pressureOf(tool.opacityDynamics) ?? pressureOf(tool.flowDynamics);
  if (opacity) brush.opacityPressure = opacity;
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

/** Width share of each point of a stroke: pen pressure, then 入り抜き at the ends. */
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
  return points.map(([, , pressure], i) => {
    let factor = pressureFactor(brush.sizePressure, pressure);
    if (taperIn > 0) factor *= Math.min(1, along[i] / taperIn);
    if (taperOut > 0) factor *= Math.min(1, (total - along[i]) / taperOut);
    return Math.max(factor, 0.02);
  });
}

export function opacityAt(brush: Brush | undefined, pressure: number): number {
  if (!brush) return 1;
  return Math.max(0, Math.min(1, brush.opacity * pressureFactor(brush.opacityPressure, pressure)));
}

/** 手ブレ補正 while drawing: how far each new point moves towards the pen (1 = all the way). */
export function followFactor(stabilization: number): number {
  return 1 / (1 + Math.max(0, stabilization) / 4);
}

// --- brushes kept between projects ---------------------------------------------------

const LIBRARY_KEY = "name-studio.brushes";

/** Brushes taken from CSP before, in any project (this computer only). */
export function loadLibrary(): Brush[] {
  try {
    const text = localStorage.getItem(LIBRARY_KEY);
    const brushes = text ? (JSON.parse(text) as Brush[]) : [];
    return Array.isArray(brushes) ? brushes : [];
  } catch {
    return [];
  }
}

export function saveToLibrary(brushes: Brush[]): void {
  const library = loadLibrary();
  for (const brush of brushes) {
    const index = library.findIndex((b) => b.source === brush.source && b.name === brush.name && b.kind === brush.kind);
    if (index >= 0) library[index] = brush;
    else library.push(brush);
  }
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
  } catch {
    // Storage full or blocked: the brushes still live in the project.
  }
}

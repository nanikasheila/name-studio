// A pen's or eraser's CLIP STUDIO PAINT settings, kept whole with the brush
// (Brush.csp: CSP's own rows, column by column): reading and changing them,
// the 影響元設定 (effector) blobs inside them, and the drawing values of the
// brush worked out from them. The brush settings edit these rows, and they go
// back to CSP as a .sut (crates/clip-core/src/subtool.rs writes it).
//
// What each column means comes from csp-format (generated/csp-columns.ts);
// the effector layout is csp-assets' `Effector`, big endian:
// header words [0] size (40, 44 or 48), [1] inputs offered, [2] inputs on,
// [3..6] minimum % with pressure, tilt, speed, random, [7] 0,
// [8] [9] byte sizes of the pressure and tilt graphs, [10] (44+) maximum %
// with tilt, [11] (48) byte size of the speed graph; then the graphs, each
// `u32 12, u32 count, u32 16` and (f64 x, f64 y) points.
import { DEFAULT_BRUSH_DPI } from "./brush";
import type { Brush, BrushKind, CspToolData, CspValue, EraseMode, PressureCurve } from "./model";

// --- values ------------------------------------------------------------------------------

export function bytesOf(base64: string): Uint8Array {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

export function base64Of(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** A number setting; `fallback` when the tool does not set it. */
export function numberOf(tool: CspToolData, column: string, fallback = 0): number {
  const value = tool.settings[column];
  return typeof value === "number" ? value : fallback;
}

/** Whether the tool sets the column. */
export function has(tool: CspToolData, column: string): boolean {
  return tool.settings[column] !== undefined;
}

export function blobOf(tool: CspToolData, column: string): Uint8Array | null {
  const value = tool.settings[column];
  return value && typeof value === "object" ? bytesOf(value.blob) : null;
}

export function setSetting(tool: CspToolData, column: string, value: CspValue | Uint8Array | undefined): void {
  if (value === undefined) delete tool.settings[column];
  else tool.settings[column] = value instanceof Uint8Array ? { blob: base64Of(value) } : value;
}

// --- 影響元設定 ----------------------------------------------------------------------------

export const INPUT_PRESSURE = 0x10;
export const INPUT_TILT = 0x20;
export const INPUT_SPEED = 0x40;
export const INPUT_RANDOM = 0x80;
/** The inputs, in the order of the minimum words and of CSP's dialog. */
export const INPUTS = [
  { bit: INPUT_PRESSURE, label: "筆圧" },
  { bit: INPUT_TILT, label: "傾き" },
  { bit: INPUT_SPEED, label: "速度" },
  { bit: INPUT_RANDOM, label: "ランダム" },
] as const;

export type Graph = [number, number][];

export interface Effector {
  headerSize: number;
  /** Inputs this setting offers (bits). */
  offered: number;
  /** Inputs in use (bits). */
  inputs: number;
  /** Minimum % with pressure, tilt, speed and random. */
  minimum: [number, number, number, number];
  word7: number;
  /** Maximum % with tilt (44- and 48-byte headers). */
  word10: number | null;
  pressure: Graph | null;
  tilt: Graph | null;
  speed: Graph | null;
}

/** An effector blob, or null when the bytes are not one. */
export function parseEffector(data: Uint8Array): Effector | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const word = (at: number) => (at + 4 <= data.length ? view.getUint32(at) : Number.NaN);
  const headerSize = word(0);
  if (headerSize !== 40 && headerSize !== 44 && headerSize !== 48) return null;
  const w = (i: number) => word(i * 4);
  const sizes = [w(8), w(9), headerSize >= 48 ? w(11) : 0];
  if (sizes.some(Number.isNaN)) return null;
  let at = headerSize;
  const graphs: (Graph | null)[] = [];
  for (const size of sizes) {
    if (size === 0) {
      graphs.push(null);
      continue;
    }
    if (at + size > data.length || word(at) !== 12 || word(at + 8) !== 16) return null;
    const count = word(at + 4);
    if (12 + count * 16 !== size) return null;
    const graph: Graph = [];
    for (let i = 0; i < count; i++) graph.push([view.getFloat64(at + 12 + i * 16), view.getFloat64(at + 20 + i * 16)]);
    graphs.push(graph);
    at += size;
  }
  if (at !== data.length) return null;
  return {
    headerSize,
    offered: w(1),
    inputs: w(2),
    minimum: [view.getInt32(12), view.getInt32(16), view.getInt32(20), view.getInt32(24)],
    word7: w(7),
    word10: headerSize >= 44 ? w(10) : null,
    pressure: graphs[0],
    tilt: graphs[1],
    speed: graphs[2],
  };
}

/** The blob of an effector; an unchanged one gives back its bytes. */
export function effectorBytes(effector: Effector): Uint8Array {
  const graphs = [effector.pressure, effector.tilt, effector.speed];
  const sizeOf = (graph: Graph | null) => (graph ? 12 + graph.length * 16 : 0);
  // A speed graph needs the 48-byte header.
  const headerSize = effector.speed && effector.headerSize < 48 ? 48 : effector.headerSize;
  const stored = headerSize >= 48 ? graphs : graphs.slice(0, 2);
  const length = headerSize + stored.reduce((sum, graph) => sum + sizeOf(graph), 0);
  const view = new DataView(new ArrayBuffer(length));
  const words = [
    headerSize,
    effector.offered,
    effector.inputs,
    ...effector.minimum.map((m) => m >>> 0),
    effector.word7,
    sizeOf(graphs[0]),
    sizeOf(graphs[1]),
  ];
  if (headerSize >= 44) words.push(effector.word10 ?? 100);
  if (headerSize >= 48) words.push(sizeOf(graphs[2]));
  words.forEach((value, i) => view.setUint32(i * 4, value));
  let at = headerSize;
  for (const graph of stored) {
    if (!graph) continue;
    view.setUint32(at, 12);
    view.setUint32(at + 4, graph.length);
    view.setUint32(at + 8, 16);
    graph.forEach(([x, y], i) => {
      view.setFloat64(at + 12 + i * 16, x);
      view.setFloat64(at + 20 + i * 16, y);
    });
    at += sizeOf(graph);
  }
  return new Uint8Array(view.buffer);
}

/** An effector with nothing on, offering what CSP's pens offer. */
export function newEffector(): Effector {
  return { headerSize: 48, offered: 0x1f0, inputs: 0, minimum: [0, 0, 0, 0], word7: 0, word10: 100, pressure: null, tilt: null, speed: null };
}

export function effectorOf(tool: CspToolData, column: string): Effector | null {
  const blob = blobOf(tool, column);
  return blob ? parseEffector(blob) : null;
}

// --- the drawing values ------------------------------------------------------------------

/** A graph's points in 0..1; none for no graph or the straight line. */
function curvePoints(graph: Graph | null): Graph {
  const points = (graph ?? []).map(([x, y]): [number, number] => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]);
  const straight = points.length === 2 && points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 1 && points[1][1] === 1;
  return straight ? [] : points;
}

type Input = "pressure" | "tilt" | "speed" | "random";

/** How one input of an effector changes the value, if it is on. */
function inputCurve(effector: Effector | null, input: Input): PressureCurve | undefined {
  const index = { pressure: 0, tilt: 1, speed: 2, random: 3 }[input];
  if (!effector || !(effector.inputs & INPUTS[index].bit)) return undefined;
  const curve: PressureCurve = { min: Math.min(1, Math.max(0, effector.minimum[index] / 100)) };
  // Without a speed graph CSP thins the line as the pen speeds up.
  const points =
    input === "random" ? [] : input === "speed" ? (effector.speed ? curvePoints(effector.speed) : [[0, 1], [1, 0]]) : curvePoints(effector[input]);
  if (points.length) curve.curve = points as [number, number][];
  return curve;
}

/** A length setting in mm: pixels at `dpi`, or (unit 2) tens of pixels. */
function lengthMm(tool: CspToolData, column: string, unitColumn: string): number {
  const px = numberOf(tool, column) * (numberOf(tool, unitColumn) === 2 ? 10 : 1);
  return (px * 25.4) / (tool.dpi || DEFAULT_BRUSH_DPI);
}

/** Pixels at `dpi` for `mm`, as CSP keeps them (two decimals). */
function pxOf(mm: number, dpi: number): number {
  return Math.round(((mm * dpi) / 25.4) * 100) / 100;
}

/** Whether CSP draws the tool as an eraser. */
export function isEraser(tool: CspToolData): boolean {
  const input = tool.node?.NodeInputOp;
  const output = tool.node?.NodeOutputOp;
  return input === 12 || output === 12 || numberOf(tool, "CompositeMode") === 27;
}

const ERASE_TYPES: EraseMode[] = ["touched", "intersection", "whole"];

/** The values of a Brush that drawing reads; what the CSP settings decide of them. */
export type DrawnValues = Omit<Brush, "id" | "name" | "kind" | "tip" | "source" | "csp">;

/** The brush's drawing values from its CSP settings (as taking it over from CSP gives them). */
export function drawnValues(tool: CspToolData, kind: BrushKind): DrawnValues {
  const percent = (column: string, fallback: number) => Math.min(1, Math.max(0, numberOf(tool, column, fallback * 100) / 100));
  const taper = (use: string, length: string, unit: string) => (numberOf(tool, use) ? lengthMm(tool, length, unit) : 0);
  const values: DrawnValues = {
    sizeMm: has(tool, "BrushSize") ? Math.max(lengthMm(tool, "BrushSize", "BrushSizeUnit"), 0.01) : 0.5,
    opacity: percent("Opacity", 1),
    hardness: percent("BrushHardness", 1),
    stabilization: numberOf(tool, "FlickerReduction"),
    taperInMm: taper("BrushUseIn", "BrushInLength", "BrushInLengthUnit"),
    taperOutMm: taper("BrushUseOut", "BrushOutLength", "BrushOutLengthUnit"),
    thickness: numberOf(tool, "BrushThickness", 100) || 100,
    rotation: numberOf(tool, "BrushRotation"),
  };
  if (numberOf(tool, "FlickerReductionBySpeed")) values.stabilizationBySpeed = true;
  if (numberOf(tool, "BrushUseRevision") && numberOf(tool, "BrushRevision")) values.postCorrection = numberOf(tool, "BrushRevision");
  const size = effectorOf(tool, "BrushSizeEffector");
  const opacity = effectorOf(tool, "BrushOpacityEffector");
  const flow = effectorOf(tool, "BrushFlowEffector");
  const keys = { pressure: "Pressure", tilt: "Tilt", speed: "Speed", random: "Random" } as const;
  for (const input of ["pressure", "tilt", "speed", "random"] as const) {
    const sizeCurve = inputCurve(size, input);
    if (sizeCurve) values[`size${keys[input]}`] = sizeCurve;
    // ブラシ濃度 works much like opacity on a name page.
    const opacityCurve = inputCurve(opacity, input) ?? inputCurve(flow, input);
    if (opacityCurve) values[`opacity${keys[input]}`] = opacityCurve;
  }
  if (kind === "eraser") {
    values.erase = numberOf(tool, "BrushUseVectorEraser") ? (ERASE_TYPES[numberOf(tool, "BrushVectorEraserType")] ?? "touched") : "touched";
  }
  return values;
}

/** The drawing values that come from the CSP settings, cleared before they are worked out again. */
const DRAWN_OPTIONAL: (keyof DrawnValues)[] = [
  "sizePressure",
  "sizeTilt",
  "sizeSpeed",
  "sizeRandom",
  "opacityPressure",
  "opacityTilt",
  "opacitySpeed",
  "opacityRandom",
  "stabilizationBySpeed",
  "postCorrection",
  "erase",
];

/** Work out the brush's drawing values again from its CSP settings (after they changed). */
export function applyCspSettings(brush: Brush): void {
  const tool = brush.csp;
  if (!tool) return;
  for (const key of DRAWN_OPTIONAL) delete brush[key];
  Object.assign(brush, drawnValues(tool, brush.kind));
  if (brush.tip) {
    brush.tip.interval = numberOf(tool, "BrushInterval", 10) || 10;
    brush.tip.enabled = !has(tool, "BrushUsePatternImage") || numberOf(tool, "BrushUsePatternImage") !== 0;
  }
}

// --- settings for a brush CSP did not give ----------------------------------------------

/** Effector settings for a pressure curve of the brush (none: the input off). */
function effectorFrom(curves: { pressure?: PressureCurve; tilt?: PressureCurve; speed?: PressureCurve; random?: PressureCurve }): Effector {
  const effector = newEffector();
  INPUTS.forEach(({ bit }, index) => {
    const input = (["pressure", "tilt", "speed", "random"] as const)[index];
    const curve = curves[input];
    if (!curve) return;
    effector.inputs |= bit;
    effector.minimum[index] = Math.round(curve.min * 100);
    const points: Graph = curve.curve?.length ? curve.curve : [[0, 0], [1, 1]];
    if (input === "pressure") effector.pressure = points;
    if (input === "tilt") effector.tilt = points;
    if (input === "speed") effector.speed = points;
  });
  return effector;
}

/**
 * CSP settings for a brush that has none (made in name-studio, or taken from
 * CSP before the settings were kept): a pen or eraser of CSP's own kind with
 * the brush's size, opacity, curves and corrections. Sizes are in pixels
 * at {@link DEFAULT_BRUSH_DPI}, as CSP's own pens keep them.
 */
export function cspSettingsFor(brush: Brush): CspToolData {
  const eraser = brush.kind === "eraser";
  const dpi = DEFAULT_BRUSH_DPI;
  const tool: CspToolData = {
    settings: {
      Opacity: Math.round(brush.opacity * 100),
      CompositeMode: eraser ? 27 : 0,
      AntiAlias: 2,
      FlickerReduction: Math.round(brush.stabilization),
      FlickerReductionBySpeed: brush.stabilizationBySpeed ? 1 : 0,
      BrushSize: pxOf(brush.sizeMm, dpi),
      BrushSizeUnit: 0,
      BrushFlow: 100,
      BrushHardness: Math.max(1, Math.round(brush.hardness * 100)),
      BrushInterval: brush.tip?.interval ?? 10,
      BrushAutoIntervalType: 2,
      BrushThickness: Math.round(brush.thickness),
      BrushVerticalThicknes: 0,
      BrushRotation: brush.rotation,
      BrushUsePatternImage: 0,
      BrushInOutType: 0,
      BrushUseIn: brush.taperInMm > 0 ? 1 : 0,
      BrushInLength: pxOf(brush.taperInMm, dpi),
      BrushInLengthUnit: 0,
      BrushUseOut: brush.taperOutMm > 0 ? 1 : 0,
      BrushOutLength: pxOf(brush.taperOutMm, dpi),
      BrushOutLengthUnit: 0,
      BrushUseRevision: brush.postCorrection ? 1 : 0,
      BrushRevision: brush.postCorrection ?? 0,
      BrushSharpenCorner: 0,
    },
    node: eraser ? { NodeInputOp: 12, NodeOutputOp: 12, NodeRangeOp: 0, NodeIcon: 106 } : { NodeInputOp: 11, NodeOutputOp: 11, NodeRangeOp: 0, NodeIcon: 101 },
    manager: { ToolType: 0, Version: 145 },
    dpi,
  };
  setSetting(tool, "BrushSizeEffector", effectorBytes(effectorFrom({ pressure: brush.sizePressure, tilt: brush.sizeTilt, speed: brush.sizeSpeed, random: brush.sizeRandom })));
  setSetting(
    tool,
    "BrushOpacityEffector",
    effectorBytes(effectorFrom({ pressure: brush.opacityPressure, tilt: brush.opacityTilt, speed: brush.opacitySpeed, random: brush.opacityRandom })),
  );
  if (eraser) {
    const type = ERASE_TYPES.indexOf(brush.erase ?? "touched");
    setSetting(tool, "BrushUseVectorEraser", 1);
    setSetting(tool, "BrushVectorEraserType", Math.max(0, type));
  }
  return tool;
}

/** A plain new pen or eraser, with settings ready to edit. */
export function newBrush(kind: BrushKind, id: string, name: string): Brush {
  const brush: Brush = {
    id,
    name,
    kind,
    sizeMm: kind === "eraser" ? 3 : 0.5,
    sizePressure: kind === "pen" ? { min: 0.1 } : undefined,
    opacity: 1,
    hardness: 1,
    stabilization: 6,
    taperInMm: 0,
    taperOutMm: 0,
    thickness: 100,
    rotation: 0,
    source: "name-studio",
  };
  if (!brush.sizePressure) delete brush.sizePressure;
  if (kind === "eraser") brush.erase = "touched";
  brush.csp = cspSettingsFor(brush);
  applyCspSettings(brush);
  return brush;
}

/** The brush's CSP settings, made from its values first if it has none. */
export function ensureCspSettings(brush: Brush): CspToolData {
  brush.csp ??= cspSettingsFor(brush);
  return brush.csp;
}

// --- materials ---------------------------------------------------------------------------

/** Names (or paths) of the materials in a material list blob (`*PatternImageArray`, `*TextureImage`). */
export function materialNames(data: Uint8Array): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 8 || view.getUint32(0) !== 8) return [];
  const utf16 = (at: number, length: number) => {
    let text = "";
    for (let i = 0; i + 1 < length; i += 2) text += String.fromCharCode(view.getUint16(at + i, true));
    return text.replace(/\0+$/, "");
  };
  const names: string[] = [];
  let at = 8;
  for (let n = view.getUint32(4); n > 0 && at + 8 <= data.length; n--) {
    const size = view.getUint32(at);
    const end = at + size;
    if (size < 8 || end > data.length) break;
    const pathLength = view.getUint32(at + 4);
    const path = utf16(at + 8, pathLength);
    let name = "";
    const nameAt = at + 8 + pathLength + 4;
    if (nameAt + 4 <= end) {
      const nameLength = view.getUint32(nameAt);
      if (nameAt + 4 + nameLength <= end) name = utf16(nameAt + 4, nameLength);
    }
    names.push(name || path);
    at = end;
  }
  return names;
}

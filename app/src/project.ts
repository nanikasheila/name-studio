// ネームデータ（正本）: the same shapes as crates/name-model/src/model.rs, and
// the edits the editor makes to them. Coordinates are millimetres on the page
// canvas, origin at its top left. Functions here change the project in place;
// the editor takes a snapshot before each change for undo.

import { storedOutline } from "./balloon";
import { inheritOpenEdges } from "./koma";

export type Point = [number, number];
/** `[x0, y0, x1, y1]` in millimetres. */
export type BoxMm = [number, number, number, number];

export type Binding = "right" | "left";
export type LineKind = "speech" | "thought" | "narration" | "sfx" | "aside";

/** 枠線: solid, 太枠, 枠なし, 破線 (flashback), 波線 (dream). */
export type PanelBorder = "solid" | "thick" | "none" | "dashed" | "wavy";
/** 塗り: none lets panels under it show; white covers them (inset panels). */
export type PanelFill = "none" | "white" | "black" | "gray";
/** Background effect: 流線, 集中線, ウニフラ, キラキラ. */
export type PanelEffect = "none" | "speed" | "focus" | "flash" | "sparkle";

/** フキダシの形; "auto" follows the kind of line. */
export type BalloonShape =
  | "auto"
  | "ellipse"
  | "rounded"
  | "box"
  | "polygon"
  | "cloud"
  | "spike"
  | "burst"
  | "wavy"
  | "flash"
  | "electric"
  | "dashed"
  | "none"
  /** An outline imported from CSP, kept as it is in `balloon`. */
  | "custom";
export type TailStyle = "wedge" | "bubbles" | "line" | "zigzag";

/** しっぽ: from the balloon towards the speaker (who may be off the panel). */
export interface Tail {
  tip: Point;
  style?: TailStyle;
}

export interface PageFormat {
  canvasMm: [number, number];
  trimMm: [number, number];
  basicMm: [number, number];
  basicOffsetMm: [number, number];
}

export interface Panel {
  id: string;
  shape: Point[];
  order: number;
  border?: PanelBorder;
  /** Edges not drawn (裁ち切り): edge i runs from shape[i] to shape[i + 1]. */
  openEdges?: number[];
  fill?: PanelFill;
  effect?: PanelEffect;
  /** Stacking order; inset panels (はめ込み) sit above with 1. */
  z?: number;
  /** 演出メモ */
  note?: string;
  /** 見開き: shared by the two halves of a panel across the gutter. */
  spread?: string;
}

/** はみ出し: an area over the panels where borders and gutters are blanked. */
export interface Breakout {
  id: string;
  shape: Point[];
  note?: string;
}

export interface Line {
  id: string;
  text: string;
  kind: LineKind;
  speaker?: string;
  panel?: string;
  box: BoxMm;
  fontSizePt: number;
  vertical: boolean;
  /** Balloon outline with tails and links merged in (what exports draw). */
  balloon?: Point[];
  balloonShape?: BalloonShape;
  tails?: Tail[];
  /** 連結: joined to this line's balloon. */
  linkTo?: string;
  /** 白抜き: black balloon, white text. */
  inverted?: boolean;
  /** 強調: bold. */
  emphasis?: boolean;
}

/**
 * `[x, y, pressure]`, or `[x, y, pressure, tilt, speed]` when the brush
 * changes with them; all but x and y are 0..1, tilt 0 is the pen upright.
 */
export type StrokePoint = [number, number, number] | [number, number, number, number, number];

export interface Stroke {
  id: string;
  points: StrokePoint[];
  widthMm: number;
  closed: boolean;
  /** Drawn over the panel borders (in a はみ出し). */
  over?: boolean;
  /** Id of the brush it was drawn with; none is the plain pen. */
  brush?: string;
  /** Start / end left by an eraser: no 入り抜き there. */
  cut?: [boolean, boolean];
}

export type BrushKind = "pen" | "eraser";
/** 触れた部分 / 交点まで / 線全体. */
export type EraseMode = "touched" | "intersection" | "whole";

/** `min` at the lightest pressure (or tilt, speed), 1 at the most, along `curve` (control points in 0..1). */
export interface PressureCurve {
  min: number;
  curve?: [number, number][];
}

export interface BrushTip {
  /** White PNG with the tip's coverage in alpha. */
  pngBase64: string;
  width: number;
  height: number;
  /** Stamp spacing in % of the size. */
  interval: number;
  enabled: boolean;
}

/** A pen or eraser, often taken from CLIP STUDIO PAINT (crates/name-model Brush). */
export interface Brush {
  id: string;
  name: string;
  kind: BrushKind;
  sizeMm: number;
  sizePressure?: PressureCurve;
  sizeTilt?: PressureCurve;
  sizeSpeed?: PressureCurve;
  /** Random change along the line (only `min` is used). */
  sizeRandom?: PressureCurve;
  opacity: number;
  opacityPressure?: PressureCurve;
  opacityTilt?: PressureCurve;
  opacitySpeed?: PressureCurve;
  opacityRandom?: PressureCurve;
  hardness: number;
  /** 手ブレ補正, 0..100. */
  stabilization: number;
  /** 速度による手ブレ補正: steadier the faster the pen moves. */
  stabilizationBySpeed?: boolean;
  /** 後補正: smoothing applied once a line is drawn, 0..100. */
  postCorrection?: number;
  taperInMm: number;
  taperOutMm: number;
  /** Tip height in % of its width, and its angle in degrees. */
  thickness: number;
  rotation: number;
  tip?: BrushTip;
  erase?: EraseMode;
  source?: string;
}

export interface RoughImage {
  id: string;
  layerId: number;
  layerName: string;
  sheetCrop: [number, number, number, number];
  box: BoxMm;
}

export interface Page {
  id: string;
  memo: string;
  panels: Panel[];
  lines: Line[];
  strokes: Stroke[];
  roughs: RoughImage[];
  breakouts: Breakout[];
  /** 見開きページ: this page and the next (its facing page) go to CSP as one spread page. */
  joinNext?: boolean;
}

export interface Character {
  id: string;
  name: string;
  color?: string;
}

export interface Scene {
  id: string;
  title: string;
  summary: string;
  firstPage: string;
  lastPage: string;
  storyTime?: string;
  storyOrder?: number;
}

export interface EmotionPoint {
  character: string;
  page: string;
  value: number;
  note: string;
}

export interface SourceSheet {
  path: string;
  resolution: number;
  cells: [number, number, number, number][];
}

export interface Project {
  formatVersion: number;
  title: string;
  storyIndex?: number;
  author: string;
  binding: Binding;
  pageFormat: PageFormat;
  pages: Page[];
  characters: Character[];
  scenes: Scene[];
  emotions: EmotionPoint[];
  source?: SourceSheet;
  brushes: Brush[];
  nextId: number;
}

export const FORMAT_VERSION = 2;
export const MM_PER_PT = 25.4 / 72;
/** Dialogue size on the manuscript (B4 trim, printed smaller in the book). */
export const DEFAULT_FONT_PT = 13;
/** Gap between panels side by side (左右) and one above the other (上下). */
export const DEFAULT_GUTTERS = { across: 2, down: 6 };

export const KIND_LABELS: Record<LineKind, string> = {
  speech: "セリフ",
  thought: "モノローグ",
  narration: "ナレーション",
  sfx: "描き文字",
  aside: "小書き",
};

/** A3 canvas, B4 trim and a 180 x 270 mm basic frame (same as the Rust default). */
export function defaultPageFormat(): PageFormat {
  return { canvasMm: [297, 420], trimMm: [257, 364], basicMm: [180, 270], basicOffsetMm: [0, 0] };
}

export function newProject(title: string, pageCount: number): Project {
  const project: Project = {
    formatVersion: FORMAT_VERSION,
    title,
    author: "",
    binding: "right",
    pageFormat: defaultPageFormat(),
    pages: [],
    characters: [],
    scenes: [],
    emotions: [],
    brushes: [],
    nextId: 1,
  };
  for (let i = 0; i < pageCount; i++) project.pages.push(emptyPage(newId(project, "page")));
  return project;
}

export function emptyPage(id: string): Page {
  return { id, memo: "", panels: [], lines: [], strokes: [], roughs: [], breakouts: [] };
}

/** Fill in fields the Rust side leaves out when they are empty. */
export function normalize(project: Project): Project {
  project.characters ??= [];
  project.scenes ??= [];
  project.emotions ??= [];
  project.author ??= "";
  project.brushes ??= [];
  for (const brush of project.brushes) {
    brush.kind ??= "pen";
    brush.opacity ??= 1;
    brush.hardness ??= 1;
    brush.stabilization ??= 0;
    brush.taperInMm ??= 0;
    brush.taperOutMm ??= 0;
    brush.thickness ??= 100;
    brush.rotation ??= 0;
  }
  const beforeShapes = (project.formatVersion ?? 1) < 2;
  for (const page of project.pages) {
    page.memo ??= "";
    page.panels ??= [];
    page.lines ??= [];
    page.strokes ??= [];
    page.roughs ??= [];
    page.breakouts ??= [];
    for (const line of page.lines) {
      line.kind ??= "speech";
      // Before balloon shapes (format 1), an outline the editor did not make
      // (it made 40-point ellipses and 4-point boxes) came from CSP.
      if (beforeShapes && !line.balloonShape && line.balloon && line.balloon.length !== 40 && line.balloon.length !== 4) line.balloonShape = "custom";
    }
  }
  for (const scene of project.scenes) scene.summary ??= "";
  for (const point of project.emotions) point.note ??= "";
  project.pageFormat.basicOffsetMm ??= [0, 0];
  // Saved again by this version, the file may hold parts older versions drop.
  project.formatVersion = Math.max(project.formatVersion ?? FORMAT_VERSION, FORMAT_VERSION);
  return project;
}

export function newId(project: Project, prefix: string): string {
  return `${prefix}${project.nextId++}`;
}

// --- geometry ----------------------------------------------------------------

function centred(format: PageFormat, size: [number, number], offset: [number, number]): BoxMm {
  const x0 = (format.canvasMm[0] - size[0]) / 2 + offset[0];
  const y0 = (format.canvasMm[1] - size[1]) / 2 + offset[1];
  return [x0, y0, x0 + size[0], y0 + size[1]];
}

export function trimBox(format: PageFormat): BoxMm {
  return centred(format, format.trimMm, [0, 0]);
}

export function basicBox(format: PageFormat): BoxMm {
  return centred(format, format.basicMm, format.basicOffsetMm);
}

export function bounds(points: readonly (readonly number[])[]): BoxMm {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

export function rectShape([x0, y0, x1, y1]: BoxMm): Point[] {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

export function area(shape: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < shape.length; i++) {
    const [x0, y0] = shape[i];
    const [x1, y1] = shape[(i + 1) % shape.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

export function centroid(shape: readonly Point[]): Point {
  const [x0, y0, x1, y1] = bounds(shape);
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

export function insidePolygon(shape: readonly Point[], [x, y]: Point): boolean {
  let inside = false;
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const [xi, yi] = shape[i];
    const [xj, yj] = shape[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function insideBox([x0, y0, x1, y1]: BoxMm, [x, y]: Point): boolean {
  return x0 <= x && x <= x1 && y0 <= y && y <= y1;
}

/** Distance from `p` to the segment `a`-`b`. */
export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Keep the part of `shape` where `side(point) >= 0` (Sutherland–Hodgman, one edge). */
function clipHalfPlane(shape: readonly Point[], side: (p: Point) => number): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < shape.length; i++) {
    const current = shape[i];
    const next = shape[(i + 1) % shape.length];
    const sc = side(current);
    const sn = side(next);
    if (sc >= 0) result.push(current);
    if ((sc >= 0) !== (sn >= 0)) {
      const t = sc / (sc - sn);
      result.push([current[0] + t * (next[0] - current[0]), current[1] + t * (next[1] - current[1])]);
    }
  }
  return dedupe(result);
}

function dedupe(shape: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of shape) {
    const last = result[result.length - 1];
    if (!last || Math.hypot(last[0] - point[0], last[1] - point[1]) > 1e-6) result.push(point);
  }
  if (result.length > 1) {
    const [first, last] = [result[0], result[result.length - 1]];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) result.pop();
  }
  return result;
}

/** The gutter for a cut from `a` to `b`: mostly vertical cuts separate panels side by side. */
export function gutterFor(a: Point, b: Point, gutters = DEFAULT_GUTTERS): number {
  return Math.abs(b[0] - a[0]) < Math.abs(b[1] - a[1]) ? gutters.across : gutters.down;
}

/**
 * Cut a polygon along the straight line through `a` and `b`, leaving `gutter`
 * mm between the two halves. Returns null when the line misses the polygon or
 * one half would be too small to be a panel.
 */
export function splitShape(shape: readonly Point[], a: Point, b: Point, gutter: number): [Point[], Point[]] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return null;
  const distance = (p: Point) => ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length;
  const first = clipHalfPlane(shape, (p) => distance(p) - gutter / 2);
  const second = clipHalfPlane(shape, (p) => -distance(p) - gutter / 2);
  const minimum = 4; // mm²
  if (first.length < 3 || second.length < 3 || area(first) < minimum || area(second) < minimum) return null;
  return [first, second];
}

/** Whether the segment `a`-`b` crosses the polygon's outline or lies inside it. */
export function segmentTouches(shape: readonly Point[], a: Point, b: Point): boolean {
  if (insidePolygon(shape, a) || insidePolygon(shape, b)) return true;
  const cross = (o: Point, p: Point, q: Point) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  for (let i = 0; i < shape.length; i++) {
    const c = shape[i];
    const d = shape[(i + 1) % shape.length];
    const d1 = cross(a, b, c);
    const d2 = cross(a, b, d);
    const d3 = cross(c, d, a);
    const d4 = cross(c, d, b);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  }
  return false;
}

/** Make an almost horizontal or vertical cut exactly so (within `degrees`). */
export function snapCut(a: Point, b: Point, degrees = 6): Point {
  const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const off = (target: number) => Math.abs(((angle - target + 540) % 360) - 180);
  if (off(0) <= degrees || off(180) <= degrees) return [b[0], a[1]];
  if (off(90) <= degrees || off(-90) <= degrees) return [a[0], b[1]];
  return b;
}

/** Edges a panel corner snaps to: the canvas, the trim and the basic frame. */
export function snapLines(format: PageFormat): { xs: number[]; ys: number[] } {
  const trim = trimBox(format);
  const basic = basicBox(format);
  return {
    xs: [0, format.canvasMm[0], trim[0], trim[2], basic[0], basic[2]],
    ys: [0, format.canvasMm[1], trim[1], trim[3], basic[1], basic[3]],
  };
}

export function snapPoint([x, y]: Point, lines: { xs: number[]; ys: number[] }, tolerance: number): Point {
  const nearest = (value: number, candidates: number[]) => {
    let best = value;
    let distance = tolerance;
    for (const candidate of candidates) {
      if (Math.abs(candidate - value) <= distance) {
        best = candidate;
        distance = Math.abs(candidate - value);
      }
    }
    return best;
  };
  return [nearest(x, lines.xs), nearest(y, lines.ys)];
}

// --- panels --------------------------------------------------------------------

/**
 * Reading order of panels in a right-bound book (same rule as the Rust
 * import): rows top to bottom, a panel starts a new row when its top is below
 * the current row's middle; right to left inside a row.
 */
export function orderPanels(page: Page, binding: Binding = "right"): void {
  const sorted = [...page.panels].sort((a, b) => bounds(a.shape)[1] - bounds(b.shape)[1]);
  const rows = new Map<Panel, number>();
  let row = 0;
  let rowMiddle = -Infinity;
  sorted.forEach((panel, index) => {
    const [, y0, , y1] = bounds(panel.shape);
    if (index > 0 && y0 >= rowMiddle) row++;
    if (index === 0 || y0 >= rowMiddle) rowMiddle = (y0 + y1) / 2;
    rows.set(panel, row);
  });
  const side = (panel: Panel) => (binding === "right" ? -bounds(panel.shape)[2] : bounds(panel.shape)[0]);
  sorted.sort((a, b) => rows.get(a)! - rows.get(b)! || side(a) - side(b));
  sorted.forEach((panel, index) => (panel.order = index + 1));
  page.panels = sorted;
}

export function addPanel(project: Project, page: Page, shape: Point[]): Panel {
  const panel: Panel = { id: newId(project, "panel"), shape, order: page.panels.length + 1 };
  page.panels.push(panel);
  orderPanels(page, project.binding);
  assignPanels(page);
  return panel;
}

/** Split every panel the cut `a`-`b` touches. Returns the ids of the new panels. */
export function cutPanels(project: Project, page: Page, a: Point, b: Point, gutters = DEFAULT_GUTTERS): string[] {
  const gutter = gutterFor(a, b, gutters);
  const created: string[] = [];
  const panels: Panel[] = [];
  for (const panel of page.panels) {
    const halves = segmentTouches(panel.shape, a, b) ? splitShape(panel.shape, a, b, gutter) : null;
    if (!halves) {
      panels.push(panel);
      continue;
    }
    // Both halves keep the panel's look; edges cut from an open edge stay open.
    const [first, second] = halves.map((shape) => {
      const half: Panel = { ...panel, shape };
      const open = inheritOpenEdges(panel.shape, panel.openEdges, shape);
      if (open.length) half.openEdges = open;
      else delete half.openEdges;
      return half;
    });
    if (panel.spread) {
      // A 見開き has one half per page: it stays with the part at the gutter.
      const [w] = project.pageFormat.canvasMm;
      const atGutter = (half: Panel) => half.shape.some(([x]) => x <= 0.05 || x >= w - 0.05);
      if (atGutter(first)) delete second.spread;
      else delete first.spread;
    }
    panels.push(first);
    const id = newId(project, "panel");
    panels.push({ ...second, id, order: 0 });
    created.push(id);
  }
  if (!created.length) return created;
  page.panels = panels;
  orderPanels(page, project.binding);
  assignPanels(page);
  return created;
}

export function removePanel(page: Page, panelId: string, binding: Binding = "right"): void {
  page.panels = page.panels.filter((panel) => panel.id !== panelId);
  orderPanels(page, binding);
  assignPanels(page);
}

/** Give each line the panel its centre is in. */
export function assignPanels(page: Page): void {
  for (const line of page.lines) {
    const center = boxCenter(line.box);
    const panel = [...page.panels].sort((a, b) => a.order - b.order).find((p) => insidePolygon(p.shape, center));
    if (panel) line.panel = panel.id;
    else delete line.panel;
  }
}

// --- lines -----------------------------------------------------------------------

export function boxCenter([x0, y0, x1, y1]: BoxMm): Point {
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/** Line pitch as a multiple of the font size. */
export const LINE_PITCH = 1.15;

/** Size of a text block, in mm: vertical columns right to left, or horizontal rows. */
export function textSize(text: string, fontSizePt: number, vertical: boolean): [number, number] {
  const size = fontSizePt * MM_PER_PT;
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  const longest = Math.max(1, ...rows.map((row) => [...row].length));
  const across = size * (1 + (rows.length - 1) * LINE_PITCH);
  return vertical ? [across, longest * size] : [longest * size, across];
}

/** Outline for a line's balloon, or undefined for kinds drawn without one. */
export function balloonFor(kind: LineKind, box: BoxMm): Point[] | undefined {
  return storedOutline({ id: "", text: "", kind, box, fontSizePt: DEFAULT_FONT_PT, vertical: true });
}

/** Resize a line's box around its centre to fit its text, and redo its balloon. */
export function fitLine(line: Line): void {
  const [w, h] = textSize(line.text, line.fontSizePt, line.vertical);
  const [cx, cy] = boxCenter(line.box);
  const box: BoxMm = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  if (line.balloonShape === "custom" && line.balloon) {
    // An imported outline follows its text.
    const [ox, oy] = boxCenter(line.box);
    line.balloon = line.balloon.map(([x, y]) => [x + cx - ox, y + cy - oy]);
  }
  line.box = box;
  const balloon = storedOutline(line);
  if (balloon) line.balloon = balloon;
  else delete line.balloon;
}

export function addLine(project: Project, page: Page, center: Point, text = "セリフ", kind: LineKind = "speech"): Line {
  const line: Line = {
    id: newId(project, "line"),
    text,
    kind,
    box: [center[0], center[1], center[0], center[1]],
    fontSizePt: kind === "narration" ? DEFAULT_FONT_PT - 1 : DEFAULT_FONT_PT,
    vertical: true,
  };
  fitLine(line);
  page.lines.push(line);
  assignPanels(page);
  sortLines(page);
  return line;
}

/** Move a line with its balloon; tails keep pointing at their speakers. */
export function moveLine(line: Line, dx: number, dy: number): void {
  const [x0, y0, x1, y1] = line.box;
  line.box = [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
  if (line.balloon) line.balloon = line.balloon.map(([x, y]) => [x + dx, y + dy]);
}

/** Manga reading order: by panel, then from the top right towards the bottom left. */
export function sortLines(page: Page): void {
  const order = new Map(page.panels.map((panel) => [panel.id, panel.order]));
  const key = (line: Line) => {
    const [cx, cy] = boxCenter(line.box);
    return { panel: line.panel ? order.get(line.panel) ?? Infinity : Infinity, diagonal: cy - cx };
  };
  page.lines.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka.panel - kb.panel || ka.diagonal - kb.diagonal;
  });
}

export function movePanel(panel: Panel, dx: number, dy: number): void {
  panel.shape = panel.shape.map(([x, y]) => [x + dx, y + dy]);
}

export function moveStroke(stroke: Stroke, dx: number, dy: number): void {
  stroke.points = stroke.points.map(([x, y, ...rest]) => [x + dx, y + dy, ...rest] as StrokePoint);
}

// --- strokes -------------------------------------------------------------------

export function addStroke(
  project: Project,
  page: Page,
  points: StrokePoint[],
  widthMm: number,
  brush?: string,
): Stroke | null {
  if (points.length < 2) return null;
  const stroke: Stroke = { id: newId(project, "stroke"), points: simplify(points, 0.15), widthMm, closed: false };
  if (brush) stroke.brush = brush;
  page.strokes.push(stroke);
  return stroke;
}

/** Drop points closer than `tolerance` mm to the previous kept one. */
export function simplify(points: StrokePoint[], tolerance: number): StrokePoint[] {
  const result: StrokePoint[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= tolerance) result.push(point);
  }
  const end = points[points.length - 1];
  if (result[result.length - 1] !== end) result.push(end);
  return result;
}

export function strokeHit(stroke: Stroke, point: Point, radius: number): boolean {
  const pts = stroke.points;
  if (pts.length === 1) return Math.hypot(pts[0][0] - point[0], pts[0][1] - point[1]) <= radius;
  for (let i = 1; i < pts.length; i++) {
    const a: Point = [pts[i - 1][0], pts[i - 1][1]];
    const b: Point = [pts[i][0], pts[i][1]];
    if (segmentDistance(point, a, b) <= radius + stroke.widthMm / 2) return true;
  }
  return false;
}

/** Remove strokes under the eraser; returns how many went. */
export function eraseStrokes(page: Page, point: Point, radius: number): number {
  const before = page.strokes.length;
  page.strokes = page.strokes.filter((stroke) => !strokeHit(stroke, point, radius));
  return before - page.strokes.length;
}

/** Erase like a CSP vector eraser; returns how many strokes changed. */
export function eraseWith(project: Project, page: Page, point: Point, radius: number, mode: EraseMode): number {
  if (mode === "whole") return eraseStrokes(page, point, radius);
  const others = page.strokes.slice();
  let changed = 0;
  const result: Stroke[] = [];
  for (const stroke of page.strokes) {
    if (stroke.points.length < 2 || !strokeHit(stroke, point, radius)) {
      result.push(stroke);
      continue;
    }
    const pieces =
      mode === "touched"
        ? cutAround(stroke.points, point, radius + stroke.widthMm / 2)
        : cutBetweenCrossings(stroke, others, point);
    changed++;
    for (const [index, piece] of pieces.entries()) {
      const part: Stroke = { ...stroke, id: index === 0 ? stroke.id : newId(project, "stroke"), points: piece.points };
      const cut: [boolean, boolean] = [piece.cutStart || !!stroke.cut?.[0], piece.cutEnd || !!stroke.cut?.[1]];
      if (cut[0] || cut[1]) part.cut = cut;
      else delete part.cut;
      result.push(part);
    }
  }
  page.strokes = result;
  return changed;
}

/** A piece left of a line, and whether each of its ends is where the eraser cut. */
interface Piece {
  points: StrokePoint[];
  cutStart: boolean;
  cutEnd: boolean;
}

/** 触れた部分: the runs of the line outside the circle. */
function cutAround(points: StrokePoint[], center: Point, radius: number): Piece[] {
  // Put extra points where segments pass the circle so the cut lands close to it.
  const step = Math.max(radius / 3, 0.05);
  const dense: StrokePoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (segmentDistance(center, [a[0], a[1]], [b[0], b[1]]) <= radius) {
      const count = Math.min(Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step), 2000);
      for (let k = 1; k < count; k++) dense.push(lerpPoint(a, b, k / count));
    }
    dense.push(b);
  }
  const pieces: Piece[] = [];
  let run: StrokePoint[] = [];
  let start = 0;
  dense.forEach((p, index) => {
    if (Math.hypot(p[0] - center[0], p[1] - center[1]) > radius) {
      if (!run.length) start = index;
      run.push(p);
      return;
    }
    if (run.length >= 2) pieces.push({ points: run, cutStart: start > 0, cutEnd: true });
    run = [];
  });
  if (run.length >= 2) pieces.push({ points: run, cutStart: start > 0, cutEnd: false });
  return pieces;
}

/** 交点まで: remove the stretch under the eraser up to the nearest crossings with other lines. */
function cutBetweenCrossings(stroke: Stroke, others: Stroke[], center: Point): Piece[] {
  const pts = stroke.points;
  const lengths = [0];
  for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = lengths[lengths.length - 1];
  // Where along the line the eraser is.
  let at = 0;
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const t = projectOnSegment(center, pts[i - 1], pts[i]);
    const p = lerpPoint(pts[i - 1], pts[i], t);
    const d = Math.hypot(p[0] - center[0], p[1] - center[1]);
    if (d < best) {
      best = d;
      at = lengths[i - 1] + t * (lengths[i] - lengths[i - 1]);
    }
  }
  let from = 0;
  let to = total;
  for (const other of others) {
    if (other === stroke) continue;
    for (let i = 1; i < pts.length; i++) {
      for (let j = 1; j < other.points.length; j++) {
        const t = crossing(pts[i - 1], pts[i], other.points[j - 1], other.points[j]);
        if (t === null) continue;
        const distance = lengths[i - 1] + t * (lengths[i] - lengths[i - 1]);
        if (distance < at) from = Math.max(from, distance);
        else if (distance > at) to = Math.min(to, distance);
      }
    }
  }
  const pieces: Piece[] = [
    { points: slicePolyline(pts, lengths, 0, from), cutStart: false, cutEnd: true },
    { points: slicePolyline(pts, lengths, to, total), cutStart: true, cutEnd: false },
  ];
  return pieces.filter(({ points: piece }) =>
    piece.length >= 2 && Math.hypot(piece[0][0] - piece[piece.length - 1][0], piece[0][1] - piece[piece.length - 1][1]) > 1e-6,
  );
}

function lerpPoint(a: StrokePoint, b: StrokePoint, t: number): StrokePoint {
  const length = Math.min(a.length, b.length);
  return a.slice(0, length).map((value, i) => value + (b[i] - value) * t) as StrokePoint;
}

function projectOnSegment(p: Point, a: StrokePoint, b: StrokePoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  return length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
}

/** Where segment ab crosses cd, as a fraction of ab; null when they do not. */
function crossing(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): number | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denominator;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** The part of a line between two distances along it. */
function slicePolyline(pts: StrokePoint[], lengths: number[], from: number, to: number): StrokePoint[] {
  if (to - from <= 1e-9) return [];
  const at = (distance: number): StrokePoint => {
    for (let i = 1; i < pts.length; i++) {
      if (distance <= lengths[i] || i === pts.length - 1) {
        const span = lengths[i] - lengths[i - 1];
        return lerpPoint(pts[i - 1], pts[i], span === 0 ? 0 : (distance - lengths[i - 1]) / span);
      }
    }
    return pts[pts.length - 1];
  };
  const result: StrokePoint[] = [at(from)];
  for (let i = 0; i < pts.length; i++) if (lengths[i] > from && lengths[i] < to) result.push(pts[i]);
  result.push(at(to));
  return result;
}

// --- pages -----------------------------------------------------------------------

export function pageIndex(project: Project, pageId: string): number {
  return project.pages.findIndex((page) => page.id === pageId);
}

export function insertPage(project: Project, index: number): Page {
  const page = emptyPage(newId(project, "page"));
  project.pages.splice(Math.max(0, Math.min(index, project.pages.length)), 0, page);
  return page;
}

/** Remove a page with what refers to it: emotion values and scene ends. */
export function removePage(project: Project, pageId: string): void {
  const index = pageIndex(project, pageId);
  if (index < 0) return;
  project.pages.splice(index, 1);
  project.emotions = project.emotions.filter((point) => point.page !== pageId);
  const neighbour = (forward: boolean) => {
    const near = forward ? project.pages[index] : project.pages[index - 1];
    return (near ?? project.pages[index - 1] ?? project.pages[index])?.id;
  };
  project.scenes = project.scenes.flatMap((scene) => {
    if (scene.firstPage === pageId) scene.firstPage = neighbour(true) ?? "";
    if (scene.lastPage === pageId) scene.lastPage = neighbour(false) ?? "";
    const first = pageIndex(project, scene.firstPage);
    const last = pageIndex(project, scene.lastPage);
    return first < 0 || last < 0 || first > last ? [] : [scene];
  });
}

export function movePage(project: Project, pageId: string, step: number): void {
  const index = pageIndex(project, pageId);
  const target = index + step;
  if (index < 0 || target < 0 || target >= project.pages.length) return;
  const [page] = project.pages.splice(index, 1);
  project.pages.splice(target, 0, page);
  // Keep scenes in page order after the move.
  for (const scene of project.scenes) {
    if (pageIndex(project, scene.firstPage) > pageIndex(project, scene.lastPage)) {
      [scene.firstPage, scene.lastPage] = [scene.lastPage, scene.firstPage];
    }
  }
}

// --- characters, scenes and emotions ----------------------------------------------

/** Categorical colours in a fixed order, checked for colour-blind separation. */
export const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];

export function addCharacter(project: Project, name: string): Character {
  const character: Character = {
    id: newId(project, "character"),
    name,
    // Past eight the colours repeat; the name tells them apart.
    color: PALETTE[project.characters.length % PALETTE.length],
  };
  project.characters.push(character);
  return character;
}

export function removeCharacter(project: Project, characterId: string): void {
  project.characters = project.characters.filter((character) => character.id !== characterId);
  project.emotions = project.emotions.filter((point) => point.character !== characterId);
  for (const page of project.pages) {
    for (const line of page.lines) if (line.speaker === characterId) delete line.speaker;
  }
}

/** Set (or with `null`, clear) how a character feels at a page. */
export function setEmotion(project: Project, characterId: string, pageId: string, value: number | null, note?: string): void {
  const existing = project.emotions.find((point) => point.character === characterId && point.page === pageId);
  if (value === null) {
    project.emotions = project.emotions.filter((point) => point !== existing);
    return;
  }
  const clamped = Math.max(-1, Math.min(1, value));
  if (existing) {
    existing.value = clamped;
    if (note !== undefined) existing.note = note;
  } else {
    project.emotions.push({ character: characterId, page: pageId, value: clamped, note: note ?? "" });
  }
}

export function addScene(project: Project, firstPage: string, lastPage: string, title: string): Scene {
  const scene: Scene = { id: newId(project, "scene"), title, summary: "", firstPage, lastPage };
  project.scenes.push(scene);
  sortScenes(project);
  return scene;
}

export function sortScenes(project: Project): void {
  project.scenes.sort((a, b) => pageIndex(project, a.firstPage) - pageIndex(project, b.firstPage));
}

/** The scene a page belongs to (the first one that covers it). */
export function sceneOf(project: Project, pageId: string): Scene | undefined {
  const index = pageIndex(project, pageId);
  return project.scenes.find(
    (scene) => pageIndex(project, scene.firstPage) <= index && index <= pageIndex(project, scene.lastPage),
  );
}

/** Lines in reading order, with their page number (1-based). */
export function script(project: Project): { page: number; line: Line }[] {
  return project.pages.flatMap((page, index) => page.lines.map((line) => ({ page: index + 1, line })));
}

/** Count of characters spoken per page, a rough measure of how text heavy it is. */
export function textAmount(page: Page): number {
  return page.lines.reduce((sum, line) => sum + [...line.text.replace(/\s/g, "")].length, 0);
}

/** 囲って消す: remove the parts of rough lines inside `shape` (as CSP deletes
 * a selection on a vector layer); returns how many lines changed. */
export function eraseInside(project: Project, page: Page, shape: readonly Point[]): number {
  if (shape.length < 3) return 0;
  const [x0, y0, x1, y1] = bounds([...shape]);
  let changed = 0;
  const result: Stroke[] = [];
  for (const stroke of page.strokes) {
    const [sx0, sy0, sx1, sy1] = bounds(stroke.points.map(([x, y]) => [x, y] as Point));
    const near = sx1 >= x0 && sx0 <= x1 && sy1 >= y0 && sy0 <= y1;
    if (!near) {
      result.push(stroke);
      continue;
    }
    const pieces = cutInside(stroke.points, shape);
    if (pieces.length === 1 && !pieces[0].cutStart && !pieces[0].cutEnd && pieces[0].points.length === stroke.points.length) {
      result.push(stroke);
      continue;
    }
    changed++;
    for (const [index, piece] of pieces.entries()) {
      const part: Stroke = { ...stroke, id: index === 0 ? stroke.id : newId(project, "stroke"), points: piece.points };
      const cut: [boolean, boolean] = [piece.cutStart || !!stroke.cut?.[0], piece.cutEnd || !!stroke.cut?.[1]];
      if (cut[0] || cut[1]) part.cut = cut;
      else delete part.cut;
      result.push(part);
    }
  }
  page.strokes = result;
  return changed;
}

/** The runs of a line outside `shape`, cut close to its edge. */
function cutInside(points: StrokePoint[], shape: readonly Point[]): Piece[] {
  const inside = (p: StrokePoint) => insidePolygon(shape, [p[0], p[1]]);
  const [x0, y0, x1, y1] = bounds([...shape]);
  // Put extra points on segments that reach the outline so the cut lands close to it.
  const dense: StrokePoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const reaches = Math.max(a[0], b[0]) >= x0 && Math.min(a[0], b[0]) <= x1 && Math.max(a[1], b[1]) >= y0 && Math.min(a[1], b[1]) <= y1;
    if (reaches) {
      const count = Math.min(Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1), 2000);
      for (let k = 1; k < count; k++) dense.push(lerpPoint(a, b, k / count));
    }
    dense.push(b);
  }
  const pieces: Piece[] = [];
  let run: StrokePoint[] = [];
  let start = 0;
  dense.forEach((p, index) => {
    if (!inside(p)) {
      if (!run.length) start = index;
      run.push(p);
      return;
    }
    if (run.length >= 2) pieces.push({ points: run, cutStart: start > 0, cutEnd: true });
    run = [];
  });
  if (run.length >= 2) pieces.push({ points: run, cutStart: start > 0, cutEnd: false });
  return pieces;
}

/** 範囲選択: rough lines mostly inside `shape` and dialogue whose box centre is. */
export function pickInside(page: Page, shape: readonly Point[]): { strokes: string[]; lines: string[] } {
  if (shape.length < 3) return { strokes: [], lines: [] };
  const strokes = page.strokes
    .filter((stroke) => {
      const inside = stroke.points.filter(([x, y]) => insidePolygon(shape, [x, y])).length;
      return inside > 0 && inside >= stroke.points.length / 2;
    })
    .map((stroke) => stroke.id);
  const lines = page.lines
    .filter(({ box: [x0, y0, x1, y1] }) => insidePolygon(shape, [(x0 + x1) / 2, (y0 + y1) / 2]))
    .map((line) => line.id);
  return { strokes, lines };
}

/** A line split where it crosses `x` (the gutter of a spread): runs in order,
 * each marked with the side it is on (`beyond`: x greater than the gutter)
 * and a crossing point shared by neighbouring runs. */
export function splitAtX(points: StrokePoint[], x: number): { points: StrokePoint[]; beyond: boolean }[] {
  const runs: { points: StrokePoint[]; beyond: boolean }[] = [];
  for (const point of points) {
    const beyond = point[0] > x;
    const run = runs[runs.length - 1];
    if (!run) {
      runs.push({ points: [point], beyond });
      continue;
    }
    if (run.beyond === beyond) {
      run.points.push(point);
      continue;
    }
    const last = run.points[run.points.length - 1];
    const t = (x - last[0]) / (point[0] - last[0]);
    const crossing = lerpPoint(last, point, Number.isFinite(t) ? t : 0);
    crossing[0] = x;
    run.points.push(crossing);
    runs.push({ points: [crossing.slice() as StrokePoint, point], beyond });
  }
  return runs.filter((run) => run.points.length >= 2);
}

/** Whether page `index` and the next one should go to CSP as one 見開き page. */
export function wantsSpread(project: Project, index: number): boolean {
  const page = project.pages[index];
  const next = project.pages[index + 1];
  if (!page || !next) return false;
  if (page.joinNext) return true;
  // A panel across the gutter can only be one panel on a spread page.
  const shared = new Set(next.panels.map((panel) => panel.spread).filter(Boolean));
  return page.panels.some((panel) => panel.spread && shared.has(panel.spread));
}

// --- コマに中身が付いてくる -------------------------------------------------------

/** The panel that owns a point: the topmost one there (insets over their panel). */
function ownerAt(page: Page, point: Point): Panel | undefined {
  let owner: Panel | undefined;
  for (const panel of page.panels) {
    if (!insidePolygon(panel.shape, point)) continue;
    if (!owner || (panel.z ?? 0) > (owner.z ?? 0)) owner = panel;
  }
  return owner;
}

/** What a panel carries along: dialogue whose box centre and rough lines most of whose points are in it. */
export function panelContents(page: Page, panel: Panel): { strokes: string[]; lines: string[] } {
  const owns = (point: Point) => ownerAt(page, point)?.id === panel.id;
  const strokes = page.strokes
    .filter((stroke) => {
      const inside = stroke.points.filter(([x, y]) => owns([x, y])).length;
      return inside > 0 && inside >= stroke.points.length / 2;
    })
    .map((stroke) => stroke.id);
  const lines = page.lines.filter((line) => owns(boxCenter(line.box))).map((line) => line.id);
  return { strokes, lines };
}

/** The contents of a panel as they were, to follow the panel as it changes. */
export interface CarriedContents {
  box: BoxMm;
  strokes: { id: string; points: StrokePoint[] }[];
  lines: { id: string; box: BoxMm; balloon?: Point[]; tails?: Point[] }[];
}

export function carryContents(page: Page, panel: Panel): CarriedContents {
  const { strokes, lines } = panelContents(page, panel);
  return {
    box: bounds(panel.shape),
    strokes: page.strokes.filter((s) => strokes.includes(s.id)).map((s) => ({ id: s.id, points: s.points.map((p) => [...p] as StrokePoint) })),
    lines: page.lines
      .filter((l) => lines.includes(l.id))
      .map((l) => ({
        id: l.id,
        box: [...l.box] as BoxMm,
        ...(l.balloon ? { balloon: l.balloon.map((p) => [...p] as Point) } : {}),
        ...(l.tails ? { tails: l.tails.map((t) => [...t.tip] as Point) } : {}),
      })),
  };
}

/**
 * Put the carried contents where the panel now is: positions follow the
 * panel's box (moved, and stretched when a corner is dragged). Rough lines
 * keep their proportions, scaled by the smaller stretch; dialogue keeps its
 * size and moves with its centre.
 */
export function followPanel(page: Page, panel: Panel, carried: CarriedContents): void {
  const [ox0, oy0, ox1, oy1] = carried.box;
  const [nx0, ny0, nx1, ny1] = bounds(panel.shape);
  const sx = ox1 > ox0 ? (nx1 - nx0) / (ox1 - ox0) : 1;
  const sy = oy1 > oy0 ? (ny1 - ny0) / (oy1 - oy0) : 1;
  const map = ([x, y]: readonly number[]): Point => [nx0 + (x - ox0) * sx, ny0 + (y - oy0) * sy];
  const uniform = Math.min(sx, sy);
  for (const { id, points } of carried.strokes) {
    const stroke = page.strokes.find((s) => s.id === id);
    if (!stroke) continue;
    const [cx0, cy0, cx1, cy1] = bounds(points.map(([x, y]) => [x, y] as Point));
    const centre: Point = [(cx0 + cx1) / 2, (cy0 + cy1) / 2];
    const [mx, my] = map(centre);
    stroke.points = points.map(([x, y, ...rest]) => [mx + (x - centre[0]) * uniform, my + (y - centre[1]) * uniform, ...rest] as StrokePoint);
  }
  for (const { id, box, balloon, tails } of carried.lines) {
    const line = page.lines.find((l) => l.id === id);
    if (!line) continue;
    const [mx, my] = map(boxCenter(box));
    const [cx, cy] = boxCenter(box);
    const [dx, dy] = [mx - cx, my - cy];
    line.box = [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
    if (balloon) line.balloon = balloon.map(([x, y]) => [x + dx, y + dy]);
    if (tails && line.tails) line.tails.forEach((tail, i) => tails[i] && (tail.tip = map(tails[i])));
  }
}

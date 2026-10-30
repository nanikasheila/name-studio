// Rough lines and fills: drawing, simplifying, hitting and erasing lines
// (CSP's erase modes), cutting them at a page edge, and selecting by a shape.

import { bounds, insidePolygon, segmentDistance } from "./geometry";
import type { EraseMode, Fill, FillTone, Page, Point, Project, Stroke, StrokePoint } from "./model";
import { newId } from "./project";

export const TONE_LABELS: Record<FillTone, string> = { black: "黒（ベタ）", gray: "グレー", white: "白" };

export function addFill(project: Project, page: Page, shape: Point[], tone: FillTone, holes?: Point[][], under = false): Fill {
  const fill: Fill = { id: newId(project, "fill"), shape };
  if (holes?.length) fill.holes = holes;
  if (tone !== "black") fill.tone = tone;
  if (under) fill.under = true;
  page.fills = [...(page.fills ?? []), fill];
  return fill;
}

/** A fill's outline and holes, as they were (to put back changed: a transform, a panel it follows). */
export interface FillShape {
  id: string;
  shape: Point[];
  holes?: Point[][];
}

export function fillShape(fill: FillShape): FillShape {
  return { id: fill.id, shape: fill.shape.map((p) => [...p] as Point), ...(fill.holes?.length ? { holes: fill.holes.map((hole) => hole.map((p) => [...p] as Point)) } : {}) };
}

/** Whether a point is in a fill (not in one of its holes). */
export function insideFill(fill: Pick<Fill, "shape" | "holes">, point: Point): boolean {
  return insidePolygon(fill.shape, point) && !(fill.holes ?? []).some((hole) => insidePolygon(hole, point));
}

/** Put a fill where `map` takes each point of `from` (its outline and holes; none: the fill as it is). */
export function mapFill(fill: Fill, map: (point: Point) => Point, from: Pick<FillShape, "shape" | "holes"> = fill): void {
  fill.shape = from.shape.map(map);
  if (from.holes?.length) fill.holes = from.holes.map((hole) => hole.map(map));
}

export function moveStroke(stroke: Stroke, dx: number, dy: number): void {
  stroke.points = stroke.points.map(([x, y, ...rest]) => [x + dx, y + dy, ...rest] as StrokePoint);
}

export function addStroke(
  project: Project,
  page: Page,
  points: StrokePoint[],
  widthMm: number,
  brush?: string,
): Stroke | null {
  if (points.length < 2) return null;
  const stroke: Stroke = { id: newId(project, "stroke"), points: simplify(points, 0.15), widthMm, closed: false };
  // Point lists are shared by undo and saving (snapshot.ts, projectjson.ts) and
  // never changed in place; in development a change in place fails loudly.
  if (import.meta.env.DEV) for (const point of Object.freeze(stroke.points)) Object.freeze(point);
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
export function eraseStrokes(page: Page, point: Point, radius: number, editable: (stroke: Stroke) => boolean = () => true): number {
  const before = page.strokes.length;
  page.strokes = page.strokes.filter((stroke) => !editable(stroke) || !strokeHit(stroke, point, radius));
  return before - page.strokes.length;
}

/** Erase like a CSP vector eraser; returns how many strokes changed. Lines not `editable` (a locked layer) stay. */
export function eraseWith(project: Project, page: Page, point: Point, radius: number, mode: EraseMode, editable: (stroke: Stroke) => boolean = () => true): number {
  if (mode === "whole") return eraseStrokes(page, point, radius, editable);
  const others = page.strokes.slice();
  let changed = 0;
  const result: Stroke[] = [];
  for (const stroke of page.strokes) {
    if (stroke.points.length < 2 || !editable(stroke) || !strokeHit(stroke, point, radius)) {
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

/** 囲って消す: remove the parts of rough lines inside `shape` (as CSP deletes
 * a selection on a vector layer); returns how many lines changed. */
export function eraseInside(project: Project, page: Page, shape: readonly Point[], editable: (stroke: Stroke) => boolean = () => true): number {
  if (shape.length < 3) return 0;
  const [x0, y0, x1, y1] = bounds([...shape]);
  let changed = 0;
  const result: Stroke[] = [];
  for (const stroke of page.strokes) {
    const [sx0, sy0, sx1, sy1] = bounds(stroke.points.map(([x, y]) => [x, y] as Point));
    const near = editable(stroke) && sx1 >= x0 && sx0 <= x1 && sy1 >= y0 && sy0 <= y1;
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
  // Fills go when most of their outline is inside.
  const fills = (page.fills ?? []).filter((fill) => fill.shape.filter((p) => insidePolygon(shape, p)).length < fill.shape.length / 2);
  changed += (page.fills?.length ?? 0) - fills.length;
  if (page.fills) page.fills = fills;
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

/** 範囲選択: rough lines mostly inside `shape`, dialogue whose box centre is, and panels, fills and はみ出し wholly inside (not halves of 見開き panels). */
export function pickInside(page: Page, shape: readonly Point[]): { strokes: string[]; lines: string[]; panels: string[]; fills: string[]; breakouts: string[] } {
  if (shape.length < 3) return { strokes: [], lines: [], panels: [], fills: [], breakouts: [] };
  // Panels, fills and はみ出し only when all of them is inside.
  const whole = (points: readonly Point[]) => points.length > 0 && points.every((point) => insidePolygon(shape, point));
  const strokes = page.strokes
    .filter((stroke) => {
      const inside = stroke.points.filter(([x, y]) => insidePolygon(shape, [x, y])).length;
      return inside > 0 && inside >= stroke.points.length / 2;
    })
    .map((stroke) => stroke.id);
  const lines = page.lines
    .filter(({ box: [x0, y0, x1, y1] }) => insidePolygon(shape, [(x0 + x1) / 2, (y0 + y1) / 2]))
    .map((line) => line.id);
  return {
    strokes,
    lines,
    panels: page.panels.filter((panel) => !panel.spread && whole(panel.shape)).map((panel) => panel.id),
    fills: (page.fills ?? []).filter((fill) => whole(fill.shape)).map((fill) => fill.id),
    breakouts: page.breakouts.filter((breakout) => whole(breakout.shape)).map((breakout) => breakout.id),
  };
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

/**
 * A line drawn over several pages (連続 shows them all on one canvas): its
 * runs, each on the page `pageOf` says its points are over. A point off every
 * page stays with the run before it. Across a gutter (`gutter` gives its x)
 * the two runs end exactly there; between pages apart, each run takes the
 * next point too, so the line reaches each page's edge, where the page cuts it.
 */
export function splitOverPages<K>(
  points: StrokePoint[],
  first: K,
  pageOf: (point: StrokePoint) => K | null,
  gutter: (from: K, to: K) => number | null,
): { page: K; points: StrokePoint[] }[] {
  const runs: { page: K; points: StrokePoint[] }[] = [];
  for (const point of points) {
    const run = runs[runs.length - 1];
    const page = pageOf(point) ?? run?.page ?? first;
    if (!run) {
      runs.push({ page, points: [point] });
      continue;
    }
    if (run.page === page) {
      run.points.push(point);
      continue;
    }
    const last = run.points[run.points.length - 1];
    const x = gutter(run.page, page);
    if (x === null) {
      run.points.push(point);
      runs.push({ page, points: [last.slice() as StrokePoint, point] });
      continue;
    }
    const t = (x - last[0]) / (point[0] - last[0]);
    const crossing = lerpPoint(last, point, Number.isFinite(t) ? t : 0);
    crossing[0] = x;
    run.points.push(crossing);
    runs.push({ page, points: [crossing.slice() as StrokePoint, point] });
  }
  return runs.filter((run) => run.points.length >= 2);
}

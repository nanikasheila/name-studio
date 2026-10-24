// コマの変形: grab the border between panels (the 間白) and move it, moving
// the panels on both sides together, or slide a single edge; join two panels
// across their border. Works on any straight edges, slanted ones included.
import { snapValue, type SnapTargets } from "./snapping";
import { area, bounds, insidePolygon, removePanel, segmentDistance, type Binding, type Page, type Panel, type Point } from "./project";

/** Edges further apart than this (mm) are not one border. */
export const MAX_GUTTER_MM = 12;
/** A panel is never made narrower than this (mm). */
const MIN_SIZE_MM = 3;
const PARALLEL = Math.sin((3 * Math.PI) / 180);

/** Edge `edge` of a panel runs from shape[edge] to shape[edge + 1]. */
export interface EdgeRef {
  panelId: string;
  edge: number;
}

/**
 * A border to move: edges along one line (`origin`, direction `dir`), and
 * the parallel edges across the gutter from them. All move together along
 * `normal`.
 */
export interface Seam {
  edges: EdgeRef[];
  origin: Point;
  dir: Point;
  normal: Point;
  /** Panels on both sides: a border between panels rather than a lone edge. */
  between: boolean;
}

function edgeEnds(panel: Panel, edge: number): [Point, Point] {
  return [panel.shape[edge], panel.shape[(edge + 1) % panel.shape.length]];
}

function unit([x, y]: Point): Point {
  const length = Math.hypot(x, y) || 1;
  return [x / length, y / length];
}

const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const minus = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];

/** The edge nearest to `point`, if one is within `tolerance` mm. */
export function edgeAt(page: Page, point: Point, tolerance: number): EdgeRef | null {
  let best: EdgeRef | null = null;
  let distance = tolerance;
  for (const panel of page.panels) {
    for (let edge = 0; edge < panel.shape.length; edge++) {
      const [a, b] = edgeEnds(panel, edge);
      const d = segmentDistance(point, a, b);
      if (d <= distance) {
        distance = d;
        best = { panelId: panel.id, edge };
      }
    }
  }
  return best;
}

/** Which side of its edge `p`-`q` a panel lies on: 1 along `normal`, -1 against it. */
function interiorSide(panel: Panel, p: Point, q: Point, normal: Point): 1 | -1 {
  const mid: Point = [(p[0] + q[0]) / 2 + normal[0] * 0.3, (p[1] + q[1]) / 2 + normal[1] * 0.3];
  return insidePolygon(panel.shape, mid) ? 1 : -1;
}

/**
 * The border through `start`: the edges on its line facing the same way
 * and touching along it one after another (a border crossing the page takes
 * the edges of every panel along it; two gutters on one line with a gutter
 * across between them stay apart), and the edges facing them across the
 * gutter. Insets (z) only join their own level.
 */
export function seamOf(page: Page, start: EdgeRef): Seam | null {
  const first = page.panels.find((panel) => panel.id === start.panelId);
  if (!first) return null;
  const [a, b] = edgeEnds(first, start.edge);
  if (Math.hypot(...minus(b, a)) < 0.5) return null;
  const dir = unit(minus(b, a));
  const normal: Point = [-dir[1], dir[0]];
  const inward = interiorSide(first, a, b, normal);
  const level = first.z ?? 0;
  type Candidate = EdgeRef & { offset: number; span: [number, number]; across: boolean };
  const candidates: Candidate[] = [];
  for (const panel of page.panels) {
    if ((panel.z ?? 0) !== level) continue;
    for (let edge = 0; edge < panel.shape.length; edge++) {
      const [p, q] = edgeEnds(panel, edge);
      const along = minus(q, p);
      const length = Math.hypot(...along);
      if (length < 0.5) continue;
      const cross = (dir[0] * along[1] - dir[1] * along[0]) / length;
      if (Math.abs(cross) > PARALLEL) continue;
      const offset = dot(minus(p, a), normal);
      const side = interiorSide(panel, p, q, normal);
      const sameLine = Math.abs(offset) < 0.5 && side === inward;
      // Across the gutter: outside `first`, facing back at it.
      const beyond = -offset * inward;
      const across = beyond >= 0.5 && beyond <= MAX_GUTTER_MM && side === -inward && panel.id !== first.id;
      if (!sameLine && !across) continue;
      const span = [dot(minus(p, a), dir), dot(minus(q, a), dir)].sort((x, y) => x - y) as [number, number];
      candidates.push({ panelId: panel.id, edge, offset, span, across });
    }
  }
  const seed = candidates.find((c) => c.panelId === start.panelId && c.edge === start.edge);
  if (!seed) return null;
  // Grow along the line: an edge joins when its span meets one already in.
  const group: Candidate[] = [seed];
  const rest = candidates.filter((c) => c !== seed);
  const slack = 1;
  for (let grown = true; grown; ) {
    grown = false;
    for (let i = rest.length - 1; i >= 0; i--) {
      const c = rest[i];
      if (group.some((g) => c.span[0] <= g.span[1] + slack && c.span[1] >= g.span[0] - slack)) {
        group.push(c);
        rest.splice(i, 1);
        grown = true;
      }
    }
  }
  // Across, only the nearest line of edges (not a further row).
  const across = group.filter((g) => g.across);
  const nearest = across.length ? across.reduce((m, g) => (Math.abs(g.offset) < Math.abs(m.offset) ? g : m)).offset : null;
  const edges = group.filter((g) => !g.across || Math.abs(g.offset - nearest!) < 0.5);
  return {
    edges: edges.map(({ panelId, edge }) => ({ panelId, edge })),
    origin: a,
    dir,
    normal,
    between: nearest !== null,
  };
}

/**
 * The border at `point`: on an edge (within `tolerance` mm), or in the gutter
 * between two panels.
 */
export function seamAt(page: Page, point: Point, tolerance: number): Seam | null {
  const onEdge = edgeAt(page, point, tolerance);
  if (onEdge) return seamOf(page, onEdge);
  if (page.panels.some((panel) => insidePolygon(panel.shape, point))) return null;
  const near = edgeAt(page, point, MAX_GUTTER_MM / 2 + tolerance);
  if (!near) return null;
  const seam = seamOf(page, near);
  if (!seam?.between) return null;
  // The point must lie between the two sides of the border.
  const offsets = seam.edges.map(({ panelId, edge }) => {
    const panel = page.panels.find((p) => p.id === panelId)!;
    return dot(minus(panel.shape[edge], seam.origin), seam.normal);
  });
  const here = dot(minus(point, seam.origin), seam.normal);
  const [lo, hi] = [Math.min(...offsets), Math.max(...offsets)];
  return here >= lo - tolerance && here <= hi + tolerance ? seam : null;
}

/** Where the line through `p` along `d` meets the line through `q` along `e`. */
function meet(p: Point, d: Point, q: Point, e: Point): Point | null {
  const denominator = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / denominator;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

/** Signed area: its sign tells which way round a shape goes. */
function signedArea(shape: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < shape.length; i++) {
    const [x0, y0] = shape[i];
    const [x1, y1] = shape[(i + 1) % shape.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

/** The shapes of the seam's panels with the border moved `distance` mm along its normal. */
function movedShapes(base: ReadonlyMap<string, Point[]>, seam: Seam, distance: number): Map<string, Point[]> {
  const shift: Point = [seam.normal[0] * distance, seam.normal[1] * distance];
  const result = new Map<string, Point[]>();
  const byPanel = new Map<string, number[]>();
  for (const { panelId, edge } of seam.edges) byPanel.set(panelId, [...(byPanel.get(panelId) ?? []), edge]);
  for (const [panelId, edges] of byPanel) {
    const shape = base.get(panelId);
    if (!shape) continue;
    const n = shape.length;
    const moved = shape.map((p) => [...p] as Point);
    for (const edge of edges) {
      const ends = [edge, (edge + 1) % n];
      const linePoint: Point = [shape[edge][0] + shift[0], shape[edge][1] + shift[1]];
      for (const [k, vertex] of ends.entries()) {
        // The vertex slides along its other edge, so slanted neighbours keep their slant.
        const otherEdge = k === 0 ? (vertex - 1 + n) % n : vertex;
        const otherPoint = shape[k === 0 ? (vertex - 1 + n) % n : (vertex + 1) % n];
        const hit = edges.includes(otherEdge) ? null : meet(otherPoint, minus(shape[vertex], otherPoint), linePoint, seam.dir);
        moved[vertex] = hit ?? [shape[vertex][0] + shift[0], shape[vertex][1] + shift[1]];
      }
    }
    result.set(panelId, moved);
  }
  return result;
}

function fine(before: readonly Point[], after: readonly Point[]): boolean {
  const [x0, y0, x1, y1] = bounds(after);
  if (x1 - x0 < MIN_SIZE_MM || y1 - y0 < MIN_SIZE_MM) return false;
  return Math.sign(signedArea(after)) === Math.sign(signedArea(before)) && area(after) > MIN_SIZE_MM * MIN_SIZE_MM;
}

/**
 * Move the border `distance` mm along its normal, from the shapes in `base`
 * (taken when the drag began). Stops short where a panel would get too thin
 * or turn inside out. Returns the distance actually moved.
 */
export function moveSeam(page: Page, base: ReadonlyMap<string, Point[]>, seam: Seam, distance: number): number {
  const ok = (d: number) => {
    const shapes = movedShapes(base, seam, d);
    return [...shapes].every(([id, shape]) => fine(base.get(id)!, shape)) ? shapes : null;
  };
  let applied = distance;
  let shapes = ok(distance);
  if (!shapes) {
    // The furthest point that still works, between 0 and `distance`.
    let [good, bad] = [0, distance];
    for (let i = 0; i < 20; i++) {
      const mid = (good + bad) / 2;
      if (ok(mid)) good = mid;
      else bad = mid;
    }
    applied = good;
    shapes = ok(good) ?? new Map();
  }
  for (const panel of page.panels) {
    const shape = shapes.get(panel.id);
    if (shape) panel.shape = shape;
  }
  return applied;
}

/** The shapes of the seam's panels, to move the border from. */
export function seamBase(page: Page, seam: Seam): Map<string, Point[]> {
  const ids = new Set(seam.edges.map((edge) => edge.panelId));
  return new Map(page.panels.filter((panel) => ids.has(panel.id)).map((panel) => [panel.id, panel.shape.map((p) => [...p] as Point)]));
}

/** The seam's edges as they are now (to show which border is under the pointer). */
export function seamLines(page: Page, seam: Seam): [Point, Point][] {
  return seam.edges.flatMap(({ panelId, edge }) => {
    const panel = page.panels.find((p) => p.id === panelId);
    return panel ? [edgeEnds(panel, edge)] : [];
  });
}

/**
 * Snap a straight border as it moves: the distance that puts the seam's
 * line on one of the targets' xs (vertical seams) or ys (horizontal ones)
 * within `tolerance`, else on the grid, and the line it went onto when that
 * is one to show. A slanted seam does not snap.
 */
export function snapSeam(seam: Seam, distance: number, targets: SnapTargets, tolerance: number): { distance: number; guide: number | null } {
  const horizontal = Math.abs(seam.dir[1]) < 1e-6;
  const vertical = Math.abs(seam.dir[0]) < 1e-6;
  if (!horizontal && !vertical) return { distance, guide: null };
  const axis = horizontal ? 1 : 0;
  const position = seam.origin[axis] + seam.normal[axis] * distance;
  const grid = targets.grid ? { origin: horizontal ? targets.grid.y0 : targets.grid.x0, step: targets.grid.step } : null;
  const snapped = snapValue(position, horizontal ? targets.ys : targets.xs, grid, tolerance);
  return { distance: (snapped.value - seam.origin[axis]) / seam.normal[axis], guide: snapped.guide };
}

// --- つなげる -----------------------------------------------------------------

function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * Two panels side by side as one: the shape over both and the gutter
 * between, or null when they do not line up (one wider than the other, so
 * that joining them would cover more than the gutter).
 */
export function joinedShape(a: Panel, b: Panel): Point[] | null {
  const hull = convexHull([...a.shape, ...b.shape]);
  const extra = area(hull) - area(a.shape) - area(b.shape);
  // Only the gutter may be added: at most its width along the shorter side.
  const [ax0, ay0, ax1, ay1] = bounds(a.shape);
  const [bx0, by0, bx1, by1] = bounds(b.shape);
  const side = Math.max(Math.min(ax1 - ax0, bx1 - bx0), Math.min(ay1 - ay0, by1 - by0));
  if (extra > side * MAX_GUTTER_MM + 1) return null;
  // Rounding leaves points on a straight edge: drop them.
  return hull.filter((p, i) => {
    const prev = hull[(i - 1 + hull.length) % hull.length];
    const next = hull[(i + 1) % hull.length];
    return segmentDistance(p, prev, next) > 0.05;
  });
}

/** The panels across a border from `panel`, each with the side they are on. */
export function neighbours(page: Page, panel: Panel): { panel: Panel; side: "top" | "bottom" | "left" | "right" }[] {
  const found = new Map<string, "top" | "bottom" | "left" | "right">();
  const [cx0, cy0, cx1, cy1] = bounds(panel.shape);
  const centre: Point = [(cx0 + cx1) / 2, (cy0 + cy1) / 2];
  for (let edge = 0; edge < panel.shape.length; edge++) {
    const seam = seamOf(page, { panelId: panel.id, edge });
    if (!seam?.between) continue;
    for (const ref of seam.edges) {
      if (ref.panelId === panel.id || found.has(ref.panelId)) continue;
      const other = page.panels.find((p) => p.id === ref.panelId)!;
      const [ox0, oy0, ox1, oy1] = bounds(other.shape);
      const [dx, dy] = [(ox0 + ox1) / 2 - centre[0], (oy0 + oy1) / 2 - centre[1]];
      found.set(other.id, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top");
    }
  }
  return [...found].map(([id, side]) => ({ panel: page.panels.find((p) => p.id === id)!, side }));
}

/**
 * Join `b` into `a` (つなげる): `a` takes the shape over both, `b` goes.
 * False when they do not line up or one is half of a 見開き.
 */
export function joinPanels(page: Page, a: Panel, b: Panel, binding: Binding): boolean {
  if (a.spread || b.spread) return false;
  const shape = joinedShape(a, b);
  if (!shape) return false;
  // 裁ち切り: an edge stays open where it runs along open edges of either panel.
  const openSegments = [a, b].flatMap((panel) => (panel.openEdges ?? []).map((edge) => edgeEnds(panel, edge)));
  const onOpen = (point: Point) => openSegments.some(([p, q]) => segmentDistance(point, p, q) < 0.05);
  const open = shape.flatMap(([x0, y0], i) => {
    const [x1, y1] = shape[(i + 1) % shape.length];
    const at = (t: number): Point => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    return onOpen(at(0.25)) && onOpen(at(0.75)) ? [i] : [];
  });
  a.shape = shape;
  if (open.length) a.openEdges = open;
  else delete a.openEdges;
  if (!a.note && b.note) a.note = b.note;
  else if (a.note && b.note) a.note = `${a.note} / ${b.note}`;
  removePanel(page, b.id, binding);
  return true;
}

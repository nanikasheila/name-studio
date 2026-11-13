// Plane geometry on page millimetres: boxes, polygons and segments. No
// knowledge of the name data beyond its point and box types.

import type { BoxMm, Point } from "./model";

/** Page millimetres → canvas pixels: `px = mm * scale + offset`. */
export interface MmToPx {
  scale: number;
  x: number;
  y: number;
}

export function bounds(points: readonly (readonly number[])[]): BoxMm {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

export function rectShape([x0, y0, x1, y1]: BoxMm): Point[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
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

/** Whether the segments a-b and c-d meet (touching ends count). */
export function segmentsMeet(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): boolean {
  const side = (o: readonly number[], p: readonly number[], q: readonly number[]) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const within = (o: readonly number[], p: readonly number[], q: readonly number[]) =>
    Math.min(o[0], p[0]) <= q[0] && q[0] <= Math.max(o[0], p[0]) && Math.min(o[1], p[1]) <= q[1] && q[1] <= Math.max(o[1], p[1]);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && within(c, d, a)) || (d2 === 0 && within(c, d, b)) || (d3 === 0 && within(a, b, c)) || (d4 === 0 && within(a, b, d));
}

function boxesMeet([a0, b0, a1, b1]: BoxMm, [c0, d0, c1, d1]: BoxMm): boolean {
  return a0 <= c1 && c0 <= a1 && b0 <= d1 && d0 <= b1;
}

/** Whether the edges of two outlines (`closed`: the last point joins the first) cross anywhere. */
function edgesMeet(a: readonly (readonly number[])[], aClosed: boolean, b: readonly Point[]): boolean {
  for (let i = aClosed ? 0 : 1, h = aClosed ? a.length - 1 : 0; i < a.length; h = i++)
    for (let j = 0, k = b.length - 1; j < b.length; k = j++) if (segmentsMeet(a[h], a[i], b[k], b[j])) return true;
  return false;
}

/** Whether an open line (a rough line's points) touches a closed shape at all: a point inside it, or crossing its outline. */
export function lineTouchesShape(shape: readonly Point[], points: readonly (readonly number[])[]): boolean {
  if (shape.length < 3 || points.length === 0 || !boxesMeet(bounds(shape), bounds(points))) return false;
  return points.some(([x, y]) => insidePolygon(shape, [x, y])) || edgesMeet(points, false, shape);
}

/** Whether two closed shapes overlap at all: a corner of one inside the other, or their outlines crossing. */
export function shapesOverlap(a: readonly Point[], b: readonly Point[]): boolean {
  if (a.length < 3 || b.length < 3 || !boxesMeet(bounds(a), bounds(b))) return false;
  return a.some((point) => insidePolygon(b, point)) || b.some((point) => insidePolygon(a, point)) || edgesMeet(a, true, b);
}

export function boxCenter([x0, y0, x1, y1]: BoxMm): Point {
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/**
 * Open edges of a shape cut out of another: an edge is open when it lies
 * along one of the old open edges.
 */
export function inheritOpenEdges(old: readonly Point[], open: readonly number[] | undefined, shape: readonly Point[]): number[] {
  if (!open?.length) return [];
  const result: number[] = [];
  for (let i = 0; i < shape.length; i++) {
    const a = shape[i];
    const b = shape[(i + 1) % shape.length];
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const along = open.some((j) => {
      const p = old[j];
      const q = old[(j + 1) % old.length];
      return onSegment(a, p, q) && onSegment(b, p, q) && onSegment(mid, p, q);
    });
    if (along) result.push(i);
  }
  return result;
}

function onSegment(point: Point, a: Point, b: Point, tolerance = 0.02): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return Math.hypot(point[0] - a[0], point[1] - a[1]) <= tolerance;
  const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (length * length);
  if (t < -1e-6 || t > 1 + 1e-6) return false;
  return Math.abs((point[0] - a[0]) * dy - (point[1] - a[1]) * dx) / length <= tolerance;
}

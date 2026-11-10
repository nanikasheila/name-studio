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

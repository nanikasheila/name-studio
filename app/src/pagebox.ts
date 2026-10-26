// A page's boxes (canvas, 仕上がり, 基本枠) and cutting a panel shape along a
// line, with the gutter between the halves and the snap of a cut to the edges.

import { area, insidePolygon } from "./geometry";
import type { BoxMm, PageFormat, Point } from "./model";
import { DEFAULT_GUTTERS } from "./project";

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

/** Keep the part of `shape` where `side(point) >= 0` (Sutherland–Hodgman, one edge). */
export function clipHalfPlane(shape: readonly Point[], side: (p: Point) => number): Point[] {
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

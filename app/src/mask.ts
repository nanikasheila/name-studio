// コマ枠でマスク: a balloon cut off at the border of its panel, as a balloon
// inside a CSP panel folder is. The outline itself is cut, so the page on
// screen, the PDF and the CSP vector layers all show the same.

import type { Panel, Point } from "./model";
import { panelLineMm } from "./style";

/** Twice the area of a polygon, positive when it runs anticlockwise (y up) / clockwise on the page (y down). */
function area2(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum;
}

/** Whether every turn of the polygon goes the same way (and it is not degenerate). */
export function isConvex(points: readonly Point[]): boolean {
  if (points.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const [cx, cy] = points[(i + 2) % points.length];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return sign !== 0;
}

/** A convex polygon moved in by `d` on every side (each edge pushed inwards, corners where they meet). */
export function insetConvex(points: readonly Point[], d: number): Point[] {
  const n = points.length;
  const turn = Math.sign(area2(points)) || 1;
  // Each edge as a point and a direction, pushed inwards.
  const edges = points.map(([x0, y0], i) => {
    const [x1, y1] = points[(i + 1) % n];
    const length = Math.hypot(x1 - x0, y1 - y0) || 1;
    const [ux, uy] = [(x1 - x0) / length, (y1 - y0) / length];
    // Inwards: to the left of the edge for an anticlockwise polygon.
    const [nx, ny] = [-uy * turn, ux * turn];
    return { p: [x0 + nx * d, y0 + ny * d] as Point, u: [ux, uy] as Point };
  });
  return edges.map((edge, i) => {
    const prev = edges[(i - 1 + n) % n];
    const denominator = prev.u[0] * edge.u[1] - prev.u[1] * edge.u[0];
    if (Math.abs(denominator) < 1e-9) return edge.p;
    const t = ((edge.p[0] - prev.p[0]) * edge.u[1] - (edge.p[1] - prev.p[1]) * edge.u[0]) / denominator;
    return [prev.p[0] + prev.u[0] * t, prev.p[1] + prev.u[1] * t];
  });
}

/** Which side of each edge of `clip` is inside, as a test on a point. */
function insideTests(clip: readonly Point[]): ((p: Point) => number)[] {
  const turn = Math.sign(area2(clip)) || 1;
  return clip.map(([x0, y0], i) => {
    const [x1, y1] = clip[(i + 1) % clip.length];
    return ([x, y]: Point) => ((x1 - x0) * (y - y0) - (y1 - y0) * (x - x0)) * turn;
  });
}

/** The part of a closed outline inside a convex polygon (Sutherland–Hodgman). */
export function clipClosed(subject: readonly Point[], clip: readonly Point[]): Point[] {
  let out: Point[] = [...subject];
  for (const side of insideTests(clip)) {
    if (!out.length) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i - 1 + input.length) % input.length];
      const b = input[i];
      const [sa, sb] = [side(a), side(b)];
      if (sb >= 0) {
        if (sa < 0) out.push(cross(a, b, sa, sb));
        out.push(b);
      } else if (sa >= 0) {
        out.push(cross(a, b, sa, sb));
      }
    }
  }
  return out;
}

function cross(a: Point, b: Point, sa: number, sb: number): Point {
  const t = sa / (sa - sb);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** The runs of an open line inside a convex polygon. */
export function clipOpen(points: readonly Point[], clip: readonly Point[]): Point[][] {
  const tests = insideTests(clip);
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (let i = 1; i < points.length; i++) {
    // Cyrus–Beck: the part of the segment inside every edge.
    const [a, b] = [points[i - 1], points[i]];
    let [t0, t1] = [0, 1];
    for (const side of tests) {
      const [sa, sb] = [side(a), side(b)];
      if (sa < 0 && sb < 0) {
        t0 = 1;
        t1 = 0;
        break;
      }
      if (sa < 0) t0 = Math.max(t0, sa / (sa - sb));
      else if (sb < 0) t1 = Math.min(t1, sa / (sa - sb));
    }
    if (t0 >= t1) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    }
    const at = (t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (!run.length || t0 > 0) {
      if (run.length > 1) runs.push(run);
      run = [at(t0)];
    }
    run.push(at(t1));
    if (t1 < 1) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * What a masked balloon is cut to: the panel inside half its border, so the
 * border is drawn whole over the cut. Null when the panel is not convex (the
 * balloon is then left whole).
 */
export function maskShape(panel: Panel): Point[] | null {
  if (!isConvex(panel.shape)) return null;
  const border = panel.border === "none" ? 0 : panelLineMm(panel);
  return insetConvex(panel.shape, border / 2);
}

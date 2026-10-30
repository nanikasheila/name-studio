// 塗りつぶし as in CSP: the closed area around a point (塗りつぶし), every
// closed area inside an outline (囲って塗る) or under a brush (塗り残し部分に
// 塗る), worked out on a fine grid over the page. The rough lines and panel
// borders bound the areas (参照), small gaps in them can be closed (隙間閉じ),
// the area can reach under the lines to their middle (ベクターの中心で塗り止
// まり) and be grown or shrunk (領域拡縮). The areas are traced back to
// outlines with holes, as the name keeps its fills.

import { widthFactors } from "./brush";
import { insidePolygon } from "./geometry";
import { borderLines, borderWidthMm } from "./koma";
import type { Page, Point, Project } from "./model";
import { shownStrokes, withoutMarks } from "./roughlayers";

/** 参照: what bounds an area. Fills already made always do. */
export type FillRefer = "all" | "rough" | "panels";

export const REFER_LABELS: Record<FillRefer, string> = { all: "ラフ線とコマ枠", rough: "ラフ線だけ", panels: "コマ枠だけ" };

export interface FillOptions {
  /** 隙間閉じ: gaps in the lines up to this wide (mm) are closed; 0: none. */
  gapMm: number;
  /** ベクターの中心で塗り止まり: the area goes under the lines to their middle, leaving no gap along them. */
  center: boolean;
  /** 領域拡縮: the area grown by this much (mm), or shrunk when below 0. */
  growMm: number;
  refer: FillRefer;
}

/** An area to fill: an outline and the holes in it (page mm). */
export interface Region {
  shape: Point[];
  holes?: Point[][];
}

/** What came of a fill: the areas, or why there are none. */
export type FillResult = { regions: Region[]; wholePage?: boolean } | { none: "onLine" | "nothingClosed" };

/** Grid cells (mm). Finer is closer to the lines; the cells of a page are kept under MAX_CELLS. */
const STEP_MM = 0.2;
const MAX_CELLS = 3_200_000;

/** The page as a grid of cells: cell (i, j) covers [i, i + 1) × [j, j + 1) steps. */
interface Grid {
  w: number;
  h: number;
  step: number;
}

function gridOf(project: Pick<Project, "pageFormat">): Grid {
  const [wMm, hMm] = project.pageFormat.canvasMm;
  const step = Math.max(STEP_MM, Math.sqrt((wMm * hMm) / MAX_CELLS));
  return { w: Math.max(1, Math.ceil(wMm / step)), h: Math.max(1, Math.ceil(hMm / step)), step };
}

// --- what bounds the areas -------------------------------------------------------------

/**
 * The cells under the lines that bound areas, and under the fills already
 * made. With `center` the lines are thin: only their middle bounds.
 */
function walls(project: Project, page: Page, grid: Grid, options: FillOptions): Uint8Array {
  const mask = new Uint8Array(grid.w * grid.h);
  const thin = grid.step * 0.75;
  if (options.refer !== "panels") {
    for (const stroke of withoutMarks(project, shownStrokes(project, page.strokes))) {
      const brush = stroke.brush ? project.brushes?.find((b) => b.id === stroke.brush) : undefined;
      const factors = options.center ? [] : widthFactors(stroke, brush);
      const half = (i: number) => (options.center ? thin : Math.max(thin, (stroke.widthMm * (factors[i] ?? 1)) / 2));
      const points = stroke.points;
      if (points.length === 1) capsule(mask, grid, points[0], points[0], half(0));
      for (let i = 1; i < points.length; i++) capsule(mask, grid, points[i - 1], points[i], Math.max(half(i - 1), half(i)));
      if (stroke.closed && points.length > 2) capsule(mask, grid, points[points.length - 1], points[0], half(0));
    }
  }
  if (options.refer !== "rough") {
    for (const line of borderLines(page)) {
      const half = options.center ? thin : Math.max(thin, borderWidthMm(line.panel) / 2);
      const points = line.points;
      for (let i = 1; i < points.length; i++) capsule(mask, grid, points[i - 1], points[i], half);
      if (line.closed && points.length > 2) capsule(mask, grid, points[points.length - 1], points[0], half);
    }
  }
  for (const fill of page.fills ?? []) polygon(mask, grid, [fill.shape, ...(fill.holes ?? [])]);
  return mask;
}

/** Mark the cells whose middle is within `radius` mm of the segment a–b. */
function capsule(mask: Uint8Array, { w, h, step }: Grid, a: readonly number[], b: readonly number[], radius: number): void {
  const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - radius) / step));
  const i1 = Math.min(w - 1, Math.floor((Math.max(a[0], b[0]) + radius) / step));
  const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - radius) / step));
  const j1 = Math.min(h - 1, Math.floor((Math.max(a[1], b[1]) + radius) / step));
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const r2 = radius * radius;
  for (let j = j0; j <= j1; j++) {
    const y = (j + 0.5) * step;
    for (let i = i0; i <= i1; i++) {
      const x = (i + 0.5) * step;
      const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length));
      const ex = x - (a[0] + t * dx);
      const ey = y - (a[1] + t * dy);
      if (ex * ex + ey * ey <= r2) mask[j * w + i] = 1;
    }
  }
}

/** Mark the cells whose middle is inside the rings (even-odd: a ring inside another is a hole). */
function polygon(mask: Uint8Array, { w, h, step }: Grid, rings: readonly (readonly Point[])[]): void {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const ring of rings) for (const [, y] of ring) [y0, y1] = [Math.min(y0, y), Math.max(y1, y)];
  const j0 = Math.max(0, Math.floor(y0 / step));
  const j1 = Math.min(h - 1, Math.ceil(y1 / step));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = (j + 0.5) * step;
    xs.length = 0;
    for (const ring of rings) {
      for (let k = 0, l = ring.length - 1; k < ring.length; l = k++) {
        const [ax, ay] = ring[l];
        const [bx, by] = ring[k];
        if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] / step - 0.5));
      const to = Math.min(w - 1, Math.ceil(xs[k + 1] / step - 0.5) - 1);
      for (let i = from; i <= to; i++) mask[j * w + i] = 1;
    }
  }
}

// --- growing and flooding --------------------------------------------------------------

/** The cells within `radius` cells of a marked one (by the distance between cell middles, to within a few per cent). */
function dilate(mask: Uint8Array, { w, h }: Grid, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  if (radius <= 0) {
    out.set(mask);
    return out;
  }
  const limit = Math.round(radius * STRAIGHT);
  const d = chamfer(mask, w, h, limit + DIAGONAL);
  for (let k = 0; k < mask.length; k++) if (d[k] <= limit) out[k] = 1;
  return out;
}

/** The cells further than `radius` cells from every unmarked one. */
function erode(mask: Uint8Array, grid: Grid, radius: number): Uint8Array {
  const grown = dilate(invert(mask), grid, radius);
  for (let k = 0; k < mask.length; k++) grown[k] = mask[k] && !grown[k] ? 1 : 0;
  return grown;
}

/** Chamfer steps: 5 to a side, 7 to a corner, 11 a knight's move away (within 2 % of the true distance). */
const STRAIGHT = 5;
const DIAGONAL = 7;
const KNIGHT = 11;

/**
 * The distance from each cell to the nearest marked one in chamfer steps,
 * no more than `cap` (two passes over the rows, forward then back).
 */
function chamfer(mask: Uint8Array, w: number, h: number, cap: number): Uint16Array {
  const top = Math.min(cap, 65535);
  const d = new Uint16Array(w * h);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] ? 0 : top;
  const w2 = 2 * w;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let best = d[k];
      if (best === 0) continue;
      if (i > 0) best = Math.min(best, d[k - 1] + STRAIGHT);
      if (j > 0) {
        best = Math.min(best, d[k - w] + STRAIGHT);
        if (i > 0) best = Math.min(best, d[k - w - 1] + DIAGONAL);
        if (i < w - 1) best = Math.min(best, d[k - w + 1] + DIAGONAL);
        if (i > 1) best = Math.min(best, d[k - w - 2] + KNIGHT);
        if (i < w - 2) best = Math.min(best, d[k - w + 2] + KNIGHT);
      }
      if (j > 1) {
        if (i > 0) best = Math.min(best, d[k - w2 - 1] + KNIGHT);
        if (i < w - 1) best = Math.min(best, d[k - w2 + 1] + KNIGHT);
      }
      d[k] = best;
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      let best = d[k];
      if (best === 0) continue;
      if (i < w - 1) best = Math.min(best, d[k + 1] + STRAIGHT);
      if (j < h - 1) {
        best = Math.min(best, d[k + w] + STRAIGHT);
        if (i < w - 1) best = Math.min(best, d[k + w + 1] + DIAGONAL);
        if (i > 0) best = Math.min(best, d[k + w - 1] + DIAGONAL);
        if (i < w - 2) best = Math.min(best, d[k + w + 2] + KNIGHT);
        if (i > 1) best = Math.min(best, d[k + w - 2] + KNIGHT);
      }
      if (j < h - 2) {
        if (i < w - 1) best = Math.min(best, d[k + w2 + 1] + KNIGHT);
        if (i > 0) best = Math.min(best, d[k + w2 - 1] + KNIGHT);
      }
      d[k] = best;
    }
  }
  return d;
}

/**
 * The area grown by up to `steps` cells (side by side) through cells that
 * are not walls nor out of `clip`: it fills the band the closed gaps kept
 * from the lines, and never crosses a line.
 */
function grownAlong(area: Uint8Array, wall: Uint8Array, { w, h }: Grid, steps: number, clip?: Uint8Array): Uint8Array {
  const out = area.slice();
  let ring: number[] = [];
  const open = (n: number) => !out[n] && !wall[n] && (!clip || clip[n]);
  // The cells of its edge to start from.
  for (let k = 0; k < area.length; k++) {
    if (!area[k]) continue;
    const i = k % w;
    if ((i > 0 && !area[k - 1]) || (i < w - 1 && !area[k + 1]) || (k >= w && !area[k - w]) || (k < (h - 1) * w && !area[k + w])) ring.push(k);
  }
  for (let step = 0; step < steps && ring.length; step++) {
    const next: number[] = [];
    for (const k of ring) {
      const i = k % w;
      if (i > 0 && open(k - 1)) (out[k - 1] = 1), next.push(k - 1);
      if (i < w - 1 && open(k + 1)) (out[k + 1] = 1), next.push(k + 1);
      if (k >= w && open(k - w)) (out[k - w] = 1), next.push(k - w);
      if (k < (h - 1) * w && open(k + w)) (out[k + w] = 1), next.push(k + w);
    }
    ring = next;
  }
  return out;
}

/** The free cells joined to `seed` side by side (not corner to corner, so a line of cells touching at corners bounds). */
function flood(free: Uint8Array, { w, h }: Grid, seed: number): Uint8Array {
  const out = new Uint8Array(free.length);
  const stack = new Int32Array(free.length);
  let top = 0;
  stack[top++] = seed;
  out[seed] = 1;
  while (top) {
    const k = stack[--top];
    const i = k % w;
    if (i > 0 && free[k - 1] && !out[k - 1]) (out[k - 1] = 1), (stack[top++] = k - 1);
    if (i < w - 1 && free[k + 1] && !out[k + 1]) (out[k + 1] = 1), (stack[top++] = k + 1);
    if (k >= w && free[k - w] && !out[k - w]) (out[k - w] = 1), (stack[top++] = k - w);
    if (k < (h - 1) * w && free[k + w] && !out[k + w]) (out[k + w] = 1), (stack[top++] = k + w);
  }
  return out;
}

/**
 * Every closed area (free cells joined side by side) that has a cell in
 * `from` and all of its cells in `within`.
 */
function closedAreas(free: Uint8Array, { w, h }: Grid, from: Uint8Array, within: Uint8Array): Uint8Array {
  const out = new Uint8Array(free.length);
  const seen = new Uint8Array(free.length);
  // Each cell goes into the queue once; an area is a run of it.
  const queue = new Int32Array(free.length);
  let tail = 0;
  for (let start = 0; start < free.length; start++) {
    if (!from[start] || !free[start] || seen[start]) continue;
    const first = tail;
    let head = tail;
    queue[tail++] = start;
    seen[start] = 1;
    let inside = true;
    while (head < tail) {
      const k = queue[head++];
      if (!within[k]) inside = false;
      const i = k % w;
      if (i > 0 && free[k - 1] && !seen[k - 1]) (seen[k - 1] = 1), (queue[tail++] = k - 1);
      if (i < w - 1 && free[k + 1] && !seen[k + 1]) (seen[k + 1] = 1), (queue[tail++] = k + 1);
      if (k >= w && free[k - w] && !seen[k - w]) (seen[k - w] = 1), (queue[tail++] = k - w);
      if (k < (h - 1) * w && free[k + w] && !seen[k + w]) (seen[k + w] = 1), (queue[tail++] = k + w);
    }
    if (inside) for (let q = first; q < tail; q++) out[queue[q]] = 1;
  }
  return out;
}

/** The nearest cell to `seed` that is free, going round the walls only (none further than `reach` cells). */
function nearestFree(free: Uint8Array, wall: Uint8Array, { w, h }: Grid, seed: number, reach: number): number {
  const seen = new Map<number, number>([[seed, 0]]);
  let ring = [seed];
  for (let step = 0; step <= reach && ring.length; step++) {
    const next: number[] = [];
    for (const k of ring) {
      if (free[k]) return k;
      const i = k % w;
      for (const n of [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, k >= w ? k - w : -1, k < (h - 1) * w ? k + w : -1]) {
        if (n < 0 || wall[n] || seen.has(n)) continue;
        seen.set(n, step + 1);
        next.push(n);
      }
    }
    ring = next;
  }
  return -1;
}

// --- after the flood ------------------------------------------------------------------

/**
 * The area as it is filled: the band the closed gaps took back (but not the
 * lines, nor past `clip`), then under the lines to their middle, then grown
 * or shrunk.
 */
function finish(area: Uint8Array, wall: Uint8Array, grid: Grid, options: FillOptions, clip?: Uint8Array): Uint8Array {
  let out = area;
  const gap = gapCells(grid, options);
  // Side by side, a walk round a corner goes up to √2 times as far; one cell more leaves nothing between the area and the lines.
  if (gap > 0) out = grownAlong(out, wall, grid, Math.ceil(gap * Math.SQRT2) + 1, clip);
  if (options.center) {
    // The thin lines are one or two cells across: two steps reach their middle from either side.
    for (let pass = 0; pass < 2; pass++) out = reachInto(out, wall, grid, clip);
  }
  const grow = options.growMm / grid.step;
  if (grow > 0) out = dilate(out, grid, grow);
  else if (grow < 0) out = erode(out, grid, -grow);
  return out;
}

function gapCells(grid: Grid, options: FillOptions): number {
  return options.gapMm > 0 ? options.gapMm / 2 / grid.step : 0;
}

/** The area and the wall cells beside it (side by side, so that what is added is joined to it). */
function reachInto(area: Uint8Array, wall: Uint8Array, { w, h }: Grid, clip?: Uint8Array): Uint8Array {
  const out = area.slice();
  for (let k = 0; k < area.length; k++) {
    if (area[k] || !wall[k] || (clip && !clip[k])) continue;
    const i = k % w;
    if ((i > 0 && area[k - 1]) || (i < w - 1 && area[k + 1]) || (k >= w && area[k - w]) || (k < (h - 1) * w && area[k + w])) out[k] = 1;
  }
  return out;
}

// --- back to outlines ----------------------------------------------------------------

/**
 * The outlines of the marked cells: each outer edge with the holes in it.
 * Edges run with the area on their right (on screen, y down), so outer
 * outlines go clockwise and holes the other way; where two cells touch only
 * at a corner they stay apart.
 */
export function outlines(mask: Uint8Array, grid: Grid): Region[] {
  const { w, h, step } = grid;
  const W = w + 1;
  // Each edge by where it starts (a corner of cells, y·(w + 1) + x) and which way it goes (0 →, 1 ↓, 2 ←, 3 ↑).
  let from: Int32Array = new Int32Array(1024);
  let dir: Uint8Array = new Uint8Array(1024);
  let count = 0;
  // A corner starts at most two edges (where two cells meet at it only): the first and the second, each + 1.
  const first = new Int32Array(W * (h + 1));
  const second = new Int32Array(W * (h + 1));
  const edge = (a: number, d: number) => {
    if (count === from.length) {
      from = grow32(from);
      const more = new Uint8Array(dir.length * 2);
      more.set(dir);
      dir = more;
    }
    from[count] = a;
    dir[count] = d;
    if (first[a]) second[a] = count + 1;
    else first[a] = count + 1;
    count++;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!mask[k]) continue;
      if (y === 0 || !mask[k - w]) edge(y * W + x, 0);
      if (x === w - 1 || !mask[k + 1]) edge(y * W + x + 1, 1);
      if (y === h - 1 || !mask[k + w]) edge((y + 1) * W + x + 1, 2);
      if (x === 0 || !mask[k - 1]) edge((y + 1) * W + x, 3);
    }
  }
  const END = [1, W, -1, -W];
  const used = new Uint8Array(count);
  const rings: Point[][] = [];
  for (let start = 0; start < count; start++) {
    if (used[start]) continue;
    const points: Point[] = [];
    let e = start;
    while (!used[e]) {
      used[e] = 1;
      const a = from[e];
      const b = a + END[dir[e]];
      points.push([((a % W) + (b % W)) / 2 * step, (Math.floor(a / W) + Math.floor(b / W)) / 2 * step]);
      const one = first[b] - 1;
      const two = second[b] - 1;
      const free1 = one >= 0 && !used[one];
      const free2 = two >= 0 && !used[two];
      if (!free1 && !free2) break;
      // Where two cells meet at a corner, turn right, round the cell this edge belongs to.
      if (free1 && free2) e = dir[two] === (dir[e] + 1) % 4 ? two : one;
      else e = free1 ? one : two;
    }
    const ring = simplifyRing(points, step * 0.5);
    if (ring.length >= 3) rings.push(ring);
  }
  const min = step * step * 2;
  const outers = rings.filter((ring) => signedArea(ring) > min).sort((a, b) => signedArea(a) - signedArea(b));
  const regions = outers.map((shape): Region => ({ shape }));
  for (const hole of rings.filter((ring) => signedArea(ring) < -min)) {
    const size = -signedArea(hole);
    const index = outers.findIndex((outer) => signedArea(outer) > size && insidePolygon(outer, hole[0]));
    if (index < 0) continue;
    (regions[index].holes ??= []).push(hole);
  }
  return regions;
}

function grow32(array: Int32Array): Int32Array {
  const more = new Int32Array(array.length * 2);
  more.set(array);
  return more;
}

function signedArea(ring: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

/** A closed outline with the points dropped that are within `tolerance` of the line through their neighbours kept (Douglas–Peucker). */
function simplifyRing(points: Point[], tolerance: number): Point[] {
  if (points.length < 4) return points;
  // Split at the point furthest from the first, and simplify each half.
  let far = 0;
  let best = -1;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (d > best) [best, far] = [d, i];
  }
  const first = simplifyRun(points.slice(0, far + 1), tolerance);
  const second = simplifyRun([...points.slice(far), points[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)].map(([x, y]) => [round(x), round(y)] as Point);
}

function simplifyRun(points: Point[], tolerance: number): Point[] {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let index = -1;
    let best = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = lineDistance(points[i], points[a], points[b]);
      if (d > best) [best, index] = [d, i];
    }
    if (index < 0) continue;
    keep[index] = 1;
    stack.push([a, index], [index, b]);
  }
  return points.filter((_, i) => keep[i]);
}

function lineDistance([x, y]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  return length === 0 ? Math.hypot(x - ax, y - ay) : Math.abs((x - ax) * dy - (y - ay) * dx) / length;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

// --- the three ways ------------------------------------------------------------------

/** 塗りつぶし: the closed area around `point`. */
export function fillAt(project: Project, page: Page, point: Point, options: FillOptions): FillResult {
  const grid = gridOf(project);
  const i = Math.floor(point[0] / grid.step);
  const j = Math.floor(point[1] / grid.step);
  if (i < 0 || j < 0 || i >= grid.w || j >= grid.h) return { none: "nothingClosed" };
  const wall = walls(project, page, grid, options);
  const gap = gapCells(grid, options);
  const closed = gap > 0 ? dilate(wall, grid, gap) : wall;
  const free = invert(closed);
  let seed = j * grid.w + i;
  if (wall[seed]) return { none: "onLine" };
  // Close to a line, in the band that closes gaps: start from the nearest cell out of it.
  if (!free[seed]) seed = nearestFree(free, wall, grid, seed, Math.ceil(gap) + 2);
  if (seed < 0) return { none: "onLine" };
  const area = finish(flood(free, grid, seed), wall, grid, options);
  const regions = outlines(area, grid);
  if (!regions.length) return { none: "nothingClosed" };
  return { regions, wholePage: touchesAllSides(area, grid) };
}

/** 囲って塗る: every closed area wholly inside `outline`. */
export function fillInside(project: Project, page: Page, outline: readonly Point[], options: FillOptions): FillResult {
  const grid = gridOf(project);
  const lasso = new Uint8Array(grid.w * grid.h);
  polygon(lasso, grid, [outline]);
  return areasIn(project, page, grid, options, lasso, lasso);
}

/**
 * 塗り残し部分に塗る: the closed areas the brush (`radiusMm` round) went
 * over, small enough to be within twice its size of where it went (the
 * specks and slivers left between lines and fills).
 */
export function fillUnder(project: Project, page: Page, path: readonly Point[], radiusMm: number, options: FillOptions): FillResult {
  const grid = gridOf(project);
  const swept = new Uint8Array(grid.w * grid.h);
  const near = new Uint8Array(grid.w * grid.h);
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)];
    capsule(swept, grid, a, path[i], radiusMm);
    capsule(near, grid, a, path[i], radiusMm * 2);
  }
  return areasIn(project, page, grid, options, swept, near);
}

function areasIn(project: Project, page: Page, grid: Grid, options: FillOptions, from: Uint8Array, within: Uint8Array): FillResult {
  const wall = walls(project, page, grid, options);
  const gap = gapCells(grid, options);
  const free = invert(gap > 0 ? dilate(wall, grid, gap) : wall);
  const found = closedAreas(free, grid, from, within);
  if (!found.some((cell) => cell)) return { none: "nothingClosed" };
  const regions = outlines(finish(found, wall, grid, options, within), grid);
  return regions.length ? { regions } : { none: "nothingClosed" };
}

function invert(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let k = 0; k < mask.length; k++) out[k] = mask[k] ? 0 : 1;
  return out;
}

/** Whether the area reaches every edge of the page (nothing bounded it). */
function touchesAllSides(area: Uint8Array, { w, h }: Grid): boolean {
  let top = false;
  let bottom = false;
  let left = false;
  let right = false;
  for (let i = 0; i < w; i++) {
    top ||= !!area[i];
    bottom ||= !!area[(h - 1) * w + i];
  }
  for (let j = 0; j < h; j++) {
    left ||= !!area[j * w];
    right ||= !!area[j * w + w - 1];
  }
  return top && bottom && left && right;
}

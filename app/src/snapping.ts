// 吸着: what panel corners, borders and whole panels snap to while they are
// drawn, moved or changed: horizontal and vertical with the corners beside
// them, the lines of the other panels (and a コマ間 away from them), the
// frames of the page, and a grid. Settings are kept on this computer (prefs.ts).
import type { BoxMm, Gutters, Page, PageFormat, Point } from "./model";
import { centroid } from "./geometry";
import { basicBox, trimBox } from "./pagebox";

export interface SnapSettings {
  /** 水平・垂直: a corner lines up with the corners next to it. */
  axis: boolean;
  /** The lines of the other panels' edges, and a コマ間 away from them. */
  panels: boolean;
  /** The canvas, the trim (裁ち切り) and the basic frame (基本枠). */
  frame: boolean;
  grid: boolean;
  /** Grid spacing (mm), from the top left of the basic frame. */
  gridMm: number;
}

export const DEFAULT_SNAP: SnapSettings = { axis: true, panels: true, frame: true, grid: false, gridMm: 5 };
export const MIN_GRID_MM = 1;
export const MAX_GRID_MM = 50;

/** Snap settings as read back (anything missing or unreadable is the default). */
export function snapFrom(stored: unknown): SnapSettings {
  const kept = (typeof stored === "object" ? stored : null) as Partial<SnapSettings> | null;
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const gridMm = Number(kept?.gridMm);
  return {
    axis: flag(kept?.axis, DEFAULT_SNAP.axis),
    panels: flag(kept?.panels, DEFAULT_SNAP.panels),
    frame: flag(kept?.frame, DEFAULT_SNAP.frame),
    grid: flag(kept?.grid, DEFAULT_SNAP.grid),
    gridMm: Number.isFinite(gridMm) && gridMm >= MIN_GRID_MM && gridMm <= MAX_GRID_MM ? gridMm : DEFAULT_SNAP.gridMm,
  };
}

/** A line to snap to: `at` is its x (in `xs`) or y (in `ys`); `guide` lines are shown when snapped to. */
export interface Target {
  at: number;
  guide: boolean;
}

export interface SnapTargets {
  xs: Target[];
  ys: Target[];
  /** The grid's origin and step (mm), when it is on. */
  grid: { x0: number; y0: number; step: number } | null;
}

/** Lines snapped to (page mm), to show while dragging. */
export interface Guides {
  xs: number[];
  ys: number[];
}

/** Edges this close to level or plumb (mm over their length) count as horizontal or vertical. */
const STRAIGHT = 0.05;

/**
 * What a panel point on `page` snaps to with `settings`: the page's frames,
 * the corners and straight edges of its panels but those in `exclude` (the
 * ones being changed), the lines a コマ間 away from those edges, and the grid.
 */
export function snapTargets(page: Page | null, format: PageFormat, settings: SnapSettings, gutters: Gutters, exclude: ReadonlySet<string> = new Set()): SnapTargets {
  const xs: Target[] = [];
  const ys: Target[] = [];
  if (settings.frame) {
    const [w, h] = format.canvasMm;
    const trim = trimBox(format);
    const basic = basicBox(format);
    for (const at of [0, w, trim[0], trim[2], basic[0], basic[2]]) xs.push({ at, guide: true });
    for (const at of [0, h, trim[1], trim[3], basic[1], basic[3]]) ys.push({ at, guide: true });
  }
  if (settings.panels && page) {
    for (const panel of page.panels) {
      if (exclude.has(panel.id)) continue;
      const [cx, cy] = centroid(panel.shape);
      panel.shape.forEach((a, i) => {
        xs.push({ at: a[0], guide: true });
        ys.push({ at: a[1], guide: true });
        const b = panel.shape[(i + 1) % panel.shape.length];
        // Across the gutter from a straight edge, outside the panel: where the next panel's edge goes.
        if (Math.abs(a[0] - b[0]) <= STRAIGHT && gutters.across > 0) {
          const x = (a[0] + b[0]) / 2;
          xs.push({ at: x < cx ? x - gutters.across : x + gutters.across, guide: true });
        }
        if (Math.abs(a[1] - b[1]) <= STRAIGHT && gutters.down > 0) {
          const y = (a[1] + b[1]) / 2;
          ys.push({ at: y < cy ? y - gutters.down : y + gutters.down, guide: true });
        }
      });
    }
  }
  const basic = basicBox(format);
  const grid = settings.grid && settings.gridMm > 0 ? { x0: basic[0], y0: basic[1], step: settings.gridMm } : null;
  return { xs, ys, grid };
}

/** No lines and no grid: nothing snaps. */
export const NO_TARGETS: SnapTargets = { xs: [], ys: [], grid: null };

/**
 * `value` snapped on one axis: to the nearest of `targets` within
 * `tolerance` (lines win over the grid), else to the grid when there is one.
 * `guide` is the line snapped to when it is one to show.
 */
export function snapValue(value: number, targets: readonly Target[], grid: { origin: number; step: number } | null, tolerance: number): { value: number; guide: number | null } {
  let best: Target | null = null;
  let gap = tolerance;
  for (const target of targets) {
    const d = Math.abs(target.at - value);
    if (d <= gap) {
      best = target;
      gap = d;
    }
  }
  if (best) return { value: best.at, guide: best.guide ? best.at : null };
  if (grid) return { value: grid.origin + Math.round((value - grid.origin) / grid.step) * grid.step, guide: null };
  return { value, guide: null };
}

function gridOn(targets: SnapTargets, axis: 0 | 1): { origin: number; step: number } | null {
  return targets.grid ? { origin: axis === 0 ? targets.grid.x0 : targets.grid.y0, step: targets.grid.step } : null;
}

/**
 * A point snapped on both axes. `beside` are the corners next to it (the
 * ones before and after it on the outline, or the last one placed): with
 * them it lines up horizontally or vertically.
 */
export function snapPointTo(point: Point, targets: SnapTargets, tolerance: number, beside: readonly Point[] = []): { point: Point; guides: Guides } {
  const xs = [...targets.xs, ...beside.map(([x]) => ({ at: x, guide: true }))];
  const ys = [...targets.ys, ...beside.map(([, y]) => ({ at: y, guide: true }))];
  const x = snapValue(point[0], xs, gridOn(targets, 0), tolerance);
  const y = snapValue(point[1], ys, gridOn(targets, 1), tolerance);
  return { point: [x.value, y.value], guides: { xs: x.guide === null ? [] : [x.guide], ys: y.guide === null ? [] : [y.guide] } };
}

/**
 * How far to shift a box being moved so that one of its sides (or its
 * middle) lies on a line: the smallest shift on each axis within
 * `tolerance`; with only the grid, its top left goes onto the grid.
 */
export function snapBox(box: BoxMm, targets: SnapTargets, tolerance: number): { dx: number; dy: number; guides: Guides } {
  const axis = (low: number, high: number, lines: readonly Target[], grid: { origin: number; step: number } | null) => {
    let best: { shift: number; guide: number | null } | null = null;
    for (const edge of [low, high, (low + high) / 2]) {
      for (const line of lines) {
        const shift = line.at - edge;
        if (Math.abs(shift) <= tolerance && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, guide: line.guide ? line.at : null };
      }
    }
    if (best) return best;
    if (grid) return { shift: snapValue(low, [], grid, tolerance).value - low, guide: null };
    return { shift: 0, guide: null };
  };
  const x = axis(box[0], box[2], targets.xs, gridOn(targets, 0));
  const y = axis(box[1], box[3], targets.ys, gridOn(targets, 1));
  return { dx: x.shift, dy: y.shift, guides: { xs: x.guide === null ? [] : [x.guide], ys: y.guide === null ? [] : [y.guide] } };
}

/** The corners before and after corner `index` of a closed outline. */
export function besideCorners(shape: readonly Point[], index: number): Point[] {
  const n = shape.length;
  if (n < 2) return [];
  return [shape[(index - 1 + n) % n], shape[(index + 1) % n]];
}

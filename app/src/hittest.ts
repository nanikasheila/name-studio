// What is under the pointer on a page: the thing a click picks, the lines and
// panels at a point, a panel's corner, number or a tail and its handles.
// Pure: the page and where it is on screen (a Slot) in, the hit out; what the
// editor has picked or hovers comes in as plain values.
import { insideBalloon, tailGeometry } from "./balloon";
import { bounds, insideBox, insidePolygon, segmentDistance } from "./geometry";
import { stacked } from "./koma";
import type { Slot } from "./layout";
import type { Page, PageFormat, Panel, Point, Sticky, Stroke } from "./model";
import { trimBox } from "./pagebox";
import { corners } from "./references";
import { stickyBox } from "./stickies";
import { insideFill, strokeHit } from "./strokes";

/** Half the size of a handle on screen (px). */
export const HANDLE = 5;
/** A 資料 picture's corner handle's reach, in screen px. */
export const REFERENCE_HANDLE = 7;

/** Something on a page a click picks. */
export interface PageHit {
  kind: "sticky" | "line" | "stroke" | "fill" | "breakout" | "panel";
  id: string;
}

export type TailPart = "tip" | "body" | "bend" | "root";

/** A tail of a line under the pointer. */
export interface TailHit {
  lineId: string;
  index: number;
  part: TailPart;
}

/** What the page shows of the editor's state, for picking. */
export interface PickState {
  /** Whether a 付箋 is open (selected or under the pointer): all of its text can be pointed at. */
  open(sticky: Sticky): boolean;
  /** The line selected on this page: of overlapping balloons it stays the one picked (a double-click writes in it). */
  selectedLine: string | null;
  /** Rough lines on a locked layer are not picked. */
  editable(stroke: Stroke): boolean;
}

/**
 * What a click at `point` (mm) picks, top first: 付箋, then dialogue, rough
 * lines, fills, はみ出し, and panels (inset ones over theirs). `scale` is the
 * page's px per mm, for how near a line must be.
 */
export function pickAt(page: Page, point: Point, scale: number, state: PickState): PageHit | null {
  const tolerance = 6 / scale;
  for (const sticky of [...(page.stickies ?? [])].reverse()) {
    if (insideBox(stickyBox(sticky, state.open(sticky)), point)) return { kind: "sticky", id: sticky.id };
  }
  const under = linesAt(page, point);
  const line = under.find((id) => id === state.selectedLine) ?? under[0];
  if (line) return { kind: "line", id: line };
  const stroke = [...page.strokes].reverse().find((stroke) => state.editable(stroke) && strokeHit(stroke, point, tolerance));
  if (stroke) return { kind: "stroke", id: stroke.id };
  const fill = [...(page.fills ?? [])].reverse().find((fill) => insideFill(fill, point));
  if (fill) return { kind: "fill", id: fill.id };
  const breakout = [...page.breakouts].reverse().find((breakout) => insidePolygon(breakout.shape, point));
  if (breakout) return { kind: "breakout", id: breakout.id };
  // Panels on top (はめ込み) first, then the smaller.
  const panel = [...page.panels].sort((a, b) => (b.z ?? 0) - (a.z ?? 0) || bounds(a.shape)[2] - bounds(b.shape)[2]).find((panel) => insidePolygon(panel.shape, point));
  return panel ? { kind: "panel", id: panel.id } : null;
}

/** Lines whose balloon or text (and a little around it) is under `point`, top first. */
export function linesAt(page: Page, point: Point): string[] {
  return [...page.lines]
    .reverse()
    .filter((line) => {
      const [x0, y0, x1, y1] = line.box;
      return (line.balloon && insidePolygon(line.balloon, point)) || insideBox([x0 - 1.5, y0 - 1.5, x1 + 1.5, y1 + 1.5], point);
    })
    .map((line) => line.id);
}

/** The topmost panel at a point of a page (insets over their panel). */
export function panelAt(page: Page, point: Point): Panel | undefined {
  return [...stacked(page.panels)].reverse().find((panel) => insidePolygon(panel.shape, point));
}

/** The corner of `panel` under a point of the screen (px), or -1. */
export function cornerAt(slot: Slot, panel: Panel, sx: number, sy: number): number {
  return panel.shape.findIndex(([x, y]) => Math.abs(slot.x + x * slot.scale - sx) <= HANDLE + 2 && Math.abs(slot.y + y * slot.scale - sy) <= HANDLE + 2);
}

/** Where a panel's number sits (screen px). Numbers stay inside the page even for panels that run off it. */
export function panelBadge(slot: Slot, panel: Panel, format: PageFormat | undefined, pageW: number): { x: number; y: number; radius: number } {
  const [, y0, x1] = bounds(panel.shape);
  const radius = Math.max(4 * slot.scale, 7);
  const [, ty0, tx1] = format ? trimBox(format) : [0, 0, pageW];
  return {
    x: Math.min(slot.x + x1 * slot.scale, slot.x + Math.min(pageW, tx1) * slot.scale) - radius - 3,
    y: Math.max(slot.y + y0 * slot.scale, slot.y + Math.max(0, ty0) * slot.scale) + radius + 3,
    radius,
  };
}

/** The panel whose number is under a point of the screen (px), the top one first. */
export function badgeAt(slot: Slot, format: PageFormat | undefined, pageW: number, sx: number, sy: number): Panel | undefined {
  return [...stacked(slot.page.panels)].reverse().find((panel) => {
    const { x, y, radius } = panelBadge(slot, panel, format, pageW);
    return Math.hypot(x - sx, y - sy) <= radius + 2;
  });
}

/**
 * The tail under a point of the screen (px): its tip, its middle (to bend
 * it) or its root (to slide it along the balloon) on the lines in `shown`
 * (selected or hovered), or anywhere along any line's tail outside its
 * balloon. Lines in `shown` first, then the others from the top.
 */
export function tailAt(slot: Slot, sx: number, sy: number, shown: ReadonlySet<string>): TailHit | null {
  const near = (p: Point, extra = 3) => Math.hypot(slot.x + p[0] * slot.scale - sx, slot.y + p[1] * slot.scale - sy) <= HANDLE + extra;
  const point: Point = [(sx - slot.x) / slot.scale, (sy - slot.y) / slot.scale];
  const reach = Math.max(6 / slot.scale, 1.2);
  const lines = [...slot.page.lines].reverse().sort((a, b) => Number(shown.has(b.id)) - Number(shown.has(a.id)));
  for (const line of lines) {
    for (const [index, tail] of (line.tails ?? []).entries()) {
      if (near(tail.tip)) return { lineId: line.id, index, part: "tip" };
      const geometry = tailGeometry(line, tail);
      if (!geometry) continue;
      if (shown.has(line.id) && near(geometry.middle, 2)) return { lineId: line.id, index, part: "bend" };
      if (shown.has(line.id) && near(geometry.root, 2)) return { lineId: line.id, index, part: "root" };
      // Along the tail (outside the balloon): root to middle to tip.
      const close = (a: Point, b: Point) => segmentDistance(point, a, b) <= reach;
      if ((close(geometry.root, geometry.middle) || close(geometry.middle, tail.tip)) && !insideBalloon(line, point)) {
        return { lineId: line.id, index, part: "body" };
      }
    }
  }
  return null;
}

/** The chosen 資料 picture's corner under a screen point of `slot`'s page (0–3), or -1. */
export function referenceCornerAt(slot: Slot, chosenId: string | null, sx: number, sy: number): number {
  const chosen = chosenId === null ? undefined : slot.page.references?.find((r) => r.id === chosenId);
  if (!chosen) return -1;
  return corners(chosen.box).findIndex(([x, y]) => Math.hypot(slot.x + x * slot.scale - sx, slot.y + y * slot.scale - sy) <= REFERENCE_HANDLE + 2);
}

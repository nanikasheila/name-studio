// Where the pages lie on the editor's screen: one spread (見開き), one page
// (単独), or every spread on one canvas (連続), and the conversions between
// the screen (CSS px, before the view's rotation) and a page (mm).
import type { BoxMm, Page, PageFormat, Point, Project } from "./model";
import { trimBox } from "./project";

/** Room around the pages (px). */
export const MARGIN = 28;
/** Room under the pages for their number and memo (px). */
export const CAPTION = 36;
/** 連続: room between the spreads by default (mm, and px so that they stay apart when small). */
export const GRID_GAP_MM = 12;
export const GRID_GAP_PX = 14;
/** The most room between the spreads that can be set (mm). */
export const MAX_PAGE_GAP_MM = 100;

/** A page as laid out on screen. */
export interface Slot {
  page: Page;
  index: number;
  x: number;
  y: number;
  scale: number;
  /** Page mm shown, `[x0, x1]`: a page facing another ends at the gutter
   * (the edge of its trim), so the two read as one spread. */
  shown: [number, number];
}

/** A spread: its page numbers (1-based), right page first; null where there is none. */
export type Pair = [number | null, number | null];

/** How the pages are arranged and viewed. */
export interface Arrangement {
  /** 単独: one page at a time instead of 見開き (連続 wins over it). */
  single: boolean;
  /** 連続: every spread on one canvas. */
  continuous: boolean;
  /** 連続: how many rows the spreads are in. */
  rows: number;
  zoom: number;
  pan: [number, number];
  /** 連続: room between the spreads (mm); none is GRID_GAP_MM. */
  gapMm?: number;
  /** The stage (CSS px). */
  width: number;
  height: number;
}

/** A spread's width (mm): the trims of its two pages meet at the gutter, as in the book. */
export function spreadWidth(format: PageFormat): number {
  const [pageW] = format.canvasMm;
  const [trimX0, , trimX1] = trimBox(format);
  return trimX1 + (pageW - trimX0);
}

/** px per mm with a whole spread on a stage of `width` x `height` (zoom 1). */
export function spreadFit(format: PageFormat, width: number, height: number): number {
  const [, pageH] = format.canvasMm;
  return Math.min((width - 2 * MARGIN) / spreadWidth(format), (height - 2 * MARGIN - CAPTION) / pageH);
}

/** 連続: how many rows `count` spreads are in (1 to one spread a row). */
export function rowCount(rows: number, count: number): number {
  return Math.min(Math.max(1, rows), Math.max(1, count));
}

/** The pages of a spread whose left edge is at `left`, top at `top`. */
export function spreadSlots(project: Project, pair: Pair, left: number, top: number, scale: number): Slot[] {
  const [pageW] = project.pageFormat.canvasMm;
  const [trimX0, , trimX1] = trimBox(project.pageFormat);
  // Right binding: [right page, left page]; left binding mirrors it.
  const [rightPage, leftPage] = project.binding === "right" ? pair : [pair[1], pair[0]];
  const facing = rightPage !== null && leftPage !== null;
  const slots: Slot[] = [];
  const place = (pageNumber: number | null, x: number, shown: [number, number]) => {
    if (pageNumber === null || !project.pages[pageNumber - 1]) return;
    slots.push({ page: project.pages[pageNumber - 1], index: pageNumber - 1, x, y: top, scale, shown });
  };
  place(leftPage, left, facing ? [0, trimX1] : [0, pageW]);
  place(rightPage, left + (trimX1 - trimX0) * scale, facing ? [trimX0, pageW] : [0, pageW]);
  return slots;
}

/**
 * The pages on screen: the spread (or page) `current` of `list`, in the
 * middle; or, 連続, every spread of `list`.
 */
export function layoutPages(project: Project, list: Pair[], current: number, view: Arrangement): Slot[] {
  if (view.continuous) return continuousLayout(project, list, view);
  const pair = list[current];
  if (!pair) return [];
  const { width, height } = view;
  const [pageW, pageH] = project.pageFormat.canvasMm;
  if (view.single) {
    // 単独: the whole page in the middle.
    const page = pair[0] ?? pair[1];
    if (page === null) return [];
    const scale = Math.min((width - 2 * MARGIN) / pageW, (height - 2 * MARGIN - CAPTION) / pageH) * view.zoom;
    const x = (width - pageW * scale) / 2 + view.pan[0];
    const y = (height - CAPTION - pageH * scale) / 2 + view.pan[1];
    return [{ page: project.pages[page - 1], index: page - 1, x, y, scale, shown: [0, pageW] }];
  }
  const spreadMm = spreadWidth(project.pageFormat);
  const scale = spreadFit(project.pageFormat, width, height) * view.zoom;
  const left = (width - spreadMm * scale) / 2 + view.pan[0];
  const top = (height - CAPTION - pageH * scale) / 2 + view.pan[1];
  return spreadSlots(project, pair, left, top, scale);
}

/**
 * 連続: every spread on one canvas, as the pages of a name sheet: in reading
 * order along each row (right to left for right binding), the rows going
 * down. At zoom 1 a spread is as big as on its own; the first one starts
 * at the top corner where reading starts (the view's pan moves over the rest).
 */
function continuousLayout(project: Project, list: Pair[], view: Arrangement): Slot[] {
  const [, pageH] = project.pageFormat.canvasMm;
  const spreadMm = spreadWidth(project.pageFormat);
  const scale = spreadFit(project.pageFormat, view.width, view.height) * view.zoom;
  const columns = Math.ceil(list.length / rowCount(view.rows, list.length));
  const gap = pageGapPx(view.gapMm ?? GRID_GAP_MM, scale);
  const pitchX = spreadMm * scale + gap;
  const pitchY = pageH * scale + CAPTION + gap;
  const step = project.binding === "right" ? -1 : 1;
  const left = (step < 0 ? view.width - MARGIN - spreadMm * scale : MARGIN) + view.pan[0];
  const top = MARGIN + view.pan[1];
  return list.flatMap((pair, i) => spreadSlots(project, pair, left + step * (i % columns) * pitchX, top + Math.floor(i / columns) * pitchY, scale));
}

/** 連続: the room between spreads on screen (px): `gapMm` at the scale, a little more while it is small, none for 0. */
export function pageGapPx(gapMm: number, scale: number): number {
  const gap = Math.max(0, gapMm);
  return gap * scale + GRID_GAP_PX * Math.min(1, gap / GRID_GAP_MM);
}

/** The screen box (px) of the pages in `slots`, with the room for their page numbers. */
export function extent(slots: Slot[], pageH: number): BoxMm | null {
  if (!slots.length) return null;
  return [
    Math.min(...slots.map((slot) => slot.x + slot.shown[0] * slot.scale)),
    Math.min(...slots.map((slot) => slot.y)),
    Math.max(...slots.map((slot) => slot.x + slot.shown[1] * slot.scale)),
    Math.max(...slots.map((slot) => slot.y + pageH * slot.scale + CAPTION)),
  ];
}

/** Whether any of a page (and its number) is on a stage of `width` x `height`, turned by `rotation`. */
export function onStage(slot: Slot, pageH: number, width: number, height: number, rotation: number): boolean {
  // A turned view shows what lies beyond the edges: room for any turn.
  const room = rotation ? Math.max(width, height) / 2 : 0;
  const x0 = slot.x + slot.shown[0] * slot.scale;
  const x1 = slot.x + slot.shown[1] * slot.scale;
  const y1 = slot.y + pageH * slot.scale + CAPTION;
  return x1 >= -room && x0 <= width + room && y1 >= -room && slot.y <= height + room;
}

/** A point of the screen (px) on a page (mm). */
export function toPage(slot: Slot, sx: number, sy: number): Point {
  return [(sx - slot.x) / slot.scale, (sy - slot.y) / slot.scale];
}

/** The page at a point of the screen: a little room outside a page, but not across the gutter. */
export function slotAt(slots: Slot[], sx: number, sy: number, format: PageFormat): Slot | null {
  const [pageW, pageH] = format.canvasMm;
  return (
    slots.find((slot) => {
      const [x, y] = toPage(slot, sx, sy);
      const x0 = slot.shown[0] > 0 ? slot.shown[0] : -10;
      const x1 = slot.shown[1] < pageW ? slot.shown[1] : pageW + 10;
      return x >= x0 && x < x1 && y >= -10 && y <= pageH + 10;
    }) ?? null
  );
}

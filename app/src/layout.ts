// Where the pages lie on the editor's screen: one spread (見開き), one page
// (単独), or every spread on one canvas (連続), and the conversions between
// the screen (CSS px, before the view's rotation) and a page (mm).
import type { Room } from "./aside";
import type { BoxMm, Page, PageFormat, Point, Project } from "./model";
import { trimBox } from "./pagebox";

/** Room around the pages (px). */
export const MARGIN = 28;
/** Room under the pages for their number and memo (px): at least this, more for a long memo (captionRoom). */
export const CAPTION = 36;
/** The pitch of the rows of a page's number and memo (px). */
export const CAPTION_ROW = 16;
/** 連続: room between the spreads by default (mm, and px so that they stay apart when small). */
export const GRID_GAP_MM = 12;
export const GRID_GAP_PX = 14;
/** The most room between the spreads that can be set (mm). */
export const MAX_PAGE_GAP_MM = 100;
/** 縦スクロール: room left of the strip for the pieces' numbers (px). */
export const STRIP_SIDE = 36;

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
  /** Room under the page for its number and memo (px); none is CAPTION. */
  caption?: number;
}

/** A spread: its page numbers (1-based), right page first; null where there is none. */
export type Pair = [number | null, number | null];

/** How the pages are arranged and viewed. */
export interface Arrangement {
  /** 単独: one page at a time instead of 見開き (連続 wins over it). */
  single: boolean;
  /** 連続: every spread on one canvas. */
  continuous: boolean;
  /** 連続: how many rows the spreads are in (縦スクロール: how many columns the strip is cut into). */
  rows: number;
  zoom: number;
  pan: [number, number];
  /** 連続: room between the spreads (mm); none is GRID_GAP_MM. */
  gapMm?: number;
  /** 連続: room kept around every page for what lies in the 欄外 (mm: top, right, bottom, left). */
  room?: Room;
  /** The stage (CSS px). */
  width: number;
  height: number;
  /** How many rows a page's number and memo take under it, as wide as its trim is at `widthPx`; none is one. */
  captionRows?: (page: Page, index: number, widthPx: number) => number;
}

/** The room (px) for a number and memo of `rows` rows: the first row's baseline 18 px under the page, a row's pitch for each further one, and the letters' tails. */
export function captionRoom(rows: number): number {
  return Math.max(CAPTION, 18 + CAPTION_ROW * (rows - 1) + 6);
}

/** The room (px) the numbers and memos of `pages` (indexes) need under them at `scale`. */
function roomUnder(project: Project, view: Arrangement, pages: number[], scale: number): number {
  const rows = view.captionRows;
  if (!rows) return CAPTION;
  const [trimX0, , trimX1] = trimBox(project.pageFormat);
  const width = (trimX1 - trimX0) * scale;
  return captionRoom(Math.max(1, ...pages.flatMap((index) => (project.pages[index] ? [rows(project.pages[index], index, width)] : []))));
}

/** The page indexes of the spreads in `list`. */
function indexesOf(list: Pair[]): number[] {
  return list.flatMap((pair) => pair.flatMap((number) => (number === null ? [] : [number - 1])));
}

/** A spread's width (mm): the trims of its two pages meet at the gutter, as in the book. */
export function spreadWidth(format: PageFormat): number {
  const [pageW] = format.canvasMm;
  const [trimX0, , trimX1] = trimBox(format);
  return trimX1 + (pageW - trimX0);
}

/** px per mm with a whole spread on a stage of `width` x `height` (zoom 1). */
export function spreadFit(format: PageFormat, width: number, height: number, caption = CAPTION): number {
  const [, pageH] = format.canvasMm;
  return Math.min((width - 2 * MARGIN) / spreadWidth(format), (height - 2 * MARGIN - caption) / pageH);
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
  if (view.continuous) return project.scroll ? stripLayout(project, list, view) : continuousLayout(project, list, view);
  const pair = list[current];
  if (!pair) return [];
  const { width, height } = view;
  const [pageW, pageH] = project.pageFormat.canvasMm;
  if (view.single || project.scroll) {
    // 単独 (and a piece of a 縦スクロール strip): the whole page in the middle.
    const page = pair[0] ?? pair[1];
    if (page === null) return [];
    const [fit, room] = fitWithCaptions(project, list, view, (caption) => Math.min((width - 2 * MARGIN) / pageW, (height - 2 * MARGIN - caption) / pageH));
    const scale = fit * view.zoom;
    const x = (width - pageW * scale) / 2 + view.pan[0];
    const y = (height - room - pageH * scale) / 2 + view.pan[1];
    const caption = roomUnder(project, view, [page - 1], scale);
    return [{ page: project.pages[page - 1], index: page - 1, x, y, scale, shown: [0, pageW], caption }];
  }
  const spreadMm = spreadWidth(project.pageFormat);
  const [fit, room] = fitWithCaptions(project, list, view, (caption) => spreadFit(project.pageFormat, width, height, caption));
  const scale = fit * view.zoom;
  const left = (width - spreadMm * scale) / 2 + view.pan[0];
  const top = (height - room - pageH * scale) / 2 + view.pan[1];
  const caption = roomUnder(project, view, indexesOf([pair]), scale);
  return spreadSlots(project, pair, left, top, scale).map((slot) => ({ ...slot, caption }));
}

/**
 * 見開き・単独: the scale (zoom 1) that fits a page with the room for the
 * longest number and memo of all of `list` under it, and that room: as
 * large for every spread, so that the pages keep their size while turned.
 * A smaller page wraps its memo into more rows: a second round settles it.
 */
function fitWithCaptions(project: Project, list: Pair[], view: Arrangement, fit: (caption: number) => number): [number, number] {
  const pages = indexesOf(list);
  let room = CAPTION;
  let scale = fit(room);
  for (let i = 0; i < 2 && view.captionRows; i++) {
    const need = roomUnder(project, view, pages, scale);
    if (need <= room) break;
    room = need;
    scale = fit(room);
  }
  return [scale, room];
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
  const [roomTop, roomRight, roomBottom, roomLeft] = (view.room ?? [0, 0, 0, 0]).map((mm) => mm * scale);
  const pitchX = spreadMm * scale + gap + roomLeft + roomRight;
  const step = project.binding === "right" ? -1 : 1;
  const left = (step < 0 ? view.width - MARGIN - roomRight - spreadMm * scale : MARGIN + roomLeft) + view.pan[0];
  // Each row as far below the one above as that one's longest memo needs.
  const slots: Slot[] = [];
  let top = MARGIN + roomTop + view.pan[1];
  for (let start = 0; start < list.length; start += columns) {
    const row = list.slice(start, start + columns);
    const caption = roomUnder(project, view, indexesOf(row), scale);
    row.forEach((pair, i) => slots.push(...spreadSlots(project, pair, left + step * i * pitchX, top, scale).map((slot) => ({ ...slot, caption }))));
    top += pageH * scale + caption + gap + roomTop + roomBottom;
  }
  return slots;
}

/**
 * 連続 for 縦スクロール: the pieces one under the other with nothing between
 * them, as the strip is read. With more than one column (`rows`) the strip
 * is cut into that many, left to right, to see more of it at once. At zoom 1
 * a piece fills the height.
 */
function stripLayout(project: Project, list: Pair[], view: Arrangement): Slot[] {
  const [pageW, pageH] = project.pageFormat.canvasMm;
  const scale = Math.min((view.width - 2 * MARGIN - STRIP_SIDE) / pageW, (view.height - 2 * MARGIN) / pageH) * view.zoom;
  const perColumn = Math.ceil(list.length / rowCount(view.rows, list.length));
  const [, roomRight, , roomLeft] = (view.room ?? [0, 0, 0, 0]).map((mm) => mm * scale);
  const pitchX = pageW * scale + STRIP_SIDE + pageGapPx(view.gapMm ?? GRID_GAP_MM, scale) + roomLeft + roomRight;
  const left = MARGIN + STRIP_SIDE + roomLeft + view.pan[0];
  const top = MARGIN + view.pan[1];
  return list.flatMap((pair, i): Slot[] => {
    const number = pair[0] ?? pair[1];
    const page = number === null ? undefined : project.pages[number - 1];
    if (!page || number === null) return [];
    const x = left + Math.floor(i / perColumn) * pitchX;
    return [{ page, index: number - 1, x, y: top + (i % perColumn) * pageH * scale, scale, shown: [0, pageW] }];
  });
}

/** 連続: the room between spreads on screen (px): `gapMm` at the scale, a little more while it is small, none for 0. */
export function pageGapPx(gapMm: number, scale: number): number {
  const gap = Math.max(0, gapMm);
  return gap * scale + GRID_GAP_PX * Math.min(1, gap / GRID_GAP_MM);
}

/** The screen box (px) of the pages in `slots`, with the room for their page numbers (and `room` around them for the 欄外). */
export function extent(slots: Slot[], pageH: number, room?: Room): BoxMm | null {
  if (!slots.length) return null;
  const [top, right, bottom, left] = room ?? [0, 0, 0, 0];
  return [
    Math.min(...slots.map((slot) => slot.x + (slot.shown[0] - left) * slot.scale)),
    Math.min(...slots.map((slot) => slot.y - top * slot.scale)),
    Math.max(...slots.map((slot) => slot.x + (slot.shown[1] + right) * slot.scale)),
    Math.max(...slots.map((slot) => slot.y + (pageH + bottom) * slot.scale + (slot.caption ?? CAPTION))),
  ];
}

/** Whether any of a page (and its number) is on a stage of `width` x `height`, turned by `rotation`. */
export function onStage(slot: Slot, pageH: number, width: number, height: number, rotation: number): boolean {
  // A turned view shows what lies beyond the edges: room for any turn.
  const room = rotation ? Math.max(width, height) / 2 : 0;
  const x0 = slot.x + slot.shown[0] * slot.scale;
  const x1 = slot.x + slot.shown[1] * slot.scale;
  const y1 = slot.y + pageH * slot.scale + (slot.caption ?? CAPTION);
  return x1 >= -room && x0 <= width + room && y1 >= -room && slot.y <= height + room;
}

/**
 * 連続: the zoom and pan that make the spreads as large as fits, at most
 * zoom 1: every page (`all`, in the middle) or the rows as tall as the stage
 * (`rows`, the screen x that `across` gives for the laid-out pages put in
 * the middle).
 */
export function fitContinuous(project: Project, list: Pair[], view: Arrangement, what: "all" | "rows", across: (slots: Slot[]) => number | null): { zoom: number; pan: Point } {
  const pageH = project.pageFormat.canvasMm[1];
  let zoom = 1;
  const slots = (pan: [number, number] = [0, 0]) => layoutPages(project, list, 0, { ...view, continuous: true, zoom, pan });
  for (let i = 0; i < 3; i++) {
    // The gaps between the spreads are partly px: a few rounds settle the zoom.
    const box = extent(slots(), pageH, view.room);
    if (!box) return { zoom: 1, pan: [0, 0] };
    const tall = (view.height - 2 * MARGIN) / (box[3] - box[1]);
    zoom = Math.min(Math.max(zoom * (what === "rows" ? tall : Math.min((view.width - 2 * MARGIN) / (box[2] - box[0]), tall)), 0.02), 1);
  }
  const laid = slots();
  const box = extent(laid, pageH, view.room)!;
  const x = what === "rows" ? (across(laid) ?? (box[0] + box[2]) / 2) : (box[0] + box[2]) / 2;
  return { zoom, pan: [view.width / 2 - x, view.height / 2 - (box[1] + box[3]) / 2] };
}

/**
 * 連続: how the spreads were fitted to a stage of `width` x `height`, if
 * they were: every page inside and filling it across or down (`all`), or
 * the rows filling its height (`rows`, or in its middle at zoom 1).
 */
export function fittedTo(slots: Slot[], pageH: number, width: number, height: number, zoom: number, room?: Room): "all" | "rows" | null {
  const box = extent(slots, pageH, room);
  if (!box) return null;
  const [w, h] = [box[2] - box[0], box[3] - box[1]];
  const middle = (a: number, b: number, size: number) => Math.abs((a + b) / 2 - size / 2) < 2;
  const fills = (length: number, size: number) => Math.abs(length - (size - 2 * MARGIN)) < 2;
  const across = middle(box[0], box[2], width);
  if (across && middle(box[1], box[3], height) && w <= width && h <= height && (fills(w, width) || fills(h, height))) return "all";
  if (middle(box[1], box[3], height) && (fills(h, height) || (zoom === 1 && h <= height))) return "rows";
  return null;
}

/** The page nearest a point of the stage (px) and the point of it (mm, maybe off the page) there. */
export function nearestTo(slots: Slot[], format: PageFormat, [sx, sy]: Point): { index: number; point: Point } | null {
  const [pageW, pageH] = format.canvasMm;
  let best: { index: number; point: Point; far: number } | null = null;
  for (const slot of slots) {
    const point = toPage(slot, sx, sy);
    const far = Math.hypot(Math.max(0, -point[0], point[0] - pageW), Math.max(0, -point[1], point[1] - pageH));
    if (!best || far < best.far) best = { index: slot.index, point, far };
  }
  return best && { index: best.index, point: best.point };
}

/** The page nearest a point of the screen (px) that is on none: the one whose 欄外 it is in. */
export function nearestSlot(slots: readonly Slot[], format: PageFormat, [sx, sy]: Point): Slot | null {
  const pageH = format.canvasMm[1];
  let best: { slot: Slot; far: number } | null = null;
  for (const slot of slots) {
    const [x, y] = toPage(slot, sx, sy);
    const far = Math.hypot(Math.max(0, slot.shown[0] - x, x - slot.shown[1]), Math.max(0, -y, y - pageH)) * slot.scale;
    if (!best || far < best.far) best = { slot, far };
  }
  return best?.slot ?? null;
}

/** Where a point of a page (mm) is on the screen (px), or null when the page is not laid out. */
export function onScreenOf(slots: Slot[], { index, point }: { index: number; point: Point }): Point | null {
  const slot = slots.find((s) => s.index === index);
  return slot ? [slot.x + point[0] * slot.scale, slot.y + point[1] * slot.scale] : null;
}

/** A point of the screen (px) on a page (mm). */
export function toPage(slot: Slot, sx: number, sy: number): Point {
  return [(sx - slot.x) / slot.scale, (sy - slot.y) / slot.scale];
}

/** The page at a point of the screen: the one it is on, else one with a little room outside it, but not across the gutter. */
export function slotAt(slots: Slot[], sx: number, sy: number, format: PageFormat): Slot | null {
  const [pageW, pageH] = format.canvasMm;
  // Pieces of a strip touch: the one the point is on before the room around another.
  const on = slots.find((slot) => {
    const [x, y] = toPage(slot, sx, sy);
    return x >= slot.shown[0] && x < slot.shown[1] && y >= 0 && y < pageH;
  });
  if (on) return on;
  return (
    slots.find((slot) => {
      const [x, y] = toPage(slot, sx, sy);
      const x0 = slot.shown[0] > 0 ? slot.shown[0] : -10;
      const x1 = slot.shown[1] < pageW ? slot.shown[1] : pageW + 10;
      return x >= x0 && x < x1 && y >= -10 && y <= pageH + 10;
    }) ?? null
  );
}

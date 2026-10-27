// ミニネーム: every page of the name on one sheet, to see the whole at a
// glance, print or send. Spread by spread in reading order along each row
// (right to left for a right-bound book), the rows going down, as the pages
// of a name sheet; a 縦スクロール strip in columns, left to right. This is
// where each page goes (mm on the sheet); drawing it is flatpage.ts's.
import type { BoxMm, Project } from "./model";
import { trimBox } from "./pagebox";
import { spreads } from "./pages";

export interface MiniOptions {
  /** Each page cut at the trim (仕上がり) or the whole canvas. */
  area: "trim" | "canvas";
  dpi: number;
  /** Spreads across a row (縦スクロール: columns of the strip); 0 chooses. */
  columns: number;
  /** The page number under each page. */
  numbers: boolean;
  /** The name's title at the top. */
  title: boolean;
}

export type MiniFormat = "png" | "jpeg" | "pdf";

export const MINI_DEFAULTS: MiniOptions = { area: "trim", dpi: 100, columns: 0, numbers: true, title: true };

/** A page on the sheet: where it lies (sheet mm) and which part of the page it shows (page mm). */
export interface MiniPage {
  index: number;
  box: BoxMm;
  area: BoxMm;
}

export interface MiniSheet {
  widthMm: number;
  heightMm: number;
  pages: MiniPage[];
  /** Page numbers: the number and where its middle is (sheet mm). */
  numbers: { text: string; at: [number, number] }[];
  title: { text: string; at: [number, number] } | null;
  /** Spreads (or strip columns) across, as chosen. */
  columns: number;
  /** Rows of spreads (or pieces in a column). */
  rows: number;
}

/** Room around the sheet, between the spreads, under the pages for their numbers, and for the title (mm). */
export const MINI_MARGIN = 10;
export const MINI_GAP = 8;
export const MINI_NUMBER = 10;
export const MINI_TITLE = 12;
/** Height of the page numbers and the title (mm). */
export const MINI_NUMBER_SIZE = 5;
export const MINI_TITLE_SIZE = 6;

/** The largest sheet drawn, in px on a side and in all. */
export const MINI_MAX_SIDE = 16000;
export const MINI_MAX_PIXELS = 100_000_000;

/** Of a page, the part shown on the sheet (page mm). */
function areaOf(project: Project, area: MiniOptions["area"]): BoxMm {
  const [w, h] = project.pageFormat.canvasMm;
  return area === "trim" ? trimBox(project.pageFormat) : [0, 0, w, h];
}

/** The title line: the name, its 話, how many pages. */
export function miniTitle(project: Project): string {
  const story = project.storyIndex !== undefined ? ` 第${project.storyIndex}話` : "";
  const unit = project.scroll ? "区切り" : "ページ";
  return `${project.title}${story}　全 ${project.pages.length} ${unit}`;
}

/** Of `count` items, how many across makes a sheet nearest to A-size landscape (√2 : 1). */
function chooseColumns(count: number, aspectOf: (columns: number) => number): number {
  let best = 1;
  let bestError = Infinity;
  for (let columns = 1; columns <= Math.max(1, count); columns++) {
    const error = Math.abs(Math.log(aspectOf(columns) / Math.SQRT2));
    if (error < bestError - 1e-9) {
      best = columns;
      bestError = error;
    }
  }
  return best;
}

/**
 * Where every page goes on the sheet. Spreads keep their two pages side by
 * side as in the book (a page alone keeps its side); `firstAlone` pairs the
 * pages as the editor does.
 */
export function miniSheet(project: Project, options: MiniOptions, firstAlone: boolean): MiniSheet {
  const area = areaOf(project, options.area);
  const pageW = area[2] - area[0];
  const pageH = area[3] - area[1];
  const top = MINI_MARGIN + (options.title ? MINI_TITLE : 0);
  const numberBand = options.numbers ? MINI_NUMBER : 0;
  const count = project.pages.length;
  const pages: MiniPage[] = [];
  const numbers: MiniSheet["numbers"] = [];

  if (project.scroll) {
    // The strip in columns, left to right, the pieces touching as they are read; numbers on the left.
    const side = options.numbers ? MINI_NUMBER : 0;
    const pitch = side + pageW + MINI_GAP;
    const size = (columns: number) => {
      const perColumn = Math.ceil(Math.max(1, count) / columns);
      return [2 * MINI_MARGIN + columns * pitch - MINI_GAP, top + MINI_MARGIN + perColumn * pageH] as const;
    };
    const columns = options.columns > 0 ? Math.min(options.columns, Math.max(1, count)) : chooseColumns(count, (c) => size(c)[0] / size(c)[1]);
    const perColumn = Math.ceil(Math.max(1, count) / columns);
    const [widthMm, heightMm] = size(columns);
    for (let index = 0; index < count; index++) {
      const x = MINI_MARGIN + Math.floor(index / perColumn) * pitch + side;
      const y = top + (index % perColumn) * pageH;
      pages.push({ index, box: [x, y, x + pageW, y + pageH], area });
      if (options.numbers) numbers.push({ text: String(index + 1), at: [x - side / 2, y + MINI_NUMBER_SIZE] });
    }
    const title = options.title ? { text: miniTitle(project), at: [MINI_MARGIN, MINI_MARGIN + MINI_TITLE / 2] as [number, number] } : null;
    return { widthMm, heightMm, pages, numbers, title, columns, rows: perColumn };
  }

  const pairs = spreads(count, firstAlone);
  const spreadW = 2 * pageW;
  const pitchY = pageH + numberBand + MINI_GAP;
  const size = (columns: number) => {
    const rows = Math.ceil(Math.max(1, pairs.length) / columns);
    return [2 * MINI_MARGIN + columns * (spreadW + MINI_GAP) - MINI_GAP, top + MINI_MARGIN + rows * pitchY - MINI_GAP] as const;
  };
  const columns = options.columns > 0 ? Math.min(options.columns, Math.max(1, pairs.length)) : chooseColumns(pairs.length, (c) => size(c)[0] / size(c)[1]);
  const rows = Math.ceil(Math.max(1, pairs.length) / columns);
  const [widthMm, heightMm] = size(columns);
  const right = project.binding === "right";
  pairs.forEach((pair, i) => {
    const column = i % columns;
    const row = Math.floor(i / columns);
    // Reading starts at the top right of a right-bound book, the top left of a left-bound one.
    const left = right ? widthMm - MINI_MARGIN - spreadW - column * (spreadW + MINI_GAP) : MINI_MARGIN + column * (spreadW + MINI_GAP);
    const y = top + row * pitchY;
    // Right binding: [right page, left page]; a left-bound pair lists its left page first.
    const [rightPage, leftPage] = right ? pair : [pair[1], pair[0]];
    const place = (number: number | null, x: number) => {
      if (number === null || number > count) return;
      pages.push({ index: number - 1, box: [x, y, x + pageW, y + pageH], area });
      if (options.numbers) numbers.push({ text: String(number), at: [x + pageW / 2, y + pageH + numberBand / 2] });
    };
    place(leftPage, left);
    place(rightPage, left + pageW);
  });
  pages.sort((a, b) => a.index - b.index);
  const title = options.title ? { text: miniTitle(project), at: [right ? widthMm - MINI_MARGIN : MINI_MARGIN, MINI_MARGIN + MINI_TITLE / 2] as [number, number] } : null;
  return { widthMm, heightMm, pages, numbers, title, columns, rows };
}

/**
 * px per mm for the sheet at `dpi`, made smaller where the sheet would be
 * too large to draw; the dpi it comes to.
 */
export function miniScale(sheet: Pick<MiniSheet, "widthMm" | "heightMm">, dpi: number): { scale: number; dpi: number; reduced: boolean } {
  let scale = dpi / 25.4;
  const side = Math.max(sheet.widthMm, sheet.heightMm) * scale;
  if (side > MINI_MAX_SIDE) scale *= MINI_MAX_SIDE / side;
  const pixels = sheet.widthMm * scale * sheet.heightMm * scale;
  if (pixels > MINI_MAX_PIXELS) scale *= Math.sqrt(MINI_MAX_PIXELS / pixels);
  const reduced = scale < dpi / 25.4 - 1e-9;
  return { scale, dpi: reduced ? Math.floor(scale * 25.4) : dpi, reduced };
}

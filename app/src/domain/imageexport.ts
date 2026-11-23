// 画像で書き出す: each page (or each 見開き) of the name as a picture file, to
// take into painting tools other than CSP: PNG, JPEG, or a PSD whose layers
// follow the CSP export's (ラフ線・コマ枠・フキダシ・セリフ…). This is what
// goes in which file and where each page lies in it (mm); drawing it is
// service/imageexport.ts's.
import type { BoxMm, Project } from "../model/model";
import { trimBox } from "./pagebox";
import { spreads } from "./pages";
import { wantsSpread } from "./panels";

export type ImageFormat = "png" | "jpeg" | "psd";
/**
 * How pages go into files: one page each; every 見開き as the editor pairs
 * them (a page alone stays alone); or only the pages made one 見開き (joined,
 * or sharing a 見開きコマ), as CSP gets them.
 */
export type ImageUnit = "page" | "spread" | "joined";

export interface ImageOptions {
  format: ImageFormat;
  unit: ImageUnit;
  /** Each page cut at the trim (仕上がり) or the whole canvas. */
  area: "trim" | "canvas";
  dpi: number;
  /** White paper under the drawing; false: transparent (PNG, and the PSD's 用紙 layer hidden). JPEG is always on white. */
  paper: boolean;
}

export const IMAGE_DEFAULTS: ImageOptions = { format: "png", unit: "page", area: "trim", dpi: 350, paper: true };
export const IMAGE_FORMATS: readonly ImageFormat[] = ["png", "jpeg", "psd"];
export const IMAGE_UNITS: readonly ImageUnit[] = ["page", "spread", "joined"];
export const IMAGE_EXTENSIONS: Record<ImageFormat, string> = { png: "png", jpeg: "jpg", psd: "psd" };

/** A page in a file: which part of the page it shows (page mm) and where that lies in the file (file mm). */
export interface ImagePiece {
  index: number;
  area: BoxMm;
  box: BoxMm;
}

/** One file: its pages, its size, and what its name ends in. */
export interface ImageSheet {
  pieces: ImagePiece[];
  widthMm: number;
  heightMm: number;
  /** Page numbers (from 1) it holds, lowest first. */
  numbers: number[];
}

/** The largest file drawn, in px on a side (PSD's own limit is 30,000) and in all. */
export const IMAGE_MAX_SIDE = 30000;
export const IMAGE_MAX_PIXELS = 100_000_000;

function areaOf(project: Project, area: ImageOptions["area"]): BoxMm {
  const [w, h] = project.pageFormat.canvasMm;
  return area === "trim" ? trimBox(project.pageFormat) : [0, 0, w, h];
}

function single(project: Project, index: number, area: ImageOptions["area"]): ImageSheet {
  const shown = areaOf(project, area);
  const widthMm = shown[2] - shown[0];
  const heightMm = shown[3] - shown[1];
  return { pieces: [{ index, area: shown, box: [0, 0, widthMm, heightMm] }], widthMm, heightMm, numbers: [index + 1] };
}

/**
 * Two pages side by side as in the book, meeting at the gutter. Cut at the
 * trim, the two trims touch; with the whole canvas, each page keeps its
 * bleed on the outer side and ends at its trim on the gutter, as a printed
 * spread (and CSP's 見開き page) does.
 */
function pair(project: Project, leftIndex: number, rightIndex: number, area: ImageOptions["area"]): ImageSheet {
  const [w, h] = project.pageFormat.canvasMm;
  const [tx0, ty0, tx1, ty1] = trimBox(project.pageFormat);
  const leftArea: BoxMm = area === "trim" ? [tx0, ty0, tx1, ty1] : [0, 0, tx1, h];
  const rightArea: BoxMm = area === "trim" ? [tx0, ty0, tx1, ty1] : [tx0, 0, w, h];
  const leftW = leftArea[2] - leftArea[0];
  const rightW = rightArea[2] - rightArea[0];
  const heightMm = leftArea[3] - leftArea[1];
  return {
    pieces: [
      { index: leftIndex, area: leftArea, box: [0, 0, leftW, heightMm] },
      { index: rightIndex, area: rightArea, box: [leftW, 0, leftW + rightW, heightMm] },
    ],
    widthMm: leftW + rightW,
    heightMm,
    numbers: [leftIndex + 1, rightIndex + 1].sort((a, b) => a - b),
  };
}

/** The files to write, in page order. `firstAlone` pairs the pages as the editor does (見開きごと). */
export function imageSheets(project: Project, options: Pick<ImageOptions, "unit" | "area">, firstAlone: boolean): ImageSheet[] {
  const count = project.pages.length;
  const right = project.binding === "right";
  // [first, second] in reading order: a right-bound book reads the right page first.
  const two = (first: number, second: number) =>
    right ? pair(project, second, first, options.area) : pair(project, first, second, options.area);
  const sheets: ImageSheet[] = [];
  // 縦スクロール: no spreads, each piece a file.
  if (project.scroll || options.unit === "page") {
    for (let index = 0; index < count; index++) sheets.push(single(project, index, options.area));
    return sheets;
  }
  if (options.unit === "spread") {
    for (const [first, second] of spreads(count, firstAlone)) {
      const pages = [first, second].filter((n): n is number => n !== null && n <= count);
      sheets.push(pages.length === 2 ? two(pages[0] - 1, pages[1] - 1) : single(project, pages[0] - 1, options.area));
    }
    return sheets;
  }
  for (let index = 0; index < count; ) {
    if (wantsSpread(project, index)) {
      sheets.push(two(index, index + 1));
      index += 2;
    } else {
      sheets.push(single(project, index, options.area));
      index += 1;
    }
  }
  return sheets;
}

/**
 * px per mm at `dpi`, made smaller where the largest file would be too large
 * to draw (or to be a PSD); the dpi it comes to.
 */
export function imageScale(
  sheets: readonly Pick<ImageSheet, "widthMm" | "heightMm">[],
  dpi: number,
): { scale: number; dpi: number; reduced: boolean } {
  let scale = dpi / 25.4;
  for (const sheet of sheets) {
    const side = Math.max(sheet.widthMm, sheet.heightMm) * scale;
    if (side > IMAGE_MAX_SIDE) scale *= IMAGE_MAX_SIDE / side;
    const pixels = sheet.widthMm * scale * sheet.heightMm * scale;
    if (pixels > IMAGE_MAX_PIXELS) scale *= Math.sqrt(IMAGE_MAX_PIXELS / pixels);
  }
  const reduced = scale < dpi / 25.4 - 1e-9;
  return { scale, dpi: reduced ? Math.floor(scale * 25.4) : dpi, reduced };
}

/** Characters Windows does not take in a file name, and the ends it trims. */
export function fileStem(text: string): string {
  const cleaned = [...text]
    .map((char) => (char < " " || '\\/:*?"<>|'.includes(char) ? "_" : char))
    .join("")
    .trim()
    .replace(/[. ]+$/, "");
  return cleaned || "ネーム";
}

/** The file of `sheet`: `<stem>_007.png`, a 見開き `<stem>_006-007.png` (numbers as wide as the last page's, at least 3). */
export function imageFileName(stem: string, sheet: Pick<ImageSheet, "numbers">, format: ImageFormat, pageCount: number): string {
  const width = Math.max(3, String(pageCount).length);
  const numbers = sheet.numbers.map((n) => String(n).padStart(width, "0")).join("-");
  return `${fileStem(stem)}_${numbers}.${IMAGE_EXTENSIONS[format]}`;
}

const UNIT_NAMES: Record<ImageUnit, string> = { page: "1 ページずつ", spread: "見開きごと", joined: "見開きのページだけつなぐ" };
const FORMAT_NAMES: Record<ImageFormat, string> = { png: "PNG", jpeg: "JPEG", psd: "PSD（レイヤー付き）" };

/** What the image export will make, in a line (before the folder). */
export function imageSummary(project: Project, options: ImageOptions, firstAlone: boolean): string {
  const sheets = imageSheets(project, options, firstAlone);
  const unit = project.scroll ? "区切りごと" : UNIT_NAMES[options.unit];
  const paper = options.format !== "jpeg" && !options.paper ? "・紙は透明" : "";
  return `${sheets.length} 個の ${FORMAT_NAMES[options.format]}（${unit}・${options.dpi} dpi・${options.area === "trim" ? "仕上がりで切る" : "キャンバス全体"}${paper}）`;
}

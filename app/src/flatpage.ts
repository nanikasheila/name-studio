// A page drawn flat, as its reader sees it (no notes, stickies or marks):
// the name sheet's roughs and the pictures of the name under the drawing,
// then the parts in layer order. 読む, the PDF and the ミニネーム draw their
// pages with it, so the three show a page alike.
import { onPageOnly } from "./aside";
import { call } from "./backend";
import { useFonts } from "./fonts";
import { MINI_NUMBER_SIZE, MINI_TITLE_SIZE, miniScale, miniSheet, type MiniFormat, type MiniOptions, type MiniSheet } from "./mininame";
import type { Page, Project, RoughImage } from "./model";
import { LAYER_ORDER, drawPart, encode, mapBox, packBody } from "./nameexport";
import { trimBox } from "./pagebox";
import { loadTips, type MmToPx } from "./pagedraw";
import { decodePicture } from "./pictures";
import { imageOf, isNamePicture, writtenOpacity } from "./references";
import { shownStrokes } from "./roughlayers";
import { useStyle } from "./style";

export type RoughLoader = (rough: RoughImage) => Promise<CanvasImageSource | null>;

/** What pages need from files to be drawn: the name sheet's roughs and the name pictures, decoded. */
export interface FlatPictures {
  roughs: Map<RoughImage, CanvasImageSource | null>;
  names: Map<string, ImageBitmap>;
}

/** The pictures `pages` show, decoded (let go of the name pictures with `releasePictures`). */
export async function flatPictures(project: Project, pages: readonly Page[], rough: RoughLoader): Promise<FlatPictures> {
  const roughs = new Map<RoughImage, CanvasImageSource | null>();
  const names = new Map<string, ImageBitmap>();
  for (const page of pages) {
    for (const item of page.roughs) roughs.set(item, await rough(item));
    for (const reference of page.references ?? []) {
      if (!isNamePicture(reference) || names.has(reference.image)) continue;
      const stored = imageOf(project, reference);
      const picture = stored && (await decodePicture(stored).catch(() => null));
      if (picture) names.set(reference.image, picture);
    }
  }
  return { roughs, names };
}

/** The decoded name pictures let go (the roughs are the loader's to keep). */
export function releasePictures(pictures: FlatPictures): void {
  for (const picture of pictures.names.values()) picture.close();
  pictures.names.clear();
}

/** Page `source` at `m`, flat; the caller clips and lays the paper under it. */
export function drawFlatPage(ctx: CanvasRenderingContext2D, project: Project, source: Page, m: MmToPx, pictures: FlatPictures): void {
  const page = { ...onPageOnly(source, project.pageFormat), strokes: shownStrokes(project, source.strokes) };
  ctx.globalAlpha = 0.45;
  for (const rough of page.roughs) {
    const image = pictures.roughs.get(rough);
    if (!image) continue;
    const [x0, y0, x1, y1] = mapBox(rough.box, m);
    ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0);
  }
  for (const reference of page.references ?? []) {
    const picture = isNamePicture(reference) ? pictures.names.get(reference.image) : undefined;
    if (!picture) continue;
    ctx.globalAlpha = writtenOpacity(reference);
    const [x0, y0, x1, y1] = mapBox(reference.box, m);
    ctx.drawImage(picture, x0, y0, x1 - x0, y1 - y0);
  }
  ctx.globalAlpha = 1;
  for (const kind of LAYER_ORDER) drawPart(ctx, page, kind, m, project.brushes);
}

export interface PdfOptions {
  /** Cut each page at the trim (仕上がり) or keep the whole canvas. */
  area: "trim" | "canvas";
  dpi: number;
}

/** Render every page as JPEG and write one PDF. */
export async function exportPdf(project: Project, path: string, options: PdfOptions, rough: RoughLoader, progress: (message: string) => void): Promise<void> {
  useFonts(project.fonts);
  useStyle(project.style);
  const [w, h] = project.pageFormat.canvasMm;
  const area = options.area === "trim" ? trimBox(project.pageFormat) : [0, 0, w, h];
  const scale = options.dpi / 25.4;
  const width = Math.round((area[2] - area[0]) * scale);
  const height = Math.round((area[3] - area[1]) * scale);
  const m: MmToPx = { scale, x: -area[0] * scale, y: -area[1] * scale };
  await loadTips(project.brushes);
  const drawing = document.createElement("canvas");
  drawing.width = width;
  drawing.height = height;
  const ctx = drawing.getContext("2d")!;
  const images: Uint8Array[] = [];
  for (const [index, page] of project.pages.entries()) {
    progress(`PDF: ${index + 1} / ${project.pages.length} ページ…`);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    const pictures = await flatPictures(project, [page], rough);
    drawFlatPage(ctx, project, page, m, pictures);
    releasePictures(pictures);
    images.push(await encode(drawing, "image/jpeg", 0.88));
  }
  drawing.width = 0;
  const meta = {
    path,
    title: project.title,
    rightToLeft: project.binding === "right",
    scroll: !!project.scroll,
    pages: images.map((jpeg) => ({
      widthMm: area[2] - area[0],
      heightMm: area[3] - area[1],
      widthPx: width,
      heightPx: height,
      length: jpeg.length,
    })),
  };
  await call("write_pdf", packBody(meta, images));
}

const MINI_FONT = '"Yu Gothic UI", "Yu Gothic", "Hiragino Sans", Meiryo, sans-serif';

/**
 * The ミニネーム drawn: every page of `sheet` at `scale` px per mm, its
 * outline, number and the title. The caller lets go of the canvas.
 */
export async function drawMiniSheet(project: Project, sheet: MiniSheet, scale: number, rough: RoughLoader, progress: (message: string) => void): Promise<HTMLCanvasElement> {
  useFonts(project.fonts);
  useStyle(project.style);
  await loadTips(project.brushes);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sheet.widthMm * scale));
  canvas.height = Math.max(1, Math.round(sheet.heightMm * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("ミニネームが大きすぎて描けません。解像度を下げてください");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [i, placed] of sheet.pages.entries()) {
    progress(`ミニネーム: ${i + 1} / ${sheet.pages.length} ページ…`);
    const page = project.pages[placed.index];
    if (!page) continue;
    const [x0, y0, x1, y1] = placed.box.map((mm) => mm * scale);
    const m: MmToPx = { scale, x: x0 - placed.area[0] * scale, y: y0 - placed.area[1] * scale };
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    const pictures = await flatPictures(project, [page], rough);
    drawFlatPage(ctx, project, page, m, pictures);
    releasePictures(pictures);
    ctx.restore();
  }
  // The pages' edges, so that each reads as a page (and is found again when the sheet is taken back in).
  ctx.strokeStyle = "#8a8a8a";
  ctx.lineWidth = Math.max(1, 0.3 * scale);
  for (const { box } of sheet.pages) ctx.strokeRect(box[0] * scale, box[1] * scale, (box[2] - box[0]) * scale, (box[3] - box[1]) * scale);
  ctx.fillStyle = "#555555";
  ctx.textBaseline = "middle";
  ctx.font = `${MINI_NUMBER_SIZE * scale}px ${MINI_FONT}`;
  ctx.textAlign = "center";
  for (const { text, at } of sheet.numbers) ctx.fillText(text, at[0] * scale, at[1] * scale);
  if (sheet.title) {
    ctx.fillStyle = "#222222";
    ctx.font = `${MINI_TITLE_SIZE * scale}px ${MINI_FONT}`;
    ctx.textAlign = sheet.title.at[0] > sheet.widthMm / 2 ? "right" : "left";
    ctx.fillText(sheet.title.text, sheet.title.at[0] * scale, sheet.title.at[1] * scale);
  }
  return canvas;
}

export interface MiniResult {
  widthPx: number;
  heightPx: number;
  /** The dpi it was drawn at (lower than asked when the sheet would be too large). */
  dpi: number;
  reduced: boolean;
  columns: number;
}

/** ミニネーム: every page on one sheet, written as a picture (PNG, JPEG) or a one-page PDF. */
export async function exportMiniName(
  project: Project,
  path: string,
  options: MiniOptions,
  format: MiniFormat,
  firstAlone: boolean,
  rough: RoughLoader,
  progress: (message: string) => void,
): Promise<MiniResult> {
  const sheet = miniSheet(project, options, firstAlone);
  const { scale, dpi, reduced } = miniScale(sheet, options.dpi);
  const canvas = await drawMiniSheet(project, sheet, scale, rough, progress);
  try {
    progress("ミニネーム: ファイルにしています…");
    const result = { widthPx: canvas.width, heightPx: canvas.height, dpi, reduced, columns: sheet.columns };
    if (format === "pdf") {
      const jpeg = await encode(canvas, "image/jpeg", 0.9);
      const meta = {
        path,
        title: project.title,
        rightToLeft: false,
        scroll: true,
        pages: [{ widthMm: sheet.widthMm, heightMm: sheet.heightMm, widthPx: canvas.width, heightPx: canvas.height, length: jpeg.length }],
      };
      await call("write_pdf", packBody(meta, [jpeg]));
    } else {
      const bytes = await encode(canvas, format === "png" ? "image/png" : "image/jpeg", 0.9);
      await call("write_binary_file", packBody({ path }, [bytes]));
    }
    return result;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

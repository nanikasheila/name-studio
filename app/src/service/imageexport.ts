// 画像で書き出す: each page or 見開き of the name as a picture file (PNG, JPEG),
// or as a PSD whose layers follow the CSP export's, for painting tools other
// than CSP. The pages are drawn as 読む・PDF・ミニネーム draw them (flatpage.ts);
// a PSD gets each part on its own layer instead (nameexport.ts's parts).
import { onPageOnly } from "../domain/aside";
import { isBackground } from "../domain/background";
import { useFonts } from "../domain/fonts";
import { IMAGE_EXTENSIONS, imageFileName, imageScale, imageSheets, type ImageOptions, type ImageSheet } from "../domain/imageexport";
import { isNamePicture, writtenOpacity } from "../domain/references";
import { markLayersOf, opacityOfLayer, roughExportNames, roughLayersOf, strokesOn } from "../domain/roughlayers";
import { useStyle } from "../domain/style";
import type { Page, Project, RoughLayer } from "../model/model";
import { call } from "../platform/backend";
import { drawPicture } from "../render/backgrounds";
import { drawMarks, loadTips, type MmToPx } from "../render/pagedraw";
import { drawFlatPage, flatPictures, releasePictures, type FlatPictures, type RoughLoader } from "./flatpage";
import {
  BACKGROUND_LAYER_NAME,
  ExportStopped,
  LAYER_NAMES,
  LAYER_ORDER,
  NAME_PICTURE_LAYER_NAME,
  NOTES_LAYER_NAME,
  ROUGH_LAYERS,
  drawNotes,
  drawPart,
  drawingLayers,
  encode,
  hasNotes,
  layerForm,
  mapBox,
  packBody,
  partCount,
  type LayerKind,
} from "./nameexport";

/** The bottom layer of a PSD: the white paper (hidden when the paper is to be transparent). */
export const PAPER_LAYER_NAME = "用紙";
/** The name sheet's rough image, as the CSP export names its layer. */
const SHEET_ROUGH_NAME = ROUGH_LAYERS[2];
/** How strong the name sheet's rough shows (as on 読む and the PDF). */
const SHEET_ROUGH_OPACITY = 0.45;

export interface ImageExportOptions extends ImageOptions {
  /** 指示 over the pages (each 指示のレイヤー its own PSD layer). */
  marks: boolean;
  /** The memos as a hidden layer of the PSD (not in PNG, JPEG). */
  notes: boolean;
}

export interface ImageResult {
  /** The files written, in page order (full paths). */
  files: string[];
  /** The largest file's size. */
  widthPx: number;
  heightPx: number;
  /** The dpi it was drawn at (lower than asked when a file would be too large). */
  dpi: number;
  reduced: boolean;
}

/** `name` in `folder`, with the folder's own kind of slash. */
export function inFolder(folder: string, name: string): string {
  const slash = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${slash}${name}`;
}

/** The files the export makes, by name (to tell which would be written over). */
export function imageFileNames(project: Project, stem: string, options: ImageOptions, firstAlone: boolean): string[] {
  return imageSheets(project, options, firstAlone).map((sheet) => imageFileName(stem, sheet, options.format, project.pages.length));
}

/** A page of a file with how it is drawn there (px of the file) and the box it keeps to. */
interface Placed {
  page: Page;
  m: MmToPx;
  clip: [number, number, number, number];
}

/**
 * Each page of `sheet` at whole pixels: a 見開き's second page starts on a
 * pixel, so that each half is the page as written alone (not shifted by a
 * part of a pixel).
 */
function placedOf(project: Project, sheet: ImageSheet, scale: number): Placed[] {
  return sheet.pieces.map(({ index, area, box }) => {
    const [x0, y0, x1, y1] = box.map((mm) => Math.round(mm * scale));
    return {
      page: project.pages[index],
      m: { scale, x: x0 - area[0] * scale, y: y0 - area[1] * scale },
      clip: [x0, y0, x1, y1],
    };
  });
}

/** Draws `draw` for each page of a file, kept to that page's box (a 見開き's pages meet at the gutter). */
function eachPage(ctx: CanvasRenderingContext2D, placed: readonly Placed[], draw: (one: Placed) => void): void {
  for (const one of placed) {
    const [x0, y0, x1, y1] = one.clip;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    draw(one);
    ctx.restore();
  }
}

/** A flat picture of `sheet` on `ctx`: the paper (unless transparent), the pages as they are read, the 指示 when asked. */
function drawFlat(
  ctx: CanvasRenderingContext2D,
  project: Project,
  placed: readonly Placed[],
  options: ImageExportOptions,
  pictures: FlatPictures,
) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  if (options.paper || options.format === "jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  eachPage(ctx, placed, ({ page, m }) => {
    drawFlatPage(ctx, project, page, m, pictures);
    if (options.marks) drawMarks(ctx, project, onPageOnly(page, project.pageFormat), m);
  });
}

interface PsdLayerOut {
  name: string;
  opacity: number;
  hidden: boolean;
  png: Uint8Array;
}

/**
 * The layers of a PSD of `sheet`, bottom first, as the CSP export makes
 * them: 用紙, the name sheet's rough, 背景, ネーム画像, then 塗り（線の下）,
 * each ラフ線のレイヤー, コマの塗り・効果, コマ枠, はみ出し, フキダシ, セリフ, and on
 * top the memos (hidden) and each 指示のレイヤー. Layers with nothing on them
 * are left out, but for the first ラフ線, コマ枠, フキダシ and セリフ (to draw on).
 */
async function psdLayers(
  project: Project,
  placed: readonly Placed[],
  options: ImageExportOptions,
  pictures: FlatPictures,
  drawing: HTMLCanvasElement,
): Promise<PsdLayerOut[]> {
  const ctx = drawing.getContext("2d")!;
  const pages = placed.map((one) => ({ ...one, page: onPageOnly(one.page, project.pageFormat) }));
  const layers: PsdLayerOut[] = [];
  /** One layer drawn by `draw` (nothing drawn, `keep` false: left out). */
  const layer = async (
    name: string,
    drawn: boolean,
    draw: (one: Placed) => void,
    look: { opacity?: number; hidden?: boolean; keep?: boolean } = {},
  ) => {
    if (!drawn && !look.keep) return;
    let png: Uint8Array = new Uint8Array();
    if (drawn) {
      ctx.clearRect(0, 0, drawing.width, drawing.height);
      eachPage(ctx, pages, draw);
      png = await encode(drawing, "image/png");
    }
    layers.push({ name, opacity: look.opacity ?? 1, hidden: !!look.hidden, png });
  };
  await layer(
    PAPER_LAYER_NAME,
    true,
    ({ clip }) => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(clip[0], clip[1], clip[2] - clip[0], clip[3] - clip[1]);
    },
    { hidden: !options.paper },
  );
  await layer(
    SHEET_ROUGH_NAME,
    pages.some(({ page }) => page.roughs.some((rough) => pictures.roughs.get(rough))),
    ({ page, m }) => {
      for (const rough of page.roughs) {
        const image = pictures.roughs.get(rough);
        if (!image) continue;
        const [x0, y0, x1, y1] = mapBox(rough.box, m);
        ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0);
      }
    },
    { opacity: SHEET_ROUGH_OPACITY },
  );
  for (const [name, takes] of [
    [BACKGROUND_LAYER_NAME, isBackground] as const,
    [NAME_PICTURE_LAYER_NAME, isNamePicture] as const,
    ...drawingLayers(project).map((layer) => [layer.name, layer.takes] as const),
  ]) {
    await layer(
      name,
      pages.some(({ page }) => page.references?.some((reference) => takes(reference) && pictures.names.has(reference.image))),
      ({ page, m }) => {
        for (const reference of page.references ?? []) {
          const picture = takes(reference) ? pictures.names.get(reference.image) : undefined;
          if (picture) drawPicture(ctx, page, reference, picture, m, writtenOpacity(reference));
        }
      },
    );
  }
  const roughSet = roughLayersOf(project);
  const names = roughExportNames(project, [
    ...Object.values(LAYER_NAMES).filter((name) => name !== LAYER_NAMES.strokes && name !== LAYER_NAMES.overStrokes),
    PAPER_LAYER_NAME,
    SHEET_ROUGH_NAME,
    BACKGROUND_LAYER_NAME,
    NAME_PICTURE_LAYER_NAME,
    NOTES_LAYER_NAME,
  ]);
  const onLayer = (page: Page, rough: RoughLayer): Page => ({ ...page, strokes: strokesOn(project, page.strokes, rough) });
  const kept: LayerKind[] = ["panels", "balloons", "text"];
  for (const kind of LAYER_ORDER) {
    // As image layers: a balloon carries its own paper, so フキダシの塗り has no layer of its own.
    if (layerForm(kind, false, false) === "none") continue;
    if (kind === "strokes" || kind === "overStrokes") {
      for (const rough of roughSet) {
        const own = pages.map((one) => ({ ...one, page: onLayer(one.page, rough) }));
        const name = names.get(rough.id)![kind === "strokes" ? "under" : "over"];
        await layer(
          name,
          own.some(({ page }) => partCount(page, kind)),
          ({ page, m }) => drawPart(ctx, onLayer(page, rough), kind, m, project.brushes),
          { opacity: opacityOfLayer(rough), hidden: !!rough.hidden, keep: kind === "strokes" },
        );
      }
      continue;
    }
    await layer(
      LAYER_NAMES[kind],
      pages.some(({ page }) => partCount(page, kind)),
      ({ page, m }) => drawPart(ctx, page, kind, m, project.brushes),
      { keep: kept.includes(kind) },
    );
  }
  if (options.notes) {
    await layer(
      NOTES_LAYER_NAME,
      pages.some(({ page }) => hasNotes(page)),
      ({ page, m }) => drawNotes(ctx, project, page, m),
      { hidden: true },
    );
  }
  if (options.marks) {
    for (const mark of markLayersOf(project)) {
      const only = { roughLayers: [mark], brushes: project.brushes };
      await layer(
        names.get(mark.id)!.under,
        pages.some(({ page }) => strokesOn(project, page.strokes, mark).length),
        ({ page, m }) => drawMarks(ctx, only, { ...page, strokes: strokesOn(project, page.strokes, mark) }, m, undefined, true),
        { hidden: !!mark.hidden },
      );
    }
  }
  return layers;
}

/**
 * Writes each page (or 見開き) of the name into `folder` as `stem_001.png`
 * and so on: a picture, or a layered PSD. `progress` may throw
 * {@link ExportStopped} to stop before the next file.
 */
export async function exportImages(
  project: Project,
  folder: string,
  stem: string,
  options: ImageExportOptions,
  firstAlone: boolean,
  rough: RoughLoader,
  progress: (message: string) => void,
): Promise<ImageResult> {
  useFonts(project.fonts);
  useStyle(project.style);
  await loadTips(project.brushes);
  const sheets = imageSheets(project, options, firstAlone);
  const { scale, dpi, reduced } = imageScale(sheets, options.dpi);
  const files: string[] = [];
  let widthPx = 0;
  let heightPx = 0;
  const drawing = document.createElement("canvas");
  const what = options.format === "psd" ? "PSD" : IMAGE_EXTENSIONS[options.format].toUpperCase();
  try {
    for (const [i, sheet] of sheets.entries()) {
      try {
        progress(`${what}: ${i + 1} / ${sheets.length} 個目…`);
      } catch (error) {
        if (error instanceof ExportStopped) error.written = files.length;
        throw error;
      }
      const placed = placedOf(project, sheet, scale);
      const width = Math.max(1, ...placed.map(({ clip }) => clip[2]));
      const height = Math.max(1, ...placed.map(({ clip }) => clip[3]));
      widthPx = Math.max(widthPx, width);
      heightPx = Math.max(heightPx, height);
      drawing.width = width;
      drawing.height = height;
      const ctx = drawing.getContext("2d");
      if (!ctx) throw new Error("画像が大きすぎて描けません。解像度を下げてください");
      const pictures = await flatPictures(
        project,
        placed.map(({ page }) => page),
        rough,
      );
      const path = inFolder(folder, imageFileName(stem, sheet, options.format, project.pages.length));
      try {
        if (options.format === "psd") {
          const layers = await psdLayers(project, placed, options, pictures, drawing);
          const meta = {
            path,
            widthPx: width,
            heightPx: height,
            dpi,
            layers: layers.map(({ name, opacity, hidden, png }) => ({ name, opacity, hidden, length: png.length })),
          };
          await call(
            "write_psd",
            packBody(
              meta,
              layers.map(({ png }) => png),
            ),
          );
        } else {
          drawFlat(ctx, project, placed, options, pictures);
          const bytes = await encode(drawing, options.format === "png" ? "image/png" : "image/jpeg", 0.92);
          await call("write_binary_file", packBody({ path }, [bytes]));
        }
      } finally {
        releasePictures(pictures);
      }
      files.push(path);
    }
  } finally {
    drawing.width = 0;
    drawing.height = 0;
  }
  return { files, widthPx, heightPx, dpi, reduced };
}

// CSP の加筆を読み戻す: read the pages written to a folder as CSP has them
// now, and plan what to take back into the name (domain/csptakeback.ts):
// the dialogue, the lines, the panels, and what was drawn on image layers.
// A picture drawn over one of the name's own image layers keeps only what
// the name does not draw there itself.
import { call, type CspExportRequest } from "../platform/backend";
import type { Adoption, CspRaster } from "../generated/ipc";
import {
  type CspLayerNames,
  type CspTakeBack,
  type PageRead,
  type PictureAdd,
  type Place,
  baseName,
  baselineOf,
  planCspTakeBack,
  type Unrecorded,
} from "../domain/csptakeback";
import { base64Of } from "../domain/cspsettings";
import { shapeSignature } from "../domain/linesig";
import type { ReadUnit } from "../domain/readback";
import { markLayersOf, roughLayersOf, strokesOn } from "../domain/roughlayers";
import type { BoxMm, Page, Project, ReferenceImage } from "../model/model";
import { drawMarks, type MmToPx } from "../render/pagedraw";
import { drawPicture } from "../render/backgrounds";
import { decodePicture } from "../render/pictures";
import { imageOf } from "../domain/references";
import {
  FRAME_FOLDER_NAME,
  INK_LAYER_NAME,
  LAYER_NAMES,
  LAYER_ORDER,
  NOTES_LAYER_NAME,
  PICTURE_LAYERS,
  SHEET_ROUGH_NAME,
  drawNotes,
  drawPart,
  encode,
  exportUnits,
  layerNames,
  projectToTemplate,
  shifted,
} from "./nameexport";

/** Pictures taken back are made no larger than this on their long side. */
export const DRAWING_MAX_PX = 3000;
/** Fewer pixels than this left over are taken for noise, not a drawing. */
const MIN_PIXELS = 24;
/** How far round the name's own drawing CSP's pixels count as it (px of the picture). */
const OWN_REACH = 3;

/** The CSP names of the name's layers. */
export function cspLayerNames(project: Project): CspLayerNames {
  const rough = new Map<string, { layer: string; over: boolean }>();
  for (const layer of roughLayersOf(project)) {
    const name = layerNames(project).get(layer.id);
    if (!name) continue;
    rough.set(name.under, { layer: layer.id, over: false });
    rough.set(name.over, { layer: layer.id, over: true });
  }
  return { rough, panels: LAYER_NAMES.panels, frames: FRAME_FOLDER_NAME, own: new Set([LAYER_NAMES.balloons]) };
}

/**
 * For pages written before lines were recorded: the lines of a CSP layer
 * as written, when the layer is as it was then. A layer of the name's own
 * (ラフ線, コマ枠) changed since is skipped: the name may have changed too,
 * and which change is whose cannot be told. Layers made in CSP: none (all
 * their lines were drawn there).
 */
function unrecordedLines(names: CspLayerNames): Unrecorded {
  return (read: PageRead, layer: string) => {
    const record = read.content.record;
    if (record.lines && Object.keys(record.lines).length) return null;
    const csp = read.content.vectors.find((vector) => vector.name === layer);
    const before = record.vectors?.[layer];
    if (csp && before && before === shapeSignature(csp.lines.map((line) => line.points)))
      return csp.lines.map((line) => ({ sig: line.sig }));
    const base = baseName(layer);
    return names.rough.has(base) || base === names.panels || base === names.frames ? "skip" : null;
  };
}

/** Draws what the name itself has on CSP layer `base` (nothing for a layer the name does not write). */
type OwnDrawing = (ctx: CanvasRenderingContext2D, page: Page, m: MmToPx) => void;

async function ownDrawing(project: Project, base: string, pictures: Map<string, ImageBitmap>): Promise<OwnDrawing | null> {
  for (const kind of LAYER_ORDER) {
    if (kind !== "strokes" && kind !== "overStrokes" && LAYER_NAMES[kind] === base)
      return (ctx, page, m) => drawPart(ctx, page, kind, m, project.brushes);
  }
  const names = layerNames(project);
  for (const layer of roughLayersOf(project)) {
    const name = names.get(layer.id);
    if (name && (name.under === base || name.over === base)) {
      const over = name.over === base;
      return (ctx, page, m) =>
        drawPart(ctx, { ...page, strokes: strokesOn(project, page.strokes, layer) }, over ? "overStrokes" : "strokes", m, project.brushes);
    }
  }
  for (const layer of markLayersOf(project)) {
    if (names.get(layer.id)?.under === base)
      return (ctx, page, m) =>
        drawMarks(
          ctx,
          { roughLayers: [layer], brushes: project.brushes },
          { ...page, strokes: strokesOn(project, page.strokes, layer) },
          m,
          undefined,
          true,
        );
  }
  if (base === NOTES_LAYER_NAME) return (ctx, page, m) => drawNotes(ctx, project, page, m);
  const pictureLayer = PICTURE_LAYERS.find((layer) => layer.name === base);
  const takes = pictureLayer ? pictureLayer.takes : (reference: ReferenceImage) => reference.kind === "drawing" && reference.layer === base;
  const used = project.pages.some((page) => page.references?.some(takes));
  if (!pictureLayer && !used) return null;
  for (const page of project.pages) {
    for (const reference of page.references ?? []) {
      if (!takes(reference) || pictures.has(reference.image)) continue;
      const image = imageOf(project, reference);
      const picture = image && (await decodePicture(image).catch(() => null));
      if (picture) pictures.set(reference.image, picture);
    }
  }
  return (ctx, page, m) => {
    for (const reference of page.references ?? []) {
      const picture = takes(reference) ? pictures.get(reference.image) : undefined;
      if (picture) drawPicture(ctx, page, reference, picture, m, 1);
    }
  };
}

/** Names the name's own layers have in CSP: a picture drawn over one goes on a layer of its own. */
function ownLayerNames(project: Project): Set<string> {
  const names = new Set<string>([
    ...Object.values(LAYER_NAMES),
    FRAME_FOLDER_NAME,
    NOTES_LAYER_NAME,
    SHEET_ROUGH_NAME,
    ...PICTURE_LAYERS.map((layer) => layer.name),
  ]);
  for (const name of layerNames(project).values()) {
    names.add(name.under);
    if (name.over) names.add(name.over);
  }
  return names;
}

/** Alpha grown by `reach` px every way (a max filter, rows then columns). */
function grow(alpha: Uint8ClampedArray, width: number, height: number, reach: number): Uint8Array {
  const rows = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let most = 0;
      for (let d = Math.max(0, x - reach); d <= Math.min(width - 1, x + reach); d++) most = Math.max(most, alpha[(y * width + d) * 4 + 3]);
      rows[y * width + x] = most;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let most = 0;
      for (let d = Math.max(0, y - reach); d <= Math.min(height - 1, y + reach); d++) most = Math.max(most, rows[d * width + x]);
      out[y * width + x] = most;
    }
  }
  return out;
}

/**
 * The pictures drawn in CSP on the image layers of `read` since what was
 * recorded: the pixels the name does not draw there itself, cut to what
 * each page of it has.
 */
async function picturesOf(
  project: Project,
  read: PageRead,
  own: Set<string>,
  pictures: Map<string, ImageBitmap>,
  notes: string[],
): Promise<Omit<PictureAdd, "ref">[]> {
  const baseline = baselineOf(project, read.content);
  const found: Omit<PictureAdd, "ref">[] = [];
  const at = `${read.places[0].page + 1}p`;
  for (const raster of read.content.rasters) {
    // As recorded (written, or taken back last time): not drawn on since.
    if (!raster.bbox || baseline.pixels[raster.name] === raster.sig) continue;
    const base = baseName(raster.name);
    if (base === SHEET_ROUGH_NAME) {
      notes.push(`${at}: 「${base}」に CSP で描いたものは読み戻しません（ネーム用紙のラフです）`);
      continue;
    }
    const drawer = base === INK_LAYER_NAME ? null : await ownDrawing(project, base, pictures);
    found.push(...(await cutPicture(project, read, raster, drawer, own.has(base) ? `${base}（CSP）` : base)));
  }
  return found;
}

async function cutPicture(
  project: Project,
  read: PageRead,
  raster: CspRaster,
  drawer: OwnDrawing | null,
  layer: string,
): Promise<Omit<PictureAdd, "ref">[]> {
  const bbox = raster.bbox!;
  const bytes = new Uint8Array(await call("read_csp_layer_image", { path: read.path, id: raster.id, bbox, maxSide: DRAWING_MAX_PX }));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const [width, height] = [bitmap.width, bitmap.height];
  const scale = width / Math.max(1, bbox[2] - bbox[0]);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const drawn = ctx.getImageData(0, 0, width, height);
  // Where the name draws on this layer itself, a little wider.
  let ownAlpha: Uint8Array | null = null;
  if (drawer) {
    const mine = document.createElement("canvas");
    mine.width = width;
    mine.height = height;
    const mctx = mine.getContext("2d", { willReadFrequently: true })!;
    for (const place of read.places) {
      const m: MmToPx = { scale: place.m.scale * scale, x: (place.m.x - bbox[0]) * scale, y: (place.m.y - bbox[1]) * scale };
      drawer(mctx, project.pages[place.page], m);
    }
    ownAlpha = grow(mctx.getImageData(0, 0, width, height).data, width, height, OWN_REACH);
    mine.width = 0;
  }
  const pixels = drawn.data;
  for (let i = 0; i < width * height; i++) {
    if (pixels[i * 4 + 3] <= 16 || (ownAlpha && ownAlpha[i] > 24)) pixels[i * 4 + 3] = 0;
  }
  // Each page of a 見開き page keeps its side of the gutter.
  const cut = read.gutterPx === null ? null : (read.gutterPx - bbox[0]) * scale;
  const result: Omit<PictureAdd, "ref">[] = [];
  for (const place of read.places) {
    const [from, to] =
      cut === null ? [0, width] : place.right ? [Math.max(0, Math.ceil(cut)), width] : [0, Math.min(width, Math.floor(cut))];
    let [x0, y0, x1, y1, count] = [width, height, -1, -1, 0];
    for (let y = 0; y < height; y++) {
      for (let x = from; x < to; x++) {
        if (!pixels[(y * width + x) * 4 + 3]) continue;
        count++;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    if (count < MIN_PIXELS) continue;
    const [w, h] = [x1 - x0 + 1, y1 - y0 + 1];
    const piece = document.createElement("canvas");
    piece.width = w;
    piece.height = h;
    const pctx = piece.getContext("2d")!;
    const part = new ImageData(w, h);
    for (let y = 0; y < h; y++) part.data.set(pixels.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * w * 4);
    pctx.putImageData(part, 0, 0);
    const png = await encode(piece, "image/png");
    piece.width = 0;
    // Back to the page: picture px → canvas px → mm.
    const toMm = (px: number, py: number): [number, number] => [
      (bbox[0] + px / scale - place.m.x) / place.m.scale,
      (bbox[1] + py / scale - place.m.y) / place.m.scale,
    ];
    const [bx0, by0] = toMm(x0, y0);
    const [bx1, by1] = toMm(x1 + 1, y1 + 1);
    const box: BoxMm = [bx0, by0, bx1, by1];
    result.push({
      page: place.page,
      cspLayer: baseName(raster.name),
      layer,
      box,
      image: {
        name: `CSP「${baseName(raster.name)}」${place.page + 1}p`,
        mime: "image/png",
        dataBase64: base64Of(png),
        widthPx: w,
        heightPx: h,
      },
      ...(raster.opacity < 0.999 && !raster.draft ? { opacity: raster.opacity } : {}),
      ...(raster.visible ? {} : { hidden: true }),
    });
  }
  canvas.width = 0;
  return result;
}

/** What reading the pages back found: the dialogue (domain/readback.ts) and the rest. */
export interface CspReadBack {
  units: ReadUnit[];
  plan: CspTakeBack;
}

/**
 * Read the pages written to `request.outDir` back as CSP has them now, and
 * plan what to take back into the name (nothing is changed yet).
 */
export async function readCspBack(project: Project, request: CspExportRequest, progress: (message: string) => void): Promise<CspReadBack> {
  const start = await call("begin_name_export", { request: { ...request, frameFolders: false } });
  const reads: PageRead[] = [];
  const units: ReadUnit[] = [];
  try {
    const full = projectToTemplate(project, start);
    const { units: pages } = exportUnits(project, start.firstPageLeft, start.spread ? null : start.spreadProblem);
    for (const [index, unit] of pages.entries()) {
      progress(`${index + 1} / ${pages.length} ページを読み中…`);
      const spread = unit.length > 1 && start.spread ? start.spread : null;
      const places = unit.map((page, position) => {
        const right = (position === 0) === (project.binding === "right");
        return { page, m: shifted(full, spread ? (right ? spread.rightDx : spread.leftDx) : 0) as Place, right };
      });
      const page = await call("read_name_page", { spread: spread !== null });
      const dialogue = page.content?.dialogue;
      units.push({
        pages: unit,
        path: page.path,
        found: !!page.content,
        written: dialogue?.written ?? null,
        adoptedFrom: dialogue?.adoptedFrom ?? null,
        texts: (dialogue?.texts ?? []).map(({ text, bbox }) => {
          const x = bbox ? (bbox[0] + bbox[2]) / 2 : 0;
          const on = (spread && places.find(({ right }) => x >= spread.gutterPx === right)) || places[0];
          const box = bbox ? (bbox.map((v, i) => (v - (i % 2 ? on.m.y : on.m.x)) / on.m.scale) as BoxMm) : null;
          return { text, page: on.page, box };
        }),
      });
      if (page.content) reads.push({ path: page.path, places, gutterPx: spread ? spread.gutterPx : null, content: page.content });
    }
  } finally {
    await call("cancel_name_export").catch(() => undefined);
  }
  const names = cspLayerNames(project);
  const plan = planCspTakeBack(project, reads, names, unrecordedLines(names));
  const own = ownLayerNames(project);
  const pictures = new Map<string, ImageBitmap>();
  let refs = 0;
  for (const [index, read] of reads.entries()) {
    progress(`${index + 1} / ${reads.length} ページの絵を確かめ中…`);
    for (const picture of await picturesOf(project, read, own, pictures, plan.notes)) plan.pictures.push({ ...picture, ref: `d${refs++}` });
  }
  for (const picture of pictures.values()) picture.close();
  return { units, plan };
}

/** Record what was taken back, so the next reading starts from there. */
export async function adoptCspPages(pages: { path: string; adoption: Adoption }[]): Promise<void> {
  await call("adopt_csp_pages", { pages: pages.map(({ path, adoption }) => [path, adoption]) });
}

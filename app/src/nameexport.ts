// Writing the name data out: CSP pages (a layer per kind of part, editable
// vector lines and texts where CSP-made layers to copy are found, plus the
// work .cmc), a PDF to read or share, and the script as text.
import { invoke } from "@tauri-apps/api/core";
import {
  BALLOON_LINE_MM,
  INK,
  PANEL_LINE_MM,
  drawBalloon,
  drawLineText,
  drawPanel,
  drawStroke,
  type MmToPx,
} from "./pagedraw";
import { KIND_LABELS, basicBox, trimBox, type Page, type Project, type RoughImage } from "./project";
import { sceneSpans } from "./story";

/** The template page as `begin_name_export` reports it (clip-core `TemplateCanvas`). */
export interface TemplateCanvas {
  widthPx: number;
  heightPx: number;
  resolution: number;
  trimPx: [number, number, number, number] | null;
  basicPx: [number, number, number, number] | null;
}

/** `begin_name_export`: the canvas, and which parts can be editable layers. */
export interface NameExportStart extends TemplateCanvas {
  vectorLayers: boolean;
  textLayers: boolean;
}

/** Bigger page images are drawn smaller and scaled up on the Rust side. */
const MAX_LAYER_PIXELS = 40_000_000;
/** Width of the image drawn over the page thumbnail. */
const OVERLAY_WIDTH = 1200;

/**
 * Where the name's page lands on the template page: its basic frame onto the
 * template's basic frame (same as the sheet export's default), or canvas
 * onto canvas when the template has none. Uniform scale, centred.
 */
export function projectToTemplate(project: Project, canvas: TemplateCanvas): MmToPx {
  const fit = (from: number[], to: number[]): MmToPx => {
    const scale = Math.min((to[2] - to[0]) / (from[2] - from[0]), (to[3] - to[1]) / (from[3] - from[1]));
    return {
      scale,
      x: (to[0] + to[2]) / 2 - ((from[0] + from[2]) / 2) * scale,
      y: (to[1] + to[3]) / 2 - ((from[1] + from[3]) / 2) * scale,
    };
  };
  if (canvas.basicPx) return fit(basicBox(project.pageFormat), canvas.basicPx);
  const [w, h] = project.pageFormat.canvasMm;
  return fit([0, 0, w, h], [0, 0, canvas.widthPx, canvas.heightPx]);
}

export function scaled(m: MmToPx, factor: number): MmToPx {
  return { scale: m.scale * factor, x: m.x * factor, y: m.y * factor };
}

export function mapBox([x0, y0, x1, y1]: number[], m: MmToPx): [number, number, number, number] {
  return [x0 * m.scale + m.x, y0 * m.scale + m.y, x1 * m.scale + m.x, y1 * m.scale + m.y];
}

export type LayerKind = "strokes" | "panels" | "balloons" | "text";

export const LAYER_NAMES: Record<LayerKind, string> = {
  strokes: "ラフ線",
  panels: "コマ枠",
  balloons: "フキダシ",
  text: "セリフ",
};

export function partCount(page: Page, kind: LayerKind): number {
  if (kind === "strokes") return page.strokes.length;
  if (kind === "panels") return page.panels.length;
  if (kind === "balloons") return page.lines.filter((line) => line.balloon).length;
  return page.lines.filter((line) => line.text.trim()).length;
}

/** Draw one kind of part of a page (transparent elsewhere). */
export function drawPart(ctx: CanvasRenderingContext2D, page: Page, kind: LayerKind, m: MmToPx): void {
  switch (kind) {
    case "strokes":
      for (const stroke of page.strokes) drawStroke(ctx, stroke, m, "#3a3834", 1);
      break;
    case "panels":
      for (const panel of page.panels) drawPanel(ctx, panel, m, INK, 1);
      break;
    case "balloons":
      for (const line of page.lines) drawBalloon(ctx, line, m, 1);
      break;
    case "text":
      for (const line of page.lines) drawLineText(ctx, line, m);
      break;
  }
}

/** A CSP vector line in template px; points are `[x, y, width factor]`. */
export interface VectorLineMeta {
  points: [number, number, number][];
  closed: boolean;
  widthPx: number;
}

/** One layer of a page as `export_name_page` takes it, bottom first. */
export type LayerMeta =
  | { kind: "raster"; name: string; length: number }
  | { kind: "vector"; name: string; lines: VectorLineMeta[] }
  | { kind: "text"; text: string; frame: [number, number, number, number]; fontSizePt: number; vertical: boolean };

export type LinePartKind = Exclude<LayerKind, "text">;

/** One kind of line part of a page as vector lines (`m`: mm → template px). */
export function vectorLines(page: Page, kind: LinePartKind, m: MmToPx): VectorLineMeta[] {
  const map = (points: readonly (readonly number[])[], width: (point: readonly number[]) => number) =>
    points.map((point): [number, number, number] => [point[0] * m.scale + m.x, point[1] * m.scale + m.y, width(point)]);
  switch (kind) {
    case "strokes":
      // Same light-pressure thinning as drawStroke.
      return page.strokes.map((stroke) => ({
        points: map(stroke.points, (point) => 0.35 + 0.65 * point[2]),
        closed: stroke.closed,
        widthPx: stroke.widthMm * m.scale,
      }));
    case "panels":
      return page.panels.map((panel) => ({
        points: map(panel.shape, () => 1),
        closed: true,
        widthPx: PANEL_LINE_MM * m.scale,
      }));
    case "balloons":
      return page.lines
        .filter((line) => line.balloon && line.balloon.length >= 3)
        .map((line) => ({ points: map(line.balloon!, () => 1), closed: true, widthPx: BALLOON_LINE_MM * m.scale }));
  }
}

/**
 * Each line of dialogue as a CSP text layer: its box in template px and its
 * size in CSP pt (pt of the template's resolution). CSP wraps text at the
 * frame, so the frame gets room to grow along the text (down for vertical,
 * right for horizontal), where its own font runs longer than ours.
 */
export function textLayers(page: Page, m: MmToPx, resolution: number): LayerMeta[] {
  return page.lines
    .filter((line) => line.text.trim())
    .map((line) => {
      const [x0, y0, x1, y1] = mapBox(line.box, m);
      const frame: [number, number, number, number] = line.vertical
        ? [x0, y0, x1, y1 + (y1 - y0) * 0.25]
        : [x0, y0, x1 + (x1 - x0) * 0.25, y1];
      return {
        kind: "text",
        text: line.text,
        frame,
        fontSizePt: (line.fontSizePt * m.scale * 25.4) / resolution,
        vertical: line.vertical,
      };
    });
}

/** `[u32 JSON length][JSON][parts...]`, the raw request body the Rust side splits. */
export function packBody(meta: unknown, parts: Uint8Array[]): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const total = 4 + json.length + parts.reduce((sum, part) => sum + part.length, 0);
  const body = new Uint8Array(total);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  let offset = 4 + json.length;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}

async function encode(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg", quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new Error("画像を作れませんでした（ページが大きすぎる可能性があります）");
  return new Uint8Array(await blob.arrayBuffer());
}

export interface CspExportRequest {
  template: string;
  outDir: string;
  workTemplate: string | null;
  workName: string | null;
  storyIndex: number | null;
  inputs: string[];
  /** .clip files (the name sheet) to copy CSP's vector / text layers from. */
  donors: string[];
}

export interface CspExportReport {
  pages: string[];
  work: string | null;
  /** Which parts were written as editable vector / text layers. */
  vectorLayers: boolean;
  textLayers: boolean;
}

/**
 * Write every page as a .clip, then the work. With `editable`, lines go as
 * vector layers and dialogue as text layers when the template or the name
 * sheet has such a CSP-made layer to copy; otherwise each kind of part is
 * one image layer.
 */
export async function exportToCsp(
  project: Project,
  request: CspExportRequest,
  editable: boolean,
  progress: (message: string) => void,
): Promise<CspExportReport> {
  const start = await invoke<NameExportStart>("begin_name_export", { request });
  const vector = editable && start.vectorLayers;
  const text = editable && start.textLayers;
  try {
    const full = projectToTemplate(project, start);
    const factor = Math.min(1, Math.sqrt(MAX_LAYER_PIXELS / (start.widthPx * start.heightPx)));
    const width = Math.round(start.widthPx * factor);
    const height = Math.round(start.heightPx * factor);
    const m = scaled(full, factor);
    const drawing = document.createElement("canvas");
    drawing.width = width;
    drawing.height = height;
    const ctx = drawing.getContext("2d")!;
    const overlay = document.createElement("canvas");
    overlay.width = Math.min(OVERLAY_WIDTH, start.widthPx);
    overlay.height = Math.round((start.heightPx * overlay.width) / start.widthPx);
    const small = scaled(full, overlay.width / start.widthPx);
    const overlayCtx = overlay.getContext("2d")!;
    for (const [index, page] of project.pages.entries()) {
      progress(`${index + 1} / ${project.pages.length} ページを書き出し中…`);
      const layers: LayerMeta[] = [];
      const pngs: Uint8Array[] = [];
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      for (const kind of ["strokes", "panels", "balloons", "text"] as LayerKind[]) {
        if (kind === "text" ? text : vector) {
          if (kind === "text") layers.push(...textLayers(page, full, start.resolution));
          else layers.push({ kind: "vector", name: LAYER_NAMES[kind], lines: vectorLines(page, kind, full) });
          // CSP draws these itself when the page is opened; the thumbnail does not.
          drawPart(overlayCtx, page, kind, small);
          continue;
        }
        // An empty part goes as no bytes; the Rust side makes it a blank layer.
        let png: Uint8Array = new Uint8Array();
        if (partCount(page, kind)) {
          ctx.clearRect(0, 0, width, height);
          drawPart(ctx, page, kind, m);
          png = await encode(drawing, "image/png");
        }
        layers.push({ kind: "raster", name: LAYER_NAMES[kind], length: png.length });
        pngs.push(png);
      }
      const overlayPng = vector || text ? await encode(overlay, "image/png") : new Uint8Array();
      const roughs = page.roughs.map((rough: RoughImage) => ({
        layerId: rough.layerId,
        sheetCrop: rough.sheetCrop,
        target: mapBox(rough.box, full),
      }));
      const meta = {
        layers,
        sheet: project.source?.path ?? null,
        roughs: project.source ? roughs : [],
        overlayLength: overlayPng.length,
      };
      await invoke("export_name_page", packBody(meta, [...pngs, overlayPng]));
    }
    drawing.width = 0;
    overlay.width = 0;
    const report = await invoke<{ pages: string[]; work: string | null }>("finish_name_export");
    return { ...report, vectorLayers: vector, textLayers: text };
  } catch (error) {
    await invoke("cancel_name_export").catch(() => undefined);
    throw error;
  }
}

export interface PdfOptions {
  /** Cut each page at the trim (仕上がり) or keep the whole canvas. */
  area: "trim" | "canvas";
  dpi: number;
}

/** Render every page (with the roughs) as JPEG and write one PDF. */
export async function exportPdf(
  project: Project,
  path: string,
  options: PdfOptions,
  rough: (rough: RoughImage) => Promise<CanvasImageSource | null>,
  progress: (message: string) => void,
): Promise<void> {
  const [w, h] = project.pageFormat.canvasMm;
  const area = options.area === "trim" ? trimBox(project.pageFormat) : [0, 0, w, h];
  const scale = options.dpi / 25.4;
  const width = Math.round((area[2] - area[0]) * scale);
  const height = Math.round((area[3] - area[1]) * scale);
  const m: MmToPx = { scale, x: -area[0] * scale, y: -area[1] * scale };
  const drawing = document.createElement("canvas");
  drawing.width = width;
  drawing.height = height;
  const ctx = drawing.getContext("2d")!;
  const images: Uint8Array[] = [];
  for (const [index, page] of project.pages.entries()) {
    progress(`PDF: ${index + 1} / ${project.pages.length} ページ…`);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 0.45;
    for (const item of page.roughs) {
      const image = await rough(item);
      if (!image) continue;
      const [x0, y0, x1, y1] = mapBox(item.box, m);
      ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.globalAlpha = 1;
    for (const kind of ["strokes", "panels", "balloons", "text"] as LayerKind[]) drawPart(ctx, page, kind, m);
    images.push(await encode(drawing, "image/jpeg", 0.88));
  }
  drawing.width = 0;
  const meta = {
    path,
    title: project.title,
    rightToLeft: project.binding === "right",
    pages: images.map((jpeg) => ({
      widthMm: area[2] - area[0],
      heightMm: area[3] - area[1],
      widthPx: width,
      heightPx: height,
      length: jpeg.length,
    })),
  };
  await invoke("write_pdf", packBody(meta, images));
}

/** The dialogue as a script: page by page, panel by panel, with speakers. */
export function scriptText(project: Project): string {
  const names = new Map(project.characters.map((character) => [character.id, character.name]));
  const spans = sceneSpans(project);
  const story = project.storyIndex !== undefined ? ` 第${project.storyIndex}話` : "";
  const out: string[] = [`${project.title}${story}`, ""];
  project.pages.forEach((page, index) => {
    const scene = spans.find((span) => span.first === index);
    if (scene) out.push(`◆ ${scene.scene.title}${scene.scene.storyTime ? `（${scene.scene.storyTime}）` : ""}`, "");
    out.push(`■ ${index + 1} ページ${page.memo ? `　${page.memo.split("\n")[0]}` : ""}`);
    const order = new Map(page.panels.map((panel) => [panel.id, panel.order]));
    let lastPanel: number | undefined;
    for (const line of page.lines) {
      const panel = line.panel ? order.get(line.panel) : undefined;
      if (panel !== undefined && panel !== lastPanel) out.push(`  ［${panel}］`);
      lastPanel = panel;
      const text = line.text.replace(/\s*\n\s*/g, "　").trim();
      const who = names.get(line.speaker ?? "") ?? "";
      const said =
        line.kind === "narration"
          ? `${KIND_LABELS.narration}：${text}`
          : line.kind === "sfx"
            ? `${KIND_LABELS.sfx}：${text}`
            : line.kind === "thought"
              ? `${who}（${text}）`
              : `${who}「${text}」`;
      out.push(`    ${said}`);
    }
    out.push("");
  });
  return out.join("\n");
}

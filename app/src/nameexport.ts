// Writing the name data out: CSP pages (one raster layer per kind of part,
// plus the work .cmc), a PDF to read or share, and the script as text.
import { invoke } from "@tauri-apps/api/core";
import { INK, drawBalloon, drawLineText, drawPanel, drawStroke, type MmToPx } from "./pagedraw";
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

/** Bigger page images are drawn smaller and scaled up on the Rust side. */
const MAX_LAYER_PIXELS = 40_000_000;

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
}

export interface CspExportReport {
  pages: string[];
  work: string | null;
}

/** Write every page as a .clip with one layer per kind of part, then the work. */
export async function exportToCsp(
  project: Project,
  request: CspExportRequest,
  progress: (message: string) => void,
): Promise<CspExportReport> {
  const canvas = await invoke<TemplateCanvas>("begin_name_export", { request });
  try {
    const full = projectToTemplate(project, canvas);
    const factor = Math.min(1, Math.sqrt(MAX_LAYER_PIXELS / (canvas.widthPx * canvas.heightPx)));
    const width = Math.round(canvas.widthPx * factor);
    const height = Math.round(canvas.heightPx * factor);
    const m = scaled(full, factor);
    const drawing = document.createElement("canvas");
    drawing.width = width;
    drawing.height = height;
    const ctx = drawing.getContext("2d")!;
    for (const [index, page] of project.pages.entries()) {
      progress(`${index + 1} / ${project.pages.length} ページを書き出し中…`);
      const layers: [string, Uint8Array][] = [];
      for (const kind of ["strokes", "panels", "balloons", "text"] as LayerKind[]) {
        // An empty part goes as no bytes; the Rust side makes it a blank layer.
        if (!partCount(page, kind)) {
          layers.push([LAYER_NAMES[kind], new Uint8Array()]);
          continue;
        }
        ctx.clearRect(0, 0, width, height);
        drawPart(ctx, page, kind, m);
        layers.push([LAYER_NAMES[kind], await encode(drawing, "image/png")]);
      }
      const roughs = page.roughs.map((rough: RoughImage) => ({
        layerId: rough.layerId,
        sheetCrop: rough.sheetCrop,
        target: mapBox(rough.box, full),
      }));
      const meta = {
        layers: layers.map(([name, png]) => [name, png.length]),
        sheet: project.source?.path ?? null,
        roughs: project.source ? roughs : [],
      };
      await invoke("export_name_page", packBody(meta, layers.map(([, png]) => png)));
    }
    drawing.width = 0;
    return await invoke<CspExportReport>("finish_name_export");
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

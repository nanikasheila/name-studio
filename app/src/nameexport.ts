// Writing the name data out: CSP pages (a layer per kind of part, editable
// vector lines and texts where CSP-made layers to copy are found, plus the
// work .cmc), a PDF to read or share, and the script as text.
import { invoke } from "@tauri-apps/api/core";
import { pageBalloons } from "./balloon";
import { widthFactors } from "./brush";
import { borderLines, borderWidthMm, dashes } from "./koma";
import {
  BALLOON_LINE_MM,
  drawBalloonFills,
  drawBalloons,
  drawLineText,
  drawPanelBorders,
  drawPanelFills,
  drawStrokes,
  loadTips,
  type MmToPx,
} from "./pagedraw";
import {
  KIND_LABELS,
  MM_PER_PT,
  basicBox,
  splitAtX,
  trimBox,
  type Brush,
  type Page,
  type Project,
  type RoughImage,
  type StrokePoint,
  wantsSpread,
} from "./project";
import { sceneSpans } from "./story";

/** The template page as `begin_name_export` reports it (clip-core `TemplateCanvas`). */
export interface TemplateCanvas {
  widthPx: number;
  heightPx: number;
  resolution: number;
  trimPx: [number, number, number, number] | null;
  basicPx: [number, number, number, number] | null;
}

/** Where pages go on a CSP 見開き page (clip-core `SpreadLayout`), in template px. */
export interface SpreadLayout {
  widthPx: number;
  heightPx: number;
  gutterPx: number;
  leftDx: number;
  rightDx: number;
}

/** `begin_name_export`: the canvas, and which parts can be editable layers. */
export interface NameExportStart extends TemplateCanvas {
  vectorLayers: boolean;
  textLayers: boolean;
  /** Whether the book's first page is a left page (from the template); null when unknown. */
  firstPageLeft: boolean | null;
  spread: SpreadLayout | null;
  /** Why 見開き pages cannot be written, when they cannot. */
  spreadProblem: string | null;
}

/**
 * The CSP pages to write, each one name page or two (a 見開き, right page
 * first for a right-bound book). CSP pairs pages by side: a spread starts
 * on the side that comes first in the book (the right page of a manga), as
 * the template's own page tells; other pairs are written as single pages.
 */
export function exportUnits(
  project: Project,
  firstPageLeft: boolean | null,
  spreadProblem: string | null = null,
): { units: number[][]; warnings: string[] } {
  const units: number[][] = [];
  const warnings: string[] = [];
  const zeroLeft = firstPageLeft ?? project.binding === "right";
  const isLeft = (index: number) => zeroLeft === (index % 2 === 0);
  for (let index = 0; index < project.pages.length; ) {
    if (wantsSpread(project, index)) {
      const startsSpread = project.binding === "right" ? !isLeft(index) : isLeft(index);
      if (spreadProblem) {
        warnings.push(`${index + 1}–${index + 2} ページを見開きにできませんでした（${spreadProblem}）。別々のページにしました`);
      } else if (!startsSpread) {
        warnings.push(
          `${index + 1}–${index + 2} ページは CSP では見開きにならない並びです（${index + 1} ページが${isLeft(index) ? "左" : "右"}ページ）。別々のページにしました`,
        );
      } else {
        units.push([index, index + 1]);
        index += 2;
        continue;
      }
    }
    units.push([index]);
    index += 1;
  }
  return { units, warnings };
}

function shifted(m: MmToPx, dx: number): MmToPx {
  return { ...m, x: m.x + dx };
}

/**
 * Vector lines cut at the gutter `x`, keeping one page's side (`right`): on
 * a spread each page ends at its trim, as the editor shows it.
 */
export function clipLines(lines: VectorLineMeta[], x: number, right: boolean): VectorLineMeta[] {
  return lines.flatMap((line) => {
    const inside = (point: readonly number[]) => (right ? point[0] >= x : point[0] <= x);
    if (line.points.every(inside)) return [line];
    const points = line.closed ? [...line.points, line.points[0]] : line.points;
    return splitAtX(points as StrokePoint[], x)
      .filter((run) => run.beyond === right)
      .map((run) => ({ ...line, closed: false, points: run.points as [number, number, number][] }));
  });
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

export type LayerKind = "strokes" | "fills" | "panels" | "overStrokes" | "balloonFills" | "balloons" | "text";

/** Layers of a page, bottom first. */
export const LAYER_ORDER: LayerKind[] = ["strokes", "fills", "panels", "overStrokes", "balloonFills", "balloons", "text"];

export const LAYER_NAMES: Record<LayerKind, string> = {
  strokes: "ラフ線",
  fills: "コマの塗り・効果",
  panels: "コマ枠",
  overStrokes: "はみ出し（ラフ線）",
  balloonFills: "フキダシの塗り",
  balloons: "フキダシ",
  text: "セリフ",
};

export function partCount(page: Page, kind: LayerKind): number {
  switch (kind) {
    case "strokes":
      return page.strokes.filter((stroke) => !stroke.over).length;
    case "overStrokes":
      return page.strokes.filter((stroke) => stroke.over).length;
    case "fills":
      return (
        page.panels.filter((panel) => (panel.fill ?? "none") !== "none" || (panel.effect ?? "none") !== "none").length +
        (page.breakouts ?? []).length
      );
    case "panels":
      return page.panels.length;
    case "balloonFills":
    case "balloons":
      return pageBalloons(page).length;
    case "text":
      return page.lines.filter((line) => line.text.trim()).length;
  }
}

/** Parts CSP can hold as vector lines; fills and effects are always an image. */
export function canBeVector(kind: LayerKind): kind is LinePartKind {
  return kind !== "text" && kind !== "fills" && kind !== "balloonFills";
}

/** Draw one kind of part of a page (transparent elsewhere). */
export function drawPart(ctx: CanvasRenderingContext2D, page: Page, kind: LayerKind, m: MmToPx, brushes: Brush[] = []): void {
  switch (kind) {
    case "strokes":
    case "overStrokes":
      drawStrokes(ctx, page, m, kind === "overStrokes", () => "#3a3834", 1, brushes);
      break;
    case "fills":
      drawPanelFills(ctx, page, m, 1);
      break;
    case "panels":
      drawPanelBorders(ctx, page, m, undefined, 1);
      break;
    case "balloonFills":
      drawBalloonFills(ctx, page, m);
      break;
    case "balloons":
      drawBalloons(ctx, page, m, 1);
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
  | {
      kind: "text";
      text: string;
      frame: [number, number, number, number];
      fontSizePt: number;
      vertical: boolean;
      /** 8-bit RGB; absent keeps the template text's colour. */
      color?: [number, number, number];
    };

export type LinePartKind = Exclude<LayerKind, "text" | "fills" | "balloonFills">;

/** One kind of line part of a page as vector lines (`m`: mm → template px). */
export function vectorLines(page: Page, kind: LinePartKind, m: MmToPx, brushes: Brush[] = []): VectorLineMeta[] {
  const map = (points: readonly (readonly number[])[], width: (point: readonly number[], index: number) => number) =>
    points.map((point, index): [number, number, number] => [point[0] * m.scale + m.x, point[1] * m.scale + m.y, width(point, index)]);
  switch (kind) {
    case "strokes":
    case "overStrokes":
      // Same widths as drawStroke: pressure (through the brush's curve) and 入り抜き.
      return page.strokes
        .filter((stroke) => !!stroke.over === (kind === "overStrokes"))
        .map((stroke) => {
          const factors = widthFactors(stroke, brushes.find((brush) => brush.id === stroke.brush));
          return {
            points: map(stroke.points, (_, i) => factors[i]),
            closed: stroke.closed,
            widthPx: stroke.widthMm * m.scale,
          };
        });
    case "panels":
      return borderLines(page).flatMap((line) => {
        const parts = line.panel.border === "dashed" ? dashes(line.points, line.closed).map((points) => ({ points, closed: false })) : [line];
        return parts.map((part) => ({ points: map(part.points, () => 1), closed: part.closed, widthPx: borderWidthMm(line.panel) * m.scale }));
      });
    case "balloons":
      return pageBalloons(page).flatMap((balloon) => {
        const widthPx = BALLOON_LINE_MM * m.scale;
        const outline = balloon.outline.length >= 3 ? [{ points: map(balloon.outline, () => 1), closed: true, widthPx }] : [];
        const extras = balloon.extras.map((extra) => ({ points: map(extra.points, () => 1), closed: extra.closed, widthPx }));
        return [...outline, ...extras];
      });
  }
}

/** Room CSP's lines take: its line pitch and character advance, generously. */
const CSP_LINE_PITCH = 1.8;
const CSP_CHAR_ADVANCE = 1.1;

/**
 * Each line of dialogue as a CSP text layer: its box in template px and its
 * size in CSP pt (pt of the template's resolution). CSP hides what does not
 * fit its frame, so the frame grows away from where the text starts (down
 * and left for vertical, down and right for horizontal) to hold every line
 * at CSP's own spacing, never smaller than the box.
 */
export function textLayers(page: Page, m: MmToPx, resolution: number): LayerMeta[] {
  return page.lines
    .filter((line) => line.text.trim())
    .map((line) => {
      const [x0, y0, x1, y1] = mapBox(line.box, m);
      const size = line.fontSizePt * MM_PER_PT * m.scale;
      const lines = line.text.split(/\r?\n/);
      const across = lines.length * size * CSP_LINE_PITCH;
      const along = Math.max(...lines.map((text) => [...text].length)) * size * CSP_CHAR_ADVANCE;
      const frame: [number, number, number, number] = line.vertical
        ? [Math.min(x0, x1 - across), y0, x1, Math.max(y1, y0 + along)]
        : [x0, y0, Math.max(x1, x0 + along), Math.max(y1, y0 + across)];
      return {
        kind: "text",
        text: line.text,
        frame,
        fontSizePt: (line.fontSizePt * m.scale * 25.4) / resolution,
        vertical: line.vertical,
        ...(line.inverted ? { color: [255, 255, 255] as [number, number, number] } : {}),
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

/** A written file read back (clip-core `verify::FileCheck`). */
export interface FileCheck {
  path: string;
  /** The name pages (1-based) in this file: two for a 見開き page. */
  pages?: number[];
  /** Empty when the file holds what was written. */
  problems: string[];
  layers: number;
  vectorLines: number;
  texts: number;
}

export interface CspExportReport {
  pages: string[];
  work: string | null;
  /** Which parts were written as editable vector / text layers. */
  vectorLayers: boolean;
  textLayers: boolean;
  /** 自己確認 of each page, in page order. */
  checks: FileCheck[];
  workCheck: FileCheck | null;
  /** Pages that could not go as they were asked to (a 見開き written as two pages). */
  warnings?: string[];
  /** How many 見開き pages were written. */
  spreads?: number;
}

/** The self-check in a few lines: all fine, or what is wrong where. */
export function checkSummary(report: Pick<CspExportReport, "checks" | "workCheck">): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  for (const [index, check] of report.checks.entries()) {
    const where = check.pages ? (check.pages.length > 1 ? `${check.pages.join("–")} ページ（見開き）` : `${check.pages[0]} ページ`) : `${index + 1} ページ`;
    for (const problem of check.problems) lines.push(`${where}: ${problem}`);
  }
  for (const problem of report.workCheck?.problems ?? []) lines.push(`作品: ${problem}`);
  if (lines.length) return { ok: false, lines: [`自己確認で ${lines.length} 件の問題が見つかりました:`, ...lines] };
  const vectors = report.checks.reduce((sum, check) => sum + check.vectorLines, 0);
  const texts = report.checks.reduce((sum, check) => sum + check.texts, 0);
  const work = report.workCheck ? "、作品のページの並び" : "";
  return {
    ok: true,
    lines: [`自己確認 OK: ${report.checks.length} ページを読み直し、レイヤー・ベクター線 ${vectors} 本・テキスト ${texts} 個${work}が書いたとおりでした`],
  };
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
  await loadTips(project.brushes);
  const start = await invoke<NameExportStart>("begin_name_export", { request });
  const vector = editable && start.vectorLayers;
  const text = editable && start.textLayers;
  try {
    const full = projectToTemplate(project, start);
    const { units, warnings } = exportUnits(project, start.firstPageLeft, start.spread ? null : start.spreadProblem);
    const checks: FileCheck[] = [];
    // One drawing canvas for the widest page; each page is drawn at its own size.
    const widest = Math.max(start.widthPx, ...(units.some((unit) => unit.length > 1) && start.spread ? [start.spread.widthPx] : []));
    const factor = Math.min(1, Math.sqrt(MAX_LAYER_PIXELS / (widest * start.heightPx)));
    const drawing = document.createElement("canvas");
    const ctx = drawing.getContext("2d")!;
    const overlay = document.createElement("canvas");
    const overlayCtx = overlay.getContext("2d")!;
    for (const [unitIndex, unit] of units.entries()) {
      progress(`${unitIndex + 1} / ${units.length} ページを書き出し中…`);
      const spread = unit.length > 1 && start.spread ? start.spread : null;
      const pageWidth = spread ? spread.widthPx : start.widthPx;
      // Right binding: the first page of a spread is the right half.
      const placed = unit.map((index, position) => {
        const right = (position === 0) === (project.binding === "right");
        const dx = spread ? (right ? spread.rightDx : spread.leftDx) : 0;
        return { page: project.pages[index], m: shifted(full, dx), right };
      });
      // On a spread each page shows up to the gutter (template px, `scale` of drawing).
      const clipped = (target: CanvasRenderingContext2D, scale: number, right: boolean, draw: () => void) => {
        if (!spread) return draw();
        target.save();
        target.beginPath();
        const x = spread.gutterPx * scale;
        target.rect(right ? x : 0, 0, right ? target.canvas.width - x : x, target.canvas.height);
        target.clip();
        draw();
        target.restore();
      };
      const width = Math.round(pageWidth * factor);
      const height = Math.round(start.heightPx * factor);
      drawing.width = width;
      drawing.height = height;
      overlay.width = Math.min(OVERLAY_WIDTH * unit.length, pageWidth);
      overlay.height = Math.round((start.heightPx * overlay.width) / pageWidth);
      const layers: LayerMeta[] = [];
      const pngs: Uint8Array[] = [];
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      for (const kind of LAYER_ORDER) {
        // Image balloons carry their own paper.
        if (kind === "balloonFills" && !vector) continue;
        if (kind === "text" ? text : vector && canBeVector(kind)) {
          const toOverlay = overlay.width / pageWidth;
          for (const { page, m, right } of placed) {
            if (kind === "text") layers.push(...textLayers(page, m, start.resolution));
            // CSP draws these itself when the page is opened; the thumbnail does not.
            clipped(overlayCtx, toOverlay, right, () => drawPart(overlayCtx, page, kind, scaled(m, toOverlay), project.brushes));
          }
          if (canBeVector(kind)) {
            const lines = placed.flatMap(({ page, m, right }) => {
              const own = vectorLines(page, kind, m, project.brushes);
              return spread ? clipLines(own, spread.gutterPx, right) : own;
            });
            layers.push({ kind: "vector", name: LAYER_NAMES[kind], lines });
          }
          continue;
        }
        // An empty part goes as no bytes; the Rust side makes it a blank layer.
        let png: Uint8Array = new Uint8Array();
        if (placed.some(({ page }) => partCount(page, kind))) {
          ctx.clearRect(0, 0, width, height);
          for (const { page, m, right } of placed) {
            clipped(ctx, factor, right, () => drawPart(ctx, page, kind, scaled(m, factor), project.brushes));
          }
          png = await encode(drawing, "image/png");
        }
        layers.push({ kind: "raster", name: LAYER_NAMES[kind], length: png.length });
        pngs.push(png);
      }
      const overlayPng = vector || text ? await encode(overlay, "image/png") : new Uint8Array();
      const roughs = placed.flatMap(({ page, m }) =>
        page.roughs.map((rough: RoughImage) => ({
          layerId: rough.layerId,
          sheetCrop: rough.sheetCrop,
          target: mapBox(rough.box, m),
        })),
      );
      const meta = {
        layers,
        sheet: project.source?.path ?? null,
        roughs: project.source ? roughs : [],
        overlayLength: overlayPng.length,
        spread: spread !== null,
      };
      const check = await invoke<FileCheck>("export_name_page", packBody(meta, [...pngs, overlayPng]));
      checks.push({ ...check, pages: unit.map((index) => index + 1) });
    }
    drawing.width = 0;
    overlay.width = 0;
    const report = await invoke<{ pages: string[]; work: string | null; workCheck: FileCheck | null }>("finish_name_export");
    return { ...report, vectorLayers: vector, textLayers: text, checks, warnings, spreads: units.filter((unit) => unit.length > 1).length };
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
    ctx.globalAlpha = 0.45;
    for (const item of page.roughs) {
      const image = await rough(item);
      if (!image) continue;
      const [x0, y0, x1, y1] = mapBox(item.box, m);
      ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.globalAlpha = 1;
    for (const kind of LAYER_ORDER) drawPart(ctx, page, kind, m, project.brushes);
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
              : line.kind === "aside"
                ? `${who}・${text}`
                : `${who}「${text}」`;
      out.push(`    ${said}`);
    }
    out.push("");
  });
  return out.join("\n");
}

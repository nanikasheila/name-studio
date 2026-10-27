// Writing the name data out: CSP pages (a layer per kind of part, editable
// vector lines and texts where CSP-made layers to copy are found, plus the
// work .cmc), a PDF to read or share, and the script as text.
import { call, type CspExportRequest, type DialogueUpdateReport, type FileCheck, type SpreadLayout, type TemplateCanvas } from "./backend";
export type { CspExportRequest, DialogueUpdateReport, FileCheck, NameExportStart, SpreadLayout, TemplateCanvas } from "./backend";
import { balloonExtent, pageBalloons } from "./balloon";
import { widthFactors } from "./brush";
import { cspFont, useFonts } from "./fonts";
import { borderLines, borderWidthMm, dashes, framePanels, type Side } from "./koma";
import {
  drawBalloonFills,
  drawBalloons,
  drawMarks,
  drawPageTexts,
  drawPanelBorders,
  drawPageFills,
  drawPanelFills,
  drawPanelMask,
  drawStrokes,
  loadTips,
  type MmToPx,
} from "./pagedraw";
import { KIND_LABELS } from "./dialogue";
import { bounds } from "./geometry";
import type { BoxMm, Brush, Page, Project, RoughImage, RoughLayer, StrokePoint } from "./model";
import { basicBox, trimBox } from "./pagebox";
import { wantsSpread } from "./panels";
import { MM_PER_PT } from "./project";
import { splitAtX } from "./strokes";
import { panelFolders } from "./panelfolders";
import { layerOf, markLayersOf, opacityOfLayer, roughExportNames, roughLayersOf, shownStrokes, strokesOn, withoutMarks } from "./roughlayers";
import { decodePicture } from "./pictures";
import { onPageOnly } from "./aside";
import { opacityOf, usedImages } from "./references";
import { sceneSpans } from "./story";
import { balloonLineMm, linePitch, lineSpacing, useStyle } from "./style";
import type { ReadUnit } from "./readback";

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
  pieces = 1,
): { units: number[][]; warnings: string[] } {
  const units: number[][] = [];
  const warnings: string[] = [];
  if (pieces > 1) {
    // 縦スクロール, joined: `pieces` pieces one under the other on each page.
    for (let index = 0; index < project.pages.length; index += pieces) {
      units.push(project.pages.slice(index, index + pieces).map((_, offset) => index + offset));
    }
    return { units, warnings };
  }
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

const NO_FRAME_FOLDER =
  "コマ枠フォルダーの見本が見つからないため、コマ枠はベクターレイヤーにしました。CSP でコマ枠フォルダーを作って保存したページ（仕上げた原稿など）を「見本のページ」に選ぶと、コマ枠フォルダーで書き出せます。";

/** The rough's layers (the name sheet's rough image too): what is inked over in CSP. */
export const ROUGH_LAYERS = [LAYER_NAMES.strokes, LAYER_NAMES.overStrokes, "ラフ（ネーム用紙）"];
/** The rough image of the name sheet (Rust side). */
const SHEET_ROUGH_NAME = ROUGH_LAYERS[2];

export function partCount(page: Page, kind: LayerKind): number {
  switch (kind) {
    case "strokes":
      return page.strokes.filter((stroke) => !stroke.over).length;
    case "overStrokes":
      return page.strokes.filter((stroke) => stroke.over).length;
    case "fills":
      return (
        page.panels.filter((panel) => (panel.fill ?? "none") !== "none" || (panel.effect ?? "none") !== "none").length +
        (page.breakouts ?? []).length +
        (page.fills ?? []).length
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
      drawPageFills(ctx, page, m);
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
      drawPageTexts(ctx, page, m);
      break;
  }
}

/** A CSP vector line in template px; points are `[x, y, width factor]`. */
export interface VectorLineMeta {
  points: [number, number, number][];
  closed: boolean;
  widthPx: number;
}

/** One panel of a コマ枠フォルダー in template px. */
export interface FrameMeta {
  points: [number, number][];
  widthPx: number;
}

/** One layer of a page as `export_name_page` takes it, bottom first. */
export type LayerMeta =
  | { kind: "raster"; name: string; length: number }
  | { kind: "vector"; name: string; lines: VectorLineMeta[] }
  | { kind: "frames"; name: string; frames: FrameMeta[]; ink?: string }
  /** A folder of `children` (bottom first); its mask PNG of `maskLength` bytes (0: none) comes before theirs. */
  | { kind: "folder"; name: string; maskLength: number; children: LayerMeta[] }
  | {
      kind: "text";
      text: string;
      frame: [number, number, number, number];
      fontSizePt: number;
      vertical: boolean;
      /** The chosen font (by the name CSP shows and its PostScript name); absent keeps the template text's. */
      font?: { name: string; postscript: string };
      /** 8-bit RGB; absent keeps the template text's colour. */
      color?: [number, number, number];
      /** Line spacing in percent of the font size (CSP's 行間); absent keeps the template text's. */
      lineSpacing?: number;
    };

export type LinePartKind = Exclude<LayerKind, "text" | "fills" | "balloonFills">;

/** One kind of line part of a page as vector lines (`m`: mm → template px). */
export function vectorLines(
  page: Page,
  kind: LinePartKind,
  m: MmToPx,
  brushes: Brush[] = [],
  /** Panels whose borders go as frames instead. */
  framed: ReadonlySet<string> = new Set(),
): VectorLineMeta[] {
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
      return borderLines(page).filter((line) => !framed.has(line.panel.id)).flatMap((line) => {
        const parts = line.panel.border === "dashed" ? dashes(line.points, line.closed).map((points) => ({ points, closed: false })) : [line];
        return parts.map((part) => ({ points: map(part.points, () => 1), closed: part.closed, widthPx: borderWidthMm(line.panel) * m.scale }));
      });
    case "balloons":
      return pageBalloons(page).flatMap((balloon) => {
        const widthPx = balloonLineMm() * m.scale;
        const outline = balloon.outline.length >= 3 ? [{ points: map(balloon.outline, () => 1), closed: true, widthPx }] : [];
        const extras = balloon.extras.map((extra) => ({ points: map(extra.points, () => 1), closed: extra.closed, widthPx }));
        return [...outline, ...extras];
      });
  }
}

/** The コマ枠フォルダー of a page and the empty layer in it to ink on. */
export const FRAME_FOLDER_NAME = "コマ";
export const INK_LAYER_NAME = "ペン入れ";

/** The page's panels a コマ枠フォルダー holds (see `framePanels`), as frames in template px. */
export function frameMetas(project: Project, page: Page, m: MmToPx, gutter: Side | null = null): { ids: Set<string>; frames: FrameMeta[] } {
  const framed = framePanels(page, project.pageFormat, gutter);
  return {
    ids: new Set(framed.map(({ panel }) => panel.id)),
    frames: framed.map(({ panel, outline }) => ({
      points: outline.map(([x, y]): [number, number] => [x * m.scale + m.x, y * m.scale + m.y]),
      widthPx: borderWidthMm(panel) * m.scale,
    })),
  };
}

/**
 * The layer of the name's memos (panel memos and the page memo), a 下描き
 * layer: seen while inking, never printed. 付箋 stay in the app: they are for
 * planning, and long ones would cover the panels.
 */
export const NOTES_LAYER_NAME = "メモ（ネーム）";
/** 資料画像 go to CSP as a 下描き layer under everything. */
export const REFERENCE_LAYER_NAME = "資料（ネーム）";
const NOTE_TEXT_MM = 3;

/** Whether a page has any memo to write. */
export function hasNotes(page: Page): boolean {
  return !!page.memo?.trim() || page.panels.some((panel) => panel.note?.trim());
}

/** `text` broken into rows no wider than `width` (px at the context's font), `max` rows at most. */
function noteRows(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const rows: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let row = "";
    for (const char of paragraph) {
      if (row && ctx.measureText(row + char).width > width) {
        rows.push(row);
        row = "";
      }
      row += char;
    }
    rows.push(row);
  }
  if (rows.length > max) rows.splice(max - 1, rows.length, rows[max - 1] + "…");
  return rows;
}

/**
 * The name's memos as they show in the app: each panel's memo on a pale tag
 * in a corner of the panel clear of its balloons, and the page memo under
 * the basic frame.
 */
export function drawNotes(ctx: CanvasRenderingContext2D, project: Project, page: Page, m: MmToPx): void {
  const size = NOTE_TEXT_MM * m.scale;
  const pad = size * 0.4;
  const [tx0, ty0, tx1, ty1] = trimBox(project.pageFormat);
  const px = (x: number) => x * m.scale + m.x;
  const py = (y: number) => y * m.scale + m.y;
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = `${size}px "Yu Gothic UI", "Yu Gothic", "Hiragino Sans", "Noto Sans JP", sans-serif`;
  const tag = (x: number, y: number, rows: string[], fill: string, w: number) => {
    const h = rows.length * size * 1.25 + 2 * pad;
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#4a3f12";
    rows.forEach((row, i) => ctx.fillText(row, x + pad, y + pad + i * size * 1.25));
  };
  for (const panel of page.panels) {
    if (!panel.note?.trim()) continue;
    const [x0, y0, x1, y1] = bounds(panel.shape);
    // A 裁ち切り panel's tag stays inside the trim.
    const [left, top, right, bottom] = [px(Math.max(x0, tx0)), py(Math.max(y0, ty0)), px(Math.min(x1, tx1)), py(Math.min(y1, ty1))];
    const room = Math.max(size * 6, Math.min(right - left - 2 * pad, size * 20));
    const rows = noteRows(ctx, panel.note, room - 2 * pad, 4);
    const w = Math.max(...rows.map((row) => ctx.measureText(row).width)) + 2 * pad;
    const h = rows.length * size * 1.25 + 2 * pad;
    const balloons = page.lines.filter((line) => line.panel === panel.id).map((line) => balloonExtent(line).map((v, i) => (i % 2 ? py(v) : px(v))));
    const clear = ([x, y]: number[]) => balloons.every(([bx0, by0, bx1, by1]) => x + w < bx0 || x > bx1 || y + h < by0 || y > by1);
    const corners = [
      [left + pad, top + pad],
      [left + pad, bottom - pad - h],
      [right - pad - w, bottom - pad - h],
    ];
    const [x, y] = corners.find(clear) ?? corners[0];
    tag(x, y, rows, "rgba(255, 246, 194, 0.92)", w);
  }
  if (page.memo?.trim()) {
    // Below the basic frame, where the page is usually blank (the panels' tags are at their tops).
    const width = (tx1 - tx0) * m.scale - 4 * pad;
    const rows = noteRows(ctx, page.memo, width - 2 * pad, 3);
    const h = rows.length * size * 1.25 + 2 * pad;
    const below = py(basicBox(project.pageFormat)[3]) + 2 * pad;
    const y = below + h <= py(ty1) - pad ? below : py(ty0) + 2 * pad;
    tag(px(tx0) + 2 * pad, y, rows, "rgba(214, 234, 248, 0.92)", Math.max(...rows.map((row) => ctx.measureText(row).width)) + 2 * pad);
  }
  ctx.restore();
}

/** Room CSP's characters take down a line, generously. */
const CSP_CHAR_ADVANCE = 1.1;

/**
 * Each line of dialogue as a CSP text layer: its box in template px and its
 * size in CSP pt (pt of the template's resolution). The text is written with
 * the name's 行間, so CSP spaces its lines as the name does. CSP hides what
 * does not fit its frame, so the frame holds every line: down and right of
 * the box's top left for horizontal text (never smaller than the box), and
 * for vertical text placed so the first column starts at the box's top
 * right, as on the name.
 */
export function textLayers(page: Page, m: MmToPx, resolution: number): LayerMeta[] {
  const pitch = linePitch();
  return page.lines
    .filter((line) => line.text.trim())
    .map((line) => {
      const [x0, y0, x1, y1] = mapBox(line.box, m);
      const size = line.fontSizePt * MM_PER_PT * m.scale;
      const lines = line.text.split(/\r?\n/);
      // The chosen font, when this computer has it (CSP needs its PostScript name too).
      const font = cspFont(line);
      // From the first line's start to the last line's end.
      const set = ((lines.length - 1) * pitch + 1) * size;
      const across = Math.max(lines.length * size * pitch, set);
      const along = Math.max(...lines.map((text) => [...text].length)) * size * CSP_CHAR_ADVANCE;
      // CSP lays vertical text out from the frame's left edge, each column
      // with its line gap on its right: the first column is set from the
      // box's right edge when the frame's left edge is where the last one
      // starts (and the frame holds every column's gap).
      const left = x1 - set;
      const frame: [number, number, number, number] = line.vertical
        ? [left, y0, left + across, Math.max(y1, y0 + along)]
        : [x0, y0, Math.max(x1, x0 + along), Math.max(y1, y0 + across)];
      return {
        kind: "text",
        text: line.text,
        frame,
        fontSizePt: (line.fontSizePt * m.scale * 25.4) / resolution,
        vertical: line.vertical,
        ...(line.inverted ? { color: [255, 255, 255] as [number, number, number] } : {}),
        ...(font ? { font } : {}),
        lineSpacing: lineSpacing(),
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

/** The kinds of layer that will be images because no CSP-made layer was found to copy. */
export function missingEditable(found: Pick<CspExportReport, "vectorLayers" | "textLayers">): string[] {
  return [!found.vectorLayers && "ベクター線（コマ枠・フキダシ・ラフ線）", !found.textLayers && "テキスト（セリフ）"].filter((x): x is string => !!x);
}

/** Why some parts went as images, and how to have them editable. */
export function imagesNote(missing: string[]): string {
  return (
    `ひな形・見本・ネーム用紙に CSP の${missing.join("と")}のレイヤーが見つからないため、その部分を画像レイヤーにしました（CSP で直せません）。` +
    "CSP でテキストとベクター線を描いて保存したページ（.clip）を「見本のページ」に選ぶか、ひな形と同じフォルダーに置くと、直せるレイヤーで書き出せます。"
  );
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
/** A page of an export unit, with where it goes on the CSP page. */
export interface PlacedPage {
  page: Page;
  m: MmToPx;
  /** The right half of a spread (always true off a spread with right binding). */
  right: boolean;
}

/** Places the pages of one export unit (one page, or the two of a spread), without what lies in their 欄外 (a CSP page ends at its paper). */
export function placeUnit(project: Project, unit: number[], full: MmToPx, spread: SpreadLayout | null): PlacedPage[] {
  // Right binding: the first page of a spread is the right half.
  return unit.map((index, position) => {
    const right = (position === 0) === (project.binding === "right");
    const dx = spread ? (right ? spread.rightDx : spread.leftDx) : 0;
    return { page: onPageOnly(project.pages[index], project.pageFormat), m: shifted(full, dx), right };
  });
}

/**
 * 縦スクロール, joined: the pieces of a unit one under the other on a page
 * that holds `pieces` of them, each fitted into its share of the height.
 */
export function placeStacked(project: Project, unit: number[], canvas: Pick<TemplateCanvas, "widthPx" | "heightPx">, pieces: number): PlacedPage[] {
  const share = canvas.heightPx / pieces;
  const [w, h] = project.pageFormat.canvasMm;
  const scale = Math.min(canvas.widthPx / w, share / h);
  return unit.map((index, position) => ({
    page: onPageOnly(project.pages[index], project.pageFormat),
    m: { scale, x: (canvas.widthPx - w * scale) / 2, y: position * share + (share - h * scale) / 2 },
    right: project.binding === "right",
  }));
}

/** How a kind of part goes to CSP: as vector lines, as text layers, as a picture, or not at all. */
export function layerForm(kind: LayerKind, vector: boolean, text: boolean): "vector" | "text" | "raster" | "none" {
  // Image balloons carry their own paper.
  if (kind === "balloonFills" && !vector) return "none";
  if (kind === "text") return text ? "text" : "raster";
  return vector && canBeVector(kind) ? "vector" : "raster";
}

/** Thrown from an export's `progress` to stop it at the next page; `written` pages were written by then. */
export class ExportStopped extends Error {
  written = 0;
  constructor() {
    super("書き出しをやめました");
  }
}

export async function exportToCsp(
  project: Project,
  request: CspExportRequest,
  editable: boolean,
  progress: (message: string) => void,
  confirmImages?: (missing: string[]) => Promise<boolean>,
  /** 縦スクロール, joined: pieces on each page (the template is that tall; see `piecesPerPage`). */
  pieces = 1,
): Promise<CspExportReport | null> {
  // The dialogue in the name's fonts, also when written from the command line.
  useFonts(project.fonts);
  useStyle(project.style);
  await loadTips(project.brushes);
  const notes = request.notes !== false && project.pages.some(hasNotes);
  if (notes) request = { ...request, draftLayers: [...(request.draftLayers ?? []), NOTES_LAYER_NAME] };
  // 指示: a 下描き layer each (seen while inking, never printed), on top; the ones with no 指示 in the name are left out.
  const markSet = request.marks === false ? [] : markLayersOf(project).filter((layer) => project.pages.some((page) => strokesOn(project, page.strokes, layer).length));
  const pictures = await decodeReferences(project);
  if (pictures.size) request = { ...request, draftLayers: [...(request.draftLayers ?? []), REFERENCE_LAYER_NAME] };
  // ラフ線のレイヤー: each its own CSP layer (one layer: ラフ線 and はみ出し（ラフ線）, as always).
  const roughSet = roughLayersOf(project);
  const roughNames = roughExportNames(project, [
    ...LAYER_ORDER.filter((kind) => kind !== "strokes" && kind !== "overStrokes").map((kind) => LAYER_NAMES[kind]),
    FRAME_FOLDER_NAME,
    INK_LAYER_NAME,
    NOTES_LAYER_NAME,
    REFERENCE_LAYER_NAME,
    SHEET_ROUGH_NAME,
  ]);
  const roughName = (layer: RoughLayer, kind: LayerKind) => roughNames.get(layer.id)![kind === "overStrokes" ? "over" : "under"];
  // はみ出し layers for the first layer, as always, and the others that have lines over the borders.
  const overLayers = roughSet.filter((layer) => layer.id === layerOf(project, {}).id || project.pages.some((page) => strokesOn(project, page.strokes, layer).some((stroke) => stroke.over)));
  const onLayer = <T extends { page: Page }>(place: T, layer: RoughLayer): T => ({ ...place, page: { ...place.page, strokes: strokesOn(project, place.page.strokes, layer) } });
  if (request.draftLayers?.includes(LAYER_NAMES.strokes)) {
    request = { ...request, draftLayers: [...request.draftLayers, ...roughSet.flatMap((layer) => [roughName(layer, "strokes"), roughName(layer, "overStrokes")])] };
  }
  const markName = (layer: RoughLayer) => roughNames.get(layer.id)!.under;
  if (markSet.length) request = { ...request, draftLayers: [...(request.draftLayers ?? []), ...markSet.map(markName)] };
  const looks = [
    ...roughSet
      .filter((layer) => layer.hidden || opacityOfLayer(layer) < 1)
      .flatMap((layer) => [roughName(layer, "strokes"), roughName(layer, "overStrokes")].map((name) => ({ name, opacity: opacityOfLayer(layer), hidden: !!layer.hidden }))),
    // A 下描き layer is at half opacity already; a hidden 指示のレイヤー goes hidden.
    ...markSet.filter((layer) => layer.hidden).map((layer) => ({ name: markName(layer), opacity: 1, hidden: true })),
  ];
  if (looks.length) request = { ...request, layerLooks: looks };
  // The name's binding, not the template's: a left-bound name may start from a right-bound work.
  request = { ...request, rightBinding: !project.scroll && project.binding === "right" };
  const start = await call("begin_name_export", { request });
  const vector = editable && start.vectorLayers;
  const text = editable && start.textLayers;
  // マスク付きフォルダー take the place of the コマ枠フォルダー.
  const masks = !!request.panelMasks;
  const frames = vector && !masks && !!request.frameFolders && start.frameFolders;
  try {
    // Asked before anything is written: lines and dialogue CSP cannot edit stop the pen work.
    const missing = editable ? missingEditable(start) : [];
    if (missing.length && confirmImages && !(await confirmImages(missing))) {
      await call("cancel_name_export");
      return null;
    }
    const full = projectToTemplate(project, start);
    const { units, warnings } = exportUnits(project, start.firstPageLeft, start.spread ? null : start.spreadProblem, pieces);
    if (vector && !masks && request.frameFolders && !start.frameFolders) warnings.push(NO_FRAME_FOLDER);
    const checks: FileCheck[] = [];
    // One drawing canvas for the widest page; each page is drawn at its own size.
    const widest = Math.max(start.widthPx, ...(units.some((unit) => unit.length > 1) && start.spread && pieces === 1 ? [start.spread.widthPx] : []));
    const factor = Math.min(1, Math.sqrt(MAX_LAYER_PIXELS / (widest * start.heightPx)));
    const drawing = document.createElement("canvas");
    const ctx = drawing.getContext("2d")!;
    const overlay = document.createElement("canvas");
    const overlayCtx = overlay.getContext("2d")!;
    for (const [unitIndex, unit] of units.entries()) {
      progress(`${unitIndex + 1} / ${units.length} ページを書き出し中…`);
      const spread = unit.length > 1 && start.spread && pieces === 1 ? start.spread : null;
      const pageWidth = spread ? spread.widthPx : start.widthPx;
      const placed = pieces > 1 ? placeStacked(project, unit, start, pieces) : placeUnit(project, unit, full, spread);
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
      if (pictures.size) {
        let png: Uint8Array = new Uint8Array();
        if (placed.some(({ page }) => page.references?.length)) {
          ctx.clearRect(0, 0, width, height);
          for (const { page, m, right } of placed) clipped(ctx, factor, right, () => drawReferences(ctx, page, pictures, scaled(m, factor)));
          png = await encode(drawing, "image/png");
        }
        layers.push({ kind: "raster", name: REFERENCE_LAYER_NAME, length: png.length });
        pngs.push(png);
      }
      // One kind of part of `pages` as a layer named `name`: vector lines, or a picture (its PNG goes to `pngs`).
      const part = async (kind: LayerKind, pages: readonly PlacedPage[], name: string): Promise<LayerMeta> => {
        if (layerForm(kind, vector, text) === "vector" && canBeVector(kind)) {
          const lines = pages.flatMap(({ page, m, right }) => {
            const own = vectorLines(page, kind, m, project.brushes);
            return spread ? clipLines(own, spread.gutterPx, right) : own;
          });
          return { kind: "vector", name, lines };
        }
        // An empty part goes as no bytes; the Rust side makes it a blank layer.
        let png: Uint8Array = new Uint8Array();
        if (pages.some(({ page }) => partCount(page, kind))) {
          ctx.clearRect(0, 0, width, height);
          for (const { page, m, right } of pages) {
            clipped(ctx, factor, right, () => drawPart(ctx, page, kind, scaled(m, factor), project.brushes));
          }
          png = await encode(drawing, "image/png");
        }
        pngs.push(png);
        return { kind: "raster", name, length: png.length };
      };
      for (const kind of LAYER_ORDER) {
        const form = layerForm(kind, vector, text);
        if (form === "none") continue;
        if (form !== "raster") {
          const toOverlay = overlay.width / pageWidth;
          for (const { page, m, right } of placed) {
            // CSP draws these itself when the page is opened; the thumbnail does not (nor hidden rough layers, nor 指示).
            const shown = { ...page, strokes: withoutMarks(project, shownStrokes(project, page.strokes)) };
            clipped(overlayCtx, toOverlay, right, () => drawPart(overlayCtx, shown, kind, scaled(m, toOverlay), project.brushes));
          }
        }
        if (kind === "strokes" && masks) {
          // The rough in each panel's folder, under its mask; a stroke in no panel stays on top of the page.
          const { folders, loose } = panelFolders(placed, project.pageFormat);
          for (const layer of roughSet) {
            const pages = placed.map((place, index) => onLayer({ ...place, page: { ...place.page, strokes: loose[index] } }, layer));
            if (pages.some(({ page }) => page.strokes.length)) layers.push(await part(kind, pages, roughName(layer, kind)));
          }
          for (const folder of folders) {
            ctx.clearRect(0, 0, width, height);
            drawPanelMask(ctx, folder, project.pageFormat, (m) => scaled(m, factor), (right, draw) => clipped(ctx, factor, right, draw));
            const mask = await encode(drawing, "image/png");
            pngs.push(mask);
            const children: LayerMeta[] = [];
            for (const layer of roughSet) {
              const pages = folder.parts.map(({ page, m, right, strokes }) => onLayer({ page: { ...page, strokes }, m, right }, layer));
              if (pages.some(({ page }) => page.strokes.length)) children.push(await part(kind, pages, roughName(layer, kind)));
            }
            children.push({ kind: "raster", name: INK_LAYER_NAME, length: 0 });
            layers.push({ kind: "folder", name: folder.name, maskLength: mask.length, children });
          }
          continue;
        }
        if (kind === "strokes" || kind === "overStrokes") {
          for (const layer of kind === "strokes" ? roughSet : overLayers) {
            layers.push(await part(kind, placed.map((place) => onLayer(place, layer)), roughName(layer, kind)));
          }
          continue;
        }
        if (kind === "text" && form === "text") {
          for (const { page, m } of placed) layers.push(...textLayers(page, m, start.resolution));
          continue;
        }
        if (kind === "panels" && frames) {
          // The gutter side of a spread page meets its facing page.
          const framed = placed.map(({ page, m, right }) => frameMetas(project, page, m, spread ? (right ? "left" : "right") : null));
          layers.push({ kind: "frames", name: FRAME_FOLDER_NAME, frames: framed.flatMap((one) => one.frames), ink: INK_LAYER_NAME });
          const lines = placed.flatMap(({ page, m, right }, index) => {
            const own = vectorLines(page, kind, m, project.brushes, framed[index].ids);
            return spread ? clipLines(own, spread.gutterPx, right) : own;
          });
          if (lines.length) layers.push({ kind: "vector", name: LAYER_NAMES[kind], lines });
          continue;
        }
        layers.push(await part(kind, placed, LAYER_NAMES[kind]));
      }
      if (notes) {
        let png: Uint8Array = new Uint8Array();
        if (placed.some(({ page }) => hasNotes(page))) {
          ctx.clearRect(0, 0, width, height);
          for (const { page, m, right } of placed) clipped(ctx, factor, right, () => drawNotes(ctx, project, page, scaled(m, factor)));
          png = await encode(drawing, "image/png");
        }
        layers.push({ kind: "raster", name: NOTES_LAYER_NAME, length: png.length });
        pngs.push(png);
      }
      for (const layer of markSet) {
        // Each 指示のレイヤー in its colour, cut at the paper's edge as everything is.
        const only = { roughLayers: [layer], brushes: project.brushes };
        let png: Uint8Array = new Uint8Array();
        if (placed.some(({ page }) => strokesOn(project, page.strokes, layer).length)) {
          ctx.clearRect(0, 0, width, height);
          for (const { page, m, right } of placed) {
            const own = { ...page, strokes: strokesOn(project, page.strokes, layer) };
            clipped(ctx, factor, right, () => drawMarks(ctx, only, own, scaled(m, factor), undefined, true));
          }
          png = await encode(drawing, "image/png");
        }
        layers.push({ kind: "raster", name: markName(layer), length: png.length });
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
      const check = await call("export_name_page", packBody(meta, [...pngs, overlayPng]));
      checks.push({ ...check, pages: unit.map((index) => index + 1) });
    }
    drawing.width = 0;
    overlay.width = 0;
    for (const picture of pictures.values()) picture.close();
    const report = await call("finish_name_export");
    return { ...report, vectorLayers: vector, textLayers: text, checks, warnings, spreads: pieces > 1 ? 0 : units.filter((unit) => unit.length > 1).length };
  } catch (error) {
    const written = await call("cancel_name_export").catch(() => 0);
    if (error instanceof ExportStopped) error.written = written ?? 0;
    throw error;
  }
}

/** The 資料画像 the pages show, decoded (by image id); one that cannot be read is left out. */
async function decodeReferences(project: Project): Promise<Map<string, ImageBitmap>> {
  const pictures = new Map<string, ImageBitmap>();
  for (const image of usedImages(project)) {
    const picture = await decodePicture(image).catch(() => null);
    if (picture) pictures.set(image.id, picture);
  }
  return pictures;
}

/**
 * A page's 資料画像 as they lie on it. The layer itself is a 下描き layer at
 * half opacity in CSP, so each is drawn twice as strong as on screen.
 */
function drawReferences(ctx: CanvasRenderingContext2D, page: Page, pictures: Map<string, ImageBitmap>, m: MmToPx): void {
  for (const reference of page.references ?? []) {
    const picture = pictures.get(reference.image);
    if (!picture) continue;
    const [x0, y0, x1, y1] = reference.box;
    ctx.globalAlpha = Math.min(1, opacityOf(reference) * 2);
    ctx.drawImage(picture, m.x + x0 * m.scale, m.y + y0 * m.scale, (x1 - x0) * m.scale, (y1 - y0) * m.scale);
  }
  ctx.globalAlpha = 1;
}

export interface DialogueUpdateSummary {
  pages: (DialogueUpdateReport & { pages: number[] })[];
  /** Pages whose dialogue changed (and were written). */
  changed: number;
  warnings: string[];
}

/** `name-studio-backup` folder name for this run: when it started. */
function backupName(now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

/**
 * Bring the dialogue into pages already written to `request.outDir` and
 * drawn on in CSP since: the same pages as the export (spreads too), but
 * only texts that changed are swapped (the old ones hidden as 「（旧）」),
 * with the balloons of those pages. Everything else in the page stays as
 * CSP saved it; each changed page is copied to `name-studio-backup` first.
 */
export async function updateCspDialogue(
  project: Project,
  request: CspExportRequest,
  progress: (message: string) => void,
): Promise<DialogueUpdateSummary> {
  useFonts(project.fonts);
  useStyle(project.style);
  await loadTips(project.brushes);
  const notes = request.notes !== false;
  const start = await call("begin_name_export", { request: { ...request, frameFolders: false, notes: false } });
  try {
    if (!start.textLayers) throw new Error("テキストのレイヤーの見本が見つかりません。書き出しと同じひな形・見本のページを選んでください");
    const vector = start.vectorLayers;
    const full = projectToTemplate(project, start);
    const { units, warnings } = exportUnits(project, start.firstPageLeft, start.spread ? null : start.spreadProblem);
    const widest = Math.max(start.widthPx, ...(units.some((unit) => unit.length > 1) && start.spread ? [start.spread.widthPx] : []));
    const factor = Math.min(1, Math.sqrt(MAX_LAYER_PIXELS / (widest * start.heightPx)));
    const drawing = document.createElement("canvas");
    const ctx = drawing.getContext("2d")!;
    const backup = backupName(new Date());
    const pages: DialogueUpdateSummary["pages"] = [];
    for (const [unitIndex, unit] of units.entries()) {
      progress(`${unitIndex + 1} / ${units.length} ページのセリフを確かめ中…`);
      const spread = unit.length > 1 && start.spread ? start.spread : null;
      const pageWidth = spread ? spread.widthPx : start.widthPx;
      const placed = unit.map((index, position) => {
        const right = (position === 0) === (project.binding === "right");
        const dx = spread ? (right ? spread.rightDx : spread.leftDx) : 0;
        return { page: project.pages[index], m: shifted(full, dx), right };
      });
      const texts = placed.flatMap(({ page, m }) => textLayers(page, m, start.resolution));
      // The balloons as the export writes them: lines and their paper, or one image.
      const balloons: LayerMeta[] = [];
      const pngs: Uint8Array[] = [];
      const width = Math.round(pageWidth * factor);
      const height = Math.round(start.heightPx * factor);
      const image = async (kind: LayerKind) => {
        let png: Uint8Array = new Uint8Array();
        if (placed.some(({ page }) => partCount(page, kind))) {
          drawing.width = width;
          drawing.height = height;
          for (const { page, m, right } of placed) {
            ctx.save();
            if (spread) {
              ctx.beginPath();
              const x = spread.gutterPx * factor;
              ctx.rect(right ? x : 0, 0, right ? width - x : x, height);
              ctx.clip();
            }
            drawPart(ctx, page, kind, scaled(m, factor), project.brushes);
            ctx.restore();
          }
          png = await encode(drawing, "image/png");
        }
        balloons.push({ kind: "raster", name: LAYER_NAMES[kind], length: png.length });
        pngs.push(png);
      };
      if (vector) {
        await image("balloonFills");
        const lines = placed.flatMap(({ page, m, right }) => {
          const own = vectorLines(page, "balloons", m, project.brushes);
          return spread ? clipLines(own, spread.gutterPx, right) : own;
        });
        balloons.push({ kind: "vector", name: LAYER_NAMES.balloons, lines });
      } else {
        await image("balloons");
      }
      let memos: LayerMeta | null = null;
      if (notes) {
        let png: Uint8Array = new Uint8Array();
        if (placed.some(({ page }) => hasNotes(page))) {
          drawing.width = width;
          drawing.height = height;
          for (const { page, m, right } of placed) {
            ctx.save();
            if (spread) {
              ctx.beginPath();
              const x = spread.gutterPx * factor;
              ctx.rect(right ? x : 0, 0, right ? width - x : x, height);
              ctx.clip();
            }
            drawNotes(ctx, project, page, scaled(m, factor));
            ctx.restore();
          }
          png = await encode(drawing, "image/png");
        }
        memos = { kind: "raster", name: NOTES_LAYER_NAME, length: png.length };
        pngs.push(png);
      }
      const meta = { texts, balloons, notes: memos, spread: spread !== null, backup };
      const report = await call("update_name_dialogue", packBody(meta, pngs));
      pages.push({ ...report, pages: unit.map((index) => index + 1) });
    }
    drawing.width = 0;
    return { pages, changed: pages.filter((page) => page.backup).length, warnings };
  } finally {
    await call("cancel_name_export").catch(() => undefined);
  }
}

/**
 * Read the dialogue back from the pages written to `request.outDir` (as
 * CSP has it now), each text on its page of the name in mm.
 */
export async function readCspDialogue(project: Project, request: CspExportRequest, progress: (message: string) => void): Promise<ReadUnit[]> {
  const start = await call("begin_name_export", { request: { ...request, frameFolders: false, notes: false } });
  try {
    const full = projectToTemplate(project, start);
    const { units } = exportUnits(project, start.firstPageLeft, start.spread ? null : start.spreadProblem);
    const read: ReadUnit[] = [];
    for (const [unitIndex, unit] of units.entries()) {
      progress(`${unitIndex + 1} / ${units.length} ページのセリフを読み中…`);
      const spread = unit.length > 1 && start.spread ? start.spread : null;
      const placed = unit.map((index, position) => {
        const right = (position === 0) === (project.binding === "right");
        return { index, m: shifted(full, spread ? (right ? spread.rightDx : spread.leftDx) : 0), right };
      });
      const page = await call("read_name_dialogue", { spread: spread !== null });
      const texts = (page.dialogue?.texts ?? []).map(({ text, bbox }) => {
        // On a 見開き page, the page whose side of the gutter it is on.
        const x = bbox ? (bbox[0] + bbox[2]) / 2 : 0;
        const on = (spread && placed.find(({ right }) => (x >= spread.gutterPx) === right)) || placed[0];
        const box = bbox ? (bbox.map((v, i) => (v - (i % 2 ? on.m.y : on.m.x)) / on.m.scale) as BoxMm) : null;
        return { text, page: on.index, box };
      });
      read.push({ pages: unit, path: page.path, found: page.dialogue !== null, written: page.dialogue?.written ?? null, adoptedFrom: page.dialogue?.adoptedFrom ?? null, texts });
    }
    return read;
  } finally {
    await call("cancel_name_export").catch(() => undefined);
  }
}

/** What the update did, in a few lines. */
export function dialogueUpdateSummary(summary: DialogueUpdateSummary): { ok: boolean; lines: string[] } {
  const where = (page: { pages: number[] }) => (page.pages.length > 1 ? `${page.pages.join("–")} ページ` : `${page.pages[0]} ページ`);
  const lines: string[] = [];
  const sum = (pick: (page: DialogueUpdateReport) => number) => summary.pages.reduce((total, page) => total + pick(page), 0);
  const missing = summary.pages.filter((page) => page.notFound.includes("ページのファイル"));
  lines.push(
    summary.changed
      ? `${summary.changed} ページに反映しました（セリフ: 足した ${sum((page) => page.added.length)}・（旧）にして隠した ${sum((page) => page.retired.length)}・そのまま ${sum((page) => page.kept)}、フキダシを入れ替えたページ ${summary.pages.filter((page) => page.replaced.length).length}、メモを描き直したページ ${summary.pages.filter((page) => page.notes).length}）`
      : "セリフ・フキダシ・メモの変わったページはありませんでした",
  );
  const backup = summary.pages.find((page) => page.backup)?.backup;
  if (backup) lines.push(`反映する前のページ: ${backup.replace(/[\\/][^\\/]+$/, "")}`);
  const inCsp = sum((page) => page.leftAsInCsp);
  if (inCsp) lines.push(`CSP で直した・消したセリフ ${inCsp} 個は、ネームで変えていないので CSP のままにしました`);
  // A text retyped in CSP is not one this tool wrote either: counted once, above.
  const foreign = sum((page) => Math.max(0, page.foreign - page.leftAsInCsp));
  if (foreign) lines.push(`CSP で足したテキスト ${foreign} 個はそのままです`);
  for (const page of summary.pages) {
    const lost = page.notFound.filter((name) => name !== "ページのファイル");
    if (lost.length && page.backup) lines.push(`${where(page)}: 「${lost.join("」「")}」レイヤーが見つからないので、フキダシは前のままです`);
    if (page.conflicts.length) {
      lines.push(`${where(page)}: CSP でも直した「${page.conflicts.join("」「")}」をネームのものにしました（CSP で直したものは「（旧）」で隠してあります）`);
    }
  }
  if (missing.length) lines.push(`ページのファイルがありません: ${missing.map(where).join("、")}（書き出したときとページの数・見開きが変わっていませんか）`);
  lines.push(...summary.warnings);
  const problems = summary.pages.flatMap((page) => page.problems.map((problem) => `${where(page)}: ${problem}`));
  if (problems.length) lines.push(`自己確認で ${problems.length} 件の問題:`, ...problems);
  return { ok: !problems.length && !missing.length, lines };
}

export interface PdfOptions {
  /** Cut each page at the trim (仕上がり) or keep the whole canvas. */
  area: "trim" | "canvas";
  dpi: number;
  /** 指示 over the pages in their colours (the 指示のレイヤー shown; on unless false), for an instruction sheet. */
  marks?: boolean;
}

/** Render every page (with the roughs) as JPEG and write one PDF. */
export async function exportPdf(
  project: Project,
  path: string,
  options: PdfOptions,
  rough: (rough: RoughImage) => Promise<CanvasImageSource | null>,
  progress: (message: string) => void,
): Promise<void> {
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
    ctx.globalAlpha = 0.45;
    for (const item of page.roughs) {
      const image = await rough(item);
      if (!image) continue;
      const [x0, y0, x1, y1] = mapBox(item.box, m);
      ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.globalAlpha = 1;
    const plain = { ...page, strokes: withoutMarks(project, page.strokes) };
    for (const kind of LAYER_ORDER) drawPart(ctx, plain, kind, m, project.brushes);
    if (options.marks !== false) drawMarks(ctx, project, page, m);
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

// A small picture of a page (物語の帯, page lists): the same drawing as the
// editor, without brush tips.
import type { BoxMm, Page, Project } from "../model/model";
import { withoutMarks } from "../domain/roughlayers";
import { drawBalloons, drawPageFills, drawPageTexts, drawPanelBorders, drawPanelFills, drawStrokes, type MmToPx } from "./pagedraw";

/** `text`: the words themselves (else grey boxes where they go). */
export function drawThumb(
  ctx: CanvasRenderingContext2D,
  project: Project,
  sheet: Project["pages"][number],
  m: MmToPx,
  text: boolean,
): void {
  // The 指示 would only clutter so small a page.
  const page = { ...sheet, strokes: withoutMarks(project, sheet.strokes) };
  const [pageW, pageH] = project.pageFormat.canvasMm;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pageW * m.scale, pageH * m.scale);
  drawParts(ctx, page, m, text);
}

/** What lies on a page, small: rough lines, fills, borders, balloons and (with `text`) the words. */
function drawParts(ctx: CanvasRenderingContext2D, page: Page, m: MmToPx, text: boolean, ink: () => string = () => "#55524c"): void {
  drawPageFills(ctx, page, m, undefined, true);
  drawStrokes(ctx, page, m, false, ink, 0.5);
  drawPanelFills(ctx, page, m, 0.4);
  drawPageFills(ctx, page, m);
  drawPanelBorders(ctx, page, m, undefined, 0.8);
  drawStrokes(ctx, page, m, true, ink, 0.5);
  drawBalloons(ctx, page, m, 0.6);
  if (text) drawPageTexts(ctx, page, m);
  else {
    ctx.fillStyle = "rgba(27, 26, 24, 0.3)";
    for (const line of page.lines) {
      const [x0, y0, x1, y1] = line.box;
      ctx.fillRect(x0 * m.scale + m.x, y0 * m.scale + m.y, (x1 - x0) * m.scale, (y1 - y0) * m.scale);
    }
  }
}

/**
 * ミニビュー of a part of a page (a レイヤー row): `page` holding only what
 * the row stands for, drawn to fit `box` (mm) in the canvas, on white.
 * `ink`: the colour of rough lines (a 指示's own).
 */
export function drawPartThumb(canvas: HTMLCanvasElement, page: Page, box: BoxMm, text: boolean, ink?: string): void {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || Number.parseFloat(canvas.style.width) || 36;
  const height = canvas.clientHeight || Number.parseFloat(canvas.style.height) || 26;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const [x0, y0, x1, y1] = box;
  const pad = 2 * ratio;
  const scale = Math.min((canvas.width - 2 * pad) / Math.max(x1 - x0, 1e-3), (canvas.height - 2 * pad) / Math.max(y1 - y0, 1e-3));
  const m: MmToPx = {
    scale,
    x: (canvas.width - (x1 - x0) * scale) / 2 - x0 * scale,
    y: (canvas.height - (y1 - y0) * scale) / 2 - y0 * scale,
  };
  drawParts(ctx, page, m, text, ink ? () => ink : undefined);
}

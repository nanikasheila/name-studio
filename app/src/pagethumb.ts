// A small picture of a page (物語の帯, page lists): the same drawing as the
// editor, without brush tips.
import type { Project } from "./model";
import { drawBalloons, drawPageFills, drawPageTexts, drawPanelBorders, drawPanelFills, drawStrokes, type MmToPx } from "./pagedraw";

/** `text`: the words themselves (else grey boxes where they go). */
export function drawThumb(ctx: CanvasRenderingContext2D, project: Project, page: Project["pages"][number], m: MmToPx, text: boolean): void {
  const [pageW, pageH] = project.pageFormat.canvasMm;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pageW * m.scale, pageH * m.scale);
  const ink = () => "#55524c";
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

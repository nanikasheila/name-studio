// Drawing the parts of a name page (mm coordinates) onto a 2D canvas, shared
// by the editor and the export (CSP layers, PDF).
import { MM_PER_PT, type Line, type Panel, type Point, type Stroke } from "./project";
import { drawText } from "./render";

/** Page millimetres → canvas pixels: `px = mm * scale + offset`. */
export interface MmToPx {
  scale: number;
  x: number;
  y: number;
}

export const INK = "#1b1a18";
/** Line widths on the manuscript, in mm. */
export const PANEL_LINE_MM = 0.6;
export const BALLOON_LINE_MM = 0.3;

export function tracePath(ctx: CanvasRenderingContext2D, points: readonly (readonly number[])[], m: MmToPx, close: boolean): void {
  ctx.beginPath();
  points.forEach(([x, y], i) => {
    const px = x * m.scale + m.x;
    const py = y * m.scale + m.y;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  if (close) ctx.closePath();
}

/** Rough lines, thinner where the pen pressed lightly. */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, m: MmToPx, color: string, minWidthPx = 0.7): void {
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const points = stroke.points;
  for (let i = 1; i < points.length; i++) {
    const pressure = (points[i - 1][2] + points[i][2]) / 2;
    ctx.lineWidth = Math.max(stroke.widthMm * (0.35 + 0.65 * pressure) * m.scale, minWidthPx);
    ctx.beginPath();
    ctx.moveTo(points[i - 1][0] * m.scale + m.x, points[i - 1][1] * m.scale + m.y);
    ctx.lineTo(points[i][0] * m.scale + m.x, points[i][1] * m.scale + m.y);
    ctx.stroke();
  }
}

export function drawPanel(ctx: CanvasRenderingContext2D, panel: Panel, m: MmToPx, color = INK, minWidthPx = 1): void {
  tracePath(ctx, panel.shape, m, true);
  ctx.strokeStyle = color;
  ctx.lineJoin = "miter";
  ctx.lineWidth = Math.max(PANEL_LINE_MM * m.scale, minWidthPx);
  ctx.stroke();
}

/** A balloon filled white; thoughts get a dashed outline. */
export function drawBalloon(ctx: CanvasRenderingContext2D, line: Line, m: MmToPx, minWidthPx = 0.8): void {
  if (!line.balloon || line.balloon.length < 3) return;
  tracePath(ctx, line.balloon, m, true);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.setLineDash(line.kind === "thought" ? [Math.max(2 * m.scale, 3), Math.max(1.5 * m.scale, 2)] : []);
  ctx.strokeStyle = INK;
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(BALLOON_LINE_MM * m.scale, minWidthPx);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawLineText(ctx: CanvasRenderingContext2D, line: Line, m: MmToPx): void {
  drawText(
    ctx,
    {
      text: line.text,
      bbox: line.box,
      fontSizePx: line.fontSizePt * MM_PER_PT,
      fontName: null,
      vertical: line.vertical,
      inBalloon: !!line.balloon,
    },
    { scale: m.scale, offsetX: m.x, offsetY: m.y },
  );
}

export function mapPoint([x, y]: Point, m: MmToPx): Point {
  return [x * m.scale + m.x, y * m.scale + m.y];
}

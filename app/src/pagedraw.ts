// Drawing the parts of a name page (mm coordinates) onto a 2D canvas, shared
// by the editor and the export (CSP layers, PDF).
import { pageBalloons } from "./balloon";
import { borderLines, borderWidthMm, dashes, effectStrokes, stacked } from "./koma";
import { MM_PER_PT, type Line, type Page, type Panel, type Point, type Stroke } from "./project";
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

/** Ink for background effects: light, so they read as notes under the drawing. */
const EFFECT_INK = "rgba(27, 26, 24, 0.45)";
const FILLS: Record<string, string> = { white: "#ffffff", black: INK, gray: "#b9b6b0" };

/**
 * Panel fills and background effects, bottom panel first, then the はみ出し
 * areas blanked white. Borders are drawn separately (drawPanelBorders).
 */
export function drawPanelFills(ctx: CanvasRenderingContext2D, page: Page, m: MmToPx, minWidthPx = 0.6): void {
  for (const panel of stacked(page.panels)) {
    const fill = panel.fill ?? "none";
    if (fill !== "none") {
      tracePath(ctx, panel.shape, m, true);
      ctx.fillStyle = FILLS[fill];
      ctx.fill();
    }
    const effect = panel.effect ?? "none";
    if (effect === "none") continue;
    const { lines, stars } = effectStrokes(panel, effect);
    ctx.save();
    tracePath(ctx, panel.shape, m, true);
    ctx.clip();
    ctx.strokeStyle = fill === "black" ? "rgba(255, 255, 255, 0.6)" : EFFECT_INK;
    ctx.lineWidth = Math.max(0.2 * m.scale, minWidthPx);
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const [a, b] of lines) {
      ctx.moveTo(a[0] * m.scale + m.x, a[1] * m.scale + m.y);
      ctx.lineTo(b[0] * m.scale + m.x, b[1] * m.scale + m.y);
    }
    ctx.stroke();
    for (const star of stars) {
      tracePath(ctx, star, m, true);
      ctx.stroke();
    }
    ctx.restore();
  }
  for (const breakout of page.breakouts ?? []) {
    if (breakout.shape.length < 3) continue;
    tracePath(ctx, breakout.shape, m, true);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }
}

/** Panel borders as drawn (open edges, insets and はみ出し taken out). */
export function drawPanelBorders(
  ctx: CanvasRenderingContext2D,
  page: Page,
  m: MmToPx,
  color: (panel: Panel) => string = () => INK,
  minWidthPx = 1,
): void {
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";
  for (const line of borderLines(page)) {
    ctx.strokeStyle = color(line.panel);
    ctx.lineWidth = Math.max(borderWidthMm(line.panel) * m.scale, minWidthPx);
    const parts = line.panel.border === "dashed" ? dashes(line.points, line.closed).map((points) => ({ points, closed: false })) : [line];
    for (const part of parts) {
      tracePath(ctx, part.points, m, part.closed);
      ctx.stroke();
    }
  }
}

/** Balloons of a page: tails, links, shapes, 白抜き. */
export function drawBalloons(ctx: CanvasRenderingContext2D, page: Page, m: MmToPx, minWidthPx = 0.8): void {
  const width = Math.max(BALLOON_LINE_MM * m.scale, minWidthPx);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const balloon of pageBalloons(page)) {
    const fill = balloon.inverted ? INK : "#ffffff";
    ctx.strokeStyle = INK;
    ctx.lineWidth = width;
    for (const extra of balloon.extras) {
      tracePath(ctx, extra.points, m, extra.closed);
      if (extra.closed) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.stroke();
    }
    if (balloon.outline.length < 3) continue;
    tracePath(ctx, balloon.outline, m, true);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.setLineDash(balloon.shape === "dashed" ? [Math.max(1.6 * m.scale, 3), Math.max(1.2 * m.scale, 2)] : []);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** Rough lines under the panel borders, or (over) those drawn in a はみ出し. */
export function drawStrokes(ctx: CanvasRenderingContext2D, page: Page, m: MmToPx, over: boolean, color: (stroke: Stroke) => string, minWidthPx?: number): void {
  for (const stroke of page.strokes) if (!!stroke.over === over) drawStroke(ctx, stroke, m, color(stroke), minWidthPx);
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
      color: line.inverted ? "#ffffff" : undefined,
      bold: line.emphasis,
    },
    { scale: m.scale, offsetX: m.x, offsetY: m.y },
  );
}

export function mapPoint([x, y]: Point, m: MmToPx): Point {
  return [x * m.scale + m.x, y * m.scale + m.y];
}

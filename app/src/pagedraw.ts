// Drawing the parts of a name page (mm coordinates) onto a 2D canvas, shared
// by the editor and the export (CSP layers, PDF).
import { opacityAt, widthFactors } from "./brush";
import { MM_PER_PT, type Brush, type Line, type Panel, type Point, type Stroke } from "./project";
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

/**
 * Rough lines, thinner where the pen pressed lightly. With a brush, its
 * pressure curves, 入り抜き and opacity apply, and a tip picture (or a flat
 * tip) is stamped along the line.
 */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  m: MmToPx,
  color: string,
  minWidthPx = 0.7,
  brush?: Brush,
): void {
  const points = stroke.points;
  const factors = widthFactors(stroke, brush);
  const widthPx = (i: number) => Math.max(stroke.widthMm * factors[i] * m.scale, minWidthPx);
  if (brush && points.length && stampTip(brush)) {
    stampStroke(ctx, stroke, brush, m, color, widthPx);
    return;
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 1; i < points.length; i++) {
    ctx.lineWidth = (widthPx(i - 1) + widthPx(i)) / 2;
    ctx.globalAlpha = opacityAt(brush, (points[i - 1][2] + points[i][2]) / 2);
    ctx.beginPath();
    ctx.moveTo(points[i - 1][0] * m.scale + m.x, points[i - 1][1] * m.scale + m.y);
    ctx.lineTo(points[i][0] * m.scale + m.x, points[i][1] * m.scale + m.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Whether the brush is drawn by stamping its tip rather than as a round line. */
function stampTip(brush: Brush): boolean {
  return (!!brush.tip?.enabled && !!tipImage(brush.tip.pngBase64)) || brush.thickness < 95;
}

const tipImages = new Map<string, HTMLImageElement | null>();
const tintedTips = new Map<string, HTMLCanvasElement>();
let tipLoaded: (() => void) | null = null;

/** Called when a tip picture finishes loading, so the view can redraw. */
export function onTipLoaded(callback: () => void): void {
  tipLoaded = callback;
}

/** The decoded tip picture, or null while it loads (it then draws as a round line). */
function tipImage(pngBase64: string): HTMLImageElement | null {
  const cached = tipImages.get(pngBase64);
  if (cached !== undefined) return cached && cached.complete && cached.naturalWidth ? cached : null;
  if (typeof Image === "undefined") return null;
  const image = new Image();
  tipImages.set(pngBase64, image);
  image.onload = () => tipLoaded?.();
  image.onerror = () => tipImages.set(pngBase64, null);
  image.src = `data:image/png;base64,${pngBase64}`;
  return null;
}

/** Load every tip picture of the brushes (before drawing pages off screen). */
export async function loadTips(brushes: Brush[]): Promise<void> {
  await Promise.all(
    brushes
      .filter((brush) => brush.tip?.enabled)
      .map(
        (brush) =>
          new Promise<void>((resolve) => {
            const image = tipImages.get(brush.tip!.pngBase64) ?? (tipImage(brush.tip!.pngBase64), tipImages.get(brush.tip!.pngBase64));
            if (!image || (image.complete && image.naturalWidth)) return resolve();
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => resolve(), { once: true });
          }),
      ),
  );
}

/** The tip in `color`; a flat ellipse when the brush has no picture. */
function tintedTip(brush: Brush, color: string): HTMLCanvasElement | null {
  const image = brush.tip?.enabled ? tipImage(brush.tip.pngBase64) : null;
  const key = `${image ? brush.tip!.pngBase64.slice(0, 64) + brush.tip!.pngBase64.length : "ellipse"}|${color}`;
  const cached = tintedTips.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const size = 128;
  canvas.width = image ? image.naturalWidth : size;
  canvas.height = image ? image.naturalHeight : size;
  const tctx = canvas.getContext("2d");
  if (!tctx) return null;
  if (image) tctx.drawImage(image, 0, 0);
  else {
    tctx.beginPath();
    tctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    tctx.fill();
  }
  tctx.globalCompositeOperation = "source-in";
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, canvas.width, canvas.height);
  tintedTips.set(key, canvas);
  return canvas;
}

const MAX_STAMPS = 6000;

/** Stamp the tip along the line every `interval` % of its size. */
function stampStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  brush: Brush,
  m: MmToPx,
  color: string,
  widthPx: (i: number) => number,
): void {
  const tip = tintedTip(brush, color);
  if (!tip) return;
  const points = stroke.points.map(([x, y, p]) => [x * m.scale + m.x, y * m.scale + m.y, p]);
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  const interval = Math.max((brush.tip?.enabled ? brush.tip.interval : 10) / 100, 0.02);
  const aspect = tip.height / tip.width;
  const flat = Math.max(brush.thickness, 1) / 100;
  const angle = (brush.rotation * Math.PI) / 180;
  ctx.save();
  const stamp = (x: number, y: number, width: number, pressure: number) => {
    ctx.globalAlpha = opacityAt(brush, pressure);
    const height = width * aspect * flat;
    if (angle === 0) {
      ctx.drawImage(tip, x - width / 2, y - height / 2, width, height);
      return;
    }
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.drawImage(tip, -width / 2, -height / 2, width, height);
    ctx.rotate(-angle);
    ctx.translate(-x, -y);
  };
  // Space stamps by the local width, but never more than MAX_STAMPS per line.
  const minStep = length / MAX_STAMPS;
  let carry = 0;
  stamp(points[0][0], points[0][1], widthPx(0), points[0][2]);
  for (let i = 1; i < points.length; i++) {
    const [x0, y0, p0] = points[i - 1];
    const [x1, y1, p1] = points[i];
    const segment = Math.hypot(x1 - x0, y1 - y0);
    if (segment === 0) continue;
    let at = carry;
    for (;;) {
      const t = at / segment;
      const width = widthPx(i - 1) + (widthPx(i) - widthPx(i - 1)) * Math.min(t, 1);
      const step = Math.max(width * interval, 0.5, minStep);
      at += step;
      if (at > segment) {
        carry = at - segment;
        break;
      }
      const u = at / segment;
      stamp(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, width, p0 + (p1 - p0) * u);
    }
  }
  ctx.restore();
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

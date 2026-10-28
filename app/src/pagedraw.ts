// Drawing the parts of a name page (mm coordinates) onto a 2D canvas, shared
// by the editor and the export (CSP layers, PDF).
import { pageBalloons } from "./balloon";
import { maskShape } from "./mask";
import { opacityFactors, widthFactors } from "./brush";
import { lineBold, lineFont } from "./fonts";
import { borderLines, borderWidthMm, dashes, effectStrokes, stacked } from "./koma";
import { MM_PER_PT } from "./project";
import { drawText } from "./render";
import { balloonLineMm, linePitch } from "./style";
import type { MmToPx } from "./geometry";
import { panelArea, panelsAbove, type PanelFolder } from "./panelfolders";
import type { Brush, Line, Page, PageFormat, Panel, Point, Project, Stroke, StrokePoint } from "./model";
import { markColor, markLayersOf, opacityOfLayer, strokesOn } from "./roughlayers";

export type { MmToPx };

export const INK = "#1b1a18";
/** Line widths on the manuscript, in mm. */

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
  paintSegments(ctx, stroke, m, color, minWidthPx, brush, 0, 0, false);
}

/**
 * The segments of a line from point `from` on (with a tip stamped, from
 * `carry` px past the last stamp); returns the carry at its end, for the
 * segments added next. Drawing a line in pieces this way gives the pixels of
 * drawing it whole.
 */
function paintSegments(ctx: CanvasRenderingContext2D, stroke: Stroke, m: MmToPx, color: string, minWidthPx: number, brush: Brush | undefined, from: number, carry: number, growing: boolean): number {
  const points = stroke.points;
  // The points before `from` - 1 are not drawn: their widths are not worked out.
  const factors = widthFactors(stroke, brush, from - 1, growing);
  const widthPx = (i: number) => Math.max(stroke.widthMm * factors[i] * m.scale, minWidthPx);
  const opacity = opacityFactors(stroke, brush, from - 1);
  if (brush && points.length && stampTip(brush)) return stampStroke(ctx, stroke, brush, m, color, widthPx, opacity, from, carry);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = Math.max(1, from); i < points.length; i++) {
    ctx.lineWidth = (widthPx(i - 1) + widthPx(i)) / 2;
    ctx.globalAlpha = (opacity[i - 1] + opacity[i]) / 2;
    ctx.beginPath();
    ctx.moveTo(points[i - 1][0] * m.scale + m.x, points[i - 1][1] * m.scale + m.y);
    ctx.lineTo(points[i][0] * m.scale + m.x, points[i][1] * m.scale + m.y);
    ctx.stroke();
  }
  ctx.restore();
  return 0;
}

/**
 * A line as it is drawn, painted onto `target` a little at a time: each frame
 * only what the pen added since the last, so a long line costs no more per
 * frame than a short one. The end is left open (抜き comes when the pen
 * lifts, as in CSP) and 入り goes by the length drawn, so what is painted
 * stays as it is.
 */
export class LiveLine {
  private painted = 0;
  private carry = 0;
  private view = "";

  constructor(private readonly target: CanvasRenderingContext2D) {}

  /** Paint the points added since the last call; false when the view moved since (the target must be filled again, then `paint` from the start). */
  paint(points: readonly StrokePoint[], widthMm: number, m: MmToPx, color: string, brush?: Brush): boolean {
    const t = this.target.getTransform();
    const view = `${m.scale},${m.x},${m.y},${t.a},${t.b},${t.c},${t.d},${t.e},${t.f}`;
    const same = !this.view || view === this.view;
    if (!same) {
      this.painted = 0;
      this.carry = 0;
    }
    this.view = view;
    if (points.length > this.painted) {
      this.carry = paintSegments(this.target, liveStroke(points, widthMm, brush), m, color, LIVE_MIN_WIDTH_PX, brush, this.painted, this.carry, true);
      this.painted = points.length;
    }
    return same;
  }

  /** On `ctx` (the screen), the line on from its painted end through `ahead` (where the pen is about to be), left as it is. */
  ahead(ctx: CanvasRenderingContext2D, points: readonly StrokePoint[], ahead: readonly StrokePoint[], widthMm: number, m: MmToPx, color: string, brush?: Brush): void {
    if (!ahead.length || !points.length) return;
    paintSegments(ctx, liveStroke([...points, ...ahead], widthMm, brush), m, color, LIVE_MIN_WIDTH_PX, brush, points.length, this.carry, true);
  }
}

/** The thinnest a line being drawn shows (px). */
const LIVE_MIN_WIDTH_PX = 0.7;

function liveStroke(points: readonly StrokePoint[], widthMm: number, brush?: Brush): Stroke {
  return { id: "", points: points as StrokePoint[], widthMm, closed: false, brush: brush?.id, cut: [false, true] };
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
  if (cached !== undefined) return cached?.complete && cached.naturalWidth ? cached : null;
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

/** Stamp the tip along the line every `interval` % of its size (from point `from` on, `carried` px past the last stamp); returns the carry at the end. */
function stampStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  brush: Brush,
  m: MmToPx,
  color: string,
  widthPx: (i: number) => number,
  opacity: number[],
  from = 0,
  carried = 0,
): number {
  const tip = tintedTip(brush, color);
  if (!tip) return carried;
  const points = stroke.points.map(([x, y], i) => [x * m.scale + m.x, y * m.scale + m.y, opacity[i]]);
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  const interval = Math.max((brush.tip?.enabled ? brush.tip.interval : 10) / 100, 0.02);
  const aspect = tip.height / tip.width;
  const flat = Math.max(brush.thickness, 1) / 100;
  const angle = (brush.rotation * Math.PI) / 180;
  ctx.save();
  const stamp = (x: number, y: number, width: number, alpha: number) => {
    ctx.globalAlpha = alpha;
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
  let carry = carried;
  if (from === 0) stamp(points[0][0], points[0][1], widthPx(0), points[0][2]);
  for (let i = Math.max(1, from); i < points.length; i++) {
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
  return carry;
}

/** Ink for background effects: light, so they read as notes under the drawing. */
const EFFECT_INK = "rgba(27, 26, 24, 0.45)";
const FILLS: Record<string, string> = { white: "#ffffff", black: INK, gray: "#b9b6b0" };

/** 投げなわ塗り: the page's filled areas, in the order they were made. */
export function drawPageFills(ctx: CanvasRenderingContext2D, page: Page, m: MmToPx, outline?: (id: string) => string | null): void {
  for (const fill of page.fills ?? []) {
    tracePath(ctx, fill.shape, m, true);
    ctx.fillStyle = FILLS[fill.tone ?? "black"];
    ctx.fill();
    const color = outline?.(fill.id);
    if (color) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

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

/** Pencil grey: 仮のコマ on the screen. */
export const PENCIL = "#5b6b82";

/** Panel borders as drawn (open edges, insets and はみ出し taken out); `pencil`: 仮のコマ drawn as by hand (the screen). */
export function drawPanelBorders(
  ctx: CanvasRenderingContext2D,
  page: Page,
  m: MmToPx,
  color: (panel: Panel) => string = () => INK,
  minWidthPx = 1,
  pencil = false,
): void {
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";
  for (const line of borderLines(page)) {
    if (pencil && line.panel.draft) {
      drawPencil(ctx, line.points, line.closed, m, color(line.panel), line.panel.id);
      continue;
    }
    ctx.strokeStyle = color(line.panel);
    ctx.lineWidth = Math.max(borderWidthMm(line.panel) * m.scale, minWidthPx);
    const parts = line.panel.border === "dashed" ? dashes(line.points, line.closed).map((points) => ({ points, closed: false })) : [line];
    for (const part of parts) {
      tracePath(ctx, part.points, m, part.closed);
      ctx.stroke();
    }
  }
}

/**
 * A border drawn as by hand in pencil (仮のコマ): each edge twice, a little
 * wavy and running past the corners, the same each time for the same panel.
 */
function drawPencil(ctx: CanvasRenderingContext2D, points: readonly Point[], closed: boolean, m: MmToPx, color: string, seed: string): void {
  let state = [...seed].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 2147483647, 7) || 7;
  const random = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647 - 0.5;
  };
  const wave = Math.min(0.45, 2 / m.scale);
  const past = Math.min(1.6, 6 / m.scale);
  ctx.save();
  ctx.strokeStyle = color === INK ? PENCIL : color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const count = closed ? points.length : points.length - 1;
  for (const pass of [0, 1]) {
    ctx.globalAlpha = pass ? 0.55 : 0.85;
    ctx.lineWidth = Math.max((pass ? 0.18 : 0.3) * m.scale, pass ? 0.7 : 1.1);
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 0.1) continue;
      const [dx, dy] = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
      // Past the corner at each end, a different amount each pass.
      const from = -past * (0.4 + random() + 0.5);
      const to = length + past * (0.4 + random() + 0.5);
      const steps = Math.max(2, Math.ceil(length / 7));
      for (let k = 0; k <= steps; k++) {
        const t = from + ((to - from) * k) / steps;
        const off = k === 0 || k === steps ? 0 : random() * 2 * wave;
        const x = (a[0] + dx * t - dy * off) * m.scale + m.x;
        const y = (a[1] + dy * t + dx * off) * m.scale + m.y;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Balloons of a page: tails, links, shapes, 白抜き. */
export function drawBalloons(ctx: CanvasRenderingContext2D, page: Page, m: MmToPx, minWidthPx = 0.8): void {
  const width = Math.max(balloonLineMm() * m.scale, minWidthPx);
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

/**
 * Only the paper of the balloons: white, or black when inverted. Vector
 * layers in CSP hold lines only, so this goes as an image layer under them.
 */
export function drawBalloonFills(ctx: CanvasRenderingContext2D, page: Page, m: MmToPx): void {
  for (const balloon of pageBalloons(page)) {
    ctx.fillStyle = balloon.inverted ? INK : "#ffffff";
    for (const extra of balloon.extras) {
      if (!extra.closed) continue;
      tracePath(ctx, extra.points, m, true);
      ctx.fill();
    }
    if (balloon.outline.length < 3) continue;
    tracePath(ctx, balloon.outline, m, true);
    ctx.fill();
  }
}

/** All the words of a page; a masked line's no further than its panel. */
export function drawPageTexts(ctx: CanvasRenderingContext2D, page: Page, m: MmToPx): void {
  for (const line of page.lines) {
    const panel = line.mask ? page.panels.find((p) => p.id === line.panel) : undefined;
    const clip = panel && maskShape(panel);
    if (!clip) {
      drawLineText(ctx, line, m);
      continue;
    }
    ctx.save();
    tracePath(ctx, clip, m, true);
    ctx.clip();
    drawLineText(ctx, line, m);
    ctx.restore();
  }
}

/** Rough lines under the panel borders, or (over) those drawn in a はみ出し. */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  page: Page,
  m: MmToPx,
  over: boolean,
  color: (stroke: Stroke) => string,
  minWidthPx?: number,
  brushes: Brush[] = [],
): void {
  for (const stroke of page.strokes) {
    if (!!stroke.over !== over) continue;
    drawStroke(ctx, stroke, m, color(stroke), minWidthPx, brushes.find((brush) => brush.id === stroke.brush));
  }
}

/** 指示 over the page, each 指示のレイヤー in its colour (`all`: the hidden ones too). */
export function drawMarks(ctx: CanvasRenderingContext2D, project: Pick<Project, "roughLayers" | "brushes">, page: Page, m: MmToPx, minWidthPx?: number, all = false): void {
  for (const layer of markLayersOf(project)) {
    if (layer.hidden && !all) continue;
    const strokes = strokesOn(project, page.strokes, layer).map((stroke) => (stroke.over ? { ...stroke, over: false } : stroke));
    if (!strokes.length) continue;
    const color = markColor(layer);
    ctx.save();
    ctx.globalAlpha *= opacityOfLayer(layer);
    drawStrokes(ctx, { ...page, strokes }, m, false, () => color, minWidthPx, project.brushes);
    ctx.restore();
  }
}

export function drawLineText(ctx: CanvasRenderingContext2D, line: Line, m: MmToPx): void {
  drawText(
    ctx,
    {
      text: line.text,
      bbox: line.box,
      fontSizePx: line.fontSizePt * MM_PER_PT,
      fontName: lineFont(line),
      vertical: line.vertical,
      inBalloon: !!line.balloon,
      color: line.inverted ? "#ffffff" : undefined,
      bold: lineBold(line),
      pitch: linePitch(),
    },
    { scale: m.scale, offsetX: m.x, offsetY: m.y },
  );
}

export function mapPoint([x, y]: Point, m: MmToPx): Point {
  return [x * m.scale + m.x, y * m.scale + m.y];
}

/**
 * Draw a folder's mask (opaque where it shows) on a clear canvas; `clip`
 * keeps each page's part to its own half of a spread page.
 */
export function drawPanelMask(
  ctx: CanvasRenderingContext2D,
  folder: PanelFolder,
  format: PageFormat,
  scale: (m: MmToPx) => MmToPx,
  clip: (right: boolean, draw: () => void) => void,
): void {
  for (const { page, m, right, panel } of folder.parts) {
    const at = scale(m);
    clip(right, () => {
      ctx.save();
      ctx.fillStyle = "#000";
      for (const shape of panelArea(page, panel, format)) {
        tracePath(ctx, shape, at, true);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "destination-out";
      for (const shape of panelsAbove(page, panel)) {
        tracePath(ctx, shape, at, true);
        ctx.fill();
      }
      ctx.restore();
    });
  }
}

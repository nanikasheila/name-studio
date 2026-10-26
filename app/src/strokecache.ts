// The rough lines of each page, drawn once into a picture and reused while
// they do not change. Lines are most of a drawn name and the slowest part to
// draw (every segment has its own width), so moving about, dragging a panel
// or seeing all pages at once (連続) would otherwise draw every line of every
// page on each frame. While the view is zoomed the old picture is stretched,
// and drawn again sharp once the zoom stops.
import { drawStrokes, type MmToPx } from "./pagedraw";
import type { Brush, Page, Stroke } from "./model";
import { listId } from "./snapshot";

/** A picture larger than this (device pixels) is not kept: the page is drawn directly. */
const MAX_PIXELS = 12_000_000;
/** All pictures together stay under this (device pixels, about 4 bytes each). */
const BUDGET_PIXELS = 64_000_000;
/** After the last change of scale, a stretched picture is drawn again sharp. */
export const SETTLE_MS = 160;
/**
 * Pictures of pages are drawn for about this long a frame (pages seen for
 * the first time, as in 連続 with many pages, and pages drawn sharp after a
 * zoom); the rest follow in the next frames, so the view never stops for all
 * of them at once. A page whose lines changed is drawn at once.
 */
const NEW_PAGES_MS = 12;

interface Layer {
  /** What was drawn, except the scale. */
  content: string;
  scale: number;
  pixelScale: number;
  canvas: HTMLCanvasElement;
  /** The scale asked for last and when that changed (to tell a zoom from a still view). */
  asked: number;
  askedAt: number;
  used: number;
}

export interface StrokeStyle {
  color: (stroke: Stroke) => string;
  minWidthPx: number;
  brushes: Brush[];
}

export class StrokeCache {
  private layers = new Map<string, Layer>();
  private tips = 0;
  private settle = 0;
  private clock = 0;
  /** Time spent this frame drawing pictures of pages seen for the first time. */
  private spent = 0;

  /** `redraw` is asked for when a stretched picture should be drawn again sharp, or pages wait for their picture (next frame). */
  constructor(
    private readonly redraw: () => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** A brush tip picture finished loading: lines drawn before it change. */
  tipsChanged(): void {
    this.tips += 1;
  }

  /** A frame begins: pages new to it get their share of time again. */
  startFrame(): void {
    this.spent = 0;
  }

  /** Forget pages not drawn since `keep` (the pages on screen are kept). */
  forget(keep: Set<string>): void {
    for (const key of this.layers.keys()) if (!keep.has(key.slice(0, key.indexOf("|")))) this.layers.delete(key);
  }

  clear(): void {
    this.layers.clear();
  }

  /**
   * Draw the page's lines that go under (or over) the panel borders, as
   * `drawStrokes` would, at `m` on `ctx` (whose transform maps to device pixels).
   * `layer` keeps the picture of each ラフ線のレイヤー apart, with only its lines.
   */
  draw(ctx: CanvasRenderingContext2D, page: Page, size: [number, number], m: MmToPx, over: boolean, style: StrokeStyle, layerId = "", only?: Stroke[]): void {
    const strokes = (only ?? page.strokes).filter((stroke) => !!stroke.over === over);
    if (!strokes.length) return;
    const t = ctx.getTransform();
    const pixelScale = Math.hypot(t.a, t.b);
    const [w, h] = [size[0] * m.scale, size[1] * m.scale];
    if (w * h * pixelScale * pixelScale > MAX_PIXELS || typeof document === "undefined") {
      drawStrokes(ctx, { ...page, strokes }, m, over, style.color, style.minWidthPx, style.brushes);
      return;
    }
    const key = `${page.id}|${layerId}|${over ? 1 : 0}`;
    const content = this.content(strokes, style);
    const now = this.now();
    let layer = this.layers.get(key);
    if (layer && layer.asked !== m.scale) {
      layer.asked = m.scale;
      layer.askedAt = now;
    }
    const fresh = layer?.content === content && layer.pixelScale === pixelScale;
    if (!layer || !fresh || layer.scale !== m.scale) {
      if (layer && fresh && now - layer.askedAt < SETTLE_MS) {
        // Zooming: the old picture, stretched, until the scale stays put.
        this.scheduleSettle();
      } else if ((!layer || fresh) && this.spent > NEW_PAGES_MS) {
        // A page seen for the first time, or one to draw sharp at its new size: its turn comes in a later frame.
        this.redraw();
        if (!layer) return;
      } else {
        const start = this.now();
        layer = this.paint(key, layer, strokes, size, m.scale, pixelScale, content, style);
        this.spent += this.now() - start;
      }
    }
    layer.used = ++this.clock;
    // Pictures sit on whole device pixels, so they are as sharp as drawing directly.
    let [x, y] = [m.x, m.y];
    if (t.b === 0 && t.c === 0) {
      x = (Math.round(t.a * x + t.e) - t.e) / t.a;
      y = (Math.round(t.d * y + t.f) - t.f) / t.d;
    }
    const k = m.scale / layer.scale;
    ctx.drawImage(layer.canvas, x, y, (layer.canvas.width / layer.pixelScale) * k, (layer.canvas.height / layer.pixelScale) * k);
  }

  private content(strokes: Stroke[], style: StrokeStyle): string {
    const parts = [String(this.tips), String(style.minWidthPx)];
    const brushes = new Set<string>();
    for (const stroke of strokes) {
      parts.push(`${listId(stroke.points)},${stroke.widthMm},${stroke.brush ?? ""},${stroke.cut?.join() ?? ""},${style.color(stroke)}`);
      if (stroke.brush) brushes.add(stroke.brush);
    }
    // A brush edited (or taken again from CSP) draws its lines anew.
    for (const brush of style.brushes) if (brushes.has(brush.id)) parts.push(JSON.stringify(brush));
    return parts.join(";");
  }

  private paint(
    key: string,
    old: Layer | undefined,
    strokes: Stroke[],
    size: [number, number],
    scale: number,
    pixelScale: number,
    content: string,
    style: StrokeStyle,
  ): Layer {
    const canvas = old?.canvas ?? document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(size[0] * scale * pixelScale));
    canvas.height = Math.max(1, Math.ceil(size[1] * scale * pixelScale));
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawStrokes(ctx, { strokes } as Page, { scale, x: 0, y: 0 }, !!strokes[0]?.over, style.color, style.minWidthPx, style.brushes);
    const layer: Layer = { content, scale, pixelScale, canvas, asked: scale, askedAt: old?.askedAt ?? 0, used: ++this.clock };
    this.layers.set(key, layer);
    this.keepBudget();
    return layer;
  }

  private keepBudget(): void {
    let total = 0;
    for (const layer of this.layers.values()) total += layer.canvas.width * layer.canvas.height;
    if (total <= BUDGET_PIXELS) return;
    const oldest = [...this.layers.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key, layer] of oldest) {
      if (total <= BUDGET_PIXELS) break;
      total -= layer.canvas.width * layer.canvas.height;
      layer.canvas.width = 0;
      this.layers.delete(key);
    }
  }

  private scheduleSettle(): void {
    if (this.settle) clearTimeout(this.settle);
    this.settle = window.setTimeout(() => {
      this.settle = 0;
      this.redraw();
    }, SETTLE_MS + 10);
  }
}

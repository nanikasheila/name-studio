// The brush settings' two drawing boxes: the 試し描き pad, where lines drawn
// with the brush being set redraw at once as its settings change, and the
// graph of one input of a 影響元設定 (pressure, tilt or speed in, share of
// the value out), whose points are dragged.
import { curveAt, FULL_SPEED_MM, followFactor, postCorrect, tiltOf } from "./brush";
import type { Graph } from "./cspsettings";
import type { Brush, Stroke, StrokePoint } from "./model";
import { drawStroke, INK, loadTips } from "./pagedraw";
import { adjustPressure, pressureReading } from "./pen";
import { penPreferences } from "./prefs";

/** Pad pixels (CSS) per page mm: a 0.5 mm pen is 4 px. */
const PAD_SCALE = 8;

/** A line across the pad, light to firm to light, for when nothing is drawn yet. */
function sampleStrokes(widthMm: number, heightMm: number): Stroke[] {
  const strokes: Stroke[] = [];
  const rows = [0.3, 0.7];
  rows.forEach((row, n) => {
    const points: StrokePoint[] = [];
    const count = 80;
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const x = 4 + t * (widthMm - 8);
      const y = heightMm * row + Math.sin(t * Math.PI * (n ? 3 : 2)) * heightMm * 0.12;
      // The first line slow, the second quick.
      points.push([x, y, Math.max(0.05, Math.sin(t * Math.PI)), 0, n ? 0.8 : 0.15]);
    }
    strokes.push({ id: `sample${n}`, points, widthMm: 1, closed: false });
  });
  return strokes;
}

export class BrushPad {
  private strokes: Stroke[] = [];
  private drawing: { stroke: Stroke; last: StrokePoint; time: number; speed: number } | null = null;
  private brush: Brush | null = null;
  private count = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener("pointerdown", (event) => this.down(event));
    canvas.addEventListener("pointermove", (event) => this.move(event));
    canvas.addEventListener("pointerup", () => this.up());
    canvas.addEventListener("pointercancel", () => this.up());
  }

  /** Draw the lines again with `brush` (as it is set now). */
  show(brush: Brush | null): void {
    this.brush = brush;
    if (brush?.tip?.enabled) void loadTips([brush]).then(() => this.brush === brush && this.render());
    this.render();
  }

  clear(): void {
    this.strokes = [];
    this.render();
  }

  private size(): [number, number] {
    const width = this.canvas.clientWidth || this.canvas.width;
    const height = this.canvas.clientHeight || this.canvas.height;
    return [width, height];
  }

  private render(): void {
    const [width, height] = this.size();
    const ratio = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * ratio)) this.canvas.width = Math.round(width * ratio);
    if (this.canvas.height !== Math.round(height * ratio)) this.canvas.height = Math.round(height * ratio);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const brush = this.brush;
    if (!brush) return;
    const m = { scale: PAD_SCALE * ratio, x: 0, y: 0 };
    const eraser = brush.kind === "eraser";
    // An eraser shows where it would erase.
    const color = eraser ? "rgba(214, 72, 72, 0.55)" : INK;
    const strokes = this.strokes.length || this.drawing ? this.strokes : sampleStrokes(width / PAD_SCALE, height / PAD_SCALE);
    for (const stroke of [...strokes, ...(this.drawing ? [this.drawing.stroke] : [])]) {
      drawStroke(ctx, { ...stroke, widthMm: brush.sizeMm }, m, color, 0.7, brush);
    }
  }

  private point(event: PointerEvent): StrokePoint {
    const reading = pressureReading(event.pointerType, event.pressure);
    const pressure = Math.max(0.05, adjustPressure(penPreferences.settings.pressureCurve, reading ?? 0.5));
    const tilt = penPreferences.settings.tilt ? tiltOf(event) : 0;
    return [event.offsetX / PAD_SCALE, event.offsetY / PAD_SCALE, pressure, tilt, this.drawing?.speed ?? 0];
  }

  private down(event: PointerEvent): void {
    if (!this.brush) return;
    this.canvas.setPointerCapture(event.pointerId);
    const point = this.point(event);
    this.drawing = { stroke: { id: `try${this.count++}`, points: [point], widthMm: 1, closed: false }, last: point, time: event.timeStamp, speed: 0 };
  }

  private move(event: PointerEvent): void {
    const drawing = this.drawing;
    if (!drawing || !this.brush) return;
    for (const e of event.getCoalescedEvents?.() ?? [event]) {
      const raw = this.point(e);
      const seconds = (e.timeStamp - drawing.time) / 1000;
      if (seconds > 0) {
        const speed = Math.hypot(raw[0] - drawing.last[0], raw[1] - drawing.last[1]) / seconds / FULL_SPEED_MM;
        drawing.speed += (Math.min(speed, 1) - drawing.speed) * 0.3;
        drawing.time = e.timeStamp;
      }
      raw[4] = drawing.speed;
      // 手ブレ補正 as the page's pen has it.
      const follow = followFactor(this.brush.stabilization, drawing.speed, this.brush.stabilizationBySpeed);
      const previous = drawing.stroke.points[drawing.stroke.points.length - 1];
      drawing.stroke.points.push(previous.map((value, i) => value + (raw[i] - value) * follow) as StrokePoint);
      drawing.last = raw;
    }
    this.render();
  }

  private up(): void {
    const drawing = this.drawing;
    if (!drawing) return;
    this.drawing = null;
    const points = drawing.stroke.points;
    if (points.length > 1) points.push(drawing.last);
    drawing.stroke.points = postCorrect(points, this.brush?.postCorrection ?? 0);
    this.strokes.push(drawing.stroke);
    // Only the last few: the pad is for trying, not keeping.
    if (this.strokes.length > 12) this.strokes.shift();
    this.render();
  }
}

/** Graph px of a point (input right, value up), with room for the points at the edges. */
const DOT = 5;

/**
 * The graph of one input. Points are dragged (the ends up and down only), a
 * press between them adds one and a double click takes one away; `changing`
 * follows the drag, `changed` comes once it ends.
 */
export class GraphBox {
  readonly canvas: HTMLCanvasElement;
  private points: Graph;
  private dragging = -1;

  constructor(
    points: Graph,
    private readonly changing: (points: Graph) => void,
    private readonly changed: (points: Graph) => void,
    size = 132,
  ) {
    this.points = points.map(([x, y]) => [x, y]);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "be-graph";
    this.canvas.width = size;
    this.canvas.height = size;
    this.canvas.title = "点をドラッグで動かす。線の上を押すと点を足し、点をダブルクリックで消す";
    this.canvas.addEventListener("pointerdown", (event) => this.down(event));
    this.canvas.addEventListener("pointermove", (event) => this.move(event));
    this.canvas.addEventListener("pointerup", () => this.up());
    this.canvas.addEventListener("pointercancel", () => this.up());
    this.canvas.addEventListener("dblclick", (event) => this.remove(event));
    this.draw();
  }

  private toGraph([x, y]: readonly [number, number]): [number, number] {
    const { width, height } = this.canvas;
    return [DOT + x * (width - 2 * DOT), height - DOT - y * (height - 2 * DOT)];
  }

  private fromGraph(gx: number, gy: number): [number, number] {
    const { width, height } = this.canvas;
    const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
    return [clamp((gx - DOT) / (width - 2 * DOT)), clamp((height - DOT - gy) / (height - 2 * DOT))];
  }

  private at(event: MouseEvent): number {
    return this.points.findIndex((point) => {
      const [gx, gy] = this.toGraph(point);
      return Math.hypot(gx - event.offsetX, gy - event.offsetY) <= DOT + 3;
    });
  }

  draw(): void {
    const canvas = this.canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#e4e2dc";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const [gx, gy] = this.toGraph([i / 4, i / 4]);
      ctx.beginPath();
      ctx.moveTo(gx, DOT);
      ctx.lineTo(gx, canvas.height - DOT);
      ctx.moveTo(DOT, gy);
      ctx.lineTo(canvas.width - DOT, gy);
      ctx.stroke();
    }
    ctx.strokeStyle = "#2f6fdb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const x = i / 48;
      const [gx, gy] = this.toGraph([x, curveAt(this.points, x)]);
      if (i) ctx.lineTo(gx, gy);
      else ctx.moveTo(gx, gy);
    }
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    for (const point of this.points) {
      const [gx, gy] = this.toGraph(point);
      ctx.beginPath();
      ctx.arc(gx, gy, DOT - 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  private down(event: PointerEvent): void {
    this.canvas.setPointerCapture(event.pointerId);
    const index = this.at(event);
    if (index >= 0) {
      this.dragging = index;
      return;
    }
    const point = this.fromGraph(event.offsetX, event.offsetY);
    if (point[0] <= this.points[0][0] + 0.01 || point[0] >= this.points[this.points.length - 1][0] - 0.01) return;
    this.points.push(point);
    this.points.sort((a, b) => a[0] - b[0]);
    this.dragging = this.points.indexOf(point);
    this.draw();
    this.changing(this.copy());
  }

  private move(event: PointerEvent): void {
    const index = this.dragging;
    if (index < 0) return;
    const [x, y] = this.fromGraph(event.offsetX, event.offsetY);
    const last = this.points.length - 1;
    // The ends stay at the edges (as CSP's graph); the points between keep their order.
    const nx = index === 0 ? 0 : index === last ? 1 : Math.min(Math.max(x, this.points[index - 1][0] + 0.01), this.points[index + 1][0] - 0.01);
    this.points[index] = [nx, y];
    this.draw();
    this.changing(this.copy());
  }

  private up(): void {
    if (this.dragging < 0) return;
    this.dragging = -1;
    this.changed(this.copy());
  }

  private remove(event: MouseEvent): void {
    const index = this.at(event);
    if (index <= 0 || index >= this.points.length - 1) return;
    this.points.splice(index, 1);
    this.draw();
    this.changed(this.copy());
  }

  private copy(): Graph {
    return this.points.map(([x, y]) => [x, y]);
  }
}

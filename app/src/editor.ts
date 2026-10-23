// The page editor: draws a spread of the name data and turns pointer input
// into edits (select and move, cut panels, place lines, draw and erase).
// Coordinates on a page are millimetres; each page of the spread has its own
// mm → screen mapping.
import { FULL_SPEED_MM, followFactor, tiltOf, usesMotion } from "./brush";
import { spreads } from "./pages";
import { addBreakout, moveBreakout, stacked } from "./koma";
import { INK, drawBalloons, drawLineText, drawPanelBorders, drawPanelFills, drawStroke, drawStrokes, onTipLoaded, tracePath } from "./pagedraw";
import {
  addLine,
  addPanel,
  addStroke,
  assignPanels,
  basicBox,
  bounds,
  cutPanels,
  eraseInside,
  eraseWith,
  insideBox,
  insidePolygon,
  moveLine,
  movePanel,
  moveStroke,
  orderPanels,
  pickInside,
  rectShape,
  snapCut,
  snapLines,
  snapPoint,
  simplify,
  sortLines,
  splitAtX,
  wantsSpread,
  strokeHit,
  trimBox,
  type Brush,
  type EraseMode,
  type Line,
  type Page,
  type Point,
  type Project,
  type RoughImage,
  type Stroke,
  type StrokePoint,
} from "./project";

export type Tool = "select" | "cut" | "text" | "pen" | "eraser" | "breakout";

export interface Selection {
  kind: "panel" | "line" | "stroke" | "breakout" | "group";
  pageId: string;
  id: string;
  /** 範囲選択 ("group"): the rough lines and dialogue picked together. */
  items?: { kind: "stroke" | "line"; id: string }[];
}

/** How the eraser works: CSP's three vector erasers, and 囲って消す. */
export type EditorEraseMode = EraseMode | "lasso";

export const ERASE_MODE_LABELS: Record<EditorEraseMode, string> = {
  touched: "触れた部分",
  intersection: "交点まで",
  whole: "線全体",
  lasso: "囲って消す",
};

/** What the editor needs from the app around it. */
export interface EditorHost {
  project(): Project | null;
  /** Remember the project before a change (for undo). */
  begin(): void;
  /** The change since `begin` is done. */
  commit(): void;
  /** The change since `begin` changed nothing. */
  cancel(): void;
  selectionChanged(selection: Selection | null): void;
  /** Pixels of a rough from the source sheet, or null while they load. */
  rough(rough: RoughImage): CanvasImageSource | null;
  status(message: string): void;
}

interface Slot {
  page: Page;
  index: number;
  x: number;
  y: number;
  scale: number;
  /** Page mm shown, `[x0, x1]`: a page facing another ends at the gutter
   * (the edge of its trim), so the two read as one spread. */
  shown: [number, number];
}

type Drag =
  | { kind: "pan"; x: number; y: number }
  | { kind: "move"; slot: Slot; last: Point; moved: boolean }
  | { kind: "vertex"; slot: Slot; panelId: string; vertex: number; moved: boolean }
  | { kind: "cut"; slot: Slot; a: Point; b: Point; free: boolean }
  | { kind: "frame"; slot: Slot; a: Point; b: Point }
  | { kind: "pen"; slot: Slot; points: StrokePoint[]; last: StrokePoint; motion: boolean; time: number; speed: number }
  | { kind: "tail"; slot: Slot; lineId: string; index: number; moved: boolean }
  | { kind: "lasso"; slot: Slot; points: Point[] }
  | { kind: "pick"; slot: Slot; points: Point[] }
  | { kind: "eraseLasso"; slot: Slot; points: Point[] }
  | { kind: "erase"; slot: Slot; erased: number };

const ACCENT = "#2f6fdb";
const MARGIN = 28;
const HANDLE = 5;

export class PageEditor {
  tool: Tool = "select";
  selection: Selection | null = null;
  spreadIndex = 0;
  firstAlone = true;
  penWidthMm = 0.4;
  /** Brushes in use (ids in the project); null is the plain pen / eraser. */
  penBrush: string | null = null;
  eraserBrush: string | null = null;
  eraserSizeMm = 2;
  /** The eraser's way of erasing; the pen's eraser end uses it too. */
  eraseMode: EditorEraseMode = "whole";
  /** The pen's eraser end is down or hovering: erase whatever the tool. */
  private tipEraser = false;
  /** Snap panel corners to the frames. */
  snap = true;
  private zoom = 1;
  private pan: [number, number] = [0, 0];
  private slots: Slot[] = [];
  private drag: Drag | null = null;
  private spaceHeld = false;
  private pointer: Point | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  /** The pages as drawn when a pen line began: only the new line is drawn over it. */
  private base: HTMLCanvasElement | null = null;
  private frame = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly host: EditorHost) {
    // Low latency: the pen line reaches the screen without waiting for the compositor.
    this.ctx = canvas.getContext("2d", { desynchronized: true })!;
    // A pen held still or its barrel button must not open the context menu.
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    onTipLoaded(() => this.draw());
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
    canvas.addEventListener("pointerleave", () => {
      this.pointer = null;
      this.draw();
    });
    canvas.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    window.addEventListener("keydown", (event) => {
      if (event.code === "Space" && !isTyping(event)) {
        this.spaceHeld = true;
        this.canvas.style.cursor = "grab";
      }
    });
    window.addEventListener("keyup", (event) => {
      if (event.code === "Space") {
        this.spaceHeld = false;
        this.updateCursor();
      }
    });
  }

  // --- spreads --------------------------------------------------------------

  spreadList(): [number | null, number | null][] {
    return spreads(this.host.project()?.pages.length ?? 0, this.firstAlone);
  }

  /** Page numbers (1-based) on the current spread, right page first. */
  currentPages(): number[] {
    const pair = this.spreadList()[this.spreadIndex];
    return pair ? pair.filter((page): page is number => page !== null) : [];
  }

  showPage(pageNumber: number): void {
    const index = this.spreadList().findIndex((pair) => pair.includes(pageNumber));
    if (index >= 0 && index !== this.spreadIndex) {
      this.spreadIndex = index;
      this.resetView();
    }
    this.draw();
  }

  flip(step: number): void {
    const count = this.spreadList().length;
    this.spreadIndex = Math.min(Math.max(this.spreadIndex + step, 0), Math.max(count - 1, 0));
    this.resetView();
    this.draw();
  }

  resetView(): void {
    this.zoom = 1;
    this.pan = [0, 0];
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.updateCursor();
    this.draw();
  }

  select(selection: Selection | null): void {
    this.selection = selection;
    this.host.selectionChanged(selection);
    this.draw();
  }

  /** The page the selection is on, or the right page of the spread. */
  focusPage(): Page | null {
    const project = this.host.project();
    if (!project) return null;
    if (this.selection) {
      const page = project.pages.find((p) => p.id === this.selection!.pageId);
      if (page) return page;
    }
    const [first] = this.currentPages();
    return first ? project.pages[first - 1] : null;
  }

  // --- layout ---------------------------------------------------------------

  resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  }

  private layout(project: Project): Slot[] {
    const pair = this.spreadList()[this.spreadIndex];
    if (!pair) return [];
    const { width, height } = this.canvas.getBoundingClientRect();
    const [pageW, pageH] = project.pageFormat.canvasMm;
    // 見開き: the trims of the two pages meet at the gutter, as in the book.
    const [trimX0, , trimX1] = trimBox(project.pageFormat);
    const spreadMm = trimX1 + (pageW - trimX0);
    const fit = Math.min((width - 2 * MARGIN) / spreadMm, (height - 2 * MARGIN) / pageH);
    const scale = fit * this.zoom;
    const left = (width - spreadMm * scale) / 2 + this.pan[0];
    const top = (height - pageH * scale) / 2 + this.pan[1];
    // Right binding: [right page, left page]; left binding mirrors it.
    const [rightPage, leftPage] = project.binding === "right" ? pair : [pair[1], pair[0]];
    const facing = rightPage !== null && leftPage !== null;
    const slots: Slot[] = [];
    const place = (pageNumber: number | null, x: number, shown: [number, number]) => {
      if (pageNumber === null) return;
      slots.push({ page: project.pages[pageNumber - 1], index: pageNumber - 1, x, y: top, scale, shown });
    };
    place(leftPage, left, facing ? [0, trimX1] : [0, pageW]);
    place(rightPage, left + (trimX1 - trimX0) * scale, facing ? [trimX0, pageW] : [0, pageW]);
    return slots;
  }

  private toPage(slot: Slot, sx: number, sy: number): Point {
    return [(sx - slot.x) / slot.scale, (sy - slot.y) / slot.scale];
  }

  private slotAt(sx: number, sy: number, project: Project): Slot | null {
    const [pageW, pageH] = project.pageFormat.canvasMm;
    return (
      this.slots.find((slot) => {
        const [x, y] = this.toPage(slot, sx, sy);
        // A little room outside the page, but not across the gutter.
        const x0 = slot.shown[0] > 0 ? slot.shown[0] : -10;
        const x1 = slot.shown[1] < pageW ? slot.shown[1] : pageW + 10;
        return x >= x0 && x < x1 && y >= -10 && y <= pageH + 10;
      }) ?? null
    );
  }

  /** The other page of the spread, if `slot` faces one. */
  private facingSlot(slot: Slot): Slot | null {
    // Slots are laid out again on every draw, so match by page.
    return this.slots.find((other) => other.page.id !== slot.page.id) ?? null;
  }

  /** Dialogue and rough lines moved past the gutter go to the facing page. */
  private carryAcrossGutter(slot: Slot): void {
    const s = this.selection;
    const facing = this.facingSlot(slot);
    if (!s || !facing || s.pageId !== slot.page.id) return;
    const items = s.kind === "group" ? (s.items ?? []) : s.kind === "line" || s.kind === "stroke" ? [{ kind: s.kind, id: s.id }] : [];
    const shift = (slot.x - facing.x) / slot.scale;
    const across = (x: number) => (facing.x > slot.x ? x > slot.shown[1] : x < slot.shown[0]);
    const moved: typeof items = [];
    for (const item of items) {
      if (item.kind === "line") {
        const line = slot.page.lines.find((l) => l.id === item.id);
        if (!line || !across((line.box[0] + line.box[2]) / 2)) continue;
        slot.page.lines = slot.page.lines.filter((l) => l !== line);
        moveLine(line, shift, 0);
        delete line.linkTo;
        facing.page.lines.push(line);
        moved.push(item);
      } else {
        const stroke = slot.page.strokes.find((x) => x.id === item.id);
        if (!stroke) continue;
        const [x0, , x1] = bounds(stroke.points.map(([x, y]) => [x, y] as Point));
        if (!across((x0 + x1) / 2)) continue;
        slot.page.strokes = slot.page.strokes.filter((x) => x !== stroke);
        moveStroke(stroke, shift, 0);
        facing.page.strokes.push(stroke);
        moved.push(item);
      }
    }
    if (!moved.length) return;
    // The selection follows when everything went across.
    if (moved.length === items.length) this.selection = { ...s, pageId: facing.page.id };
    else if (s.kind === "group") this.selection = { ...s, items: items.filter((item) => !moved.includes(item)) };
    this.host.selectionChanged(this.selection);
    this.host.status(`${moved.length} 個を向かいのページ（${facing.index + 1} ページ）へ移しました`);
  }

  // --- drawing ----------------------------------------------------------------

  /** Draw on the next frame: pointer events can come many times a frame. */
  private requestDraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw(): void {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    const ctx = this.ctx;
    const { width, height } = this.canvas.getBoundingClientRect();
    if (this.drag?.kind === "pen" && this.base) {
      // While a line is drawn nothing else changes: the pages as they were, then the line.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.base, 0, 0);
      ctx.restore();
      this.drawOverlay();
      return;
    }
    ctx.clearRect(0, 0, width, height);
    const project = this.host.project();
    if (!project) return;
    this.slots = this.layout(project);
    for (const slot of this.slots) this.drawPage(project, slot);
    this.drawSpreadMark(project);
    this.drawOverlay();
  }

  /** 見開きページ: a mark under the gutter when the two pages go to CSP as one. */
  private drawSpreadMark(project: Project): void {
    if (this.slots.length < 2) return;
    const first = Math.min(...this.slots.map((slot) => slot.index));
    if (!wantsSpread(project, first)) return;
    const [left, right] = [...this.slots].sort((a, b) => a.x - b.x);
    const gutter = left.x + left.shown[1] * left.scale;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "#3a6fd8";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("見開きページ", gutter, right.y + project.pageFormat.canvasMm[1] * right.scale + 18);
    ctx.restore();
  }

  private drawPage(project: Project, slot: Slot): void {
    const ctx = this.ctx;
    const { page, scale } = slot;
    const [pageW, pageH] = project.pageFormat.canvasMm;
    const sx = (x: number) => slot.x + x * scale;
    const sy = (y: number) => slot.y + y * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(sx(slot.shown[0]), sy(0), (slot.shown[1] - slot.shown[0]) * scale, pageH * scale);
    ctx.clip();
    ctx.fillStyle = "#eeede9";
    ctx.fillRect(sx(0), sy(0), pageW * scale, pageH * scale);
    const trim = trimBox(project.pageFormat);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(sx(trim[0]), sy(trim[1]), (trim[2] - trim[0]) * scale, (trim[3] - trim[1]) * scale);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx(trim[0]), sy(trim[1]), (trim[2] - trim[0]) * scale, (trim[3] - trim[1]) * scale);
    const basic = basicBox(project.pageFormat);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(47, 111, 219, 0.45)";
    ctx.strokeRect(sx(basic[0]), sy(basic[1]), (basic[2] - basic[0]) * scale, (basic[3] - basic[1]) * scale);
    ctx.setLineDash([]);

    // Roughs from the source sheet, faded so the name reads on top.
    ctx.globalAlpha = 0.45;
    for (const rough of page.roughs) {
      const image = this.host.rough(rough);
      if (!image) continue;
      const [x0, y0, x1, y1] = rough.box;
      ctx.drawImage(image, sx(x0), sy(y0), (x1 - x0) * scale, (y1 - y0) * scale);
    }
    ctx.globalAlpha = 1;

    const m = { scale, x: slot.x, y: slot.y };
    const brushes = this.host.project()?.brushes ?? [];
    const strokeColor = (stroke: Stroke) => (this.isSelected(page, "stroke", stroke.id) ? ACCENT : "#3a3834");
    drawStrokes(ctx, page, m, false, strokeColor, 0.7, brushes);
    drawPanelFills(ctx, page, m);
    const selectedPanel = page.panels.find((panel) => this.isSelected(page, "panel", panel.id));
    if (selectedPanel) {
      tracePath(ctx, selectedPanel.shape, m, true);
      ctx.fillStyle = "rgba(47, 111, 219, 0.08)";
      ctx.fill();
    }
    drawPanelBorders(ctx, page, m, (panel) => (panel === selectedPanel ? ACCENT : INK));
    drawStrokes(ctx, page, m, true, strokeColor, 0.7, brushes);

    // はみ出し: shown by a dashed outline (only here, not in exports).
    for (const breakout of page.breakouts) {
      const selected = this.isSelected(page, "breakout", breakout.id);
      tracePath(ctx, breakout.shape, m, true);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = selected ? ACCENT : "rgba(214, 120, 40, 0.8)";
      ctx.lineWidth = selected ? 2 : 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const panel of stacked(page.panels)) {
      const selected = panel === selectedPanel;
      // Panels with no border at all still show where they are.
      if ((panel.border ?? "solid") === "none" && !selected) {
        tracePath(ctx, panel.shape, m, true);
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = "rgba(47, 111, 219, 0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const [, y0, x1] = bounds(panel.shape);
      const radius = Math.max(4 * scale, 7);
      // Numbers stay inside the page even for panels that run off it.
      const nx = Math.min(sx(x1), sx(pageW)) - radius - 3;
      const ny = Math.max(sy(y0), sy(0)) + radius + 3;
      ctx.fillStyle = selected ? ACCENT : "rgba(47, 111, 219, 0.75)";
      ctx.beginPath();
      ctx.arc(nx, ny, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${Math.round(radius * 1.2)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(panel.order), nx, ny);
      if (selected) {
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        for (const [x, y] of panel.shape) {
          ctx.fillRect(sx(x) - HANDLE, sy(y) - HANDLE, HANDLE * 2, HANDLE * 2);
          ctx.strokeRect(sx(x) - HANDLE, sy(y) - HANDLE, HANDLE * 2, HANDLE * 2);
        }
      }
    }

    drawBalloons(ctx, page, m);
    for (const line of page.lines) this.drawLine(project, slot, line);
    ctx.restore();

    ctx.fillStyle = "#f4f3f0";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const memo = page.memo ? `  ${page.memo.split("\n")[0]}` : "";
    const [trimX0, , trimX1] = trimBox(project.pageFormat);
    ctx.fillText(`${slot.index + 1}${memo}`, sx((trimX0 + trimX1) / 2), sy(pageH) + 18);
  }

  private drawLine(project: Project, slot: Slot, line: Line): void {
    const ctx = this.ctx;
    const { scale } = slot;
    const sx = (x: number) => slot.x + x * scale;
    const sy = (y: number) => slot.y + y * scale;
    const selected = this.isSelected(slot.page, "line", line.id);
    const m = { scale, x: slot.x, y: slot.y };
    drawLineText(ctx, line, m);
    const speaker = project.characters.find((character) => character.id === line.speaker);
    const [x0, y0, x1, y1] = line.box;
    if (speaker) {
      ctx.fillStyle = speaker.color ?? ACCENT;
      ctx.beginPath();
      ctx.arc(sx(x1) + 4, sy(y0) - 4, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (selected) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(sx(x0) - 3, sy(y0) - 3, (x1 - x0) * scale + 6, (y1 - y0) * scale + 6);
      ctx.setLineDash([]);
      // しっぽの先: drag to point at the speaker.
      for (const tail of line.tails ?? []) {
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx(tail.tip[0]), sy(tail.tip[1]), HANDLE, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  private drawOverlay(): void {
    const ctx = this.ctx;
    const drag = this.drag;
    if (drag && (drag.kind === "cut" || drag.kind === "frame")) {
      const { slot } = drag;
      const a = drag.a;
      const b = drag.kind === "cut" && !drag.free ? snapCut(drag.a, drag.b) : drag.b;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      if (drag.kind === "cut") {
        ctx.beginPath();
        ctx.moveTo(slot.x + a[0] * slot.scale, slot.y + a[1] * slot.scale);
        ctx.lineTo(slot.x + b[0] * slot.scale, slot.y + b[1] * slot.scale);
        ctx.stroke();
      } else {
        const [x0, y0, x1, y1] = bounds([a, b]);
        ctx.strokeRect(slot.x + x0 * slot.scale, slot.y + y0 * slot.scale, (x1 - x0) * slot.scale, (y1 - y0) * slot.scale);
      }
      ctx.setLineDash([]);
    }
    if ((drag?.kind === "lasso" || drag?.kind === "pick" || drag?.kind === "eraseLasso") && drag.points.length > 1) {
      const { slot } = drag;
      ctx.strokeStyle = drag.kind === "lasso" ? "rgba(214, 120, 40, 0.9)" : drag.kind === "pick" ? ACCENT : "rgba(192, 57, 43, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      tracePath(ctx, drag.points, { scale: slot.scale, x: slot.x, y: slot.y }, true);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (drag?.kind === "pen") {
      const { slot, points } = drag;
      const brush = this.brush("pen");
      const stroke = { id: "", points, widthMm: this.penWidthMm, closed: false, brush: brush?.id };
      drawStroke(ctx, stroke, { scale: slot.scale, x: slot.x, y: slot.y }, "#3a3834", 0.7, brush);
    }
    if (this.erasing() && this.eraseMode !== "lasso" && this.pointer) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.pointer[0], this.pointer[1], this.eraserRadiusPx(), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** The brush chosen for the pen or the eraser, if it is still in the project. */
  brush(kind: "pen" | "eraser"): Brush | undefined {
    const id = kind === "pen" ? this.penBrush : this.eraserBrush;
    return id ? this.host.project()?.brushes.find((brush) => brush.id === id) : undefined;
  }

  /** The plain eraser is a fixed 8 px on screen; a brush eraser has its size on the page. */
  private eraserRadiusPx(scale = this.slots[0]?.scale ?? 1): number {
    return this.brush("eraser") ? Math.max((this.eraserSizeMm / 2) * scale, 3) : 8;
  }

  private isSelected(page: Page, kind: Selection["kind"], id: string): boolean {
    const s = this.selection;
    if (!s || s.pageId !== page.id) return false;
    if (s.kind === "group") return !!s.items?.some((item) => item.kind === kind && item.id === id);
    return s.kind === kind && s.id === id;
  }

  /** Whether `point` is on one of the picked lines or inside a picked text. */
  private groupHit(page: Page, point: Point, tolerance: number): boolean {
    for (const item of this.selection?.items ?? []) {
      if (item.kind === "stroke") {
        const stroke = page.strokes.find((x) => x.id === item.id);
        if (stroke && strokeHit(stroke, point, tolerance + stroke.widthMm)) return true;
      } else {
        const line = page.lines.find((l) => l.id === item.id);
        if (line && insideBox(line.box, point)) return true;
      }
    }
    return false;
  }

  /** Follow the pen's eraser end (button 5, buttons bit 32) as it comes and goes. */
  private setTipEraser(event: PointerEvent): void {
    const tip = event.pointerType === "pen" && (event.button === 5 || (event.buttons & 32) !== 0);
    if (tip !== this.tipEraser) {
      this.tipEraser = tip;
      this.updateCursor();
    }
  }

  // --- hit testing ---------------------------------------------------------------

  private hit(slot: Slot, point: Point): Selection | null {
    const page = slot.page;
    const tolerance = 6 / slot.scale;
    for (const line of [...page.lines].reverse()) {
      const [x0, y0, x1, y1] = line.box;
      const pad = 1.5;
      const inBalloon = line.balloon && insidePolygon(line.balloon, point);
      if (inBalloon || insideBox([x0 - pad, y0 - pad, x1 + pad, y1 + pad], point)) {
        return { kind: "line", pageId: page.id, id: line.id };
      }
    }
    for (const stroke of [...page.strokes].reverse()) {
      if (strokeHit(stroke, point, tolerance)) return { kind: "stroke", pageId: page.id, id: stroke.id };
    }
    for (const breakout of [...page.breakouts].reverse()) {
      if (insidePolygon(breakout.shape, point)) return { kind: "breakout", pageId: page.id, id: breakout.id };
    }
    // Panels on top (はめ込み) first.
    const panels = [...page.panels].sort((a, b) => (b.z ?? 0) - (a.z ?? 0) || bounds(a.shape)[2] - bounds(b.shape)[2]);
    for (const panel of panels) {
      if (insidePolygon(panel.shape, point)) return { kind: "panel", pageId: page.id, id: panel.id };
    }
    return null;
  }

  private vertexAt(slot: Slot, sx: number, sy: number): number {
    const s = this.selection;
    if (!s || s.kind !== "panel" || s.pageId !== slot.page.id) return -1;
    const panel = slot.page.panels.find((p) => p.id === s.id);
    if (!panel) return -1;
    return panel.shape.findIndex(
      ([x, y]) => Math.abs(slot.x + x * slot.scale - sx) <= HANDLE + 2 && Math.abs(slot.y + y * slot.scale - sy) <= HANDLE + 2,
    );
  }

  /** The tail tip of the selected line under the pointer, or -1. */
  private tailAt(slot: Slot, sx: number, sy: number): number {
    const s = this.selection;
    if (!s || s.kind !== "line" || s.pageId !== slot.page.id) return -1;
    const line = slot.page.lines.find((l) => l.id === s.id);
    if (!line?.tails) return -1;
    return line.tails.findIndex(({ tip: [x, y] }) => Math.hypot(slot.x + x * slot.scale - sx, slot.y + y * slot.scale - sy) <= HANDLE + 3);
  }

  // --- input ------------------------------------------------------------------------

  /** Whether the pointer erases now: the eraser tool or the pen's eraser end. */
  private erasing(): boolean {
    return this.tool === "eraser" || this.tipEraser;
  }

  private updateCursor(): void {
    const cursors: Record<Tool, string> = {
      select: "default",
      cut: "crosshair",
      text: "text",
      pen: "crosshair",
      eraser: "none",
      breakout: "crosshair",
    };
    const eraser = this.eraseMode === "lasso" ? "crosshair" : "none";
    this.canvas.style.cursor = this.spaceHeld ? "grab" : this.tipEraser ? eraser : this.tool === "eraser" ? eraser : cursors[this.tool];
  }

  private pointerDown(event: PointerEvent): void {
    const project = this.host.project();
    if (!project) return;
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks: carry on without capture.
    }
    const { offsetX: sx, offsetY: sy } = event;
    if (event.button === 1 || this.spaceHeld) {
      this.drag = { kind: "pan", x: event.clientX, y: event.clientY };
      return;
    }
    // A pen's eraser end reports button 5 (buttons bit 32): erase with any tool.
    this.setTipEraser(event);
    if (event.button !== 0 && !this.tipEraser) return;
    const slot = this.slotAt(sx, sy, project);
    if (!slot) {
      this.select(null);
      return;
    }
    const point = this.toPage(slot, sx, sy);
    switch (this.tipEraser ? "eraser" : this.tool) {
      case "select": {
        const tail = this.tailAt(slot, sx, sy);
        if (tail >= 0) {
          this.host.begin();
          this.drag = { kind: "tail", slot, lineId: this.selection!.id, index: tail, moved: false };
          return;
        }
        const vertex = this.vertexAt(slot, sx, sy);
        if (vertex >= 0) {
          this.host.begin();
          this.drag = { kind: "vertex", slot, panelId: this.selection!.id, vertex, moved: false };
          return;
        }
        const target = this.hit(slot, point);
        // Inside a 範囲選択: drag the whole group.
        if (this.selection?.kind === "group" && this.selection.pageId === slot.page.id && (!target || this.isSelected(slot.page, target.kind, target.id))) {
          if (this.groupHit(slot.page, point, 4 / slot.scale)) {
            this.host.begin();
            this.drag = { kind: "move", slot, last: point, moved: false };
            return;
          }
        }
        if (!target) {
          // On nothing: drag around rough lines and dialogue to pick them together.
          this.select(null);
          this.drag = { kind: "pick", slot, points: [point] };
          return;
        }
        this.select(target);
        this.host.begin();
        this.drag = { kind: "move", slot, last: point, moved: false };
        return;
      }
      case "cut": {
        const inPanel = slot.page.panels.some((panel) => insidePolygon(panel.shape, point));
        this.drag = inPanel || slot.page.panels.length
          ? { kind: "cut", slot, a: point, b: point, free: event.altKey }
          : { kind: "frame", slot, a: point, b: point };
        if (!inPanel && slot.page.panels.length && event.shiftKey) this.drag = { kind: "frame", slot, a: point, b: point };
        return;
      }
      case "text": {
        const hit = this.hit(slot, point);
        if (hit?.kind === "line") {
          this.select(hit);
          return;
        }
        this.host.begin();
        const line = addLine(project, slot.page, point);
        this.host.commit();
        this.select({ kind: "line", pageId: slot.page.id, id: line.id });
        return;
      }
      case "pen": {
        // Keep tilt and speed only for brushes that change with them.
        const motion = usesMotion(this.brush("pen"));
        const first: StrokePoint = motion ? [...point, pressureOf(event), tiltOf(event), 0] : [...point, pressureOf(event)];
        this.drag = { kind: "pen", slot, points: [first], last: first, motion, time: event.timeStamp, speed: 0 };
        this.captureBase();
        return;
      }
      case "breakout":
        this.drag = { kind: "lasso", slot, points: [point] };
        return;
      case "eraser": {
        if (this.eraseMode === "lasso") {
          this.drag = { kind: "eraseLasso", slot, points: [point] };
          return;
        }
        this.host.begin();
        this.drag = { kind: "erase", slot, erased: 0 };
        this.erase(slot, point);
        return;
      }
    }
  }

  /** Keep the pages as drawn now (without the overlay) for the pen line to go over. */
  private captureBase(): void {
    this.base = null;
    // The screen already shows the pages unless a frame is still to be drawn
    // (drawing them again would delay the start of the line).
    if (this.frame) this.draw();
    const base = document.createElement("canvas");
    base.width = this.canvas.width;
    base.height = this.canvas.height;
    base.getContext("2d")!.drawImage(this.canvas, 0, 0);
    this.base = base;
  }

  private pointerMove(event: PointerEvent): void {
    this.pointer = [event.offsetX, event.offsetY];
    const drag = this.drag;
    if (!drag) {
      this.setTipEraser(event);
      if (this.erasing()) this.requestDraw();
      return;
    }
    if (drag.kind === "pan") {
      this.pan[0] += event.clientX - drag.x;
      this.pan[1] += event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.requestDraw();
      return;
    }
    const point = this.toPage(drag.slot, event.offsetX, event.offsetY);
    const project = this.host.project()!;
    switch (drag.kind) {
      case "move": {
        const dx = point[0] - drag.last[0];
        const dy = point[1] - drag.last[1];
        if (dx === 0 && dy === 0) return;
        this.moveSelection(drag.slot.page, dx, dy);
        drag.last = point;
        drag.moved = true;
        break;
      }
      case "vertex": {
        const panel = drag.slot.page.panels.find((p) => p.id === drag.panelId);
        if (!panel) return;
        const tolerance = 8 / drag.slot.scale;
        const snapped = this.snap && !event.altKey ? snapPoint(point, snapLines(project.pageFormat), tolerance) : point;
        panel.shape[drag.vertex] = snapped;
        drag.moved = true;
        break;
      }
      case "tail": {
        const line = drag.slot.page.lines.find((l) => l.id === drag.lineId);
        const tail = line?.tails?.[drag.index];
        if (!tail) return;
        tail.tip = point;
        drag.moved = true;
        break;
      }
      case "lasso":
      case "pick":
      case "eraseLasso":
        drag.points.push(point);
        break;
      case "cut":
      case "frame":
        drag.b = point;
        if (drag.kind === "cut") drag.free = event.altKey;
        break;
      case "pen": {
        // 手ブレ補正: each point moves only part of the way towards the pen.
        const follow = followFactor(this.brush("pen")?.stabilization ?? 0);
        const events = event.getCoalescedEvents?.() ?? [event];
        for (const e of events.length ? events : [event]) {
          const [x, y] = this.toPage(drag.slot, e.offsetX, e.offsetY);
          let raw: StrokePoint = [x, y, pressureOf(e)];
          if (drag.motion) {
            const seconds = (e.timeStamp - drag.time) / 1000;
            if (seconds > 0) {
              const speed = Math.hypot(x - drag.last[0], y - drag.last[1]) / seconds / FULL_SPEED_MM;
              // Smoothed: single samples jump about.
              drag.speed += (Math.min(speed, 1) - drag.speed) * 0.3;
              drag.time = e.timeStamp;
            }
            raw = [x, y, pressureOf(e), tiltOf(e), drag.speed];
          }
          const previous = drag.points[drag.points.length - 1];
          drag.points.push(previous.map((value, i) => value + (raw[i] - value) * follow) as StrokePoint);
          drag.last = raw;
        }
        break;
      }
      case "erase": {
        // The eraser goes on across the gutter onto the facing page.
        const under = this.slotAt(event.offsetX, event.offsetY, project) ?? drag.slot;
        this.erase(under, this.toPage(under, event.offsetX, event.offsetY));
        break;
      }
    }
    this.requestDraw();
  }

  private pointerUp(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    this.base = null;
    if (!drag) return;
    const project = this.host.project();
    if (!project) return;
    switch (drag.kind) {
      case "pick": {
        const picked = pickInside(drag.slot.page, drag.points);
        const items = [
          ...picked.strokes.map((id) => ({ kind: "stroke" as const, id })),
          ...picked.lines.map((id) => ({ kind: "line" as const, id })),
        ];
        if (items.length === 1) this.select({ kind: items[0].kind, pageId: drag.slot.page.id, id: items[0].id });
        else if (items.length) this.select({ kind: "group", pageId: drag.slot.page.id, id: "group", items });
        if (items.length > 1) {
          this.host.status(`線 ${picked.strokes.length} 本・セリフ ${picked.lines.length} 個を選びました。ドラッグで動かし、Delete で消せます`);
        }
        break;
      }
      case "eraseLasso": {
        this.host.begin();
        const changed = eraseInside(project, drag.slot.page, drag.points);
        if (changed) {
          this.host.commit();
          this.host.status(`囲んだ中の線を消しました（${changed} 本）`);
        } else {
          this.host.cancel();
        }
        break;
      }
      case "tail":
        if (drag.moved) this.host.commit();
        else this.host.cancel();
        break;
      case "lasso": {
        const shape = simplify(
          drag.points.map(([x, y]) => [x, y, 1] as [number, number, number]),
          0.8,
        ).map(([x, y]) => [x, y] as Point);
        const box = bounds(shape);
        if (shape.length < 3 || box[2] - box[0] < 4 || box[3] - box[1] < 4) {
          this.host.status("はみ出しにする所を囲むようにドラッグしてください");
          break;
        }
        this.host.begin();
        const breakout = addBreakout(project, drag.slot.page, shape);
        this.host.commit();
        this.select({ kind: "breakout", pageId: drag.slot.page.id, id: breakout.id });
        this.host.status("はみ出しを作りました。中でペンを描き始めると、コマ枠の上に描かれます");
        break;
      }
      case "move":
      case "vertex":
        if (!drag.moved) {
          this.host.cancel();
          break;
        }
        if (drag.kind === "vertex" || this.selection?.kind === "panel") orderPanels(drag.slot.page, project.binding);
        if (drag.kind === "move") this.carryAcrossGutter(drag.slot);
        for (const slot of this.slots) {
          assignPanels(slot.page);
          sortLines(slot.page);
        }
        this.host.commit();
        break;
      case "cut": {
        const b = drag.free ? drag.b : snapCut(drag.a, drag.b);
        if (Math.hypot(b[0] - drag.a[0], b[1] - drag.a[1]) < 3) break;
        this.host.begin();
        const created = cutPanels(project, drag.slot.page, drag.a, b);
        if (created.length) {
          sortLines(drag.slot.page);
          this.host.commit();
          this.host.status(`コマを ${created.length} か所で分けました`);
        } else {
          this.host.cancel();
          this.host.status("コマを横切るように線を引いてください");
        }
        break;
      }
      case "frame": {
        const box = bounds([drag.a, drag.b]);
        if (box[2] - box[0] < 5 || box[3] - box[1] < 5) {
          this.host.status("コマにするには、もう少し大きく囲んでください");
          break;
        }
        const tolerance = 8 / drag.slot.scale;
        const lines = snapLines(project.pageFormat);
        const [x0, y0] = snapPoint([box[0], box[1]], lines, tolerance);
        const [x1, y1] = snapPoint([box[2], box[3]], lines, tolerance);
        this.host.begin();
        const panel = addPanel(project, drag.slot.page, rectShape([x0, y0, x1, y1]));
        this.host.commit();
        this.select({ kind: "panel", pageId: drag.slot.page.id, id: panel.id });
        break;
      }
      case "pen": {
        this.host.begin();
        // The smoothed line catches up with where the pen left the page.
        if (drag.points.length > 1) drag.points.push(drag.last);
        const brushId = this.brush("pen")?.id;
        // Begun inside a はみ出し: the line goes over the panel borders.
        const [bx, by] = drag.points[0];
        const over = drag.slot.page.breakouts.some((breakout) => insidePolygon(breakout.shape, [bx, by]));
        // 見開き: a line drawn across the gutter goes onto both pages, cut where it crosses.
        const facing = this.facingSlot(drag.slot);
        const gutter = facing ? (facing.x > drag.slot.x ? drag.slot.shown[1] : drag.slot.shown[0]) : null;
        const runs =
          facing && gutter !== null ? splitAtX(drag.points, gutter) : [{ points: drag.points, beyond: false }];
        const onFacing = (beyond: boolean) => facing !== null && beyond === facing.x > drag.slot.x;
        let added = 0;
        for (const [index, run] of runs.entries()) {
          const target = onFacing(run.beyond) && facing ? facing : drag.slot;
          const shift = (drag.slot.x - target.x) / drag.slot.scale;
          const points = run.points.map((p) => [p[0] + shift, ...p.slice(1)] as StrokePoint);
          const stroke = addStroke(project, target.page, points, this.penWidthMm, brushId);
          if (!stroke) continue;
          added++;
          if (over && target === drag.slot) stroke.over = true;
          const cut: [boolean, boolean] = [index > 0, index < runs.length - 1];
          if (cut[0] || cut[1]) stroke.cut = cut;
        }
        if (added) this.host.commit();
        else this.host.cancel();
        break;
      }
      case "erase":
        if (drag.erased) this.host.commit();
        else this.host.cancel();
        break;
      case "pan":
        break;
    }
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.draw();
  }

  private erase(slot: Slot, point: Point): void {
    const project = this.host.project();
    if (!project) return;
    const mode = this.eraseMode === "lasso" ? "whole" : this.eraseMode;
    const erased = eraseWith(project, slot.page, point, this.eraserRadiusPx(slot.scale) / slot.scale, mode);
    if (this.drag?.kind === "erase") this.drag.erased += erased;
  }

  private moveSelection(page: Page, dx: number, dy: number): void {
    const s = this.selection;
    if (!s) return;
    if (s.kind === "line") {
      const line = page.lines.find((l) => l.id === s.id);
      if (line) moveLine(line, dx, dy);
    } else if (s.kind === "panel") {
      const panel = page.panels.find((p) => p.id === s.id);
      if (panel) movePanel(panel, dx, dy);
    } else if (s.kind === "breakout") {
      const breakout = page.breakouts.find((b) => b.id === s.id);
      if (breakout) moveBreakout(breakout, dx, dy);
    } else if (s.kind === "group") {
      for (const item of s.items ?? []) {
        if (item.kind === "line") {
          const line = page.lines.find((l) => l.id === item.id);
          if (line) moveLine(line, dx, dy);
        } else {
          const stroke = page.strokes.find((x) => x.id === item.id);
          if (stroke) moveStroke(stroke, dx, dy);
        }
      }
    } else {
      const stroke = page.strokes.find((p) => p.id === s.id);
      if (stroke) moveStroke(stroke, dx, dy);
    }
  }

  /** Nudge the selection with the arrow keys (mm). */
  nudge(dx: number, dy: number): boolean {
    const page = this.focusPage();
    if (!page || !this.selection) return false;
    this.host.begin();
    this.moveSelection(page, dx, dy);
    assignPanels(page);
    sortLines(page);
    this.host.commit();
    this.draw();
    return true;
  }

  private wheel(event: WheelEvent): void {
    event.preventDefault();
    const project = this.host.project();
    if (!project) return;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const zoom = Math.min(Math.max(this.zoom * factor, 0.3), 12);
    const applied = zoom / this.zoom;
    // Keep the point under the pointer still.
    const { width, height } = this.canvas.getBoundingClientRect();
    const cx = width / 2 + this.pan[0];
    const cy = height / 2 + this.pan[1];
    this.pan[0] += (event.offsetX - cx) * (1 - applied);
    this.pan[1] += (event.offsetY - cy) * (1 - applied);
    this.zoom = zoom;
    this.draw();
  }
}

function pressureOf(event: PointerEvent): number {
  // Mice report 0.5 while a button is down; treat that as full pressure.
  if (event.pointerType !== "pen") return 1;
  return Math.max(0.05, Math.min(1, event.pressure || 0.5));
}

export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
}

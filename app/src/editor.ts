// The page editor: draws a spread of the name data and turns pointer input
// into edits (select and move, cut panels, place lines, draw and erase).
// Coordinates on a page are millimetres; each page of the spread has its own
// mm → screen mapping.
import { spreads } from "./pages";
import { INK, drawBalloon, drawLineText, drawPanel, drawStroke, tracePath } from "./pagedraw";
import {
  addLine,
  addPanel,
  addStroke,
  assignPanels,
  basicBox,
  bounds,
  cutPanels,
  eraseStrokes,
  insideBox,
  insidePolygon,
  moveLine,
  movePanel,
  moveStroke,
  orderPanels,
  rectShape,
  snapCut,
  snapLines,
  snapPoint,
  sortLines,
  strokeHit,
  trimBox,
  type Line,
  type Page,
  type Point,
  type Project,
  type RoughImage,
} from "./project";

export type Tool = "select" | "cut" | "text" | "pen" | "eraser";

export interface Selection {
  kind: "panel" | "line" | "stroke";
  pageId: string;
  id: string;
}

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
}

type Drag =
  | { kind: "pan"; x: number; y: number }
  | { kind: "move"; slot: Slot; last: Point; moved: boolean }
  | { kind: "vertex"; slot: Slot; panelId: string; vertex: number; moved: boolean }
  | { kind: "cut"; slot: Slot; a: Point; b: Point; free: boolean }
  | { kind: "frame"; slot: Slot; a: Point; b: Point }
  | { kind: "pen"; slot: Slot; points: [number, number, number][] }
  | { kind: "erase"; slot: Slot; erased: number };

const ACCENT = "#2f6fdb";
const GAP = 18;
const MARGIN = 28;
const HANDLE = 5;

export class PageEditor {
  tool: Tool = "select";
  selection: Selection | null = null;
  spreadIndex = 0;
  firstAlone = true;
  penWidthMm = 0.4;
  /** Snap panel corners to the frames. */
  snap = true;
  private zoom = 1;
  private pan: [number, number] = [0, 0];
  private slots: Slot[] = [];
  private drag: Drag | null = null;
  private spaceHeld = false;
  private pointer: Point | null = null;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly host: EditorHost) {
    this.ctx = canvas.getContext("2d")!;
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
    const fit = Math.min((width - 2 * MARGIN - GAP) / (2 * pageW), (height - 2 * MARGIN) / pageH);
    const scale = fit * this.zoom;
    const spreadW = 2 * pageW * scale + GAP;
    const left = (width - spreadW) / 2 + this.pan[0];
    const top = (height - pageH * scale) / 2 + this.pan[1];
    // Right binding: [right page, left page]; left binding mirrors it.
    const [rightPage, leftPage] = project.binding === "right" ? pair : [pair[1], pair[0]];
    const slots: Slot[] = [];
    const place = (pageNumber: number | null, x: number) => {
      if (pageNumber === null) return;
      slots.push({ page: project.pages[pageNumber - 1], index: pageNumber - 1, x, y: top, scale });
    };
    place(leftPage, left);
    place(rightPage, left + pageW * scale + GAP);
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
        return x >= -10 && x <= pageW + 10 && y >= -10 && y <= pageH + 10;
      }) ?? null
    );
  }

  // --- drawing ----------------------------------------------------------------

  draw(): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, width, height);
    const project = this.host.project();
    if (!project) return;
    this.slots = this.layout(project);
    for (const slot of this.slots) this.drawPage(project, slot);
    this.drawOverlay();
  }

  private drawPage(project: Project, slot: Slot): void {
    const ctx = this.ctx;
    const { page, scale } = slot;
    const [pageW, pageH] = project.pageFormat.canvasMm;
    const sx = (x: number) => slot.x + x * scale;
    const sy = (y: number) => slot.y + y * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(sx(0), sy(0), pageW * scale, pageH * scale);
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
    for (const stroke of page.strokes) {
      drawStroke(ctx, stroke, m, this.isSelected(page, "stroke", stroke.id) ? ACCENT : "#3a3834");
    }

    for (const panel of page.panels) {
      const selected = this.isSelected(page, "panel", panel.id);
      if (selected) {
        tracePath(ctx, panel.shape, m, true);
        ctx.fillStyle = "rgba(47, 111, 219, 0.08)";
        ctx.fill();
      }
      drawPanel(ctx, panel, m, selected ? ACCENT : INK);
      const [, y0, x1] = bounds(panel.shape);
      const radius = Math.max(4 * scale, 7);
      ctx.fillStyle = selected ? ACCENT : "rgba(47, 111, 219, 0.75)";
      ctx.beginPath();
      ctx.arc(sx(x1) - radius - 3, sy(y0) + radius + 3, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${Math.round(radius * 1.2)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(panel.order), sx(x1) - radius - 3, sy(y0) + radius + 3);
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

    for (const line of page.lines) this.drawLine(project, slot, line);
    ctx.restore();

    ctx.fillStyle = "#f4f3f0";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const memo = page.memo ? `  ${page.memo.split("\n")[0]}` : "";
    ctx.fillText(`${slot.index + 1}${memo}`, sx(pageW / 2), sy(pageH) + 18);
  }

  private drawLine(project: Project, slot: Slot, line: Line): void {
    const ctx = this.ctx;
    const { scale } = slot;
    const sx = (x: number) => slot.x + x * scale;
    const sy = (y: number) => slot.y + y * scale;
    const selected = this.isSelected(slot.page, "line", line.id);
    const m = { scale, x: slot.x, y: slot.y };
    drawBalloon(ctx, line, m);
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
    if (drag?.kind === "pen") {
      const { slot, points } = drag;
      ctx.strokeStyle = "#3a3834";
      ctx.lineWidth = Math.max(this.penWidthMm * slot.scale, 0.7);
      ctx.lineCap = "round";
      ctx.beginPath();
      points.forEach(([x, y], i) => {
        const px = slot.x + x * slot.scale;
        const py = slot.y + y * slot.scale;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
    if (this.tool === "eraser" && this.pointer) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.pointer[0], this.pointer[1], this.eraserRadiusPx(), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private eraserRadiusPx(): number {
    return 8;
  }

  private isSelected(page: Page, kind: Selection["kind"], id: string): boolean {
    const s = this.selection;
    return !!s && s.pageId === page.id && s.kind === kind && s.id === id;
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
    const panels = [...page.panels].sort((a, b) => bounds(a.shape)[2] - bounds(b.shape)[2]);
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

  // --- input ------------------------------------------------------------------------

  private updateCursor(): void {
    const cursors: Record<Tool, string> = {
      select: "default",
      cut: "crosshair",
      text: "text",
      pen: "crosshair",
      eraser: "none",
    };
    this.canvas.style.cursor = this.spaceHeld ? "grab" : cursors[this.tool];
  }

  private pointerDown(event: PointerEvent): void {
    const project = this.host.project();
    if (!project) return;
    this.canvas.setPointerCapture(event.pointerId);
    const { offsetX: sx, offsetY: sy } = event;
    if (event.button === 1 || this.spaceHeld) {
      this.drag = { kind: "pan", x: event.clientX, y: event.clientY };
      return;
    }
    if (event.button !== 0) return;
    const slot = this.slotAt(sx, sy, project);
    if (!slot) {
      this.select(null);
      return;
    }
    const point = this.toPage(slot, sx, sy);
    switch (this.tool) {
      case "select": {
        const vertex = this.vertexAt(slot, sx, sy);
        if (vertex >= 0) {
          this.host.begin();
          this.drag = { kind: "vertex", slot, panelId: this.selection!.id, vertex, moved: false };
          return;
        }
        const target = this.hit(slot, point);
        this.select(target);
        if (target) {
          this.host.begin();
          this.drag = { kind: "move", slot, last: point, moved: false };
        }
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
      case "pen":
        this.drag = { kind: "pen", slot, points: [[...point, pressureOf(event)]] };
        return;
      case "eraser": {
        this.host.begin();
        this.drag = { kind: "erase", slot, erased: 0 };
        this.erase(slot, point);
        return;
      }
    }
  }

  private pointerMove(event: PointerEvent): void {
    this.pointer = [event.offsetX, event.offsetY];
    const drag = this.drag;
    if (!drag) {
      if (this.tool === "eraser") this.draw();
      return;
    }
    if (drag.kind === "pan") {
      this.pan[0] += event.clientX - drag.x;
      this.pan[1] += event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.draw();
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
      case "cut":
      case "frame":
        drag.b = point;
        if (drag.kind === "cut") drag.free = event.altKey;
        break;
      case "pen": {
        const events = event.getCoalescedEvents?.() ?? [event];
        for (const e of events.length ? events : [event]) {
          drag.points.push([...this.toPage(drag.slot, e.offsetX, e.offsetY), pressureOf(e)]);
        }
        break;
      }
      case "erase":
        this.erase(drag.slot, point);
        break;
    }
    this.draw();
  }

  private pointerUp(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    const project = this.host.project();
    if (!project) return;
    switch (drag.kind) {
      case "move":
      case "vertex":
        if (!drag.moved) {
          this.host.cancel();
          break;
        }
        if (drag.kind === "vertex" || this.selection?.kind === "panel") orderPanels(drag.slot.page, project.binding);
        assignPanels(drag.slot.page);
        sortLines(drag.slot.page);
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
        const stroke = addStroke(project, drag.slot.page, drag.points, this.penWidthMm);
        if (stroke) this.host.commit();
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
    this.canvas.releasePointerCapture(event.pointerId);
    this.draw();
  }

  private erase(slot: Slot, point: Point): void {
    const erased = eraseStrokes(slot.page, point, this.eraserRadiusPx() / slot.scale);
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

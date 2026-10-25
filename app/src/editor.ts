// The page editor: draws a spread of the name data and turns pointer input
// into edits (select and move, cut panels, place lines, draw and erase).
// What each tool does with a press and its drags is in its own module
// (tools.ts); the editor keeps the view, the hit testing and the drawing.
// Coordinates on a page are millimetres; each page of the spread has its own
// mm → screen mapping.
import { maskShape } from "./mask";
import { penPreferences } from "./pen";
import { balloonExtent, insideBalloon, tailGeometry } from "./balloon";
import { spreads } from "./pages";
import { GRID_GAP_MM, MARGIN, MAX_PAGE_GAP_MM, extent, layoutPages, onStage, rowCount, slotAt, toPage, type Slot } from "./layout";
import { holdPanel, placeHeld } from "./hold";
import { canvasFont, lineBold, lineFont } from "./fonts";
import { addDrawnPanel, moveBreakout, spanGutter, stacked } from "./koma";
import { joinPanels, seamAt, seamLines, type Seam } from "./komaedit";
import {
  baseBounds,
  copySelection,
  pasteClip,
  rotation,
  scaling,
  transformBase,
  transformItems,
  withContents,
  moveItems,
  type Clip,
  type ItemRef,
} from "./transform";
import { INK, drawBalloons, drawLineText, drawPageFills, drawPanelBorders, drawPanelFills, drawStroke, drawStrokes, onTipLoaded, tracePath } from "./pagedraw";
import { corners, imageOf, opacityOf, pictureOf, REFERENCE_HANDLE } from "./references";
import { StrokeCache } from "./strokecache";
import { opacityOfLayer, ROUGH_BASE, roughLayersOf, shownStrokes, strokeEditable, strokesOn } from "./roughlayers";
import {
  stickyAnchor,
  assignPanels,
  basicBox,
  bounds,
  insideBox,
  insidePolygon,
  MM_PER_PT,
  moveLine,
  movePanel,
  moveStroke,
  orderPanels,
  pageIndex,
  panelContents,
  snapCut,
  sortLines,
  wantsSpread,
  carryContents,
  followPanel,
  gutters,
  type CarriedContents,
  strokeHit,
  keepStickyOnPage,
  setLineText,
  wrapTypedLine,
  trimBox,
  type Binding,
  type BoxMm,
  type Brush,
  type FillTone,
  type Line,
  type Page,
  type Panel,
  type Point,
  type Sticky,
  STICKY_COLORS,
  STICKY_TEXT_MM,
  stickyBox,
  stickyRows,
  type Project,
  type Stroke,
} from "./project";
import { readCount, readFlag, readNumber } from "./settings";
import { linePitch } from "./style";
import {
  FRAME_HANDLES,
  type EditorCore,
  type EditorEraseMode,
  type EditorHost,
  type Guides,
  type PanelMode,
  type Selection,
  type TailHit,
  type Tool,
  type ToolDrag,
} from "./editorcore";
import { LINK_HANDLE } from "./toolsticky";
import { dragHandler, PRESS } from "./tools";
import { pickedSummary } from "./toolselect";
import { loadSnap, snapPointTo, snapTargets, type SnapSettings, type SnapTargets } from "./snapping";

export type { EditorEraseMode, EditorHost, PanelMode, Selection, Tool } from "./editorcore";
export { pickedSummary };

export const PANEL_MODE_LABELS: Record<PanelMode, string> = { cut: "割る", rect: "四角", polygon: "多角形" };

export const ERASE_MODE_LABELS: Record<EditorEraseMode, string> = {
  touched: "触れた部分",
  intersection: "交点まで",
  whole: "線全体",
  lasso: "囲って消す",
};

/** Drags of the view itself (the tools' drags are in their modules). */
type Drag =
  | ToolDrag
  | { kind: "pan"; x: number; y: number }
  /** Two fingers: `v` is the view point under their middle (independent of zoom), kept under it. */
  | { kind: "pinch"; ids: [number, number]; dist: number; angle: number; zoom: number; rotation: number; v: Point }
  | { kind: "turn"; from: number; rotation: number };

const ROTATE_GAP = 22;

/** What the pointer is over with the select tool, shown before anything is pressed. */
type Hover =
  | { kind: "tail"; slot: Slot; hit: TailHit }
  | { kind: "seam"; slot: Slot; seam: Seam }
  | { kind: "item"; slot: Slot; target: Selection }
  | { kind: "handle"; slot: Slot; handle: number };

const ACCENT = "#2f6fdb";
/** Lines snapped to. */
const GUIDE = "#e0398a";
const HANDLE = 5;

export const PANEL_CARRIES_KEY = "namestudio.panelCarries";
export const BALLOON_TEXT_KEY = "namestudio.balloonTextFollows";
export const SHOW_NOTES_KEY = "namestudio.showNotes";
export const SINGLE_PAGE_KEY = "namestudio.singlePage";
export const CONTINUOUS_KEY = "namestudio.continuous";
export const ROWS_KEY = "namestudio.rows";
export const PAGE_GAP_KEY = "namestudio.pageGap";
/** How long the pages take to slide to a new arrangement (ms). */
const SLIDE_MS = 220;
/** Pages narrower than this (px) show their drawing without panel numbers or memos. */
const SMALL_PAGE_PX = 170;

const NOTE_FONT = '12px "Yu Gothic UI", "Yu Gothic", "Hiragino Sans", "Noto Sans JP", sans-serif';
const NOTE_ROW = 16;

export class PageEditor {
  tool: Tool = "select";
  selection: Selection | null = null;
  spreadIndex = 0;
  /** The page of the spread last clicked or picked in the page list: what the page settings are for. */
  private focusedPageId: string | null = null;
  /** Picking the next of overlapping balloons, held back while a double-click may follow. */
  private cycleTimer = 0;
  firstAlone = true;
  /** 単独: one page at a time instead of 見開き. */
  single = readFlag(SINGLE_PAGE_KEY, false);
  /** 連続: every page on one canvas, as on a name sheet, the spreads in `rows` rows (1: one long row). */
  continuous = readFlag(CONTINUOUS_KEY, false);
  rows = readCount(ROWS_KEY, 1);
  /** Where the pages were on screen, while they slide to a new arrangement. */
  private sliding: { from: Map<number, Point>; start: number } | null = null;
  /** コマに中身が付いてくる: moving or reshaping a panel takes its contents along. */
  panelCarries = readFlag(PANEL_CARRIES_KEY, true);
  /** A balloon transformed on its own: its text grows and shrinks with it (off: only the balloon changes). */
  balloonTextFollows = readFlag(BALLOON_TEXT_KEY, true);
  /** Each panel's memo shown on the page (only on screen, never exported). */
  showNotes = readFlag(SHOW_NOTES_KEY, true);
  penWidthMm = 0.4;
  /** The ラフ線のレイヤー the pen draws on (ROUGH_BASE when the name has one layer). */
  roughLayer = ROUGH_BASE;
  /** Brushes in use (ids in the project); null is the plain pen / eraser. */
  penBrush: string | null = null;
  eraserBrush: string | null = null;
  eraserSizeMm = 2;
  /** 投げなわ塗り: the tone the fill tool fills with. */
  fillTone: FillTone = "black";
  /** The eraser's way of erasing; the pen's eraser end uses it too. */
  eraseMode: EditorEraseMode = "whole";
  /** The pen's eraser end is down or hovering: erase whatever the tool. */
  private tipEraser = false;
  /** 吸着: what panel corners, borders and panels snap to (nothing while Alt is held). */
  snapping: SnapSettings = loadSnap();
  /** 連続: room between the spreads (mm). */
  pageGapMm = readNumber(PAGE_GAP_KEY, GRID_GAP_MM, 0, MAX_PAGE_GAP_MM);
  /** コマ割り: what a drag with the panel tool does. */
  panelMode: PanelMode = "cut";
  /** 多角形: the corners placed so far on a page (the panel is made when the outline is closed). */
  private polygon: { pageId: string; points: Point[] } | null = null;
  /** Lines snapped to while dragging (page mm), shown as guides. */
  private guides: Guides | null = null;
  /** 変形 (Ctrl+T): the transform frame on a panel, a balloon, a fill or a はみ出し. */
  private transforming = false;
  /** Hidden on screen from the レイヤー list (`kind:id`); exports keep them. */
  readonly hidden = new Set<string>();
  private zoom = 1;
  private pan: [number, number] = [0, 0];
  /** 画面の回転 (radians, clockwise): the whole view turns about the middle of the stage. */
  private rotation = 0;
  private slots: Slot[] = [];
  /** The canvas's size on screen (CSS px), kept by `resize`. */
  private size: { width: number; height: number } | null = null;
  private drag: Drag | null = null;
  private spaceHeld = false;
  private pointer: Point | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  /** The pages as drawn when a pen line began: only the new line is drawn over it. */
  private base: HTMLCanvasElement | null = null;
  private frame = 0;
  /** The pages as last drawn, for redrawing only what is over them (hover, eraser ring). */
  private cache: HTMLCanvasElement | null = null;
  /** 資料: the picture chosen with the 資料 tool. */
  reference: { pageId: string; id: string } | null = null;
  /** Each page's rough lines as a picture, while they do not change. */
  private readonly strokeCache = new StrokeCache(() => this.requestDraw());
  private overlayFrame = 0;
  private hover: Hover | null = null;
  private hoverAt: Point | null = null;
  private hoverFrame = 0;
  /** A text being written in place on the page (a panel's memo or dialogue). */
  private inline: { field: HTMLTextAreaElement; place: () => void; finish: (keep: boolean) => void } | null = null;
  /** Run once the pointer is up (opening a text field during the press would lose its focus). */
  private afterUp: (() => void) | null = null;
  /** What was copied last (Ctrl+C), and how often it was pasted onto its own page. */
  private clip: Clip | null = null;
  private pastes = 0;
  /** The small bar of actions beside the selection. */
  private readonly bar: HTMLDivElement;
  /** The pointer the drag belongs to: other pens and fingers do not disturb it. */
  private dragPointer: number | null = null;
  private dragPointerType = "";
  /** When the pen was last near the screen (for ignoring the hand resting on it). */
  private penSeen = -Infinity;
  /** Fingers on the page (screen px), and where each came down. */
  private readonly touches = new Map<number, Point>();
  private readonly touchStarts = new Map<number, Point>();
  /** The fingers since the first came down: for taps (two: undo, three: redo). */
  private gesture: { start: number; most: number; moved: boolean } | null = null;

  /** The editor as its tools see it (tools.ts). */
  private readonly core: EditorCore = this.toolView();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly host: EditorHost) {
    // Low latency: the pen line reaches the screen without waiting for the compositor.
    this.ctx = canvas.getContext("2d", { desynchronized: true })!;
    // A pen held still or its barrel button must not open the context menu.
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    onTipLoaded(() => {
      this.strokeCache.tipsChanged();
      this.draw();
    });
    penPreferences.onChange(() => {
      this.updateCursor();
      this.requestOverlay();
    });
    this.bar = document.createElement("div");
    this.bar.className = "action-bar";
    this.bar.hidden = true;
    // Presses on the bar are not presses on the page.
    this.bar.addEventListener("pointerdown", (event) => event.stopPropagation());
    canvas.parentElement?.append(this.bar);
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
    canvas.addEventListener("pointerleave", () => {
      this.pointer = null;
      this.hover = null;
      this.updateCursor();
      this.requestOverlay();
    });
    canvas.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    canvas.addEventListener("dblclick", (event) => this.doubleClick(event));
    // 多角形: Enter closes the outline, Backspace takes back a corner, Esc stops (before the app's own keys).
    window.addEventListener(
      "keydown",
      (event) => {
        if (!this.polygon || isTyping(event)) return;
        const done = event.key === "Enter" ? this.finishPolygon() : event.key === "Backspace" ? this.cancelPolygon(true) : event.key === "Escape" ? this.cancelPolygon() : false;
        if (done) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
    window.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && this.transforming && !isTyping(event)) {
        event.preventDefault();
        this.toggleTransform(false);
        return;
      }
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
    const project = this.host.project();
    const count = project?.pages.length ?? 0;
    // 単独: each page on its own, one at a time; a 縦スクロール strip has no spreads.
    if ((this.single && !this.continuous) || project?.scroll) return Array.from({ length: count }, (_, i): [number | null, number | null] => [i + 1, null]);
    return spreads(count, this.firstAlone);
  }

  /** Page numbers (1-based) on the current spread, right page first. */
  currentPages(): number[] {
    const pair = this.spreadList()[this.spreadIndex];
    return pair ? pair.filter((page): page is number => page !== null) : [];
  }

  showPage(pageNumber: number): void {
    this.focusedPageId = this.host.project()?.pages[pageNumber - 1]?.id ?? null;
    const index = this.spreadList().findIndex((pair) => pair.includes(pageNumber));
    if (this.continuous) {
      // 連続: the page is already on the canvas; bring it into view.
      if (index >= 0) this.spreadIndex = index;
      this.reveal();
      return;
    }
    if (index >= 0 && index !== this.spreadIndex) {
      this.spreadIndex = index;
      this.resetView();
    }
    this.draw();
  }

  flip(step: number): void {
    const count = this.spreadList().length;
    this.spreadIndex = Math.min(Math.max(this.spreadIndex + step, 0), Math.max(count - 1, 0));
    if (this.continuous) {
      const pair = this.spreadList()[this.spreadIndex];
      this.focusedPageId = this.host.project()?.pages[(pair?.[0] ?? pair?.[1] ?? 1) - 1]?.id ?? null;
      this.reveal();
      return;
    }
    this.resetView();
    this.draw();
  }

  /** 連続: how many rows the spreads are in (1 to one spread a row). */
  rowCount(): number {
    return rowCount(this.rows, this.spreadList().length);
  }

  /** 連続: lay the spreads out in `rows` rows, the spread worked on staying where it is on screen. */
  setRows(rows: number): void {
    const project = this.host.project();
    const count = Math.max(1, this.spreadList().length);
    const next = Math.min(Math.max(1, Math.round(rows)), count);
    if (next === this.rowCount() && next === this.rows) return;
    this.slide(() => {
      const before = project && this.spreadBox(this.layout(project));
      this.rows = next;
      const after = project && this.spreadBox(this.layout(project));
      if (before && after) {
        this.pan[0] += before[0] - after[0];
        this.pan[1] += before[1] - after[1];
      }
    });
  }

  /** 連続: the whole name on screen. */
  fitAll(): void {
    const project = this.host.project();
    if (!project || !this.continuous) return;
    this.slide(() => {
      const { width, height } = this.stageSize();
      this.zoom = 1;
      this.pan = [0, 0];
      if (this.rotation) {
        this.rotation = 0;
        this.applyViewTransform();
      }
      for (let i = 0; i < 3; i++) {
        // The gaps between the spreads are partly px: a few rounds settle the zoom.
        const box = this.extent(this.layout(project));
        if (!box) return;
        const factor = Math.min((width - 2 * MARGIN) / (box[2] - box[0]), (height - 2 * MARGIN) / (box[3] - box[1]));
        this.zoom = Math.min(Math.max(this.zoom * factor, 0.02), 1);
      }
      const box = this.extent(this.layout(project));
      if (!box) return;
      this.pan[0] += width / 2 - (box[0] + box[2]) / 2;
      this.pan[1] += height / 2 - (box[1] + box[3]) / 2;
    });
  }

  /** 連続: move the view (sliding) so that the spread worked on is all on screen. */
  private reveal(): void {
    const project = this.host.project();
    const box = project && this.spreadBox(this.layout(project));
    if (!box) {
      this.draw();
      return;
    }
    const { width, height } = this.stageSize();
    const [x0, y0, x1, y1] = box;
    const inside = x0 >= 0 && x1 <= width && y0 >= 0 && y1 <= height;
    if (inside || this.rotation) {
      this.draw();
      return;
    }
    // Too big to fit: as much of it as fits, from its top.
    const dx = x1 - x0 <= width ? width / 2 - (x0 + x1) / 2 : 0;
    const dy = y1 - y0 <= height ? height / 2 - (y0 + y1) / 2 : MARGIN - y0;
    this.slide(() => {
      this.pan[0] += dx;
      this.pan[1] += dy;
    });
  }

  /** Change the arrangement or the view, the pages sliding there from where they are. */
  private slide(change: () => void): void {
    const from = new Map(this.slots.map((slot): [number, Point] => [slot.index, [slot.x, slot.y]]));
    change();
    this.sliding = from.size && !matchMedia("(prefers-reduced-motion: reduce)").matches ? { from, start: performance.now() } : null;
    this.draw();
  }

  /** The screen box (px) of the spread worked on, with the room for its page numbers. */
  private spreadBox(slots: Slot[]): BoxMm | null {
    const pages = this.currentPages();
    return this.extent(slots.filter((slot) => pages.includes(slot.index + 1)));
  }

  /** The screen box (px) of the pages in `slots`, with the room for their page numbers. */
  private extent(slots: Slot[]): BoxMm | null {
    return extent(slots, this.host.project()?.pageFormat.canvasMm[1] ?? 0);
  }

  resetView(zoom = 1): void {
    this.zoom = zoom;
    this.pan = [0, 0];
    this.sliding = null;
  }

  /** Ctrl+0: the whole spread, upright (連続: the spread worked on, in the middle). */
  fitView(): void {
    if (this.continuous) {
      const project = this.host.project();
      this.zoom = 1;
      const box = project && this.spreadBox(this.layout(project));
      const { width, height } = this.stageSize();
      if (box) {
        this.pan[0] += width / 2 - (box[0] + box[2]) / 2;
        this.pan[1] += height / 2 - (box[1] + box[3]) / 2;
      }
      this.sliding = null;
    } else {
      this.resetView();
    }
    this.setRotation(0);
  }

  /** Turn the view by `degrees` (Shift + Space + drag turns it freely). */
  rotateView(degrees: number): void {
    this.setRotation(this.rotation + (degrees * Math.PI) / 180);
  }

  private setRotation(radians: number): void {
    const full = Math.PI * 2;
    this.rotation = ((((radians + Math.PI) % full) + full) % full) - Math.PI;
    if (Math.abs(this.rotation) < 1e-9) this.rotation = 0;
    this.applyViewTransform();
    this.draw();
    const degrees = Math.round((this.rotation * 180) / Math.PI);
    this.host.status(degrees ? `画面を ${degrees}° 回しています（Ctrl+0 で戻す）` : "画面の回転を戻しました");
  }

  /** The middle of the stage (CSS px), which the view turns about. */
  private centre(): Point {
    const { width, height } = this.stageSize();
    return [width / 2, height / 2];
  }

  /** A vector turned by `radians`. */
  private turn(x: number, y: number, radians: number): Point {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return [x * cos - y * sin, x * sin + y * cos];
  }

  /** Where an event is in the view before turning (what the pages are laid out in). */
  private at(event: MouseEvent): Point {
    if (!this.rotation) return [event.offsetX, event.offsetY];
    const [cx, cy] = this.centre();
    const [x, y] = this.turn(event.offsetX - cx, event.offsetY - cy, -this.rotation);
    return [cx + x, cy + y];
  }

  /** Where a point of the unturned view shows on screen. */
  private onScreen([x, y]: Point): Point {
    if (!this.rotation) return [x, y];
    const [cx, cy] = this.centre();
    const [dx, dy] = this.turn(x - cx, y - cy, this.rotation);
    return [cx + dx, cy + dy];
  }

  private angleAt(sx: number, sy: number): number {
    const [cx, cy] = this.centre();
    const [x, y] = this.turn(sx - cx, sy - cy, this.rotation);
    return Math.atan2(y, x);
  }

  private applyViewTransform(): void {
    const ratio = window.devicePixelRatio || 1;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (!this.rotation) return;
    const [cx, cy] = this.centre();
    this.ctx.translate(cx, cy);
    this.ctx.rotate(this.rotation);
    this.ctx.translate(-cx, -cy);
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.transforming = false;
    if (tool !== "cut") this.cancelPolygon();
    this.updateCursor();
    this.renderBar();
    this.draw();
  }

  select(selection: Selection | null): void {
    const same = selection && this.selection && selection.kind === this.selection.kind && selection.id === this.selection.id && selection.pageId === this.selection.pageId;
    if (!same) this.transforming = false;
    this.selection = selection;
    this.host.selectionChanged(selection);
    this.renderBar();
    this.draw();
  }

  /** Fill the action bar for the selection (or hide it). */
  renderBar(): void {
    const s = this.selection;
    this.bar.replaceChildren(...(s && this.tool === "select" ? this.host.actions(s) : []));
    this.placeBar();
  }

  /** The selection's box on screen (px), when its page is shown. */
  private selectionScreenBox(): BoxMm | null {
    const s = this.selection;
    const slot = s && this.slots.find((x) => x.page.id === s.pageId);
    if (!s || !slot) return null;
    const page = slot.page;
    let box: BoxMm | null = null;
    if (s.kind === "panel") {
      const panel = page.panels.find((p) => p.id === s.id);
      if (panel) box = bounds(panel.shape);
    } else if (s.kind === "line") {
      const line = page.lines.find((l) => l.id === s.id);
      if (line) box = bounds([[line.box[0], line.box[1]], [line.box[2], line.box[3]], ...(line.balloon ?? [])]);
    } else if (s.kind === "breakout") {
      const breakout = page.breakouts.find((b) => b.id === s.id);
      if (breakout) box = bounds(breakout.shape);
    } else if (s.kind === "sticky") {
      const sticky = page.stickies?.find((n) => n.id === s.id);
      if (sticky) box = stickyBox(sticky);
    } else if (s.kind === "fill") {
      const fill = page.fills?.find((f) => f.id === s.id);
      if (fill) box = bounds(fill.shape);
    } else {
      box = baseBounds(transformBase(page, this.selectedItems()));
    }
    if (!box) return null;
    const corners = [
      [box[0], box[1]],
      [box[2], box[1]],
      [box[2], box[3]],
      [box[0], box[3]],
    ].map(([x, y]) => this.onScreen([slot.x + x * slot.scale, slot.y + y * slot.scale]));
    return bounds(corners);
  }

  /** Put the bar above the selection (below it when there is no room), inside the stage. */
  private placeBar(): void {
    const box = this.drag || this.inline || !this.bar.childElementCount ? null : this.selectionScreenBox();
    this.bar.hidden = !box;
    if (!box) return;
    const { width, height } = this.stageSize();
    const w = this.bar.offsetWidth;
    const h = this.bar.offsetHeight;
    // Clear of the turning handle above a transform frame.
    let y = box[1] - h - ROTATE_GAP - 14;
    if (y < 6) y = Math.min(box[3] + 14, height - h - 6);
    const x = Math.min(Math.max((box[0] + box[2]) / 2 - w / 2, 6), width - w - 6);
    this.bar.style.left = `${x}px`;
    this.bar.style.top = `${Math.max(y, 6)}px`;
  }

  /** The page the selection is on, else the page of the spread last clicked or picked, else its first page. */
  focusPage(): Page | null {
    const project = this.host.project();
    if (!project) return null;
    if (this.selection) {
      const page = project.pages.find((p) => p.id === this.selection!.pageId);
      if (page) return page;
    }
    const shown = this.currentPages().map((number) => project.pages[number - 1]).filter(Boolean);
    return shown.find((page) => page.id === this.focusedPageId) ?? shown[0] ?? null;
  }

  // --- layout ---------------------------------------------------------------

  resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    this.size = { width, height };
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.applyViewTransform();
    this.draw();
  }

  /**
   * The canvas on screen (CSS px), as of the last resize (the stage is watched
   * for that): reading it from the page while drawing would make the browser
   * lay out what the side panels just changed, in the middle of a frame.
   */
  private stageSize(): { width: number; height: number } {
    if (this.size) return this.size;
    const { width, height } = this.canvas.getBoundingClientRect();
    // Not kept while the editor is hidden: the next resize gives it.
    if (width && height) this.size = { width, height };
    return { width, height };
  }

  private layout(project: Project): Slot[] {
    const { width, height } = this.stageSize();
    const view = { single: this.single, continuous: this.continuous, rows: this.rows, zoom: this.zoom, pan: this.pan, width, height, gapMm: this.pageGapMm };
    return layoutPages(project, this.spreadList(), this.spreadIndex, view);
  }

  /** While sliding: each page part of the way from where it was. */
  private slid(slots: Slot[]): Slot[] {
    const sliding = this.sliding;
    if (!sliding) return slots;
    const t = (performance.now() - sliding.start) / SLIDE_MS;
    if (t >= 1) {
      this.sliding = null;
      return slots;
    }
    const ease = 1 - (1 - t) ** 3;
    this.requestDraw();
    return slots.map((slot) => {
      const from = sliding.from.get(slot.index);
      return from ? { ...slot, x: from[0] + (slot.x - from[0]) * ease, y: from[1] + (slot.y - from[1]) * ease } : slot;
    });
  }

  /** Whether any of a page (and its number) is on screen. */
  private onCanvas(project: Project, slot: Slot): boolean {
    const { width, height } = this.stageSize();
    return onStage(slot, project.pageFormat.canvasMm[1], width, height, this.rotation);
  }

  private slotAt(sx: number, sy: number, project: Project): Slot | null {
    return slotAt(this.slots, sx, sy, project.pageFormat);
  }

  /** The page under a point of the window, the point on it (mm) and the panel there. */
  /** Where a point of a shown page (mm) is in the window (client px), or null when the page is not shown. */
  clientOf(pageId: string, [x, y]: Point): Point | null {
    const slot = this.slots.find((s) => s.page.id === pageId);
    if (!slot) return null;
    let [sx, sy] = [slot.x + x * slot.scale, slot.y + y * slot.scale];
    if (this.rotation) {
      const [cx, cy] = this.centre();
      const [tx, ty] = this.turn(sx - cx, sy - cy, this.rotation);
      [sx, sy] = [cx + tx, cy + ty];
    }
    const rect = this.canvas.getBoundingClientRect();
    return [rect.left + sx, rect.top + sy];
  }

  pageAtClient(clientX: number, clientY: number): { page: Page; point: Point; panel?: Panel } | null {
    const project = this.host.project();
    if (!project) return null;
    const rect = this.canvas.getBoundingClientRect();
    let [sx, sy] = [clientX - rect.left, clientY - rect.top];
    if (this.rotation) {
      const [cx, cy] = this.centre();
      const [x, y] = this.turn(sx - cx, sy - cy, -this.rotation);
      [sx, sy] = [cx + x, cy + y];
    }
    const slot = this.slotAt(sx, sy, project);
    if (!slot) return null;
    const point = toPage(slot, sx, sy);
    return { page: slot.page, point, panel: this.panelAt(slot.page, point) };
  }

  /** The other page of the spread, if `slot` faces one. */
  private facingSlot(slot: Slot): Slot | null {
    const pair = this.spreadList().find((p) => p.includes(slot.index + 1));
    const other = pair?.find((page) => page !== null && page !== slot.index + 1);
    // Slots are laid out again on every draw, so match by page.
    return (other && this.slots.find((s) => s.index === other - 1)) || null;
  }

  /** Where the gutter between `slot` and its facing page is, in `slot`'s mm. */
  private gutterOf(slot: Slot, facing: Slot): number {
    return facing.x > slot.x ? slot.shown[1] : slot.shown[0];
  }

  /** The other page that a point (mm on `slot`) is over, if it is over another one. */
  private otherPageUnder(project: Project, slot: Slot, [x, y]: Point): Slot | null {
    const there = this.slotAt(slot.x + x * slot.scale, slot.y + y * slot.scale, project);
    if (there) return there.index === slot.index ? null : there;
    // Past the gutter, even beyond the facing page: the facing page.
    const facing = this.facingSlot(slot);
    const across = facing && (facing.x > slot.x ? x > slot.shown[1] : x < slot.shown[0]);
    return across ? facing : null;
  }

  /**
   * While something is dragged: what is dragged, drawn over the other pages
   * and the room between them too (its own page cuts it off at its edge), and
   * the page it goes to when let go, framed.
   */
  private drawDragged(project: Project): void {
    const drag = this.drag;
    const s = this.selection;
    if (drag?.kind !== "move" || !drag.moved || !s) return;
    const slot = this.slots.find((x) => x.index === drag.slot.index);
    if (!slot) return;
    const page = slot.page;
    const ids = (kind: ItemRef["kind"]) => new Set((drag.items ?? []).filter((item) => item.kind === kind).map((item) => item.id));
    const panels = ids("panel");
    const lines = ids("line");
    const strokes = ids("stroke");
    const fills = ids("fill");
    const breakouts = ids("breakout");
    if (!drag.items) {
      const own = { panel: panels, line: lines, stroke: strokes, fill: fills, breakout: breakouts } as Record<string, Set<string>>;
      own[s.kind]?.add(s.id);
      for (const line of drag.carried?.lines ?? []) lines.add(line.id);
      for (const stroke of drag.carried?.strokes ?? []) strokes.add(stroke.id);
      for (const fill of drag.carried?.fills ?? []) fills.add(fill.id);
    }
    const dragged: Page = {
      ...page,
      panels: page.panels.filter((x) => panels.has(x.id)),
      lines: page.lines.filter((x) => lines.has(x.id)),
      strokes: page.strokes.filter((x) => strokes.has(x.id)),
      breakouts: page.breakouts.filter((x) => breakouts.has(x.id)),
      fills: (page.fills ?? []).filter((x) => fills.has(x.id)),
      stickies: [],
    };
    const [, pageH] = project.pageFormat.canvasMm;
    const m = { scale: slot.scale, x: slot.x, y: slot.y };
    const ctx = this.ctx;
    ctx.save();
    // Everywhere but its own page, where it is drawn already.
    ctx.beginPath();
    ctx.rect(-1e5, -1e5, 2e5, 2e5);
    ctx.rect(slot.x + slot.shown[0] * slot.scale, slot.y, (slot.shown[1] - slot.shown[0]) * slot.scale, pageH * slot.scale);
    ctx.clip("evenodd");
    ctx.globalAlpha = 0.9;
    for (const panel of dragged.panels) {
      // Lifted off the paper: the pages under it show through a little.
      tracePath(ctx, panel.shape, m, true);
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.fill();
    }
    const brushes = project.brushes ?? [];
    drawStrokes(ctx, dragged, m, false, () => ACCENT, 0.7, brushes);
    drawPanelFills(ctx, dragged, m);
    drawPageFills(ctx, dragged, m);
    drawPanelBorders(ctx, dragged, m, () => ACCENT);
    drawStrokes(ctx, dragged, m, true, () => ACCENT, 0.7, brushes);
    drawBalloons(ctx, dragged, m);
    for (const line of dragged.lines) drawLineText(ctx, line, m);
    ctx.restore();

    // Where it goes: a panel on its own (not half of a 見開き panel), dialogue and rough lines.
    const panel = s.kind === "panel" && !drag.items ? dragged.panels[0] : undefined;
    const going = panel
      ? panel.spread
        ? []
        : [bounds(panel.shape)]
      : [...dragged.lines.map((line) => line.box), ...dragged.strokes.map((stroke) => bounds(stroke.points.map(([x, y]) => [x, y] as Point)))];
    if (!going.length) return;
    const box = bounds(going.flatMap(([x0, y0, x1, y1]) => [[x0, y0], [x1, y1]] as Point[]));
    const to = this.otherPageUnder(project, slot, [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
    if (!to) return;
    const [tx0, ty0, tx1, ty1] = trimBox(project.pageFormat);
    const left = to.x + Math.max(tx0, to.shown[0]) * to.scale;
    const right = to.x + Math.min(tx1, to.shown[1]) * to.scale;
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(left - 3, to.y + ty0 * to.scale - 3, right - left + 6, (ty1 - ty0) * to.scale + 6);
    ctx.setLineDash([]);
    const label = `${to.index + 1} ページへ${panel ? "（中身ごと）" : ""}`;
    ctx.font = "bold 13px system-ui, sans-serif";
    const w = ctx.measureText(label).width + 16;
    const lx = (left + right) / 2 - w / 2;
    const ly = to.y + ty0 * to.scale - 30;
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.roundRect(lx, ly, w, 22, 11);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lx + w / 2, ly + 11);
    ctx.restore();
  }

  /** The page settings follow the page worked on; 連続: its spread is the one worked on. */
  private focusOn(slot: Slot): void {
    this.focusedPageId = slot.page.id;
    const spread = this.spreadList().findIndex((pair) => pair.includes(slot.index + 1));
    const moved = this.continuous && spread >= 0 && spread !== this.spreadIndex;
    if (moved) this.spreadIndex = spread;
    this.host.selectionChanged(this.selection);
    if (moved) this.host.spreadChanged?.();
  }

  /**
   * The panels being reshaped, and the panel selected, where they run past
   * their page's edge on screen (over the facing page and the room between
   * pages): drawn there too, the selected one with its corners, so a side
   * pulled over the gutter stays in sight and can be taken again.
   */
  private drawOverflow(project: Project): void {
    const drag = this.drag;
    const s = this.selection;
    const pageId = drag && "slot" in drag && drag.slot ? drag.slot.page.id : s?.pageId;
    const slot = pageId ? this.slots.find((x) => x.page.id === pageId) : undefined;
    if (!slot) return;
    const ids = new Set<string>();
    if (drag?.kind === "vertex") ids.add(drag.panelId);
    else if (drag?.kind === "seam") for (const edge of drag.seam.edges) ids.add(edge.panelId);
    else if (drag && (drag.kind === "scale" || drag.kind === "rotate" || drag.kind === "warp")) for (const panel of drag.base.panels ?? []) ids.add(panel.id);
    const corners = !this.transforming && s?.kind === "panel" && s.pageId === slot.page.id ? s.id : null;
    if (corners) ids.add(corners);
    const [, pageH] = project.pageFormat.canvasMm;
    const left = slot.x + slot.shown[0] * slot.scale;
    const right = slot.x + slot.shown[1] * slot.scale;
    const panels = slot.page.panels.filter((panel) => ids.has(panel.id) && !panel.spread);
    const outside = panels.filter((panel) =>
      panel.shape.some(([x, y]) => {
        const sx = slot.x + x * slot.scale;
        return sx < left - 0.5 || sx > right + 0.5 || y < 0 || y > pageH;
      }),
    );
    if (!outside.length) return;
    const m = { scale: slot.scale, x: slot.x, y: slot.y };
    const ctx = this.ctx;
    ctx.save();
    // Everywhere but its own page, where it is drawn already.
    ctx.beginPath();
    ctx.rect(-1e5, -1e5, 2e5, 2e5);
    ctx.rect(left, slot.y, right - left, pageH * slot.scale);
    ctx.clip("evenodd");
    for (const panel of outside) {
      tracePath(ctx, panel.shape, m, true);
      ctx.fillStyle = "rgba(47, 111, 219, 0.12)";
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (panel.id !== corners) continue;
      ctx.fillStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      for (const [x, y] of panel.shape) {
        const [hx, hy] = [slot.x + x * slot.scale, slot.y + y * slot.scale];
        ctx.fillRect(hx - HANDLE, hy - HANDLE, HANDLE * 2, HANDLE * 2);
        ctx.strokeRect(hx - HANDLE, hy - HANDLE, HANDLE * 2, HANDLE * 2);
      }
    }
    ctx.restore();
  }

  /**
   * What was dragged onto another page goes to that page: dialogue and rough
   * lines past the gutter, or (連続) onto any page on the canvas, and a panel
   * with what is in it.
   */
  private carryToPageUnder(project: Project, slot: Slot): void {
    const s = this.selection;
    if (!s || s.pageId !== slot.page.id) return;
    const under = (point: Point) => this.otherPageUnder(project, slot, point);
    const centre = (box: BoxMm): Point => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    if (s.kind === "panel") {
      const panel = slot.page.panels.find((p) => p.id === s.id);
      // Half of a 見開き panel stays: it is one panel with the facing page's half.
      const to = panel && !panel.spread ? under(centre(bounds(panel.shape))) : null;
      if (!panel || !to) return;
      const [cx, cy] = centre(bounds(panel.shape));
      const at = toPage(to, slot.x + cx * slot.scale, slot.y + cy * slot.scale);
      const moved = placeHeld(project, to.page, holdPanel(project, slot.page, panel, to.page.id), at);
      this.selection = { kind: "panel", pageId: to.page.id, id: moved.id };
      this.focusOn(to);
      this.host.status(`コマを中身ごと ${to.index + 1} ページへ移しました（コマ ${moved.order}）`);
      return;
    }
    const all: ItemRef[] = s.kind === "group" ? (s.items ?? []) : s.kind === "line" || s.kind === "stroke" ? [{ kind: s.kind, id: s.id }] : [];
    // Panels, fills and はみ出し stay on their page.
    const items = all.filter((item) => item.kind === "line" || item.kind === "stroke");
    const moved: typeof items = [];
    const targets = new Set<Slot>();
    for (const item of items) {
      if (item.kind === "line") {
        const line = slot.page.lines.find((l) => l.id === item.id);
        const to = line && under(centre(line.box));
        if (!line || !to) continue;
        slot.page.lines = slot.page.lines.filter((l) => l !== line);
        moveLine(line, (slot.x - to.x) / slot.scale, (slot.y - to.y) / slot.scale);
        delete line.linkTo;
        to.page.lines.push(line);
        sortLines(to.page, this.binding());
        targets.add(to);
        moved.push(item);
      } else {
        const stroke = slot.page.strokes.find((x) => x.id === item.id);
        const to = stroke && under(centre(bounds(stroke.points.map(([x, y]) => [x, y] as Point))));
        if (!stroke || !to) continue;
        slot.page.strokes = slot.page.strokes.filter((x) => x !== stroke);
        moveStroke(stroke, (slot.x - to.x) / slot.scale, (slot.y - to.y) / slot.scale);
        to.page.strokes.push(stroke);
        targets.add(to);
        moved.push(item);
      }
    }
    if (!moved.length) return;
    const [first] = targets;
    // The selection follows when everything went to one page.
    if (moved.length === all.length && targets.size === 1) this.selection = { ...s, pageId: first.page.id };
    else if (s.kind === "group") this.selection = { ...s, items: all.filter((item) => !moved.includes(item)) };
    else this.selection = null;
    if (this.selection?.pageId === first.page.id) this.focusOn(first);
    else this.host.selectionChanged(this.selection);
    const pages = [...targets].map((t) => t.index + 1).sort((a, b) => a - b).join("・");
    this.host.status(`${moved.length} 個を ${pages} ページへ移しました`);
  }

  /**
   * ページをまたぐコマ: panels of the page drawn on past the gutter onto the
   * facing page (on screen beside it) become 見開き panels. Returns how many.
   */
  private spanPanels(project: Project, pageId: string): number {
    const slot = this.slots.find((s) => s.page.id === pageId);
    const facing = slot && this.facingSlot(slot);
    if (!slot || !facing) return 0;
    let count = 0;
    for (const panel of [...slot.page.panels]) if (spanGutter(project, slot.page, panel, this.firstAlone)) count++;
    if (count) this.host.status(`コマがのどを越えたので、${slot.index + 1}・${facing.index + 1} ページの見開きコマにしました（「見開きをやめる」で戻せます）`);
    return count;
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
    if (this.overlayFrame) {
      cancelAnimationFrame(this.overlayFrame);
      this.overlayFrame = 0;
    }
    // A hidden editor (a file loading before the editor shows) has no pixels to draw.
    if (!this.canvas.width || !this.canvas.height) return;
    const ctx = this.ctx;
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
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // A turned view leaves the corners outside the pages: the stage colour there.
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    const project = this.host.project();
    if (!project) return;
    this.slots = this.slid(this.layout(project));
    this.strokeCache.startFrame();
    const drawn = new Set<string>();
    for (const slot of this.slots) {
      if (!this.onCanvas(project, slot)) continue;
      this.drawPage(project, slot);
      drawn.add(slot.page.id);
    }
    this.strokeCache.forget(drawn);
    this.drawSpreadMarks(project);
    this.drawDragged(project);
    this.drawOverflow(project);
    this.keepCache();
    this.inline?.place();
    this.placeBar();
    this.drawOverlay();
  }

  private keepCache(): void {
    const cache = this.cache ?? document.createElement("canvas");
    if (cache.width !== this.canvas.width || cache.height !== this.canvas.height) {
      cache.width = this.canvas.width;
      cache.height = this.canvas.height;
    }
    const ctx = cache.getContext("2d")!;
    ctx.clearRect(0, 0, cache.width, cache.height);
    ctx.drawImage(this.canvas, 0, 0);
    this.cache = cache;
  }

  /** Redraw only what lies over the pages (hover marks, the eraser ring) on the next frame. */
  private requestOverlay(): void {
    if (this.frame || this.overlayFrame) return;
    this.overlayFrame = requestAnimationFrame(() => {
      this.overlayFrame = 0;
      if (!this.cache || this.drag) {
        this.draw();
        return;
      }
      const ctx = this.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.cache, 0, 0);
      ctx.restore();
      this.drawOverlay();
    });
  }

  /**
   * 見開きページ: a mark under the gutter when the two pages go to CSP as one.
   * 連続: the spread worked on (what the side panels are about) is framed.
   */
  private drawSpreadMarks(project: Project): void {
    const bySpread = new Map<number, Slot[]>();
    const list = this.spreadList();
    const spreadOf = new Map<number, number>();
    list.forEach((pair, i) => pair.forEach((page) => page !== null && spreadOf.set(page - 1, i)));
    for (const slot of this.slots) {
      const i = spreadOf.get(slot.index);
      if (i === undefined) continue;
      bySpread.set(i, [...(bySpread.get(i) ?? []), slot]);
    }
    const ctx = this.ctx;
    const pageH = project.pageFormat.canvasMm[1];
    for (const slots of bySpread.values()) {
      if (slots.length < 2 || !slots.some((slot) => this.onCanvas(project, slot))) continue;
      if (!wantsSpread(project, Math.min(...slots.map((slot) => slot.index)))) continue;
      const [left, right] = [...slots].sort((a, b) => a.x - b.x);
      const gutter = left.x + left.shown[1] * left.scale;
      ctx.save();
      ctx.fillStyle = "#3a6fd8";
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("見開きページ", gutter, right.y + pageH * right.scale + 18);
      ctx.restore();
    }
    const current = bySpread.get(this.spreadIndex);
    if (!this.continuous || !current || list.length < 2) return;
    const box = this.extent(current);
    if (!box) return;
    ctx.save();
    ctx.strokeStyle = "rgba(47, 111, 219, 0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(box[0] - 5, box[1] - 5, box[2] - box[0] + 10, box[3] - box[1] + 10, 6);
    ctx.stroke();
    ctx.restore();
  }

  /** The page as shown: without what the レイヤー list hides. */
  private visiblePage(page: Page): Page {
    // Lines on a hidden ラフ線のレイヤー.
    const project = this.host.project();
    const strokes = project ? shownStrokes(project, page.strokes) : page.strokes;
    if (strokes !== page.strokes) page = { ...page, strokes };
    if (!this.hidden.size) return page;
    const shown = <T extends { id: string }>(kind: string, list: T[]) => list.filter((item) => !this.hidden.has(`${kind}:${item.id}`));
    return {
      ...page,
      panels: shown("panel", page.panels),
      lines: shown("line", page.lines),
      strokes: shown("stroke", page.strokes),
      breakouts: shown("breakout", page.breakouts),
      ...(page.fills ? { fills: shown("fill", page.fills) } : {}),
      ...(page.stickies ? { stickies: shown("sticky", page.stickies) } : {}),
    };
  }

  /** A page shown small (連続, from afar): too small for its marks and memos. */
  private small(project: Project, slot: Slot): boolean {
    const [x0, , x1] = trimBox(project.pageFormat);
    return (x1 - x0) * slot.scale < SMALL_PAGE_PX;
  }

  private drawPage(project: Project, slot: Slot): void {
    const ctx = this.ctx;
    const { scale } = slot;
    const page = this.visiblePage(slot.page);
    const small = this.small(project, slot);
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
    // 資料画像, faint under the drawing.
    for (const reference of page.references ?? []) {
      const stored = imageOf(project, reference);
      const picture = stored && pictureOf(stored, () => this.requestDraw());
      if (!picture) continue;
      const [x0, y0, x1, y1] = reference.box;
      ctx.globalAlpha = opacityOf(reference);
      ctx.drawImage(picture, sx(x0), sy(y0), (x1 - x0) * scale, (y1 - y0) * scale);
    }
    ctx.globalAlpha = 1;
    if (this.tool === "reference") this.drawReferenceFrames(slot);

    const m = { scale, x: slot.x, y: slot.y };
    const brushes = this.host.project()?.brushes ?? [];
    const strokeColor = (stroke: Stroke) => (this.isSelected(page, "stroke", stroke.id) ? ACCENT : "#3a3834");
    const style = { color: strokeColor, minWidthPx: 0.7, brushes };
    const roughs = roughLayersOf(project);
    // Each ラフ線のレイヤー at its own opacity (hidden ones are not in `page`).
    const drawRoughs = (over: boolean) => {
      for (const layer of roughs) {
        const strokes = strokesOn(project, page.strokes, layer);
        if (!strokes.length) continue;
        ctx.globalAlpha = opacityOfLayer(layer);
        this.strokeCache.draw(ctx, page, project.pageFormat.canvasMm, m, over, style, roughs.length > 1 ? layer.id : "", strokes);
      }
      ctx.globalAlpha = 1;
    };
    drawRoughs(false);
    drawPanelFills(ctx, page, m);
    drawPageFills(ctx, page, m, (id) => (this.isSelected(page, "fill", id) ? ACCENT : null));
    const selectedPanels = page.panels.filter((panel) => this.isSelected(page, "panel", panel.id));
    for (const panel of selectedPanels) {
      tracePath(ctx, panel.shape, m, true);
      ctx.fillStyle = "rgba(47, 111, 219, 0.08)";
      ctx.fill();
    }
    drawPanelBorders(ctx, page, m, (panel) => (selectedPanels.includes(panel) ? ACCENT : INK));
    drawRoughs(true);

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
      const selected = selectedPanels.includes(panel);
      // Panels with no border at all still show where they are.
      if ((panel.border ?? "solid") === "none" && !selected) {
        tracePath(ctx, panel.shape, m, true);
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = "rgba(47, 111, 219, 0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const { x: nx, y: ny, radius } = this.badge(slot, panel, pageW);
      const swapping = this.drag?.kind === "swap" && this.drag.to?.panelId === panel.id && this.drag.to.slot.page === page;
      if (swapping) {
        tracePath(ctx, panel.shape, m, true);
        ctx.fillStyle = "rgba(47, 111, 219, 0.18)";
        ctx.fill();
      }
      // Pages seen from afar (連続) show the drawing, not the marks over it.
      if (!small || selected) {
        ctx.fillStyle = selected ? ACCENT : "rgba(47, 111, 219, 0.75)";
        ctx.beginPath();
        ctx.arc(nx, ny, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = `bold ${Math.round(radius * 1.2)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(panel.order), nx, ny);
      }
      // Corners to drag, for a panel selected on its own.
      if (selected && !this.transforming && this.selection?.kind === "panel") {
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
    for (const line of page.lines) {
      // コマ枠でマスク: the words go no further than the balloon does.
      const panel = line.mask ? page.panels.find((p) => p.id === line.panel) : undefined;
      const clip = panel && maskShape(panel);
      if (!clip) {
        this.drawLine(project, slot, line);
        continue;
      }
      ctx.save();
      tracePath(ctx, clip, m, true);
      ctx.clip();
      this.drawLine(project, slot, line);
      ctx.restore();
    }
    if (this.showNotes && !small) for (const panel of page.panels) if (panel.note) this.drawNote(slot, panel);
    for (const sticky of page.stickies ?? []) this.drawSticky(slot, sticky);
    ctx.restore();

    ctx.fillStyle = "#f4f3f0";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    if (project.scroll) {
      // 縦スクロール: the pieces touch; the number goes left of the strip, at the top of its piece.
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(String(slot.index + 1), sx(0) - 8, sy(0) + 4);
      return;
    }
    // The page number and its memo, wrapped to the page's width so the two pages of a spread do not run into each other.
    const [trimX0, , trimX1] = trimBox(project.pageFormat);
    const memo = page.memo && !small ? `  ${page.memo.replace(/\s*\n\s*/g, " ")}` : "";
    const rows = wrapText(ctx, `${slot.index + 1}${memo}`, Math.max(small ? 0 : 80, (trimX1 - trimX0) * scale - 8), 2);
    rows.forEach((row, i) => ctx.fillText(row, sx((trimX0 + trimX1) / 2), sy(pageH) + 18 + i * 16));
  }

  /** 資料: every picture's outline, the chosen one with corners to drag. */
  private drawReferenceFrames(slot: Slot): void {
    const ctx = this.ctx;
    for (const reference of slot.page.references ?? []) {
      const chosen = this.reference?.pageId === slot.page.id && this.reference.id === reference.id;
      const [x0, y0, x1, y1] = reference.box.map((v, i) => (i % 2 ? slot.y : slot.x) + v * slot.scale);
      ctx.save();
      ctx.setLineDash(chosen ? [] : [4, 3]);
      ctx.strokeStyle = chosen ? ACCENT : "rgba(47, 111, 219, 0.55)";
      ctx.lineWidth = chosen ? 1.5 : 1;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      if (chosen) {
        ctx.setLineDash([]);
        ctx.fillStyle = "#ffffff";
        for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
          ctx.fillRect(x - HANDLE, y - HANDLE, HANDLE * 2, HANDLE * 2);
          ctx.strokeRect(x - HANDLE, y - HANDLE, HANDLE * 2, HANDLE * 2);
        }
      }
      ctx.restore();
    }
  }

  /** 資料: the chosen picture's corner under a screen point (0–3), or -1. */
  private referenceCornerAt(slot: Slot, sx: number, sy: number): number {
    const chosen = this.reference?.pageId === slot.page.id ? slot.page.references?.find((r) => r.id === this.reference!.id) : undefined;
    if (!chosen) return -1;
    return corners(chosen.box).findIndex(([x, y]) => Math.hypot(slot.x + x * slot.scale - sx, slot.y + y * slot.scale - sy) <= REFERENCE_HANDLE + 2);
  }

  /** Choose a 資料画像 (or none) with the 資料 tool. */
  chooseReference(reference: { pageId: string; id: string } | null): void {
    this.reference = reference;
    this.host.referenceChanged?.();
    this.draw();
  }

  /** Where a panel's memo sits on screen: inside its top-left corner, as wide as the panel allows. */
  private noteBox(slot: Slot, panel: Panel): { x: number; y: number; w: number; h: number; rows: string[] } {
    // On the paper: a 裁ち切り panel's tag sits inside the trim, not out in the bleed.
    const format = this.host.project()?.pageFormat;
    const [tx0, ty0, tx1, ty1] = format ? trimBox(format) : [-Infinity, 0, Infinity, Infinity];
    const [x0, y0, x1, y1] = bounds(panel.shape);
    const left = Math.max(x0, slot.shown[0], tx0);
    const right = Math.min(x1, slot.shown[1], tx1);
    const top = Math.max(y0, 0, ty0);
    const bottom = Math.min(y1, ty1);
    // Leave room for the panel's number at the top right.
    const room = Math.max(60, Math.min((right - left) * slot.scale - 8 - 2 * Math.max(4 * slot.scale, 7) - 6, 280));
    const ctx = this.ctx;
    ctx.font = NOTE_FONT;
    const rows = panel.note ? wrapText(ctx, panel.note, room - 10, 4) : [];
    const w = rows.length ? Math.min(room, Math.max(...rows.map((row) => ctx.measureText(row).width)) + 10) : 52;
    const h = Math.max(rows.length, 1) * NOTE_ROW + 4;
    // The top left corner, or another one when dialogue is there (balloons start at the top right).
    const [sl, sr, st, sb] = [slot.x + left * slot.scale + 4, slot.x + right * slot.scale - 4 - w, slot.y + top * slot.scale + 4, slot.y + bottom * slot.scale - 4 - h];
    const corners: [number, number][] = [
      [sl, st],
      [sl, sb],
      [sr, sb],
    ];
    const balloons = slot.page.lines
      .filter((line) => line.panel === panel.id)
      .map((line) => {
        const [bx0, by0, bx1, by1] = balloonExtent(line);
        return [slot.x + bx0 * slot.scale, slot.y + by0 * slot.scale, slot.x + bx1 * slot.scale, slot.y + by1 * slot.scale];
      });
    const clear = ([x, y]: [number, number]) => balloons.every(([bx0, by0, bx1, by1]) => x + w < bx0 || x > bx1 || y + h < by0 || y > by1);
    // Moved by hand: where it was put, wherever the panel goes.
    if (panel.noteAt) return { x: slot.x + (x0 + panel.noteAt[0]) * slot.scale, y: slot.y + (y0 + panel.noteAt[1]) * slot.scale, w, h, rows };
    const [x, y] = corners.find(clear) ?? corners[0];
    return { x, y, w, h, rows };
  }

  /** A panel's memo, on a pale tag in its corner (screen only). */
  private drawNote(slot: Slot, panel: Panel): void {
    const ctx = this.ctx;
    const { x, y, w, h, rows } = this.noteBox(slot, panel);
    ctx.save();
    if (panel.noteAt) {
      // Moved away from its panel: a line back to it, as a comment points at its cell.
      const [x0, y0, x1, y1] = bounds(panel.shape);
      const inset = 3;
      const ax = Math.min(Math.max(x + w / 2, slot.x + (x0 + inset) * slot.scale), slot.x + (x1 - inset) * slot.scale);
      const ay = Math.min(Math.max(y + h / 2, slot.y + (y0 + inset) * slot.scale), slot.y + (y1 - inset) * slot.scale);
      this.leader(ax, ay, [x, y, x + w, y + h], "rgba(170, 140, 40, 0.85)");
    }
    ctx.fillStyle = "rgba(255, 246, 194, 0.92)";
    ctx.strokeStyle = "rgba(170, 140, 40, 0.6)";
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = "#4a3f12";
    ctx.font = NOTE_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    rows.forEach((row, i) => ctx.fillText(row, x + 5, y + 4 + i * NOTE_ROW));
    ctx.restore();
  }

  /** The panel whose memo tag (or, for the panel under the pointer, its "＋メモ" tag) is at a screen point. */
  private noteAt(slot: Slot, sx: number, sy: number): Panel | undefined {
    const hovered = this.hover?.kind === "item" && this.hover.target.kind === "panel" ? this.hover.target.id : null;
    const project = this.host.project();
    if (project && this.small(project, slot)) return undefined;
    return slot.page.panels.find((panel) => {
      if (!(this.showNotes && panel.note) && panel.id !== hovered) return false;
      const { x, y, w, h } = this.noteBox(slot, panel);
      return sx >= x && sx <= x + w && sy >= y && sy <= y + h;
    });
  }

  /** 付箋: a coloured note with its text; only here, never in exports. */
  private drawSticky(slot: Slot, sticky: Sticky): void {
    const ctx = this.ctx;
    const [x0, y0, x1, y1] = stickyBox(sticky);
    const sx = slot.x + x0 * slot.scale;
    const sy = slot.y + y0 * slot.scale;
    const w = (x1 - x0) * slot.scale;
    const h = (y1 - y0) * slot.scale;
    const anchor = stickyAnchor(slot.page, sticky);
    if (anchor) this.leader(slot.x + anchor[0] * slot.scale, slot.y + anchor[1] * slot.scale, [sx, sy, sx + w, sy + h], "rgba(120, 96, 20, 0.9)", STICKY_COLORS[sticky.color ?? "yellow"].fill);
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = STICKY_COLORS[sticky.color ?? "yellow"].fill;
    ctx.fillRect(sx, sy, w, h);
    ctx.restore();
    if (this.isSelected(slot.page, "sticky", sticky.id)) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx - 1, sy - 1, w + 2, h + 2);
    }
    const size = STICKY_TEXT_MM * slot.scale;
    ctx.fillStyle = sticky.text ? "#3a3420" : "rgba(58, 52, 32, 0.45)";
    ctx.font = `${size}px sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    stickyRows(sticky.text).forEach((row, i) => ctx.fillText(row, sx + 2 * slot.scale, sy + 2 * slot.scale + i * size * 1.3));
    if (this.isSelected(slot.page, "sticky", sticky.id) && (this.tool === "select" || this.tool === "sticky")) {
      // The handle to tie it to a panel or a line: drag it there.
      const [hx, hy] = this.stickyHandle(slot, sticky);
      ctx.beginPath();
      ctx.arc(hx, hy, LINK_HANDLE, 0, Math.PI * 2);
      ctx.fillStyle = anchor ? ACCENT : "#ffffff";
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  /** A line from a point on the page to the nearest edge of a box (screen px), with a dot at the point. */
  private leader(ax: number, ay: number, [x0, y0, x1, y1]: BoxMm, color: string, dot = "#fff6c2"): void {
    const ctx = this.ctx;
    const nx = Math.min(Math.max(ax, x0), x1);
    const ny = Math.min(Math.max(ay, y0), y1);
    ctx.save();
    if (Math.hypot(nx - ax, ny - ay) > 2) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(nx, ny);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(ax, ay, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = dot;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  /** Where a 付箋's link handle is on screen: the point it is tied to, else its bottom left corner. */
  private stickyHandle(slot: Slot, sticky: Sticky): Point {
    const anchor = stickyAnchor(slot.page, sticky);
    if (anchor) return [slot.x + anchor[0] * slot.scale, slot.y + anchor[1] * slot.scale];
    const [x0, , , y1] = stickyBox(sticky);
    return [slot.x + x0 * slot.scale, slot.y + y1 * slot.scale];
  }

  /** The line or panel at a point, to tie a 付箋 to. */
  private linkTarget(slot: Slot, point: Point): Selection | null {
    const page = this.visiblePage(slot.page);
    const line = this.linesAt(slot, point)[0];
    if (line) return { kind: "line", pageId: page.id, id: line };
    const panel = this.panelAt(page, point);
    return panel ? { kind: "panel", pageId: page.id, id: panel.id } : null;
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
    if (speaker && !this.small(project, slot)) {
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
      // しっぽの先 (drag to point at the speaker) and its middle (drag to bend it).
      this.drawTailHandles(slot, line, true);
    }
  }

  private drawOverlay(): void {
    const ctx = this.ctx;
    const drag = this.drag;
    // Slots are laid out again on every draw: the hover's page as it is now placed.
    const hoverSlot = this.hover && this.slots.find((s) => s.page.id === this.hover!.slot.page.id);
    const seam = drag?.kind === "seam" ? drag : this.hover?.kind === "seam" && hoverSlot ? { slot: hoverSlot, seam: this.hover.seam } : null;
    if (seam) {
      // The border under the pointer (or being moved): its edges, thick.
      const { slot } = seam;
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      for (const [a, b] of seamLines(slot.page, seam.seam)) {
        ctx.beginPath();
        ctx.moveTo(slot.x + a[0] * slot.scale, slot.y + a[1] * slot.scale);
        ctx.lineTo(slot.x + b[0] * slot.scale, slot.y + b[1] * slot.scale);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (!drag && this.hover?.kind === "item" && hoverSlot) {
      const { target } = this.hover;
      const slot = hoverSlot;
      const m = { scale: slot.scale, x: slot.x, y: slot.y };
      ctx.save();
      ctx.strokeStyle = "rgba(47, 111, 219, 0.55)";
      ctx.lineWidth = 2;
      if (target.kind === "panel") {
        const panel = slot.page.panels.find((p) => p.id === target.id);
        if (panel) {
          tracePath(ctx, panel.shape, m, true);
          ctx.stroke();
          if (!panel.note || !this.showNotes) {
            // An invitation to write the panel's memo right here.
            const { x, y } = this.noteBox(slot, panel);
            ctx.fillStyle = "rgba(255, 246, 194, 0.85)";
            ctx.fillRect(x, y, 52, NOTE_ROW + 4);
            ctx.fillStyle = "#7a6a2a";
            ctx.font = NOTE_FONT;
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.fillText("＋ メモ", x + 6, y + 4);
          }
        }
      } else if (target.kind === "line") {
        const line = slot.page.lines.find((l) => l.id === target.id);
        if (line) {
          const [x0, y0, x1, y1] = line.box;
          ctx.strokeRect(slot.x + x0 * slot.scale - 3, slot.y + y0 * slot.scale - 3, (x1 - x0) * slot.scale + 6, (y1 - y0) * slot.scale + 6);
          if (!this.isSelected(slot.page, "line", line.id)) this.drawTailHandles(slot, line, false);
        }
      }
      ctx.restore();
    }
    if (!drag && this.hover?.kind === "tail" && hoverSlot) {
      const { lineId } = this.hover.hit;
      const line = hoverSlot.page.lines.find((l) => l.id === lineId);
      if (line && !this.isSelected(hoverSlot.page, "line", line.id)) this.drawTailHandles(hoverSlot, line, true);
    }
    this.drawGrid(this.host.project()!);
    // The outline being placed snaps its next corner: the guides after it.
    this.drawPolygon();
    this.drawGuides();
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
    if (drag?.kind === "fill" && drag.points.length > 2) {
      // The area as it will be filled, while it is drawn round.
      const { slot } = drag;
      tracePath(ctx, drag.points, { scale: slot.scale, x: slot.x, y: slot.y }, true);
      ctx.fillStyle = this.fillTone === "black" ? "rgba(40, 38, 34, 0.55)" : this.fillTone === "gray" ? "rgba(150, 146, 140, 0.55)" : "rgba(255, 255, 255, 0.8)";
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.stroke();
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
    if (drag?.kind === "stickyLink" && this.pointer) {
      const { slot } = drag;
      const sticky = slot.page.stickies?.find((n) => n.id === drag.stickyId);
      if (sticky) {
        const [x0, y0, x1, y1] = stickyBox(sticky);
        const [px, py] = this.pointer;
        if (drag.to) {
          const box = drag.to.kind === "panel" ? slot.page.panels.find((p) => p.id === drag.to!.id)?.shape : null;
          if (box) {
            tracePath(ctx, box, { scale: slot.scale, x: slot.x, y: slot.y }, true);
            ctx.fillStyle = "rgba(201, 154, 18, 0.18)";
            ctx.fill();
          }
        }
        this.leader(px, py, [slot.x + x0 * slot.scale, slot.y + y0 * slot.scale, slot.x + x1 * slot.scale, slot.y + y1 * slot.scale], ACCENT);
        ctx.fillStyle = ACCENT;
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(drag.to ? (drag.to.kind === "panel" ? "このコマに紐づける" : "このセリフに紐づける") : sticky.link ? "ここで離すと紐づけを外す" : "コマかセリフの上で離す", px + 10, py - 6);
      }
    }
    if (drag?.kind === "swap" && this.pointer) {
      // An arrow from the panel's number to where its contents go.
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(drag.at[0], drag.at[1]);
      ctx.lineTo(this.pointer[0], this.pointer[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ACCENT;
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(drag.to ? "ここに入れ替え" : "入れ替えるコマへ", this.pointer[0] + 10, this.pointer[1] - 6);
    }
    if (drag?.kind === "pen") {
      const { slot, points } = drag;
      const brush = this.brush("pen");
      // 抜き (the taper at the end) comes when the pen lifts, as in CSP.
      const cut: [boolean, boolean] = [false, true];
      const stroke = { id: "", points, widthMm: this.penWidthMm, closed: false, brush: brush?.id, cut };
      drawStroke(ctx, stroke, { scale: slot.scale, x: slot.x, y: slot.y }, "#3a3834", 0.7, brush);
    }
    this.drawFrame();
    if (this.tool === "pen" && !this.erasing() && !this.spaceHeld && this.pointer && penPreferences.settings.cursor === "brush") {
      // The pen's size where it will draw (a cross in it when it is small).
      const [px, py] = this.pointer;
      const radius = Math.max(((this.penWidthMm / 2) * (this.slots[0]?.scale ?? 1)), 2);
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.beginPath();
      ctx.arc(px, py, radius + 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(30, 30, 30, 0.85)";
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      if (radius < 5) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          ctx.moveTo(px + dx * (radius + 2), py + dy * (radius + 2));
          ctx.lineTo(px + dx * (radius + 6), py + dy * (radius + 6));
        }
      }
      ctx.stroke();
      ctx.restore();
    }
    if (this.erasing() && this.eraseMode !== "lasso" && this.pointer) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.pointer[0], this.pointer[1], this.eraserRadiusPx(), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // --- 吸着・コマを描く -------------------------------------------------------------

  /** What panel points on `page` snap to, but the panels `exclude` (the ones being changed). */
  private snapTargetsOn(project: Project, page: Page, exclude: Iterable<string> = []): SnapTargets {
    return snapTargets(page, project.pageFormat, this.snapping, gutters(project), new Set(exclude));
  }

  /** A panel point snapped (nothing with Alt): `beside` are the corners it lines up with; the lines it went onto show. */
  private snapped(slot: Slot, point: Point, targets: SnapTargets, free: boolean, beside: readonly Point[] = []): Point {
    if (free) {
      this.guides = null;
      return point;
    }
    const result = snapPointTo(point, targets, 8 / slot.scale, this.snapping.axis ? beside : []);
    this.guides = { pageId: slot.page.id, ...result.guides };
    return result.point;
  }

  /** A panel drawn on `page` (inside another one: an inset over it), selected. */
  private addFreePanel(project: Project, page: Page, outline: Point[]): void {
    this.host.begin();
    const panel = addDrawnPanel(project, page, outline);
    if (!panel) {
      this.host.cancel();
      this.host.status("コマにするには、もう少し大きく囲んでください");
      return;
    }
    this.host.commit();
    this.select({ kind: "panel", pageId: page.id, id: panel.id });
    this.host.status(
      panel.z
        ? `コマ ${panel.order} を足しました（中に描いたので、はめ込みにしました）`
        : `コマ ${panel.order} を足しました。選択で角をドラッグすると形を変えられます`,
    );
  }

  /** Which way the project's pages and panels read. */
  private binding(): Binding {
    return this.host.project()?.binding ?? "right";
  }

  /** 多角形: whether corners are being placed. */
  get placingCorners(): boolean {
    return this.polygon !== null;
  }

  /** The page of the outline being placed, as laid out now. */
  private polygonSlot(): Slot | null {
    const polygon = this.polygon;
    return polygon ? (this.slots.find((slot) => slot.page.id === polygon.pageId) ?? null) : null;
  }

  /** The next corner, snapped, from the pointer at `point` on the outline's page. */
  private nextCorner(slot: Slot, point: Point, free: boolean): Point {
    const points = this.polygon?.points ?? [];
    const project = this.host.project();
    if (!project) return point;
    const beside = points.length ? [points[points.length - 1], points[0]] : [];
    return this.snapped(slot, point, this.snapTargetsOn(project, slot.page), free, beside);
  }

  /** 多角形: a click places a corner; on the first corner (or the last again) it closes the outline into a panel. */
  private placeCorner(slot: Slot, point: Point, free: boolean): void {
    const polygon = this.polygon?.pageId === slot.page.id ? this.polygon : null;
    if (!polygon) {
      this.polygon = { pageId: slot.page.id, points: [this.nextCorner(slot, point, free)] };
      this.host.status("多角形: クリックで角を置く。最初の角をクリック・ダブルクリック・Enter で閉じてコマに（Backspace で 1 つ戻す、Esc でやめる）");
      this.requestOverlay();
      return;
    }
    const near = (p: Point) => Math.hypot(p[0] - point[0], p[1] - point[1]) * slot.scale <= 8;
    if (polygon.points.length >= 3 && (near(polygon.points[0]) || near(polygon.points[polygon.points.length - 1]))) {
      this.finishPolygon();
      return;
    }
    polygon.points.push(this.nextCorner(slot, point, free));
    this.guides = null;
    this.requestOverlay();
  }

  /** 多角形: the corners placed make a panel (with three or more). */
  finishPolygon(): boolean {
    const polygon = this.polygon;
    const project = this.host.project();
    if (!polygon || !project) return false;
    this.polygon = null;
    this.guides = null;
    const page = project.pages.find((p) => p.id === polygon.pageId);
    if (page && polygon.points.length >= 3) this.addFreePanel(project, page, polygon.points);
    else this.host.status("コマにするには角を 3 つ以上置いてください");
    this.draw();
    return true;
  }

  /** 多角形: stop placing corners (`last`: take back only the last one). */
  cancelPolygon(last = false): boolean {
    if (!this.polygon) return false;
    if (last && this.polygon.points.length > 1) this.polygon.points.pop();
    else {
      this.polygon = null;
      this.host.status("");
    }
    this.guides = null;
    this.requestOverlay();
    return true;
  }

  /** コマ割り: cut, draw rectangles or place corners. */
  setPanelMode(mode: PanelMode): void {
    this.panelMode = mode;
    if (mode !== "polygon") this.cancelPolygon();
    this.requestOverlay();
  }

  /** 連続: room between the spreads (mm), the spread worked on staying where it is on screen. */
  setPageGap(mm: number): void {
    const project = this.host.project();
    const next = Math.min(Math.max(0, mm), MAX_PAGE_GAP_MM);
    if (next === this.pageGapMm) return;
    const before = project && this.continuous ? this.spreadBox(this.layout(project)) : null;
    this.pageGapMm = next;
    const after = project && this.continuous ? this.spreadBox(this.layout(project)) : null;
    if (before && after) {
      this.pan[0] += before[0] - after[0];
      this.pan[1] += before[1] - after[1];
    }
    this.draw();
  }

  /** The lines snapped to, across the page they are on. */
  private drawGuides(): void {
    const guides = this.guides;
    const slot = guides && this.slots.find((s) => s.page.id === guides.pageId);
    if (!guides || !slot || (!guides.xs.length && !guides.ys.length)) return;
    const [pageW, pageH] = this.host.project()!.pageFormat.canvasMm;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = GUIDE;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (const x of guides.xs) {
      ctx.moveTo(slot.x + x * slot.scale, slot.y);
      ctx.lineTo(slot.x + x * slot.scale, slot.y + pageH * slot.scale);
    }
    for (const y of guides.ys) {
      ctx.moveTo(slot.x + slot.shown[0] * slot.scale, slot.y + y * slot.scale);
      ctx.lineTo(slot.x + Math.min(slot.shown[1], pageW) * slot.scale, slot.y + y * slot.scale);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** The grid (when panels snap to it) on the pages, while panels are cut, drawn or changed. */
  private drawGrid(project: Project): void {
    const { grid, gridMm } = this.snapping;
    const panelDrag = this.drag && ["frame", "vertex", "seam", "scale"].includes(this.drag.kind);
    const moving = this.drag?.kind === "move" && !!this.drag.snap;
    if (!grid || !(this.tool === "cut" || panelDrag || moving)) return;
    const [pageW, pageH] = project.pageFormat.canvasMm;
    const [bx, by] = basicBox(project.pageFormat);
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(47, 111, 219, 0.14)";
    ctx.lineWidth = 1;
    for (const slot of this.slots) {
      // Too fine to see: no grid.
      if (gridMm * slot.scale < 4 || this.small(project, slot)) continue;
      const [x0, x1] = slot.shown;
      ctx.beginPath();
      for (let x = bx - Math.floor((bx - x0) / gridMm) * gridMm; x <= x1; x += gridMm) {
        ctx.moveTo(slot.x + x * slot.scale, slot.y);
        ctx.lineTo(slot.x + x * slot.scale, slot.y + pageH * slot.scale);
      }
      for (let y = by - Math.floor(by / gridMm) * gridMm; y <= pageH; y += gridMm) {
        ctx.moveTo(slot.x + x0 * slot.scale, slot.y + y * slot.scale);
        ctx.lineTo(slot.x + Math.min(x1, pageW) * slot.scale, slot.y + y * slot.scale);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 多角形: the corners placed, and the side to where the pointer is. */
  private drawPolygon(): void {
    const polygon = this.polygon;
    const slot = this.polygonSlot();
    if (!polygon || !slot) return;
    const ctx = this.ctx;
    const at = ([x, y]: Point): Point => [slot.x + x * slot.scale, slot.y + y * slot.scale];
    const points = [...polygon.points];
    let closing = false;
    if (this.pointer && !this.drag) {
      const pointer = toPage(slot, ...this.pointer);
      const first = polygon.points[0];
      closing = polygon.points.length >= 3 && Math.hypot(first[0] - pointer[0], first[1] - pointer[1]) * slot.scale <= 8;
      if (!closing) points.push(this.nextCorner(slot, pointer, false));
    }
    ctx.save();
    if (points.length >= 3) {
      tracePath(ctx, points, { scale: slot.scale, x: slot.x, y: slot.y }, true);
      ctx.fillStyle = "rgba(47, 111, 219, 0.08)";
      ctx.fill();
    }
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    tracePath(ctx, points, { scale: slot.scale, x: slot.x, y: slot.y }, closing);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    polygon.points.forEach((point, i) => {
      const [px, py] = at(point);
      const r = i === 0 && closing ? HANDLE + 2 : HANDLE - 1;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  }

  // --- 変形（拡大縮小・回転・反転） -------------------------------------------------------

  /** What the transform frame works on: rough lines and dialogue picked, or what is being transformed. */
  private selectedItems(): ItemRef[] {
    const s = this.selection;
    if (s?.kind === "group") {
      const page = this.host.project()?.pages.find((p) => p.id === s.pageId);
      return page ? withContents(page, s.items ?? [], this.panelCarries) : [];
    }
    if (s?.kind === "stroke") return [{ kind: "stroke", id: s.id }];
    if (!s || !this.transforming) return [];
    if (s.kind === "panel") {
      const page = this.host.project()?.pages.find((p) => p.id === s.pageId);
      const panel = page?.panels.find((p) => p.id === s.id);
      if (!page || !panel) return [];
      const items: ItemRef[] = [{ kind: "panel", id: panel.id }];
      if (this.panelCarries) {
        // コマ枠フォルダ: what is drawn in the panel goes with it.
        const carried = carryContents(page, panel);
        items.push(
          ...carried.strokes.map(({ id }) => ({ kind: "stroke" as const, id })),
          ...carried.lines.map(({ id }) => ({ kind: "line" as const, id })),
          ...(carried.fills ?? []).map(({ id }) => ({ kind: "fill" as const, id })),
        );
      }
      return items;
    }
    if (s.kind === "line" || s.kind === "fill" || s.kind === "breakout") return [{ kind: s.kind, id: s.id }];
    return [];
  }

  get isTransforming(): boolean {
    return this.transforming;
  }

  /** 変形 on or off for the selection (Ctrl+T); false when it cannot be transformed. */
  toggleTransform(on = !this.transforming): boolean {
    const s = this.selection;
    if (on) {
      if (!s || !["panel", "line", "fill", "breakout", "stroke", "group"].includes(s.kind)) return false;
      const page = this.host.project()?.pages.find((p) => p.id === s.pageId);
      if (s.kind === "panel" && page?.panels.find((p) => p.id === s.id)?.spread) {
        this.host.status("見開きのコマは変形できません。頂点や間白で形を変えてください");
        return false;
      }
      if (this.tool !== "select") this.setTool("select");
    }
    this.transforming = on;
    this.renderBar();
    this.draw();
    this.host.status(
      on
        ? "変形: 四角をドラッグで拡大縮小（Shift で縦横別々、Alt で中心から）、丸で回転、Ctrl + 角で自由変形。Enter で終わる"
        : "",
    );
    return true;
  }

  /** The transform frame on screen: its box (mm), slot and handle positions (px). */
  private frameGeometry(): { slot: Slot; box: BoxMm; handles: Point[]; rotate: Point } | null {
    if (this.tool !== "select" || !this.selection) return null;
    const items = this.selectedItems();
    const slot = this.slots.find((s) => s.page.id === this.selection!.pageId);
    if (!items.length || !slot) return null;
    // A panel's frame is the panel's own box; what is in it just goes along.
    const own = this.selection.kind === "group" ? (this.selection.items ?? []) : items[0].kind === "panel" ? items.slice(0, 1) : items;
    const box = baseBounds(transformBase(slot.page, own));
    if (!box) return null;
    const pad = 3 / slot.scale;
    const [x0, y0, x1, y1] = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
    const sx = (x: number) => slot.x + x * slot.scale;
    const sy = (y: number) => slot.y + y * slot.scale;
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const handles: Point[] = [
      [sx(x0), sy(y0)],
      [sx(x1), sy(y0)],
      [sx(x1), sy(y1)],
      [sx(x0), sy(y1)],
      [sx(cx), sy(y0)],
      [sx(x1), sy(cy)],
      [sx(cx), sy(y1)],
      [sx(x0), sy(cy)],
    ];
    return { slot, box: [x0, y0, x1, y1], handles, rotate: [sx(cx), sy(y0) - ROTATE_GAP] };
  }

  private drawFrame(): void {
    const drag = this.drag;
    if (drag?.kind === "warp") {
      // The four corners as they are being pulled.
      const { slot } = drag;
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      tracePath(ctx, drag.corners, { scale: slot.scale, x: slot.x, y: slot.y }, true);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      for (const [x, y] of drag.corners) {
        const [px, py] = [slot.x + x * slot.scale, slot.y + y * slot.scale];
        ctx.fillRect(px - HANDLE + 1, py - HANDLE + 1, 2 * HANDLE - 2, 2 * HANDLE - 2);
        ctx.strokeRect(px - HANDLE + 1, py - HANDLE + 1, 2 * HANDLE - 2, 2 * HANDLE - 2);
      }
      ctx.restore();
      return;
    }
    if (drag && drag.kind !== "scale" && drag.kind !== "rotate") return;
    const frame = this.frameGeometry();
    if (!frame) return;
    const ctx = this.ctx;
    const [tl, tr, , bl] = frame.handles;
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(tl[0], tl[1], tr[0] - tl[0], bl[1] - tl[1]);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo((tl[0] + tr[0]) / 2, tl[1]);
    ctx.lineTo(...frame.rotate);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    for (const [x, y] of frame.handles) {
      ctx.fillRect(x - HANDLE + 1, y - HANDLE + 1, 2 * HANDLE - 2, 2 * HANDLE - 2);
      ctx.strokeRect(x - HANDLE + 1, y - HANDLE + 1, 2 * HANDLE - 2, 2 * HANDLE - 2);
    }
    ctx.beginPath();
    ctx.arc(frame.rotate[0], frame.rotate[1], HANDLE, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** The frame handle at a screen point: 0..7, 8 for turning, or -1. */
  private frameHandleAt(sx: number, sy: number): number {
    const frame = this.frameGeometry();
    if (!frame) return -1;
    if (Math.hypot(frame.rotate[0] - sx, frame.rotate[1] - sy) <= HANDLE + 3) return FRAME_HANDLES;
    return frame.handles.findIndex(([x, y]) => Math.abs(x - sx) <= HANDLE + 2 && Math.abs(y - sy) <= HANDLE + 2);
  }

  private static handleCursor(handle: number): string {
    return handle === FRAME_HANDLES ? "grab" : ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize", "ns-resize", "ew-resize", "ns-resize", "ew-resize"][handle];
  }

  /** 左右反転 / 上下反転 / 90° turns of the selected rough lines and dialogue. */
  transformSelection(how: "flipH" | "flipV" | "left" | "right"): boolean {
    const page = this.focusPage();
    const items = this.selectedItems();
    if (!page || !items.length) return false;
    const base = transformBase(page, items);
    const box = baseBounds(base);
    if (!box) return false;
    const centre: Point = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    const m =
      how === "flipH" ? scaling(-1, 1, centre) : how === "flipV" ? scaling(1, -1, centre) : rotation(((how === "right" ? 1 : -1) * Math.PI) / 2, centre);
    this.host.begin();
    transformItems(page, base, m);
    assignPanels(page);
    sortLines(page, this.binding());
    this.host.commit();
    this.draw();
    return true;
  }

  // --- コピー・貼り付け -------------------------------------------------------------

  /** Copy what is selected; with `cut`, take it away too (the caller deletes). */
  copy(): boolean {
    const page = this.focusPage();
    const s = this.selection;
    if (!page || !s) return false;
    const panel = s.kind === "panel" ? page.panels.find((p) => p.id === s.id) : undefined;
    const source = s.kind === "group" ? { ...s, items: withContents(page, s.items ?? [], this.panelCarries) } : s;
    const clip = copySelection(page, source, panel ? panelContents(page, panel) : undefined);
    if (!clip) return false;
    this.clip = clip;
    this.pastes = 0;
    const count = clip.panels.length + clip.strokes.length + clip.lines.length + clip.breakouts.length + clip.stickies.length + (clip.fills?.length ?? 0);
    this.host.status(`${clip.panels.length ? "コマと中身" : `${count} 個`}をコピーしました。Ctrl+V で、ポインターのあるページに貼り付けます`);
    return true;
  }

  get canPaste(): boolean {
    return this.clip !== null;
  }

  /**
   * Paste onto the page under the pointer (or the selection's page, or the
   * right page of the spread): where it was on its page, a little lower
   * right each time it goes onto its own page again.
   */
  /** Where something pasted goes: the page under the pointer (and the point there), else the page worked on. */
  pasteTarget(): { page: Page; point?: Point } | null {
    const project = this.host.project();
    if (!project) return null;
    const under = this.pointer && this.slotAt(this.pointer[0], this.pointer[1], project);
    if (under) return { page: under.page, point: toPage(under, this.pointer![0], this.pointer![1]) };
    const page = this.focusPage();
    return page ? { page } : null;
  }

  paste(): boolean {
    const project = this.host.project();
    if (!project || !this.clip) return false;
    const under = this.pointer && this.slotAt(this.pointer[0], this.pointer[1], project);
    const selected = this.selection && this.slots.find((slot) => slot.page.id === this.selection!.pageId);
    const focused = this.focusPage();
    const slot = under || selected || this.slots.find((s) => s.page === focused) || [...this.slots].sort((a, b) => b.x - a.x)[0];
    if (!slot) return false;
    const page = slot.page;
    if (page.id === this.clip.pageId) this.pastes += 1;
    const shift = page.id === this.clip.pageId ? this.pastes * 5 : 0;
    this.host.begin();
    const pasted = pasteClip(project, page, this.clip, [shift, shift]);
    this.host.commit();
    const items: ItemRef[] = [
      ...pasted.strokes.map((id) => ({ kind: "stroke" as const, id })),
      ...pasted.lines.map((id) => ({ kind: "line" as const, id })),
      ...pasted.panels.map((id) => ({ kind: "panel" as const, id })),
      ...pasted.fills.map((id) => ({ kind: "fill" as const, id })),
      ...pasted.breakouts.map((id) => ({ kind: "breakout" as const, id })),
    ];
    // One panel goes on with what is in it; more things are picked together.
    if (pasted.panels.length === 1 && !pasted.fills.length && !pasted.breakouts.length) this.select({ kind: "panel", pageId: page.id, id: pasted.panels[0] });
    else if (items.length > 1) this.select({ kind: "group", pageId: page.id, id: "group", items });
    else if (items.length) this.select({ kind: items[0].kind, pageId: page.id, id: items[0].id });
    else if (pasted.stickies.length) this.select({ kind: "sticky", pageId: page.id, id: pasted.stickies[0] });
    this.host.status(`${slot.index + 1} ページに貼り付けました`);
    return true;
  }

  /** Ctrl+A: everything on the page (but halves of 見開き panels), to move or transform the page's whole drawing. */
  selectAll(): boolean {
    const page = this.focusPage();
    if (!page) return false;
    const items: ItemRef[] = [
      ...page.panels.filter((panel) => !panel.spread).map((p) => ({ kind: "panel" as const, id: p.id })),
      ...page.strokes.map((s) => ({ kind: "stroke" as const, id: s.id })),
      ...page.lines.map((l) => ({ kind: "line" as const, id: l.id })),
      ...(page.fills ?? []).map((f) => ({ kind: "fill" as const, id: f.id })),
      ...page.breakouts.map((b) => ({ kind: "breakout" as const, id: b.id })),
    ];
    if (!items.length) return false;
    this.setTool("select");
    this.select(items.length === 1 ? { kind: items[0].kind, pageId: page.id, id: items[0].id } : { kind: "group", pageId: page.id, id: "group", items });
    this.host.status(`${pickedSummary(items)}を選びました。枠の四角で大きさ、丸で向き、Ctrl + 角で自由変形`);
    return true;
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

  /** Whether `point` is on one of the picked lines, inside a picked text, or inside a picked panel, fill or はみ出し. */
  private groupHit(page: Page, point: Point, tolerance: number): boolean {
    for (const item of this.selection?.items ?? []) {
      if (item.kind === "stroke") {
        const stroke = page.strokes.find((x) => x.id === item.id);
        if (stroke && strokeHit(stroke, point, tolerance + stroke.widthMm)) return true;
      } else if (item.kind === "line") {
        const line = page.lines.find((l) => l.id === item.id);
        if (line && insideBox(line.box, point)) return true;
      } else {
        const list = item.kind === "panel" ? page.panels : item.kind === "fill" ? (page.fills ?? []) : page.breakouts;
        const shape = list.find((x) => x.id === item.id)?.shape;
        if (shape && insidePolygon(shape, point)) return true;
      }
    }
    return false;
  }

  /** Follow the pen's eraser end (button 5, buttons bit 32) as it comes and goes. */
  private setTipEraser(event: PointerEvent): void {
    const pen = penPreferences.settings;
    const end = pen.eraserEnd && (event.button === 5 || (event.buttons & 32) !== 0);
    // The side button held as the pen touches: the eraser too, when set so.
    const side = pen.sideButton === "eraser" && (event.button === 2 || (event.buttons & 2) !== 0);
    const tip = event.pointerType === "pen" && (end || side);
    if (tip !== this.tipEraser) {
      this.tipEraser = tip;
      this.updateCursor();
    }
  }

  // --- hit testing ---------------------------------------------------------------

  private hit(slot: Slot, point: Point): Selection | null {
    // What is hidden cannot be picked on the page.
    const page = this.visiblePage(slot.page);
    const tolerance = 6 / slot.scale;
    // 付箋 lie on top of everything.
    for (const sticky of [...(page.stickies ?? [])].reverse()) {
      if (insideBox(stickyBox(sticky), point)) return { kind: "sticky", pageId: page.id, id: sticky.id };
    }
    // Overlapping balloons: the selected one stays the one picked (a double-click writes in it).
    const under = this.linesAt(slot, point);
    const selected = this.selection?.kind === "line" && this.selection.pageId === page.id ? this.selection.id : null;
    const line = under.find((id) => id === selected) ?? under[0];
    if (line) return { kind: "line", pageId: page.id, id: line };
    const project = this.host.project();
    for (const stroke of [...page.strokes].reverse()) {
      // Lines on a locked layer are not picked.
      if (project && !strokeEditable(project, stroke)) continue;
      if (strokeHit(stroke, point, tolerance)) return { kind: "stroke", pageId: page.id, id: stroke.id };
    }
    for (const fill of [...(page.fills ?? [])].reverse()) {
      if (insidePolygon(fill.shape, point)) return { kind: "fill", pageId: page.id, id: fill.id };
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

  /** Lines whose balloon or text is under `point`, top first. */
  private linesAt(slot: Slot, point: Point): string[] {
    const page = this.visiblePage(slot.page);
    return [...page.lines]
      .reverse()
      .filter((line) => {
        const [x0, y0, x1, y1] = line.box;
        return (line.balloon && insidePolygon(line.balloon, point)) || insideBox([x0 - 1.5, y0 - 1.5, x1 + 1.5, y1 + 1.5], point);
      })
      .map((line) => line.id);
  }

  private vertexAt(slot: Slot, sx: number, sy: number): number {
    const s = this.selection;
    if (!s || s.kind !== "panel" || s.pageId !== slot.page.id || this.transforming) return -1;
    const panel = slot.page.panels.find((p) => p.id === s.id);
    if (!panel) return -1;
    return panel.shape.findIndex(
      ([x, y]) => Math.abs(slot.x + x * slot.scale - sx) <= HANDLE + 2 && Math.abs(slot.y + y * slot.scale - sy) <= HANDLE + 2,
    );
  }

  /** Where a panel's number sits (screen px). Numbers stay inside the page even for panels that run off it. */
  private badge(slot: Slot, panel: Panel, pageW: number): { x: number; y: number; radius: number } {
    const [, y0, x1] = bounds(panel.shape);
    const radius = Math.max(4 * slot.scale, 7);
    // On the paper: a 裁ち切り panel's number sits at the trim, not out in the bleed.
    const format = this.host.project()?.pageFormat;
    const [, ty0, tx1] = format ? trimBox(format) : [0, 0, pageW];
    return {
      x: Math.min(slot.x + x1 * slot.scale, slot.x + Math.min(pageW, tx1) * slot.scale) - radius - 3,
      y: Math.max(slot.y + y0 * slot.scale, slot.y + Math.max(0, ty0) * slot.scale) + radius + 3,
      radius,
    };
  }

  /** The panel whose number is under the pointer. */
  private badgeAt(slot: Slot, sx: number, sy: number, pageW: number): Panel | undefined {
    const project = this.host.project();
    if (project && this.small(project, slot)) return undefined;
    return [...stacked(slot.page.panels)].reverse().find((panel) => {
      const { x, y, radius } = this.badge(slot, panel, pageW);
      return Math.hypot(x - sx, y - sy) <= radius + 2;
    });
  }

  /** The topmost panel at a point of a page (insets over their panel). */
  private panelAt(page: Page, point: Point): Panel | undefined {
    return [...stacked(page.panels)].reverse().find((panel) => insidePolygon(panel.shape, point));
  }

  /**
   * The tail under the pointer: its tip, its middle (to bend it, on the
   * selected or hovered line) or anywhere along it. Any line's tails can be
   * taken, without picking the line first.
   */
  private tailAt(slot: Slot, sx: number, sy: number): TailHit | null {
    const s = this.selection;
    const near = (p: Point, extra = 3) => Math.hypot(slot.x + p[0] * slot.scale - sx, slot.y + p[1] * slot.scale - sy) <= HANDLE + extra;
    const point = toPage(slot, sx, sy);
    const shown = new Set<string>();
    if (s?.kind === "line" && s.pageId === slot.page.id) shown.add(s.id);
    if (this.hover?.kind === "item" && this.hover.target.kind === "line") shown.add(this.hover.target.id);
    if (this.hover?.kind === "tail") shown.add(this.hover.hit.lineId);
    // The selected line's tails first, then the others from the top.
    const lines = [...slot.page.lines].reverse().sort((a, b) => Number(shown.has(b.id)) - Number(shown.has(a.id)));
    for (const line of lines) {
      for (const [index, tail] of (line.tails ?? []).entries()) {
        if (near(tail.tip)) return { lineId: line.id, index, part: "tip" };
        const geometry = tailGeometry(line, tail);
        if (!geometry) continue;
        if (shown.has(line.id) && near(geometry.middle, 2)) return { lineId: line.id, index, part: "bend" };
        if (shown.has(line.id) && near(geometry.root, 2)) return { lineId: line.id, index, part: "root" };
        // Along the tail (outside the balloon): root to middle to tip.
        const reach = Math.max(6 / slot.scale, 1.2);
        const close = (a: Point, b: Point) => distanceToSegment(point, a, b) <= reach;
        if ((close(geometry.root, geometry.middle) || close(geometry.middle, tail.tip)) && !insideBalloon(line, point)) {
          return { lineId: line.id, index, part: "body" };
        }
      }
    }
    return null;
  }

  /** The tails of a line with their handles: tips (round) and middles (to bend). */
  private drawTailHandles(slot: Slot, line: Line, strong: boolean): void {
    const ctx = this.ctx;
    const at = ([x, y]: Point): Point => [slot.x + x * slot.scale, slot.y + y * slot.scale];
    ctx.save();
    ctx.strokeStyle = strong ? ACCENT : "rgba(47, 111, 219, 0.7)";
    ctx.lineWidth = 1.5;
    const s = this.selection;
    const chosen = s?.kind === "line" && s.id === line.id && s.pageId === slot.page.id ? s.tail : undefined;
    for (const [index, tail] of (line.tails ?? []).entries()) {
      const geometry = tailGeometry(line, tail);
      if (geometry) {
        const [mx, my] = at(geometry.middle);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(mx, my - HANDLE + 1);
        ctx.lineTo(mx + HANDLE - 1, my);
        ctx.lineTo(mx, my + HANDLE - 1);
        ctx.lineTo(mx - HANDLE + 1, my);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // 根本: a small square on the outline, to slide the tail along the balloon.
        const [rx, ry] = at(geometry.root);
        const r = HANDLE - 1.5;
        ctx.fillStyle = tail.root === undefined ? "#ffffff" : "rgba(47, 111, 219, 0.35)";
        ctx.fillRect(rx - r, ry - r, r * 2, r * 2);
        ctx.strokeRect(rx - r, ry - r, r * 2, r * 2);
      }
      // The chosen tail's tip is filled (Delete removes that tail).
      const [tx, ty] = at(tail.tip);
      ctx.fillStyle = index === chosen ? ACCENT : "#ffffff";
      ctx.beginPath();
      ctx.arc(tx, ty, index === chosen ? HANDLE + 1 : HANDLE, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
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
      fill: "crosshair",
      breakout: "crosshair",
      sticky: "copy",
      reference: "default",
    };
    const eraser = this.eraseMode === "lasso" ? "crosshair" : "none";
    const hover =
      this.tool === "select" && this.hover
        ? this.hover.kind === "seam"
          ? PageEditor.seamCursor(this.hover.seam)
          : this.hover.kind === "handle"
            ? PageEditor.handleCursor(this.hover.handle)
            : this.hover.kind === "tail" && (this.hover.hit.part === "bend" || this.hover.hit.part === "root")
              ? "grab"
              : "move"
        : null;
    const look = penPreferences.settings.cursor;
    cursors.pen = look === "brush" ? "none" : look === "dot" ? DOT_CURSOR : "crosshair";
    this.canvas.style.cursor = this.spaceHeld ? "grab" : this.tipEraser ? eraser : this.tool === "eraser" ? eraser : hover ?? cursors[this.tool];
  }

  private pointerDown(event: PointerEvent): void {
    if (event.pointerType === "pen") {
      this.penSeen = event.timeStamp;
      // The pen wins over a finger moving the view.
      if (this.drag && this.dragPointerType === "touch") this.abandonDrag();
    }
    if (event.pointerType === "touch" && this.touchDown(event)) return;
    // One drag at a time: another pen or mouse press waits for it to end.
    if (this.drag && this.dragPointer !== null && event.pointerId !== this.dragPointer) return;
    this.press(event);
    if (this.drag && this.drag.kind !== "pinch") {
      this.dragPointer = event.pointerId;
      this.dragPointerType = event.pointerType;
    }
  }

  // --- fingers ----------------------------------------------------------------------

  /** A finger comes down: true when it is taken here (moving the view), false to draw with it. */
  private touchDown(event: PointerEvent): boolean {
    const pen = penPreferences.settings;
    // 手のひら: the hand resting on the screen while the pen draws.
    if (pen.palmRejection && (event.timeStamp - this.penSeen < 500 || this.dragPointerType === "pen")) return true;
    const at: Point = [event.offsetX, event.offsetY];
    this.touches.set(event.pointerId, at);
    this.touchStarts.set(event.pointerId, at);
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Not tracked any more: the finger just does nothing.
    }
    if (!this.gesture) this.gesture = { start: event.timeStamp, most: 0, moved: false };
    this.gesture.most = Math.max(this.gesture.most, this.touches.size);
    if (this.touches.size === 1) {
      if (pen.touch === "draw") return false;
      if (pen.touch === "pan") {
        this.drag = { kind: "pan", x: event.clientX, y: event.clientY };
        this.dragPointer = event.pointerId;
        this.dragPointerType = "touch";
      }
      return true;
    }
    // A second finger: what the first began gives way to the pinch.
    this.abandonDrag();
    if (this.touches.size === 2 && pen.pinch) this.startPinch();
    return true;
  }

  private startPinch(): void {
    const [[a, pa], [b, pb]] = [...this.touches.entries()];
    const mid: Point = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    const [cx, cy] = this.centre();
    const [ux, uy] = this.turn(mid[0] - cx, mid[1] - cy, -this.rotation);
    this.drag = {
      kind: "pinch",
      ids: [a, b],
      dist: Math.max(Math.hypot(pb[0] - pa[0], pb[1] - pa[1]), 1),
      angle: Math.atan2(pb[1] - pa[1], pb[0] - pa[0]),
      zoom: this.zoom,
      rotation: this.rotation,
      v: [(ux - this.pan[0]) / this.zoom, (uy - this.pan[1]) / this.zoom],
    };
    this.dragPointer = null;
    this.dragPointerType = "touch";
  }

  /** Zoom, turn and move the view with the two fingers: what was under them stays under them. */
  private pinchMove(drag: Extract<Drag, { kind: "pinch" }>): void {
    const pa = this.touches.get(drag.ids[0]);
    const pb = this.touches.get(drag.ids[1]);
    if (!pa || !pb) return;
    const mid: Point = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    const zoom = Math.min(Math.max((drag.zoom * Math.hypot(pb[0] - pa[0], pb[1] - pa[1])) / drag.dist, 0.3), 12);
    if (penPreferences.settings.pinchRotate) {
      let rotation = drag.rotation + Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) - drag.angle;
      const full = Math.PI * 2;
      rotation = ((((rotation + Math.PI) % full) + full) % full) - Math.PI;
      // Upright again when close to it.
      if (Math.abs(rotation) < (3 * Math.PI) / 180) rotation = 0;
      if (rotation !== this.rotation) {
        this.rotation = rotation;
        this.applyViewTransform();
      }
    }
    const [cx, cy] = this.centre();
    const [ux, uy] = this.turn(mid[0] - cx, mid[1] - cy, -this.rotation);
    this.zoom = zoom;
    this.pan = [ux - drag.v[0] * zoom, uy - drag.v[1] * zoom];
    this.requestDraw();
  }

  /** After an error: forget the drag in progress without finishing it (the change it made was undone). */
  dropDrag(): void {
    this.drag = null;
    this.base = null;
    this.afterUp = null;
    this.dragPointer = null;
    this.dragPointerType = "";
  }

  /** Give up the drag in progress: a line not yet drawn goes; a change already made stays. */
  private abandonDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.base = null;
    this.guides = null;
    if (["move", "vertex", "seam", "scale", "rotate", "warp", "tail", "erase"].includes(drag.kind)) this.completeDrag(drag);
    this.dragPointer = null;
    this.dragPointerType = "";
    this.draw();
  }

  private press(event: PointerEvent): void {
    const project = this.host.project();
    if (!project) return;
    // A click away from text being written only ends the writing.
    if (this.inline) {
      this.inline.finish(true);
      return;
    }
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks: carry on without capture.
    }
    const [sx, sy] = this.at(event);
    // Shift + Space: turn the view (as in CSP); Space or the middle button: move it.
    if (this.spaceHeld && event.shiftKey) {
      this.drag = { kind: "turn", from: this.angleAt(sx, sy), rotation: this.rotation };
      return;
    }
    if (event.button === 1 || this.spaceHeld) {
      this.drag = { kind: "pan", x: event.clientX, y: event.clientY };
      return;
    }
    // The pen's side button (as the right button) does what the tablet settings say.
    if (event.pointerType === "pen" && event.button === 2) {
      const side = penPreferences.settings.sideButton;
      if (side === "pan") {
        this.drag = { kind: "pan", x: event.clientX, y: event.clientY };
        return;
      }
      if (side === "undo") {
        this.host.run("undo");
        return;
      }
    }
    // A pen's eraser end reports button 5 (buttons bit 32): erase with any tool.
    this.setTipEraser(event);
    if (event.button !== 0 && !this.tipEraser) return;
    let slot = this.slotAt(sx, sy, project);
    // The selected panel's corners, also where they lie past its page (over the facing one).
    const selectedOn = this.tool === "select" && this.selection?.kind === "panel" ? this.slots.find((x) => x.page.id === this.selection!.pageId) : undefined;
    if (selectedOn && selectedOn !== slot && this.vertexAt(selectedOn, sx, sy) >= 0) slot = selectedOn;
    if (!slot) {
      this.select(null);
      return;
    }
    // The page settings follow the page worked on (the left page of a spread too).
    if (this.focusedPageId !== slot.page.id) this.focusOn(slot);
    const point = toPage(slot, sx, sy);
    PRESS[this.tipEraser ? "eraser" : this.tool](this.core, { event, project, slot, point, sx, sy });
  }

  /** What the tools may see and do (their press, drag and finish are in their own modules). */
  private toolView(): EditorCore {
    const editor = this;
    return {
      // A getter: the tools are made before the constructor has the host.
      get host() {
        return editor.host;
      },
      get slots() {
        return editor.slots;
      },
      get selection() {
        return editor.selection;
      },
      get pointer() {
        return editor.pointer;
      },
      get reference() {
        return editor.reference;
      },
      get panelMode() {
        return editor.panelMode;
      },
      get panelCarries() {
        return editor.panelCarries;
      },
      get balloonTextFollows() {
        return editor.balloonTextFollows;
      },
      get eraseMode() {
        return editor.eraseMode;
      },
      get fillTone() {
        return editor.fillTone;
      },
      get roughLayer() {
        return editor.roughLayer;
      },
      get penWidthMm() {
        return editor.penWidthMm;
      },
      get guides() {
        return editor.guides;
      },
      set guides(guides) {
        editor.guides = guides;
      },
      startDrag: (drag) => (this.drag = drag),
      afterUp: (action) => (this.afterUp = action),
      pickLater: (action, ms) => (this.cycleTimer = window.setTimeout(action, ms)),
      select: (selection) => this.select(selection),
      setSelection: (selection) => (this.selection = selection),
      chooseReference: (reference) => this.chooseReference(reference),
      forgetHover: () => (this.hover = null),
      requestDraw: () => this.requestDraw(),
      requestOverlay: () => this.requestOverlay(),
      captureBase: () => this.captureBase(),
      at: (event) => this.at(event),
      slotAt: (sx, sy, project) => this.slotAt(sx, sy, project),
      facingSlot: (slot) => this.facingSlot(slot),
      gutterOf: (slot, facing) => this.gutterOf(slot, facing),
      binding: () => this.binding(),
      brush: (kind) => this.brush(kind),
      eraserRadiusPx: (scale) => this.eraserRadiusPx(scale),
      hit: (slot, point) => this.hit(slot, point),
      linesAt: (slot, point) => this.linesAt(slot, point),
      panelAt: (page, point) => this.panelAt(page, point),
      vertexAt: (slot, sx, sy) => this.vertexAt(slot, sx, sy),
      tailAt: (slot, sx, sy) => this.tailAt(slot, sx, sy),
      badgeAt: (slot, sx, sy, pageW) => this.badgeAt(slot, sx, sy, pageW),
      noteAt: (slot, sx, sy) => this.noteAt(slot, sx, sy),
      noteBox: (slot, panel) => this.noteBox(slot, panel),
      stickyHandle: (slot, sticky) => this.stickyHandle(slot, sticky),
      linkTarget: (slot, point) => this.linkTarget(slot, point),
      referenceCornerAt: (slot, sx, sy) => this.referenceCornerAt(slot, sx, sy),
      isSelected: (page, kind, id) => this.isSelected(page, kind, id),
      groupHit: (page, point, tolerance) => this.groupHit(page, point, tolerance),
      selectedItems: () => this.selectedItems(),
      frameHandleAt: (sx, sy) => this.frameHandleAt(sx, sy),
      frameGeometry: () => this.frameGeometry(),
      snapTargetsOn: (project, page, exclude) => this.snapTargetsOn(project, page, exclude),
      snapped: (slot, point, targets, free, beside) => this.snapped(slot, point, targets, free, beside),
      moveSelection: (page, dx, dy, items) => this.moveSelection(page, dx, dy, items),
      follow: (page, carried) => this.follow(page, carried),
      carryToPageUnder: (project, slot) => this.carryToPageUnder(project, slot),
      spanPanels: (project, pageId) => this.spanPanels(project, pageId),
      addFreePanel: (project, page, outline) => this.addFreePanel(project, page, outline),
      placeCorner: (slot, point, free) => this.placeCorner(slot, point, free),
      editInPlace: (pageId, kind, id) => this.editInPlace(pageId, kind, id),
    };
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
    if (event.pointerType === "pen") this.penSeen = event.timeStamp;
    if (event.pointerType === "touch") {
      // Fingers not taken (the hand under the pen) do nothing.
      if (!this.touches.has(event.pointerId)) return;
      const at: Point = [event.offsetX, event.offsetY];
      this.touches.set(event.pointerId, at);
      const start = this.touchStarts.get(event.pointerId);
      if (this.gesture && start && Math.hypot(at[0] - start[0], at[1] - start[1]) > 10) this.gesture.moved = true;
      if (this.drag?.kind === "pinch") {
        this.pinchMove(this.drag);
        return;
      }
    }
    if (this.drag && this.dragPointer !== null && event.pointerId !== this.dragPointer) return;
    const [ex, ey] = this.at(event);
    this.pointer = [ex, ey];
    const drag = this.drag;
    if (!drag) {
      this.setTipEraser(event);
      this.scheduleHover(ex, ey);
      if (this.erasing() || this.tool === "pen" || this.polygon) this.requestOverlay();
      return;
    }
    if (drag.kind === "pan") {
      // The pages follow the hand on screen, however the view is turned.
      const [dx, dy] = this.turn(event.clientX - drag.x, event.clientY - drag.y, -this.rotation);
      this.pan[0] += dx;
      this.pan[1] += dy;
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.requestDraw();
      return;
    }
    if (drag.kind === "turn") {
      // The angle on screen: turning the view moves the local frame along.
      const [lx, ly] = this.at(event);
      const [wx, wy] = this.turn(lx - this.centre()[0], ly - this.centre()[1], this.rotation);
      let rotation = drag.rotation + Math.atan2(wy, wx) - drag.from;
      if (event.altKey) rotation = Math.round(rotation / (Math.PI / 12)) * (Math.PI / 12);
      this.setRotation(rotation);
      return;
    }
    if (drag.kind === "pinch") return;
    const point = toPage(drag.slot, ex, ey);
    const project = this.host.project()!;
    if (dragHandler(drag).move(this.core, drag, { event, project, point, ex, ey }) === false) return;
    this.requestDraw();
  }

  private pointerUp(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      const tracked = this.touches.delete(event.pointerId);
      this.touchStarts.delete(event.pointerId);
      if (!tracked) return;
      const gesture = this.gesture;
      if (!this.touches.size && gesture) {
        this.gesture = null;
        // A quick tap with two fingers undoes, with three redoes (as in CSP).
        if (penPreferences.settings.touchTaps && gesture.most >= 2 && !gesture.moved && event.timeStamp - gesture.start < 400) {
          this.host.run(gesture.most === 2 ? "undo" : "redo");
        }
      }
      if (this.drag?.kind === "pinch") {
        if (this.touches.size < 2) {
          this.drag = null;
          this.dragPointerType = "";
          this.draw();
        }
        return;
      }
    }
    if (this.drag && this.dragPointer !== null && event.pointerId !== this.dragPointer) return;
    this.dragPointer = null;
    this.dragPointerType = "";
    const drag = this.drag;
    this.drag = null;
    this.base = null;
    this.guides = null;
    const after = this.afterUp;
    this.afterUp = null;
    if (after) setTimeout(after, 0);
    if (!drag) return;
    this.completeDrag(drag);
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.draw();
  }

  /** Finish what a drag did: keep the change for undo, make what was drawn. */
  private completeDrag(drag: Drag): void {
    const project = this.host.project();
    if (!project || drag.kind === "pan" || drag.kind === "turn" || drag.kind === "pinch") return;
    dragHandler(drag).end(this.core, drag, project);
  }

  /** Move what is selected; `items`: a 範囲選択 with what its panels hold, as taken when the drag began. */
  private moveSelection(page: Page, dx: number, dy: number, items?: ItemRef[]): void {
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
    } else if (s.kind === "sticky") {
      const sticky = page.stickies?.find((n) => n.id === s.id);
      if (sticky) {
        sticky.at = [sticky.at[0] + dx, sticky.at[1] + dy];
        const project = this.host.project();
        if (project) keepStickyOnPage(project, sticky);
      }
    } else if (s.kind === "fill") {
      const fill = page.fills?.find((f) => f.id === s.id);
      if (fill) fill.shape = fill.shape.map(([x, y]) => [x + dx, y + dy]);
    } else if (s.kind === "group") {
      moveItems(page, items ?? this.selectedItems(), dx, dy);
    } else {
      const stroke = page.strokes.find((p) => p.id === s.id);
      if (stroke) moveStroke(stroke, dx, dy);
    }
  }

  /** Contents carried by the selected panel follow it. */
  private follow(page: Page, carried: CarriedContents | undefined): void {
    const s = this.selection;
    const panel = carried && s?.kind === "panel" ? page.panels.find((p) => p.id === s.id) : undefined;
    if (panel && carried) followPanel(page, panel, carried);
  }

  /** Look for what is under the pointer once a frame, however often it moves. */
  private scheduleHover(sx: number, sy: number): void {
    this.hoverAt = [sx, sy];
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      if (this.hoverAt && !this.drag) this.updateHover(...this.hoverAt);
    });
  }

  /** What the select tool would grab here: shown by a mark and the cursor. */
  private updateHover(sx: number, sy: number): void {
    const project = this.host.project();
    let hover: Hover | null = null;
    if (project && this.tool === "select" && !this.spaceHeld && !this.tipEraser) {
      const slot = this.slotAt(sx, sy, project);
      const frameHandle = this.frameHandleAt(sx, sy);
      if (frameHandle >= 0 && slot) hover = { kind: "handle", slot, handle: frameHandle };
      else if (slot) {
        const point = toPage(slot, sx, sy);
        const tail = this.tailAt(slot, sx, sy);
        if (tail) hover = { kind: "tail", slot, hit: tail };
        const onHandle = !!tail || this.vertexAt(slot, sx, sy) >= 0 || !!this.badgeAt(slot, sx, sy, project.pageFormat.canvasMm[0]);
        const target = onHandle ? null : this.hit(slot, point);
        if (!onHandle && (!target || target.kind === "panel")) {
          const seam = seamAt(slot.page, point, 6 / slot.scale);
          if (seam) hover = { kind: "seam", slot, seam };
        }
        if (!hover && target) hover = { kind: "item", slot, target };
      }
    }
    const key = (h: Hover | null) =>
      !h ? "" : h.kind === "tail" ? `tail:${h.hit.lineId}:${h.hit.index}:${h.hit.part}` : h.kind === "handle" ? `handle:${h.handle}` : h.kind === "seam" ? `seam:${h.slot.page.id}:${h.seam.edges.map((e) => `${e.panelId}.${e.edge}`).join(",")}` : `item:${h.target.pageId}:${h.target.kind}:${h.target.id}`;
    if (key(hover) === key(this.hover)) return;
    this.hover = hover;
    this.updateCursor();
    this.requestOverlay();
  }

  /** The cursor for moving a border: across it. */
  private static seamCursor(seam: Seam): string {
    const [nx, ny] = seam.normal;
    if (Math.abs(ny) > 2 * Math.abs(nx)) return "ns-resize";
    if (Math.abs(nx) > 2 * Math.abs(ny)) return "ew-resize";
    return nx * ny > 0 ? "nwse-resize" : "nesw-resize";
  }

  private doubleClick(event: MouseEvent): void {
    window.clearTimeout(this.cycleTimer);
    if (this.tool === "cut" && this.finishPolygon()) return;
    const project = this.host.project();
    if (!project || this.tool !== "select") return;
    const [ex, ey] = this.at(event);
    const slot = this.slotAt(ex, ey, project);
    if (!slot) return;
    const point = toPage(slot, ex, ey);
    const target = this.hit(slot, point);
    // Dialogue: write it right there.
    if (target?.kind === "line") {
      this.editInPlace(slot.page.id, "line", target.id);
      return;
    }
    if (target && target.kind !== "panel") return;
    // Inside a panel: its memo.
    const panel = this.panelAt(slot.page, point);
    if (panel) {
      this.select({ kind: "panel", pageId: slot.page.id, id: panel.id });
      this.editInPlace(slot.page.id, "note", panel.id);
      return;
    }
    // つなげる: double-click the gutter between two panels.
    const seam = seamAt(slot.page, point, 6 / slot.scale);
    if (!seam?.between) return;
    const ids = [...new Set(seam.edges.map((edge) => edge.panelId))];
    if (ids.length !== 2) {
      this.host.status("つなげられるのは、境目の両側が 1 コマずつのときです");
      return;
    }
    const [a, b] = ids.map((id) => slot.page.panels.find((p) => p.id === id)!).sort((x, y) => x.order - y.order);
    this.host.begin();
    if (!joinPanels(slot.page, a, b, project.binding)) {
      this.host.cancel();
      this.host.status("この 2 つのコマは形がそろっていないか見開きなので、つなげられません");
      return;
    }
    assignPanels(slot.page);
    sortLines(slot.page, this.binding());
    this.host.commit();
    this.hover = null;
    this.select({ kind: "panel", pageId: slot.page.id, id: a.id });
    this.host.status(`コマ ${a.order} と隣のコマをつなげました（元に戻すは Ctrl+Z）`);
  }

  /** Whether text is being written on the page right now. */
  get editingInPlace(): boolean {
    return this.inline !== null;
  }

  /**
   * Write a panel's memo or a line of dialogue in a field laid over the page,
   * where it is. The page follows each key; Ctrl+Enter or a click elsewhere
   * keeps it (one undo step), Esc puts it back.
   */
  editInPlace(pageId: string, kind: "note" | "line", id: string): void {
    this.inline?.finish(true);
    const project = this.host.project();
    const page = project?.pages.find((p) => p.id === pageId);
    const panel = kind === "note" ? page?.panels.find((p) => p.id === id) : undefined;
    const line = kind === "line" ? page?.lines.find((l) => l.id === id) : undefined;
    if (!page || (!panel && !line)) return;
    if (!this.slots.some((slot) => slot.page.id === pageId)) this.showPage(pageIndex(project!, pageId) + 1);
    const field = document.createElement("textarea");
    field.className = `inline-edit ${kind}`;
    field.spellcheck = false;
    const original = (panel ? panel.note : line!.text) ?? "";
    field.value = original;
    if (panel) field.placeholder = "このコマのメモ（狙い・演出・直したいこと）";
    const apply = (value: string) => {
      if (panel) {
        if (value.trim()) panel.note = value;
        else delete panel.note;
      } else if (line) {
        setLineText(line, value);
      }
    };
    const place = () => {
      const slot = this.slots.find((s) => s.page.id === pageId);
      if (!slot) return;
      const style = field.style;
      if (panel) {
        const { x, y } = this.noteBox(slot, panel);
        const [x0, , x1] = bounds(panel.shape);
        const [left, top] = this.onScreen([x, y]);
        style.left = `${left}px`;
        style.top = `${top}px`;
        style.width = `${Math.max(180, Math.min((x1 - x0) * slot.scale - 8, 320))}px`;
        style.height = `${NOTE_ROW * 4 + 8}px`;
        style.font = NOTE_FONT;
        style.writingMode = "horizontal-tb";
      } else if (line) {
        const [x0, y0, x1] = line.box;
        // Never smaller than can be read, even when the page is shown small.
        const size = Math.max(line.fontSizePt * MM_PER_PT * slot.scale, 12);
        const pad = 6;
        style.font = canvasFont(lineFont(line), size, lineBold(line));
        style.writingMode = line.vertical ? "vertical-rl" : "horizontal-tb";
        const rows = field.value.replace(/\r\n?/g, "\n").split("\n");
        const longest = Math.max(1, ...rows.map((row) => [...row].length));
        // Room for one more character and one more row, so the caret is never squeezed.
        const across = (rows.length + 1) * size * linePitch() + 2 * pad;
        const along = (longest + 1) * size + 2 * pad;
        const [w, h] = line.vertical ? [across, along] : [along, across];
        // Vertical text starts at the right, as it is read.
        const [ax, ay] = this.onScreen([line.vertical ? slot.x + x1 * slot.scale + pad : slot.x + x0 * slot.scale - pad, slot.y + y0 * slot.scale - pad]);
        style.left = `${line.vertical ? ax - w : ax}px`;
        style.top = `${ay}px`;
        style.width = `${w}px`;
        style.height = `${h}px`;
        style.lineHeight = String(linePitch());
      }
    };
    this.host.begin();
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      if (this.inline?.field === field) this.inline = null;
      if (!keep) apply(original);
      // A long line typed in one go: broken into short lines.
      else if (line && field.value !== original) wrapTypedLine(line);
      field.remove();
      if (keep && field.value !== original) {
        this.host.commit();
        this.host.status(panel ? "コマのメモを書きました" : "セリフを直しました");
      } else {
        this.host.cancel();
        this.host.status("");
      }
      this.draw();
    };
    field.addEventListener("input", () => {
      apply(field.value);
      this.draw();
    });
    field.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finish(true);
      }
    });
    field.addEventListener("blur", () => finish(true));
    this.inline = { field, place, finish };
    this.canvas.parentElement!.append(field);
    place();
    field.focus();
    if (line && line.text === "セリフ") field.select();
    this.host.status(panel ? "コマのメモを書いています（Ctrl+Enter かほかを押すと決定、Esc でやめる）" : "セリフを書いています（改行で行を分ける。Ctrl+Enter かほかを押すと決定、Esc でやめる）");
  }

  /** Nudge the selection with the arrow keys (mm). */
  nudge(dx: number, dy: number): boolean {
    const page = this.focusPage();
    if (!page || !this.selection) return false;
    this.host.begin();
    this.moveSelection(page, dx, dy);
    if (this.selection.kind === "panel" || this.selection.items?.some((item) => item.kind === "panel")) orderPanels(page, this.host.project()!.binding);
    assignPanels(page);
    sortLines(page, this.binding());
    this.host.commit();
    this.draw();
    return true;
  }

  private sizing?: number;

  /** Alt+ホイール: the selected line's text larger or smaller, shown at once; one undo step a moment after. */
  private resizeText(step: number): boolean {
    const s = this.selection;
    const project = this.host.project();
    const line = s?.kind === "line" ? project?.pages.find((p) => p.id === s.pageId)?.lines.find((l) => l.id === s.id) : undefined;
    if (!line) return false;
    const size = Math.min(72, Math.max(4, Math.round((line.fontSizePt + step) * 2) / 2));
    if (size === line.fontSizePt) return true;
    if (this.sizing === undefined) this.host.begin();
    window.clearTimeout(this.sizing);
    line.fontSizePt = size;
    setLineText(line, line.text);
    this.draw();
    this.host.status(`文字の大きさ ${size} pt（Alt+ホイール）`);
    this.sizing = window.setTimeout(() => {
      this.sizing = undefined;
      this.host.commit();
    }, 600);
    return true;
  }

  private wheel(event: WheelEvent): void {
    event.preventDefault();
    const project = this.host.project();
    if (!project) return;
    if (event.altKey && this.resizeText(event.deltaY < 0 ? 0.5 : -0.5)) return;
    if (project.scroll && !event.ctrlKey && !event.metaKey && !event.shiftKey && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
      // 縦スクロール: the wheel goes down the strip, as it is read; Ctrl+ホイール (a pinch) zooms.
      this.pan[1] -= event.deltaY;
      this.sliding = null;
      this.draw();
      return;
    }
    if (event.shiftKey || (event.deltaX && Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
      // Shift+ホイール (or a sideways swipe): along the row, onward in reading order.
      const along = event.deltaX || event.deltaY;
      this.pan[0] += project.binding === "right" ? along : -along;
      this.draw();
      return;
    }
    const factor = Math.exp(-event.deltaY * 0.0015);
    // 連続: out far enough to see the whole name.
    const zoom = Math.min(Math.max(this.zoom * factor, this.continuous ? 0.02 : 0.3), 12);
    const applied = zoom / this.zoom;
    // Keep the point under the pointer still.
    const { width, height } = this.stageSize();
    const cx = width / 2 + this.pan[0];
    const cy = height / 2 + this.pan[1];
    const [ex, ey] = this.at(event);
    // The page under the pointer, else the nearest one (the point may lie off it).
    const pageH = project.pageFormat.canvasMm[1];
    const away = (slot: Slot) =>
      Math.hypot(ex - (slot.x + ((slot.shown[0] + slot.shown[1]) / 2) * slot.scale), ey - (slot.y + (pageH / 2) * slot.scale));
    const anchor = this.slotAt(ex, ey, project) ?? [...this.slots].sort((a, b) => away(a) - away(b))[0];
    const point = anchor && toPage(anchor, ex, ey);
    this.pan[0] += (ex - cx) * (1 - applied);
    this.pan[1] += (ey - cy) * (1 - applied);
    this.zoom = zoom;
    if (this.continuous && anchor && point) {
      // The gaps between spreads are partly px: put the page point itself back under the pointer.
      const moved = this.layout(project).find((slot) => slot.index === anchor.index);
      if (moved) {
        this.pan[0] += ex - (moved.x + point[0] * moved.scale);
        this.pan[1] += ey - (moved.y + point[1] * moved.scale);
      }
    }
    this.sliding = null;
    this.draw();
  }
}

/** A small dot for drawing (the tablet settings' 点 cursor). */
const DOT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><circle cx="4.5" cy="4.5" r="2" fill="#222" stroke="#fff" stroke-width="1"/></svg>')}") 4 4, crosshair`;

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

export function isTyping(event: Event): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
}

/** Break `text` into rows no wider than `width` px, at most `max` rows (the last ends in …). */
function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const rows: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let row = "";
    for (const char of paragraph) {
      if (row && ctx.measureText(row + char).width > width) {
        rows.push(row);
        row = "";
      }
      row += char;
    }
    rows.push(row);
  }
  if (rows.length <= max) return rows;
  const kept = rows.slice(0, max);
  kept[max - 1] = `${kept[max - 1].slice(0, -1)}…`;
  return kept;
}


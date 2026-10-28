// The page editor: draws a spread of the name data and turns pointer input
// into edits (select and move, cut panels, place lines, draw and erase).
// What each tool does with a press and its drags is in its own module
// (tools.ts); the editor keeps the view, the hit testing and the drawing
// (the memos and 付箋 drawn for the person only are notedraw.ts; writing on
// the page in place is inplace.ts).
// Coordinates on a page are millimetres; each page of the spread has its own
// mm → screen mapping.
import { isTyping } from "./dom";
import { BALLOON_TEXT_KEY, CONTINUOUS_KEY, loadSnap, PAGE_GAP_KEY, PANEL_CARRIES_KEY, penPreferences, ROWS_KEY, SHOW_NOTES_KEY, SINGLE_PAGE_KEY } from "./prefs";
import { spreads } from "./pages";
import { GRID_GAP_MM, MARGIN, MAX_PAGE_GAP_MM, extent, fitContinuous, fittedTo, layoutPages, nearestSlot, nearestTo, onScreenOf, onStage, rowCount, slotAt, toPage, type Arrangement, type Slot } from "./layout";
import { holdPanel, placeHeld } from "./hold";
import { carryItems, carrySticky, type Destination } from "./carry";
import { addDrawnPanel, spanGutter } from "./koma";
import { joinPanels, seamAt, seamLines, type Seam } from "./komaedit";
import {
  baseBounds,
  copySelection,
  pasteClip,
  rotation,
  scaling,
  selectionBox,
  transformBase,
  transformItems,
  withContents,
  moveItems,
  type Clip,
  type ItemRef,
} from "./transform";
import { drawLineText, drawStroke, LiveLine, onTipLoaded, tracePath } from "./pagedraw";
import { perfMeter } from "./perfmeter";
import { StrokeCache } from "./strokecache";
import { ROUGH_BASE, shownStrokes, strokeEditable } from "./roughlayers";
import { neighbour, setLineText } from "./dialogue";
import { bounds, insideBox, insidePolygon } from "./geometry";
import type { Binding, BoxMm, Brush, FillTone, Line, Page, Panel, Point, Project } from "./model";
import { snapCut, trimBox } from "./pagebox";
import { type CarriedContents, carryContents, followPanel, panelContents } from "./panels";
import { gutters, pageIndex } from "./project";
import { assignPanels, orderPanels, sortLines } from "./readingorder";
import { settleSticky, stickyFolds } from "./stickies";
import { asideRoom, NO_ROOM, offPage, type Room } from "./aside";
import { drawAside } from "./asidedraw";
import { asideSlot, pressHeld } from "./toolaside";
import { strokeHit } from "./strokes";
import { readCount, readFlag, readNumber } from "./settings";
import {
  FRAME_HANDLES,
  framedAtOnce,
  toolHolds,
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
import { markPen } from "./toolmark";
import { editorCursor } from "./cursors";
import { dragHandler, PRESS } from "./tools";
import { pickedSummary } from "./toolselect";
import { snapPointTo, snapTargets, type SnapSettings, type SnapTargets } from "./snapping";
import { Viewport } from "./viewport";
import { ACCENT, drawSticky, NOTE_FONT, NOTE_ROW, noteBox, stickyHandle, type NoteBox } from "./notedraw";
import { writeInPlace, type InPlaceEdit, type InPlaceHost } from "./inplace";
import { drawCorners, drawCutOrFrame, drawDashedLine, drawFillArea, drawGoingTo, drawGuideLines, drawLasso, drawLifted, drawOverflowPanels, drawPenCursor, drawPointerNote, drawReferenceFrames, drawSpreadMarks, drawRing, drawScreenPage, drawSeam, drawSketch, drawSnapGrid, drawStickyLink, drawTransformFrame, drawTailHandles, drawWarpCorners } from "./screendraw";
import { badgeAt, cornerAt, HANDLE, linesAt, panelAt, panelBadge, pickAt, referenceCornerAt, tailAt } from "./hittest";

export type { EditorEraseMode, EditorHost, PanelMode, Selection, Tool } from "./editorcore";
export { pickedSummary };

export const PANEL_MODE_LABELS: Record<PanelMode, string> = { cut: "割る", sketch: "描く", rect: "四角", polygon: "多角形" };

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

/** Lines snapped to. */
const GUIDE = "#e0398a";

/** How long the pages take to slide to a new arrangement (ms). */
const SLIDE_MS = 220;
/** Pages narrower than this (px) show their drawing without panel numbers or memos. */
const SMALL_PAGE_PX = 170;


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
  /** 連続: room kept around the pages for what lies in their 欄外 (aside.ts). */
  private room: Room = NO_ROOM;
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
  /** Zoom, pan and 画面の回転 (viewport.ts). */
  private readonly view = new Viewport(() => this.stageSize());
  private slots: Slot[] = [];
  /** The canvas's size on screen (CSS px), kept by `resize`. */
  private size: { width: number; height: number } | null = null;
  private drag: Drag | null = null;
  private spaceHeld = false;
  private pointer: Point | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  /**
   * A pen line being drawn: painted a little each frame onto the picture of
   * the pages (the cache, which nothing else draws meanwhile); the screen is
   * that picture and what lies over it.
   */
  private live: LiveLine | null = null;
  /** 低遅延: the same line painted straight onto the screen as the input comes (pointerrawupdate), between frames. */
  private onScreen: LiveLine | null = null;
  /** The cache holds a line no longer being drawn: the pages are drawn again before it is used. */
  private cacheStale = false;
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
  private inline: InPlaceEdit | null = null;
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
    // 低遅延: the pen's input as soon as it comes, not with the next frame (where the browser has it).
    if ("onpointerrawupdate" in window) canvas.addEventListener("pointerrawupdate" as "pointermove", (event) => this.rawMove(event));
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
        this.view.pan[0] += before[0] - after[0];
        this.view.pan[1] += before[1] - after[1];
      }
    });
  }

  /** 連続: the whole name on screen. */
  fitAll(slide = true): void {
    this.fit("all", slide);
  }

  /** 連続: the rows as tall as the stage (at most zoom 1), the spread worked on in the middle across. */
  fitRows(): void {
    this.fit("rows", false);
  }

  private fit(what: "all" | "rows", slide: boolean, across?: (slots: Slot[]) => number | null): void {
    const project = this.host.project();
    if (!project || !this.continuous) return;
    const change = () => {
      const middleOfSpread = (slots: Slot[]) => {
        const box = this.spreadBox(slots);
        return box && (box[0] + box[2]) / 2;
      };
      const { zoom, pan } = fitContinuous(project, this.spreadList(), this.arrangement(), what, across ?? middleOfSpread);
      this.view.zoom = zoom;
      this.view.pan = pan;
      if (this.view.rotation) {
        this.view.rotation = 0;
        this.applyViewTransform();
      }
    };
    if (slide) this.slide(change);
    else change();
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
    if (inside || this.view.rotation) {
      this.draw();
      return;
    }
    // Too big to fit: as much of it as fits, from its top.
    const dx = x1 - x0 <= width ? width / 2 - (x0 + x1) / 2 : 0;
    const dy = y1 - y0 <= height ? height / 2 - (y0 + y1) / 2 : MARGIN - y0;
    this.slide(() => {
      this.view.pan[0] += dx;
      this.view.pan[1] += dy;
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
    this.view.reset(zoom);
    this.sliding = null;
  }

  /** Ctrl+0: the whole spread, upright (連続: the spread worked on, in the middle). */
  fitView(): void {
    if (this.continuous) {
      const project = this.host.project();
      this.view.zoom = 1;
      const box = project && this.spreadBox(this.layout(project));
      const { width, height } = this.stageSize();
      if (box) {
        this.view.pan[0] += width / 2 - (box[0] + box[2]) / 2;
        this.view.pan[1] += height / 2 - (box[1] + box[3]) / 2;
      }
      this.sliding = null;
    } else {
      this.resetView();
    }
    this.setRotation(0);
  }

  /** Turn the view by `degrees` (Shift + Space + drag turns it freely). */
  rotateView(degrees: number): void {
    this.setRotation(this.view.rotation + (degrees * Math.PI) / 180);
  }

  private setRotation(radians: number): void {
    this.view.turnTo(radians);
    this.applyViewTransform();
    this.draw();
    const degrees = Math.round((this.view.rotation * 180) / Math.PI);
    this.host.status(degrees ? `画面を ${degrees}° 回しています（Ctrl+0 で戻す）` : "画面の回転を戻しました");
  }

  /** Where an event is in the view before turning (what the pages are laid out in). */
  private at(event: MouseEvent): Point {
    return this.view.unturned([event.offsetX, event.offsetY]);
  }

  private applyViewTransform(): void {
    this.ctx.setTransform(...this.view.matrix(window.devicePixelRatio || 1));
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.transforming = false;
    if (tool !== "cut") this.cancelPolygon();
    // What the tool taken up does not keep is let go: Delete and the arrows never act on what is not shown as picked.
    if (this.selection && !toolHolds(tool, this.selection.kind)) {
      this.selection = null;
      this.host.selectionChanged(null);
    }
    this.updateCursor();
    this.renderBar();
    this.draw();
  }

  /** `quiet`: another part of the screen took the selection, and says so itself. */
  select(selection: Selection | null, quiet = false): void {
    // What the tool in hand does not keep is picked with the select tool (from a list, a paste, Ctrl+A).
    if (selection && !toolHolds(this.tool, selection.kind)) this.host.useTool("select");
    const same = selection && this.selection && selection.kind === this.selection.kind && selection.id === this.selection.id && selection.pageId === this.selection.pageId;
    if (!same) this.transforming = false;
    this.selection = selection;
    if (!quiet) this.host.selectionChanged(selection);
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
    const box = selectionBox(slot.page, s.kind, s.id, this.pickedItems());
    if (!box) return null;
    const corners = [
      [box[0], box[1]],
      [box[2], box[1]],
      [box[2], box[3]],
      [box[0], box[3]],
    ].map(([x, y]) => this.view.onScreen([slot.x + x * slot.scale, slot.y + y * slot.scale]));
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
    const before = this.size;
    const project = this.host.project();
    // 連続, as the stage grows or shrinks (Tab, the strip, the window): fitted to it, fitted again;
    // otherwise what was in the middle stays in the middle.
    const was = this.continuous && project && before?.width && before.height && width && height ? this.layout(project) : null;
    const fitted = was && project && !project.scroll && before ? fittedTo(was, project.pageFormat.canvasMm[1], before.width, before.height, this.view.zoom, this.room) : null;
    const held = was && project && before ? nearestTo(was, project.pageFormat, [before.width / 2, before.height / 2]) : null;
    this.size = { width, height };
    const at = (slots: Slot[]) => (held ? onScreenOf(slots, held) : null);
    if (fitted === "all") this.fitAll(false);
    else if (fitted === "rows") this.fit("rows", false, (slots) => at(slots)?.[0] ?? null);
    else if (held && project) {
      const point = at(this.layout(project));
      if (point) this.view.pan = [this.view.pan[0] + width / 2 - point[0], this.view.pan[1] + height / 2 - point[1]];
    }
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

  private arrangement(): Arrangement {
    const { width, height } = this.stageSize();
    return { single: this.single, continuous: this.continuous, rows: this.rows, zoom: this.view.zoom, pan: this.view.pan, width, height, gapMm: this.pageGapMm, room: this.room };
  }

  private layout(project: Project): Slot[] {
    return layoutPages(project, this.spreadList(), this.spreadIndex, this.arrangement());
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
    return onStage(slot, project.pageFormat.canvasMm[1], width, height, this.view.rotation);
  }

  private slotAt(sx: number, sy: number, project: Project): Slot | null {
    return slotAt(this.slots, sx, sy, project.pageFormat);
  }

  /** Where a point of a shown page (mm) is in the window (client px), or null when the page is not shown. */
  clientOf(pageId: string, [x, y]: Point): Point | null {
    const slot = this.slots.find((s) => s.page.id === pageId);
    if (!slot) return null;
    const [sx, sy] = this.view.onScreen([slot.x + x * slot.scale, slot.y + y * slot.scale]);
    const rect = this.canvas.getBoundingClientRect();
    return [rect.left + sx, rect.top + sy];
  }

  /** The page under a point of the window, the point on it (mm) and the panel there. */
  pageAtClient(clientX: number, clientY: number): { page: Page; point: Point; panel?: Panel } | null {
    const project = this.host.project();
    if (!project) return null;
    const rect = this.canvas.getBoundingClientRect();
    const [sx, sy] = this.view.unturned([clientX - rect.left, clientY - rect.top]);
    // Off every page: the nearest one, at a point in its 欄外.
    const slot = this.slotAt(sx, sy, project) ?? nearestSlot(this.slots, project.pageFormat, [sx, sy]);
    if (!slot) return null;
    const point = toPage(slot, sx, sy);
    return { page: slot.page, point, panel: panelAt(slot.page, point) };
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
    drawLifted(this.ctx, project, slot, dragged);

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
    if (to) drawGoingTo(this.ctx, project, to, `${to.index + 1} ページへ${panel ? "（中身ごと）" : ""}`);
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
    const corners = this.tool === "select" && !this.transforming && s?.kind === "panel" && s.pageId === slot.page.id ? s.id : null;
    if (corners) ids.add(corners);
    const panels = slot.page.panels.filter((panel) => ids.has(panel.id) && !panel.spread);
    drawOverflowPanels(this.ctx, project, slot, panels, corners);
  }

  /**
   * What was dragged onto another page goes to that page: dialogue and rough
   * lines past the gutter, or (連続) onto any page on the canvas, and a panel
   * with what is in it.
   */
  private carryToPageUnder(project: Project, slot: Slot): void {
    const s = this.selection;
    if (!s || s.pageId !== slot.page.id) return;
    // Over another page, or off every page: the page whose 欄外 it now lies in.
    const nearest = ([x, y]: Point) => nearestSlot(this.slots, project.pageFormat, [slot.x + x * slot.scale, slot.y + y * slot.scale]);
    const slotUnder = (point: Point) => this.otherPageUnder(project, slot, point) ?? (offPage([...point, ...point], project.pageFormat) && nearest(point) !== slot ? nearest(point) : null);
    const under = (point: Point): Destination | null => {
      const to = slotUnder(point);
      return to && { page: to.page, offset: [(slot.x - to.x) / slot.scale, (slot.y - to.y) / slot.scale] };
    };
    const slotOf = (page: Page) => this.slots.find((x) => x.page === page)!;
    if (s.kind === "sticky") {
      const sticky = slot.page.stickies?.find((n) => n.id === s.id);
      const to = sticky && carrySticky(project, slot.page, sticky, under);
      if (to) {
        this.selection = { ...s, pageId: to.id };
        this.focusOn(slotOf(to));
      }
      return;
    }
    if (s.kind === "panel") {
      const panel = slot.page.panels.find((p) => p.id === s.id);
      // Half of a 見開き panel stays: it is one panel with the facing page's half.
      if (!panel || panel.spread) return;
      const box = bounds(panel.shape);
      const centre: Point = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      const to = slotUnder(centre);
      if (!to) return;
      const at = toPage(to, slot.x + centre[0] * slot.scale, slot.y + centre[1] * slot.scale);
      const moved = placeHeld(project, to.page, holdPanel(project, slot.page, panel, to.page.id), at);
      this.selection = { kind: "panel", pageId: to.page.id, id: moved.id };
      this.focusOn(to);
      this.host.status(`コマを中身ごと ${to.index + 1} ページへ移しました（コマ ${moved.order}）`);
      return;
    }
    const all: ItemRef[] = s.kind === "group" ? (s.items ?? []) : s.kind === "line" || s.kind === "stroke" ? [{ kind: s.kind, id: s.id }] : [];
    const { moved, to } = carryItems(project, slot.page, all, under);
    if (!moved.length) return;
    const targets = [...to].map(slotOf);
    // The selection follows when everything went to one page.
    if (moved.length === all.length && targets.length === 1) this.selection = { ...s, pageId: targets[0].page.id };
    else if (s.kind === "group") this.selection = { ...s, items: all.filter((item) => !moved.includes(item)) };
    else this.selection = null;
    if (this.selection?.pageId === targets[0].page.id) this.focusOn(targets[0]);
    else this.host.selectionChanged(this.selection);
    const pages = targets.map((t) => t.index + 1).sort((a, b) => a - b).join("・");
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
    const started = performance.now();
    if (this.drag?.kind === "pen" && this.live && this.cache) {
      // While a line is drawn nothing else changes: the pages as they were with the line painted on so far, then what lies over them.
      this.paintLive(this.drag);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.cache, 0, 0);
      ctx.restore();
      this.drawOverlay();
      perfMeter.drawn(started, true);
      return;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // A turned view leaves the corners outside the pages: the stage colour there.
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    const project = this.host.project();
    if (!project) return;
    if (!this.drag) this.keepRoom(project);
    this.slots = this.slid(this.layout(project));
    this.strokeCache.startFrame();
    const drawn = new Set<string>();
    for (const slot of this.slots) {
      if (!this.onCanvas(project, slot)) continue;
      this.drawPage(project, slot);
      drawn.add(slot.page.id);
    }
    this.strokeCache.forget(drawn);
    drawAside(this.ctx, project, this.slots, {
      visible: (page) => this.visiblePage(page),
      selected: (page, kind, id) => this.isSelected(page, kind, id),
      stickyHandle: this.tool === "select" || this.tool === "sticky" ? LINK_HANDLE : null,
      held: this.drag?.kind === "held" ? this.drag : null,
      redraw: () => this.requestDraw(),
      referenceFrames: this.tool === "reference" ? (slot) => this.drawReferenceFrames(slot) : undefined,
    });
    this.drawSpreadMarks(project);
    this.drawDragged(project);
    this.drawOverflow(project);
    this.keepCache();
    this.inline?.place();
    this.placeBar();
    this.drawOverlay();
    if (this.drag) perfMeter.drawn(started, false);
  }

  /** What the editor keeps to draw quickly (device pixels): the pictures of the pages' lines, and the screen's own copy. */
  get kept(): { linePictures: number; linePixels: number; screenPixels: number } {
    const lines = this.strokeCache.kept;
    return { linePictures: lines.pictures, linePixels: lines.pixels, screenPixels: (this.cache?.width ?? 0) * (this.cache?.height ?? 0) };
  }

  /** Paint what the pen added onto the picture of the pages (all of the line again when the view moved). */
  private paintLive(drag: Extract<Drag, { kind: "pen" }>): void {
    const cache = this.cache!.getContext("2d")!;
    cache.setTransform(this.ctx.getTransform());
    const { slot } = drag;
    const m = { scale: slot.scale, x: slot.x, y: slot.y };
    const [width, color, brush] = this.liveInk(drag);
    if (!this.live!.paint(drag.points, width, m, color, brush)) {
      // The view moved under the line: the pages anew, then the whole line.
      this.live = null;
      this.cacheStale = true;
      this.draw();
      this.captureBase();
      // (captureBase made a new one.)
      (this.live as LiveLine | null)?.paint(drag.points, width, m, color, brush);
    }
  }

  /** A line being drawn: its width (mm), colour and brush. */
  private liveInk(drag: Extract<Drag, { kind: "pen" }>): [number, string, Brush | undefined] {
    return [drag.mark?.widthMm ?? this.penWidthMm, drag.mark?.color ?? "#3a3834", drag.mark ? undefined : this.brush("pen")];
  }

  private keepCache(): void {
    const cache = this.cache ?? document.createElement("canvas");
    if (cache.width !== this.canvas.width || cache.height !== this.canvas.height) {
      cache.width = this.canvas.width;
      cache.height = this.canvas.height;
    }
    const ctx = cache.getContext("2d")!;
    // A line drawn on it last left the view's transform.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cache.width, cache.height);
    ctx.drawImage(this.canvas, 0, 0);
    this.cache = cache;
    this.cacheStale = false;
  }

  /** 連続: room between the pages for what lies in their 欄外, made anew as that changes (the pages slide, the spread worked on stays put). */
  private keepRoom(project: Project): void {
    const room = asideRoom(project, project.pageFormat.canvasMm[1] / 2);
    if (room.every((side, i) => Math.abs(side - this.room[i]) < 0.5)) return;
    if (!this.continuous) {
      this.room = room;
      return;
    }
    const from = new Map(this.slots.map((slot): [number, Point] => [slot.index, [slot.x, slot.y]]));
    const before = this.spreadBox(this.layout(project));
    this.room = room;
    const after = this.spreadBox(this.layout(project));
    if (before && after) this.view.pan = [this.view.pan[0] + before[0] - after[0], this.view.pan[1] + before[1] - after[1]];
    if (from.size && !matchMedia("(prefers-reduced-motion: reduce)").matches) this.sliding = { from, start: performance.now() };
  }

  /** Redraw only what lies over the pages (hover marks, the eraser ring) on the next frame. */
  private requestOverlay(): void {
    if (this.frame || this.overlayFrame) return;
    this.overlayFrame = requestAnimationFrame(() => {
      this.overlayFrame = 0;
      if (!this.cache || this.drag || this.cacheStale) {
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
    const current = this.continuous ? this.spreadIndex : null;
    drawSpreadMarks(this.ctx, project, this.slots, this.spreadList(), current, (slot) => this.onCanvas(project, slot), (slots) => this.extent(slots));
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
    const page = this.visiblePage(slot.page);
    const small = this.small(project, slot);
    const [pageW] = project.pageFormat.canvasMm;
    const swap = this.drag?.kind === "swap" && this.drag.to?.slot.page === slot.page ? this.drag.to.panelId : null;
    drawScreenPage(this.ctx, project, slot, page, {
      small,
      showNotes: this.showNotes,
      selected: (kind, id) => this.isSelected(slot.page, kind, id),
      panelCorners: this.tool === "select" && !this.transforming && this.selection?.kind === "panel",
      swapInto: swap ?? null,
      stickyHandle: this.tool === "select" || this.tool === "sticky" ? LINK_HANDLE : null,
      rough: (rough) => this.host.rough(rough),
      redraw: () => this.requestDraw(),
      strokes: this.strokeCache,
      badge: (panel) => panelBadge(slot, panel, project.pageFormat, pageW),
      referenceFrames: this.tool === "reference" ? () => this.drawReferenceFrames(slot) : undefined,
      line: (line) => this.drawLine(project, slot, line),
    });
  }

  /** 資料: every picture's outline, the chosen one with corners to drag. */
  private drawReferenceFrames(slot: Slot): void {
    drawReferenceFrames(this.ctx, slot, this.reference?.pageId === slot.page.id ? this.reference.id : null);
  }

  /** 資料: the chosen picture's corner under a screen point (0–3), or -1. */
  private referenceCornerAt(slot: Slot, sx: number, sy: number): number {
    return referenceCornerAt(slot, this.reference?.pageId === slot.page.id ? this.reference.id : null, sx, sy);
  }

  /** Choose a 資料画像 (or none) with the 資料 tool. */
  chooseReference(reference: { pageId: string; id: string } | null): void {
    this.reference = reference;
    this.host.referenceChanged?.();
    this.draw();
  }

  /** Where a panel's memo sits on screen (notedraw.ts). */
  private noteBox(slot: Slot, panel: Panel): NoteBox {
    return noteBox(this.ctx, slot, panel, this.host.project()?.pageFormat);
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

  /** The line or panel at a point, to tie a 付箋 to. */
  private linkTarget(slot: Slot, point: Point): Selection | null {
    const page = this.visiblePage(slot.page);
    const line = linesAt(this.visiblePage(slot.page), point)[0];
    if (line) return { kind: "line", pageId: page.id, id: line };
    const panel = panelAt(page, point);
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
      // しっぽの先 (drag to point at the speaker) and its middle (drag to bend it): handles are the select tool's.
      if (this.tool === "select") this.drawTailHandles(slot, line, true);
    }
  }

  private drawOverlay(): void {
    const ctx = this.ctx;
    const drag = this.drag;
    // Slots are laid out again on every draw: the hover's page as it is now placed.
    const hoverSlot = this.hover && this.slots.find((s) => s.page.id === this.hover!.slot.page.id);
    const seam = drag?.kind === "seam" ? drag : this.hover?.kind === "seam" && hoverSlot ? { slot: hoverSlot, seam: this.hover.seam } : null;
    if (seam) drawSeam(ctx, seam.slot, seamLines(seam.slot.page, seam.seam));
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
      } else if (target.kind === "sticky") {
        // A long 付箋 opens to all its text while the pointer is on it.
        const sticky = slot.page.stickies?.find((n) => n.id === target.id);
        if (sticky && stickyFolds(sticky) && !this.isSelected(slot.page, "sticky", sticky.id)) drawSticky(ctx, slot, sticky, false, null, true);
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
      const b = drag.kind === "cut" && !drag.free ? snapCut(drag.a, drag.b) : drag.b;
      drawCutOrFrame(ctx, drag.slot, drag.a, b, drag.kind === "cut");
    }
    if (drag?.kind === "fill" && drag.points.length > 2) {
      // The area as it will be filled, while it is drawn round.
      const tone = this.fillTone === "black" ? "rgba(40, 38, 34, 0.55)" : this.fillTone === "gray" ? "rgba(150, 146, 140, 0.55)" : "rgba(255, 255, 255, 0.8)";
      drawFillArea(ctx, drag.slot, drag.points, tone);
    }
    if ((drag?.kind === "lasso" || drag?.kind === "pick" || drag?.kind === "eraseLasso") && drag.points.length > 1) {
      drawLasso(ctx, drag.slot, drag.points, drag.kind === "lasso" ? "rgba(214, 120, 40, 0.9)" : drag.kind === "pick" ? ACCENT : "rgba(192, 57, 43, 0.9)");
    }
    if (drag?.kind === "stickyLink" && this.pointer) drawStickyLink(ctx, drag.slot, drag.stickyId, drag.to, this.pointer);
    if (drag?.kind === "sketch") drawSketch(ctx, drag.slot, drag.points);
    if (drag?.kind === "swap" && this.pointer) {
      // An arrow from the panel's number to where its contents go.
      drawDashedLine(ctx, drag.at, this.pointer);
      drawPointerNote(ctx, this.pointer, drag.to ? "ここに入れ替え" : "入れ替えるコマへ");
    }
    if (drag?.kind === "pen") {
      const { slot, points } = drag;
      const m = { scale: slot.scale, x: slot.x, y: slot.y };
      const [width, color, brush] = this.liveInk(drag);
      if (this.live) {
        // Where the pen is about to be (先読み): shown this frame only.
        this.live.ahead(ctx, points, drag.ahead ?? [], width, m, color, brush);
      } else {
        // 抜き (the taper at the end) comes when the pen lifts, as in CSP.
        drawStroke(ctx, { id: "", points, widthMm: width, closed: false, brush: brush?.id, cut: [false, true] }, m, color, 0.7, brush);
      }
    }
    this.drawFrame();
    if (this.tool === "pen" && !this.erasing() && !this.spaceHeld && this.pointer && penPreferences.settings.cursor === "brush") {
      // The pen's size where it will draw.
      drawPenCursor(ctx, this.pointer, Math.max((this.penWidthMm / 2) * (this.slots[0]?.scale ?? 1), 2));
    }
    if (this.erasing() && this.eraseMode !== "lasso" && this.pointer) drawRing(ctx, this.pointer, this.eraserRadiusPx());
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
      this.view.pan[0] += before[0] - after[0];
      this.view.pan[1] += before[1] - after[1];
    }
    this.draw();
  }

  /** The lines snapped to, across the page they are on. */
  private drawGuides(): void {
    const guides = this.guides;
    const slot = guides && this.slots.find((s) => s.page.id === guides.pageId);
    if (!guides || !slot || (!guides.xs.length && !guides.ys.length)) return;
    drawGuideLines(this.ctx, this.host.project()!, slot, guides.xs, guides.ys, GUIDE);
  }

  /** The grid (when panels snap to it) on the pages, while panels are cut, drawn or changed. */
  private drawGrid(project: Project): void {
    const { grid, gridMm } = this.snapping;
    const panelDrag = this.drag && ["frame", "vertex", "seam", "scale"].includes(this.drag.kind);
    const moving = this.drag?.kind === "move" && !!this.drag.snap;
    if (!grid || !(this.tool === "cut" || panelDrag || moving)) return;
    // Too fine to see: no grid.
    drawSnapGrid(this.ctx, project, this.slots.filter((slot) => gridMm * slot.scale >= 4 && !this.small(project, slot)), gridMm);
  }

  /** 多角形: the corners placed, and the side to where the pointer is. */
  private drawPolygon(): void {
    const polygon = this.polygon;
    const slot = this.polygonSlot();
    if (!polygon || !slot) return;
    const points = [...polygon.points];
    let closing = false;
    if (this.pointer && !this.drag) {
      const pointer = toPage(slot, ...this.pointer);
      const first = polygon.points[0];
      closing = polygon.points.length >= 3 && Math.hypot(first[0] - pointer[0], first[1] - pointer[1]) * slot.scale <= 8;
      if (!closing) points.push(this.nextCorner(slot, pointer, false));
    }
    drawCorners(this.ctx, slot, polygon.points, points, closing);
  }

  // --- 変形（拡大縮小・回転・反転） -------------------------------------------------------

  /** What is picked, as things to move or turn: a panel (and a group's panels) with what is drawn in it (コマ枠フォルダ). */
  private pickedItems(): ItemRef[] {
    const s = this.selection;
    const page = s && this.host.project()?.pages.find((p) => p.id === s.pageId);
    if (!s || !page || s.kind === "sticky") return [];
    return withContents(page, s.kind === "group" ? (s.items ?? []) : [{ kind: s.kind, id: s.id }], this.panelCarries);
  }

  /** What the transform frame works on: with the select tool, what has no handles of its own, or anything with 変形 on. */
  private selectedItems(): ItemRef[] {
    const s = this.selection;
    if (!s || this.tool !== "select") return [];
    return framedAtOnce(s.kind) || this.transforming ? this.pickedItems() : [];
  }

  get isTransforming(): boolean {
    return this.transforming;
  }

  /** A drag (a line, a panel moved, …) under way. */
  get dragging(): boolean {
    return this.drag !== null;
  }

  /** What the select tool would grab under the pointer, for the help bar: "item.panel", "seam", "tail.tip", "handle". */
  get hovered(): string | null {
    return this.hover && (this.hover.kind === "item" ? `item.${this.hover.target.kind}` : this.hover.kind === "tail" ? `tail.${this.hover.hit.part}` : this.hover.kind);
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
      if (this.tool !== "select") this.host.useTool("select");
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
    // 自由変形: the four corners as they are being pulled.
    if (drag?.kind === "warp") return drawWarpCorners(this.ctx, drag.slot, drag.corners);
    if (drag && drag.kind !== "scale" && drag.kind !== "rotate") return;
    const frame = this.frameGeometry();
    if (frame) drawTransformFrame(this.ctx, frame.handles, frame.rotate);
  }

  /** The frame handle at a screen point: 0..7, 8 for turning, or -1. */
  private frameHandleAt(sx: number, sy: number): number {
    const frame = this.frameGeometry();
    if (!frame) return -1;
    if (Math.hypot(frame.rotate[0] - sx, frame.rotate[1] - sy) <= HANDLE + 3) return FRAME_HANDLES;
    return frame.handles.findIndex(([x, y]) => Math.abs(x - sx) <= HANDLE + 2 && Math.abs(y - sy) <= HANDLE + 2);
  }

  /** 左右反転 / 上下反転 / 90° turns of what is selected. */
  transformSelection(how: "flipH" | "flipV" | "left" | "right"): boolean {
    const page = this.focusPage();
    const s = this.selection;
    if (s?.kind === "panel" && page?.panels.find((p) => p.id === s.id)?.spread) {
      this.host.status("見開きのコマは反転・回転できません。頂点や間白で形を変えてください");
      return false;
    }
    // Whatever is picked, 変形 on or not; a panel with what is drawn in it.
    const items = this.pickedItems();
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
    const under = this.pointer && (this.slotAt(this.pointer[0], this.pointer[1], project) ?? nearestSlot(this.slots, project.pageFormat, this.pointer));
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

  /** What a click at `point` picks on the page as shown (what is hidden cannot be picked). */
  private hit(slot: Slot, point: Point): Selection | null {
    const page = this.visiblePage(slot.page);
    const project = this.host.project();
    const found = pickAt(page, point, slot.scale, {
      open: (sticky) => this.isSelected(page, "sticky", sticky.id) || (this.hover?.kind === "item" && this.hover.target.id === sticky.id),
      selectedLine: this.selection?.kind === "line" && this.selection.pageId === page.id ? this.selection.id : null,
      editable: (stroke) => !project || strokeEditable(project, stroke),
    });
    return found && { ...found, pageId: page.id };
  }

  private vertexAt(slot: Slot, sx: number, sy: number): number {
    const s = this.selection;
    if (s?.kind !== "panel" || s.pageId !== slot.page.id || this.transforming) return -1;
    const panel = slot.page.panels.find((p) => p.id === s.id);
    return panel ? cornerAt(slot, panel, sx, sy) : -1;
  }

  /** The panel whose number is under the pointer (none on a page shown small). */
  private badgeAt(slot: Slot, sx: number, sy: number, pageW: number): Panel | undefined {
    const project = this.host.project();
    if (project && this.small(project, slot)) return undefined;
    return badgeAt(slot, project?.pageFormat, pageW, sx, sy);
  }

  /** The tail under the pointer; the selected or hovered line's handles too. Any line's tails can be taken without picking the line first. */
  private tailAt(slot: Slot, sx: number, sy: number): TailHit | null {
    const s = this.selection;
    const shown = new Set<string>();
    if (s?.kind === "line" && s.pageId === slot.page.id) shown.add(s.id);
    if (this.hover?.kind === "item" && this.hover.target.kind === "line") shown.add(this.hover.target.id);
    if (this.hover?.kind === "tail") shown.add(this.hover.hit.lineId);
    return tailAt(slot, sx, sy, shown);
  }

  private drawTailHandles(slot: Slot, line: Line, strong: boolean): void {
    const s = this.selection;
    drawTailHandles(this.ctx, slot, line, strong, s?.kind === "line" && s.id === line.id && s.pageId === slot.page.id ? s.tail : undefined);
  }

  // --- input ------------------------------------------------------------------------

  /** Whether the pointer erases now: the eraser tool or the pen's eraser end. */
  private erasing(): boolean {
    return this.tool === "eraser" || this.tipEraser || (this.tool === "mark" && markPen.erase);
  }

  private updateCursor(): void {
    const hover = this.hover && (this.hover.kind === "tail" ? { kind: "tail" as const, part: this.hover.hit.part } : this.hover);
    const lasso = this.eraseMode === "lasso";
    this.canvas.style.cursor = editorCursor({ tool: this.tool, panning: this.spaceHeld, erasing: this.erasing(), lasso, hover, penLook: penPreferences.settings.cursor });
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
    // 動作の記録: from the pen coming down to the line's first frame.
    if (this.drag?.kind === "pen") perfMeter.input(event.timeStamp, true);
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
    this.drag = {
      kind: "pinch",
      ids: [a, b],
      dist: Math.max(Math.hypot(pb[0] - pa[0], pb[1] - pa[1]), 1),
      angle: Math.atan2(pb[1] - pa[1], pb[0] - pa[0]),
      zoom: this.view.zoom,
      rotation: this.view.rotation,
      v: this.view.anchorAt(mid),
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
    // Upright again when close to it.
    if (penPreferences.settings.pinchRotate && this.view.turnTo(drag.rotation + Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) - drag.angle, (3 * Math.PI) / 180)) {
      this.applyViewTransform();
    }
    this.view.holdAnchor(drag.v, mid, zoom);
    this.requestDraw();
  }

  /** After an error: forget the drag in progress without finishing it (the change it made was undone). */
  dropDrag(): void {
    this.drag = null;
    this.endLive();
    this.afterUp = null;
    this.dragPointer = null;
    this.dragPointerType = "";
  }

  /** Give up the drag in progress: a line not yet drawn goes; a change already made stays. */
  private abandonDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.endLive();
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
      this.drag = { kind: "turn", from: this.view.angleAt(sx, sy), rotation: this.view.rotation };
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
    // 保留コマ laid in the 欄外 lie over everything.
    if (this.tool === "select" && !this.tipEraser && pressHeld(this.core, project, sx, sy)) return;
    let slot = this.slotAt(sx, sy, project);
    // The selected panel's corners, also where they lie past its page (over the facing one).
    const selectedOn = this.tool === "select" && this.selection?.kind === "panel" ? this.slots.find((x) => x.page.id === this.selection!.pageId) : undefined;
    if (selectedOn && selectedOn !== slot && this.vertexAt(selectedOn, sx, sy) >= 0) slot = selectedOn;
    // Off every page: in the 欄外 of the nearest one.
    slot ??= asideSlot(this.core, this.tipEraser ? "eraser" : this.tool, project, sx, sy);
    if (!slot) {
      this.select(null);
      return;
    }
    // The page settings follow the page worked on (the left page of a spread too).
    if (this.focusedPageId !== slot.page.id) this.focusOn(slot);
    const point = toPage(slot, sx, sy);
    // The 指示 tool's eraser end erases 指示 only.
    PRESS[this.tipEraser && this.tool !== "mark" ? "eraser" : this.tool](this.core, { event, project, slot, point, sx, sy });
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
      linesAt: (slot, point) => linesAt(this.visiblePage(slot.page), point),
      panelAt: (page, point) => panelAt(page, point),
      vertexAt: (slot, sx, sy) => this.vertexAt(slot, sx, sy),
      tailAt: (slot, sx, sy) => this.tailAt(slot, sx, sy),
      badgeAt: (slot, sx, sy, pageW) => this.badgeAt(slot, sx, sy, pageW),
      noteAt: (slot, sx, sy) => this.noteAt(slot, sx, sy),
      noteBox: (slot, panel) => this.noteBox(slot, panel),
      stickyHandle,
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
      editInPlace: (pageId, kind, id, fresh) => this.editInPlace(pageId, kind, id, fresh),
    };
  }

  /** Keep the pages as drawn now (without the overlay) for the pen line to go over. */
  private captureBase(): void {
    this.live = null;
    // The screen already shows the pages unless a frame is still to be drawn
    // (drawing them again would delay the start of the line).
    if (this.frame || this.cacheStale || !this.cache) this.draw();
    // The picture of the pages (without what lies over them, such as the pen's cursor) takes the line.
    if (this.cache) this.live = new LiveLine(this.cache.getContext("2d")!);
  }

  /**
   * 低遅延: a pen line takes its input as soon as it comes and paints it
   * straight onto the screen (a desynchronized canvas shows it without
   * waiting for the next frame); the frame after it only adds what lies over
   * the pages and the 先読み.
   */
  private rawMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag?.kind !== "pen" || !this.live || !this.cache || event.pointerId !== this.dragPointer || !penPreferences.settings.lowLatency) return;
    const [ex, ey] = this.at(event);
    this.pointer = [ex, ey];
    const coalesced = event.getCoalescedEvents?.() ?? [];
    perfMeter.input(coalesced[0]?.timeStamp ?? event.timeStamp, true, coalesced.length || 1);
    const project = this.host.project()!;
    dragHandler(drag).move(this.core, drag, { event, project, point: toPage(drag.slot, ex, ey), ex, ey, phase: "raw" });
    // Onto the screen only: the picture of the pages takes it once a frame (draw).
    this.onScreen ??= new LiveLine(this.ctx);
    const [width, color, brush] = this.liveInk(drag);
    this.onScreen.paint(drag.points, width, { scale: drag.slot.scale, x: drag.slot.x, y: drag.slot.y }, color, brush);
    perfMeter.shown();
    this.requestDraw();
  }

  /** A drag ended. A line drawn is no longer: the picture of the pages holds it, so the pages are drawn again before it shows. */
  private endLive(): void {
    perfMeter.dragEnded();
    this.onScreen = null;
    if (!this.live) return;
    this.live = null;
    this.cacheStale = true;
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
      this.view.dragBy(event.clientX - drag.x, event.clientY - drag.y);
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.requestDraw();
      return;
    }
    if (drag.kind === "turn") {
      // The angle on screen: turning the view moves the local frame along.
      let rotation = drag.rotation + this.view.angleAt(...this.at(event)) - drag.from;
      if (event.altKey) rotation = Math.round(rotation / (Math.PI / 12)) * (Math.PI / 12);
      this.setRotation(rotation);
      return;
    }
    if (drag.kind === "pinch") return;
    // A pen line taking its input as it comes (rawMove): this move only looks ahead.
    const phase = drag.kind === "pen" && this.onScreen ? "frame" : undefined;
    if (!phase) {
      // For 動作の記録: how long the oldest of the moves takes to show.
      const coalesced = event.getCoalescedEvents?.() ?? [];
      perfMeter.input(coalesced[0]?.timeStamp ?? event.timeStamp, drag.kind === "pen", coalesced.length || 1);
    }
    const point = toPage(drag.slot, ex, ey);
    const project = this.host.project()!;
    if (dragHandler(drag).move(this.core, drag, { event, project, point, ex, ey, phase }) === false) return;
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
    this.endLive();
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
    if (s?.kind === "sticky") {
      const sticky = page.stickies?.find((n) => n.id === s.id);
      // On its page or in its 欄外 once let go (carryToPageUnder).
      if (sticky) sticky.at = [sticky.at[0] + dx, sticky.at[1] + dy];
    } else if (s) moveItems(page, s.kind === "group" ? (items ?? this.pickedItems()) : [{ kind: s.kind, id: s.id }], dx, dy);
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
    this.canvas.dispatchEvent(new Event("hoverchange"));
    this.updateCursor();
    this.requestOverlay();
  }

  /** The cursor for moving a border: across it. */
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
    // 付箋: write in it, in the right panel.
    if (target?.kind === "sticky") return void (this.select(target), document.querySelector<HTMLTextAreaElement>("#inspector textarea")?.focus());
    if (target && target.kind !== "panel") return;
    // Inside a panel: its memo.
    const panel = panelAt(slot.page, point);
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
   * where it is (inplace.ts).
   */
  /** `fresh`: a line just placed in the step begun, which the field ends (Esc takes the line away). */
  editInPlace(pageId: string, kind: "note" | "line", id: string, fresh = false): void {
    this.inline?.finish(true);
    const project = this.host.project();
    const page = project?.pages.find((p) => p.id === pageId);
    const panel = kind === "note" ? page?.panels.find((p) => p.id === id) : undefined;
    const line = kind === "line" ? page?.lines.find((l) => l.id === id) : undefined;
    if (!page || (!panel && !line)) return;
    if (!this.slots.some((slot) => slot.page.id === pageId)) this.showPage(pageIndex(project!, pageId) + 1);
    const host: InPlaceHost = {
      begin: () => this.host.begin(),
      commit: () => this.host.commit(),
      cancel: () => this.host.cancel(),
      status: (message) => this.host.status(message),
      draw: () => this.draw(),
      slotOf: (id) => this.slots.find((s) => s.page.id === id),
      noteAt: (slot, panel) => this.noteBox(slot, panel),
      onScreen: (point) => this.view.onScreen(point),
      drop: (pageId, lineId) => {
        const on = this.host.project()?.pages.find((p) => p.id === pageId);
        if (on) on.lines = on.lines.filter((l) => l.id !== lineId);
        if (this.selection?.kind === "line" && this.selection.id === lineId) this.select(null);
      },
      next: (step) => {
        const to = neighbour(project!, pageId, kind, id, step);
        if (!to) return null;
        return () => {
          const index = pageIndex(project!, to.pageId);
          if (to.pageId !== pageId) this.showPage(index + 1);
          this.select({ kind: kind === "line" ? "line" : "panel", pageId: to.pageId, id: to.id });
          this.editInPlace(to.pageId, kind, to.id);
        };
      },
      opened: (edit) => (this.inline = edit),
      closed: (edit) => {
        if (this.inline === edit) this.inline = null;
      },
    };
    writeInPlace(host, this.canvas.parentElement!, pageId, panel ? { panel } : { line: line! }, fresh);
  }

  /** Nudge the selection with the arrow keys (mm), as a drag moves it (a panel with what is drawn in it). */
  nudge(dx: number, dy: number): boolean {
    const page = this.focusPage();
    if (!page || !this.selection) return false;
    const s = this.selection;
    const panel = s.kind === "panel" ? page.panels.find((p) => p.id === s.id) : undefined;
    const carried = panel && this.panelCarries ? carryContents(page, panel) : undefined;
    this.host.begin();
    this.moveSelection(page, dx, dy);
    this.follow(page, carried);
    const sticky = this.selection.kind === "sticky" ? page.stickies?.find((n) => n.id === this.selection!.id) : undefined;
    if (sticky) settleSticky(this.host.project()!, sticky);
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
      this.view.pan[1] -= event.deltaY;
      this.sliding = null;
      this.draw();
      return;
    }
    if (event.shiftKey || (event.deltaX && Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
      // Shift+ホイール (or a sideways swipe): along the row, onward in reading order.
      const along = event.deltaX || event.deltaY;
      this.view.pan[0] += project.binding === "right" ? along : -along;
      this.draw();
      return;
    }
    const factor = Math.exp(-event.deltaY * 0.0015);
    // 連続: out far enough to see the whole name.
    const zoom = Math.min(Math.max(this.view.zoom * factor, this.continuous ? 0.02 : 0.3), 12);
    const [ex, ey] = this.at(event);
    // The page under the pointer, else the nearest one (the point may lie off it).
    const pageH = project.pageFormat.canvasMm[1];
    const away = (slot: Slot) =>
      Math.hypot(ex - (slot.x + ((slot.shown[0] + slot.shown[1]) / 2) * slot.scale), ey - (slot.y + (pageH / 2) * slot.scale));
    const anchor = this.slotAt(ex, ey, project) ?? [...this.slots].sort((a, b) => away(a) - away(b))[0];
    const point = anchor && toPage(anchor, ex, ey);
    // Keep the point under the pointer still.
    this.view.zoomAbout([ex, ey], zoom);
    if (anchor && point) {
      // The page numbers' room and the gaps between spreads are px, not zoomed: put the page point itself back under the pointer.
      const moved = this.layout(project).find((slot) => slot.index === anchor.index);
      if (moved) {
        this.view.pan[0] += ex - (moved.x + point[0] * moved.scale);
        this.view.pan[1] += ey - (moved.y + point[1] * moved.scale);
      }
    }
    this.sliding = null;
    this.draw();
  }
}

/** A small dot for drawing (the tablet settings' 点 cursor). */


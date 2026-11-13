// The pages as they lie on screen: which spread is shown (見開き・単独・連続),
// where each page is (the slots), the view on them (zoom, pan, 画面の回転) and
// what of them is hidden. Knows nothing of tools, the selection or drawing:
// the page editor (editor.ts) puts this together with what is picked
// (editorpicks.ts) and the drawing (editorpaint.ts).
import { asideRooms, type Room, sameRooms } from "../domain/aside";
import { panelAt } from "../editing/hittest";
import { withoutHidden } from "./layers";
import {
  GRID_GAP_MM,
  MARGIN,
  MAX_PAGE_GAP_MM,
  extent,
  fitContinuous,
  fittedTo,
  layoutPages,
  nearestSlot,
  nearestTo,
  onScreenOf,
  onStage,
  rowCount,
  slotAt,
  toPage,
  type Arrangement,
  type Slot,
} from "../editing/layout";
import type { BoxMm, Page, Panel, Point, Project } from "../model/model";
import { trimBox } from "../domain/pagebox";
import { spreads } from "../domain/pages";
import { CONTINUOUS_KEY, PAGE_GAP_KEY, ROWS_KEY, SHOW_NOTES_KEY, SHOW_STICKIES_KEY, SINGLE_PAGE_KEY } from "../platform/prefs";
import { captionMeter } from "../render/screendraw";
import { readCount, readFlag, readNumber } from "../platform/settings";
import { Viewport } from "../editing/viewport";

/** How long the pages take to slide to a new arrangement (ms). */
const SLIDE_MS = 220;
/** Pages narrower than this (px) show their drawing without panel numbers or memos. */
const SMALL_PAGE_PX = 170;

/** What the stage needs from the editor around it. */
export interface StageHost {
  project(): Project | null;
  status(message: string): void;
  /** Draw the pages now, or on the next frame. */
  draw(): void;
  requestDraw(): void;
}

export class EditorStage {
  spreadIndex = 0;

  /** The page of the spread last clicked or picked in the page list: what the page settings are for. */
  focusedPageId: string | null = null;

  firstAlone = true;

  /** 単独: one page at a time instead of 見開き. */
  single = readFlag(SINGLE_PAGE_KEY, false);

  /** 連続: every page on one canvas, as on a name sheet, the spreads in `rows` rows (1: one long row). */
  continuous = readFlag(CONTINUOUS_KEY, false);

  rows = readCount(ROWS_KEY, 1);

  /** Where the pages were on screen, while they slide to a new arrangement. */
  private sliding: { from: Map<number, Point>; start: number } | null = null;

  /** Each panel's memo shown on the page (only on screen, never exported). */
  showNotes = readFlag(SHOW_NOTES_KEY, true);

  /** 付箋 shown on the pages and beside them (setStickiesShown). */
  showStickies = readFlag(SHOW_STICKIES_KEY, true);

  /** 連続: room between the spreads (mm). */
  pageGapMm = readNumber(PAGE_GAP_KEY, GRID_GAP_MM, 0, MAX_PAGE_GAP_MM);

  /** 連続: room kept around each page for what lies in its 欄外 (aside.ts), by page index. */
  private rooms: Room[] = [];

  /** Hidden on screen from the レイヤー list (`kind:id`); exports keep them. */
  readonly hidden = new Set<string>();

  /** Zoom, pan and 画面の回転 (viewport.ts). */
  readonly view = new Viewport(() => this.stageSize());

  /** The pages on screen, laid out anew for each drawing (`arrange`). */
  slots: Slot[] = [];

  /** The canvas's size on screen (CSS px), kept by `resize`. */
  private size: { width: number; height: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly host: StageHost,
  ) {}

  // --- spreads --------------------------------------------------------------

  spreadList(): [number | null, number | null][] {
    const project = this.host.project();
    const count = project?.pages.length ?? 0;
    // 単独: each page on its own, one at a time; a 縦スクロール strip has no spreads.
    if ((this.single && !this.continuous) || project?.scroll)
      return Array.from({ length: count }, (_, i): [number | null, number | null] => [i + 1, null]);
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
    this.host.draw();
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
    this.host.draw();
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
      this.host.draw();
      return;
    }
    const { width, height } = this.stageSize();
    const [x0, y0, x1, y1] = box;
    const inside = x0 >= 0 && x1 <= width && y0 >= 0 && y1 <= height;
    if (inside || this.view.changed) {
      this.host.draw();
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
    this.host.draw();
  }

  /** The screen box (px) of the spread worked on, with the room for its page numbers. */
  private spreadBox(slots: Slot[]): BoxMm | null {
    const pages = this.currentPages();
    return this.extent(slots.filter((slot) => pages.includes(slot.index + 1)));
  }

  /** The screen box (px) of the pages in `slots`, with the room for their page numbers. */
  extent(slots: Slot[]): BoxMm | null {
    return extent(slots, this.host.project()?.pageFormat.canvasMm[1] ?? 0);
  }

  resetView(zoom = 1): void {
    this.view.reset(zoom);
    this.sliding = null;
  }

  /** Ctrl+0: the whole spread, upright and not mirrored (連続: the spread worked on, in the middle). */
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
    this.view.flipped = false;
    this.setRotation(0);
  }

  /** 左右反転: mirror the view (to see the balance of a page afresh, as CSP's 画面の左右反転). */
  setFlipped(flipped: boolean): void {
    if (this.view.flipped === flipped) return;
    this.view.flipped = flipped;
    this.applyViewTransform();
    this.host.draw();
    this.host.status(flipped ? "画面を左右反転しています（もう一度で戻す）" : "画面の左右反転を戻しました");
  }

  /** Turn the view by `degrees` (Shift + Space + drag turns it freely). */
  rotateView(degrees: number): void {
    this.setRotation(this.view.rotation + (degrees * Math.PI) / 180);
  }

  setRotation(radians: number): void {
    this.view.turnTo(radians);
    this.applyViewTransform();
    this.host.draw();
    const degrees = Math.round((this.view.rotation * 180) / Math.PI);
    const flipped = this.view.flipped ? "（左右反転中）" : "";
    this.host.status(degrees ? `画面を ${degrees}° 回しています${flipped}（Ctrl+0 で戻す）` : `画面の回転を戻しました${flipped}`);
  }

  /** Where an event is in the view before turning (what the pages are laid out in). */
  at(event: MouseEvent): Point {
    return this.view.unturned([event.offsetX, event.offsetY]);
  }

  applyViewTransform(): void {
    this.ctx.setTransform(...this.view.matrix(window.devicePixelRatio || 1));
  }

  resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    const before = this.size;
    const project = this.host.project();
    // 連続, as the stage grows or shrinks (Tab, the strip, the window): fitted to it, fitted again;
    // otherwise what was in the middle stays in the middle.
    const was = this.continuous && project && before?.width && before.height && width && height ? this.layout(project) : null;
    const fitted =
      was && project && !project.scroll && before
        ? fittedTo(was, project.pageFormat.canvasMm[1], before.width, before.height, this.view.zoom, this.rooms)
        : null;
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
    this.host.draw();
  }

  /**
   * The canvas on screen (CSS px), as of the last resize (the stage is watched
   * for that): reading it from the page while drawing would make the browser
   * lay out what the side panels just changed, in the middle of a frame.
   */
  stageSize(): { width: number; height: number } {
    if (this.size) return this.size;
    const { width, height } = this.canvas.getBoundingClientRect();
    // Not kept while the editor is hidden: the next resize gives it.
    if (width && height) this.size = { width, height };
    return { width, height };
  }

  private arrangement(): Arrangement {
    const { width, height } = this.stageSize();
    return {
      single: this.single,
      continuous: this.continuous,
      rows: this.rows,
      zoom: this.view.zoom,
      pan: this.view.pan,
      width,
      height,
      gapMm: this.pageGapMm,
      rooms: this.rooms,
      captionRows: this.captionRows,
    };
  }

  /** How many rows a page's number and memo take under it, as drawn. */
  private readonly captionRows = captionMeter(() => this.ctx, SMALL_PAGE_PX);

  layout(project: Project): Slot[] {
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
    this.host.requestDraw();
    return slots.map((slot) => {
      const from = sliding.from.get(slot.index);
      return from ? { ...slot, x: from[0] + (slot.x - from[0]) * ease, y: from[1] + (slot.y - from[1]) * ease } : slot;
    });
  }

  /** Whether any of a page (and its number) is on screen. */
  onCanvas(project: Project, slot: Slot): boolean {
    const { width, height } = this.stageSize();
    return onStage(slot, project.pageFormat.canvasMm[1], width, height, this.view.rotation);
  }

  slotAt(sx: number, sy: number, project: Project): Slot | null {
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
  facingSlot(slot: Slot): Slot | null {
    const pair = this.spreadList().find((p) => p.includes(slot.index + 1));
    const other = pair?.find((page) => page !== null && page !== slot.index + 1);
    // Slots are laid out again on every draw, so match by page.
    return (other && this.slots.find((s) => s.index === other - 1)) || null;
  }

  /** Where the gutter between `slot` and its facing page is, in `slot`'s mm. */
  gutterOf(slot: Slot, facing: Slot): number {
    return facing.x > slot.x ? slot.shown[1] : slot.shown[0];
  }

  /** The other page that a point (mm on `slot`) is over, if it is over another one. */
  otherPageUnder(project: Project, slot: Slot, [x, y]: Point): Slot | null {
    const there = this.slotAt(slot.x + x * slot.scale, slot.y + y * slot.scale, project);
    if (there) return there.index === slot.index ? null : there;
    // Past the gutter, even beyond the facing page: the facing page.
    const facing = this.facingSlot(slot);
    const across = facing && (facing.x > slot.x ? x > slot.shown[1] : x < slot.shown[0]);
    return across ? facing : null;
  }

  /** 連続: room between the pages for what lies in their 欄外 (not what is hidden), made anew as that changes (the pages slide, the spread worked on stays put). */
  keepRoom(project: Project): void {
    const shown = (kind: string, id: string) => (kind !== "sticky" || this.showStickies) && !this.hidden.has(`${kind}:${id}`);
    const rooms = asideRooms(project, project.pageFormat.canvasMm[1] / 2, shown);
    if (sameRooms(rooms, this.rooms)) return;
    if (!this.continuous) {
      this.rooms = rooms;
      return;
    }
    const from = new Map(this.slots.map((slot): [number, Point] => [slot.index, [slot.x, slot.y]]));
    const before = this.spreadBox(this.layout(project));
    this.rooms = rooms;
    const after = this.spreadBox(this.layout(project));
    if (before && after) this.view.pan = [this.view.pan[0] + before[0] - after[0], this.view.pan[1] + before[1] - after[1]];
    if (from.size && !matchMedia("(prefers-reduced-motion: reduce)").matches) this.sliding = { from, start: performance.now() };
  }

  /** Lay the pages out for a drawing (part of the way there while they slide). */
  arrange(project: Project): void {
    this.slots = this.slid(this.layout(project));
  }

  /** The page worked on is `slot`'s (the page settings follow it); 連続: its spread is the one worked on. True when the spread changed. */
  focusOn(slot: Slot): boolean {
    this.focusedPageId = slot.page.id;
    const spread = this.spreadList().findIndex((pair) => pair.includes(slot.index + 1));
    const moved = this.continuous && spread >= 0 && spread !== this.spreadIndex;
    if (moved) this.spreadIndex = spread;
    return moved;
  }

  /** The wheel over the pages: down a 縦スクロール strip, along the row (Shift, or a sideways swipe), else zooming about the pointer. */
  wheel(event: WheelEvent, project: Project): void {
    if (project.scroll && !event.ctrlKey && !event.metaKey && !event.shiftKey && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
      // 縦スクロール: the wheel goes down the strip, as it is read; Ctrl+ホイール (a pinch) zooms.
      this.view.pan[1] -= event.deltaY;
      this.sliding = null;
      this.host.draw();
      return;
    }
    if (event.shiftKey || (event.deltaX && Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
      // Shift+ホイール (or a sideways swipe): along the row, onward in reading order.
      const along = event.deltaX || event.deltaY;
      this.view.pan[0] += project.binding === "right" ? along : -along;
      this.host.draw();
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
    this.host.draw();
  }

  /** The page as shown: without what the レイヤー list (or a ラフ線のレイヤー) hides, or the 付箋 hidden all together. */
  visiblePage(page: Page): Page {
    return withoutHidden(page, this.hidden, this.showStickies, this.host.project() ?? undefined);
  }

  /** A page shown small (連続, from afar): too small for its marks and memos. */
  small(project: Project, slot: Slot): boolean {
    const [x0, , x1] = trimBox(project.pageFormat);
    return (x1 - x0) * slot.scale < SMALL_PAGE_PX;
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
    this.host.draw();
  }
}

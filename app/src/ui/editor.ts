// The page editor: turns pointer input on the pages into edits (select and
// move, cut panels, place lines, draw and erase) and is what the screens
// around it talk to. It puts three parts together and hands the input out:
//   editorstage.ts  the pages as they lie on screen, and the view on them
//   editorpicks.ts  what is picked, and what is done with it as a whole
//   editorpaint.ts  the drawing of the pages and of what lies over them
// What each tool does with a press and its drags is in its own module
// (tools.ts); the memos and 付箋 drawn for the person only are notedraw.ts,
// writing on the page in place is inplace.ts.
// Coordinates on a page are millimetres; each page of the spread has its own
// mm → screen mapping.
import { isTyping } from "../platform/dom";
import { BALLOON_TEXT_KEY, loadFillSettings, loadSnap, PANEL_CARRIES_KEY, penPreferences, SHOW_STICKIES_KEY } from "../platform/prefs";
import { toPage, type Slot } from "../editing/layout";
import { addDrawnPanel, spanGutter } from "../domain/koma";
import { joinPanels, seamAt } from "../domain/komaedit";
import { onTipLoaded } from "../render/pagedraw";
import { perfMeter } from "../platform/perfmeter";
import { ROUGH_BASE } from "../domain/roughlayers";
import { neighbour, setLineText } from "../domain/dialogue";
import type { FillSettings } from "../editing/fillsettings";
import type { Binding, Brush, Page, Panel, Point, Project } from "../model/model";
import { gutters, pageIndex } from "../domain/project";
import { assignPanels, sortLines } from "../domain/readingorder";
import { asideSlot, pressHeld } from "./toolaside";
import { readFlag, writeFlag } from "../platform/settings";
import type { Drag, EditorCore, EditorEraseMode, EditorHost, Guides, Hover, PanelMode, Selection, Tool } from "./editorcore";
import { markPen } from "./toolmark";
import { editorCursor } from "./cursors";
import { dragHandler, PRESS } from "./tools";
import { pickedSummary } from "./toolselect";
import { snapPointTo, snapTargets, type SnapSettings, type SnapTargets } from "../domain/snapping";
import type { Viewport } from "../editing/viewport";
import { EditorPainter, type PaintScene } from "./editorpaint";
import { EditorPicks, type PicksScene } from "./editorpicks";
import { EditorStage } from "./editorstage";
import { stickyHandle } from "../render/notedraw";
import { writeInPlace, type InPlaceEdit, type InPlaceHost } from "./inplace";
import { badgeAt, linesAt, panelAt, referenceCornerAt } from "../editing/hittest";

export type { EditorEraseMode, EditorHost, PanelMode, Selection, Tool } from "./editorcore";
export { pickedSummary };

export const PANEL_MODE_LABELS: Record<PanelMode, string> = { cut: "割る", sketch: "描く", rect: "四角", polygon: "多角形" };

export const ERASE_MODE_LABELS: Record<EditorEraseMode, string> = {
  touched: "触れた部分",
  intersection: "交点まで",
  whole: "線全体",
  lasso: "囲って消す",
};

export class PageEditor {
  tool: Tool = "select";

  /** Picking the next of overlapping balloons, held back while a double-click may follow. */
  private cycleTimer = 0;

  /** コマに中身が付いてくる: moving or reshaping a panel takes its contents along. */
  panelCarries = readFlag(PANEL_CARRIES_KEY, true);

  /** A balloon transformed on its own: its text grows and shrinks with it (off: only the balloon changes). */
  balloonTextFollows = readFlag(BALLOON_TEXT_KEY, true);

  penWidthMm = 0.4;

  /** The ラフ線のレイヤー the pen draws on (ROUGH_BASE when the name has one layer). */
  roughLayer = ROUGH_BASE;

  /** Brushes in use (ids in the project); null is the plain pen / eraser. */
  penBrush: string | null = null;

  eraserBrush: string | null = null;

  eraserSizeMm = 2;

  /** 塗り: the way in hand (CSP's sub tools), the tone and each way's settings. */
  fill: FillSettings = loadFillSettings();

  /** The eraser's way of erasing; the pen's eraser end uses it too. */
  eraseMode: EditorEraseMode = "whole";

  /** The pen's eraser end is down or hovering: erase whatever the tool. */
  private tipEraser = false;

  /** 吸着: what panel corners, borders and panels snap to (nothing while Alt is held). */
  snapping: SnapSettings = loadSnap();

  /** コマ割り: what a drag with the panel tool does. */
  panelMode: PanelMode = "cut";

  /** 多角形: the corners placed so far on a page (the panel is made when the outline is closed). */
  private polygon: { pageId: string; points: Point[] } | null = null;

  /** Lines snapped to while dragging (page mm), shown as guides. */
  private guides: Guides | null = null;

  private drag: Drag | null = null;

  private spaceHeld = false;

  private pointer: Point | null = null;

  /** 資料: the picture chosen with the 資料 tool. */
  reference: { pageId: string; id: string } | null = null;

  private hover: Hover | null = null;

  private hoverAt: Point | null = null;

  private hoverFrame = 0;

  /** A text being written in place on the page (a panel's memo or dialogue). */
  private inline: InPlaceEdit | null = null;

  /** Run once the pointer is up (opening a text field during the press would lose its focus). */
  private afterUp: (() => void) | null = null;

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

  /** The pages as they lie on screen, and the view on them. */
  readonly stage: EditorStage;
  /** What is picked, and what is done with it as a whole. */
  readonly picks: EditorPicks;
  /** The drawing of all that. */
  readonly painter: EditorPainter;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: EditorHost,
  ) {
    // Low latency: the pen line reaches the screen without waiting for the compositor.
    const ctx = canvas.getContext("2d", { desynchronized: true })!;
    this.stage = new EditorStage(canvas, ctx, {
      project: () => host.project(),
      status: (message) => host.status(message),
      draw: () => this.painter.draw(),
      requestDraw: () => this.painter.requestDraw(),
    });
    this.picks = new EditorPicks(canvas, host, this.stage, this.picksScene());
    this.painter = new EditorPainter(canvas, ctx, host, this.stage, this.picks, this.paintScene());
    // A pen held still or its barrel button must not open the context menu.
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    onTipLoaded(() => this.painter.tipsChanged());
    penPreferences.onChange(() => {
      this.updateCursor();
      this.painter.requestOverlay();
    });
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
      this.painter.requestOverlay();
    });
    canvas.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    canvas.addEventListener("dblclick", (event) => this.doubleClick(event));
    // 多角形: Enter closes the outline, Backspace takes back a corner, Esc stops (before the app's own keys).
    window.addEventListener(
      "keydown",
      (event) => {
        if (!this.polygon || isTyping(event)) return;
        const done =
          event.key === "Enter"
            ? this.finishPolygon()
            : event.key === "Backspace"
              ? this.cancelPolygon(true)
              : event.key === "Escape"
                ? this.cancelPolygon()
                : false;
        if (done) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
    window.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && this.picks.isTransforming && !isTyping(event)) {
        event.preventDefault();
        this.picks.toggleTransform(false);
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

  /** What the drawing looks at here (editorpaint.ts): getters, for it is made before the fields below it are. */
  private paintScene(): PaintScene {
    const editor = this;
    return {
      get tool() {
        return editor.tool;
      },
      get drag() {
        return editor.drag;
      },
      get hover() {
        return editor.hover;
      },
      get pointer() {
        return editor.pointer;
      },
      get spaceHeld() {
        return editor.spaceHeld;
      },
      get polygon() {
        return editor.polygon;
      },
      get guides() {
        return editor.guides;
      },
      get snapping() {
        return editor.snapping;
      },
      get reference() {
        return editor.reference;
      },
      get fill() {
        return editor.fill;
      },
      get penWidthMm() {
        return editor.penWidthMm;
      },
      get eraseMode() {
        return editor.eraseMode;
      },
      polygonSlot: () => this.polygonSlot(),
      nextCorner: (slot, point, free) => this.nextCorner(slot, point, free),
      erasing: () => this.erasing(),
      eraserRadiusPx: () => this.eraserRadiusPx(),
      brush: (kind) => this.brush(kind),
      laidOut: () => {
        this.inline?.place();
        this.picks.placeBar();
      },
    };
  }

  /** What the selection needs from here (editorpicks.ts). */
  private picksScene(): PicksScene {
    const editor = this;
    return {
      get tool() {
        return editor.tool;
      },
      get drag() {
        return editor.drag;
      },
      get hover() {
        return editor.hover;
      },
      get pointer() {
        return editor.pointer;
      },
      get writing() {
        return editor.inline !== null;
      },
      get panelCarries() {
        return editor.panelCarries;
      },
      binding: () => this.binding(),
      showStickies: () => this.setStickiesShown(true),
      draw: () => this.painter.draw(),
    };
  }

  // --- The pages on screen (editorstage.ts) --------------------------------------

  private get slots(): Slot[] {
    return this.stage.slots;
  }

  private get view(): Viewport {
    return this.stage.view;
  }

  get spreadIndex(): number {
    return this.stage.spreadIndex;
  }

  set spreadIndex(index: number) {
    this.stage.spreadIndex = index;
  }

  /** The first page is on its own (a cover), the rest in spreads. */
  get firstAlone(): boolean {
    return this.stage.firstAlone;
  }

  set firstAlone(alone: boolean) {
    this.stage.firstAlone = alone;
  }

  /** 単独: one page at a time instead of 見開き. */
  get single(): boolean {
    return this.stage.single;
  }

  set single(single: boolean) {
    this.stage.single = single;
  }

  /** 連続: every page on one canvas, the spreads in `rows` rows. */
  get continuous(): boolean {
    return this.stage.continuous;
  }

  set continuous(continuous: boolean) {
    this.stage.continuous = continuous;
  }

  get rows(): number {
    return this.stage.rows;
  }

  /** 連続: room between the spreads (mm). */
  get pageGapMm(): number {
    return this.stage.pageGapMm;
  }

  /** Each panel's memo shown on the page (only on screen, never exported). */
  get showNotes(): boolean {
    return this.stage.showNotes;
  }

  set showNotes(shown: boolean) {
    this.stage.showNotes = shown;
  }

  /** 付箋 shown on the pages and beside them (setStickiesShown). */
  get showStickies(): boolean {
    return this.stage.showStickies;
  }

  /** Hidden on screen from the レイヤー list (`kind:id`); exports keep them. */
  get hidden(): Set<string> {
    return this.stage.hidden;
  }

  spreadList(): [number | null, number | null][] {
    return this.stage.spreadList();
  }

  /** Page numbers (1-based) on the current spread, right page first. */
  currentPages(): number[] {
    return this.stage.currentPages();
  }

  showPage(pageNumber: number): void {
    this.stage.showPage(pageNumber);
  }

  flip(step: number): void {
    this.stage.flip(step);
  }

  /** 連続: how many rows the spreads are in. */
  rowCount(): number {
    return this.stage.rowCount();
  }

  setRows(rows: number): void {
    this.stage.setRows(rows);
  }

  setPageGap(mm: number): void {
    this.stage.setPageGap(mm);
  }

  fitAll(slide = true): void {
    this.stage.fitAll(slide);
  }

  fitRows(): void {
    this.stage.fitRows();
  }

  resetView(zoom = 1): void {
    this.stage.resetView(zoom);
  }

  fitView(): void {
    this.stage.fitView();
  }

  rotateView(degrees: number): void {
    this.stage.rotateView(degrees);
  }

  resize(): void {
    this.stage.resize();
  }

  /** Where a point of a shown page (mm) is in the window (client px), or null when the page is not shown. */
  clientOf(pageId: string, point: Point): Point | null {
    return this.stage.clientOf(pageId, point);
  }

  /** The page under a point of the window, the point on it (mm) and the panel there. */
  pageAtClient(clientX: number, clientY: number): { page: Page; point: Point; panel?: Panel } | null {
    return this.stage.pageAtClient(clientX, clientY);
  }

  // --- What is picked (editorpicks.ts) ---------------------------------------------

  get selection(): Selection | null {
    return this.picks.selection;
  }

  set selection(selection: Selection | null) {
    this.picks.selection = selection;
  }

  /** `quiet`: another part of the screen took the selection, and says so itself. */
  select(selection: Selection | null, quiet = false): void {
    this.picks.select(selection, quiet);
  }

  renderBar(): void {
    this.picks.renderBar();
  }

  /** The page the selection is on, else the page of the spread last clicked or picked, else its first page. */
  focusPage(): Page | null {
    return this.picks.focusPage();
  }

  get isTransforming(): boolean {
    return this.picks.isTransforming;
  }

  /** 変形 on or off for the selection (Ctrl+T); false when it cannot be transformed. */
  toggleTransform(on?: boolean): boolean {
    return this.picks.toggleTransform(on);
  }

  transformSelection(how: "flipH" | "flipV" | "left" | "right"): boolean {
    return this.picks.transformSelection(how);
  }

  copy(): boolean {
    return this.picks.copy();
  }

  get canPaste(): boolean {
    return this.picks.canPaste;
  }

  pasteTarget(): { page: Page; point?: Point } | null {
    return this.picks.pasteTarget();
  }

  paste(): boolean {
    return this.picks.paste();
  }

  selectAll(): boolean {
    return this.picks.selectAll();
  }

  /** Nudge the selection with the arrow keys (mm). */
  nudge(dx: number, dy: number): boolean {
    return this.picks.nudge(dx, dy);
  }

  // --- The drawing (editorpaint.ts) ------------------------------------------------

  draw(): void {
    this.painter.draw();
  }

  get kept(): { linePictures: number; linePixels: number; screenPixels: number } {
    return this.painter.kept;
  }

  // --- Tools and what they show -----------------------------------------------------

  setTool(tool: Tool): void {
    this.tool = tool;
    if (tool !== "cut") this.cancelPolygon();
    if (tool === "sticky" && !this.stage.showStickies) this.setStickiesShown(true); // 付箋 put while hidden would not be seen.
    this.picks.toolTaken(tool);
    this.updateCursor();
    this.picks.renderBar();
    this.painter.draw();
  }

  /**
   * ページをまたぐコマ: panels of the page drawn on past the gutter onto the
   * facing page (on screen beside it) become 見開き panels. Returns how many.
   */
  private spanPanels(project: Project, pageId: string): number {
    const slot = this.slots.find((s) => s.page.id === pageId);
    const facing = slot && this.stage.facingSlot(slot);
    if (!slot || !facing) return 0;
    let count = 0;
    for (const panel of [...slot.page.panels]) if (spanGutter(project, slot.page, panel, this.stage.firstAlone)) count++;
    if (count)
      this.host.status(
        `コマがのどを越えたので、${slot.index + 1}・${facing.index + 1} ページの見開きコマにしました（「見開きをやめる」で戻せます）`,
      );
    return count;
  }

  /** 付箋を出す・隠す (on screen only): hidden, none can be picked, and 連続 closes up the room only they took. */
  setStickiesShown(shown: boolean): void {
    if (shown === this.stage.showStickies) return;
    this.stage.showStickies = shown;
    writeFlag(SHOW_STICKIES_KEY, shown);
    const box = document.getElementById("show-stickies");
    if (box instanceof HTMLInputElement) box.checked = shown;
    this.host.status(shown ? "付箋を出しました" : "付箋を隠しました（画面だけ。紙面の下の付箋のボタンでまた出します）");
    if (!shown && this.picks.selection?.kind === "sticky") this.picks.select(null);
    this.painter.draw();
  }

  /** 資料: the chosen picture's corner under a screen point (0–3), or -1. */
  private referenceCornerAt(slot: Slot, sx: number, sy: number): number {
    return referenceCornerAt(slot, this.reference?.pageId === slot.page.id ? this.reference.id : null, sx, sy);
  }

  /** Choose a 資料画像 (or none) with the 資料 tool. */
  chooseReference(reference: { pageId: string; id: string } | null): void {
    this.reference = reference;
    this.host.referenceChanged?.();
    this.painter.draw();
  }

  /** The panel whose memo tag (or, for the panel under the pointer, its "＋メモ" tag) is at a screen point. */
  private noteAt(slot: Slot, sx: number, sy: number): Panel | undefined {
    const hovered = this.hover?.kind === "item" && this.hover.target.kind === "panel" ? this.hover.target.id : null;
    const project = this.host.project();
    if (project && this.stage.small(project, slot)) return undefined;
    return slot.page.panels.find((panel) => {
      if (!(this.stage.showNotes && panel.note) && panel.id !== hovered) return false;
      const { x, y, w, h } = this.painter.noteBox(slot, panel);
      return sx >= x && sx <= x + w && sy >= y && sy <= y + h;
    });
  }

  /** The line or panel at a point, to tie a 付箋 to. */
  private linkTarget(slot: Slot, point: Point): Selection | null {
    const page = this.stage.visiblePage(slot.page);
    const line = linesAt(this.stage.visiblePage(slot.page), point)[0];
    if (line) return { kind: "line", pageId: page.id, id: line };
    const panel = panelAt(page, point);
    return panel ? { kind: "panel", pageId: page.id, id: panel.id } : null;
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
    this.picks.select({ kind: "panel", pageId: page.id, id: panel.id });
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
      this.host.status(
        "多角形: クリックで角を置く。最初の角をクリック・ダブルクリック・Enter で閉じてコマに（Backspace で 1 つ戻す、Esc でやめる）",
      );
      this.painter.requestOverlay();
      return;
    }
    const near = (p: Point) => Math.hypot(p[0] - point[0], p[1] - point[1]) * slot.scale <= 8;
    if (polygon.points.length >= 3 && (near(polygon.points[0]) || near(polygon.points[polygon.points.length - 1]))) {
      this.finishPolygon();
      return;
    }
    polygon.points.push(this.nextCorner(slot, point, free));
    this.guides = null;
    this.painter.requestOverlay();
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
    this.painter.draw();
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
    this.painter.requestOverlay();
    return true;
  }

  /** コマ割り: cut, draw rectangles or place corners. */
  setPanelMode(mode: PanelMode): void {
    this.panelMode = mode;
    if (mode !== "polygon") this.cancelPolygon();
    this.painter.requestOverlay();
  }

  /** The drag under way (a line, a panel moved, …; "pan", "pinch" and "turn" move the view), or null. */
  get dragKind(): string | null {
    return this.drag?.kind ?? null;
  }

  /** What the select tool would grab under the pointer, for the help bar: "item.panel", "seam", "tail.tip", "handle". */
  get hovered(): string | null {
    return (
      this.hover &&
      (this.hover.kind === "item"
        ? `item.${this.hover.target.kind}`
        : this.hover.kind === "tail"
          ? `tail.${this.hover.hit.part}`
          : this.hover.kind)
    );
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

  /** The panel whose number is under the pointer (none on a page shown small). */
  private badgeAt(slot: Slot, sx: number, sy: number, pageW: number): Panel | undefined {
    const project = this.host.project();
    if (project && this.stage.small(project, slot)) return undefined;
    return badgeAt(slot, project?.pageFormat, pageW, sx, sy);
  }

  // --- input ------------------------------------------------------------------------

  /** Whether the pointer erases now: the eraser tool or the pen's eraser end. */
  private erasing(): boolean {
    return this.tool === "eraser" || this.tipEraser || (this.tool === "mark" && markPen.erase);
  }

  private updateCursor(): void {
    const hover = this.hover && (this.hover.kind === "tail" ? { kind: "tail" as const, part: this.hover.hit.part } : this.hover);
    const lasso = this.eraseMode === "lasso";
    this.canvas.style.cursor = editorCursor({
      tool: this.tool,
      panning: this.spaceHeld,
      erasing: this.erasing(),
      lasso,
      hover,
      penLook: penPreferences.settings.cursor,
    });
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
    if (
      penPreferences.settings.pinchRotate &&
      this.view.turnTo(drag.rotation + Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) - drag.angle, (3 * Math.PI) / 180)
    ) {
      this.stage.applyViewTransform();
    }
    this.view.holdAnchor(drag.v, mid, zoom);
    this.painter.requestDraw();
  }

  /** After an error: forget the drag in progress without finishing it (the change it made was undone). */
  dropDrag(): void {
    this.drag = null;
    this.painter.endLive();
    this.afterUp = null;
    this.dragPointer = null;
    this.dragPointerType = "";
  }

  /** Give up the drag in progress: a line not yet drawn goes; a change already made stays. */
  private abandonDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.painter.endLive();
    this.guides = null;
    if (["move", "vertex", "seam", "scale", "rotate", "warp", "tail", "erase"].includes(drag.kind)) this.completeDrag(drag);
    this.dragPointer = null;
    this.dragPointerType = "";
    this.painter.draw();
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
    const [sx, sy] = this.stage.at(event);
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
    let slot = this.stage.slotAt(sx, sy, project);
    // The selected panel's corners, also where they lie past its page (over the facing one).
    const selectedOn =
      this.tool === "select" && this.picks.selection?.kind === "panel"
        ? this.slots.find((x) => x.page.id === this.picks.selection!.pageId)
        : undefined;
    if (selectedOn && selectedOn !== slot && this.picks.vertexAt(selectedOn, sx, sy) >= 0) slot = selectedOn;
    // Off every page: in the 欄外 of the nearest one.
    slot ??= asideSlot(this.core, this.tipEraser ? "eraser" : this.tool, project, sx, sy);
    if (!slot) {
      this.picks.select(null);
      return;
    }
    // The page settings follow the page worked on (the left page of a spread too).
    if (this.stage.focusedPageId !== slot.page.id) this.picks.focusOn(slot);
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
        return editor.picks.selection;
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
      get fill() {
        return editor.fill;
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
      select: (selection) => this.picks.select(selection),
      setSelection: (selection) => (this.picks.selection = selection),
      chooseReference: (reference) => this.chooseReference(reference),
      forgetHover: () => (this.hover = null),
      requestDraw: () => this.painter.requestDraw(),
      requestOverlay: () => this.painter.requestOverlay(),
      captureBase: () => this.painter.captureBase(),
      at: (event) => this.stage.at(event),
      slotAt: (sx, sy, project) => this.stage.slotAt(sx, sy, project),
      facingSlot: (slot) => this.stage.facingSlot(slot),
      gutterOf: (slot, facing) => this.stage.gutterOf(slot, facing),
      binding: () => this.binding(),
      brush: (kind) => this.brush(kind),
      eraserRadiusPx: (scale) => this.eraserRadiusPx(scale),
      hit: (slot, point) => this.picks.hit(slot, point),
      linesAt: (slot, point) => linesAt(this.stage.visiblePage(slot.page), point),
      panelAt: (page, point) => panelAt(page, point),
      vertexAt: (slot, sx, sy) => this.picks.vertexAt(slot, sx, sy),
      tailAt: (slot, sx, sy) => this.picks.tailAt(slot, sx, sy),
      badgeAt: (slot, sx, sy, pageW) => this.badgeAt(slot, sx, sy, pageW),
      noteAt: (slot, sx, sy) => this.noteAt(slot, sx, sy),
      noteBox: (slot, panel) => this.painter.noteBox(slot, panel),
      stickyHandle,
      linkTarget: (slot, point) => this.linkTarget(slot, point),
      referenceCornerAt: (slot, sx, sy) => this.referenceCornerAt(slot, sx, sy),
      isSelected: (page, kind, id) => this.picks.isSelected(page, kind, id),
      groupHit: (page, point, tolerance) => this.picks.groupHit(page, point, tolerance),
      selectedItems: () => this.picks.selectedItems(),
      frameHandleAt: (sx, sy) => this.picks.frameHandleAt(sx, sy),
      frameGeometry: () => this.picks.frameGeometry(),
      snapTargetsOn: (project, page, exclude) => this.snapTargetsOn(project, page, exclude),
      snapped: (slot, point, targets, free, beside) => this.snapped(slot, point, targets, free, beside),
      moveSelection: (page, dx, dy, items) => this.picks.moveSelection(page, dx, dy, items),
      follow: (page, carried) => this.picks.follow(page, carried),
      carryToPageUnder: (project, slot) => this.picks.carryToPageUnder(project, slot),
      spanPanels: (project, pageId) => this.spanPanels(project, pageId),
      addFreePanel: (project, page, outline) => this.addFreePanel(project, page, outline),
      placeCorner: (slot, point, free) => this.placeCorner(slot, point, free),
      editInPlace: (pageId, kind, id, fresh) => this.editInPlace(pageId, kind, id, fresh),
    };
  }

  /**
   * 低遅延: a pen line takes its input as soon as it comes and paints it
   * straight onto the screen (a desynchronized canvas shows it without
   * waiting for the next frame); the frame after it only adds what lies over
   * the pages and the 先読み.
   */
  private rawMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag?.kind !== "pen" || !this.painter.takesRaw || event.pointerId !== this.dragPointer || !penPreferences.settings.lowLatency)
      return;
    const [ex, ey] = this.stage.at(event);
    this.pointer = [ex, ey];
    const coalesced = event.getCoalescedEvents?.() ?? [];
    perfMeter.input(coalesced[0]?.timeStamp ?? event.timeStamp, true, coalesced.length || 1);
    const project = this.host.project()!;
    dragHandler(drag).move(this.core, drag, { event, project, point: toPage(drag.slot, ex, ey), ex, ey, phase: "raw" });
    this.painter.paintRaw(drag);
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
    const [ex, ey] = this.stage.at(event);
    this.pointer = [ex, ey];
    const drag = this.drag;
    if (!drag) {
      this.setTipEraser(event);
      this.scheduleHover(ex, ey);
      if (this.erasing() || this.tool === "pen" || this.polygon) this.painter.requestOverlay();
      return;
    }
    if (drag.kind === "pan") {
      // The pages follow the hand on screen, however the view is turned.
      this.view.dragBy(event.clientX - drag.x, event.clientY - drag.y);
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.painter.requestDraw();
      return;
    }
    if (drag.kind === "turn") {
      // The angle on screen: turning the view moves the local frame along.
      let rotation = drag.rotation + this.view.angleAt(...this.stage.at(event)) - drag.from;
      if (event.altKey) rotation = Math.round(rotation / (Math.PI / 12)) * (Math.PI / 12);
      this.stage.setRotation(rotation);
      return;
    }
    if (drag.kind === "pinch") return;
    // A pen line taking its input as it comes (rawMove): this move only looks ahead.
    const phase = drag.kind === "pen" && this.painter.paintedRaw ? "frame" : undefined;
    if (!phase) {
      // For 動作の記録: how long the oldest of the moves takes to show.
      const coalesced = event.getCoalescedEvents?.() ?? [];
      perfMeter.input(coalesced[0]?.timeStamp ?? event.timeStamp, drag.kind === "pen", coalesced.length || 1);
    }
    const point = toPage(drag.slot, ex, ey);
    const project = this.host.project()!;
    if (dragHandler(drag).move(this.core, drag, { event, project, point, ex, ey, phase }) === false) return;
    this.painter.requestDraw();
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
          this.painter.draw();
        }
        return;
      }
    }
    if (this.drag && this.dragPointer !== null && event.pointerId !== this.dragPointer) return;
    this.dragPointer = null;
    this.dragPointerType = "";
    const drag = this.drag;
    this.drag = null;
    this.painter.endLive();
    this.guides = null;
    const after = this.afterUp;
    this.afterUp = null;
    if (after) setTimeout(after, 0);
    if (!drag) return;
    this.completeDrag(drag);
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.painter.draw();
  }

  /** Finish what a drag did: keep the change for undo, make what was drawn. */
  private completeDrag(drag: Drag): void {
    const project = this.host.project();
    if (!project || drag.kind === "pan" || drag.kind === "turn" || drag.kind === "pinch") return;
    dragHandler(drag).end(this.core, drag, project);
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
      const slot = this.stage.slotAt(sx, sy, project);
      const frameHandle = this.picks.frameHandleAt(sx, sy);
      if (frameHandle >= 0 && slot) hover = { kind: "handle", slot, handle: frameHandle };
      else if (slot) {
        const point = toPage(slot, sx, sy);
        const tail = this.picks.tailAt(slot, sx, sy);
        if (tail) hover = { kind: "tail", slot, hit: tail };
        const onHandle = !!tail || this.picks.vertexAt(slot, sx, sy) >= 0 || !!this.badgeAt(slot, sx, sy, project.pageFormat.canvasMm[0]);
        const target = onHandle ? null : this.picks.hit(slot, point);
        if (!onHandle && (!target || target.kind === "panel")) {
          const seam = seamAt(slot.page, point, 6 / slot.scale);
          if (seam) hover = { kind: "seam", slot, seam };
        }
        if (!hover && target) hover = { kind: "item", slot, target };
      }
    }
    const key = (h: Hover | null) =>
      !h
        ? ""
        : h.kind === "tail"
          ? `tail:${h.hit.lineId}:${h.hit.index}:${h.hit.part}`
          : h.kind === "handle"
            ? `handle:${h.handle}`
            : h.kind === "seam"
              ? `seam:${h.slot.page.id}:${h.seam.edges.map((e) => `${e.panelId}.${e.edge}`).join(",")}`
              : `item:${h.target.pageId}:${h.target.kind}:${h.target.id}`;
    if (key(hover) === key(this.hover)) return;
    this.hover = hover;
    this.canvas.dispatchEvent(new Event("hoverchange"));
    this.updateCursor();
    this.painter.requestOverlay();
  }

  /** The cursor for moving a border: across it. */
  private doubleClick(event: MouseEvent): void {
    window.clearTimeout(this.cycleTimer);
    if (this.tool === "cut" && this.finishPolygon()) return;
    const project = this.host.project();
    if (!project || this.tool !== "select") return;
    const [ex, ey] = this.stage.at(event);
    const slot = this.stage.slotAt(ex, ey, project);
    if (!slot) return;
    const point = toPage(slot, ex, ey);
    const target = this.picks.hit(slot, point);
    // Dialogue: write it right there.
    if (target?.kind === "line") {
      this.editInPlace(slot.page.id, "line", target.id);
      return;
    }
    // 付箋: write in it, in the right panel.
    if (target?.kind === "sticky")
      return void (this.picks.select(target), document.querySelector<HTMLTextAreaElement>("#inspector textarea")?.focus());
    if (target && target.kind !== "panel") return;
    // Inside a panel: its memo.
    const panel = panelAt(slot.page, point);
    if (panel) {
      this.picks.select({ kind: "panel", pageId: slot.page.id, id: panel.id });
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
    this.picks.select({ kind: "panel", pageId: slot.page.id, id: a.id });
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
    if (!this.slots.some((slot) => slot.page.id === pageId)) this.stage.showPage(pageIndex(project!, pageId) + 1);
    const host: InPlaceHost = {
      begin: () => this.host.begin(),
      commit: () => this.host.commit(),
      cancel: () => this.host.cancel(),
      status: (message) => this.host.status(message),
      draw: () => this.painter.draw(),
      slotOf: (id) => this.slots.find((s) => s.page.id === id),
      noteAt: (slot, panel) => this.painter.noteBox(slot, panel),
      onScreen: (point) => this.view.onScreen(point),
      drop: (pageId, lineId) => {
        const on = this.host.project()?.pages.find((p) => p.id === pageId);
        if (on) on.lines = on.lines.filter((l) => l.id !== lineId);
        if (this.picks.selection?.kind === "line" && this.picks.selection.id === lineId) this.picks.select(null);
      },
      next: (step) => {
        const to = neighbour(project!, pageId, kind, id, step);
        if (!to) return null;
        return () => {
          const index = pageIndex(project!, to.pageId);
          if (to.pageId !== pageId) this.stage.showPage(index + 1);
          this.picks.select({ kind: kind === "line" ? "line" : "panel", pageId: to.pageId, id: to.id });
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

  private sizing?: number;

  /** Alt+ホイール: the selected line's text larger or smaller, shown at once; one undo step a moment after. */
  private resizeText(step: number): boolean {
    const s = this.picks.selection;
    const project = this.host.project();
    const line = s?.kind === "line" ? project?.pages.find((p) => p.id === s.pageId)?.lines.find((l) => l.id === s.id) : undefined;
    if (!line) return false;
    const size = Math.min(72, Math.max(4, Math.round((line.fontSizePt + step) * 2) / 2));
    if (size === line.fontSizePt) return true;
    if (!this.host.inStep()) this.host.begin(); // One step for the turns (an undo in between ends it).
    window.clearTimeout(this.sizing);
    line.fontSizePt = size;
    setLineText(line, line.text);
    this.painter.draw();
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
    this.stage.wheel(event, project);
  }
}

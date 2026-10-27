// What the page editor's tools share: the selection and the app around the
// editor, the drags a tool starts, and the editor as a tool sees it
// (EditorCore). Each tool's press, drag and finish live in its own module
// (toolselect.ts, toolpen.ts, ...); editor.ts dispatches to them.
import type { Seam } from "./komaedit";
import type { Slot } from "./layout";
import type { Binding, BoxMm, Brush, EraseMode, FillTone, Page, Panel, Point, Project, RoughImage, Sticky, StrokePoint } from "./model";
import type { CarriedContents } from "./panels";
import type { SnapTargets } from "./snapping";
import type { ItemRef, TransformBase } from "./transform";

export type Tool = "select" | "cut" | "text" | "pen" | "eraser" | "fill" | "breakout" | "sticky" | "reference";

/** コマ割り: cut panels apart, draw a rectangle panel, or place the corners of any shape (台形 and the like). */
export type PanelMode = "cut" | "rect" | "polygon";

/** How the eraser works: CSP's three vector erasers, and 囲って消す. */
export type EditorEraseMode = EraseMode | "lasso";

export interface Selection {
  kind: "panel" | "line" | "stroke" | "breakout" | "group" | "sticky" | "fill";
  pageId: string;
  id: string;
  /** 範囲選択 ("group"): the things picked together (rough lines, dialogue, panels, fills, はみ出し). */
  items?: ItemRef[];
  /** A line's chosen しっぽ (its index in `tails`): Delete removes it rather than the line. */
  tail?: number;
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
  /** Buttons for the bar shown by the selection (most used actions, at hand). */
  actions(selection: Selection): HTMLElement[];
  /** Undo or redo (two- and three-finger taps, the pen's side button). */
  run(action: "undo" | "redo"): void;
  /** 連続: the spread worked on changed by touching a page of another one. */
  spreadChanged?(): void;
  /** 資料: the picture chosen with the 資料 tool changed. */
  referenceChanged?(): void;
}

export type TailPart = "tip" | "body" | "bend" | "root";

/** A tail of a line under the pointer. */
export interface TailHit {
  lineId: string;
  index: number;
  part: TailPart;
}

/** Panels being moved: snapped by their box as it was, moved by `total` (snapped) so far. */
export interface MoveSnap {
  origin: Point;
  box: BoxMm;
  total: Point;
  targets: SnapTargets;
}

/** Handles of the transform frame: corners from the top left clockwise, then the sides top, right, bottom, left; then the round one to turn. */
export const FRAME_HANDLES = 8;

/** A drag a tool started: what it changes as the pointer moves, until it is let go. */
export type ToolDrag =
  /** `snap`: panels being moved, from `origin` (their box then, and how far they have been moved so far). */
  | {
      kind: "move";
      slot: Slot;
      last: Point;
      moved: boolean;
      carried?: CarriedContents;
      items?: ItemRef[];
      cycle?: string;
      snap?: MoveSnap;
    }
  | {
      kind: "vertex";
      slot: Slot;
      panelId: string;
      vertex: number;
      moved: boolean;
      carried?: CarriedContents;
      targets: SnapTargets;
    }
  | { kind: "cut"; slot: Slot; a: Point; b: Point; free: boolean }
  | { kind: "frame"; slot: Slot; a: Point; b: Point; targets: SnapTargets }
  | {
      kind: "pen";
      slot: Slot;
      points: StrokePoint[];
      last: StrokePoint;
      motion: boolean;
      time: number;
      speed: number;
      straight: boolean;
    }
  /** しっぽ: its tip, its whole length (body), or its middle (bend); `created` when pulled out of the balloon. */
  | {
      kind: "tail";
      slot: Slot;
      lineId: string;
      index: number;
      moved: boolean;
      part: TailPart;
      start: Point;
      tip: Point;
      created?: boolean;
    }
  | { kind: "lasso"; slot: Slot; points: Point[] }
  | { kind: "fill"; slot: Slot; points: Point[] }
  | {
      kind: "pick";
      slot: Slot;
      points: Point[];
      add?: { base: ItemRef[]; target: ItemRef | null };
    }
  | { kind: "eraseLasso"; slot: Slot; points: Point[] }
  /** `last`: where the eraser was (on page `at`), to erase all the way between moves. */
  | { kind: "erase"; slot: Slot; erased: number; last?: Point; at?: number }
  | {
      kind: "swap";
      slot: Slot;
      panelId: string;
      at: [number, number];
      to: { slot: Slot; panelId: string } | null;
    }
  | {
      kind: "note";
      slot: Slot;
      panelId: string;
      start: [number, number];
      origin: Point;
      moved: boolean;
    }
  | { kind: "stickyLink"; slot: Slot; stickyId: string; to: Selection | null }
  | {
      kind: "seam";
      slot: Slot;
      seam: Seam;
      base: Map<string, Point[]>;
      start: Point;
      moved: boolean;
      carried: Map<string, CarriedContents>;
      targets: SnapTargets;
    }
  | {
      kind: "scale";
      slot: Slot;
      handle: number;
      base: TransformBase;
      box: BoxMm;
      moved: boolean;
      targets: SnapTargets;
    }
  /** 自由変形 (Ctrl + a corner): the corners of the frame, each where it was dragged. */
  | {
      kind: "warp";
      slot: Slot;
      handle: number;
      base: TransformBase;
      box: BoxMm;
      corners: [Point, Point, Point, Point];
      moved: boolean;
    }
  | {
      kind: "rotate";
      slot: Slot;
      base: TransformBase;
      centre: Point;
      start: number;
      moved: boolean;
    }
  /** 保留コマ laid in the 欄外: moved there (its box from `at`), or onto the page `to` to put it there. */
  | {
      kind: "held";
      slot: Slot;
      heldId: string;
      start: Point;
      at: Point;
      moved: boolean;
      to: Slot | null;
    }
  /** 資料画像: moved (corner -1) or resized from a corner, the opposite corner staying put. */
  | {
      kind: "reference";
      slot: Slot;
      id: string;
      corner: number;
      start: Point;
      box: BoxMm;
      moved: boolean;
    };

export type DragOf<K extends ToolDrag["kind"]> = Extract<ToolDrag, { kind: K }>;

/** Lines snapped to while dragging (page mm), shown as guides. */
export interface Guides {
  pageId: string;
  xs: number[];
  ys: number[];
}

/** A press on a page with a tool: where (screen px and page mm) and on which page. */
export interface Press {
  event: PointerEvent;
  project: Project;
  slot: Slot;
  /** On the page (mm). */
  point: Point;
  /** On the canvas (px). */
  sx: number;
  sy: number;
}

/** The pointer moved during a drag. */
export interface Move {
  event: PointerEvent;
  project: Project;
  /** On the page the drag began on (mm). */
  point: Point;
  /** On the canvas (px). */
  ex: number;
  ey: number;
}

/** How a kind of drag goes on and ends. `move` returns false when nothing is to be redrawn. */
export interface DragHandler<D extends ToolDrag> {
  move(editor: EditorCore, drag: D, at: Move): boolean | void;
  end(editor: EditorCore, drag: D, project: Project): void;
}

/** The page editor as its tools see it. */
export interface EditorCore {
  readonly host: EditorHost;
  /** The pages on screen. */
  readonly slots: readonly Slot[];
  readonly selection: Selection | null;
  /** Where the pointer is on the canvas (px). */
  readonly pointer: Point | null;
  /** 資料: the picture chosen with the 資料 tool. */
  readonly reference: { pageId: string; id: string } | null;
  readonly panelMode: PanelMode;
  readonly panelCarries: boolean;
  readonly balloonTextFollows: boolean;
  readonly eraseMode: EditorEraseMode;
  readonly fillTone: FillTone;
  readonly penWidthMm: number;
  /** The ラフ線のレイヤー the pen draws on. */
  readonly roughLayer: string;
  guides: Guides | null;

  /** Start a drag: it gets the pointer's moves until it is let go. */
  startDrag(drag: ToolDrag): void;
  /** Run once the pointer is up (opening a text field during the press would lose its focus). */
  afterUp(action: () => void): void;
  /** Pick the next of overlapping balloons a moment later (a double-click may still come). */
  pickLater(action: () => void, ms: number): void;
  select(selection: Selection | null): void;
  /** Change the selection without telling anyone (the drawing at the end of the drag shows it). */
  setSelection(selection: Selection | null): void;
  chooseReference(reference: { pageId: string; id: string } | null): void;
  forgetHover(): void;
  requestDraw(): void;
  requestOverlay(): void;
  /** Keep the pages as drawn now for a pen line to go over. */
  captureBase(): void;
  /** The pointer's point on the canvas (px). */
  at(event: MouseEvent): Point;
  slotAt(sx: number, sy: number, project: Project): Slot | null;
  facingSlot(slot: Slot): Slot | null;
  gutterOf(slot: Slot, facing: Slot): number;
  binding(): Binding;
  brush(kind: "pen" | "eraser"): Brush | undefined;
  eraserRadiusPx(scale: number): number;

  // What is where.
  hit(slot: Slot, point: Point): Selection | null;
  linesAt(slot: Slot, point: Point): string[];
  panelAt(page: Page, point: Point): Panel | undefined;
  vertexAt(slot: Slot, sx: number, sy: number): number;
  tailAt(slot: Slot, sx: number, sy: number): TailHit | null;
  badgeAt(slot: Slot, sx: number, sy: number, pageW: number): Panel | undefined;
  noteAt(slot: Slot, sx: number, sy: number): Panel | undefined;
  noteBox(slot: Slot, panel: Panel): { x: number; y: number; w: number; h: number };
  stickyHandle(slot: Slot, sticky: Sticky): Point;
  linkTarget(slot: Slot, point: Point): Selection | null;
  referenceCornerAt(slot: Slot, sx: number, sy: number): number;
  isSelected(page: Page, kind: Selection["kind"], id: string): boolean;
  groupHit(page: Page, point: Point, tolerance: number): boolean;
  selectedItems(): ItemRef[];
  frameHandleAt(sx: number, sy: number): number;
  frameGeometry(): { slot: Slot; box: BoxMm } | null;

  // Snapping.
  snapTargetsOn(project: Project, page: Page, exclude?: Iterable<string>): SnapTargets;
  snapped(slot: Slot, point: Point, targets: SnapTargets, free: boolean, beside?: readonly Point[]): Point;

  // Changes.
  moveSelection(page: Page, dx: number, dy: number, items?: ItemRef[]): void;
  /** Contents carried by the selected panel follow it. */
  follow(page: Page, carried: CarriedContents | undefined): void;
  carryToPageUnder(project: Project, slot: Slot): void;
  spanPanels(project: Project, pageId: string): number;
  addFreePanel(project: Project, page: Page, outline: Point[]): void;
  placeCorner(slot: Slot, point: Point, free: boolean): void;
  editInPlace(pageId: string, kind: "note" | "line", id: string, fresh?: boolean): void;
}

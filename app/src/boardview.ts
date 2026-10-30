// What the lanes of 物語の帯 share: the host they change the name through,
// the strip's view of the page axis (Board gives each lane a LaneView), and
// small helpers. Each lane is its own module (boardshape, boardscene,
// boardemotion, boardpages); board.ts puts them on one axis.
import { svg } from "./dom";
import type { Project } from "./model";

export interface StoryHost {
  project(): Project | null;
  /** Run `change` as one undoable step. */
  edit(change: (project: Project) => void): void;
  /** Show a page (1-based) on the canvas. */
  openPage(pageNumber: number): void;
  /** Select a panel on the canvas (its page comes into view). */
  selectPanel(pageId: string, panelId: string): void;
  /** Pages `first`..`last` dragged to before page `target`. */
  movePages(first: number, last: number, target: number): void;
  /** 別案 of pages `first`..`last` (0-based), to edit. */
  makeOption(first: number, last: number): void;
  /** Pages (1-based) on the canvas now. */
  currentPages(): number[];
  /** The strip's selection changed: the inspector shows it. */
  inspect(): void;
  /** Say what was done in the status bar. */
  status?(message: string): void;
}

/** What the strip itself selects; pages and panels are selected on the canvas. */
export type BoardSelection = { kind: "scene"; sceneId: string } | { kind: "shape" };

export interface BoardTip {
  show(event: MouseEvent, lines: string[]): void;
  hide(): void;
}

export type LaneId = "shape" | "scene" | "time" | "emotion" | "text";

/** Lane heights (px). */
export const RULER = 20;
export const SHAPE = 40;
export const SCENE = 32;
export const ROW = 18;
export const TEXT = 32;

/** The strip as a lane sees it: where pages are, and how to change and select. */
export interface LaneView {
  readonly host: StoryHost;
  readonly tip: BoardTip;
  /** Width of one page column, px. */
  readonly column: number;
  /** A press is being followed (hover tips wait). */
  readonly busy: boolean;
  /** Character whose emotion values the curve lane changes. */
  readonly character: string | null;
  /** Page pictures by page id, with what they were drawn from. */
  readonly thumbs: Map<string, { key: string; canvas: HTMLCanvasElement }>;
  /** The element the lanes are drawn in. */
  canvas(): HTMLDivElement | null;
  emotionHeight(): number;
  /** Pages run right to left (編集画面と同じ並び, 右綴じ). */
  readonly reversed: boolean;
  /** Where page boundary `boundary` (0 = before the first page, count = after the last) is, px. */
  x(boundary: number): number;
  /** Left edge of page `index`'s column, px. */
  cell(index: number): number;
  /** Left edge and width of pages `first`..`last`, px. */
  span(first: number, last: number): { left: number; width: number };
  /** Width of all the pages, px. */
  width(): number;
  /** Page column under a pointer (clamped), and the nearest page boundary. */
  at(event: MouseEvent): { index: number; boundary: number; x: number };
  /** First or last page of a scene whose edge is dragged to the boundary nearest the pointer. */
  edgeIndex(event: MouseEvent, edge: "first" | "last"): number;
  /** One undoable step. */
  edit(change: (project: Project) => void): void;
  /** Hold renders while a press is followed; `release` draws what waited. */
  hold(): void;
  release(): void;
  select(selection: BoardSelection | null): void;
  /** A scene picked in the strip: its first page comes up unless the canvas is already in it. */
  selectScene(span: { scene: { id: string }; first: number; last: number }): void;
  /** Set what is selected without drawing (inside an edit, which draws). */
  setSelection(selection: BoardSelection | null): void;
  /** A vertical marker over all lanes (where a drag would put things). */
  mark(kind: string): HTMLDivElement;
  placeMark(marker: HTMLDivElement, x: number): void;
}

export const ICONS: Record<LaneId | "fit" | "wide" | "narrow" | "fold" | "unfold" | "help", string> = {
  shape: '<rect x="2" y="6.5" width="5" height="7" rx="1.2" class="fill"/><rect x="8" y="6.5" width="4" height="7" rx="1.2"/><rect x="13" y="6.5" width="5" height="7" rx="1.2" class="fill"/>',
  scene: '<rect x="2" y="6" width="7.5" height="8" rx="2.5"/><rect x="11" y="6" width="7" height="8" rx="2.5"/>',
  time: '<path d="M2.5 4.5h6M7 10h6M11.5 15.5h6"/><path d="M8.5 4.5L7 10M13 10l-1.5 5.5" stroke-dasharray="1.5 1.5"/>',
  emotion: '<path d="M2.5 14c3 0 3-9 6-9s3 10 6 10 2-6 3-6"/>',
  text: '<rect x="3" y="11" width="3" height="6"/><rect x="8.5" y="6" width="3" height="11"/><rect x="14" y="3" width="3" height="14"/>',
  fit: '<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/>',
  wide: '<path d="M10 16V4M5 9l5-5 5 5"/>',
  narrow: '<path d="M10 4v12M5 11l5 5 5-5"/>',
  fold: '<path d="M4 7l6 6 6-6"/><path d="M4 16h12"/>',
  unfold: '<path d="M4 13l6-6 6 6"/><path d="M4 4h12"/>',
  help: '<circle cx="10" cy="10" r="7.5"/><path d="M7.8 7.8a2.3 2.3 0 1 1 3.2 2.1c-.7.3-1 .8-1 1.5v.6"/><circle cx="10" cy="14.6" r=".6" class="fill"/>',
};


export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const node = svg("svg", { viewBox: "0 0 20 20", class: "icon", "aria-hidden": "true" });
  node.innerHTML = ICONS[name];
  return node;
}

export /** Follow a press until it is let go; `moved` turns true past a few pixels. */
function track(
  down: PointerEvent,
  target: Element,
  handlers: { move?: (event: PointerEvent, moved: boolean) => void; end: (event: PointerEvent, moved: boolean) => void },
): void {
  const [sx, sy] = [down.clientX, down.clientY];
  let moved = false;
  try {
    target.setPointerCapture(down.pointerId);
  } catch {
    // Synthetic events have no pointer to capture.
  }
  const move = (event: Event) => {
    const e = event as PointerEvent;
    if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) > 4) moved = true;
    handlers.move?.(e, moved);
  };
  const end = (event: Event) => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    handlers.end(event as PointerEvent, moved && event.type === "pointerup");
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
}

export function diamond(cx: number, cy: number, r: number): string {
  return `M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z`;
}

export function clip(text: string, length: number): string {
  if (length <= 1) return "";
  return [...text].length > length ? `${[...text].slice(0, length - 1).join("")}…` : text;
}

export function formatValue(value: number): string {
  return value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
}

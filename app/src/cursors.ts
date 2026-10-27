// The page editor's mouse cursor: each tool's own, the eraser's (a ring is
// drawn instead), and with the select tool what a press would do where the
// pointer is (move, drag a seam, a handle of the transform frame).
import { FRAME_HANDLES, type Tool } from "./editorcore";
import type { Seam } from "./komaedit";

const DOT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><circle cx="4.5" cy="4.5" r="2" fill="#222" stroke="#fff" stroke-width="1"/></svg>')}") 4 4, crosshair`;

const CURSORS: Record<Tool, string> = {
  select: "default",
  cut: "crosshair",
  text: "text",
  pen: "crosshair",
  mark: "crosshair",
  eraser: "none",
  fill: "crosshair",
  breakout: "crosshair",
  sticky: "copy",
  reference: "default",
};

/** What the select tool would do under the pointer. */
export type HoverLook = { kind: "seam"; seam: Seam } | { kind: "handle"; handle: number } | { kind: "tail"; part: string } | { kind: "item" };

export interface CursorState {
  tool: Tool;
  /** Space held: the view is dragged. */
  panning: boolean;
  /** The eraser (or the pen's eraser end, or the 指示 tool erasing) is in hand. */
  erasing: boolean;
  lasso: boolean;
  hover: HoverLook | null;
  /** How the pen shows: as its brush (drawn), a dot or a cross. */
  penLook: string;
}

export function editorCursor(state: CursorState): string {
  if (state.panning) return "grab";
  if (state.erasing) return state.lasso ? "crosshair" : "none";
  if (state.tool === "select" && state.hover) return hoverCursor(state.hover);
  // The 指示 pen has no brush to show: a dot or a cross.
  if (state.tool === "pen" || state.tool === "mark") return state.penLook === "dot" ? DOT_CURSOR : state.penLook === "brush" && state.tool === "pen" ? "none" : "crosshair";
  return CURSORS[state.tool];
}

function hoverCursor(hover: HoverLook): string {
  if (hover.kind === "seam") return seamCursor(hover.seam);
  if (hover.kind === "handle") return handleCursor(hover.handle);
  return hover.kind === "tail" && (hover.part === "bend" || hover.part === "root") ? "grab" : "move";
}

function seamCursor(seam: Seam): string {
  const [nx, ny] = seam.normal;
  if (Math.abs(ny) > 2 * Math.abs(nx)) return "ns-resize";
  if (Math.abs(nx) > 2 * Math.abs(ny)) return "ew-resize";
  return nx * ny > 0 ? "nwse-resize" : "nesw-resize";
}

function handleCursor(handle: number): string {
  return handle === FRAME_HANDLES ? "grab" : ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize", "ns-resize", "ew-resize", "ns-resize", "ew-resize"][handle];
}

// 欄外 with the tools: a press off every page is for the page nearest it
// (the pen sketches there, the eraser erases, 付箋 and 資料画像 go there, the
// select tool picks what lies there), and the held panels laid there are
// dragged about, or onto a page to put them on it.
import { heldBox } from "./aside";
import { heldAt } from "./asidedraw";
import type { DragHandler, DragOf, EditorCore, Tool } from "./editorcore";
import { placeHeld } from "./hold";
import { nearestSlot, toPage, type Slot } from "./layout";
import type { Point, Project } from "./model";
import { referenceAt } from "./references";

/** The tools that work in the 欄外. */
const ASIDE_TOOLS: ReadonlySet<Tool> = new Set<Tool>(["select", "pen", "eraser", "sticky", "reference"]);

/**
 * The page a press off every page is for: the one whose 欄外 has what is
 * under the point (nearest first), else the nearest; null for the tools
 * that only work on a page.
 */
export function asideSlot(editor: EditorCore, tool: Tool, project: Project, sx: number, sy: number): Slot | null {
  if (!ASIDE_TOOLS.has(tool)) {
    editor.host.status("ページの外（欄外）には、ペン・消しゴム・付箋・資料画像と保留のコマを置けます");
    return null;
  }
  const nearest = nearestSlot(editor.slots, project.pageFormat, [sx, sy]);
  const byDistance = nearest ? [nearest, ...editor.slots.filter((slot) => slot !== nearest)] : [];
  const under = (slot: Slot) => {
    const point = toPage(slot, sx, sy);
    return tool === "reference" ? !!referenceAt(slot.page, point) : tool === "select" || tool === "sticky" ? !!editor.hit(slot, point) : false;
  };
  return byDistance.find(under) ?? nearest;
}

/** The select tool on a held panel laid beside a page: pick it up to move. */
export function pressHeld(editor: EditorCore, project: Project, sx: number, sy: number): boolean {
  const found = heldAt(project, editor.slots, sx, sy);
  if (!found?.held.at) return false;
  editor.select(null);
  editor.startDrag({
    kind: "held",
    slot: found.slot,
    heldId: found.held.id,
    start: toPage(found.slot, sx, sy),
    at: [...found.held.at] as Point,
    moved: false,
    to: null,
  });
  return true;
}

/** The page under a screen point (on it, not just near), if any. */
function pageUnder(editor: EditorCore, project: Project, [sx, sy]: Point): Slot | null {
  const pageH = project.pageFormat.canvasMm[1];
  return (
    editor.slots.find((slot) => {
      const [x, y] = toPage(slot, sx, sy);
      return x >= slot.shown[0] && x < slot.shown[1] && y >= 0 && y < pageH;
    }) ?? null
  );
}

const held: DragHandler<DragOf<"held">> = {
  move(editor, drag, { project, point, ex, ey }) {
    const held = project.held?.find((h) => h.id === drag.heldId);
    if (!held?.at) return false;
    if (!drag.moved) {
      if (Math.hypot(point[0] - drag.start[0], point[1] - drag.start[1]) * drag.slot.scale < 3) return false;
      editor.host.begin();
      drag.moved = true;
    }
    held.at = [drag.at[0] + point[0] - drag.start[0], drag.at[1] + point[1] - drag.start[1]];
    drag.to = pageUnder(editor, project, [ex, ey]);
  },
  end(editor, drag, project) {
    const held = project.held?.find((h) => h.id === drag.heldId);
    if (!drag.moved || !held) {
      editor.host.status("保留のコマです。ページへドラッグすると置けます（コマの上で離すと中身をそのコマへ）。欄外の中なら好きな所へ動かせます");
      return;
    }
    const pointer = editor.pointer;
    const on = pointer && pageUnder(editor, project, pointer);
    if (on && pointer) {
      // On a page: there, or into the panel under the pointer.
      const into = editor.panelAt(on.page, toPage(on, ...pointer));
      const box = heldBox(held)!;
      const centre = toPage(on, drag.slot.x + ((box[0] + box[2]) / 2) * drag.slot.scale, drag.slot.y + ((box[1] + box[3]) / 2) * drag.slot.scale);
      delete held.at;
      const panel = placeHeld(project, on.page, held, centre, into);
      editor.host.commit();
      editor.select({ kind: "panel", pageId: on.page.id, id: panel.id });
      editor.host.status(into ? `保留のコマの中身を ${on.index + 1} ページのコマ ${panel.order} に入れました` : `保留のコマを ${on.index + 1} ページに置きました（コマ ${panel.order}）`);
      return;
    }
    // Still in the 欄外: it belongs to the page it now lies nearest.
    const box = heldBox(held)!;
    const centre: Point = [drag.slot.x + ((box[0] + box[2]) / 2) * drag.slot.scale, drag.slot.y + ((box[1] + box[3]) / 2) * drag.slot.scale];
    const home = nearestSlot(editor.slots, project.pageFormat, centre);
    if (home && home !== drag.slot) {
      held.near = home.page.id;
      held.at = toPage(home, drag.slot.x + box[0] * drag.slot.scale, drag.slot.y + box[1] * drag.slot.scale);
    }
    editor.host.commit();
  },
};

export const ASIDE_DRAGS = { held };

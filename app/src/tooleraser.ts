// The eraser: CSP's vector erasers (触れた部分, 交点まで, 線全体) along the
// drag, going on across the gutter onto the facing page; 囲って消す erases
// what is inside the outline drawn.
import type { DragHandler, DragOf, EditorCore, Press } from "./editorcore";
import { nearestSlot, toPage, type Slot } from "./layout";
import type { Point } from "./model";
import { eraseInside, eraseWith } from "./strokes";
import { strokeEditable } from "./roughlayers";

export function pressEraser(editor: EditorCore, { slot, point }: Press): void {
  if (editor.eraseMode === "lasso") {
    editor.startDrag({ kind: "eraseLasso", slot, points: [point] });
    return;
  }
  editor.host.begin();
  const drag: DragOf<"erase"> = { kind: "erase", slot, erased: 0 };
  editor.startDrag(drag);
  erase(editor, drag, slot, point);
}

function erase(editor: EditorCore, drag: DragOf<"erase">, slot: Slot, point: Point): void {
  const project = editor.host.project();
  if (!project) return;
  const mode = editor.eraseMode === "lasso" ? "whole" : editor.eraseMode;
  const radius = editor.eraserRadiusPx(slot.scale) / slot.scale;
  // A quick move skips past thin lines: erase along the way, a radius at a time.
  const from = drag.last && drag.at === slot.index ? drag.last : point;
  const steps = Math.min(64, Math.max(1, Math.ceil(Math.hypot(point[0] - from[0], point[1] - from[1]) / radius)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const along: Point = [from[0] + (point[0] - from[0]) * t, from[1] + (point[1] - from[1]) * t];
    drag.erased += eraseWith(project, slot.page, along, radius, mode, (stroke) => strokeEditable(project, stroke));
  }
  drag.last = point;
  drag.at = slot.index;
}

const eraseDrag: DragHandler<DragOf<"erase">> = {
  move(editor, drag, { project, ex, ey }) {
    // The eraser goes on across the gutter onto the facing page, and in the 欄外 of the page nearest.
    const under = editor.slotAt(ex, ey, project) ?? nearestSlot(editor.slots, project.pageFormat, [ex, ey]) ?? drag.slot;
    erase(editor, drag, under, toPage(under, ex, ey));
  },
  end(editor, drag) {
    if (drag.erased) editor.host.commit();
    else editor.host.cancel();
  },
};

const eraseLasso: DragHandler<DragOf<"eraseLasso">> = {
  move(_editor, drag, { point }) {
    drag.points.push(point);
  },
  end(editor, drag, project) {
    editor.host.begin();
    const changed = eraseInside(project, drag.slot.page, drag.points, (stroke) => strokeEditable(project, stroke));
    if (changed) {
      editor.host.commit();
      editor.host.status(`囲んだ中の線を消しました（${changed} 本）`);
    } else {
      editor.host.cancel();
    }
  },
};

export const ERASER_DRAGS = { erase: eraseDrag, eraseLasso };

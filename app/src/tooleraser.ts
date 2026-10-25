// The eraser: CSP's vector erasers (触れた部分, 交点まで, 線全体) along the
// drag, going on across the gutter onto the facing page; 囲って消す erases
// what is inside the outline drawn.
import type { DragHandler, DragOf, EditorCore, Press } from "./editorcore";
import { toPage, type Slot } from "./layout";
import { eraseInside, eraseWith, type Point } from "./project";

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
  drag.erased += eraseWith(project, slot.page, point, editor.eraserRadiusPx(slot.scale) / slot.scale, mode);
}

const eraseDrag: DragHandler<DragOf<"erase">> = {
  move(editor, drag, { project, ex, ey }) {
    // The eraser goes on across the gutter onto the facing page.
    const under = editor.slotAt(ex, ey, project) ?? drag.slot;
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
    const changed = eraseInside(project, drag.slot.page, drag.points);
    if (changed) {
      editor.host.commit();
      editor.host.status(`囲んだ中の線を消しました（${changed} 本）`);
    } else {
      editor.host.cancel();
    }
  },
};

export const ERASER_DRAGS = { erase: eraseDrag, eraseLasso };

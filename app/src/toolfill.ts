// Tools that take an outline drawn around something: 投げなわ塗り (a fill in
// the chosen tone) and はみ出し (where the drawing goes over the panel borders).
import type { DragHandler, DragOf, Press, EditorCore } from "./editorcore";
import { addBreakout } from "./koma";
import { addFill, bounds, simplify, type Point } from "./project";

export function pressFill(editor: EditorCore, { slot, point }: Press): void {
  editor.startDrag({ kind: "fill", slot, points: [point] });
}

export function pressBreakout(editor: EditorCore, { slot, point }: Press): void {
  editor.startDrag({ kind: "lasso", slot, points: [point] });
}

/** The outline drawn, without the jitter of the hand (`tolerance` mm). */
function outline(points: readonly Point[], tolerance: number): Point[] {
  return simplify(
    points.map(([x, y]) => [x, y, 1] as [number, number, number]),
    tolerance,
  ).map(([x, y]) => [x, y] as Point);
}

const fill: DragHandler<DragOf<"fill">> = {
  move(_editor, drag, { point }) {
    drag.points.push(point);
  },
  end(editor, drag, project) {
    const shape = outline(drag.points, 0.4);
    const box = bounds(shape);
    if (shape.length < 3 || box[2] - box[0] < 1 || box[3] - box[1] < 1) {
      editor.host.status("塗る所を囲むようにドラッグしてください");
      return;
    }
    editor.host.begin();
    addFill(project, drag.slot.page, shape, editor.fillTone);
    editor.host.commit();
  },
};

const lasso: DragHandler<DragOf<"lasso">> = {
  move(_editor, drag, { point }) {
    drag.points.push(point);
  },
  end(editor, drag, project) {
    const shape = outline(drag.points, 0.8);
    const box = bounds(shape);
    if (shape.length < 3 || box[2] - box[0] < 4 || box[3] - box[1] < 4) {
      editor.host.status("はみ出しにする所を囲むようにドラッグしてください");
      return;
    }
    editor.host.begin();
    const breakout = addBreakout(project, drag.slot.page, shape);
    editor.host.commit();
    editor.select({
      kind: "breakout",
      pageId: drag.slot.page.id,
      id: breakout.id,
    });
    editor.host.status("はみ出しを作りました。中でペンを描き始めると、コマ枠の上に描かれます");
  },
};

export const FILL_DRAGS = { fill, lasso };

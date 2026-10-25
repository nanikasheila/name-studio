// 資料: a picture on the page (a photo, a background to draw over), chosen,
// moved, or resized from a corner (the opposite corner staying put).
import type { DragHandler, DragOf, EditorCore, Press } from "./editorcore";
import { referenceAt, resizeBox } from "./references";

export function pressReference(editor: EditorCore, { slot, point, sx, sy }: Press): void {
  // A corner of the chosen picture resizes it; a picture moves; elsewhere nothing is chosen.
  const corner = editor.referenceCornerAt(slot, sx, sy);
  const hit = corner >= 0 ? slot.page.references?.find((r) => r.id === editor.reference?.id) : referenceAt(slot.page, point);
  if (!hit) {
    editor.chooseReference(null);
    return;
  }
  if (editor.reference?.id !== hit.id) editor.chooseReference({ pageId: slot.page.id, id: hit.id });
  editor.startDrag({
    kind: "reference",
    slot,
    id: hit.id,
    corner,
    start: point,
    box: [...hit.box],
    moved: false,
  });
}

const reference: DragHandler<DragOf<"reference">> = {
  move(editor, drag, { point }) {
    const reference = drag.slot.page.references?.find((r) => r.id === drag.id);
    if (!reference) return false;
    if (!drag.moved) {
      if (Math.hypot(point[0] - drag.start[0], point[1] - drag.start[1]) * drag.slot.scale < 3) return false;
      editor.host.begin();
      drag.moved = true;
    }
    const [dx, dy] = [point[0] - drag.start[0], point[1] - drag.start[1]];
    const [x0, y0, x1, y1] = drag.box;
    reference.box = drag.corner < 0 ? [x0 + dx, y0 + dy, x1 + dx, y1 + dy] : resizeBox(drag.box, drag.corner, point);
  },
  end(editor, drag) {
    if (drag.moved) editor.host.commit();
  },
};

export const REFERENCE_DRAGS = { reference };

// コマ割り: a line drawn across panels cuts them apart (割る); a box drawn
// makes a panel (四角, or off the panels); 多角形 places corners one by one.
import type { DragHandler, DragOf, EditorCore, Press } from "./editorcore";
import { bounds, insidePolygon, rectShape } from "./geometry";
import { snapCut } from "./pagebox";
import { cutPanels } from "./panels";
import { sortLines } from "./readingorder";

export function pressCut(editor: EditorCore, { event, project, slot, point }: Press): void {
  if (editor.panelMode === "polygon") {
    editor.placeCorner(slot, point, event.altKey);
    return;
  }
  const inPanel = slot.page.panels.some((panel) => insidePolygon(panel.shape, point));
  // 四角, or (割る) a drag off the panels or with Shift: a new panel there.
  const framing = editor.panelMode === "rect" || !slot.page.panels.length || (!inPanel && event.shiftKey);
  if (framing) {
    const targets = editor.snapTargetsOn(project, slot.page);
    const a = editor.snapped(slot, point, targets, event.altKey);
    editor.startDrag({ kind: "frame", slot, a, b: a, targets });
    return;
  }
  editor.startDrag({
    kind: "cut",
    slot,
    a: point,
    b: point,
    free: event.altKey,
  });
}

const cut: DragHandler<DragOf<"cut">> = {
  move(_editor, drag, { event, point }) {
    drag.b = point;
    drag.free = event.altKey;
  },
  end(editor, drag, project) {
    const b = drag.free ? drag.b : snapCut(drag.a, drag.b);
    if (Math.hypot(b[0] - drag.a[0], b[1] - drag.a[1]) < 3) return;
    editor.host.begin();
    const created = cutPanels(project, drag.slot.page, drag.a, b);
    if (created.length) {
      sortLines(drag.slot.page, editor.binding());
      editor.host.commit();
      editor.host.status(`コマを ${created.length} か所で分けました`);
    } else {
      editor.host.cancel();
      editor.host.status("コマを横切るように線を引いてください");
    }
  },
};

const frame: DragHandler<DragOf<"frame">> = {
  move(editor, drag, { event, point }) {
    drag.b = editor.snapped(drag.slot, point, drag.targets, event.altKey);
  },
  end(editor, drag, project) {
    const box = bounds([drag.a, drag.b]);
    if (box[2] - box[0] < 5 || box[3] - box[1] < 5) {
      editor.host.status("コマにするには、もう少し大きく囲んでください");
      return;
    }
    editor.addFreePanel(project, drag.slot.page, rectShape(box));
  },
};

export const PANEL_DRAGS = { cut, frame };

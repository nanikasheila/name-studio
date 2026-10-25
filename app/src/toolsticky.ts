// 付箋: a note put on a page (tied to the panel or line clicked), moved with
// the select or 付箋 tool; its round handle dragged onto a panel or a line
// ties it there.
import type { DragHandler, DragOf, EditorCore, Press } from "./editorcore";
import type { Slot } from "./layout";
import { toPage } from "./layout";
import { addSticky, linkSticky } from "./project";

export function pressSticky(editor: EditorCore, { project, slot, point, sx, sy }: Press): void {
  if (startStickyLink(editor, slot, sx, sy)) return;
  // On a note: pick it up to move; elsewhere: a new note there, tied to the panel or line clicked.
  const hit = editor.hit(slot, point);
  if (hit?.kind === "sticky") {
    editor.select(hit);
    editor.host.begin();
    editor.startDrag({ kind: "move", slot, last: point, moved: false });
    return;
  }
  editor.host.begin();
  const about = editor.linkTarget(slot, point);
  // Tied to something: the note beside it, pointing back (as a comment in a spreadsheet).
  const sticky = addSticky(project, slot.page, about ? [point[0] + 10, point[1] - 14] : point);
  if (about) linkSticky(slot.page, sticky, about.kind as "panel" | "line", about.id, point);
  editor.host.commit();
  editor.select({ kind: "sticky", pageId: slot.page.id, id: sticky.id });
  editor.host.status(
    about
      ? "付箋を貼りました。クリックした所に紐づいています。付箋は好きな所へ動かせます（丸をドラッグで付け替え）"
      : "付箋を貼りました。右の欄に書けます（書き出しには入りません）。丸をコマやセリフへドラッグすると紐づきます",
  );
}

/** On the selected 付箋's link handle: start dragging it to what the note is about. */
export function startStickyLink(editor: EditorCore, slot: Slot, sx: number, sy: number): boolean {
  const s = editor.selection;
  if (s?.kind !== "sticky" || s.pageId !== slot.page.id) return false;
  const sticky = slot.page.stickies?.find((n) => n.id === s.id);
  if (!sticky) return false;
  const [hx, hy] = editor.stickyHandle(slot, sticky);
  if (Math.hypot(hx - sx, hy - sy) > LINK_HANDLE + 4) return false;
  editor.startDrag({ kind: "stickyLink", slot, stickyId: sticky.id, to: null });
  return true;
}

/** Radius of a 付箋's link handle (px). */
export const LINK_HANDLE = 5;

const stickyLink: DragHandler<DragOf<"stickyLink">> = {
  move(editor, drag, { point }) {
    drag.to = editor.linkTarget(drag.slot, point);
    editor.requestOverlay();
    return false;
  },
  end(editor, drag) {
    const sticky = drag.slot.page.stickies?.find((n) => n.id === drag.stickyId);
    if (!sticky || !editor.pointer) return;
    const point = toPage(drag.slot, editor.pointer[0], editor.pointer[1]);
    const to = editor.linkTarget(drag.slot, point);
    if (!to && !sticky.link) return;
    editor.host.begin();
    if (to) linkSticky(drag.slot.page, sticky, to.kind as "panel" | "line", to.id, point);
    else delete sticky.link;
    editor.host.commit();
    editor.host.status(to ? `付箋を${to.kind === "panel" ? "コマ" : "セリフ"}に紐づけました` : "付箋の紐づけを外しました");
  },
};

export const STICKY_DRAGS = { stickyLink };

// The text tool: a click writes straight onto the page, in the line clicked
// or in a new one there.
import type { EditorCore, Press } from "./editorcore";
import { addLine } from "./dialogue";

export function pressText(editor: EditorCore, { project, slot, point }: Press): void {
  const hit = editor.hit(slot, point);
  if (hit?.kind === "line") {
    editor.select(hit);
    editor.afterUp(() => editor.editInPlace(slot.page.id, "line", hit.id));
    return;
  }
  // Placing the line and writing in it are one step: Esc in the field takes the line away.
  editor.host.begin();
  const line = addLine(project, slot.page, point);
  editor.select({ kind: "line", pageId: slot.page.id, id: line.id });
  editor.afterUp(() => editor.editInPlace(slot.page.id, "line", line.id, true));
}

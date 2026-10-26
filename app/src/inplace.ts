// Writing on the page itself: a panel's memo or a line of dialogue in a field
// laid over the page, where it is. The page follows each key; Ctrl+Enter or a
// click elsewhere keeps it (one undo step), Esc puts it back.
import { setLineText, wrapTypedLine } from "./dialogue";
import { canvasFont, lineBold, lineFont } from "./fonts";
import { bounds } from "./geometry";
import type { Slot } from "./layout";
import type { Line, Panel, Point } from "./model";
import { NOTE_FONT, NOTE_ROW } from "./notedraw";
import { MM_PER_PT } from "./project";
import { linePitch } from "./style";

/** A field open on the page. */
export interface InPlaceEdit {
  field: HTMLTextAreaElement;
  /** Lay the field over its text again (the view moved). */
  place(): void;
  /** Close it, keeping what was written or not. */
  finish(keep: boolean): void;
}

/** What writing in place needs from the page editor. */
export interface InPlaceHost {
  begin(): void;
  commit(): void;
  cancel(): void;
  status(message: string): void;
  draw(): void;
  /** Where the page is on screen now (undefined when it is not shown). */
  slotOf(pageId: string): Slot | undefined;
  /** Where a panel's memo tag is on screen. */
  noteAt(slot: Slot, panel: Panel): { x: number; y: number };
  /** Where a point of the upright view shows on screen (the view may be turned). */
  onScreen(point: Point): Point;
  /** The field is about to show; `closed` when it goes. */
  opened(edit: InPlaceEdit): void;
  closed(edit: InPlaceEdit): void;
}

/** Opens a field over `panel`'s memo or over `line` on the page `pageId`, inside `container`. */
export function writeInPlace(host: InPlaceHost, container: HTMLElement, pageId: string, target: { panel: Panel } | { line: Line }): void {
  const panel = "panel" in target ? target.panel : undefined;
  const line = "line" in target ? target.line : undefined;
  const field = document.createElement("textarea");
  field.className = `inline-edit ${panel ? "note" : "line"}`;
  field.spellcheck = false;
  const original = (panel ? panel.note : line!.text) ?? "";
  field.value = original;
  if (panel) field.placeholder = "このコマのメモ（狙い・演出・直したいこと）";
  const apply = (value: string) => {
    if (panel) {
      if (value.trim()) panel.note = value;
      else delete panel.note;
    } else if (line) {
      setLineText(line, value);
    }
  };
  const place = () => {
    const slot = host.slotOf(pageId);
    if (!slot) return;
    const style = field.style;
    if (panel) {
      const { x, y } = host.noteAt(slot, panel);
      const [x0, , x1] = bounds(panel.shape);
      const [left, top] = host.onScreen([x, y]);
      style.left = `${left}px`;
      style.top = `${top}px`;
      style.width = `${Math.max(180, Math.min((x1 - x0) * slot.scale - 8, 320))}px`;
      style.height = `${NOTE_ROW * 4 + 8}px`;
      style.font = NOTE_FONT;
      style.writingMode = "horizontal-tb";
    } else if (line) {
      const [x0, y0, x1] = line.box;
      // Never smaller than can be read, even when the page is shown small.
      const size = Math.max(line.fontSizePt * MM_PER_PT * slot.scale, 12);
      const pad = 6;
      style.font = canvasFont(lineFont(line), size, lineBold(line));
      style.writingMode = line.vertical ? "vertical-rl" : "horizontal-tb";
      const rows = field.value.replace(/\r\n?/g, "\n").split("\n");
      const longest = Math.max(1, ...rows.map((row) => [...row].length));
      // Room for one more character and one more row, so the caret is never squeezed.
      const across = (rows.length + 1) * size * linePitch() + 2 * pad;
      const along = (longest + 1) * size + 2 * pad;
      const [w, h] = line.vertical ? [across, along] : [along, across];
      // Vertical text starts at the right, as it is read.
      const [ax, ay] = host.onScreen([line.vertical ? slot.x + x1 * slot.scale + pad : slot.x + x0 * slot.scale - pad, slot.y + y0 * slot.scale - pad]);
      style.left = `${line.vertical ? ax - w : ax}px`;
      style.top = `${ay}px`;
      style.width = `${w}px`;
      style.height = `${h}px`;
      style.lineHeight = String(linePitch());
    }
  };
  host.begin();
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    host.closed(edit);
    if (!keep) apply(original);
    // A long line typed in one go: broken into short lines.
    else if (line && field.value !== original) wrapTypedLine(line);
    field.remove();
    if (keep && field.value !== original) {
      host.commit();
      host.status(panel ? "コマのメモを書きました" : "セリフを直しました");
    } else {
      host.cancel();
      host.status("");
    }
    host.draw();
  };
  const edit: InPlaceEdit = { field, place, finish };
  field.addEventListener("input", () => {
    apply(field.value);
    host.draw();
  });
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      finish(true);
    }
  });
  field.addEventListener("blur", () => finish(true));
  host.opened(edit);
  container.append(field);
  place();
  field.focus();
  if (line && line.text === "セリフ") field.select();
  host.status(
    panel ? "コマのメモを書いています（Ctrl+Enter かほかを押すと決定、Esc でやめる）" : "セリフを書いています（改行で行を分ける。Ctrl+Enter かほかを押すと決定、Esc でやめる）",
  );
}

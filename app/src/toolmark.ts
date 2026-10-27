// 指示: notes and instructions scribbled straight onto the name for whoever
// inks it (背景・効果・トーンの指定、直し), in colour on a 指示のレイヤー over
// everything. The tool draws with a plain pen, quick and as the hand moves
// (no brush, no 手ブレ補正); its eraser (the 消す button, or the pen's
// eraser end) erases 指示 only, as the eraser erases all but them.
import type { EditorCore, Press } from "./editorcore";
import { penPreferences } from "./prefs";
import { markColor, markLayersOf, MARK_COLORS } from "./roughlayers";
import { readNumber, writeNumber } from "./settings";
import { pressEraser } from "./tooleraser";
import { startLine } from "./toolpen";

const WIDTH_KEY = "namestudio.markWidth";
export const MARK_WIDTH_MM = 0.6;

/** The 指示 tool's state, shared by its bar and the editor. */
export const markPen = {
  /** The 指示のレイヤー drawn on ("": the top one). */
  layer: "",
  widthMm: readNumber(WIDTH_KEY, MARK_WIDTH_MM, 0.1, 10),
  /** 消す: the tool erases 指示 rather than drawing them. */
  erase: false,
};

export function setMarkWidth(mm: number): void {
  markPen.widthMm = Math.min(10, Math.max(0.1, Math.round(mm * 100) / 100));
  writeNumber(WIDTH_KEY, markPen.widthMm);
}

export function pressMark(editor: EditorCore, press: Press): void {
  const { event, project } = press;
  const tipEraser = penPreferences.settings.eraserEnd && (event.button === 5 || (event.buttons & 32) !== 0);
  if (markPen.erase || tipEraser) return pressEraser(editor, press, true);
  const marks = markLayersOf(project);
  const layer = marks.find((one) => one.id === markPen.layer) ?? marks[marks.length - 1];
  if (layer?.locked) {
    editor.host.status(`指示のレイヤー「${layer.name}」はロックしています。レイヤーの欄でロックを外すか、ほかの色を選んでください`);
    return;
  }
  startLine(editor, press, { color: layer ? markColor(layer) : MARK_COLORS[0], widthMm: markPen.widthMm, layer: layer?.id ?? "" });
}

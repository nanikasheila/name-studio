// 背景の指示: the 背景 tool marks what a panel's background should be, for
// whoever draws it (an AI asked from 相談 among them): アイレベル (drag a line,
// or click for a level one), 消失点 (click; it may lie beyond the panel), 物
// (drag a box round where a thing stands; it gets the name in the bar), and
// 消す (click near one). Each goes to the panel under the pointer, else the
// one marked last on that page, else the nearest.
import type { DragHandler, DragOf, EditorCore, Press } from "./editorcore";
import type { Page, Panel, Point } from "../model/model";
import { bounds } from "../model/geometry";
import { panelAt } from "../editing/hittest";
import { addObject, addVanishing, removeInstructionAt, setHorizon } from "../domain/background";

export type BackgroundMode = "horizon" | "vanishing" | "object" | "erase";

export const BACKGROUND_MODE_LABELS: Record<BackgroundMode, string> = {
  horizon: "アイレベル",
  vanishing: "消失点",
  object: "物",
  erase: "消す",
};

/** The 背景 tool's state, shared by its bar, the editor and the 背景 palette. */
export const backgroundPen = {
  mode: "horizon" as BackgroundMode,
  /** The name the next 物 gets. */
  label: "",
  /** The panel marked last (vanishing points beyond a panel go to it). */
  panel: "",
  /** 背景の指示 shown with any tool (else with the 背景 tool only). */
  alwaysShown: false,
};

/** The panel an instruction at `point` goes to. */
export function targetPanel(page: Page, point: Point): Panel | undefined {
  const under = panelAt(page, point);
  if (under) return under;
  const last = page.panels.find((panel) => panel.id === backgroundPen.panel);
  if (last) return last;
  const distance = (panel: Panel) => {
    const [x0, y0, x1, y1] = bounds(panel.shape);
    return Math.hypot(Math.max(x0 - point[0], 0, point[0] - x1), Math.max(y0 - point[1], 0, point[1] - y1));
  };
  return [...page.panels].sort((a, b) => distance(a) - distance(b))[0];
}

export function pressBackground(editor: EditorCore, { slot, point }: Press): void {
  const panel = targetPanel(slot.page, point);
  if (!panel) {
    editor.host.status("背景の指示はコマに付けます。先にコマを割ってください");
    return;
  }
  backgroundPen.panel = panel.id;
  const mode = backgroundPen.mode;
  if (mode === "horizon" || mode === "object") {
    editor.startDrag({ kind: "bgDrag", slot, panelId: panel.id, what: mode, a: point, b: point });
    return;
  }
  editor.host.begin();
  if (mode === "vanishing") {
    addVanishing(panel, point);
    editor.host.commit();
    editor.host.status("消失点を置きました（3 つまで。4 つ目で古いものが消えます）");
    return;
  }
  // 消す: within a few pixels on screen.
  const removed = removeInstructionAt(panel, point, 8 / slot.scale);
  if (removed) {
    editor.host.commit();
    editor.host.status({ object: "物の指示を消しました", vanishing: "消失点を消しました", horizon: "アイレベルを消しました" }[removed]);
  } else {
    editor.host.cancel();
    editor.host.status("消す指示がありません。アイレベルの線・消失点・物の枠の近くを押してください");
  }
}

const bgDrag: DragHandler<DragOf<"bgDrag">> = {
  move(editor, drag, { point }) {
    drag.b = point;
    editor.requestOverlay();
    return false;
  },
  end(editor, drag, project) {
    const panel = drag.slot.page.panels.find((one) => one.id === drag.panelId);
    if (!panel) return;
    const [ax, ay] = drag.a;
    const [bx, by] = drag.b;
    if (drag.what === "object" && (Math.abs(bx - ax) < 2 || Math.abs(by - ay) < 2)) {
      editor.host.status("物の指示は、物が立つ所をドラッグで囲んでください");
      editor.requestOverlay();
      return;
    }
    editor.host.begin();
    if (drag.what === "horizon") {
      setHorizon(panel, drag.a, drag.b);
      editor.host.commit();
      editor.host.status("アイレベルを引きました（カメラの高さ。消失点はこの線の上に置くのがふつう）");
      return;
    }
    const [x0, x1] = [Math.min(ax, bx), Math.max(ax, bx)];
    const [y0, y1] = [Math.min(ay, by), Math.max(ay, by)];
    const object = addObject(project, panel, backgroundPen.label, [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]);
    editor.host.commit();
    editor.host.status(`物「${object.label}」を置きました。名前は上の段か、背景の欄で変えられます`);
  },
};

export const BACKGROUND_DRAGS = { bgDrag };

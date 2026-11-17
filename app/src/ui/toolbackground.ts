// 背景の指示: the 背景 tool marks what a panel's background should be, for
// whoever draws it (an AI asked from 作画 among them). The eye level and the
// vanishing points are one ruler (透視の定規, bgruler.ts) chosen as 1, 2 or
// 3 points in the bar: アイレベル (drag a line, or click for a level one),
// 線 (drag along an edge in the panel as its X, Y or Z line: where it meets
// the eye level is the point, beyond the panel too), 消失点 (click), 物 (drag
// a box round where a thing stands; it gets the name in the bar; one placed
// is moved from inside, sized by a corner and named anew in the bar), and 消す
// (click near one). With アイレベル, 線 and 消失点 the ruler's parts are
// dragged where they are: a point (the eye level comes with it), an end of a
// line (its point slides along the eye level), the eye level (the points
// slide along their lines). Each goes to the panel under the pointer, else
// the one marked last on that page, else the nearest.
import type { DragHandler, DragOf, EditorCore, Press } from "./editorcore";
import type { Page, Panel, Point } from "../model/model";
import { bounds } from "../model/geometry";
import { panelAt } from "../editing/hittest";
import { addObject, backgroundOf, moveObject, objectAt, removeInstructionAt, sizeObject } from "../domain/background";
import {
  GUIDE_AXES,
  drawGuide,
  drawHorizon,
  moveGuide,
  moveHorizon,
  turnHorizon,
  moveVanishing,
  placeVanishing,
  pointOfGuide,
  removeVanishing,
  rulerOf,
  rulerPartAt,
  setPerspective,
} from "../domain/bgruler";

export type BackgroundMode = "horizon" | "line" | "vanishing" | "object" | "erase";

export const BACKGROUND_MODE_LABELS: Record<BackgroundMode, string> = {
  horizon: "アイレベル",
  line: "線",
  vanishing: "消失点",
  object: "物",
  erase: "消す",
};

export type GuideAxis = (typeof GUIDE_AXES)[number];

/** The 背景 tool's state, shared by its bar, the editor and the 作画 palette. */
export const backgroundPen = {
  mode: "horizon" as BackgroundMode,
  /** The axis the next line drawn with 線 is for. */
  axis: "X" as GuideAxis,
  /** The name the next 物 gets. */
  label: "",
  /** The panel marked last (vanishing points beyond a panel go to it; the bar's 透視 is its). */
  panel: "",
  /** The 物 picked last (its name is in the bar); none: the bar's name is for the next one. */
  object: "",
  /** 背景の指示 shown with any tool (else with the 背景 tool only). */
  alwaysShown: false,
  /** Told when a press or drag changed the panel worked on or its ruler (the bar shows its 透視). */
  changed: null as (() => void) | null,
};

const told = () => backgroundPen.changed?.();

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

/** A part of a ruler under `point`: the last marked panel's first (its points may lie over another panel), then the others'. */
function rulerAt(page: Page, point: Point, near: number) {
  const panels = [...page.panels].sort((a, b) => Number(b.id === backgroundPen.panel) - Number(a.id === backgroundPen.panel));
  for (const panel of panels) {
    const part = rulerPartAt(panel, point, near);
    if (part) return { panel, part };
  }
  return null;
}

const MOVED_SAYS = {
  vanishing: "消失点を動かしました（アイレベルも一緒に動き、線が消失点へ向きます）",
  guide: "線を動かしました（消失点は線とアイレベルの交わる所へ）",
  horizon: "アイレベルを動かしました（消失点は線に沿って動きます）",
  horizonEnd: "アイレベルの傾きを変えました（水平の近くでは水平に吸い付きます。Alt で吸い付かない）",
} as const;

export function pressBackground(editor: EditorCore, press: Press): void {
  pressOn(editor, press);
  told();
}

function pressOn(editor: EditorCore, { slot, point }: Press): void {
  const mode = backgroundPen.mode;
  // The ruler's parts are dragged where they are (a point beyond the panel too).
  if (mode === "horizon" || mode === "line" || mode === "vanishing") {
    const hit = rulerAt(slot.page, point, 9 / slot.scale);
    // The eye level itself is taken in アイレベル only (線 is drawn across it); its ends always.
    if (hit && (hit.part.kind !== "horizon" || mode === "horizon")) {
      backgroundPen.panel = hit.panel.id;
      editor.startDrag({
        kind: "bgRuler",
        slot,
        panelId: hit.panel.id,
        part: hit.part,
        start: rulerOf(hit.panel),
        from: point,
        moved: false,
      });
      return;
    }
  }
  // 物 already placed: moved from inside, sized by a corner, its name in the bar.
  if (mode === "object") {
    const panels = [...slot.page.panels].sort((a, b) => Number(b.id === backgroundPen.panel) - Number(a.id === backgroundPen.panel));
    for (const one of panels) {
      const hit = objectAt(one, point, 9 / slot.scale);
      if (!hit) continue;
      backgroundPen.panel = one.id;
      backgroundPen.object = hit.object.id;
      editor.startDrag({
        kind: "bgObject",
        slot,
        panelId: one.id,
        objectId: hit.object.id,
        corner: hit.corner,
        start: hit.object.shape.map(([x, y]) => [x, y] as Point),
        from: point,
        moved: false,
      });
      editor.host.status(`物「${hit.object.label}」: ドラッグで動かす・角で大きさ・上の段で名前`);
      editor.requestOverlay();
      return;
    }
    backgroundPen.object = "";
  }
  const panel = targetPanel(slot.page, point);
  if (!panel) {
    editor.host.status("背景の指示はコマに付けます。先にコマを割ってください");
    return;
  }
  backgroundPen.panel = panel.id;
  if (mode === "horizon" || mode === "object" || mode === "line") {
    editor.startDrag({ kind: "bgDrag", slot, panelId: panel.id, what: mode, a: point, b: point });
    return;
  }
  editor.host.begin();
  if (mode === "vanishing") {
    const index = placeVanishing(panel, point);
    editor.host.commit();
    const ruler = rulerOf(panel);
    editor.host.status(
      ruler.vanishing.length < 3 && ruler.points === ruler.vanishing.length
        ? `消失点${index + 1}を置きました（${ruler.points}点透視。点を増やすには上の段の「透視」で選びます）`
        : `消失点${index + 1}を置きました`,
    );
    editor.requestOverlay();
    return;
  }
  // 消す: within a few pixels on screen. A point or a line takes its point off the ruler.
  const hit = rulerAt(slot.page, point, 8 / slot.scale);
  if (hit && (hit.part.kind === "horizon" || hit.part.kind === "horizonEnd")) {
    // The eye level (beyond the panel too): the ruler goes with it.
    setPerspective(hit.panel, 0);
    editor.host.commit();
    editor.host.status("アイレベルを消しました（定規ごと）");
    return;
  }
  if (hit && (hit.part.kind === "vanishing" || hit.part.kind === "guide")) {
    const { part } = hit;
    const index = part.kind === "vanishing" ? part.index : pointOfGuide(part.index);
    removeVanishing(hit.panel, index);
    editor.host.commit();
    editor.host.status(`消失点${index + 1}を消しました（${rulerOf(hit.panel).vanishing.length}点透視に）`);
    return;
  }
  const removed = removeInstructionAt(panel, point, 8 / slot.scale);
  if (removed) {
    editor.host.commit();
    editor.host.status(
      { object: "物の指示を消しました", vanishing: "消失点を消しました", horizon: "アイレベルを消しました（定規ごと）" }[removed],
    );
  } else {
    editor.host.cancel();
    editor.host.status("消す指示がありません。アイレベル・線・消失点・物の枠の近くを押してください");
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
    queueMicrotask(told);
    const [ax, ay] = drag.a;
    const [bx, by] = drag.b;
    if (drag.what === "object" && (Math.abs(bx - ax) < 2 || Math.abs(by - ay) < 2)) {
      editor.host.status("物の指示は、物が立つ所をドラッグで囲んでください");
      editor.requestOverlay();
      return;
    }
    if (drag.what === "line") {
      if (Math.hypot(bx - ax, by - ay) < 3) {
        editor.host.status(`${backgroundPen.axis} の線は、コマの中の辺（建物・床・道の線）に沿ってドラッグで引きます`);
        editor.requestOverlay();
        return;
      }
      editor.host.begin();
      drawGuide(panel, backgroundPen.axis, [drag.a, drag.b]);
      editor.host.commit();
      const ruler = rulerOf(panel);
      const index = pointOfGuide(GUIDE_AXES.indexOf(backgroundPen.axis));
      const point = ruler.vanishing[index];
      const [x0, y0, x1, y1] = bounds(panel.shape);
      const outside = point && (point[0] < x0 || point[0] > x1 || point[1] < y0 || point[1] > y1) ? "（コマの外）" : "";
      editor.host.status(`${backgroundPen.axis} の線を引きました。消失点${index + 1}${outside}はこの線の先です（${ruler.points}点透視）`);
      return;
    }
    editor.host.begin();
    if (drag.what === "horizon") {
      drawHorizon(panel, drag.a, drag.b);
      editor.host.commit();
      editor.host.status(
        rulerOf(panel).vanishing.length
          ? "アイレベルを引き直しました（消失点は線に沿ってアイレベルの上へ）"
          : "アイレベルを引きました（上の段の「透視」で 1点・2点・3点を選ぶと消失点と線が付きます）",
      );
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
    backgroundPen.object = object.id;
    editor.host.commit();
    editor.host.status(`物「${object.label}」を置きました。名前は上の段で変えられます（あとから押して選んでも）`);
  },
};

/** 物 moved or sized as the pointer goes, one undo step. */
const bgObject: DragHandler<DragOf<"bgObject">> = {
  move(editor, drag, { point }) {
    const panel = drag.slot.page.panels.find((one) => one.id === drag.panelId);
    const object = panel && backgroundOf(panel).objects?.find((one) => one.id === drag.objectId);
    if (!object) return false;
    if (!drag.moved) {
      if (Math.hypot(point[0] - drag.from[0], point[1] - drag.from[1]) * drag.slot.scale < 3) return false;
      editor.host.begin();
      drag.moved = true;
    }
    if (drag.corner < 0) moveObject(object, drag.start, point[0] - drag.from[0], point[1] - drag.from[1]);
    else sizeObject(object, drag.start, drag.corner, point);
  },
  end(editor, drag) {
    told();
    if (!drag.moved) return;
    editor.host.commit();
    editor.host.status(drag.corner < 0 ? "物を動かしました" : "物の大きさを変えました");
  },
};

/** A part of the ruler moved: the model changes as the pointer goes (from the ruler as it was), one undo step. */
const bgRuler: DragHandler<DragOf<"bgRuler">> = {
  move(editor, drag, { point, event }) {
    const panel = drag.slot.page.panels.find((one) => one.id === drag.panelId);
    if (!panel) return false;
    if (!drag.moved) {
      if (Math.hypot(point[0] - drag.from[0], point[1] - drag.from[1]) * drag.slot.scale < 3) return false;
      editor.host.begin();
      drag.moved = true;
    }
    const part = drag.part;
    if (part.kind === "vanishing") {
      const from = drag.start.vanishing[part.index];
      moveVanishing(panel, drag.start, part.index, [from[0] + point[0] - drag.from[0], from[1] + point[1] - drag.from[1]]);
    } else if (part.kind === "guide") {
      const from = drag.start.guides[part.index][part.end];
      moveGuide(panel, drag.start, part.index, part.end, [from[0] + point[0] - drag.from[0], from[1] + point[1] - drag.from[1]]);
    } else if (part.kind === "horizonEnd") {
      turnHorizon(panel, drag.start, part.end, point, event.altKey);
    } else moveHorizon(panel, drag.start, drag.from, point);
  },
  end(editor, drag) {
    if (!drag.moved) return;
    editor.host.commit();
    told();
    editor.host.status(MOVED_SAYS[drag.part.kind]);
  },
};

export const BACKGROUND_DRAGS = { bgDrag, bgObject, bgRuler };

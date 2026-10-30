// Tools that take an outline drawn around something: 塗り (塗りつぶし,
// 囲って塗る, 投げなわ塗り and 塗り残し部分に塗る in the chosen tone) and はみ出し
// (where the drawing goes over the panel borders).
import type { DragHandler, DragOf, Press, EditorCore } from "./editorcore";
import { fillAt, fillInside, fillUnder, type FillResult } from "./fillregion";
import { FILL_WAY_LABELS } from "./fillsettings";
import { addBreakout } from "./koma";
import { bounds } from "./geometry";
import type { Page, Point, Project } from "./model";
import { TONE_LABELS, addFill, insideFill, simplify } from "./strokes";

export function pressFill(editor: EditorCore, { project, slot, point }: Press): void {
  const { way, tone } = editor.fill;
  if (way !== "click") {
    editor.startDrag({ kind: "fill", slot, points: [point], way });
    return;
  }
  // On a fill: it takes the tone in hand, as CSP fills an area of one colour with another.
  const under = [...(slot.page.fills ?? [])].reverse().find((fill) => insideFill(fill, point));
  if (under) {
    if ((under.tone ?? "black") === tone) {
      editor.host.status(`ここはもう${TONE_LABELS[tone]}で塗ってあります`);
      return;
    }
    editor.host.begin();
    if (tone === "black") delete under.tone;
    else under.tone = tone;
    editor.host.commit();
    editor.host.status(`塗りを${TONE_LABELS[tone]}に変えました`);
    return;
  }
  const result = fillAt(project, slot.page, point, editor.fill.options.click);
  addRegions(editor, project, slot.page, result, "click");
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

/** Fill the areas found, as one step, and say what came of it. */
function addRegions(editor: EditorCore, project: Project, page: Page, result: FillResult, way: "click" | "enclose" | "remaining"): void {
  if ("none" in result) {
    editor.host.status(
      result.none === "onLine"
        ? "線の上です。線で閉じた範囲の中をクリックしてください"
        : way === "click"
          ? "塗れる範囲が見つかりません"
          : way === "enclose"
            ? "囲んだ中に線で閉じた範囲がありません。閉じた範囲をまるごと囲んでください"
            : "なぞった所に塗り残しの隙間がありません",
    );
    return;
  }
  editor.host.begin();
  for (const region of result.regions) addFill(project, page, region.shape, editor.fill.tone, region.holes, editor.fill.under[way]);
  editor.host.commit();
  const count = result.regions.length;
  editor.host.status(
    result.wholePage
      ? "線で閉じていない所だったので、ページ全体を塗りました（Ctrl+Z で戻す。隙間閉じを大きくすると閉じることがあります）"
      : `${FILL_WAY_LABELS[way]}: ${count > 1 ? `${count} か所を` : ""}${TONE_LABELS[editor.fill.tone]}で塗りました`,
  );
}

const fill: DragHandler<DragOf<"fill">> = {
  move(_editor, drag, { point }) {
    drag.points.push(point);
  },
  end(editor, drag, project) {
    const page = drag.slot.page;
    if (drag.way === "remaining") {
      const path = outline(drag.points, 0.2);
      addRegions(editor, project, page, fillUnder(project, page, path, editor.fill.brushMm / 2, editor.fill.options.remaining), "remaining");
      return;
    }
    const shape = outline(drag.points, 0.4);
    const box = bounds(shape);
    if (shape.length < 3 || box[2] - box[0] < 1 || box[3] - box[1] < 1) {
      editor.host.status("塗る所を囲むようにドラッグしてください");
      return;
    }
    if (drag.way === "enclose") {
      addRegions(editor, project, page, fillInside(project, page, shape, editor.fill.options.enclose), "enclose");
      return;
    }
    editor.host.begin();
    addFill(project, page, shape, editor.fill.tone, undefined, editor.fill.under.lasso);
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

// 物語の帯: the right-click menus of the scene lane and the shape lane, with
// the same order as the page list's menu (listops.ts): put in, move, the
// lane's own, remove.
import { addScene } from "./cast";
import type { Project } from "./model";
import { openMenu, SEPARATOR, type MenuItem } from "./popupmenu";
import { keepShape } from "./prefs";
import { canSplitAt, duplicateScene, joinScene, moveSceneTo, sceneNeighbours, scenePageIds, sceneTarget, splitScene } from "./sceneops";
import { addBeat, editableShape, removeBeat, removePart, splitPart } from "./shapes";
import { type SceneSpan, uncoveredRunAt } from "./story";
import type { LaneView } from "./boardview";

type Entry = MenuItem | typeof SEPARATOR;

/** The menu of a scene (`index`: the page under the pointer). */
export function sceneMenu(view: LaneView, project: Project, span: SceneSpan, index: number, x: number, y: number): void {
  const id = span.scene.id;
  const { before, after } = sceneNeighbours(project, id);
  const ids = scenePageIds(project, id);
  const range = span.first === span.last ? `${span.first + 1} ページ` : `${span.first + 1}〜${span.last + 1} ページ`;
  const move = (to: -1 | 1 | "first" | "last", label: string, keys?: string): MenuItem => ({
    label,
    keys,
    disabled: sceneTarget(project, id, to) === null,
    run: () => view.edit((p) => moveSceneTo(p, id, to)),
  });
  const pages = view.host.pageAction;
  const items: Entry[] = [
    {
      label: "名前・あらすじを直す",
      run: () => {
        view.selectScene(span);
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#inspector input.scene-title")?.focus());
      },
    },
    ...(pages ? [{ label: `シーンのページ（${range}）を選ぶ`, title: "ページ一覧でまとめて選ぶ（コピー・移動・保留などに）", run: () => pages("pick", ids) }] : []),
    SEPARATOR,
    {
      label: "ページごと複製して後ろに入れる",
      run: () => {
        let made = "";
        view.edit((p) => (made = duplicateScene(p, id)?.scene.id ?? ""));
        if (made) view.setSelection({ kind: "scene", sceneId: made });
      },
    },
    SEPARATOR,
    move(-1, "ページごと 1 つ前のシーンの前へ"),
    move(1, "ページごと 1 つ後ろのシーンの後ろへ"),
    move("first", "ページごと先頭へ"),
    move("last", "ページごと最後へ"),
    SEPARATOR,
    {
      label: `${index + 1} ページから別のシーンに分ける`,
      disabled: !canSplitAt(project, id, index),
      title: "ポインターのあるページから後ろを、新しいシーンにする",
      run: () => {
        let made = "";
        view.edit((p) => (made = splitScene(p, id, index)?.id ?? ""));
        if (made) view.setSelection({ kind: "scene", sceneId: made });
      },
    },
    { label: before ? `前のシーン「${before.scene.title}」とつなぐ` : "前のシーンとつなぐ", disabled: !before, run: () => view.edit((p) => joinScene(p, id, false)) },
    { label: after ? `次のシーン「${after.scene.title}」とつなぐ` : "次のシーンとつなぐ", disabled: !after, run: () => view.edit((p) => joinScene(p, id, true)) },
    { label: "別案を作る", title: "このシーンのページを写した案を作り、ページ配分やコマ割りを試す", run: () => view.host.makeOption(span.first, span.last) },
    ...(pages ? [{ label: "ページを保留にする（外して取っておく）", disabled: ids.length >= project.pages.length, run: () => pages("hold", ids) }] : []),
    SEPARATOR,
    {
      label: "シーンを消す（ページは残す）",
      keys: "Delete",
      danger: true,
      run: () =>
        view.edit((p) => {
          p.scenes = p.scenes.filter((s) => s.id !== id);
          view.setSelection(null);
        }),
    },
    ...(pages ? [{ label: "シーンをページごと削除", danger: true, disabled: ids.length >= project.pages.length, run: () => pages("delete", ids) }] : []),
  ];
  view.selectScene(span);
  openMenu(items, x, y, `シーン「${span.scene.title}」のメニュー`);
}

/** The menu on the scene lane where no scene is (page `index`). */
export function emptySceneMenu(view: LaneView, project: Project, index: number, x: number, y: number): void {
  const run = uncoveredRunAt(project, index);
  if (!run) return;
  openMenu(
    [
      {
        label: run[0] === run[1] ? `${run[0] + 1} ページにシーンを足す` : `${run[0] + 1}〜${run[1] + 1} ページにシーンを足す`,
        run: () =>
          view.edit((p) => {
            const scene = addScene(p, p.pages[run[0]].id, p.pages[run[1]].id, `シーン${p.scenes.length + 1}`);
            view.setSelection({ kind: "scene", sceneId: scene.id });
          }),
      },
    ],
    x,
    y,
    "シーン",
  );
}

/** Change the shape in use (a built-in one is copied into an own shape first) and keep it on this computer. */
function changeShape(view: LaneView, change: (shape: NonNullable<ReturnType<typeof editableShape>>) => void): void {
  view.edit((p) => {
    const own = editableShape(p);
    if (!own) return;
    change(own);
    keepShape(own);
  });
}

/** The menu of a part of the story shape (`part` its index; `index` the page under the pointer). */
export function partMenu(view: LaneView, project: Project, part: number, parts: number, index: number, x: number, y: number): void {
  const count = project.pages.length;
  openMenu(
    [
      { label: "話の型を直す（名前・区切り・ビート）", run: () => view.select({ kind: "shape" }) },
      SEPARATOR,
      { label: "この区切りを半分に分ける", run: () => changeShape(view, (own) => splitPart(own, part)) },
      { label: `${index + 1} ページにビートを足す`, run: () => changeShape(view, (own) => addBeat(own, "ビート", (index + 0.5) / count)) },
      SEPARATOR,
      { label: "この区切りを消す（前の区切りに入れる）", danger: true, disabled: parts <= 1, run: () => changeShape(view, (own) => removePart(own, part)) },
    ],
    x,
    y,
    "話の型",
  );
}

/** The menu of a beat of the story shape. */
export function beatMenu(view: LaneView, beat: number, name: string, x: number, y: number): void {
  openMenu(
    [
      { label: "話の型を直す（名前・区切り・ビート）", run: () => view.select({ kind: "shape" }) },
      SEPARATOR,
      { label: `ビート「${name}」を消す`, danger: true, run: () => changeShape(view, (own) => removeBeat(own, beat)) },
    ],
    x,
    y,
    "ビート",
  );
}

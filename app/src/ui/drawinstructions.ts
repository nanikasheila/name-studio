// A panel's 背景の指示 in the 作画 palette: what to draw in words, its 場所
// (a 素材), the 透視 of its ruler or the camera in words, 背景なし, and the
// things placed with the 背景 tool named (each with its 素材). Folded, a
// panel shows only `instructionSummary`.
import { assetNamed, chooseAsset, objectAsset } from "../domain/bgassets";
import { CAMERA_LABELS, backgroundOf, findPanel, renameObject, setBackground } from "../domain/background";
import {
  PERSPECTIVES,
  PERSPECTIVE_LABELS,
  PERSPECTIVE_TITLES,
  type Perspective,
  perspectiveOf,
  rulerOf,
  rulerWords,
  setPerspective,
} from "../domain/bgruler";
import type { BackgroundCamera, Panel, Project } from "../model/model";
import type { DrawAssets } from "./drawassets";

/** An element with these attributes and children. */
export function tag<K extends keyof HTMLElementTagNameMap>(
  name: K,
  attributes: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

export interface InstructionHost {
  edit(change: (project: Project) => void): void;
  readonly assets: DrawAssets;
}

/** The instructions in one line, for a panel folded: its words, then what else it has. */
export function instructionSummary(panel: Panel): string {
  const bg = backgroundOf(panel);
  if (bg.none) return "背景なし";
  const ruler = rulerOf(panel);
  const parts = [
    bg.brief?.trim() ?? "",
    bg.place ? `場所: ${bg.place}` : "",
    ruler.vanishing.length ? `${PERSPECTIVE_LABELS[perspectiveOf(bg)]}透視` : ruler.horizon ? "アイレベル" : "",
    !ruler.vanishing.length && bg.camera ? CAMERA_LABELS[bg.camera] : "",
    bg.objects?.length ? `物 ${bg.objects.map((object) => object.label).join("・")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : "指示なし（ラフのまま）";
}

/** A panel's 背景の指示, to write and choose. */
export function instructionsView(host: InstructionHost, panel: Panel): HTMLElement {
  const bg = backgroundOf(panel);
  const change = (next: Parameters<typeof setBackground>[1]) =>
    host.edit((project) => {
      const found = findPanel(project, panel.id);
      if (found) setBackground(found.panel, next);
    });
  const brief = tag("textarea", {
    rows: "1",
    placeholder: "このコマの背景（例: 車寄せ。バンのスライドドアが開いている）",
    "aria-label": "このコマの背景",
  });
  brief.value = bg.brief ?? "";
  brief.addEventListener("keydown", (event) => event.stopPropagation());
  brief.addEventListener("change", () => change({ brief: brief.value.trim() }));
  // 場所: a 素材 to take place in, or a name for the AI to make (and add to the 素材).
  const place = tag("input", {
    type: "text",
    class: "drawing-place",
    list: "drawing-places",
    "aria-label": "場所",
    placeholder: "場所（素材）",
    title: "このコマの場所。素材にある場所を選ぶと AI はそれを使い、ない名前なら作って素材に足します（例: 叔母の家 玄関）",
  });
  place.value = bg.place ?? "";
  place.size = Math.max(10, Math.min(16, place.value.length + 2));
  place.dataset.listed = String(!!assetNamed(host.assets.list, bg.place));
  place.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") place.blur();
  });
  place.addEventListener("change", () => change({ place: place.value.trim() || undefined }));
  const ruler = rulerOf(panel);
  const points = tag("select", {
    "aria-label": "透視",
    title: "透視の定規（背景の道具 H で消失点・線・アイレベルをドラッグして合わせる）",
  });
  for (const n of PERSPECTIVES)
    points.append(tag("option", { value: String(n), title: PERSPECTIVE_TITLES[n] }, n ? `${PERSPECTIVE_LABELS[n]}透視` : "透視なし"));
  points.value = String(ruler.vanishing.length ? perspectiveOf(bg) : 0);
  points.addEventListener("change", () =>
    host.edit((project) => {
      const found = findPanel(project, panel.id);
      if (found) setPerspective(found.panel, Number(points.value) as Perspective);
    }),
  );
  // With a ruler the camera comes from its points; without one, in words.
  const camera = tag("select", { "aria-label": "カメラ", title: "カメラの高さ（透視の定規がないとき）" });
  camera.append(tag("option", { value: "" }, "カメラ: ラフのまま"));
  for (const [value, label] of Object.entries(CAMERA_LABELS)) camera.append(tag("option", { value }, label));
  camera.value = bg.camera ?? "";
  camera.addEventListener("change", () => change({ camera: (camera.value || undefined) as BackgroundCamera | undefined }));
  const view =
    ruler.vanishing.length === 3
      ? rulerWords(ruler)?.includes("見下ろし")
        ? "見下ろし"
        : "見上げ"
      : ruler.vanishing.length
        ? "水平のカメラ"
        : "";
  const none = tag("input", { type: "checkbox" });
  none.checked = !!bg.none;
  none.addEventListener("change", () => change({ none: none.checked }));
  const drawn = [ruler.horizon && !ruler.vanishing.length ? "アイレベル" : "", view].filter(Boolean);
  // The things placed with 物, each named here too.
  const things = (bg.objects ?? []).map((object) => {
    const name = tag("input", {
      type: "text",
      class: "drawing-object",
      "aria-label": "物の名前",
      title: "物の名前（背景の道具の「物」で動かす・大きさを変える）",
    });
    name.value = object.label;
    name.size = Math.max(4, Math.min(14, object.label.length + 1));
    name.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") name.blur();
    });
    name.addEventListener("change", () =>
      host.edit((project) => {
        const found = findPanel(project, panel.id);
        if (found) renameObject(found.panel, object.id, name.value);
      }),
    );
    const listed = host.assets.names("thing");
    if (!listed.length && !object.asset) return name;
    // Its 素材: chosen, else the one its name begins with.
    const asset = tag("select", { "aria-label": "物の素材", title: "この物に使う素材（素材の一覧から）" });
    const guessed = objectAsset(host.assets.list, { ...object, asset: undefined });
    asset.append(tag("option", { value: "" }, guessed ? `素材: ${guessed.name}（名前から）` : "素材なし"));
    for (const thing of listed) asset.append(tag("option", { value: thing }, thing));
    if (object.asset && !listed.includes(object.asset))
      asset.append(tag("option", { value: object.asset }, `${object.asset}（一覧にない）`));
    asset.value = object.asset ?? "";
    asset.addEventListener("change", () =>
      host.edit((project) => {
        const found = findPanel(project, panel.id);
        if (found) chooseAsset(found.panel, object.id, asset.value || undefined);
      }),
    );
    return tag("span", { class: "drawing-object-asset" }, name, asset);
  });
  return tag(
    "div",
    { class: "drawing-instructions" },
    brief,
    tag(
      "div",
      { class: "assist-row" },
      place,
      points,
      ...(ruler.vanishing.length ? [] : [camera]),
      tag("label", { class: "check", title: "人物のアップ・効果など、背景を描かないコマ" }, none, " 背景なし"),
      tag("span", { class: "hint", title: "背景の道具（H）で描いた指示" }, drawn.length ? drawn.join("・") : ""),
    ),
    ...(things.length ? [tag("div", { class: "assist-row drawing-objects" }, tag("span", { class: "hint" }, "物"), ...things)] : []),
  );
}

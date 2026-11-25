// A panel's 背景の指示 in the 作画 palette: what to draw in words, its 場所
// (a 素材), the 透視 of its ruler or the camera in words, 背景なし, and the
// things placed with the 背景 tool named (each with its 素材). Folded, a
// panel shows only `instructionSummary`.
import { assetNamed, chooseAsset, objectAsset } from "../domain/bgassets";
import {
  CAMERA_LABELS,
  FAR_KINDS,
  FAR_LABELS,
  backgroundOf,
  findPanel,
  renameObject,
  reseedFar,
  setBackground,
  setFar,
} from "../domain/background";
import {
  GROUND,
  INDOOR_LIGHTS,
  LIGHT_LABELS,
  MATERIALS,
  OUTDOOR_LIGHTS,
  SETTING_LABELS,
  TIME_LABELS,
  WEATHER_LABELS,
  lookOf,
  lookWords,
  materialOf,
  setLook,
  setMaterial,
  shareLook,
} from "../domain/bglook";
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
import type {
  BackgroundCamera,
  BackgroundFar,
  BackgroundLook,
  FarKind,
  LightKey,
  LookSetting,
  Panel,
  Project,
  TimeOfDay,
  Weather,
} from "../model/model";
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
    bg.far?.length ? `遠景 ${bg.far.map(farWord).join("・")}` : "",
    lookWords(panel),
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : "指示なし（ラフのまま）";
}

const farWord = (layer: BackgroundFar) => (layer.kind === "panorama" ? (layer.asset ?? FAR_LABELS.panorama) : FAR_LABELS[layer.kind]);

/** 遠景: the sky (a 360° picture from the 素材, turned) and the made layers (mountains, skyline, trees), with another shape. */
function farRow(host: InstructionHost, panel: Panel): HTMLElement {
  const far = backgroundOf(panel).far ?? [];
  const layerOf = (kind: FarKind) => far.find((layer) => layer.kind === kind);
  const edit = (change: (panel: Panel) => void) =>
    host.edit((project) => {
      const found = findPanel(project, panel.id);
      if (found) change(found.panel);
    });
  const parts: HTMLElement[] = [
    tag("span", { class: "hint", title: "遠くの景色。線は細く・トーンは明るく描かれ、遠景だけの絵（遠景）も届きます" }, "遠景"),
  ];
  const listed = host.assets.names("panorama");
  const panorama = layerOf("panorama");
  if (listed.length || panorama) {
    const sky = tag("select", {
      "aria-label": "遠景の空",
      title: "空に貼る全天球の画像（素材の「全天球の画像」）。画像の地平線がアイレベルに合います",
    });
    sky.append(tag("option", { value: "" }, "空の画像なし"));
    for (const name of listed) sky.append(tag("option", { value: name }, name));
    if (panorama?.asset && !listed.includes(panorama.asset))
      sky.append(tag("option", { value: panorama.asset }, `${panorama.asset}（一覧にない）`));
    sky.value = panorama?.asset ?? "";
    sky.addEventListener("change", () => edit((one) => setFar(one, "panorama", sky.value ? { asset: sky.value } : null)));
    parts.push(sky);
    if (panorama) {
      const turn = tag("input", {
        type: "number",
        step: "15",
        class: "drawing-far-turn",
        "aria-label": "空の向き",
        title: "空の画像を回す角度（度、上から見て左回り）。太陽や山の向きを合わせる",
      });
      turn.value = String(panorama.turnDeg ?? 0);
      turn.addEventListener("keydown", (event) => event.stopPropagation());
      turn.addEventListener("change", () => {
        const value = Number(turn.value);
        edit((one) => setFar(one, "panorama", { turnDeg: Number.isFinite(value) && value ? ((value % 360) + 360) % 360 : undefined }));
      });
      parts.push(tag("label", { class: "check" }, turn, "°"));
    }
  }
  for (const kind of FAR_KINDS) {
    if (kind === "panorama") continue;
    const box = tag("input", { type: "checkbox" });
    box.checked = !!layerOf(kind);
    box.dataset.far = kind;
    box.addEventListener("change", () => edit((one) => setFar(one, kind, box.checked ? {} : null)));
    parts.push(
      tag(
        "label",
        { class: "check", title: `${FAR_LABELS[kind]}を遠くに置く（形は種から。同じ種なら同じ形）` },
        box,
        ` ${FAR_LABELS[kind]}`,
      ),
    );
  }
  if (far.some((layer) => layer.kind !== "panorama")) {
    const again = tag("button", { type: "button", title: "山並み・街並み・木立を別の形にする" }, "別の形");
    again.addEventListener("click", () => edit((one) => reseedFar(one)));
    parts.push(again);
  }
  return tag("div", { class: "assist-row drawing-far" }, ...parts);
}

/** A choice of words (its first option: none), set by `pick`. */
function choice<T extends string>(
  label: string,
  title: string,
  none: string,
  values: readonly T[],
  labels: Record<T, string>,
  value: T | undefined,
  pick: (value: T | undefined) => void,
): HTMLSelectElement {
  const select = tag("select", { "aria-label": label, title });
  select.append(tag("option", { value: "" }, none));
  for (const one of values) select.append(tag("option", { value: one }, labels[one]));
  if (value && !values.includes(value)) select.append(tag("option", { value }, labels[value] ?? value));
  select.value = value ?? "";
  select.addEventListener("change", () => pick((select.value || undefined) as T | undefined));
  return select;
}

/** A 物's (or the ground's) material, from name-blockout's library; none: guessed from its name. */
export function materialChoice(host: InstructionHost, panel: Panel, target: string, what: string): HTMLSelectElement {
  const names = MATERIALS.map((one) => one.name);
  const labels = Object.fromEntries(MATERIALS.map((one) => [one.name, one.name])) as Record<string, string>;
  const select = choice(
    `${what}の材質`,
    `${what}の材質（3D の質感と漫画での描き方の組。${MATERIALS.map((one) => `${one.name}: ${one.note}`).join("／")}）`,
    "材質: 名前から",
    names,
    labels,
    materialOf(panel, target),
    (value) =>
      host.edit((project) => {
        const found = findPanel(project, panel.id);
        if (found) setMaterial(found.panel, target, value);
      }),
  );
  select.classList.add("drawing-material");
  return select;
}

/** 見た目: 作画まで (name-blockout's development), the time, weather, indoors or out, the light; the ground's material. */
function lookRow(host: InstructionHost, panel: Panel): HTMLElement {
  const look = lookOf(panel);
  const change = (next: Partial<BackgroundLook>) =>
    host.edit((project) => {
      const found = findPanel(project, panel.id);
      if (found) setLook(found.panel, next);
    });
  const develop = tag("input", { type: "checkbox" });
  develop.checked = !!look.develop;
  develop.dataset.look = "develop";
  develop.addEventListener("change", () => change({ develop: develop.checked }));
  const indoor = look.setting === "indoor";
  const parts: HTMLElement[] = [
    tag(
      "label",
      {
        class: "check",
        title: "あたり（Blockout）のあと、光の向きどおりの影・材質ごとのトーンとベタまで描く（name-blockout の開発）",
      },
      develop,
      " 作画まで",
    ),
    choice<TimeOfDay>(
      "時間帯",
      "時間帯（太陽の高さと向き。屋内では窓の外の明るさ）",
      "時間帯",
      Object.keys(TIME_LABELS) as TimeOfDay[],
      TIME_LABELS,
      look.timeOfDay,
      (value) => change({ timeOfDay: value }),
    ),
    choice<Weather>(
      "天気",
      "天気（晴れ・くもり・かすみは日差しあり、どんより・雨・雪・霧は日差しなし）",
      "天気",
      Object.keys(WEATHER_LABELS) as Weather[],
      WEATHER_LABELS,
      look.weather,
      (value) => change({ weather: value }),
    ),
    choice<LookSetting>(
      "屋内か屋外か",
      "屋内では太陽ではなく部屋の明かりで照らし、地面は床になります（決めないと物の名前から推します）",
      "屋内/屋外",
      ["outdoor", "indoor"],
      SETTING_LABELS,
      look.setting,
      (value) => change({ setting: value }),
    ),
    choice<LightKey>(
      "光",
      indoor ? "屋内の明かり（決めないと天井の明かり）" : "日差しの向きの狙い（時間帯があれば、合わないときに北の向きを聞かれます）",
      "光",
      indoor ? INDOOR_LIGHTS : OUTDOOR_LIGHTS,
      LIGHT_LABELS,
      look.light,
      (value) => change({ light: value }),
    ),
  ];
  if (look.develop) parts.push(materialChoice(host, panel, GROUND, indoor ? "床" : "地面"));
  if (look.timeOfDay || look.weather || look.setting || look.light) {
    const share = tag(
      "button",
      { type: "button", title: "時間帯・天気・屋内/屋外・光を、同じシーンのほかのコマにも（シーンがなければ同じページ）" },
      "シーンにも",
    );
    share.addEventListener("click", () => host.edit((project) => void shareLook(project, panel.id)));
    parts.push(share);
  }
  return tag("div", { class: "assist-row drawing-look" }, tag("span", { class: "hint", title: "見た目（光と材質）" }, "見た目"), ...parts);
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
    const material = bg.look?.develop ? [materialChoice(host, panel, object.id, `「${object.label}」`)] : [];
    const listed = host.assets.names("thing");
    if (!listed.length && !object.asset) return material.length ? tag("span", { class: "drawing-object-asset" }, name, ...material) : name;
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
    return tag("span", { class: "drawing-object-asset" }, name, asset, ...material);
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
    ...(bg.none ? [] : [farRow(host, panel), lookRow(host, panel)]),
  );
}

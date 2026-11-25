// 見た目 of a panel's background: whether it is drawn to the development
// (name-blockout's 開発: the light, its shadows, tones and ベタ by material)
// or only blocked out, and that light and those materials in words. The words
// are name-blockout's (instruction.schema.json, look): the time of day and
// the weather give the sun, indoors the room's light, each 物 a material of
// its library (3D and how a manga draws it, paired). Pure.
import type { BackgroundLook, LightKey, LookSetting, Panel, PanelBackground, Project, TimeOfDay, Weather } from "../model/model";
import { backgroundOf, setBackground } from "./background";

export const TIME_LABELS: Record<TimeOfDay, string> = {
  dawn: "明け方",
  morning: "朝",
  noon: "昼",
  afternoon: "午後",
  evening: "夕方",
  dusk: "日暮れ",
  night: "夜",
};
export const WEATHER_LABELS: Record<Weather, string> = {
  clear: "晴れ",
  cloudy: "くもり",
  haze: "かすみ",
  overcast: "どんより",
  rain: "雨",
  snow: "雪",
  fog: "霧",
};
export const SETTING_LABELS: Record<LookSetting, string> = { outdoor: "屋外", indoor: "屋内" };
export const LIGHT_LABELS: Record<LightKey, string> = {
  front: "順光",
  back: "逆光",
  "side-left": "左から",
  "side-right": "右から",
  top: "真上から",
  window: "窓から",
  interior: "天井の明かり",
  street: "街灯",
};
/** The lights offered outdoors (the sun's side, as the author wants it) and indoors (the room's). */
export const OUTDOOR_LIGHTS: readonly LightKey[] = ["front", "back", "side-left", "side-right", "top", "street"];
export const INDOOR_LIGHTS: readonly LightKey[] = ["interior", "window", "street", "side-left", "side-right"];

/** name-blockout's material library: each name, with how a manga draws it. */
export const MATERIALS: readonly { name: string; note: string }[] = [
  { name: "白壁", note: "光の面は白、影だけトーン" },
  { name: "コンクリート", note: "トーン薄め。型枠の目地を描き込む" },
  { name: "木", note: "木目・板の継ぎ目を線で" },
  { name: "金属", note: "映り込みは白抜きの帯" },
  { name: "トタン", note: "波板の筋を線で" },
  { name: "ガラス", note: "映り込みの斜めの白抜き" },
  { name: "瓦", note: "瓦の段を線で" },
  { name: "アスファルト", note: "トーン。白線は白抜き" },
  { name: "土", note: "トーン薄め" },
  { name: "草", note: "線の束、影はトーン" },
  { name: "布", note: "しわは線で" },
  { name: "黒い塗装", note: "ベタ。線は白で" },
  { name: "水", note: "映り込みと波の線" },
];
/** The ground's target among the materials (a floor indoors). */
export const GROUND = "ground";
/** A room's walls and ceiling among the materials (indoors, name-blockout builds the room). */
export const WALLS = "walls";

/** Where a room's window is (name-blockout's room.windows, kept among the answers by that path). */
export type RoomWindow = "none" | "back" | "left" | "right";
export const WINDOW_LABELS: Record<RoomWindow, string> = { none: "なし", back: "奥", left: "左", right: "右" };
const WINDOWS_PATH = "room.windows";

/** The window chosen for a panel's room (none chosen: name-blockout puts one where the light comes through, if it does). */
export function windowOf(panel: Panel): RoomWindow | undefined {
  const kept = backgroundOf(panel).answers?.find((one) => one.path === WINDOWS_PATH);
  if (!kept?.value) return undefined;
  try {
    const value = JSON.parse(kept.value) as { wall?: string }[];
    if (!Array.isArray(value)) return undefined;
    const wall = value[0]?.wall;
    return !value.length ? "none" : wall === "back" || wall === "left" || wall === "right" ? wall : undefined;
  } catch {
    return undefined;
  }
}

/** Choose a panel's window (undefined: leave it to name-blockout). */
export function setWindow(panel: Panel, wall: RoomWindow | undefined): void {
  const others = (backgroundOf(panel).answers ?? []).filter((one) => one.path !== WINDOWS_PATH);
  const value = wall === undefined ? null : JSON.stringify(wall === "none" ? [] : [{ wall }]);
  setBackground(panel, { answers: value === null ? others : [...others, { path: WINDOWS_PATH, value }] });
}

/** A panel's 見た目 (empty when it has none). */
export function lookOf(panel: Panel): BackgroundLook {
  return backgroundOf(panel).look ?? {};
}

/** The look with what is empty taken out (none when nothing is left). */
function tidy(look: BackgroundLook): BackgroundLook | undefined {
  const next: BackgroundLook = { ...look };
  for (const key of Object.keys(next) as (keyof BackgroundLook)[]) {
    const value = next[key];
    if (value === undefined || value === false || (Array.isArray(value) && !value.length)) delete next[key];
  }
  return Object.keys(next).length ? next : undefined;
}

/** Change a panel's 見た目. Turning it indoors (or out) drops a light the other side does not offer. */
export function setLook(panel: Panel, change: Partial<BackgroundLook>): void {
  const next: BackgroundLook = { ...lookOf(panel), ...change };
  if (change.setting !== undefined && next.light) {
    const offered = next.setting === "indoor" ? INDOOR_LIGHTS : OUTDOOR_LIGHTS;
    if (!offered.includes(next.light)) delete next.light;
  }
  setBackground(panel, { look: tidy(next) });
}

/** The material of a 物 (or the ground, GROUND): chosen, or none (name-blockout guesses it from the name). */
export function setMaterial(panel: Panel, target: string, material: string | undefined): void {
  const others = (lookOf(panel).materials ?? []).filter((one) => one.target !== target);
  setLook(panel, { materials: material ? [...others, { target, material }] : others });
}

/** The material chosen for `target`, if any. */
export const materialOf = (panel: Panel, target: string): string | undefined =>
  lookOf(panel).materials?.find((one) => one.target === target)?.material;

/** The materials that still name something: a 物 of the panel, or the ground. */
function liveMaterials(bg: PanelBackground) {
  const ids = new Set([GROUND, WALLS, ...(bg.objects ?? []).map((object) => object.id)]);
  return (bg.look?.materials ?? []).filter((one) => ids.has(one.target) && one.material.trim());
}

/** The 見た目 in words (none: empty), for a panel folded and the request: 作画まで・夕方・晴れ・屋内・窓から・ソファ=布. */
export function lookWords(panel: Panel): string {
  const bg = backgroundOf(panel);
  const look = bg.look;
  if (!look) return "";
  const label = (target: string) =>
    target === GROUND
      ? look.setting === "indoor"
        ? "床"
        : "地面"
      : target === WALLS
        ? "壁"
        : (bg.objects?.find((object) => object.id === target)?.label ?? target);
  const wall = windowOf(panel);
  return [
    look.develop ? "作画まで" : "",
    look.timeOfDay ? TIME_LABELS[look.timeOfDay] : "",
    look.weather ? WEATHER_LABELS[look.weather] : "",
    look.setting ? SETTING_LABELS[look.setting] : "",
    look.light ? LIGHT_LABELS[look.light] : "",
    wall ? (wall === "none" ? "窓なし" : `窓は${WINDOW_LABELS[wall]}`) : "",
    ...liveMaterials(bg).map((one) => `${label(one.target)}=${one.material}`),
  ]
    .filter(Boolean)
    .join("・");
}

/** What 指示.json carries of it: the stage (develop when 作画まで) and the look in name-blockout's words. */
export function lookInstruction(panel: Panel): { stage: "blockout" | "develop"; look?: Record<string, unknown> } {
  const bg = backgroundOf(panel);
  const look = bg.look;
  const materials = liveMaterials(bg).map((one) => ({ target: one.target, material: one.material.trim() }));
  const out: Record<string, unknown> = {
    ...(look?.timeOfDay ? { timeOfDay: look.timeOfDay } : {}),
    ...(look?.setting ? { setting: look.setting } : {}),
    ...(look?.weather ? { weather: look.weather } : {}),
    ...(look?.light ? { light: { key: look.light } } : {}),
    ...(materials.length ? { materials } : {}),
  };
  return { stage: look?.develop ? "develop" : "blockout", ...(Object.keys(out).length ? { look: out } : {}) };
}

/** The panels of the scene `panelId` is in (its pages; none: only its own page), but itself. */
function scenePanels(project: Project, panelId: string): Panel[] {
  const pageIndex = project.pages.findIndex((page) => page.panels.some((panel) => panel.id === panelId));
  if (pageIndex < 0) return [];
  const at = (id: string) => project.pages.findIndex((page) => page.id === id);
  const scene = (project.scenes ?? []).find((one) => at(one.firstPage) <= pageIndex && pageIndex <= at(one.lastPage));
  const [from, to] = scene ? [at(scene.firstPage), at(scene.lastPage)] : [pageIndex, pageIndex];
  return project.pages
    .slice(from, to + 1)
    .flatMap((page) => page.panels)
    .filter((panel) => panel.id !== panelId && !panel.background?.none);
}

/** The time, weather, indoors or out and light of one panel given to the rest of its scene (its page, without one).
 * How many panels took it. */
export function shareLook(project: Project, panelId: string): number {
  const source = project.pages.flatMap((page) => page.panels).find((panel) => panel.id === panelId);
  if (!source) return 0;
  const { timeOfDay, weather, setting, light } = lookOf(source);
  const others = scenePanels(project, panelId);
  for (const panel of others) setLook(panel, { timeOfDay, weather, setting, light });
  return others.length;
}

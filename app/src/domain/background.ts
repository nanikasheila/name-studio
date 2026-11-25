// 背景: the backgrounds of panels. Each panel can carry 背景の指示 (what to
// draw in words, the camera, the eye level, vanishing points and where
// things stand), a request built from them goes to an AI from 相談 (or to
// whoever draws them), and what comes back are 案 (takes) in the
// background folder, listed in its 背景.json. A take adopted for a panel is
// a picture on the page (a 資料画像 of the kind "background") cut to the
// panel's shape: drawn under the rough lines and written to CSP as a layer
// of its own. Pure: the files are read and written by the screens.
import { bounds, insidePolygon, segmentDistance } from "../model/geometry";
import type {
  BackgroundCamera,
  BackgroundFar,
  BackgroundObject,
  BoxMm,
  FarKind,
  Page,
  PageFormat,
  Panel,
  PanelBackground,
  Point,
  Project,
  ReferenceImage,
  StoredImage,
} from "../model/model";
import { newId } from "./project";

/** 塗り足し: a background is drawn this far (mm) past its panel's bounds, to be nudged or the panel widened. */
export const BACKGROUND_BLEED_MM = 3;
/** The resolution backgrounds are asked for (as the manuscript's). */
export const BACKGROUND_DPI = 600;
/** Adopted backgrounds are kept in the name no larger than this on their long side (the files keep them whole). */
export const MAX_BACKGROUND_PX = 3200;
/** 消失点: at most three (三点透視). */
export const MAX_VANISHING = 3;
/** The list of takes in the background folder. */
export const MANIFEST_FILE = "背景.json";
/** Where each request's files go, in the background folder. */
export const REQUEST_DIR = "依頼";
/** A request as data for tools (name-blockout's instruction), beside its 依頼.md: 依頼/<stamp>/指示.json (bginstruction.ts). */
export const INSTRUCTION_FILE = "指示.json";
/** Where the takes go, in the background folder: 案/<panel>/<take>/. */
export const TAKES_DIR = "案";

export const CAMERA_LABELS: Record<BackgroundCamera, string> = { eye: "目の高さ", low: "あおり", high: "俯瞰" };

/** What a take is drawn as: the whole (on white), the lines alone, the tones, the far band alone (遠景), the shadows. */
export const VARIANTS = ["完成", "線画", "トーン", "遠景", "影"] as const;
export type Variant = (typeof VARIANTS)[number];

export function isBackground(reference: ReferenceImage): boolean {
  return reference.kind === "background";
}

/** The panel's number in reading order on its page (from 1). */
export function panelNumber(page: Page, panel: Panel): number {
  return [...page.panels].sort((a, b) => a.order - b.order).indexOf(panel) + 1;
}

/** "p15 コマ7". */
export function panelLabel(project: Project, page: Page, panel: Panel): string {
  return `p${project.pages.indexOf(page) + 1} コマ${panelNumber(page, panel)}`;
}

/** The panel with `id` and its page. */
export function findPanel(project: Project, id: string): { page: Page; panel: Panel } | null {
  for (const page of project.pages) {
    const panel = page.panels.find((one) => one.id === id);
    if (panel) return { page, panel };
  }
  return null;
}

/** A background's instructions with nothing left out (empty when there are none). */
export function backgroundOf(panel: Panel): PanelBackground {
  return panel.background ?? {};
}

/** Whether a panel has instructions for its background (words, camera, lines or things). */
export function hasInstructions(panel: Panel): boolean {
  const bg = panel.background;
  return (
    !!bg &&
    (!!bg.brief?.trim() ||
      !!bg.place?.trim() ||
      !!bg.camera ||
      !!bg.horizon ||
      !!bg.vanishing?.length ||
      !!bg.objects?.length ||
      !!bg.far?.length ||
      !!bg.look)
  );
}

/** 遠景の層, farthest first: a 360° picture (a 素材), then mountains, a skyline and trees made from a seed. */
export const FAR_KINDS: readonly FarKind[] = ["panorama", "mountains", "skyline", "trees"];
export const FAR_LABELS: Record<FarKind, string> = { panorama: "空の画像", mountains: "山並み", skyline: "街並み", trees: "木立" };
/** Seeds of the made layers (name-blockout makes the same shape from the same seed). */
const SEEDS = 1_000_000;

/** A seed for a made layer, from `random` (0..1). */
export const farSeed = (random: () => number = Math.random): number => Math.floor(random() * SEEDS);

/** 遠景: the layer `kind` on (with `value`: a made one gets a seed, a picture its 素材) or off. Kept farthest first. */
export function setFar(panel: Panel, kind: FarKind, value: Partial<BackgroundFar> | null): void {
  const others = (backgroundOf(panel).far ?? []).filter((layer) => layer.kind !== kind);
  const layer: BackgroundFar | null = value
    ? { ...(backgroundOf(panel).far ?? []).find((one) => one.kind === kind), ...value, kind }
    : null;
  if (layer && kind !== "panorama" && layer.seed === undefined) layer.seed = farSeed();
  const far = [...others, ...(layer ? [layer] : [])].sort((a, b) => FAR_KINDS.indexOf(a.kind) - FAR_KINDS.indexOf(b.kind));
  setBackground(panel, { far });
}

/** 遠景: new seeds for the made layers (another shape for the mountains, skyline and trees). */
export function reseedFar(panel: Panel, random: () => number = Math.random): void {
  const far = backgroundOf(panel).far;
  if (!far?.length) return;
  setBackground(panel, { far: far.map((layer) => (layer.kind === "panorama" ? layer : { ...layer, seed: farSeed(random) })) });
}

/** Change a panel's instructions; what is left empty is taken out (and the whole when nothing is left). */
export function setBackground(panel: Panel, change: Partial<PanelBackground>): void {
  const next: PanelBackground = { ...backgroundOf(panel), ...change };
  for (const key of Object.keys(next) as (keyof PanelBackground)[]) {
    const value = next[key];
    if (value === undefined || value === false || value === "" || (Array.isArray(value) && !value.length)) delete next[key];
  }
  if (Object.keys(next).length) panel.background = next;
  else delete panel.background;
}

/** アイレベル: the line through `a` and `b` (a click alone: level across the panel). */
export function setHorizon(panel: Panel, a: Point, b: Point): void {
  const [x0, , x1] = bounds(panel.shape);
  const flat = Math.hypot(b[0] - a[0], b[1] - a[1]) < 2;
  setBackground(panel, {
    horizon: flat
      ? [
          [x0, a[1]],
          [x1, a[1]],
        ]
      : [a, b],
  });
}

/** 消失点: one more (the oldest goes past three). The 背景 tool places them with the ruler (bgruler.ts). */
export function addVanishing(panel: Panel, point: Point): void {
  const points = [...(backgroundOf(panel).vanishing ?? []), point];
  setBackground(panel, { vanishing: points.slice(-MAX_VANISHING) });
}

/** 物の指示: a thing named `label` standing in `shape`. */
export function addObject(project: Project, panel: Panel, label: string, shape: Point[]): BackgroundObject {
  const object: BackgroundObject = { id: newId(project, "object"), label: label.trim() || "物", shape };
  setBackground(panel, { objects: [...(backgroundOf(panel).objects ?? []), object] });
  return object;
}

/** 物 under `point` (the last placed first): a corner within `near` mm (0 top-left, clockwise) to size it, else inside it (−1) to move it. */
export function objectAt(panel: Panel, point: Point, near: number): { object: BackgroundObject; corner: number } | null {
  for (const object of [...(backgroundOf(panel).objects ?? [])].reverse()) {
    const corner = boxCorners(object.shape).findIndex(([x, y]) => Math.hypot(x - point[0], y - point[1]) <= near);
    if (corner >= 0) return { object, corner };
    if (insidePolygon(object.shape, point) || edgeDistance(object.shape, point) <= near / 2) return { object, corner: -1 };
  }
  return null;
}

/** The corners of a thing's box: top-left, top-right, bottom-right, bottom-left. */
export function boxCorners(shape: readonly Point[]): Point[] {
  const [x0, y0, x1, y1] = bounds(shape as Point[]);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** 物 moved by (`dx`, `dy`) from `start` (its outline when the drag began). */
export function moveObject(object: BackgroundObject, start: readonly Point[], dx: number, dy: number): void {
  object.shape = start.map(([x, y]) => [tenth(x + dx), tenth(y + dy)]);
}

/** 物 sized by dragging its `corner` to `to` (the opposite corner stays); its box from `start`. */
export function sizeObject(object: BackgroundObject, start: readonly Point[], corner: number, to: Point): void {
  const corners = boxCorners(start);
  const [fx, fy] = corners[(corner + 2) % 4];
  const [x0, x1] = [Math.min(fx, to[0]), Math.max(fx, to[0])];
  const [y0, y1] = [Math.min(fy, to[1]), Math.max(fy, to[1])];
  if (x1 - x0 < 1 || y1 - y0 < 1) return;
  object.shape = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(([x, y]) => [tenth(x), tenth(y)]);
}

/** 物 named anew (empty: "物"). */
export function renameObject(panel: Panel, id: string, label: string): boolean {
  const object = backgroundOf(panel).objects?.find((one) => one.id === id);
  if (!object) return false;
  object.label = label.trim() || "物";
  return true;
}

/** Take away the instruction nearest `point` (within `near` mm): a thing, a vanishing point or the eye level; what was taken. */
export function removeInstructionAt(panel: Panel, point: Point, near: number): "object" | "vanishing" | "horizon" | null {
  const bg = backgroundOf(panel);
  const vanishing = (bg.vanishing ?? []).findIndex(([x, y]) => Math.hypot(x - point[0], y - point[1]) <= near);
  if (vanishing >= 0) {
    const rest = bg.vanishing!.filter((_, i) => i !== vanishing);
    // One point fewer: its lines are laid anew.
    setBackground(panel, { vanishing: rest, perspective: rest.length || undefined, guides: undefined });
    return "vanishing";
  }
  const objects = bg.objects ?? [];
  const object = [...objects].reverse().find((one) => insidePolygon(one.shape, point) || edgeDistance(one.shape, point) <= near);
  if (object) {
    setBackground(panel, { objects: objects.filter((one) => one !== object) });
    return "object";
  }
  if (bg.horizon && horizonDistance(panel, bg.horizon, point) <= near) {
    // The eye level holds the ruler: it goes with its points and lines.
    setBackground(panel, { horizon: undefined, vanishing: undefined, perspective: undefined, guides: undefined });
    return "horizon";
  }
  return null;
}

function edgeDistance(shape: readonly Point[], point: Point): number {
  return Math.min(...shape.map((a, i) => segmentDistance(point, a, shape[(i + 1) % shape.length])));
}

/** How far `point` is from the eye level, drawn across the panel. */
function horizonDistance(panel: Panel, horizon: [Point, Point], point: Point): number {
  const [a, b] = horizonAcross(panel, horizon);
  return segmentDistance(point, a, b);
}

/** The eye level drawn from the panel's left to its right side (or as given when it stands upright). */
export function horizonAcross(panel: Panel, [a, b]: [Point, Point]): [Point, Point] {
  const [x0, , x1] = bounds(panel.shape);
  const dx = b[0] - a[0];
  if (Math.abs(dx) < 1e-6) return [a, b];
  const slope = (b[1] - a[1]) / dx;
  return [
    [x0, a[1] + (x0 - a[0]) * slope],
    [x1, a[1] + (x1 - a[0]) * slope],
  ];
}

/** Where a panel's background is drawn: its bounds and the bleed, kept on the paper. */
export function backgroundBox(format: PageFormat, panel: Panel, bleed = BACKGROUND_BLEED_MM): BoxMm {
  const [x0, y0, x1, y1] = bounds(panel.shape);
  const [w, h] = format.canvasMm;
  return [Math.max(0, x0 - bleed), Math.max(0, y0 - bleed), Math.min(w, x1 + bleed), Math.min(h, y1 + bleed)].map(tenth) as BoxMm;
}

const tenth = (v: number) => Math.round(v * 10) / 10;

/** The pixels of `box` at `dpi`. */
export function boxPixels([x0, y0, x1, y1]: BoxMm, dpi: number): [number, number] {
  return [Math.round(((x1 - x0) * dpi) / 25.4), Math.round(((y1 - y0) * dpi) / 25.4)];
}

/** The background adopted for a panel (on its page), if any. */
export function backgroundFor(page: Page, panelId: string): ReferenceImage | undefined {
  return page.references?.find((reference) => isBackground(reference) && reference.panel === panelId);
}

/** The outline a background is cut to: its panel's; none when the panel is gone (then it is not drawn). */
export function backgroundClip(page: Page, reference: ReferenceImage): Point[] | null {
  return page.panels.find((panel) => panel.id === reference.panel)?.shape ?? null;
}

/** Lay `image` in `panel` as its background over `box` (one adopted before is replaced); the reference. */
export function adoptBackground(
  project: Project,
  page: Page,
  panel: Panel,
  image: StoredImage,
  box: BoxMm,
  source: string,
): ReferenceImage {
  const stored: StoredImage = { ...image, id: newId(project, "image") };
  project.images = [...(project.images ?? []), stored];
  const others = (page.references ?? []).filter((reference) => !(isBackground(reference) && reference.panel === panel.id));
  const reference: ReferenceImage = {
    id: newId(project, "reference"),
    image: stored.id,
    box,
    opacity: 1,
    kind: "background",
    panel: panel.id,
    source,
  };
  // Under the other pictures: the 資料 and the pictures of the name are looked at over it.
  page.references = [reference, ...others];
  return reference;
}

/** Take a panel's background off its page. */
export function removeBackground(page: Page, panelId: string): boolean {
  const before = page.references?.length ?? 0;
  page.references = (page.references ?? []).filter((reference) => !(isBackground(reference) && reference.panel === panelId));
  if (!page.references.length) delete page.references;
  return before !== (page.references?.length ?? 0);
}

// --- 案 (takes) in the background folder ---------------------------------------------------------------

/** One take of a panel's background, as 背景.json lists it. */
export interface BackgroundTake {
  panel: string;
  /** Its number among the panel's takes ("1", "2", …). */
  take: string;
  /** Its pictures, from the background folder ("/" between folders). */
  files: Partial<Record<Variant, string>>;
  /** Where it lies on the page (mm); none: where the panel's background goes now. */
  box?: BoxMm;
  note?: string;
  /** The request it answered. */
  request?: string;
}

/** `source` of a reference made from a take. */
export function sourceOf(take: Pick<BackgroundTake, "panel" | "take">, variant: Variant): string {
  return `${take.panel}/${take.take}/${variant}`;
}

/** A take's source read back: its panel, number and variant. */
export function readSource(source: string | undefined): { panel: string; take: string; variant: Variant } | null {
  const parts = source?.split("/") ?? [];
  if (parts.length !== 3 || !(VARIANTS as readonly string[]).includes(parts[2])) return null;
  return { panel: parts[0], take: parts[1], variant: parts[2] as Variant };
}

/** A path in the background folder as the AI wrote it, when it stays in the folder. */
export function folderPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const parts = path.replace(/\\/g, "/").replace(/^\.\//, "").split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) return null;
  return parts.join("/");
}

const isBox = (value: unknown): value is BoxMm =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every((v) => typeof v === "number" && Number.isFinite(v)) &&
  value[2] > value[0] &&
  value[3] > value[1];

/** 背景.json read: the takes it lists (newest last), and what could not be read. */
export function readManifest(text: string): { takes: BackgroundTake[]; problems: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return { takes: [], problems: [`${MANIFEST_FILE} を読めません: ${String(error)}`] };
  }
  const list = Array.isArray(data) ? data : (data as { takes?: unknown })?.takes;
  if (!Array.isArray(list)) return { takes: [], problems: [`${MANIFEST_FILE} に takes の一覧がありません`] };
  const takes: BackgroundTake[] = [];
  const problems: string[] = [];
  const seen = new Map<string, number>();
  list.forEach((item, i) => {
    const entry = item as Record<string, unknown>;
    const panel = typeof entry?.panel === "string" ? entry.panel : "";
    const files: Partial<Record<Variant, string>> = {};
    const given = (entry?.files ?? {}) as Record<string, unknown>;
    for (const variant of VARIANTS) {
      const path = folderPath(given[variant]);
      if (path) files[variant] = path;
      else if (given[variant] !== undefined) problems.push(`${i + 1} 件目: ${variant} の場所 ${String(given[variant])} は使えません`);
    }
    if (!panel || !Object.keys(files).length) {
      problems.push(`${i + 1} 件目: コマの id か画像がありません`);
      return;
    }
    const take = entry.take === undefined ? "" : String(entry.take);
    const take_ = take || String((seen.get(panel) ?? 0) + 1);
    seen.set(panel, Math.max(seen.get(panel) ?? 0, Number(take_) || 0));
    takes.push({
      panel,
      take: take_,
      files,
      ...(isBox(entry.box) ? { box: entry.box } : {}),
      ...(typeof entry.note === "string" && entry.note.trim() ? { note: entry.note.trim() } : {}),
      ...(typeof entry.request === "string" ? { request: entry.request } : {}),
    });
  });
  // The same take listed twice: the later one stands.
  const unique = new Map<string, BackgroundTake>();
  for (const take of takes) {
    unique.delete(`${take.panel}/${take.take}`);
    unique.set(`${take.panel}/${take.take}`, take);
  }
  return { takes: [...unique.values()], problems };
}

/** Where a request lists what it drew: its own file, as requests may be drawn at the same time. */
export const requestManifest = (stamp: string) => `${REQUEST_DIR}/${stamp}/${MANIFEST_FILE}`;

/**
 * The takes of every list read (背景.json of the folder, then each request's, oldest first):
 * the same take listed again, the later one stands; each problem says which file it is in.
 */
export function readManifests(files: readonly { path: string; text: string }[]): { takes: BackgroundTake[]; problems: string[] } {
  const unique = new Map<string, BackgroundTake>();
  const problems: string[] = [];
  for (const file of files) {
    const read = readManifest(file.text);
    for (const take of read.takes) {
      unique.delete(`${take.panel}/${take.take}`);
      unique.set(`${take.panel}/${take.take}`, take);
    }
    problems.push(...read.problems.map((problem) => (file.path === MANIFEST_FILE ? problem : `${file.path}: ${problem}`)));
  }
  return { takes: [...unique.values()], problems };
}

/** A panel's takes, newest first. */
export function takesFor(takes: readonly BackgroundTake[], panelId: string): BackgroundTake[] {
  return takes.filter((take) => take.panel === panelId).reverse();
}

/** The variant shown for a take: the one asked for when it has it, else the first it has. */
export function variantOf(take: BackgroundTake, wanted: Variant = "完成"): Variant | null {
  if (take.files[wanted]) return wanted;
  return VARIANTS.find((variant) => take.files[variant]) ?? null;
}

/** The number the next take of a panel gets. */
export function nextTake(takes: readonly BackgroundTake[], panelId: string): number {
  return Math.max(0, ...takes.filter((take) => take.panel === panelId).map((take) => Number(take.take) || 0)) + 1;
}

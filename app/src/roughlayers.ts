// ラフ線のレイヤー: rough lines kept apart (人物・背景・効果…), each layer shown
// or hidden, faded and locked together, and written to CSP as a layer of its
// own. A name without them has one layer, ROUGH_BASE, holding every line.
import type { Page, Project, RoughLayer, Stroke } from "./model";

/** The first layer: lines with no layer (or one that is gone) are on it. */
export const ROUGH_BASE = "rough";
export const ROUGH_BASE_NAME = "ラフ線";
export const MIN_OPACITY = 0.1;

/** Every layer of the name, bottom first: the rough's and the 指示のレイヤー (one, ROUGH_BASE, when it has none of its own). */
export function allLayersOf(project: Pick<Project, "roughLayers">): RoughLayer[] {
  return project.roughLayers?.length ? project.roughLayers : [{ id: ROUGH_BASE, name: ROUGH_BASE_NAME }];
}

/** The rough's layers, bottom first (one, ROUGH_BASE, when it has none of its own); the 指示のレイヤー are not among them. */
export function roughLayersOf(project: Pick<Project, "roughLayers">): RoughLayer[] {
  const layers = allLayersOf(project).filter((layer) => !layer.marks);
  return layers.length ? layers : [{ id: ROUGH_BASE, name: ROUGH_BASE_NAME }];
}

/** The 指示のレイヤー, bottom first. */
export function markLayersOf(project: Pick<Project, "roughLayers">): RoughLayer[] {
  return (project.roughLayers ?? []).filter((layer) => layer.marks);
}

/** The layer a line is on (a line with no layer, or one gone, is on the rough's first). */
export function layerOf(project: Pick<Project, "roughLayers">, stroke: Pick<Stroke, "layer">): RoughLayer {
  const found = stroke.layer && project.roughLayers?.find((layer) => layer.id === stroke.layer);
  if (found) return found;
  const rough = roughLayersOf(project);
  return rough.find((layer) => layer.id === ROUGH_BASE) || rough[0];
}

/** Whether a line is a 指示 (on a 指示のレイヤー). */
export function isMark(project: Pick<Project, "roughLayers">, stroke: Pick<Stroke, "layer">): boolean {
  return !!stroke.layer && !!layerOf(project, stroke).marks;
}

/** The rough lines of a page, without its 指示. */
export function withoutMarks(project: Pick<Project, "roughLayers">, strokes: Stroke[]): Stroke[] {
  if (!project.roughLayers?.some((layer) => layer.marks)) return strokes;
  return strokes.filter((stroke) => !isMark(project, stroke));
}

/** Whether the name has any 指示 (lines on a 指示のレイヤー). */
export function hasMarks(project: Pick<Project, "roughLayers" | "pages">): boolean {
  const marks = new Set(markLayersOf(project).map((layer) => layer.id));
  return marks.size > 0 && project.pages.some((page) => page.strokes.some((stroke) => !!stroke.layer && marks.has(stroke.layer)));
}

/** The 指示's colours to choose from: 赤・青・緑・橙・紫. */
export const MARK_COLORS = ["#e53935", "#1e6fd9", "#2e9b4a", "#f08a00", "#8e3fb5"] as const;
export const MARK_COLOR_NAMES: Record<(typeof MARK_COLORS)[number], string> = { "#e53935": "赤", "#1e6fd9": "青", "#2e9b4a": "緑", "#f08a00": "橙", "#8e3fb5": "紫" };
export const MARK_LAYER_NAME = "指示";

export function markColor(layer: Pick<RoughLayer, "color">): string {
  return layer.color && /^#[0-9a-f]{6}$/i.test(layer.color) ? layer.color : MARK_COLORS[0];
}

/** A new 指示のレイヤー on top, in the first colour no other has (`color`, when given). */
export function addMarkLayer(project: Project, newId: () => string, color?: string): RoughLayer {
  const layers = ownRoughLayers(project);
  const used = new Set(markLayersOf(project).map(markColor));
  const pick = color ?? MARK_COLORS.find((c) => !used.has(c)) ?? MARK_COLORS[0];
  const named = MARK_COLOR_NAMES[pick as (typeof MARK_COLORS)[number]];
  const base = used.size === 0 ? MARK_LAYER_NAME : `${MARK_LAYER_NAME}（${named ?? "色"}）`;
  const layer: RoughLayer = { id: newId(), name: freeLayerName(project, base), marks: true };
  if (pick !== MARK_COLORS[0]) layer.color = pick;
  layers.push(layer);
  return layer;
}

/** The 指示のレイヤー the 指示 tool draws on: `wanted` when it is one, else the top one; made (red, 指示) when there is none. */
export function markLayerFor(project: Project, wanted: string, newId: () => string): RoughLayer {
  const marks = markLayersOf(project);
  return marks.find((layer) => layer.id === wanted) ?? marks[marks.length - 1] ?? addMarkLayer(project, newId);
}

export function opacityOfLayer(layer: RoughLayer): number {
  return Math.min(1, Math.max(MIN_OPACITY, layer.opacity ?? 1));
}

/** Lines that can be drawn over, erased and picked: on a layer shown and not locked. */
export function strokeEditable(project: Pick<Project, "roughLayers">, stroke: Pick<Stroke, "layer">): boolean {
  if (!project.roughLayers?.length) return true;
  const layer = layerOf(project, stroke);
  return !layer.hidden && !layer.locked;
}

/** The page without the lines of hidden layers. */
export function shownStrokes(project: Pick<Project, "roughLayers">, strokes: Stroke[]): Stroke[] {
  if (!project.roughLayers?.some((layer) => layer.hidden)) return strokes;
  return strokes.filter((stroke) => !layerOf(project, stroke).hidden);
}

/** A page's lines on `layer`. */
export function strokesOn(project: Pick<Project, "roughLayers">, strokes: Stroke[], layer: RoughLayer): Stroke[] {
  if (!project.roughLayers?.length || project.roughLayers.length === 1) return strokes;
  return strokes.filter((stroke) => layerOf(project, stroke).id === layer.id);
}

/** The layers as the name's own list, to change (the one implied made real). */
export function ownRoughLayers(project: Project): RoughLayer[] {
  if (!project.roughLayers?.length) project.roughLayers = [{ id: ROUGH_BASE, name: ROUGH_BASE_NAME }];
  return project.roughLayers;
}

/** A name not taken by another layer: `name`, else `name 2`, `name 3`… */
export function freeLayerName(project: Pick<Project, "roughLayers">, name: string, except?: string): string {
  const taken = new Set(
    allLayersOf(project)
      .filter((layer) => layer.id !== except)
      .map((layer) => layer.name),
  );
  const base = name.trim() || ROUGH_BASE_NAME;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** A new layer above `above` (else on top). */
export function addRoughLayer(project: Project, name: string, newId: () => string, above?: string): RoughLayer {
  const layers = ownRoughLayers(project);
  const layer: RoughLayer = { id: newId(), name: freeLayerName(project, name) };
  const at = above ? layers.findIndex((l) => l.id === above) : -1;
  layers.splice(at >= 0 ? at + 1 : layers.length, 0, layer);
  return layer;
}

export function renameRoughLayer(project: Project, id: string, name: string): void {
  const layer = ownRoughLayers(project).find((l) => l.id === id);
  if (layer) layer.name = freeLayerName(project, name, id);
}

/** Change how a layer is shown (hidden, opacity, locked). */
export function setRoughLayer(project: Project, id: string, change: Partial<Pick<RoughLayer, "hidden" | "opacity" | "locked" | "color">>): void {
  const layer = ownRoughLayers(project).find((l) => l.id === id);
  if (!layer) return;
  for (const [key, value] of Object.entries(change) as [keyof typeof change, unknown][]) {
    if (key === "color") {
      // A 指示のレイヤー's colour; red is none.
      if (!layer.marks) continue;
      if (value && value !== MARK_COLORS[0]) layer.color = String(value);
      else delete layer.color;
      continue;
    }
    const off = key === "opacity" ? value === undefined || (value as number) >= 1 : !value;
    if (off) delete layer[key];
    else if (key === "opacity") layer.opacity = Math.max(MIN_OPACITY, Math.round((value as number) * 100) / 100);
    else layer[key] = true;
  }
}

/** The next layer up (+1) or down (-1) from `at` of the same kind (rough or 指示); -1: none. */
function neighbourOf(layers: RoughLayer[], at: number, step: 1 | -1): number {
  for (let i = at + step; i >= 0 && i < layers.length; i += step) if (!!layers[i].marks === !!layers[at].marks) return i;
  return -1;
}

/** Move a layer one step up (+1, nearer the top) or down (-1), among the rough's layers or the 指示のレイヤー. */
export function moveRoughLayer(project: Project, id: string, step: 1 | -1): boolean {
  const layers = ownRoughLayers(project);
  const at = layers.findIndex((l) => l.id === id);
  const to = at < 0 ? -1 : neighbourOf(layers, at, step);
  if (at < 0 || to < 0) return false;
  [layers[at], layers[to]] = [layers[to], layers[at]];
  return true;
}

/** Put `ids` of `page` on `layerId`; how many moved. */
export function moveStrokesToLayer(project: Project, page: Page, ids: readonly string[], layerId: string): number {
  let moved = 0;
  page.strokes = page.strokes.map((stroke) => {
    if (!ids.includes(stroke.id) || layerOf(project, stroke).id === layerId) return stroke;
    moved++;
    const next: Stroke = { ...stroke, layer: layerId };
    if (layerId === ROUGH_BASE) delete next.layer;
    return next;
  });
  return moved;
}

/** Lines on a layer, over all pages. */
export function layerStrokeCount(project: Project, id: string): number {
  return project.pages.reduce((sum, page) => sum + page.strokes.filter((stroke) => layerOf(project, stroke).id === id).length, 0);
}

/**
 * Remove a layer with its lines (the name keeps at least one layer); how many
 * lines went. 下と結合 instead puts them on the layer below.
 */
export function removeRoughLayer(project: Project, id: string, mergeDown: boolean): number {
  const layers = project.roughLayers ?? [];
  const at = layers.findIndex((l) => l.id === id);
  // The rough keeps one layer; 指示のレイヤー can all go.
  if (at < 0 || (!layers[at].marks && roughLayersOf(project).length < 2)) return 0;
  const below = mergeDown ? layers[neighbourOf(layers, at, -1)] : undefined;
  if (mergeDown && !below) return 0;
  let count = 0;
  for (const page of project.pages) {
    const on = page.strokes.filter((stroke) => layerOf(project, stroke).id === id).map((stroke) => stroke.id);
    count += on.length;
    if (below) moveStrokesToLayer(project, page, on, below.id);
    else page.strokes = page.strokes.filter((stroke) => !on.includes(stroke.id));
  }
  layers.splice(at, 1);
  if (layers.length === 1 && layers[0].id === ROUGH_BASE && !layers[0].hidden && !layers[0].opacity && !layers[0].locked && !layers[0].marks && layers[0].name === ROUGH_BASE_NAME) {
    delete project.roughLayers;
  }
  return count;
}

/**
 * The CSP layer names of each layer's lines (under the panel borders) and
 * its はみ出し (over them), unlike each other and the page's other layers;
 * a 指示のレイヤー has one name (`under`).
 */
export function roughExportNames(project: Pick<Project, "roughLayers">, reserved: readonly string[]): Map<string, { under: string; over: string }> {
  const taken = new Set(reserved);
  const names = new Map<string, { under: string; over: string }>();
  const free = (name: string) => {
    let candidate = name;
    for (let n = 2; taken.has(candidate); n++) candidate = `${name} ${n}`;
    taken.add(candidate);
    return candidate;
  };
  for (const layer of roughLayersOf(project)) {
    // One layer as before: ラフ線 and はみ出し（ラフ線）.
    const under = free(layer.name);
    names.set(layer.id, { under, over: free(`はみ出し（${under}）`) });
  }
  // A 指示のレイヤー is one CSP layer, over and under the borders alike.
  for (const layer of markLayersOf(project)) names.set(layer.id, { under: free(layer.name), over: "" });
  return names;
}

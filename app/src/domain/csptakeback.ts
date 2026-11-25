// Taking what was drawn in CSP back into the name: vector lines drawn,
// changed or deleted on the pages since the export (they become the name's
// rough lines), the コマ枠 changed there (the name's panels), and pictures
// drawn on image layers (pages' CSP の絵, made by service/csptakeback.ts).
//
// The name is what counts: what the export (or the last take-back)
// recorded of each line tells CSP's changes from the name's own, a part
// changed in the name since stays as the name has it, and nothing goes
// without being listed (see `planCspTakeBack`).

import type { CspFrameFolder, CspLine, CspPageContent, LineRecord } from "../generated/ipc";
import { bounds, centroid } from "../model/geometry";
import type { BoxMm, Brush, Panel, Point, Project, ReferenceImage, RoughLayer, StoredImage, Stroke, StrokePoint } from "../model/model";
import { cspSettingsFor, newBrush } from "./cspsettings";
import { lineSignature, valueHash } from "./linesig";
import { emptyPage, newId } from "./project";
import { addPanel, removePanel } from "./panels";
import { orderPanels, assignPanels } from "./readingorder";
import { ownRoughLayers, freeLayerName } from "./roughlayers";
import { applySketch, fitOutline } from "./sketchpanels";
import { applyCspPages, cspPagesSummary, type CspPages, noPages } from "./csppages";
import { applyTakeBack } from "./readback";

/** Canvas px = mm × scale + offset. */
export interface Place {
  scale: number;
  x: number;
  y: number;
}

/** One page file read back: where the name's pages lie on it, and what it holds. */
export interface PageRead {
  path: string;
  /** The name's pages in it (two on a 見開き page) and where each lies. */
  places: { page: number; m: Place; right: boolean }[];
  /** The gutter of a 見開き page (canvas px); null on a single page. */
  gutterPx: number | null;
  content: CspPageContent;
  /** A page added in CSP (nothing of it was recorded: every line on it is new). */
  added?: boolean;
}

/** What the name's layers are called in CSP (see nameexport.ts). */
export interface CspLayerNames {
  /** CSP layer name → the ラフ線のレイヤー (its id) and whether it holds the はみ出し. */
  rough: Map<string, { layer: string; over: boolean }>;
  /** The vector コマ枠 layer. */
  panels: string;
  /** The コマ枠フォルダー the export writes. */
  frames: string;
  /** Vector layers whose lines are the name's own drawing (the balloons): never taken back. */
  own: Set<string>;
}

// --- keys: what of the name a line is -----------------------------------------------------

/** A stroke's key: its id and the fingerprint of its shape and look. */
export function strokeKey(stroke: Stroke): string {
  return `s:${stroke.id}:${valueHash([stroke.points, stroke.widthMm, stroke.closed, stroke.color ?? null, stroke.brush ?? null, !!stroke.over])}`;
}

/** A panel's key (its border lines, its frame). */
export function panelKey(panel: Panel): string {
  return `p:${panel.id}:${valueHash([panel.shape, panel.border ?? "solid", panel.openEdges ?? [], panel.lineMm ?? null])}`;
}

/** A picture's key (CSP の絵). */
export function pictureKey(reference: ReferenceImage): string {
  return `d:${reference.id}`;
}

/** A page's key (one added in CSP). */
export function pageKey(id: string): string {
  return `g:${id}`;
}

type Key = { kind: "s" | "p" | "d" | "g"; id: string; hash: string };

function parseKey(key: string | null | undefined): Key | null {
  const match = key ? /^([spdg]):([^:]+)(?::(.*))?$/.exec(key) : null;
  return match ? { kind: match[1] as Key["kind"], id: match[2], hash: match[3] ?? "" } : null;
}

/** Whether what `key` names is in the name still, as it was then. */
function keyState(project: Project, pages: readonly number[], key: Key): "same" | "changed" | "gone" {
  if (key.kind === "g") return project.pages.some((page) => page.id === key.id) ? "same" : "gone";
  for (const index of pages) {
    const page = project.pages[index];
    if (key.kind === "s") {
      const stroke = page.strokes.find((s) => s.id === key.id);
      if (stroke) return strokeKey(stroke) === `s:${key.id}:${key.hash}` ? "same" : "changed";
    } else if (key.kind === "p") {
      const panel = page.panels.find((p) => p.id === key.id);
      if (panel) return panelKey(panel) === `p:${key.id}:${key.hash}` ? "same" : "changed";
    } else if (page.references?.some((reference) => reference.id === key.id)) return "same";
  }
  return "gone";
}

/** Whether anything `keys` names is still in the name (a take-back not undone). */
function anyLeft(project: Project, keys: readonly string[]): boolean {
  return keys.some((key) => {
    const parsed = parseKey(key);
    return !!parsed && project.pages.some((_, index) => keyState(project, [index], parsed) !== "gone");
  });
}

// --- the plan ----------------------------------------------------------------------------

/** A line to add to the name: on `page`, on the rough layer `layer` (or a new one named `newLayer`). */
export interface StrokeAdd {
  ref: string;
  page: number;
  cspLayer: string;
  layer: string | null;
  newLayer?: string;
  stroke: Omit<Stroke, "id">;
}

export interface StrokeChange {
  ref: string;
  page: number;
  cspLayer: string;
  stroke: string;
  points: StrokePoint[];
  widthMm: number;
  closed: boolean;
  color?: string;
}

export interface StrokeRemove {
  ref: string;
  page: number;
  cspLayer: string;
  stroke: string;
}

export interface PanelChange {
  ref: string;
  page: number;
  panel: string;
  shape: Point[];
  /** From a コマ枠フォルダー's frame (else the vector コマ枠). */
  frame?: boolean;
}

/** A line drawn on the コマ枠 layer: read as コマ割り's 描く (a panel, a cut, a join). */
export interface PanelSketch {
  ref: string;
  page: number;
  points: Point[];
}

export interface PanelAdd {
  ref: string;
  page: number;
  shape: Point[];
}

export interface PanelRemove {
  ref: string;
  page: number;
  panel: string;
}

/** A picture drawn on an image layer in CSP (made by the service). */
export interface PictureAdd {
  ref: string;
  page: number;
  cspLayer: string;
  /** The name's layer it goes on (the CSP layer's, or 「…（CSP）」 for one of the name's own). */
  layer: string;
  box: BoxMm;
  image: Omit<StoredImage, "id">;
  opacity?: number;
  /** A layer hidden in CSP: not ticked to start with. */
  hidden?: boolean;
}

/** One line of a page's record as it will be once taken back. */
interface PendingLine {
  sig: string;
  key: string | null;
  /** The change that makes it the name's (its key then). */
  ref?: string;
}

/** What to record of each page file once taken back. */
export interface PagePending {
  path: string;
  pages: number[];
  lines: Record<string, PendingLine[]>;
  pixels: Record<string, string>;
  pageIds: string[];
}

export interface CspTakeBack {
  strokesAdded: StrokeAdd[];
  strokesChanged: StrokeChange[];
  strokesRemoved: StrokeRemove[];
  panelsChanged: PanelChange[];
  panelSketches: PanelSketch[];
  panelsAdded: PanelAdd[];
  panelsRemoved: PanelRemove[];
  pictures: PictureAdd[];
  /** Changed in CSP and in the name since: the name's stands. */
  conflicts: string[];
  /** Changes not taken back, to say. */
  notes: string[];
  pending: PagePending[];
  /** The work's pages added, deleted and moved in CSP (domain/csppages.ts). */
  pages: CspPages;
}

export function emptyTakeBack(): CspTakeBack {
  return {
    strokesAdded: [],
    strokesChanged: [],
    strokesRemoved: [],
    panelsChanged: [],
    panelSketches: [],
    panelsAdded: [],
    panelsRemoved: [],
    pictures: [],
    conflicts: [],
    notes: [],
    pending: [],
    pages: noPages(),
  };
}

/** How many changes there are to pick from. */
export function changeCount(plan: CspTakeBack): number {
  return (
    plan.strokesAdded.length +
    plan.strokesChanged.length +
    plan.strokesRemoved.length +
    plan.panelsChanged.length +
    plan.panelSketches.length +
    plan.panelsAdded.length +
    plan.panelsRemoved.length +
    plan.pictures.length +
    plan.pages.added.length +
    plan.pages.held.length +
    (plan.pages.move ? 1 : 0)
  );
}

/** The record to compare with: what was recorded, or before the last take-back when the name undid it. */
export function baselineOf(
  project: Project,
  content: CspPageContent,
): { lines: Record<string, LineRecord[]>; pixels: Record<string, string> } {
  const record = content.record;
  const taken = record.taken;
  if (taken?.keys.length && !anyLeft(project, taken.keys)) return { lines: taken.lines ?? {}, pixels: taken.pixels ?? {} };
  return { lines: record.lines ?? {}, pixels: record.pixels ?? {} };
}

/** The last part of a layer name after its folders. */
export function baseName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

const toMm = (m: Place, [x, y]: readonly number[]): Point => [(x - m.x) / m.scale, (y - m.y) / m.scale];

/** The name's page of a unit a shape (canvas px) is on: by its middle on a 見開き page. */
function placeOf(read: PageRead, points: readonly (readonly number[])[]): PageRead["places"][number] {
  if (read.places.length < 2 || read.gutterPx === null || !points.length) return read.places[0];
  const [x0, , x1] = bounds(points);
  const right = (x0 + x1) / 2 >= read.gutterPx;
  return read.places.find((place) => place.right === right) ?? read.places[0];
}

const hex = ([r, g, b]: readonly number[]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** A CSP line on the name's page, in mm. */
function lineToStroke(line: CspLine, m: Place): Omit<Stroke, "id" | "layer" | "brush"> {
  const points = line.points.map((point): StrokePoint => {
    const [x, y] = toMm(m, point);
    return [x, y, Math.max(0, Math.min(1, point[2]))];
  });
  const color = line.color.some((value) => value !== 0) ? hex(line.color) : undefined;
  return { points, widthMm: line.widthPx / m.scale, closed: line.closed, ...(color ? { color } : {}) };
}

/**
 * How alike two shapes are where they lie (0..1): the share of the smaller
 * box both cover. The boxes are taken a unit larger all round, so a straight
 * line (a box of no height) still overlaps what it lies along.
 */
function overlapOf(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): number {
  const grow = ([x0, y0, x1, y1]: readonly number[]) => [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
  const [ax0, ay0, ax1, ay1] = grow(bounds(a));
  const [bx0, by0, bx1, by1] = grow(bounds(b));
  const w = Math.min(ax1, bx1) - Math.max(ax0, bx0);
  const h = Math.min(ay1, by1) - Math.max(ay0, by0);
  const smaller = Math.max(
    1e-6,
    Math.min(Math.max(ax1 - ax0, 1) * Math.max(ay1 - ay0, 1), Math.max(bx1 - bx0, 1) * Math.max(by1 - by0, 1)),
  );
  return w <= 0 || h <= 0 ? 0 : (Math.max(w, 1) * Math.max(h, 1)) / smaller;
}

/** Whether a line spans less of a panel's outline than its whole box (an edge of it, a piece). */
function partOfOutline(shape: readonly (readonly number[])[] | null, line: readonly (readonly number[])[]): boolean {
  if (!shape) return false;
  const [sx0, sy0, sx1, sy1] = bounds(shape);
  const [lx0, ly0, lx1, ly1] = bounds(line);
  return lx1 - lx0 < (sx1 - sx0) * 0.8 || ly1 - ly0 < (sy1 - sy0) * 0.8;
}

/**
 * For a page written before lines were recorded: what to compare a layer
 * with (null: nothing, every line is new), or "skip" to leave the layer be.
 */
export type Unrecorded = (read: PageRead, layer: string) => LineRecord[] | null | "skip";

/**
 * Compare each page file `reads` with what was recorded of it, into the
 * changes to take back (nothing is changed yet). `unrecorded` gives the
 * name's lines for files written by a version that recorded none.
 */
export function planCspTakeBack(project: Project, reads: readonly PageRead[], names: CspLayerNames, unrecorded: Unrecorded): CspTakeBack {
  const plan = emptyTakeBack();
  let refs = 0;
  const ref = () => `c${refs++}`;
  const where = (page: number) => `${page + 1}p`;
  // The name's own layers left be on pages written before lines were recorded: their pages, by layer.
  const unread = new Map<string, number[]>();
  for (const read of reads) {
    const pages = read.places.map((place) => place.page);
    const baseline = baselineOf(project, read.content);
    const pending: PagePending = {
      path: read.path,
      pages,
      lines: {},
      pixels: Object.fromEntries(read.content.rasters.map((raster) => [raster.name, raster.sig])),
      pageIds: pages.map((index) => project.pages[index].id),
    };
    plan.pending.push(pending);
    // Layers of the name's own on a page written before lines were recorded, changed since.
    const skipped = new Set<string>();
    const lineLayers: { name: string; lines: { sig: string; points: number[][]; line?: CspLine }[]; frames?: boolean }[] = [
      ...read.content.vectors.map((layer) => ({
        name: layer.name,
        lines: layer.lines.map((line) => ({ sig: line.sig, points: line.points, line })),
      })),
      ...read.content.frames.map((folder: CspFrameFolder) => ({
        name: folder.name,
        frames: true,
        lines: folder.frames.map((frame) => ({ sig: frame.sig, points: frame.points })),
      })),
    ];
    for (const layer of lineLayers) {
      const base = baseName(layer.name);
      const fallback = baseline.lines[layer.name] ? null : unrecorded(read, layer.name);
      if (fallback === "skip") {
        skipped.add(base);
        continue;
      }
      const recorded = baseline.lines[layer.name] ?? fallback ?? [];
      // Lines as recorded: the name's (or left in CSP before).
      const left = [...recorded];
      const lines: PendingLine[] = [];
      const added: typeof layer.lines = [];
      for (const line of layer.lines) {
        const at = left.findIndex((entry) => entry.sig === line.sig);
        if (at >= 0) {
          lines.push({ sig: line.sig, key: left[at].key ?? null });
          left.splice(at, 1);
        } else added.push(line);
      }
      pending.lines[layer.name] = lines;
      if (names.own.has(base)) {
        if (added.length || left.some((entry) => entry.key))
          plan.notes.push(`${where(pages[0])}: CSP で変えた「${base}」の線は読み戻しません（フキダシはネームの形のままです）`);
        for (const line of added) lines.push({ sig: line.sig, key: null });
        continue;
      }
      const isPanels = layer.frames ? true : base === names.panels;
      // Recorded lines gone from CSP: deleted there, or changed (one new line in their place).
      const gone = left
        .map((entry) => ({ entry, key: parseKey(entry.key) }))
        .filter(({ key }) => key && key.kind === (isPanels ? "p" : "s"));
      // The name's shape of what each gone entry was, to pair with the new lines by place.
      const shapeOf = (key: Key): number[][] | null => {
        for (const place of read.places) {
          const page = project.pages[place.page];
          const found =
            key.kind === "s" ? page.strokes.find((s) => s.id === key.id)?.points : page.panels.find((p) => p.id === key.id)?.shape;
          if (found) return found.map(([x, y]) => [x * place.m.scale + place.m.x, y * place.m.scale + place.m.y]);
        }
        return null;
      };
      const pairs: { g: number; a: number; score: number }[] = [];
      gone.forEach(({ key }, g) => {
        const shape = shapeOf(key!);
        if (!shape) return;
        added.forEach((line, a) => {
          const score = overlapOf(shape, line.points);
          if (score > 0.5) pairs.push({ g, a, score });
        });
      });
      pairs.sort((p, q) => q.score - p.score);
      const [pairedGone, pairedAdded] = [new Map<number, number>(), new Map<number, number>()];
      for (const pair of pairs) {
        if (pairedGone.has(pair.g) || pairedAdded.has(pair.a)) continue;
        pairedGone.set(pair.g, pair.a);
        pairedAdded.set(pair.a, pair.g);
      }
      const multi = (entry: LineRecord) => recorded.filter((other) => other.key === entry.key).length > 1;
      const noted = new Set<string>();
      gone.forEach(({ entry, key }, g) => {
        const state = keyState(project, pages, key!);
        const a = pairedGone.get(g);
        if (state === "gone") return;
        if (state === "changed") {
          plan.conflicts.push(
            `${where(pages[0])}: CSP でも変えた${isPanels ? "コマ" : "線"}（「${base}」）は、ネームでも変えていたのでネームのままです`,
          );
          if (a !== undefined) lines.push({ sig: added[a].sig, key: null });
          return;
        }
        // A panel drawn as several lines or as part of its outline (点線, 波線, 裁ち切り, 重なり) is not one shape to take.
        if (isPanels && !layer.frames && (multi(entry) || (a !== undefined && partOfOutline(shapeOf(key!), added[a].points)))) {
          if (!noted.has(entry.key!))
            plan.notes.push(`${where(pages[0])}: 点線・波線・裁ち切りのコマの枠を CSP で変えたものは読み戻しません`);
          noted.add(entry.key!);
          if (a !== undefined) lines.push({ sig: added[a].sig, key: entry.key! });
          return;
        }
        const r = ref();
        if (a !== undefined) {
          const line = added[a];
          const place = placeOf(read, line.points);
          if (isPanels) {
            const shape = line.points.map((point) => toMm(place.m, point));
            plan.panelsChanged.push({
              ref: r,
              page: place.page,
              panel: key!.id,
              shape: shape.length > 12 ? fitOutline(shape) : shape,
              frame: layer.frames,
            });
          } else {
            const stroke = lineToStroke(line.line!, place.m);
            plan.strokesChanged.push({ ref: r, page: place.page, cspLayer: base, stroke: key!.id, ...stroke });
          }
          lines.push({ sig: line.sig, key: null, ref: r });
        } else if (isPanels) {
          plan.panelsRemoved.push({
            ref: r,
            page: pages.find((p) => project.pages[p].panels.some((panel) => panel.id === key!.id)) ?? pages[0],
            panel: key!.id,
          });
        } else {
          plan.strokesRemoved.push({
            ref: r,
            page: pages.find((p) => project.pages[p].strokes.some((s) => s.id === key!.id)) ?? pages[0],
            cspLayer: base,
            stroke: key!.id,
          });
        }
      });
      // Lines new in CSP.
      added.forEach((line, a) => {
        if (pairedAdded.has(a)) return;
        const place = placeOf(read, line.points);
        const r = ref();
        lines.push({ sig: line.sig, key: null, ref: r });
        if (layer.frames) {
          const shape = line.points.map((point) => toMm(place.m, point));
          // A frame where a panel of the name is: that panel's new shape; else a new panel.
          const page = project.pages[place.page];
          const like = page.panels
            .map((panel) => ({ panel, score: overlapOf(panel.shape, shape) * overlapOf(shape, panel.shape) }))
            .filter(({ score }) => score > 0.8)
            .sort((p, q) => q.score - p.score)[0];
          if (like) {
            if (Math.max(...shape.map((p) => Math.min(...like.panel.shape.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))))) > 0.5)
              plan.panelsChanged.push({ ref: r, page: place.page, panel: like.panel.id, shape, frame: true });
            else lines[lines.length - 1] = { sig: line.sig, key: panelKey(like.panel) };
          } else plan.panelsAdded.push({ ref: r, page: place.page, shape });
          return;
        }
        if (isPanels) {
          const points = line.points.map((point) => toMm(place.m, point));
          plan.panelSketches.push({ ref: r, page: place.page, points: line.line?.closed ? [...points, points[0]] : points });
          return;
        }
        const stroke = lineToStroke(line.line!, place.m);
        const rough = names.rough.get(base);
        plan.strokesAdded.push({
          ref: r,
          page: place.page,
          cspLayer: base,
          layer: rough?.layer ?? project.roughLayers?.find((l) => l.name === base && !l.marks)?.id ?? null,
          ...(rough || project.roughLayers?.some((l) => l.name === base && !l.marks) ? {} : { newLayer: base }),
          stroke: { ...stroke, ...(rough?.over ? { over: true } : {}) },
        });
      });
    }
    if (skipped.size) for (const name of skipped) (unread.get(name) ?? unread.set(name, []).get(name)!).push(pages[0]);
  }
  for (const [name, pages] of unread)
    plan.notes.push(
      `${pages.map((page) => where(page)).join("・")}: 前のバージョンで書き出したページなので、CSP で「${name}」の線を変えていても読み戻しません（ネームでも変えていると、どちらの変更か分からないため）`,
    );
  return plan;
}

// --- picking and applying ----------------------------------------------------------------

/** The changes whose `ref` `keep` says to take back. */
export function pickCspTakeBack(plan: CspTakeBack, keep: ReadonlySet<string>): CspTakeBack {
  // What is on a page added in CSP goes with it.
  const dropped = new Set(plan.pages.added.filter((add) => !keep.has(add.ref)).map((add) => add.page));
  const only = <T extends { ref: string; page?: number | string }>(list: T[]) =>
    list.filter((item) => keep.has(item.ref) && !(typeof item.page === "number" && dropped.has(item.page)));
  return {
    ...plan,
    strokesAdded: only(plan.strokesAdded),
    strokesChanged: only(plan.strokesChanged),
    strokesRemoved: only(plan.strokesRemoved),
    panelsChanged: only(plan.panelsChanged),
    panelSketches: only(plan.panelSketches),
    panelsAdded: only(plan.panelsAdded),
    panelsRemoved: only(plan.panelsRemoved),
    pictures: only(plan.pictures),
    pages: {
      ...plan.pages,
      added: only(plan.pages.added),
      held: only(plan.pages.held),
      move: plan.pages.move && keep.has(plan.pages.move.ref) ? plan.pages.move : null,
    },
  };
}

/** Every change's ref. */
export function allRefs(plan: CspTakeBack): string[] {
  return [
    ...plan.strokesAdded,
    ...plan.strokesChanged,
    ...plan.strokesRemoved,
    ...plan.panelsChanged,
    ...plan.panelSketches,
    ...plan.panelsAdded,
    ...plan.panelsRemoved,
    ...plan.pictures,
    ...plan.pages.added,
    ...plan.pages.held,
    ...(plan.pages.move ? [plan.pages.move] : []),
  ].map((item) => item.ref);
}

/** Changes not ticked to start with: removing panels and pages, and layers hidden in CSP. */
export function startsUnticked(plan: CspTakeBack): Set<string> {
  return new Set([
    ...plan.panelsRemoved.map((item) => item.ref),
    ...plan.pictures.filter((item) => item.hidden).map((item) => item.ref),
    ...plan.pages.held.map((item) => item.ref),
  ]);
}

/** The changes on a page added in CSP (they go with it). */
export function onAddedPage(plan: CspTakeBack, page: number): string[] {
  return [
    ...plan.strokesAdded,
    ...plan.strokesChanged,
    ...plan.strokesRemoved,
    ...plan.panelsChanged,
    ...plan.panelSketches,
    ...plan.panelsAdded,
    ...plan.panelsRemoved,
    ...plan.pictures,
  ]
    .filter((item) => item.page === page)
    .map((item) => item.ref);
}

/** The pen CSP's lines are taken back with: their width follows the pressure kept in the points as it is. */
export function readBackBrush(project: Project): Brush {
  const found = project.brushes.find((brush) => brush.source === CSP_LINE_SOURCE);
  if (found) return found;
  const brush = newBrush("pen", newId(project, "brush"), "CSP の線");
  brush.sizePressure = { min: 0 };
  brush.stabilization = 0;
  brush.source = CSP_LINE_SOURCE;
  brush.csp = cspSettingsFor(brush);
  project.brushes.push(brush);
  return brush;
}

export const CSP_LINE_SOURCE = "csp-readback";

/** The rough layer named `name`, made when the name has none. */
function roughLayerNamed(project: Project, name: string): RoughLayer {
  const found = project.roughLayers?.find((layer) => layer.name === name && !layer.marks);
  if (found) return found;
  const layer: RoughLayer = { id: newId(project, "layer"), name: freeLayerName(project, name) };
  ownRoughLayers(project).push(layer);
  return layer;
}

/** What applying made, by change: the keys to record. */
export type Made = Map<string, string>;

/**
 * Make the changes `plan` lists in the name; what each made, by its ref.
 * `pictures` are added to the project's pictures as they are given.
 */
export function applyCspTakeBack(project: Project, plan: CspTakeBack): Made {
  const made: Made = new Map();
  // Pages added in CSP: made at the end of the name, where their changes were planned, and moved to their place last.
  const ids = new Map<string, string>();
  const placeholders = new Set<string>();
  const last = Math.max(-1, ...plan.pages.added.map((add) => add.page));
  for (let index = project.pages.length; index <= last; index++) {
    const page = emptyPage(newId(project, "page"));
    project.pages.push(page);
    const add = plan.pages.added.find((a) => a.page === index);
    if (add) {
      ids.set(add.key, page.id);
      made.set(add.ref, pageKey(page.id));
    } else placeholders.add(page.id);
  }
  const findStroke = (page: number, id: string) => project.pages[page]?.strokes.find((stroke) => stroke.id === id);
  const findPanel = (page: number, id: string) => project.pages[page]?.panels.find((panel) => panel.id === id);
  const brush = () => readBackBrush(project);
  for (const change of plan.strokesChanged) {
    const stroke = findStroke(change.page, change.stroke) ?? project.pages.flatMap((p) => p.strokes).find((s) => s.id === change.stroke);
    if (!stroke) continue;
    Object.assign(stroke, { points: change.points, widthMm: change.widthMm, closed: change.closed, brush: brush().id });
    if (change.color) stroke.color = change.color;
    else delete stroke.color;
    delete stroke.cut;
    made.set(change.ref, strokeKey(stroke));
  }
  for (const change of plan.strokesRemoved) {
    for (const page of project.pages) page.strokes = page.strokes.filter((stroke) => stroke.id !== change.stroke);
  }
  for (const change of plan.strokesAdded) {
    const page = project.pages[change.page];
    const layer = change.layer ?? (change.newLayer ? roughLayerNamed(project, change.newLayer).id : undefined);
    const stroke: Stroke = { ...change.stroke, id: newId(project, "stroke"), brush: brush().id, ...(layer ? { layer } : {}) };
    page.strokes.push(stroke);
    made.set(change.ref, strokeKey(stroke));
  }
  for (const change of plan.panelsChanged) {
    const panel = findPanel(change.page, change.panel);
    if (!panel) continue;
    panel.shape = change.shape;
    delete panel.openEdges;
    const page = project.pages[change.page];
    orderPanels(page, project.binding);
    assignPanels(page);
    made.set(change.ref, panelKey(panel));
  }
  for (const change of plan.panelsAdded) {
    const page = project.pages[change.page];
    const panel = addPanel(project, page, change.shape);
    made.set(change.ref, panelKey(panel));
  }
  for (const change of plan.panelSketches) {
    const page = project.pages[change.page];
    if (page) applySketch(project, page, change.points);
  }
  for (const change of plan.panelsRemoved) {
    const page = project.pages[change.page];
    if (page?.panels.some((panel) => panel.id === change.panel)) removePanel(page, change.panel, project.binding);
  }
  for (const change of plan.pictures) {
    const page = project.pages[change.page];
    const image: StoredImage = { ...change.image, id: newId(project, "image") };
    project.images = [...(project.images ?? []), image];
    const reference: ReferenceImage = {
      id: newId(project, "reference"),
      image: image.id,
      box: change.box,
      kind: "drawing",
      layer: change.layer,
      ...(change.opacity !== undefined && change.opacity < 1 ? { opacity: change.opacity } : {}),
    };
    page.references = [...(page.references ?? []), reference];
    made.set(change.ref, pictureKey(reference));
  }
  const texts = plan.pages.added.flatMap((add) => add.texts);
  if (texts.length)
    applyTakeBack(project, { retyped: [], added: texts, removed: [], conflicts: [], unrecorded: [], missing: [], paths: [] });
  if (ids.size || placeholders.size || plan.pages.held.length || plan.pages.move) applyCspPages(project, plan.pages, ids, placeholders);
  return made;
}

/** The pages added in CSP that `made` made: each one's key in the plan → its page's id. */
function addedPageIds(plan: CspTakeBack, made: Made): Map<string, string> {
  const ids = new Map<string, string>();
  for (const add of plan.pages.added) {
    const key = parseKey(made.get(add.ref));
    if (key) ids.set(add.key, key.id);
  }
  return ids;
}

/** The pages added in CSP that `made` made (their ids), for the record of the work. */
export function madePages(plan: CspTakeBack, made: Made): string[] {
  return [...addedPageIds(plan, made).values()];
}

/** What to record of each page once `made` is in the name (see `Adoption` on the Rust side). */
export function adoptions(
  plan: CspTakeBack,
  made: Made,
): {
  path: string;
  adoption: { lines: Record<string, LineRecord[]>; pixels: Record<string, string>; pageIds: string[]; made: string[] };
}[] {
  const keys = [...made.values()];
  const pageIds = addedPageIds(plan, made);
  // A page added in CSP and not taken: none of the name's pages are in it.
  const added = new Set(plan.pages.added.map((add) => add.key));
  return plan.pending.map((page) => ({
    path: page.path,
    adoption: {
      lines: Object.fromEntries(
        Object.entries(page.lines).map(([layer, lines]) => [
          layer,
          lines.map((line) => {
            const key = line.ref ? (made.get(line.ref) ?? null) : line.key;
            return key ? { sig: line.sig, key } : { sig: line.sig };
          }),
        ]),
      ),
      pixels: page.pixels,
      pageIds: page.pageIds.flatMap((id) => (pageIds.has(id) ? [pageIds.get(id)!] : added.has(id) ? [] : [id])),
      made: keys,
    },
  }));
}

/** What taking back would do, in a few lines. */
export function cspTakeBackSummary(plan: CspTakeBack): string[] {
  const lines: string[] = [];
  const count = (n: number, what: string) => (n ? [`${what} ${n}`] : []);
  const parts = [
    ...count(plan.strokesAdded.length, "CSP で描いた線"),
    ...count(plan.strokesChanged.length, "CSP で直した線"),
    ...count(plan.strokesRemoved.length, "CSP で消した線"),
    ...count(plan.panelsChanged.length, "形を変えたコマ"),
    ...count(plan.panelSketches.length + plan.panelsAdded.length, "足した・割ったコマ"),
    ...count(plan.panelsRemoved.length, "消したコマ"),
    ...count(plan.pictures.length, "CSP で描いた絵"),
  ];
  if (parts.length) lines.push(parts.join("・"));
  lines.push(...cspPagesSummary(plan.pages), ...plan.conflicts, ...plan.notes, ...plan.pages.notes);
  return lines;
}

/** Panels the name has on `page`: to say which one a change is. */
export function panelLabel(project: Project, page: number, id: string): string {
  const panel = project.pages[page]?.panels.find((p) => p.id === id);
  return panel ? `コマ ${panel.order}` : "コマ";
}

/** Where a line is on its page, to say: its middle in mm. */
export function middleOf(points: readonly (readonly number[])[]): Point {
  return points.length ? centroid(points.map(([x, y]) => [x, y] as Point)) : [0, 0];
}

export { lineSignature };

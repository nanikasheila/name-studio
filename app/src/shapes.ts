// 話の型: the built-in story shapes (起承転結, Save the Cat and the like) and
// the ones made for a name (オリジナルの型), laid over its pages.
import { STRUCTURES, type Project, type ShapePart, type StoryShape } from "./project";
import { readJson, writeJson } from "./settings";

/** Colours of the parts, in turn; used wherever pages are shown by part. */
export const PART_COLORS = ["#4f86d9", "#e0884a", "#3fae84", "#c9a227", "#d97aa6", "#7d6bd6", "#5aa9c9", "#c25b5b"];

/** Every shape the name can use: the built-in ones, then its own. */
export function storyShapes(project: Project): StoryShape[] {
  return [...Object.values(STRUCTURES), ...(project.plan?.shapes ?? [])];
}

export function isBuiltinShape(id: string): boolean {
  return id in STRUCTURES;
}

/** The shape the name is held against, if any. */
export function currentShape(project: Project): StoryShape | undefined {
  const id = project.plan?.structure;
  return id ? storyShapes(project).find((shape) => shape.id === id) : undefined;
}

export function partColor(shape: StoryShape, index: number): string {
  return shape.parts[index]?.color ?? PART_COLORS[index % PART_COLORS.length];
}

/** A part over the pages (0-based, inclusive). */
export interface ShapeSpan {
  index: number;
  name: string;
  color: string;
  first: number;
  last: number;
}

/**
 * Where the parts of `shape` fall over `pages` pages: each part gets at
 * least one page while there are pages enough, and the last part ends on
 * the last page.
 */
export function shapeSpans(shape: StoryShape, pages: number): ShapeSpan[] {
  if (pages < shape.parts.length || !shape.parts.length) return [];
  const total = shape.parts.reduce((sum, part) => sum + Math.max(part.share, 0), 0) || 1;
  const spans: ShapeSpan[] = [];
  let done = 0;
  let share = 0;
  shape.parts.forEach((part, index) => {
    share += Math.max(part.share, 0) / total;
    const left = shape.parts.length - index - 1;
    // Room for one page for each part still to come.
    const end = index === shape.parts.length - 1 ? pages : Math.min(pages - left, Math.max(done + 1, Math.round(pages * share)));
    spans.push({ index, name: part.name, color: partColor(shape, index), first: done, last: end - 1 });
    done = end;
  });
  return spans;
}

/** The page (0-based) a beat at `at` (0..1) falls on. */
export function beatPage(at: number, pages: number): number {
  return Math.max(0, Math.min(pages - 1, Math.floor(at * pages)));
}

/** The part each page is in under the current shape (undefined where there is none). */
export function pageParts(project: Project): (ShapeSpan | undefined)[] {
  const shape = currentShape(project);
  const count = project.pages.length;
  const out: (ShapeSpan | undefined)[] = new Array(count).fill(undefined);
  if (!shape) return out;
  for (const span of shapeSpans(shape, count)) for (let i = span.first; i <= span.last; i++) out[i] = span;
  return out;
}

// --- オリジナルの型 ------------------------------------------------------------------

function plan(project: Project) {
  return (project.plan ??= {});
}

/** Start an own shape from `from` (or three even parts) and use it. */
export function makeShape(project: Project, from?: StoryShape, label?: string): StoryShape {
  const shape: StoryShape = {
    // Unique beyond this name: own shapes are also kept on the computer for other names.
    id: `shape-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    label: label ?? (from ? `${from.label}（自分用）` : "自分の型"),
    parts: from ? from.parts.map((part) => ({ ...part })) : [{ name: "はじまり", share: 1 }, { name: "なか", share: 1 }, { name: "おわり", share: 1 }],
    ...(from?.beats?.length ? { beats: from.beats.map((beat) => ({ ...beat })) } : {}),
  };
  const p = plan(project);
  (p.shapes ??= []).push(shape);
  p.structure = shape.id;
  return shape;
}

/** Take a shape kept on this computer into the name (same id, so it is not taken twice). */
export function adoptShape(project: Project, shape: StoryShape): StoryShape {
  const p = plan(project);
  const own = (p.shapes ??= []);
  let copy = own.find((s) => s.id === shape.id);
  if (!copy) {
    copy = structuredClone(shape);
    own.push(copy);
  }
  p.structure = copy.id;
  return copy;
}

/**
 * The current shape, ready to change: an own shape as it is, a built-in one
 * copied into an own shape first (built-in shapes stay as they are).
 */
export function editableShape(project: Project): StoryShape | undefined {
  const shape = currentShape(project);
  if (!shape) return undefined;
  return isBuiltinShape(shape.id) ? makeShape(project, shape) : shape;
}

export function removeShape(project: Project, id: string): void {
  const p = project.plan;
  if (!p?.shapes) return;
  p.shapes = p.shapes.filter((shape) => shape.id !== id);
  if (!p.shapes.length) delete p.shapes;
  if (p.structure === id) delete p.structure;
  if (!Object.keys(p).length) delete project.plan;
}

/** Shares turned into fractions of the whole, so boundaries can be moved. */
function fractions(parts: ShapePart[]): number[] {
  const total = parts.reduce((sum, part) => sum + Math.max(part.share, 0), 0) || 1;
  return parts.map((part) => Math.max(part.share, 0) / total);
}

/** Smallest share a part keeps when its neighbour's boundary is dragged. */
export const MIN_SHARE = 0.02;

/**
 * Move the boundary after part `index` to `at` (0..1 of the pages). Only the
 * two parts on either side change; each keeps at least MIN_SHARE.
 */
export function moveBoundary(shape: StoryShape, index: number, at: number): void {
  if (index < 0 || index >= shape.parts.length - 1) return;
  const shares = fractions(shape.parts);
  const before = shares.slice(0, index).reduce((sum, s) => sum + s, 0);
  const pair = shares[index] + shares[index + 1];
  const left = Math.max(MIN_SHARE, Math.min(pair - MIN_SHARE, at - before));
  shares[index] = left;
  shares[index + 1] = pair - left;
  shape.parts.forEach((part, i) => (part.share = round(shares[i])));
}

/** Split part `index` into two halves. */
export function splitPart(shape: StoryShape, index: number, name = "新しい区切り"): void {
  const part = shape.parts[index];
  if (!part) return;
  const half = part.share / 2;
  part.share = half;
  shape.parts.splice(index + 1, 0, { name, share: half });
}

/** Remove part `index`; its pages go to the part before it (or after, for the first). */
export function removePart(shape: StoryShape, index: number): void {
  if (shape.parts.length <= 1 || !shape.parts[index]) return;
  const [part] = shape.parts.splice(index, 1);
  shape.parts[Math.max(0, index - 1)].share += part.share;
}

export function setBeat(shape: StoryShape, index: number, at: number): void {
  const beat = shape.beats?.[index];
  if (!beat) return;
  beat.at = round(Math.max(0, Math.min(1, at)));
  shape.beats!.sort((a, b) => a.at - b.at);
}

export function addBeat(shape: StoryShape, name: string, at: number): void {
  (shape.beats ??= []).push({ name, at: round(Math.max(0, Math.min(1, at))) });
  shape.beats.sort((a, b) => a.at - b.at);
}

export function removeBeat(shape: StoryShape, index: number): void {
  shape.beats?.splice(index, 1);
  if (shape.beats && !shape.beats.length) delete shape.beats;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// --- この PC に置く型 --------------------------------------------------------------

const LIBRARY_KEY = "namestudio.storyShapes";

/** Own shapes kept on this computer, to use in other names. */
export function libraryShapes(): StoryShape[] {
  const value = readJson(LIBRARY_KEY, []);
  return Array.isArray(value) ? value.filter((shape) => shape && typeof shape.id === "string" && Array.isArray(shape.parts)) : [];
}

/** Keep (or update) an own shape on this computer. */
export function keepShape(shape: StoryShape): void {
  // Storage may be off; the shape still lives in the name.
  const kept = libraryShapes().filter((s) => s.id !== shape.id);
  kept.push(structuredClone(shape));
  writeJson(LIBRARY_KEY, kept);
}

export function forgetShape(id: string): void {
  writeJson(LIBRARY_KEY, libraryShapes().filter((s) => s.id !== id));
}

// ペン・消しゴムの持ち替え (as CSP's サブツール・ツールプロパティ・ブラシサイズ
// palettes): which pens and erasers there are to pick from, a name for each
// that stays the same from name to name (its keys and its last size go by
// it), the sizes offered as round buttons, and the size slider's scale.
import type { Brush, BrushKind, Project } from "./model";

/** A pen or eraser to pick: one of the name's, the plain one, or one taken in another name. */
export interface BrushPick {
  kind: BrushKind;
  /** None: 標準のペン / 標準の消しゴム. */
  brush: Brush | null;
  /** Taken in another name only (picking it brings it into this one). */
  library: boolean;
  ref: string;
}

/** The plain pen's width in hand when nothing else is known. */
export const PLAIN_PEN_MM = 0.4;

/** What the brush is called in the keys and the sizes kept on this computer: the same in every name. */
export function brushRef(kind: BrushKind, brush: Pick<Brush, "name" | "source"> | null): string {
  return brush ? `${kind}:${brush.source ?? ""}/${brush.name}` : `${kind}:plain`;
}

/** The pens (or erasers) to pick from: the plain one, the name's in their order, then those of other names. */
export function brushPicks(project: Pick<Project, "brushes">, library: readonly Brush[], kind: BrushKind): BrushPick[] {
  const own = project.brushes.filter((brush) => brush.kind === kind);
  const picks: BrushPick[] = [{ kind, brush: null, library: false, ref: brushRef(kind, null) }];
  const refs = new Set(picks.map((pick) => pick.ref));
  for (const brush of own) {
    const ref = brushRef(kind, brush);
    refs.add(ref);
    picks.push({ kind, brush, library: false, ref });
  }
  for (const brush of library) {
    const ref = brushRef(kind, brush);
    if (brush.kind !== kind || refs.has(ref)) continue;
    refs.add(ref);
    picks.push({ kind, brush, library: true, ref });
  }
  return picks;
}

/** The name's brushes with the pens (or erasers) `first`..`last` of their kind put before the one at `target` of it. */
export function reorderBrushes(brushes: readonly Brush[], kind: BrushKind, first: number, last: number, target: number): Brush[] {
  const own = brushes.filter((brush) => brush.kind === kind);
  const moved = own.slice(first, last + 1);
  const rest = own.filter((_, i) => i < first || i > last);
  const at = target <= first ? target : target - moved.length;
  rest.splice(Math.max(0, Math.min(rest.length, at)), 0, ...moved);
  // The other kind keeps its places; this kind fills its own in the new order.
  let next = 0;
  return brushes.map((brush) => (brush.kind === kind ? rest[next++] : brush));
}

// --- sizes ----------------------------------------------------------------------------

/** How thin and thick the pen and the eraser in hand go (as ] and [ keep them). */
export const SIZE_RANGE: Record<BrushKind, [number, number]> = { pen: [0.05, 20], eraser: [0.2, 50] };

export function clampSize(kind: BrushKind, mm: number): number {
  const [min, max] = SIZE_RANGE[kind];
  return Math.min(max, Math.max(min, Math.round(mm * 100) / 100));
}

/** ブラシサイズ: the sizes offered as round buttons, out of the box. */
export const DEFAULT_SIZE_PRESETS: Record<BrushKind, number[]> = {
  pen: [0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1, 1.5, 2, 3, 5],
  eraser: [0.5, 1, 2, 3, 5, 8, 12, 20],
};

/** At most this many round buttons a kind. */
export const MAX_PRESETS = 24;

export type SizePresets = Record<BrushKind, number[]>;

/** Sizes in order, each once, within the kind's range. */
function cleanSizes(kind: BrushKind, sizes: readonly unknown[]): number[] {
  const numbers = sizes.filter((size): size is number => typeof size === "number" && Number.isFinite(size) && size > 0).map((size) => clampSize(kind, size));
  return [...new Set(numbers)].sort((a, b) => a - b).slice(0, MAX_PRESETS);
}

/** The kept sizes, as read back; anything missing or broken is the default. */
export function presetsFrom(stored: unknown): SizePresets {
  const presets: SizePresets = { pen: [...DEFAULT_SIZE_PRESETS.pen], eraser: [...DEFAULT_SIZE_PRESETS.eraser] };
  if (!stored || typeof stored !== "object") return presets;
  for (const kind of ["pen", "eraser"] as const) {
    const sizes = (stored as Partial<Record<BrushKind, unknown>>)[kind];
    if (Array.isArray(sizes)) presets[kind] = cleanSizes(kind, sizes);
  }
  return presets;
}

export function withPreset(presets: SizePresets, kind: BrushKind, mm: number): SizePresets {
  return { ...presets, [kind]: cleanSizes(kind, [...presets[kind], mm]) };
}

export function withoutPreset(presets: SizePresets, kind: BrushKind, mm: number): SizePresets {
  return { ...presets, [kind]: presets[kind].filter((size) => size !== mm) };
}

/**
 * The size each pen was last used at (as CSP's sub tools keep theirs), by
 * {@link brushRef}, with the brush's own size then: when the brush's own size
 * is set anew, that one counts again.
 */
export type HandSizes = Record<string, { mm: number; base: number }>;

export function handSizesFrom(stored: unknown): HandSizes {
  const sizes: HandSizes = {};
  if (!stored || typeof stored !== "object") return sizes;
  for (const [ref, value] of Object.entries(stored as Record<string, unknown>)) {
    const { mm, base } = (value ?? {}) as { mm?: unknown; base?: unknown };
    if (typeof mm === "number" && mm > 0 && typeof base === "number") sizes[ref] = { mm, base };
  }
  return sizes;
}

/** The size to take a brush up at: the one it was last used at, unless its own size changed since. */
export function sizeInHand(sizes: HandSizes, kind: BrushKind, brush: Brush | null): number {
  const own = brush ? brush.sizeMm : PLAIN_PEN_MM;
  const kept = sizes[brushRef(kind, brush)];
  return kept && kept.base === own ? kept.mm : own;
}

/** The sizes with the brush now used at `mm` (its own size again: forgotten). */
export function withHandSize(sizes: HandSizes, kind: BrushKind, brush: Brush | null, mm: number): HandSizes {
  const ref = brushRef(kind, brush);
  const base = brush ? brush.sizeMm : PLAIN_PEN_MM;
  const next = { ...sizes };
  if (mm === base) delete next[ref];
  else next[ref] = { mm, base };
  return next;
}

/** Steps of the size slider: it goes by ratio, so thin pens get as much room as thick ones. */
export const SLIDER_STEPS = 1000;

export function sliderOf(kind: BrushKind, mm: number): number {
  const [min, max] = SIZE_RANGE[kind];
  const t = Math.log(Math.min(max, Math.max(min, mm)) / min) / Math.log(max / min);
  return Math.round(t * SLIDER_STEPS);
}

export function sizeOfSlider(kind: BrushKind, position: number): number {
  const [min, max] = SIZE_RANGE[kind];
  const mm = min * (max / min) ** (Math.min(SLIDER_STEPS, Math.max(0, position)) / SLIDER_STEPS);
  // Two figures are enough to the eye, and keep the sizes round.
  const digits = mm < 1 ? 2 : mm < 10 ? 1 : 0;
  return clampSize(kind, Number(mm.toFixed(digits)));
}

/** A size as shown on a round button and beside the slider. */
export function sizeLabel(mm: number): string {
  return mm >= 10 ? String(Math.round(mm)) : String(Math.round(mm * 100) / 100);
}

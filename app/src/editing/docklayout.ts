// 欄の配置 (as CSP's palette docks): where each palette is — a side (left or
// right of the pages), a column on that side (up to three, the first by the
// window's edge), its place top to bottom, a tab in another palette's frame,
// or floating over the pages — whether it is shown, folded to its title, its
// share of the height or the height of what it holds, and the columns'
// widths. Pure: the screen (ui/dock.ts) draws it and hands the changes here.

export type PaletteId =
  | "subtools"
  | "toolprops"
  | "brushsize"
  | "pages"
  | "script"
  | "cast"
  | "notes"
  | "held"
  | "layers"
  | "series"
  | "assist"
  | "inspector";
export type Side = "left" | "right";

/** At most this many columns a side. */
export const MAX_COLUMNS = 3;
export const MIN_WIDTH = 160;
export const MAX_WIDTH = 640;
export const DEFAULT_WIDTH: Record<Side, number> = { left: 280, right: 300 };
/** A floating palette, in the window's pixels. */
export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaletteState {
  side: Side;
  /** Its column on its side, 0 by the window's edge. */
  col: number;
  /** In its column (else only its icon is). */
  shown: boolean;
  /** Only its title bar. */
  folded: boolean;
  /** Its share of the column's height among the open ones. */
  weight: number;
  /** As tall as what it holds (shrinking when the column is short), not a share. */
  fit: boolean;
  /** A tab in the frame of this palette (the frame's first), or none. */
  tab: PaletteId | null;
  /** Floating over the pages there (its icon stays on its side), or docked. */
  float: FloatRect | null;
}

export interface DockLayout {
  /** Top to bottom, the sides and columns mixed. */
  order: PaletteId[];
  palettes: Record<PaletteId, PaletteState>;
  /** Each side's columns' widths, from the window's edge in. */
  widths: Record<Side, number[]>;
  /** The side folded to its icons. */
  collapsed: Record<Side, boolean>;
  /** The tab in front of each frame (by the frame's first). */
  front: Partial<Record<PaletteId, PaletteId>>;
}

/** One frame in a column: one palette, or several as tabs. */
export interface Frame {
  /** Whose state (height, folded) the frame has: the frame's first. */
  lead: PaletteId;
  /** The tabs shown, in order. */
  members: PaletteId[];
  /** The tab in front. */
  front: PaletteId;
}

export const PALETTE_IDS: PaletteId[] = [
  "subtools",
  "toolprops",
  "brushsize",
  "pages",
  "script",
  "cast",
  "notes",
  "held",
  "layers",
  "series",
  "assist",
  "inspector",
];

/** As tall as what they hold, out of the box (the sub tools are short; the lists take the rest). */
const FIT: ReadonlySet<PaletteId> = new Set(["subtools", "toolprops", "brushsize"]);

/** Palettes split off another one since: where that one is, after it, shown as it was (ブラシサイズ hidden). */
const SPLIT_FROM: Partial<Record<PaletteId, { from: PaletteId; shown: boolean }>> = {
  toolprops: { from: "subtools", shown: true },
  brushsize: { from: "subtools", shown: false },
};

function state(side: Side, shown: boolean, id: PaletteId): PaletteState {
  return { side, col: 0, shown, folded: false, weight: 1, fit: FIT.has(id), tab: null, float: null };
}

export function defaultLayout(leftCollapsed = false): DockLayout {
  const shownLeft: PaletteId[] = ["subtools", "toolprops", "pages"];
  const palettes = Object.fromEntries(
    PALETTE_IDS.map((id) => {
      // AI に相談 and 詳細 on the right (相談 its icon until it is asked for).
      if (id === "assist") return [id, state("right", false, id)];
      if (id === "inspector") return [id, state("right", true, id)];
      return [id, state("left", shownLeft.includes(id), id)];
    }),
  ) as Record<PaletteId, PaletteState>;
  return {
    order: [...PALETTE_IDS],
    palettes,
    widths: { left: [DEFAULT_WIDTH.left], right: [DEFAULT_WIDTH.right] },
    collapsed: { left: leftCollapsed, right: false },
    front: {},
  };
}

export function clampWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), MIN_WIDTH), MAX_WIDTH);
}

const isId = (id: unknown): id is PaletteId => PALETTE_IDS.includes(id as PaletteId);

function readRect(value: unknown): FloatRect | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<FloatRect>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const [x, y, w, h] = [n(r.x), n(r.y), n(r.w), n(r.h)];
  if (x === null || y === null || w === null || h === null) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.max(160, Math.round(w)), h: Math.max(80, Math.round(h)) };
}

/** The kept arrangement (older ones too: one column a side), with palettes added since in their default place. */
export function readLayout(text: string | null, leftCollapsed = false): DockLayout {
  const base = defaultLayout(leftCollapsed);
  if (!text) return base;
  try {
    const saved = JSON.parse(text) as Partial<DockLayout> & { width?: Partial<Record<Side, number>> };
    const order = (saved.order ?? []).filter(isId).filter((id, i, all) => all.indexOf(id) === i);
    const palettes = { ...base.palettes };
    for (const id of PALETTE_IDS) {
      const p = saved.palettes?.[id] as Partial<PaletteState> | undefined;
      if (!p) continue;
      palettes[id] = {
        side: p.side === "right" ? "right" : "left",
        col: Number.isInteger(p.col) && (p.col as number) >= 0 ? Math.min(p.col as number, MAX_COLUMNS - 1) : 0,
        shown: !!p.shown,
        folded: !!p.folded,
        weight: Number.isFinite(p.weight) && (p.weight as number) > 0 ? (p.weight as number) : 1,
        fit: typeof p.fit === "boolean" ? p.fit : FIT.has(id),
        tab: isId(p.tab) && p.tab !== id ? p.tab : null,
        float: readRect(p.float),
      };
    }
    // One added since: before the one it comes before by default (サブツール above ページ),
    // or (split off one kept) right after that one, in its column.
    PALETTE_IDS.forEach((id, index) => {
      if (order.includes(id)) return;
      const split = SPLIT_FROM[id];
      if (split && order.includes(split.from) && saved.palettes?.[split.from]) {
        const from = palettes[split.from];
        palettes[id] = { ...palettes[id], side: from.side, col: from.col, shown: split.shown && from.shown && !from.float };
        let at = order.indexOf(split.from) + 1;
        while (at < order.length && SPLIT_FROM[order[at]]?.from === split.from) at++;
        order.splice(at, 0, id);
        return;
      }
      const next = PALETTE_IDS.slice(index + 1).find((other) => order.includes(other));
      order.splice(next ? order.indexOf(next) : order.length, 0, id);
    });
    const widths = (side: Side): number[] => {
      const kept = saved.widths?.[side];
      if (Array.isArray(kept) && kept.length) return kept.slice(0, MAX_COLUMNS).map((w) => clampWidth(Number(w) || DEFAULT_WIDTH[side]));
      return [clampWidth(saved.width?.[side] ?? DEFAULT_WIDTH[side])];
    };
    const front: DockLayout["front"] = {};
    for (const [key, value] of Object.entries(saved.front ?? {})) if (isId(key) && isId(value)) front[key] = value;
    const layout: DockLayout = {
      order,
      palettes,
      widths: { left: widths("left"), right: widths("right") },
      collapsed: { left: !!saved.collapsed?.left, right: !!saved.collapsed?.right },
      front,
    };
    tidy(layout);
    return layout;
  } catch {
    return base;
  }
}

/** The palettes of a side (any column, floating ones too), top to bottom. */
export function column(layout: DockLayout, side: Side): PaletteId[] {
  return layout.order.filter((id) => layout.palettes[id].side === side);
}

/** The columns of a side that show something, from the window's edge in. */
export function columnsOf(layout: DockLayout, side: Side): number[] {
  const cols = new Set<number>();
  for (const id of layout.order) {
    const p = layout.palettes[id];
    if (p.side === side && p.shown && !p.float) cols.add(p.col);
  }
  return [...cols].sort((a, b) => a - b);
}

/** The width of a side's column. */
export function widthOf(layout: DockLayout, side: Side, col: number): number {
  return layout.widths[side][col] ?? DEFAULT_WIDTH[side];
}

/** The frame a palette is in (its own, or the one it is a tab of). */
export function frameKey(layout: DockLayout, id: PaletteId): PaletteId {
  return layout.palettes[id].tab ?? id;
}

/** A column's frames, top to bottom: the palettes shown there, tabs together. */
export function frames(layout: DockLayout, side: Side, col: number): Frame[] {
  const groups = new Map<PaletteId, PaletteId[]>();
  for (const id of layout.order) {
    const p = layout.palettes[id];
    if (p.side !== side || p.col !== col || !p.shown || p.float) continue;
    const key = frameKey(layout, id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(id);
  }
  return [...groups].map(([key, members]) => {
    const lead = members.includes(key) ? key : members[0];
    const wanted = layout.front[key];
    return { lead, members, front: wanted && members.includes(wanted) ? wanted : members[0] };
  });
}

/** The palettes floating over the pages, in order (the last on top). */
export function floating(layout: DockLayout): PaletteId[] {
  return layout.order.filter((id) => layout.palettes[id].shown && layout.palettes[id].float);
}

/** Whether a palette's contents are on screen. */
export function isOpen(layout: DockLayout, id: PaletteId): boolean {
  const p = layout.palettes[id];
  if (!p.shown) return false;
  if (p.float) return true;
  if (layout.collapsed[p.side]) return false;
  const frame = frames(layout, p.side, p.col).find((f) => f.members.includes(id));
  if (!frame || frame.front !== id) return false;
  return !layout.palettes[frame.lead].folded;
}

/** Out of its tab group (the others stay together, the next one leading). */
export function detach(layout: DockLayout, id: PaletteId): void {
  const p = layout.palettes[id];
  if (p.tab) {
    if (layout.front[p.tab] === id) delete layout.front[p.tab];
    p.tab = null;
    return;
  }
  const others = layout.order.filter((other) => layout.palettes[other].tab === id);
  if (!others.length) return;
  const [lead, ...rest] = others;
  layout.palettes[lead].tab = null;
  // The new lead takes the frame's height.
  Object.assign(layout.palettes[lead], { weight: p.weight, fit: p.fit, folded: p.folded });
  for (const other of rest) layout.palettes[other].tab = lead;
  const front = layout.front[id];
  delete layout.front[id];
  if (front && front !== id) layout.front[lead] = front;
}

/** Shift a side's columns from `at` one further in, making room for a new one there. */
function makeColumn(layout: DockLayout, side: Side, at: number): void {
  for (const id of PALETTE_IDS) {
    const p = layout.palettes[id];
    if (p.side === side && p.col >= at) p.col += 1;
  }
  layout.widths[side].splice(at, 0, DEFAULT_WIDTH[side]);
}

/**
 * Columns showing nothing go (the palettes hidden there join the nearest
 * column that shows something), the others close up; tabs stay with their frame.
 */
export function tidy(layout: DockLayout): void {
  for (const side of ["left", "right"] as const) {
    const onSide = PALETTE_IDS.filter((id) => layout.palettes[id].side === side);
    const shownCols = [
      ...new Set(onSide.filter((id) => layout.palettes[id].shown && !layout.palettes[id].float).map((id) => layout.palettes[id].col)),
    ].sort((a, b) => a - b);
    const widths = layout.widths[side];
    if (!shownCols.length) {
      for (const id of onSide) layout.palettes[id].col = 0;
      layout.widths[side] = [widths[0] ?? DEFAULT_WIDTH[side]];
      continue;
    }
    const nearest = (col: number) => shownCols.reduce((best, c) => (Math.abs(c - col) < Math.abs(best - col) ? c : best), shownCols[0]);
    for (const id of onSide) {
      const p = layout.palettes[id];
      p.col = shownCols.indexOf(nearest(p.col));
    }
    layout.widths[side] = shownCols.map((col) => widths[col] ?? DEFAULT_WIDTH[side]);
  }
  // A tab whose frame is gone, elsewhere or itself a tab: on its own.
  for (const id of PALETTE_IDS) {
    const p = layout.palettes[id];
    if (!p.tab) continue;
    const lead = layout.palettes[p.tab];
    if (lead.tab || lead.side !== p.side || lead.col !== p.col || !!lead.float !== !!p.float || p.float) p.tab = null;
  }
}

/** Where a palette goes: a column of a side, before another (else at the column's bottom), or a new column. */
export interface Place {
  side: Side;
  /** Its column; with `newColumn`, where the new column goes (0 by the window's edge). */
  col: number;
  newColumn?: boolean;
  before?: PaletteId | null;
}

/** Whether a side has room for another column. */
export function canAddColumn(layout: DockLayout, side: Side): boolean {
  return columnsOf(layout, side).length < MAX_COLUMNS;
}

/** Put a palette there, shown and open (out of a tab group or floating). */
export function placePalette(layout: DockLayout, id: PaletteId, place: Place): void {
  const before = place.before && place.before !== id ? place.before : null;
  detach(layout, id);
  const p = layout.palettes[id];
  let col = place.col;
  if (place.newColumn) {
    col = Math.max(0, Math.min(col, columnsOf(layout, place.side).length));
    makeColumn(layout, place.side, col);
  }
  Object.assign(p, { side: place.side, col, shown: true, folded: false, float: null });
  layout.order = layout.order.filter((x) => x !== id);
  const target = before && layout.palettes[before].side === place.side && layout.palettes[before].col === col ? before : null;
  if (target) {
    // Before the frame `before` is in (its first tab).
    const key = frameKey(layout, target);
    const first = layout.order.find((x) => frameKey(layout, x) === key && layout.palettes[x].side === place.side) ?? target;
    layout.order.splice(layout.order.indexOf(first), 0, id);
  } else {
    // At the bottom of the column: after its last palette.
    const last = [...layout.order].reverse().find((x) => layout.palettes[x].side === place.side && layout.palettes[x].col === col);
    layout.order.splice(last ? layout.order.indexOf(last) + 1 : layout.order.length, 0, id);
  }
  layout.collapsed[place.side] = false;
  tidy(layout);
}

/** Put a palette in a side's column, before `before` (else at the bottom of the column `before` is in, or the last one). */
export function movePalette(layout: DockLayout, id: PaletteId, side: Side, before: PaletteId | null): void {
  if (before === id) return;
  const target = before && layout.palettes[before].side === side ? layout.palettes[before] : null;
  const cols = columnsOf(layout, side).filter((col) => col !== layout.palettes[id].col || layout.palettes[id].side !== side);
  const col = target ? target.col : (cols.at(-1) ?? columnsOf(layout, side).at(-1) ?? 0);
  placePalette(layout, id, { side, col, before: target ? before : null });
}

/** A palette as a tab of another one's frame, in front. */
export function joinTab(layout: DockLayout, id: PaletteId, other: PaletteId): void {
  const key = frameKey(layout, other);
  if (key === id || frameKey(layout, id) === key) {
    layout.front[key] = id;
    return;
  }
  detach(layout, id);
  // Its own tabs (now led by another) stay where they are.
  const lead = layout.palettes[key];
  const p = layout.palettes[id];
  Object.assign(p, { side: lead.side, col: lead.col, shown: true, folded: false, float: null, tab: key });
  layout.order = layout.order.filter((x) => x !== id);
  const last = [...layout.order].reverse().find((x) => frameKey(layout, x) === key) ?? key;
  layout.order.splice(layout.order.indexOf(last) + 1, 0, id);
  layout.front[key] = id;
  if (lead.float) {
    // A floating frame does not take tabs: the palette floats beside it.
    p.tab = null;
    p.float = { ...lead.float, x: lead.float.x + 24, y: lead.float.y + 24 };
  }
  tidy(layout);
}

/** Bring a tab to the front of its frame. */
export function showTab(layout: DockLayout, id: PaletteId): void {
  layout.front[frameKey(layout, id)] = id;
}

/** A palette floating over the pages at `rect`. */
export function floatPalette(layout: DockLayout, id: PaletteId, rect: FloatRect): void {
  detach(layout, id);
  const p = layout.palettes[id];
  Object.assign(p, { shown: true, folded: false, float: { ...rect } });
  // On top of the others.
  layout.order = [...layout.order.filter((x) => x !== id), id];
  tidy(layout);
}

/** A floating palette back in its side's column (the innermost one shown, at the bottom). */
export function dockPalette(layout: DockLayout, id: PaletteId): void {
  const p = layout.palettes[id];
  p.float = null;
  movePalette(layout, id, p.side, null);
}

/** Every palette as it comes from its height: a share of the column, or as tall as what it holds. */
export function setFit(layout: DockLayout, id: PaletteId, fit: boolean): void {
  layout.palettes[frameKey(layout, id)].fit = fit;
}

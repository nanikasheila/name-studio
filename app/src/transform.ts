// 選んだものの変形（拡大縮小・回転・反転・自由変形）とコピー・貼り付け.
// Rough lines, panels, fills and はみ出し change shape with the transform;
// dialogue keeps its size and moves with its centre, its tails pointing
// where they pointed (a balloon transformed on its own grows with its text).
import { storedOutline } from "./balloon";
import { moveLine } from "./dialogue";
import { bounds } from "./geometry";
import type { BoxMm, Breakout, Fill, Line, Page, Panel, Point, Project, Sticky, Stroke, StrokePoint } from "./model";
import { carryContents, movePanel } from "./panels";
import { newId } from "./project";
import { assignPanels, orderPanels, sortLines } from "./readingorder";
import { stickyBox } from "./stickies";
import { fillShape, mapFill, moveStroke, type FillShape } from "./strokes";

/** x' = a x + c y + e, y' = b x + d y + f. */
export type Affine = [number, number, number, number, number, number];

export function applyAffine([a, b, c, d, e, f]: Affine, [x, y]: readonly number[]): Point {
  return [a * x + c * y + e, b * x + d * y + f];
}

/** Scale by `sx`, `sy` about `origin`. */
export function scaling(sx: number, sy: number, [ox, oy]: Point): Affine {
  return [sx, 0, 0, sy, ox - sx * ox, oy - sy * oy];
}

/** Turn by `radians` (clockwise on the page, y down) about `origin`. */
export function rotation(radians: number, [ox, oy]: Point): Affine {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, ox - cos * ox + sin * oy, oy - sin * ox - cos * oy];
}

/**
 * 自由変形: the box's corners (top left, top right, bottom right, bottom
 * left) moved each on its own; points inside go with them (bilinear).
 */
export interface Quad {
  box: BoxMm;
  corners: [Point, Point, Point, Point];
}

/** Where a transform takes things: an affine map or a free deform. */
export type Warp = Affine | Quad;

export function warpPoint(w: Warp, p: readonly number[]): Point {
  if (Array.isArray(w)) return applyAffine(w, p);
  const [x0, y0, x1, y1] = w.box;
  const u = x1 > x0 ? (p[0] - x0) / (x1 - x0) : 0;
  const v = y1 > y0 ? (p[1] - y0) / (y1 - y0) : 0;
  const [a, b, c, d] = w.corners;
  const top: Point = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  const bottom: Point = [d[0] + (c[0] - d[0]) * u, d[1] + (c[1] - d[1]) * u];
  return [top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v];
}

/** How much a warp changes sizes: the square root of its change of area. */
export function warpScale(w: Warp): number {
  if (Array.isArray(w)) return Math.sqrt(Math.abs(w[0] * w[3] - w[1] * w[2]));
  const [x0, y0, x1, y1] = w.box;
  const before = (x1 - x0) * (y1 - y0);
  const [a, b, c, d] = w.corners;
  const after = Math.abs((a[0] * b[1] - b[0] * a[1] + b[0] * c[1] - c[0] * b[1] + c[0] * d[1] - d[0] * c[1] + d[0] * a[1] - a[0] * d[1]) / 2);
  return before > 0 ? Math.sqrt(after / before) : 1;
}

/** What a selection is made of. */
export interface ItemRef {
  kind: "stroke" | "line" | "panel" | "fill" | "breakout";
  id: string;
}

/**
 * What a 範囲選択 takes along: the things picked and, as with CSP's コマ枠
 * フォルダ, what is drawn in the panels among them, each thing once.
 */
export function withContents(page: Page, items: readonly ItemRef[], carries: boolean): ItemRef[] {
  const all = [...items];
  const seen = new Set(items.map((item) => `${item.kind}:${item.id}`));
  const add = (kind: ItemRef["kind"], id: string) => {
    if (seen.has(`${kind}:${id}`)) return;
    seen.add(`${kind}:${id}`);
    all.push({ kind, id });
  };
  if (!carries) return all;
  for (const item of items) {
    const panel = item.kind === "panel" ? page.panels.find((p) => p.id === item.id) : undefined;
    if (!panel) continue;
    const carried = carryContents(page, panel);
    for (const { id } of carried.strokes) add("stroke", id);
    for (const { id } of carried.lines) add("line", id);
    for (const { id } of carried.fills ?? []) add("fill", id);
  }
  return all;
}

/** Move the things by `dx`, `dy` mm. */
export function moveItems(page: Page, items: readonly ItemRef[], dx: number, dy: number): void {
  const shift = (shape: Point[]) => shape.map(([x, y]) => [x + dx, y + dy] as Point);
  for (const item of items) {
    if (item.kind === "stroke") {
      const stroke = page.strokes.find((s) => s.id === item.id);
      if (stroke) moveStroke(stroke, dx, dy);
    } else if (item.kind === "line") {
      const line = page.lines.find((l) => l.id === item.id);
      if (line) moveLine(line, dx, dy);
    } else if (item.kind === "panel") {
      const panel = page.panels.find((p) => p.id === item.id);
      if (panel) movePanel(panel, dx, dy);
    } else if (item.kind === "fill") {
      const fill = page.fills?.find((f) => f.id === item.id);
      if (fill) mapFill(fill, ([x, y]) => [x + dx, y + dy]);
    } else {
      const breakout = page.breakouts.find((b) => b.id === item.id);
      if (breakout) breakout.shape = shift(breakout.shape);
    }
  }
}

/** Shift + click: the thing added to the picked ones, or taken out if it was in. */
export function toggleItem(items: readonly ItemRef[], ref: ItemRef): ItemRef[] {
  const inside = items.some((item) => item.kind === ref.kind && item.id === ref.id);
  return inside ? items.filter((item) => !(item.kind === ref.kind && item.id === ref.id)) : [...items, ref];
}

/** The selected things as they were when a transform began. */
export interface TransformBase {
  strokes: { id: string; points: StrokePoint[]; widthMm: number }[];
  lines: { id: string; box: BoxMm; fontSizePt: number; balloon?: Point[]; tails?: Point[]; balloonScale?: [number, number] }[];
  panels?: { id: string; shape: Point[] }[];
  fills?: FillShape[];
  breakouts?: { id: string; shape: Point[] }[];
  /** A balloon transformed on its own: its text grows and shrinks with it. */
  scaleText?: boolean;
  /** A balloon transformed on its own, its text kept as it is: only the balloon's width and height change. */
  balloonOnly?: boolean;
}

/** How a balloon transformed on its own changes: with its text, or the balloon alone. */
export type LoneBalloon = "withText" | "balloonOnly";

export function transformBase(page: Page, items: readonly ItemRef[], lone?: LoneBalloon): TransformBase {
  const ids = (kind: ItemRef["kind"]) => new Set(items.filter((item) => item.kind === kind).map((item) => item.id));
  const strokes = ids("stroke");
  const lines = ids("line");
  const shapes = <T extends { id: string; shape: Point[] }>(list: readonly T[] | undefined, wanted: Set<string>) =>
    (list ?? []).filter((x) => wanted.has(x.id)).map((x) => ({ id: x.id, shape: x.shape.map((p) => [...p] as Point) }));
  const panels = shapes(page.panels, ids("panel"));
  const fillIds = ids("fill");
  const fills = (page.fills ?? []).filter((fill) => fillIds.has(fill.id)).map(fillShape);
  const breakouts = shapes(page.breakouts, ids("breakout"));
  return {
    ...(panels.length ? { panels } : {}),
    ...(fills.length ? { fills } : {}),
    ...(breakouts.length ? { breakouts } : {}),
    ...(lone === "withText" ? { scaleText: true } : lone === "balloonOnly" ? { balloonOnly: true } : {}),
    strokes: page.strokes
      .filter((s) => strokes.has(s.id))
      .map((s) => ({ id: s.id, points: s.points.map((p) => [...p] as StrokePoint), widthMm: s.widthMm })),
    lines: page.lines
      .filter((l) => lines.has(l.id))
      .map((l) => ({
        id: l.id,
        box: [...l.box] as BoxMm,
        fontSizePt: l.fontSizePt,
        ...(l.balloon ? { balloon: l.balloon.map((p) => [...p] as Point) } : {}),
        ...(l.tails ? { tails: l.tails.map((t) => [...t.tip] as Point) } : {}),
        ...(l.balloonScale ? { balloonScale: [...l.balloonScale] as [number, number] } : {}),
      })),
  };
}

/** How much a warp stretches across and down (each on its own). */
export function warpStretch(w: Warp): [number, number] {
  if (Array.isArray(w)) return [Math.hypot(w[0], w[1]), Math.hypot(w[2], w[3])];
  const [x0, y0, x1, y1] = w.box;
  const [nx0, ny0, nx1, ny1] = bounds(w.corners);
  return [x1 > x0 ? (nx1 - nx0) / (x1 - x0) : 1, y1 > y0 ? (ny1 - ny0) / (y1 - y0) : 1];
}

/** The box around the selected things (balloons included). */
export function baseBounds(base: TransformBase): BoxMm | null {
  const points: Point[] = [];
  for (const stroke of base.strokes) for (const [x, y] of stroke.points) points.push([x, y]);
  for (const line of base.lines) {
    points.push([line.box[0], line.box[1]], [line.box[2], line.box[3]]);
    for (const p of line.balloon ?? []) points.push(p);
  }
  for (const { shape } of [...(base.panels ?? []), ...(base.fills ?? []), ...(base.breakouts ?? [])]) points.push(...shape);
  return points.length ? bounds(points) : null;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Put the selected things where `w` takes them from `base`. Line widths
 * follow the size (the square root of the area's change), never below
 * 0.05 mm.
 */
export function transformItems(page: Page, base: TransformBase, w: Warp): void {
  const sizeFactor = warpScale(w);
  const map = (p: readonly number[]): Point => {
    const [x, y] = warpPoint(w, p);
    return [round3(x), round3(y)];
  };
  for (const { id, points, widthMm } of base.strokes) {
    const stroke = page.strokes.find((s) => s.id === id);
    if (!stroke) continue;
    stroke.points = points.map((p) => [...warpPoint(w, p), ...p.slice(2)] as StrokePoint);
    stroke.widthMm = Math.max(0.05, Math.round(widthMm * sizeFactor * 1000) / 1000);
  }
  for (const { id, box, fontSizePt, balloon, tails, balloonScale } of base.lines) {
    const line = page.lines.find((l) => l.id === id);
    if (!line) continue;
    const centre: Point = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    const [cx, cy] = warpPoint(w, centre);
    if (base.balloonOnly) {
      // The text stays as it is; the balloon around it gets wider or taller.
      const [ax, ay] = warpStretch(w);
      const [hw, hh] = [(box[2] - box[0]) / 2, (box[3] - box[1]) / 2];
      line.box = [round3(cx - hw), round3(cy - hh), round3(cx + hw), round3(cy + hh)];
      if (line.balloonShape === "custom" && balloon) {
        line.balloon = balloon.map(([x, y]) => [round3(cx + (x - centre[0]) * ax), round3(cy + (y - centre[1]) * ay)]);
      } else {
        const [bx, by] = balloonScale ?? [1, 1];
        const clamp = (value: number) => Math.round(Math.min(Math.max(value, 0.3), 6) * 1000) / 1000;
        const next: [number, number] = [clamp(bx * ax), clamp(by * ay)];
        if (next[0] === 1 && next[1] === 1) delete line.balloonScale;
        else line.balloonScale = next;
        const outline = storedOutline(line);
        if (outline) line.balloon = outline;
      }
      if (tails && line.tails) line.tails.forEach((tail, i) => tails[i] && (tail.tip = map(tails[i])));
      continue;
    }
    // On its own the balloon and its text grow together; with others it keeps its size.
    const k = base.scaleText ? Math.min(Math.max(sizeFactor, 0.2), 8) : 1;
    const [hw, hh] = [((box[2] - box[0]) / 2) * k, ((box[3] - box[1]) / 2) * k];
    line.box = [round3(cx - hw), round3(cy - hh), round3(cx + hw), round3(cy + hh)];
    if (base.scaleText) line.fontSizePt = Math.max(4, Math.round(fontSizePt * k * 10) / 10);
    if (balloon) line.balloon = balloon.map(([x, y]) => [round3(cx + (x - centre[0]) * k), round3(cy + (y - centre[1]) * k)]);
    if (tails && line.tails) line.tails.forEach((tail, i) => tails[i] && (tail.tip = map(tails[i])));
  }
  const reshape = <T extends { id: string; shape: Point[] }>(list: T[] | undefined, from: { id: string; shape: Point[] }[] | undefined) => {
    for (const { id, shape } of from ?? []) {
      const item = list?.find((x) => x.id === id);
      if (item) item.shape = shape.map(map);
    }
  };
  reshape(page.panels, base.panels);
  for (const from of base.fills ?? []) {
    const fill = page.fills?.find((f) => f.id === from.id);
    if (fill) mapFill(fill, map, from);
  }
  reshape(page.breakouts, base.breakouts);
  // A flip turns shapes inside out: keep panels the same way round.
  if (Array.isArray(w) && w[0] * w[3] - w[1] * w[2] < 0) {
    for (const { id } of base.panels ?? []) {
      const panel = page.panels.find((p) => p.id === id);
      if (!panel) continue;
      const n = panel.shape.length;
      panel.shape.reverse();
      // Edge i ran from point i to i + 1; reversed, it runs from n - 2 - i to n - 1 - i.
      if (panel.openEdges) panel.openEdges = panel.openEdges.map((i) => (((n - 2 - i) % n) + n) % n).sort((a, b) => a - b);
    }
  }
}

// --- コピー・貼り付け ------------------------------------------------------------

/** Things copied, as they were on their page. */
export interface Clip {
  pageId: string;
  strokes: Stroke[];
  lines: Line[];
  panels: Panel[];
  breakouts: Breakout[];
  stickies: Sticky[];
  fills?: Fill[];
}

export interface CopySource {
  kind: "panel" | "line" | "stroke" | "breakout" | "group" | "sticky" | "fill";
  pageId: string;
  id: string;
  items?: ItemRef[];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Copy what is selected. A panel comes with what is in it (its dialogue and
 * rough lines), so that pasting it gives the whole panel again.
 */
export function copySelection(page: Page, selection: CopySource, contents?: { strokes: string[]; lines: string[] }): Clip | null {
  const clip: Clip = { pageId: page.id, strokes: [], lines: [], panels: [], breakouts: [], stickies: [] };
  const take = (kind: ItemRef["kind"], id: string) => {
    if (kind === "stroke") {
      const stroke = page.strokes.find((s) => s.id === id);
      if (stroke) clip.strokes.push(clone(stroke));
    } else if (kind === "line") {
      const line = page.lines.find((l) => l.id === id);
      if (line) clip.lines.push(clone(line));
    } else if (kind === "panel") {
      const panel = page.panels.find((p) => p.id === id);
      if (panel) clip.panels.push(clone(panel));
    } else if (kind === "fill") {
      const fill = page.fills?.find((f) => f.id === id);
      if (fill) clip.fills = [...(clip.fills ?? []), clone(fill)];
    } else {
      const breakout = page.breakouts.find((b) => b.id === id);
      if (breakout) clip.breakouts.push(clone(breakout));
    }
  };
  switch (selection.kind) {
    case "panel": {
      const panel = page.panels.find((p) => p.id === selection.id);
      if (!panel) return null;
      clip.panels.push(clone(panel));
      for (const id of contents?.strokes ?? []) take("stroke", id);
      for (const id of contents?.lines ?? []) take("line", id);
      break;
    }
    case "group":
      for (const item of selection.items ?? []) take(item.kind, item.id);
      break;
    case "stroke":
    case "line":
      take(selection.kind, selection.id);
      break;
    case "breakout": {
      const breakout = page.breakouts.find((b) => b.id === selection.id);
      if (breakout) clip.breakouts.push(clone(breakout));
      break;
    }
    case "sticky": {
      const sticky = page.stickies?.find((n) => n.id === selection.id);
      if (sticky) clip.stickies.push(clone(sticky));
      break;
    }
    case "fill": {
      const fill = page.fills?.find((f) => f.id === selection.id);
      if (fill) clip.fills = [clone(fill)];
      break;
    }
  }
  // 付箋 about what is copied come along with it.
  const copied = new Set([...clip.panels.map((p) => p.id), ...clip.lines.map((l) => l.id)]);
  for (const sticky of page.stickies ?? []) {
    if (sticky.link && copied.has(sticky.link.id) && !clip.stickies.some((n) => n.id === sticky.id)) clip.stickies.push(clone(sticky));
  }
  const empty = !clip.strokes.length && !clip.lines.length && !clip.panels.length && !clip.breakouts.length && !clip.stickies.length && !clip.fills?.length;
  return empty ? null : clip;
}

/** What was pasted, to select it. */
export interface Pasted {
  panels: string[];
  strokes: string[];
  lines: string[];
  breakouts: string[];
  stickies: string[];
  fills: string[];
}

/**
 * Paste `clip` onto `page`, moved by `offset` mm. Everything gets new ids;
 * balloons stay joined only to balloons pasted with them, and a pasted half
 * of a 見開き panel becomes a panel of its own.
 */
export function pasteClip(project: Project, page: Page, clip: Clip, offset: Point = [0, 0]): Pasted {
  const [dx, dy] = offset;
  const move = ([x, y]: readonly number[]): Point => [x + dx, y + dy];
  const pasted: Pasted = { panels: [], strokes: [], lines: [], breakouts: [], stickies: [], fills: [] };
  for (const source of clip.fills ?? []) {
    const fill = clone(source);
    fill.id = newId(project, "fill");
    mapFill(fill, move);
    page.fills = [...(page.fills ?? []), fill];
    pasted.fills.push(fill.id);
  }
  const panelIds = new Map<string, string>();
  for (const source of clip.panels) {
    const panel = clone(source);
    panel.id = newId(project, "panel");
    panelIds.set(source.id, panel.id);
    panel.shape = panel.shape.map(move);
    delete panel.spread;
    page.panels.push(panel);
    pasted.panels.push(panel.id);
  }
  for (const source of clip.strokes) {
    const stroke = clone(source);
    stroke.id = newId(project, "stroke");
    stroke.points = stroke.points.map((p) => [...move(p), ...p.slice(2)] as StrokePoint);
    page.strokes.push(stroke);
    pasted.strokes.push(stroke.id);
  }
  const lineIds = new Map<string, string>();
  for (const source of clip.lines) lineIds.set(source.id, newId(project, "line"));
  for (const source of clip.lines) {
    const line = clone(source);
    line.id = lineIds.get(source.id)!;
    line.box = [line.box[0] + dx, line.box[1] + dy, line.box[2] + dx, line.box[3] + dy];
    if (line.balloon) line.balloon = line.balloon.map(move);
    for (const tail of line.tails ?? []) tail.tip = move(tail.tip);
    if (line.linkTo && lineIds.has(line.linkTo)) line.linkTo = lineIds.get(line.linkTo);
    else delete line.linkTo;
    delete line.panel;
    page.lines.push(line);
    pasted.lines.push(line.id);
  }
  for (const source of clip.breakouts) {
    const breakout = clone(source);
    breakout.id = newId(project, "breakout");
    breakout.shape = breakout.shape.map(move);
    page.breakouts.push(breakout);
    pasted.breakouts.push(breakout.id);
  }
  for (const source of clip.stickies) {
    const sticky = clone(source);
    sticky.id = newId(project, "sticky");
    sticky.at = move(sticky.at);
    // Still tied to what it was about when that came along or is on this page; otherwise loose.
    const tied = sticky.link && (sticky.link.kind === "panel" ? panelIds : lineIds).get(sticky.link.id);
    if (sticky.link && tied) sticky.link.id = tied;
    else if (clip.pageId !== page.id) delete sticky.link;
    page.stickies = [...(page.stickies ?? []), sticky];
    pasted.stickies.push(sticky.id);
  }
  if (pasted.panels.length) orderPanels(page, project.binding);
  assignPanels(page);
  sortLines(page, project.binding);
  return pasted;
}

// --- 直線 ----------------------------------------------------------------------

/** The end of a straight line: along 0°, 45°, 90°... when within 3° of one. */
export function straightEnd(start: readonly number[], end: Point): Point {
  const [dx, dy] = [end[0] - start[0], end[1] - start[1]];
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(angle / step) * step;
  if (Math.abs(angle - snapped) > (3 * Math.PI) / 180) return end;
  return [start[0] + Math.cos(snapped) * length, start[1] + Math.sin(snapped) * length];
}

/** A straight line as points about every half millimetre, each value going evenly from one end to the other. */
export function densify(points: StrokePoint[]): StrokePoint[] {
  if (points.length !== 2) return points;
  const [a, b] = points;
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
  return Array.from({ length: steps + 1 }, (_, i) => a.map((value, k) => value + ((b[k] ?? value) - value) * (i / steps)) as StrokePoint);
}

/** The box of what is selected (mm): one thing of `kind`, or `items` picked together. */
export function selectionBox(page: Page, kind: string, id: string, items: readonly ItemRef[]): BoxMm | null {
  if (kind === "panel") {
    const panel = page.panels.find((p) => p.id === id);
    return panel ? bounds(panel.shape) : null;
  }
  if (kind === "line") {
    const line = page.lines.find((l) => l.id === id);
    return line ? bounds([[line.box[0], line.box[1]], [line.box[2], line.box[3]], ...(line.balloon ?? [])]) : null;
  }
  if (kind === "breakout") {
    const breakout = page.breakouts.find((b) => b.id === id);
    return breakout ? bounds(breakout.shape) : null;
  }
  if (kind === "sticky") {
    const sticky = page.stickies?.find((n) => n.id === id);
    return sticky ? stickyBox(sticky) : null;
  }
  if (kind === "fill") {
    const fill = page.fills?.find((f) => f.id === id);
    return fill ? bounds(fill.shape) : null;
  }
  return baseBounds(transformBase(page, items));
}

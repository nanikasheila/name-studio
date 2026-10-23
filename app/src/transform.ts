// 選んだものの変形（拡大縮小・回転・反転）とコピー・貼り付け. Rough lines
// change shape with the transform; dialogue keeps its size and moves with
// its centre, its tails pointing where they pointed.
import {
  assignPanels,
  bounds,
  newId,
  orderPanels,
  sortLines,
  type BoxMm,
  type Breakout,
  type Line,
  type Page,
  type Panel,
  type Point,
  type Project,
  type Sticky,
  type Stroke,
  type StrokePoint,
} from "./project";

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

/** What a selection is made of: rough lines and dialogue. */
export interface ItemRef {
  kind: "stroke" | "line";
  id: string;
}

/** The selected things as they were when a transform began. */
export interface TransformBase {
  strokes: { id: string; points: StrokePoint[]; widthMm: number }[];
  lines: { id: string; box: BoxMm; balloon?: Point[]; tails?: Point[] }[];
}

export function transformBase(page: Page, items: readonly ItemRef[]): TransformBase {
  const ids = (kind: ItemRef["kind"]) => new Set(items.filter((item) => item.kind === kind).map((item) => item.id));
  const strokes = ids("stroke");
  const lines = ids("line");
  return {
    strokes: page.strokes
      .filter((s) => strokes.has(s.id))
      .map((s) => ({ id: s.id, points: s.points.map((p) => [...p] as StrokePoint), widthMm: s.widthMm })),
    lines: page.lines
      .filter((l) => lines.has(l.id))
      .map((l) => ({
        id: l.id,
        box: [...l.box] as BoxMm,
        ...(l.balloon ? { balloon: l.balloon.map((p) => [...p] as Point) } : {}),
        ...(l.tails ? { tails: l.tails.map((t) => [...t.tip] as Point) } : {}),
      })),
  };
}

/** The box around the selected rough lines and dialogue (balloons included). */
export function baseBounds(base: TransformBase): BoxMm | null {
  const points: Point[] = [];
  for (const stroke of base.strokes) for (const [x, y] of stroke.points) points.push([x, y]);
  for (const line of base.lines) {
    points.push([line.box[0], line.box[1]], [line.box[2], line.box[3]]);
    for (const p of line.balloon ?? []) points.push(p);
  }
  return points.length ? bounds(points) : null;
}

/**
 * Put the selected things where `m` takes them from `base`. Line widths
 * follow the size (the square root of the area's change), never below
 * 0.05 mm.
 */
export function transformItems(page: Page, base: TransformBase, m: Affine): void {
  const sizeFactor = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  for (const { id, points, widthMm } of base.strokes) {
    const stroke = page.strokes.find((s) => s.id === id);
    if (!stroke) continue;
    stroke.points = points.map((p) => [...applyAffine(m, p), ...p.slice(2)] as StrokePoint);
    stroke.widthMm = Math.max(0.05, Math.round(widthMm * sizeFactor * 1000) / 1000);
  }
  for (const { id, box, balloon, tails } of base.lines) {
    const line = page.lines.find((l) => l.id === id);
    if (!line) continue;
    const centre: Point = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    const [cx, cy] = applyAffine(m, centre);
    const [dx, dy] = [cx - centre[0], cy - centre[1]];
    line.box = [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
    if (balloon) line.balloon = balloon.map(([x, y]) => [x + dx, y + dy]);
    if (tails && line.tails) line.tails.forEach((tail, i) => tails[i] && (tail.tip = applyAffine(m, tails[i])));
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
}

export interface CopySource {
  kind: "panel" | "line" | "stroke" | "breakout" | "group" | "sticky";
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
    } else {
      const line = page.lines.find((l) => l.id === id);
      if (line) clip.lines.push(clone(line));
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
  }
  const empty = !clip.strokes.length && !clip.lines.length && !clip.panels.length && !clip.breakouts.length && !clip.stickies.length;
  return empty ? null : clip;
}

/** What was pasted, to select it. */
export interface Pasted {
  panels: string[];
  strokes: string[];
  lines: string[];
  breakouts: string[];
  stickies: string[];
}

/**
 * Paste `clip` onto `page`, moved by `offset` mm. Everything gets new ids;
 * balloons stay joined only to balloons pasted with them, and a pasted half
 * of a 見開き panel becomes a panel of its own.
 */
export function pasteClip(project: Project, page: Page, clip: Clip, offset: Point = [0, 0]): Pasted {
  const [dx, dy] = offset;
  const move = ([x, y]: readonly number[]): Point => [x + dx, y + dy];
  const pasted: Pasted = { panels: [], strokes: [], lines: [], breakouts: [], stickies: [] };
  for (const source of clip.panels) {
    const panel = clone(source);
    panel.id = newId(project, "panel");
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
    page.stickies = [...(page.stickies ?? []), sticky];
    pasted.stickies.push(sticky.id);
  }
  if (pasted.panels.length) orderPanels(page, project.binding);
  assignPanels(page);
  sortLines(page);
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

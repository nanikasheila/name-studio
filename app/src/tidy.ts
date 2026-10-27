// 整える (清書): panels laid out roughly made exact. Almost level or upright
// edges are made so, edges almost in line are lined up (with each other and
// with the panels left as they are), outer edges go to the 基本枠 or, drawn
// past it, off the paper (裁ち切り), and the gaps between neighbours become
// the name's コマ間. What a panel holds follows it. Each panel's edges are
// moved as lines and its corners found again where they meet, so slanted
// edges stay slanted and the panel keeps its number of corners.
import { area, bounds } from "./geometry";
import type { Gutters, Page, PageFormat, Panel, Point, Project } from "./model";
import { MAX_GUTTER_MM } from "./komaedit";
import { basicBox, trimBox } from "./pagebox";
import { carryContents, followPanel } from "./panels";
import { gutters } from "./project";
import { assignPanels, orderPanels, sortLines } from "./readingorder";

/** Edges within this of level or upright are made exactly so (degrees). */
export const STRAIGHT_DEGREES = 5;
/** Edges facing the same way this close (mm) are put in line. */
const ALIGN_MM = 3;
/** An outer edge this close inside the 基本枠 (mm) goes onto it (outside, up to halfway to the trim); past that, off the paper. */
const FRAME_MM = 4;
/** Edges facing each other this far apart at most (mm; overlapping by up to OVERLAP_MM) are neighbours across a gutter. */
const GAP_MM = MAX_GUTTER_MM + 4;
const OVERLAP_MM = 8;

type Facing = "left" | "right" | "top" | "bottom";

const NORMALS: Record<Facing, Point> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

/** One edge as a line: the points p with n·p = c, n pointing out of the panel. */
interface EdgeLine {
  n: Point;
  c: number;
  /** Level or upright: which way it faces. */
  facing: Facing | null;
  /** Where it was: its ends, to measure overlaps and to fall back on. */
  a: Point;
  b: Point;
  open: boolean;
}

const dot = (p: Point, q: Point) => p[0] * q[0] + p[1] * q[1];

function signedArea(shape: readonly Point[]): number {
  let sum = 0;
  shape.forEach(([x0, y0], i) => {
    const [x1, y1] = shape[(i + 1) % shape.length];
    sum += x0 * y1 - x1 * y0;
  });
  return sum / 2;
}

/** Which way a normal faces, when it is within `degrees` of level or upright. */
function facingOf(n: Point, degrees = STRAIGHT_DEGREES): Facing | null {
  const limit = Math.cos((degrees * Math.PI) / 180);
  for (const facing of Object.keys(NORMALS) as Facing[]) if (dot(n, NORMALS[facing]) >= limit) return facing;
  return null;
}

/** Where a level or upright line lies: x for left and right, y for top and bottom. */
const along = (facing: Facing) => (facing === "left" || facing === "right" ? 0 : 1);

function setFacing(line: EdgeLine, facing: Facing, value: number): void {
  line.facing = facing;
  line.n = NORMALS[facing];
  const point: Point = along(facing) === 0 ? [value, 0] : [0, value];
  line.c = dot(line.n, point);
}

function valueOf(line: EdgeLine): number {
  return line.facing === "left" || line.facing === "top" ? -line.c : line.c;
}

/**
 * A panel's edges as lines, made straight when `straighten`, and runs of
 * edges along one line made one (a corner list without points mid-edge).
 */
function edgeLines(panel: Panel, straighten: boolean): EdgeLine[] {
  const shape = panel.shape;
  const turn = signedArea(shape) >= 0 ? 1 : -1;
  const open = new Set(panel.openEdges ?? []);
  const lines: EdgeLine[] = [];
  shape.forEach((a, i) => {
    const b = shape[(i + 1) % shape.length];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const length = Math.hypot(dx, dy);
    if (length < 0.05) return;
    const n: Point = [(turn * dy) / length, (-turn * dx) / length];
    const line: EdgeLine = { n, c: dot(n, a), facing: null, a, b, open: open.has(i) };
    const facing = facingOf(n, straighten ? STRAIGHT_DEGREES : 0.01);
    if (facing) setFacing(line, facing, along(facing) === 0 ? (a[0] + b[0]) / 2 : (a[1] + b[1]) / 2);
    lines.push(line);
  });
  // One line for edges that run on along it.
  const length = (line: EdgeLine) => Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]);
  for (let merged = true; merged && lines.length > 3; ) {
    merged = false;
    for (let i = 0; i < lines.length; i++) {
      const [line, next] = [lines[i], lines[(i + 1) % lines.length]];
      if (dot(line.n, next.n) < Math.cos((2 * Math.PI) / 180)) continue;
      const [la, lb] = [length(line), length(next)];
      if (line.facing && line.facing === next.facing) setFacing(line, line.facing, (valueOf(line) * la + valueOf(next) * lb) / (la + lb));
      else line.c = (line.c * la + dot(line.n, [(next.a[0] + next.b[0]) / 2, (next.a[1] + next.b[1]) / 2]) * lb) / (la + lb);
      line.b = next.b;
      line.open = line.open && next.open;
      lines.splice((i + 1) % lines.length, 1);
      merged = true;
      break;
    }
  }
  return lines;
}

/** Where two edge lines meet, or `fallback` put on `second` when they run alongside. */
function meet(first: EdgeLine, second: EdgeLine, fallback: Point): Point {
  const det = first.n[0] * second.n[1] - first.n[1] * second.n[0];
  if (Math.abs(det) < 1e-6) {
    const off = dot(second.n, fallback) - second.c;
    return [fallback[0] - off * second.n[0], fallback[1] - off * second.n[1]];
  }
  return [(first.c * second.n[1] - second.c * first.n[1]) / det, (first.n[0] * second.c - second.n[0] * first.c) / det];
}

/** The corners where a panel's edge lines meet, each edge starting at its corner. */
function cornersOf(lines: readonly EdgeLine[]): Point[] {
  // To a ten-thousandth of a millimetre (and no -0), so that edges put on one line are on it exactly.
  const round = (value: number) => Math.round(value * 1e4) / 1e4 + 0;
  return lines.map((line, i) => meet(lines[(i - 1 + lines.length) % lines.length], line, line.a).map(round) as Point);
}

/** Whether a new outline is still the panel it was: not turned inside out, not much bigger or smaller, no corner run off (but to the paper's edge). */
function believable(before: readonly Point[], after: readonly Point[], edge?: readonly [number, number]): boolean {
  if (after.length < 3 || signedArea(after) * signedArea(before) <= 0) return false;
  const ratio = area(after) / Math.max(area(before), 1e-6);
  if (ratio < 0.5 || ratio > 2) return false;
  const [x0, y0, x1, y1] = bounds(before);
  const reach = 25;
  const near = (value: number, low: number, high: number, end: number) => (value > low - reach && value < high + reach) || (edge && (value === 0 || value === end));
  return after.every(([x, y]) => near(x, x0, x1, edge?.[0] ?? 0) && near(y, y0, y1, edge?.[1] ?? 0));
}

/** A drawn outline with almost level or upright edges made exactly so (and corners mid-edge taken out). */
export function straightenShape(shape: readonly Point[]): Point[] {
  const lines = edgeLines({ id: "", order: 0, shape: [...shape] }, true);
  const corners = cornersOf(lines);
  return believable(shape, corners) ? corners : [...shape];
}

/** Edges of the same panels facing the same way and almost in line: one group, moved as one. */
interface Group {
  facing: Facing;
  value: number;
  members: { panel: number; line: EdgeLine }[];
  /** Put somewhere already (on a panel left as it is, on the frame, at a gutter): not moved again. */
  fixed: boolean;
}

function groupsOf(edges: { panel: number; line: EdgeLine; fixed: boolean }[], facing: Facing): Group[] {
  const sorted = edges.filter((edge) => edge.line.facing === facing).sort((p, q) => valueOf(p.line) - valueOf(q.line));
  const groups: Group[] = [];
  let first = -Infinity;
  for (const edge of sorted) {
    const value = valueOf(edge.line);
    let group = groups[groups.length - 1];
    if (!group || value - first > ALIGN_MM) {
      group = { facing, value: 0, members: [], fixed: false };
      groups.push(group);
      first = value;
    }
    group.members.push({ panel: edge.panel, line: edge.line });
    if (edge.fixed && !group.fixed) {
      group.fixed = true;
      group.value = value;
    }
  }
  for (const group of groups) {
    if (group.fixed) continue;
    let weight = 0;
    let sum = 0;
    for (const { line } of group.members) {
      const length = Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]);
      weight += length;
      sum += valueOf(line) * length;
    }
    group.value = weight ? sum / weight : valueOf(group.members[0].line);
  }
  return groups;
}

/** The outer edges onto the 基本枠, or past it off the paper. */
function toFrame(group: Group, format: PageFormat): void {
  if (group.fixed) return;
  const [bx0, by0, bx1, by1] = basicBox(format);
  const [tx0, ty0, tx1, ty1] = trimBox(format);
  const [w, h] = format.canvasMm;
  const { frame, trim, edge, outward } = {
    left: { frame: bx0, trim: tx0, edge: 0, outward: -1 },
    right: { frame: bx1, trim: tx1, edge: w, outward: 1 },
    top: { frame: by0, trim: ty0, edge: 0, outward: -1 },
    bottom: { frame: by1, trim: ty1, edge: h, outward: 1 },
  }[group.facing];
  const past = (group.value - frame) * outward;
  // Drawn a little past the frame is the frame; halfway to the trim or more is off the paper.
  const halfway = Math.max(FRAME_MM, ((trim - frame) * outward) / 2);
  if (past >= -FRAME_MM && past <= halfway) group.value = frame;
  else if (past > halfway) group.value = edge;
  else return;
  group.fixed = true;
}

/** How far apart along an edge's run two edges lie side by side (mm; negative: not at all). */
function overlap(p: EdgeLine, q: EdgeLine): number {
  const dir: Point = [-p.n[1], p.n[0]];
  const [p0, p1] = [dot(dir, p.a), dot(dir, p.b)].sort((x, y) => x - y);
  const [q0, q1] = [dot(dir, q.a), dot(dir, q.b)].sort((x, y) => x - y);
  return Math.min(p1, q1) - Math.max(p0, q0);
}

/** Two groups facing each other across a gutter: set `gap` apart, round their middle (or from the one already put). */
function spaceGroups(before: Group, after: Group, gap: number): boolean {
  if (before.fixed && after.fixed) return false;
  if (before.fixed) after.value = before.value + gap;
  else if (after.fixed) before.value = after.value - gap;
  else {
    const middle = (before.value + after.value) / 2;
    before.value = middle - gap / 2;
    after.value = middle + gap / 2;
  }
  before.fixed = after.fixed = true;
  return true;
}

/** Neighbours across level or upright gutters: right edges with left ones, bottom edges with top ones. */
function spaceAxisGutters(groups: Map<Facing, Group[]>, gaps: Gutters): void {
  const pairs: { before: Group; after: Group; gap: number; width: number }[] = [];
  for (const [first, second, gap] of [["right", "left", gaps.across], ["bottom", "top", gaps.down]] as const) {
    for (const before of groups.get(first) ?? []) {
      for (const after of groups.get(second) ?? []) {
        const width = after.value - before.value;
        if (width < -OVERLAP_MM || width > GAP_MM) continue;
        const facing = before.members.some((p) => after.members.some((q) => p.panel !== q.panel && overlap(p.line, q.line) > 3));
        if (facing) pairs.push({ before, after, gap, width });
      }
    }
  }
  // The narrowest first: those are the gutters meant.
  pairs.sort((p, q) => Math.abs(p.width - p.gap) - Math.abs(q.width - q.gap));
  for (const { before, after, gap } of pairs) spaceGroups(before, after, gap);
}

/** Slanted edges (of 仮のコマ) facing each other across a gutter: made parallel, the gutter's width apart. */
function spaceSlantedGutters(edges: { panel: number; line: EdgeLine; fixed: boolean }[], gaps: Gutters): void {
  const slanted = edges.filter((edge) => !edge.line.facing && !edge.fixed);
  const done = new Set<EdgeLine>();
  for (const p of slanted) {
    for (const q of slanted) {
      if (p.panel === q.panel || done.has(p.line) || done.has(q.line)) continue;
      if (dot(p.line.n, q.line.n) > -Math.cos((8 * Math.PI) / 180)) continue;
      const mid = (line: EdgeLine): Point => [(line.a[0] + line.b[0]) / 2, (line.a[1] + line.b[1]) / 2];
      const width = dot(p.line.n, mid(q.line)) - p.line.c;
      if (width < -OVERLAP_MM || width > GAP_MM || overlap(p.line, q.line) <= 3) continue;
      const nx = p.line.n[0] - q.line.n[0];
      const ny = p.line.n[1] - q.line.n[1];
      const length = Math.hypot(nx, ny);
      const n: Point = [nx / length, ny / length];
      const [pm, qm] = [mid(p.line), mid(q.line)];
      const middle = dot(n, [(pm[0] + qm[0]) / 2, (pm[1] + qm[1]) / 2]);
      const gap = Math.abs(n[1]) > Math.abs(n[0]) ? gaps.down : gaps.across;
      p.line.n = n;
      p.line.c = middle - gap / 2;
      q.line.n = [-n[0], -n[1]];
      q.line.c = -(middle + gap / 2);
      done.add(p.line);
      done.add(q.line);
    }
  }
}

/** The panels 整える would change on a page: those chosen, else the 仮のコマ, else all of them (見開き halves stay). */
export function panelsToTidy(page: Page, chosen: readonly string[] = []): Panel[] {
  const panels = page.panels.filter((panel) => !panel.spread && panel.shape.length >= 3);
  if (chosen.length) return panels.filter((panel) => chosen.includes(panel.id));
  const drafts = panels.filter((panel) => panel.draft);
  return drafts.length ? drafts : panels;
}

export interface Tidied {
  /** Panels made exact (and no longer 仮). */
  tidied: number;
  /** Panels whose shape could not be made out (left as they were). */
  kept: number;
}

/**
 * 整える the panels of a page with ids in `ids` (see panelsToTidy): the
 * others stay as they are and the tidied ones line up with them.
 */
export function tidyPanels(project: Project, page: Page, ids: readonly string[]): Tidied {
  const format = project.pageFormat;
  const targets = page.panels.filter((panel) => ids.includes(panel.id));
  if (!targets.length) return { tidied: 0, kept: 0 };
  // What each holds, from where things are before anything moves.
  const carried = new Map(targets.map((panel) => [panel.id, carryContents(page, panel)]));
  // Only 仮のコマ (drawn by hand) have their almost straight edges straightened: a slight slant
  // in a panel made exactly is meant. Insets (はめ込み) are only straightened: they sit over a panel on purpose.
  const lines = targets.map((panel) => edgeLines(panel, !!panel.draft));
  const edges: { panel: number; line: EdgeLine; fixed: boolean }[] = [];
  targets.forEach((panel, index) => {
    if ((panel.z ?? 0) > 0) return;
    for (const line of lines[index]) edges.push({ panel: index, line, fixed: false });
  });
  // The panels left as they are hold their edges where they are.
  page.panels.forEach((panel, index) => {
    if (ids.includes(panel.id) || (panel.z ?? 0) > 0) return;
    for (const line of edgeLines(panel, false)) if (line.facing) edges.push({ panel: targets.length + index, line, fixed: true });
  });
  const groups = new Map<Facing, Group[]>();
  for (const facing of Object.keys(NORMALS) as Facing[]) {
    const found = groupsOf(edges, facing);
    for (const group of found) toFrame(group, format);
    groups.set(facing, found);
  }
  const gaps = gutters(project);
  spaceAxisGutters(groups, gaps);
  for (const found of groups.values()) {
    for (const group of found) for (const { panel, line } of group.members) if (panel < targets.length) setFacing(line, group.facing, group.value);
  }
  spaceSlantedGutters(
    edges.filter((edge) => targets[edge.panel]?.draft),
    gaps,
  );

  let tidied = 0;
  targets.forEach((panel, index) => {
    const shape = cornersOf(lines[index]);
    if (!believable(panel.shape, shape, format.canvasMm)) return;
    panel.shape = shape;
    // 裁ち切り: edges open before stay open, and so do those now on the paper's edge.
    const [w, h] = format.canvasMm;
    const onEdge = ([x, y]: Point) => x <= 0.05 || x >= w - 0.05 || y <= 0.05 || y >= h - 0.05;
    const open = lines[index].flatMap((line, i) => {
      const [a, b] = [shape[i], shape[(i + 1) % shape.length]];
      const sameSide = (a[0] <= 0.05 && b[0] <= 0.05) || (a[0] >= w - 0.05 && b[0] >= w - 0.05) || (a[1] <= 0.05 && b[1] <= 0.05) || (a[1] >= h - 0.05 && b[1] >= h - 0.05);
      return line.open || (sameSide && onEdge(a) && onEdge(b)) ? [i] : [];
    });
    if (open.length) panel.openEdges = open;
    else delete panel.openEdges;
    delete panel.draft;
    tidied++;
  });
  for (const panel of targets) {
    const contents = carried.get(panel.id);
    if (contents) followPanel(page, panel, contents);
  }
  orderPanels(page, project.binding);
  assignPanels(page);
  sortLines(page, project.binding);
  return { tidied, kept: targets.length - tidied };
}

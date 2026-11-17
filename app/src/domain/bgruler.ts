// 透視の定規: a panel's eye level and vanishing points held together, like
// a perspective ruler. The ruler has 1, 2 or 3 points: the first two lie on
// the eye level (the horizon), the third (3点) is where the upright lines
// meet, above it when looking up and below when looking down. Each point is
// set by a line drawn along an edge in the panel (X・Y・Z の線): the X and
// Y lines meet the eye level at their points, the two Z lines meet each
// other, so a point beyond the panel (or the paper) is set from inside it.
// Moving the eye level keeps the lines and slides the points along them;
// moving a point moves the eye level with it and turns the lines to it.
import { bounds } from "../model/geometry";
import type { Panel, PanelBackground, Point } from "../model/model";
import { backgroundOf, setBackground } from "./background";

export type Perspective = 0 | 1 | 2 | 3;
export const PERSPECTIVES: readonly Perspective[] = [0, 1, 2, 3];
export const PERSPECTIVE_LABELS: Record<Perspective, string> = { 0: "なし", 1: "1点", 2: "2点", 3: "3点" };
export const PERSPECTIVE_TITLES: Record<Perspective, string> = {
  0: "透視の定規を外す（アイレベル・消失点・線を消す）",
  1: "1点透視: カメラは奥を正面に向く。奥へ向かう線（X）がアイレベルの上の 1 点に集まる",
  2: "2点透視: 水平なカメラ。X と Y の線がアイレベルの上の 2 点に集まり、縦の線はまっすぐ",
  3: "3点透視: 見上げ・見下ろし。X と Y はアイレベルの上、縦の線（Z）は 3 つ目の点に集まる（下なら見下ろし、上なら見上げ）",
};
/** The axis each line belongs to, by its place in `guides`. */
export const GUIDE_AXES = ["X", "Y", "Z", "Z"] as const;
/** The colour of each axis (the eye level stays green). */
export const AXIS_COLORS: Record<(typeof GUIDE_AXES)[number], string> = { X: "#d64545", Y: "#3b6fd8", Z: "#9b4dca" };
/** The axis of vanishing point `index`. */
export const axisOf = (index: number) => GUIDE_AXES[Math.min(index, 2)];

type Line = [Point, Point];

/** The ruler as it holds together: its points, the eye level, the points and the lines. */
export interface Ruler {
  points: Perspective;
  horizon?: Line;
  vanishing: Point[];
  /** One per point on the eye level, two for the third. */
  guides: Line[];
}

/** How many points a panel's ruler has (as many as are placed when not chosen). */
export function perspectiveOf(bg: PanelBackground): Perspective {
  const n = bg.perspective ?? bg.vanishing?.length ?? 0;
  return Math.max(0, Math.min(3, Math.round(n))) as Perspective;
}

/** How many lines a ruler of `points` has. */
export const guideCount = (points: Perspective) => (points === 3 ? 4 : points);

/** The point a line `k` sets (0, 1, then the third for both Z lines). */
export const pointOfGuide = (k: number) => Math.min(k, 2);

// --- geometry along the eye level ----------------------------------------------------------------

interface Frame {
  o: Point;
  u: Point;
  n: Point;
}

/** The eye level as a frame: along it to the right (s), and across it downwards (t). */
function frameOf([a, b]: Line): Frame {
  let [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = Math.hypot(dx, dy) || 1;
  if (dx < 0) [dx, dy] = [-dx, -dy];
  const u: Point = [dx / length, dy / length];
  return { o: a, u, n: [-u[1], u[0]] };
}
const along = (f: Frame, p: Point) => (p[0] - f.o[0]) * f.u[0] + (p[1] - f.o[1]) * f.u[1];
const off = (f: Frame, p: Point) => (p[0] - f.o[0]) * f.n[0] + (p[1] - f.o[1]) * f.n[1];
const at = (f: Frame, s: number, t: number): Point => [f.o[0] + s * f.u[0] + t * f.n[0], f.o[1] + s * f.u[1] + t * f.n[1]];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (p: Point): Point => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];

/** How far a point may go when lines are nearly parallel: this many times the panel's size. */
const FAR = 40;

function size(panel: Panel): { box: [number, number, number, number]; w: number; h: number; centre: Point } {
  const box = bounds(panel.shape);
  const [x0, y0, x1, y1] = box;
  return { box, w: x1 - x0, h: y1 - y0, centre: [(x0 + x1) / 2, (y0 + y1) / 2] };
}

/** A level eye level across the panel at `y`. */
function level(panel: Panel, y: number): Line {
  const [x0, , x1] = bounds(panel.shape);
  return [
    [x0, y],
    [x1, y],
  ];
}

/** Where line `a`–`b` meets line `c`–`d`; nearly parallel: far along `a`–`b` (towards `b`). */
function meet([a, b]: Line, [c, d]: Line, far: number): Point {
  const r: Point = [b[0] - a[0], b[1] - a[1]];
  const q: Point = [d[0] - c[0], d[1] - c[1]];
  const cross = r[0] * q[1] - r[1] * q[0];
  const length = Math.hypot(...r) || 1;
  if (Math.abs(cross) > 1e-9) {
    const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / cross;
    const p: Point = [a[0] + r[0] * t, a[1] + r[1] * t];
    if (Math.hypot(p[0] - a[0], p[1] - a[1]) <= far) return p;
  }
  return [a[0] + (r[0] / length) * far, a[1] + (r[1] / length) * far];
}

/** A line turned (about its end farther from `point`) to aim at `point`, its length kept (short of the point); one through it already stays. */
function aim([a, b]: Line, point: Point): Line {
  // Already through the point: kept as drawn.
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const span = Math.hypot(dx, dy);
  if (span > 1e-6 && Math.abs((point[0] - a[0]) * dy - (point[1] - a[1]) * dx) / span < 0.02) return [a, b];
  const da = Math.hypot(point[0] - a[0], point[1] - a[1]);
  const db = Math.hypot(point[0] - b[0], point[1] - b[1]);
  const [pivot, other] = da >= db ? [a, b] : [b, a];
  const to = Math.max(da, db);
  if (to < 1e-6) return [a, b];
  const length = Math.min(Math.hypot(other[0] - pivot[0], other[1] - pivot[1]), 0.8 * to);
  const end: Point = [pivot[0] + ((point[0] - pivot[0]) / to) * length, pivot[1] + ((point[1] - pivot[1]) / to) * length];
  return da >= db ? [round(pivot), round(end)] : [round(end), round(pivot)];
}

/** The third point kept between the first two (across the eye level) and off it, so a camera can be found. */
function third(f: Frame, v1: Point, v2: Point, v3: Point, h: number): Point {
  const [s1, s2] = [along(f, v1), along(f, v2)].sort((a, b) => a - b);
  const margin = 0.1 * (s2 - s1);
  const s = s2 - s1 < 1e-6 ? s1 : clamp(along(f, v3), s1 + margin, s2 - margin);
  const t0 = off(f, v3);
  const least = 0.25 * h;
  return at(f, s, Math.abs(t0) < least ? (t0 < 0 ? -least : least) : t0);
}

/** Lines in the panel aimed at each point, where none were drawn: on the roomier side of the eye level. */
function defaultGuides(panel: Panel, horizon: Line, vanishing: Point[]): Line[] {
  const { box, w, h, centre } = size(panel);
  const [x0, y0, x1, y1] = box;
  const f = frameOf(horizon);
  const cs = along(f, centre);
  const ch = off(f, centre);
  // Below the eye level when there is more of the panel there.
  const side = ch >= 0 ? 1 : -1;
  const inside = (p: Point): Point => [clamp(p[0], x0 + 0.05 * w, x1 - 0.05 * w), clamp(p[1], y0 + 0.05 * h, y1 - 0.05 * h)];
  const lineTo = (anchor: Point, point: Point): Line => aim([anchor, [anchor[0] + 0.01, anchor[1]]], point);
  const guides: Line[] = [];
  const spots = [-0.25, 0.25];
  vanishing.slice(0, 2).forEach((point, i) => {
    // The anchor away from its point, so the line runs across the panel towards it.
    const away = along(f, point) >= cs ? -1 : 1;
    const anchor = inside(at(f, cs + away * 0.35 * w + spots[i] * 0.2 * w, side * Math.max((i ? 0.42 : 0.22) * h, Math.abs(ch) * 0.8)));
    const line = lineTo(anchor, point);
    guides.push(stretch(line, point, 0.3 * w));
  });
  if (vanishing[2]) {
    for (const s of spots) {
      const anchor = inside(at(f, cs + s * 1.4 * w, off(f, vanishing[2]) > 0 ? -0.3 * h + ch : 0.3 * h + ch));
      guides.push(stretch(lineTo(anchor, vanishing[2]), vanishing[2], 0.5 * h));
    }
  }
  return guides;
}

/** A line from its anchor (the first end) `length` long towards `point` (short of it). */
function stretch([a]: Line, point: Point, length: number): Line {
  const to = Math.hypot(point[0] - a[0], point[1] - a[1]) || 1;
  const l = Math.min(length, 0.8 * to);
  return [round(a), round([a[0] + ((point[0] - a[0]) / to) * l, a[1] + ((point[1] - a[1]) / to) * l])];
}

// --- the ruler -----------------------------------------------------------------------------------

/** A panel's ruler, held together (the points on the eye level, the third between, lines for each). */
export function rulerOf(panel: Panel): Ruler {
  const bg = backgroundOf(panel);
  const points = perspectiveOf(bg);
  const given = (bg.vanishing ?? []).slice(0, points);
  const horizon = bg.horizon ?? (given[0] ? level(panel, given[0][1]) : undefined);
  if (!horizon) return { points, vanishing: [], guides: [] };
  const f = frameOf(horizon);
  const vanishing = given.map((p, i) => (i < 2 ? at(f, along(f, p), 0) : p));
  if (vanishing.length === 3) vanishing[2] = third(f, vanishing[0], vanishing[1], vanishing[2], size(panel).h);
  const stored = bg.guides ?? [];
  const guides =
    stored.length === guideCount(vanishing.length as Perspective)
      ? stored.map((line, k) => aim(line, vanishing[pointOfGuide(k)]))
      : defaultGuides(panel, horizon, vanishing);
  return { points, horizon, vanishing: vanishing.map(round), guides };
}

function save(panel: Panel, ruler: Ruler): void {
  setBackground(panel, {
    perspective: ruler.points || undefined,
    horizon: ruler.horizon,
    vanishing: ruler.vanishing.length ? ruler.vanishing.map(round) : undefined,
    guides: ruler.guides.length ? ruler.guides : undefined,
  });
}

/** Choose how many points the ruler has: ones missing are laid out (beyond the panel's sides), extra ones taken off; 0 takes the ruler away. */
export function setPerspective(panel: Panel, points: Perspective): void {
  if (!points) {
    setBackground(panel, { perspective: undefined, horizon: undefined, vanishing: undefined, guides: undefined });
    return;
  }
  const { w, h, centre, box } = size(panel);
  const before = rulerOf(panel);
  const horizon = before.horizon ?? level(panel, box[1] + 0.45 * h);
  const f = frameOf(horizon);
  const cs = along(f, centre);
  const vanishing = before.vanishing.slice(0, points);
  if (points >= 1 && vanishing.length < 1) vanishing.push(at(f, points === 1 ? cs : cs - 1.1 * w, 0));
  if (points >= 2 && vanishing.length < 2) {
    const s1 = along(f, vanishing[0]);
    const away = s1 <= cs ? 1 : -1;
    vanishing.push(at(f, cs + away * Math.max(1.1 * w, Math.abs(cs - s1)), 0));
  }
  if (points >= 3 && vanishing.length < 3) {
    const middle = (along(f, vanishing[0]) + along(f, vanishing[1])) / 2;
    const ch = off(f, centre);
    // Looking down when the eye level is above the panel's middle.
    vanishing.push(at(f, middle, ch >= 0 ? ch + 1.6 * h : ch - 1.6 * h));
  }
  const kept = before.guides.slice(0, guideCount(Math.min(before.vanishing.length, points) as Perspective));
  const laid = defaultGuides(panel, horizon, vanishing);
  const guides = laid.map((line, k) => kept[k] ?? line);
  setBackground(panel, { camera: undefined });
  save(panel, settle(panel, { points, horizon, vanishing, guides }));
}

/** The ruler with its third point kept in place and the lines aimed at their points. */
function settle(panel: Panel, ruler: Ruler): Ruler {
  if (!ruler.horizon) return ruler;
  const f = frameOf(ruler.horizon);
  const vanishing = ruler.vanishing.map((p, i) => (i < 2 ? at(f, along(f, p), 0) : p));
  if (vanishing.length === 3) vanishing[2] = third(f, vanishing[0], vanishing[1], vanishing[2], size(panel).h);
  const guides = ruler.guides.map((line, k) => (vanishing[pointOfGuide(k)] ? aim(line, vanishing[pointOfGuide(k)]) : line));
  return { ...ruler, vanishing, guides };
}

/** The eye level drawn anew (`a`–`b`; a click: level across the panel): the points slide along their lines onto it. */
export function drawHorizon(panel: Panel, a: Point, b: Point): void {
  const flat = Math.hypot(b[0] - a[0], b[1] - a[1]) < 2;
  const horizon: Line = flat ? level(panel, a[1]) : [a, b];
  const ruler = rulerOf(panel);
  if (!ruler.vanishing.length) {
    setBackground(panel, { horizon });
    return;
  }
  save(panel, settle(panel, { ...ruler, horizon, vanishing: onLines(panel, ruler, horizon) }));
}

/** The eye level moved across itself by the drag from `from` to `to`: the points slide along their lines. */
export function moveHorizon(panel: Panel, start: Ruler, from: Point, to: Point): void {
  if (!start.horizon) return;
  const f = frameOf(start.horizon);
  const t = off(f, to) - off(f, from);
  const horizon = start.horizon.map(([x, y]) => [x + f.n[0] * t, y + f.n[1] * t]) as Line;
  save(panel, settle(panel, { ...start, horizon, vanishing: onLines(panel, start, horizon) }));
}

/** The points where the X and Y lines meet `horizon` (the third stays). */
function onLines(panel: Panel, ruler: Ruler, horizon: Line): Point[] {
  const far = FAR * Math.max(size(panel).w, size(panel).h);
  return ruler.vanishing.map((p, i) => {
    const line = ruler.guides[i];
    if (i >= 2 || !line) return p;
    // From the line's end nearer the point, on towards it.
    const toward: Line =
      Math.hypot(p[0] - line[0][0], p[1] - line[0][1]) >= Math.hypot(p[0] - line[1][0], p[1] - line[1][1]) ? line : [line[1], line[0]];
    return meet(toward, horizon, far);
  });
}

/** A point dragged to `to`: one on the eye level takes the eye level (and the other point) with it; the lines turn to the points. */
export function moveVanishing(panel: Panel, start: Ruler, index: number, to: Point): void {
  if (!start.horizon || !start.vanishing[index]) return;
  const f = frameOf(start.horizon);
  let { horizon, vanishing } = start;
  vanishing = [...vanishing];
  if (index < 2) {
    const t = off(f, to);
    const shift = (p: Point): Point => [p[0] + f.n[0] * t, p[1] + f.n[1] * t];
    horizon = [shift(horizon![0]), shift(horizon![1])];
    vanishing = vanishing.map((p, i) => (i < 2 ? shift(p) : p));
  }
  vanishing[index] = to;
  save(panel, settle(panel, { ...start, horizon, vanishing }));
}

/** An end of line `k` dragged to `to` (the other end stays): its point moves to where the line now leads. */
export function moveGuide(panel: Panel, start: Ruler, k: number, end: 0 | 1, to: Point): void {
  const line = [...(start.guides[k] ?? [to, to])] as Line;
  line[end] = to;
  setGuide(panel, start, k, line);
}

/** Line `k` drawn anew as `line`: its point moves to where the line leads (the X and Y lines meet the eye level, the Z lines each other). */
export function setGuide(panel: Panel, start: Ruler, k: number, line: Line): void {
  if (!start.horizon || !start.guides[k] || Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]) < 1e-6) return;
  const guides = start.guides.map((one) => [...one] as Line);
  guides[k] = line;
  const far = FAR * Math.max(size(panel).w, size(panel).h);
  const vanishing = [...start.vanishing];
  const index = pointOfGuide(k);
  const old = start.vanishing[index];
  // Towards the side the point was on.
  const toward: Line =
    Math.hypot(old[0] - line[0][0], old[1] - line[0][1]) >= Math.hypot(old[0] - line[1][0], old[1] - line[1][1])
      ? line
      : [line[1], line[0]];
  vanishing[index] = index < 2 ? meet(toward, start.horizon, far) : meet(toward, guides[k === 2 ? 3 : 2], far);
  // The line itself stays as drawn: only the other lines turn to their points.
  const settled = settle(panel, { ...start, vanishing, guides });
  settled.guides[k] = [round(line[0]), round(line[1])];
  if (index === 2 && settled.vanishing[2]) {
    // The third point held between the others: the Z lines turn to where it is kept.
    const other = k === 2 ? 3 : 2;
    settled.guides[other] = aim(settled.guides[other], settled.vanishing[2]);
  }
  save(panel, settled);
}

/** A line drawn for `axis` (X, Y or Z): the ruler gets as many points as the axis needs, then the line (the nearer Z line) is set. */
export function drawGuide(panel: Panel, axis: (typeof GUIDE_AXES)[number], line: Line): void {
  const need: Perspective = axis === "X" ? 1 : axis === "Y" ? 2 : 3;
  if (perspectiveOf(backgroundOf(panel)) < need || rulerOf(panel).vanishing.length < need) setPerspective(panel, need);
  const ruler = rulerOf(panel);
  let k = axis === "X" ? 0 : axis === "Y" ? 1 : 2;
  if (axis === "Z") {
    const mid: Point = [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
    const gap = (g: Line) => Math.hypot((g[0][0] + g[1][0]) / 2 - mid[0], (g[0][1] + g[1][1]) / 2 - mid[1]);
    if (ruler.guides[3] && gap(ruler.guides[3]) < gap(ruler.guides[2])) k = 3;
  }
  // Aimed at the point: the end nearer it last.
  const point = ruler.vanishing[pointOfGuide(k)];
  const ordered: Line =
    point && Math.hypot(point[0] - line[0][0], point[1] - line[0][1]) < Math.hypot(point[0] - line[1][0], point[1] - line[1][1])
      ? [line[1], line[0]]
      : line;
  setGuide(panel, ruler, k, ordered);
}

/** A click with 消失点: the first makes a 1点 ruler, then the points still missing are placed, then the nearest moves there. */
export function placeVanishing(panel: Panel, point: Point): number {
  const ruler = rulerOf(panel);
  if (!ruler.points || !ruler.horizon) {
    const horizon = backgroundOf(panel).horizon ?? level(panel, point[1]);
    setBackground(panel, { perspective: 1, horizon, vanishing: [point], guides: undefined });
    save(panel, rulerOf(panel));
    return 0;
  }
  if (ruler.vanishing.length < ruler.points) {
    const vanishing = [...ruler.vanishing, point];
    const guides = defaultGuides(panel, ruler.horizon, vanishing).map((line, k) => ruler.guides[k] ?? line);
    save(panel, settle(panel, { ...ruler, vanishing, guides }));
    return vanishing.length - 1;
  }
  const index = nearest(ruler.vanishing, point);
  moveVanishing(panel, ruler, index, point);
  return index;
}

function nearest(points: readonly Point[], point: Point): number {
  let best = 0;
  points.forEach((p, i) => {
    if (Math.hypot(p[0] - point[0], p[1] - point[1]) < Math.hypot(points[best][0] - point[0], points[best][1] - point[1])) best = i;
  });
  return best;
}

/** Take point `index` off the ruler (and its lines): one point fewer. */
export function removeVanishing(panel: Panel, index: number): void {
  const ruler = rulerOf(panel);
  const vanishing = ruler.vanishing.filter((_, i) => i !== index);
  const kept = ruler.guides.filter((_, k) => pointOfGuide(k) !== index);
  const points = vanishing.length as Perspective;
  if (!points) {
    setBackground(panel, { perspective: undefined, vanishing: undefined, guides: undefined });
    return;
  }
  const guides = ruler.horizon ? defaultGuides(panel, ruler.horizon, vanishing).map((line, k) => kept[k] ?? line) : [];
  save(panel, settle(panel, { ...ruler, points, vanishing, guides }));
}

// --- what lies under the pointer ------------------------------------------------------------------

export type RulerPart = { kind: "vanishing"; index: number } | { kind: "guide"; index: number; end: 0 | 1 } | { kind: "horizon" };

/** The part of a panel's ruler at `point` (within `near` mm): a point, a line's end, else the eye level. */
export function rulerPartAt(panel: Panel, point: Point, near: number): RulerPart | null {
  const ruler = rulerOf(panel);
  const distance = (p: Point) => Math.hypot(p[0] - point[0], p[1] - point[1]);
  const vanishing = ruler.vanishing.findIndex((p) => distance(p) <= near);
  if (vanishing >= 0) return { kind: "vanishing", index: vanishing };
  for (let k = 0; k < ruler.guides.length; k++) {
    for (const end of [1, 0] as const) if (distance(ruler.guides[k][end]) <= near) return { kind: "guide", index: k, end };
  }
  if (ruler.horizon) {
    const f = frameOf(ruler.horizon);
    const [x0, , x1] = bounds(panel.shape);
    const s = along(f, point);
    const inside = point[0] >= x0 - near && point[0] <= x1 + near;
    if (inside && Math.abs(off(f, point)) <= near && Number.isFinite(s)) return { kind: "horizon" };
  }
  return null;
}

/** The ruler in words for a request: what kind and which point is which. */
export function rulerWords(ruler: Ruler): string | null {
  if (!ruler.vanishing.length) return null;
  const n = ruler.vanishing.length;
  if (n === 1) return "透視: 1点透視（カメラは消失点 1 の方向を正面に向く。奥へ向かう水平の線がそこに集まる）";
  if (n === 2) return "透視: 2点透視（カメラは水平。消失点 1・2 はアイレベルの上、縦の線はまっすぐ）";
  const f = frameOf(ruler.horizon!);
  const down = off(f, ruler.vanishing[2]) > 0;
  return `透視: 3点透視（消失点 1・2 はアイレベルの上、消失点 3 は縦の線が集まる点で${down ? "下＝見下ろし" : "上＝見上げ"}）`;
}

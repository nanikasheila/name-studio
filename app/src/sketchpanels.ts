// なぐり描きのコマ割り: panels laid out by hand, as on paper. A line drawn
// round becomes a panel, a line across panels cuts them, and a scribble over
// the gap between panels joins them. What comes of it is 仮のコマ (draft):
// rough until 整える makes it exact (tidy.ts).
import { addDrawnPanel } from "./koma";
import { convexHull, joinPanels } from "./komaedit";
import { area, bounds, insidePolygon, rectShape, segmentDistance } from "./geometry";
import type { Page, Panel, Point, Project } from "./model";
import { basicBox, segmentTouches, snapCut } from "./pagebox";
import { addPanel, cutPanels, removePanel } from "./panels";
import { assignPanels, orderPanels, sortLines } from "./readingorder";
import { straightenShape } from "./tidy";

/** What a line drawn by hand is taken for. */
export type SketchReading =
  | { kind: "panel"; shape: Point[] }
  | { kind: "cut"; a: Point; b: Point }
  | { kind: "join"; panels: string[] }
  | { kind: "none" };

const length = (points: readonly Point[]) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);

function signedArea(shape: readonly Point[]): number {
  let sum = 0;
  shape.forEach(([x0, y0], i) => {
    const [x1, y1] = shape[(i + 1) % shape.length];
    sum += x0 * y1 - x1 * y0;
  });
  return sum / 2;
}

/** Douglas–Peucker on an open run: the points that keep its shape within `tolerance`. */
function simplifyRun(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 3) return [...points];
  const [a, b] = [points[0], points[points.length - 1]];
  let far = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const distance = segmentDistance(points[i], a, b);
    if (distance > far) [far, index] = [distance, i];
  }
  if (far <= tolerance) return [a, b];
  return [...simplifyRun(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplifyRun(points.slice(index), tolerance)];
}

/** How sharply the outline turns at corner `i` (degrees; 0 is straight on). */
function turnAt(shape: readonly Point[], i: number): number {
  const n = shape.length;
  const [p, q, r] = [shape[(i - 1 + n) % n], shape[i], shape[(i + 1) % n]];
  const a = Math.atan2(q[1] - p[1], q[0] - p[0]);
  const b = Math.atan2(r[1] - q[1], r[0] - q[0]);
  return Math.abs(((((b - a) * 180) / Math.PI + 540) % 360) - 180);
}

/**
 * The corners of an outline drawn round by hand: wobbles smoothed away,
 * rounded corners made sharp, almost level or upright edges made so. Wound
 * as rectShape is (clockwise on the page).
 */
export function fitOutline(points: readonly Point[]): Point[] {
  const [x0, y0, x1, y1] = bounds(points);
  const size = Math.hypot(x1 - x0, y1 - y0);
  // Split at the point furthest from the start, so that both runs are open.
  let far = 0;
  let index = 0;
  points.forEach((p, i) => {
    const distance = Math.hypot(p[0] - points[0][0], p[1] - points[0][1]);
    if (distance > far) [far, index] = [distance, i];
  });
  const tolerance = Math.max(1.2, size * 0.04);
  let shape = [...simplifyRun(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplifyRun([...points.slice(index), points[0]], tolerance).slice(0, -1)];
  // Corners that barely turn or cut off only a sliver (a rounded corner) go.
  for (let removed = true; removed && shape.length > 3; ) {
    removed = false;
    const whole = Math.abs(signedArea(shape));
    let weakest = -1;
    let least = Infinity;
    shape.forEach((_, i) => {
      const n = shape.length;
      const sliver = Math.abs(signedArea([shape[(i - 1 + n) % n], shape[i], shape[(i + 1) % n]]));
      const weight = turnAt(shape, i) < 20 ? 0 : sliver;
      if (weight < least) [least, weakest] = [weight, i];
    });
    if (weakest >= 0 && (least === 0 || least < whole * 0.025)) {
      shape = shape.filter((_, i) => i !== weakest);
      removed = true;
    }
  }
  if (signedArea(shape) < 0) shape.reverse();
  return straightenShape(shape);
}

/** How many times a line turns back along its longer side (a scribble turns back again and again). */
function turnsBack(points: readonly Point[]): number {
  const [x0, y0, x1, y1] = bounds(points);
  const axis = x1 - x0 >= y1 - y0 ? 0 : 1;
  let turns = 0;
  let heading = 0;
  let anchor = points[0][axis];
  for (const point of points) {
    const moved = point[axis] - anchor;
    if (Math.abs(moved) < 1.5) continue;
    const now = Math.sign(moved);
    if (heading && now !== heading) turns++;
    heading = now;
    anchor = point[axis];
  }
  return turns;
}

/** Panels a line goes through (two of its points or more inside), the ones on top for insets. */
function panelsUnder(page: Page, points: readonly Point[]): Panel[] {
  const counts = new Map<Panel, number>();
  for (const point of points) {
    let owner: Panel | undefined;
    for (const panel of page.panels) {
      if (insidePolygon(panel.shape, point) && (!owner || (panel.z ?? 0) > (owner.z ?? 0))) owner = panel;
    }
    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count >= 2).map(([panel]) => panel);
}

/** What a line drawn with コマ割り's 描く is taken for, on `page` (points in mm). */
export function readSketch(page: Page, drawn: readonly Point[]): SketchReading {
  const points = drawn.filter((p, i) => i === 0 || Math.hypot(p[0] - drawn[i - 1][0], p[1] - drawn[i - 1][1]) > 0.3);
  if (points.length < 2) return { kind: "none" };
  const [x0, y0, x1, y1] = bounds(points);
  const size = Math.hypot(x1 - x0, y1 - y0);
  if (size < 4) return { kind: "none" };
  const run = length(points);
  const [a, b] = [points[0], points[points.length - 1]];
  const gap = Math.hypot(b[0] - a[0], b[1] - a[1]);
  // ぐしゃぐしゃ over the gap between panels: join them.
  const enclosed = Math.abs(signedArea(points)) / Math.max((x1 - x0) * (y1 - y0), 1e-6);
  const scribble = (run > 4 * size && size < 45) || (run > 3 * size && turnsBack(points) >= 3 && enclosed < 0.3);
  if (scribble) {
    const under = panelsUnder(page, points);
    if (under.length >= 2) return { kind: "join", panels: under.map((panel) => panel.id) };
  }
  // Drawn round (the ends meet): a panel.
  if (gap <= Math.max(6, size * 0.3) && run >= 1.8 * size) {
    const shape = fitOutline(points);
    return shape.length >= 3 && area(shape) >= 25 ? { kind: "panel", shape } : { kind: "none" };
  }
  // Drawn across: a cut, straight from end to end.
  const bend = Math.max(...points.map((p) => segmentDistance(p, a, b)));
  if (bend <= Math.max(3, gap * 0.12)) return { kind: "cut", a, b: snapCut(a, b) };
  // Drawn most of the way round: a panel all the same.
  if (gap <= size * 0.6) {
    const shape = fitOutline(points);
    return shape.length >= 3 && area(shape) >= 25 ? { kind: "panel", shape } : { kind: "none" };
  }
  return { kind: "none" };
}

/** What drawing a line did, to say. */
export interface SketchDone {
  changed: boolean;
  message: string;
  /** The panel made, to select. */
  panelId?: string;
}

/**
 * Do what a hand-drawn line is taken for (readSketch) on `page`. The panels
 * made, cut or joined are 仮のコマ. On a page with no panels yet, a line
 * across cuts the 基本枠 as one panel.
 */
export function applySketch(project: Project, page: Page, drawn: readonly Point[]): SketchDone {
  const reading = readSketch(page, drawn);
  switch (reading.kind) {
    case "panel": {
      const panel = addDrawnPanel(project, page, reading.shape);
      if (!panel) return { changed: false, message: "コマにするには、もう少し大きく囲んでください" };
      panel.draft = true;
      return {
        changed: true,
        panelId: panel.id,
        message: panel.z ? `仮のコマ ${panel.order} を足しました（中に描いたので、はめ込み）` : `仮のコマ ${panel.order} を足しました。決まったら「整える」で清書できます`,
      };
    }
    case "cut": {
      const { a, b } = reading;
      const fresh = !page.panels.length;
      if (fresh) addPanel(project, page, rectShape(basicBox(project.pageFormat))).draft = true;
      const touched = new Set(page.panels.filter((panel) => segmentTouches(panel.shape, a, b)).map((panel) => panel.id));
      const created = cutPanels(project, page, a, b);
      if (!created.length) {
        if (fresh) page.panels = [];
        return { changed: false, message: "割るには、コマを横切るように描いてください" };
      }
      for (const panel of page.panels) if (touched.has(panel.id) || created.includes(panel.id)) panel.draft = true;
      sortLines(page, project.binding);
      return { changed: true, message: `${fresh ? "基本枠を" : "コマを"} ${created.length} か所で仮に割りました` };
    }
    case "join": {
      const panels = reading.panels.map((id) => page.panels.find((panel) => panel.id === id)!).sort((p, q) => p.order - q.order);
      const [first, ...rest] = panels;
      let joined = 0;
      for (const other of rest) {
        if (joinPanels(page, first, other, project.binding) || forceJoin(project, page, first, other)) joined++;
      }
      if (!joined) return { changed: false, message: "形がそろっていないか見開きのコマなので、つなげられません" };
      first.draft = true;
      orderPanels(page, project.binding);
      assignPanels(page);
      sortLines(page, project.binding);
      return { changed: true, panelId: first.id, message: `${joined + 1} つのコマを仮につなげました` };
    }
    case "none":
      return { changed: false, message: "囲むとコマ、横切るとコマを割る線、コマの間のぐしゃぐしゃでつなげる、として読みます" };
  }
}

/**
 * つなげる panels that do not line up (drawn by hand): the outline round
 * both, as long as it covers little more than the two and the gap between.
 */
function forceJoin(project: Project, page: Page, a: Panel, b: Panel): boolean {
  if (a.spread || b.spread || !(a.draft || b.draft)) return false;
  const [ax0, ay0, ax1, ay1] = bounds(a.shape);
  const [bx0, by0, bx1, by1] = bounds(b.shape);
  const apart = Math.max(bx0 - ax1, ax0 - bx1, by0 - ay1, ay0 - by1);
  if (apart > 10) return false;
  let hull = convexHull([...a.shape, ...b.shape]);
  if (area(hull) > (area(a.shape) + area(b.shape)) * 1.35) return false;
  if (signedArea(hull) < 0) hull = hull.reverse();
  a.shape = straightenShape(hull);
  delete a.openEdges;
  if (!a.note && b.note) a.note = b.note;
  else if (a.note && b.note) a.note = `${a.note} / ${b.note}`;
  removePanel(page, b.id, project.binding);
  return true;
}

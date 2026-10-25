// コマ割りの語彙: panel borders and open edges (裁ち切り), insets (はめ込み),
// tilted panels, breakouts (はみ出し), background effects, and page layout
// patterns taken from the manuscripts. Everything here works in page mm.
import { arrangePanel } from "./arrange";
import { seeded } from "./balloon";
import { inheritOpenEdges } from "./geometry";
import { panelLineMm } from "./style";
import { onLeftHand, spreads } from "./pages";
import {
  gutters,
  area,
  insidePolygon,
  assignPanels,
  basicBox,
  bounds,
  carryContents,
  centroid,
  clipHalfPlane,
  followPanel,
  moveLine,
  moveStroke,
  newId,
  orderPanels,
  pageIndex,
  panelContents,
  rectShape,
  sortLines,
  trimBox,
  type BoxMm,
  type Breakout,
  type Page,
  type PageFormat,
  type Panel,
  type PanelBorder,
  type PanelEffect,
  type PanelFill,
  type Point,
  type Project,
} from "./project";

export const BORDER_LABELS: Record<PanelBorder, string> = {
  solid: "実線",
  thick: "太枠",
  none: "枠なし",
  dashed: "破線（回想・空想）",
  wavy: "波線（夢・ゆらぎ）",
};

export const FILL_LABELS: Record<PanelFill, string> = {
  none: "なし",
  white: "白（下のコマを隠す）",
  black: "ベタ（回想・暗転）",
  gray: "グレー（トーン）",
};

export const EFFECT_LABELS: Record<PanelEffect, string> = {
  none: "なし",
  speed: "流線（動き）",
  focus: "集中線（驚き・注目）",
  flash: "ウニフラ（衝撃・動揺）",
  sparkle: "キラキラ（好意・華やぎ）",
};

export type Side = "top" | "bottom" | "left" | "right";

export const SIDE_LABELS: Record<Side, string> = { top: "上", bottom: "下", left: "左", right: "右" };

const ON_EDGE = 0.05;

/** Whether a page point lies on that side of the canvas edge. */
export function onCanvasSide([x, y]: Point, side: Side, format: PageFormat): boolean {
  const [w, h] = format.canvasMm;
  switch (side) {
    case "top":
      return y <= ON_EDGE;
    case "bottom":
      return y >= h - ON_EDGE;
    case "left":
      return x <= ON_EDGE;
    case "right":
      return x >= w - ON_EDGE;
  }
}

/** Whether the panel runs off the page on that side (裁ち切り). */
export function isBled(panel: Panel, side: Side, format: PageFormat): boolean {
  return panel.shape.some((point) => onCanvasSide(point, side, format));
}

/**
 * 裁ち切り on or off for one side: the panel's corners on that side move out
 * to the canvas edge (past the trim) and the edge there is left open, or back
 * to the basic frame.
 */
export function bleedPanel(panel: Panel, side: Side, format: PageFormat, on: boolean): void {
  const [w, h] = format.canvasMm;
  const basic = basicBox(format);
  const [x0, y0, x1, y1] = bounds(panel.shape);
  const vertical = side === "top" || side === "bottom";
  const extreme = { top: y0, bottom: y1, left: x0, right: x1 }[side];
  const target = on ? { top: 0, bottom: h, left: 0, right: w }[side] : { top: basic[1], bottom: basic[3], left: basic[0], right: basic[2] }[side];
  // Corners within a millimetre of the panel's edge on that side move together.
  const tolerance = 1;
  const before = edgesAlong(panel.shape, side, format);
  panel.shape = panel.shape.map((point) => {
    const value = vertical ? point[1] : point[0];
    if (Math.abs(value - extreme) > tolerance) return point;
    return vertical ? [point[0], target] : [target, point[1]];
  });
  const open = new Set(panel.openEdges ?? []);
  if (on) for (const i of edgesAlong(panel.shape, side, format)) open.add(i);
  else for (const i of before) open.delete(i);
  if (open.size) panel.openEdges = [...open].sort((x, y) => x - y);
  else delete panel.openEdges;
}

/** Edges lying on that side of the canvas edge. */
function edgesAlong(shape: readonly Point[], side: Side, format: PageFormat): number[] {
  const result: number[] = [];
  for (let i = 0; i < shape.length; i++) {
    if (onCanvasSide(shape[i], side, format) && onCanvasSide(shape[(i + 1) % shape.length], side, format)) result.push(i);
  }
  return result;
}

/**
 * The border as drawn: runs of edges that are not open, each a polyline.
 * A border with no open edge is one closed run.
 */
export function borderRuns(panel: Panel): { points: Point[]; closed: boolean }[] {
  const n = panel.shape.length;
  const open = new Set(panel.openEdges ?? []);
  if (!open.size) return [{ points: [...panel.shape], closed: true }];
  if (open.size >= n) return [];
  const runs: { points: Point[]; closed: boolean }[] = [];
  // Start right after an open edge so that no run is split across the start.
  const first = [...open][0];
  let run: Point[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (first + k) % n;
    if (open.has(i)) {
      if (run.length) runs.push({ points: [...run, panel.shape[i]], closed: false });
      run = [];
    } else {
      run.push(panel.shape[i]);
    }
  }
  return runs;
}

/** A polyline made wavy (波線), amplitude and wavelength in mm. */
export function wavy(points: readonly Point[], closed: boolean, amplitude = 0.7, wavelength = 5): Point[] {
  const out: Point[] = [];
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(2, Math.round((length / wavelength) * 8));
    const nx = -(b[1] - a[1]) / (length || 1);
    const ny = (b[0] - a[0]) / (length || 1);
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      // Waves fade out at the corners so they meet cleanly.
      const offset = amplitude * Math.sin((t * length * Math.PI * 2) / wavelength) * Math.min(1, t * 6, (1 - t) * 6);
      out.push([a[0] + (b[0] - a[0]) * t + nx * offset, a[1] + (b[1] - a[1]) * t + ny * offset]);
    }
  }
  if (!closed) out.push(points[points.length - 1]);
  return out;
}

/** Turn the panel around its centre (傾いたコマ). */
export function rotatePanel(panel: Panel, degrees: number): void {
  const [cx, cy] = centroid(panel.shape);
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  panel.shape = panel.shape.map(([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]);
}

/**
 * はめ込み: a small panel laid over a corner of `parent`, reaching a little
 * past its border, white so that it hides what is under it.
 */
export function addInset(project: Project, page: Page, parent: Panel): Panel {
  const [x0, y0, x1, y1] = bounds(parent.shape);
  const w = Math.max((x1 - x0) * 0.36, 20);
  const h = Math.max((y1 - y0) * 0.36, 20);
  const out = 3;
  // The bottom corner read last: the left one in a right-bound book, the right one in a left-bound book.
  const shape =
    project.binding === "right" ? rectShape([x0 - out, y1 - h + out, x0 - out + w, y1 + out]) : rectShape([x1 + out - w, y1 - h + out, x1 + out, y1 + out]);
  const panel: Panel = { id: newId(project, "panel"), shape, order: 0, fill: "white", z: (parent.z ?? 0) + 1 };
  page.panels.push(panel);
  orderPanels(page, project.binding);
  assignPanels(page);
  return panel;
}

/**
 * A panel drawn freely (a rectangle or any outline, 台形 and the like).
 * Drawn inside another panel, it is an inset over it (はめ込み: white, on
 * top); elsewhere a panel of its own. The outline goes the way a
 * rectangle's does, a corner list without repeats or slivers.
 */
export function addDrawnPanel(project: Project, page: Page, outline: readonly Point[]): Panel | null {
  const shape: Point[] = [];
  for (const point of outline) {
    const last = shape[shape.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 0.05) shape.push([point[0], point[1]]);
  }
  while (shape.length > 1 && Math.hypot(shape[0][0] - shape[shape.length - 1][0], shape[0][1] - shape[shape.length - 1][1]) <= 0.05) shape.pop();
  if (shape.length < 3 || area(shape) < 4) return null;
  // Clockwise on the page (y down), as rectShape.
  let signed = 0;
  shape.forEach(([x0, y0], i) => {
    const [x1, y1] = shape[(i + 1) % shape.length];
    signed += x0 * y1 - x1 * y0;
  });
  if (signed < 0) shape.reverse();
  const middle = centroid(shape);
  const parent = stacked(page.panels)
    .reverse()
    .find((panel) => insidePolygon(panel.shape, middle) && area(panel.shape) > area(shape));
  const panel: Panel = { id: newId(project, "panel"), shape, order: 0 };
  if (parent) {
    panel.fill = "white";
    panel.z = (parent.z ?? 0) + 1;
  }
  page.panels.push(panel);
  orderPanels(page, project.binding);
  assignPanels(page);
  return panel;
}

export function addBreakout(project: Project, page: Page, shape: Point[]): Breakout {
  const breakout: Breakout = { id: newId(project, "breakout"), shape };
  page.breakouts.push(breakout);
  return breakout;
}

export function moveBreakout(breakout: Breakout, dx: number, dy: number): void {
  breakout.shape = breakout.shape.map(([x, y]) => [x + dx, y + dy]);
}

// --- 見開き: one panel across the gutter ----------------------------------------

/** The page facing `page` in its spread and the side of `page` at the gutter. */
export function facingPage(project: Project, page: Page, firstAlone: boolean): { page: Page; gutter: Side } | null {
  const number = pageIndex(project, page.id) + 1;
  // 縦スクロール: the pieces of the strip never face each other.
  if (project.scroll) return null;
  const pair = spreads(project.pages.length, firstAlone).find((p) => p.includes(number));
  if (!pair || pair[0] === null || pair[1] === null) return null;
  const left = onLeftHand(pair, number, project.binding);
  const other = pair[0] === number ? pair[1] : pair[0];
  return { page: project.pages[other - 1], gutter: left ? "right" : "left" };
}

/** The two facing pages `page` is on, in page order, or null when it faces none. */
export function spreadPair(project: Project, page: Page, firstAlone: boolean): [Page, Page] | null {
  const facing = facingPage(project, page, firstAlone);
  if (!facing) return null;
  return pageIndex(project, page.id) < pageIndex(project, facing.page.id) ? [page, facing.page] : [facing.page, page];
}

/** 見開きページ: whether `page` and its facing page go to CSP as one spread page. */
export function setSpreadPage(project: Project, page: Page, firstAlone: boolean, joined: boolean): void {
  const pair = spreadPair(project, page, firstAlone);
  if (!pair) return;
  if (joined) pair[0].joinNext = true;
  else delete pair[0].joinNext;
}

/** The other half of a 見開き panel, on the facing page. */
export function spreadTwin(project: Project, page: Page, panel: Panel): { page: Page; panel: Panel } | null {
  if (!panel.spread) return null;
  for (const other of project.pages) {
    if (other.id === page.id) continue;
    const twin = other.panels.find((p) => p.spread === panel.spread);
    if (twin) return { page: other, panel: twin };
  }
  return null;
}

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

/**
 * 見開き: run the panel across the gutter. Its gutter side bleeds to the
 * canvas edge and stays open, and the facing page gets the mirrored other
 * half with the same style. Both halves share `spread`.
 */
export function spreadPanel(project: Project, page: Page, panel: Panel, firstAlone: boolean): Panel | null {
  const facing = facingPage(project, page, firstAlone);
  if (!facing || panel.spread) return null;
  const format = project.pageFormat;
  bleedPanel(panel, facing.gutter, format, true);
  const [w] = format.canvasMm;
  // Mirrored across the gutter; reversed so the outline keeps its winding.
  const shape: Point[] = panel.shape.map(([x, y]): Point => [w - x, y]).reverse();
  const sides = (["top", "bottom", "left", "right"] as Side[]).filter((side) => isBled(panel, side, format)).map((side) => (side === "top" || side === "bottom" ? side : OPPOSITE[side]));
  const open = [...new Set(sides.flatMap((side) => edgesAlong(shape, side, format)))].sort((a, b) => a - b);
  panel.spread = newId(project, "spread");
  const { id: _id, shape: _shape, order: _order, openEdges: _open, ...style } = panel;
  const twin: Panel = { ...style, id: newId(project, "panel"), shape, order: 0, ...(open.length ? { openEdges: open } : {}) };
  facing.page.panels.push(twin);
  orderPanels(facing.page, project.binding);
  assignPanels(facing.page);
  // A panel across the gutter needs the two pages to be one CSP page.
  setSpreadPage(project, page, firstAlone, true);
  return twin;
}

/**
 * ページをまたぐコマ: a panel drawn on past the gutter onto the facing page
 * becomes a 見開き panel. The part over each page is its half there, cut
 * at the gutter and run on to the canvas edge (open), as 見開きにする
 * leaves it; what the panel holds past the gutter goes with its half.
 * Returns the new half, or null when the panel does not reach over (one
 * bled to the canvas edge at the gutter, 裁ち切り, stays as it is).
 */
export function spanGutter(project: Project, page: Page, panel: Panel, firstAlone: boolean): Panel | null {
  if (panel.spread) return null;
  const facing = facingPage(project, page, firstAlone);
  if (!facing) return null;
  const format = project.pageFormat;
  const [w] = format.canvasMm;
  const [trimX0, , trimX1] = trimBox(format);
  // This page's gutter, the facing page's and the canvas edges behind them.
  const onLeft = facing.gutter === "left";
  const gutter = onLeft ? trimX0 : trimX1;
  const facingGutter = onLeft ? trimX1 : trimX0;
  const [edge, facingEdge] = onLeft ? [0, w] : [w, 0];
  const past = (x: number) => (onLeft ? gutter - x : x - gutter);
  const reach = Math.max(...panel.shape.map(([x]) => past(x)));
  const beyondCanvas = Math.max(...panel.shape.map(([x]) => past(x) - past(edge))) > ON_EDGE;
  if (reach <= 1 || (isBled(panel, facing.gutter, format) && !beyondCanvas)) return null;
  const own = clipHalfPlane(panel.shape, ([x]) => -past(x));
  const over = clipHalfPlane(panel.shape, ([x]) => past(x));
  if (own.length < 3 || over.length < 3 || area(own) < 4 || area(over) < 4) return null;
  // Open edges carry over before the cut runs on to the edge (the corners keep their numbers).
  const ownOpen = inheritOpenEdges(panel.shape, panel.openEdges, own);
  const overOpen = inheritOpenEdges(panel.shape, panel.openEdges, over);
  const shift = facingGutter - gutter;
  const atCut = (x: number) => Math.abs(x - gutter) < 1e-6;
  const ownShape = own.map(([x, y]): Point => [atCut(x) ? edge : x, y]);
  // No further than the facing page's canvas.
  const twinShape = over.map(([x, y]): Point => [atCut(x) ? facingEdge : Math.min(Math.max(x + shift, 0), w), y]);
  const opened = (shape: Point[], open: number[], side: Side) => [...new Set([...open, ...edgesAlong(shape, side, format)])].sort((a, b) => a - b);
  const ownEdges = opened(ownShape, ownOpen, facing.gutter);
  const twinEdges = opened(twinShape, overOpen, OPPOSITE[facing.gutter]);
  // What the panel holds past the gutter is on the facing page now.
  const held = panelContents(page, panel);
  const centreOver = (box: BoxMm) => past((box[0] + box[2]) / 2) > 0;
  const lines = page.lines.filter((line) => held.lines.includes(line.id) && centreOver(line.box));
  const strokes = page.strokes.filter((stroke) => held.strokes.includes(stroke.id) && centreOver(bounds(stroke.points.map(([x, y]): Point => [x, y]))));
  panel.shape = ownShape;
  if (ownEdges.length) panel.openEdges = ownEdges;
  else delete panel.openEdges;
  panel.spread = newId(project, "spread");
  const { id: _id, shape: _shape, order: _order, openEdges: _open, note: _note, noteAt: _noteAt, ...style } = panel;
  const twin: Panel = { ...style, id: newId(project, "panel"), shape: twinShape, order: 0, ...(twinEdges.length ? { openEdges: twinEdges } : {}) };
  facing.page.panels.push(twin);
  page.lines = page.lines.filter((line) => !lines.includes(line));
  page.strokes = page.strokes.filter((stroke) => !strokes.includes(stroke));
  for (const line of lines) {
    moveLine(line, shift, 0);
    delete line.linkTo;
    facing.page.lines.push(line);
  }
  for (const stroke of strokes) {
    moveStroke(stroke, shift, 0);
    facing.page.strokes.push(stroke);
  }
  for (const p of [page, facing.page]) {
    orderPanels(p, project.binding);
    assignPanels(p);
    sortLines(p, project.binding);
  }
  // A panel across the gutter needs the two pages to be one CSP page.
  setSpreadPage(project, page, firstAlone, true);
  return twin;
}

/** Back to one page: the other half goes and the gutter side returns to the basic frame. */
export function unspreadPanel(project: Project, page: Page, panel: Panel, firstAlone: boolean): void {
  const twin = spreadTwin(project, page, panel);
  if (twin) {
    twin.page.panels = twin.page.panels.filter((p) => p !== twin.panel);
    orderPanels(twin.page, project.binding);
    assignPanels(twin.page);
  }
  delete panel.spread;
  const facing = facingPage(project, page, firstAlone);
  if (facing) bleedPanel(panel, facing.gutter, project.pageFormat, false);
}

/** Panels bottom first, as they stack. */
export function stacked(panels: readonly Panel[]): Panel[] {
  return [...panels].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
}

// --- background effects ---------------------------------------------------------

/** Lines (and small stars) of a background effect, in mm, to be clipped to the panel. */
export function effectStrokes(panel: Panel, effect: PanelEffect): { lines: [Point, Point][]; stars: Point[][] } {
  const lines: [Point, Point][] = [];
  const stars: Point[][] = [];
  if (effect === "none") return { lines, stars };
  const random = seeded(panel.id + effect);
  const [x0, y0, x1, y1] = bounds(panel.shape);
  const [cx, cy] = centroid(panel.shape);
  const reach = Math.hypot(x1 - x0, y1 - y0);
  switch (effect) {
    case "speed":
      for (let y = y0 + 1.5; y < y1; y += 1.8 + random() * 1.6) {
        const start = x0 + random() * (x1 - x0) * 0.5;
        lines.push([
          [start, y],
          [start + (x1 - x0) * (0.35 + random() * 0.5), y],
        ]);
      }
      break;
    case "focus": {
      const count = Math.round(reach * 0.9);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + random() * 0.03;
        const inner = reach * (0.2 + random() * 0.12);
        lines.push([
          [cx + Math.cos(a) * reach, cy + Math.sin(a) * reach],
          [cx + Math.cos(a) * inner, cy + Math.sin(a) * inner],
        ]);
      }
      break;
    }
    case "flash": {
      const count = Math.round(reach * 1.2);
      const ring = Math.min(x1 - x0, y1 - y0) * 0.42;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const inner = ring * (0.75 + random() * 0.15);
        const outer = ring * (1.05 + random() * 0.45);
        lines.push([
          [cx + Math.cos(a) * inner, cy + Math.sin(a) * inner],
          [cx + Math.cos(a) * outer, cy + Math.sin(a) * outer],
        ]);
      }
      break;
    }
    case "sparkle": {
      const count = 4 + Math.round(random() * 4);
      for (let i = 0; i < count; i++) {
        const sx = x0 + random() * (x1 - x0);
        const sy = y0 + random() * (y1 - y0);
        const r = 2 + random() * 3;
        const star: Point[] = [];
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2 - Math.PI / 2;
          const rr = k % 2 ? r * 0.25 : r;
          star.push([sx + Math.cos(a) * rr, sy + Math.sin(a) * rr]);
        }
        stars.push(star);
      }
      break;
    }
  }
  return { lines, stars };
}

// --- layout patterns ------------------------------------------------------------

/** One row of a layout pattern; weights are relative sizes. */
interface Row {
  weight: number;
  cells: number[];
  /** Vertical gutters lean: the top is this many mm right of the bottom. */
  lean?: number;
  /** The gutter under this row tilts: its left end is this many mm lower. */
  tilt?: number;
  /** Cells (by index from the right) filled black. */
  black?: number[];
}

export interface Pattern {
  id: string;
  label: string;
  note: string;
  rows: Row[];
  /** Sides of the page the first / last row bleed to. */
  bleed?: { first?: Side[]; last?: Side[]; all?: Side[] };
  /** Add an inset over the bottom left corner of this row's first cell. */
  inset?: number;
}

/**
 * Page patterns seen in ユメノストラ 1–3 (and common in manga generally).
 * Rows run top to bottom; cells right to left (right-bound books; a
 * left-bound book gets them mirrored).
 */
export const PATTERNS: Pattern[] = [
  {
    id: "basic4",
    label: "基本の4段",
    note: "横長と2分割を交互に。会話の続くページの土台。",
    rows: [
      { weight: 1, cells: [1, 1.3] },
      { weight: 1, cells: [1] },
      { weight: 1, cells: [1.4, 1] },
      { weight: 1, cells: [1] },
    ],
  },
  {
    id: "three",
    label: "3段（2・1・2）",
    note: "中段を見せ場に。",
    rows: [
      { weight: 1, cells: [1, 1] },
      { weight: 1.3, cells: [1] },
      { weight: 1, cells: [1, 1.2] },
    ],
  },
  {
    id: "opening",
    label: "導入（上を裁ち切り）",
    note: "場面の始まりに、上いっぱいの風景で場所を見せる。",
    rows: [
      { weight: 1.1, cells: [1] },
      { weight: 1, cells: [1, 1.4] },
      { weight: 1, cells: [1] },
      { weight: 1, cells: [1.3, 1] },
    ],
    bleed: { first: ["top", "left", "right"] },
  },
  {
    id: "bigInset",
    label: "大ゴマ＋はめ込み",
    note: "決めの大ゴマに、反応の小ゴマを重ねる。",
    rows: [
      { weight: 1, cells: [1, 1] },
      { weight: 2.4, cells: [1] },
    ],
    bleed: { last: ["bottom", "left"] },
    inset: 1,
  },
  {
    id: "action",
    label: "斜めの間白（アクション）",
    note: "傾いた間白で勢いを出す。動きの向きに傾ける。",
    rows: [
      { weight: 1, cells: [1, 1.2], lean: 10, tilt: 8 },
      { weight: 1.5, cells: [1], tilt: -10 },
      { weight: 1, cells: [1, 1, 1], lean: -8 },
    ],
  },
  {
    id: "sequence",
    label: "縦長の連続（動きのコマ送り）",
    note: "細長いコマを3つ並べて一連の動きを見せる。",
    rows: [
      { weight: 1.5, cells: [1, 1, 1], lean: 6 },
      { weight: 1, cells: [1] },
      { weight: 1, cells: [1, 1] },
    ],
  },
  {
    id: "pause",
    label: "間（細い空コマ）",
    note: "細いコマを挟んで沈黙や時間の経過を置く。",
    rows: [
      { weight: 1, cells: [1, 1] },
      { weight: 0.16, cells: [1] },
      { weight: 1.2, cells: [1] },
      { weight: 1, cells: [1, 1.3] },
    ],
  },
  {
    id: "flashback",
    label: "回想の帯（ベタと交互）",
    note: "傾いた横長の帯を重ね、ベタの帯に言葉だけを置く。",
    rows: [
      { weight: 1, cells: [1], tilt: -4, black: [0] },
      { weight: 0.6, cells: [1], tilt: 4 },
      { weight: 1, cells: [1], tilt: -4, black: [0] },
      { weight: 0.6, cells: [1], tilt: 4 },
      { weight: 1, cells: [1], black: [0] },
    ],
  },
  {
    id: "splash",
    label: "1ページ大ゴマ（全面裁ち切り）",
    note: "扉や山場の一枚絵。",
    rows: [{ weight: 1, cells: [1] }],
    bleed: { all: ["top", "bottom", "left", "right"] },
  },
];

/** How many panels a pattern makes (with its inset). */
export function patternCount(patternId: string): number {
  const pattern = PATTERNS.find((p) => p.id === patternId);
  return pattern ? pattern.rows.reduce((sum, row) => sum + row.cells.length, 0) + (pattern.inset !== undefined ? 1 : 0) : 0;
}

/** Rows thin enough to be a pause: never split nor joined. */
const PAUSE_WEIGHT = 0.3;
const MOST_ACROSS = 3;

/**
 * The pattern made to have `count` panels, keeping its look: fewer by joining
 * the cells of the busiest row (then dropping the inset, then joining rows),
 * more by splitting the tallest row with the fewest cells (up to three across,
 * then a new row at the bottom).
 */
export function fitPattern(pattern: Pattern, count: number): Pattern {
  const rows: Row[] = pattern.rows.map((row) => ({ ...row, cells: [...row.cells], ...(row.black ? { black: [...row.black] } : {}) }));
  let inset = pattern.inset;
  const total = () => rows.reduce((sum, row) => sum + row.cells.length, 0) + (inset !== undefined ? 1 : 0);
  const want = Math.max(1, Math.round(count));
  while (total() > want) {
    const busy = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.cells.length > 1)
      .sort((a, b) => b.row.cells.length - a.row.cells.length || b.index - a.index)[0];
    if (busy) {
      // The last two cells (the left end) become one.
      const cells = busy.row.cells;
      cells.splice(cells.length - 2, 2, cells[cells.length - 2] + cells[cells.length - 1]);
      busy.row.black = busy.row.black?.filter((c) => c < cells.length);
      continue;
    }
    if (inset !== undefined) {
      inset = undefined;
      continue;
    }
    if (rows.length < 2) break;
    // Join the thinnest row into the one above (or below, for the first).
    const thin = rows.reduce((best, row, index) => (row.weight < rows[best].weight ? index : best), rows.length - 1);
    const into = thin > 0 ? thin - 1 : 1;
    rows[into].weight += rows[thin].weight;
    rows.splice(thin, 1);
  }
  while (total() < want) {
    const open = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => row.weight >= PAUSE_WEIGHT && row.cells.length < MOST_ACROSS && index !== inset && !row.black?.length);
    open.sort((a, b) => a.row.cells.length - b.row.cells.length || b.row.weight - a.row.weight || a.index - b.index);
    if (open.length) {
      open[0].row.cells.push(1);
      continue;
    }
    rows.push({ weight: 1, cells: want - total() > 1 ? [1, 1] : [1] });
  }
  return { ...pattern, rows, inset };
}

/**
 * Panels of a pattern on the page's basic frame (not yet added to the page).
 * With `count`, made to have that many panels ({@link fitPattern}).
 */
export function patternPanels(project: Project, patternId: string, gaps = gutters(project), count?: number): Panel[] {
  const found = PATTERNS.find((p) => p.id === patternId);
  if (!found) return [];
  const pattern = count && count !== patternCount(patternId) ? fitPattern(found, count) : found;
  const format = project.pageFormat;
  const [bx0, by0, bx1, by1] = basicBox(format);
  const total = pattern.rows.reduce((sum, row) => sum + row.weight, 0);
  const height = by1 - by0 - gaps.down * (pattern.rows.length - 1);
  // Gutter lines between rows: y at the left and right ends of the frame.
  const cuts: { left: number; right: number }[] = [];
  let y = by0;
  pattern.rows.forEach((row, index) => {
    y += (height * row.weight) / total;
    if (index < pattern.rows.length - 1) {
      const tilt = row.tilt ?? 0;
      cuts.push({ left: y + tilt / 2, right: y - tilt / 2 });
      y += gaps.down;
    }
  });
  const lineY = (line: { left: number; right: number }, x: number) => line.left + ((line.right - line.left) * (x - bx0)) / (bx1 - bx0);
  const panels: Panel[] = [];
  pattern.rows.forEach((row, r) => {
    const top = r === 0 ? { left: by0, right: by0 } : { left: cuts[r - 1].left + gaps.down, right: cuts[r - 1].right + gaps.down };
    const bottom = r === pattern.rows.length - 1 ? { left: by1, right: by1 } : cuts[r];
    const sum = row.cells.reduce((s, c) => s + c, 0);
    const width = bx1 - bx0 - gaps.across * (row.cells.length - 1);
    // Cells from the right edge leftwards.
    let right = bx1;
    row.cells.forEach((weight, c) => {
      const left = c === row.cells.length - 1 ? bx0 : right - (width * weight) / sum;
      const lean = row.lean ?? 0;
      const leanRight = c === 0 ? 0 : lean / 2;
      const leanLeft = c === row.cells.length - 1 ? 0 : lean / 2;
      const shape: Point[] = [
        [right + leanRight, lineY(top, right + leanRight)],
        [right - leanRight, lineY(bottom, right - leanRight)],
        [left - leanLeft, lineY(bottom, left - leanLeft)],
        [left + leanLeft, lineY(top, left + leanLeft)],
      ];
      const panel: Panel = { id: newId(project, "panel"), shape, order: 0 };
      if (row.black?.includes(c)) panel.fill = "black";
      panels.push(panel);
      right = left - gaps.across;
    });
  });
  // A left-bound book reads from the left: the pattern mirrored, its first cell top left.
  const mirrored = project.binding === "left";
  if (mirrored) for (const panel of panels) panel.shape = panel.shape.map(([x, y]): Point => [bx0 + bx1 - x, y]).reverse();
  const sideOf = (side: Side): Side => (!mirrored ? side : side === "left" ? "right" : side === "right" ? "left" : side);
  const firstRow = panels.slice(0, pattern.rows[0].cells.length);
  const lastRow = panels.slice(panels.length - pattern.rows[pattern.rows.length - 1].cells.length);
  const bleedAll = (list: Panel[], sides: Side[] | undefined) => {
    for (const panel of list) {
      for (const side of (sides ?? []).map(sideOf)) {
        // Only cells that touch that side of the frame run off the page.
        const [x0, y0, x1, y1] = bounds(panel.shape);
        const touches = { top: Math.abs(y0 - by0) < 1, bottom: Math.abs(y1 - by1) < 1, left: Math.abs(x0 - bx0) < 1, right: Math.abs(x1 - bx1) < 1 }[side];
        if (touches) bleedPanel(panel, side, format, true);
      }
    }
  };
  bleedAll(firstRow, pattern.bleed?.first);
  bleedAll(lastRow, pattern.bleed?.last);
  bleedAll(panels, pattern.bleed?.all);
  if (pattern.inset !== undefined) {
    const rowStart = pattern.rows.slice(0, pattern.inset).reduce((s, row) => s + row.cells.length, 0);
    const parent = panels[rowStart];
    const [x0, , , y1] = bounds(parent.shape);
    const [, , , fy1] = basicBox(format);
    const [px0, py0, px1, py1] = bounds(parent.shape);
    const w = (px1 - px0) * 0.36;
    const h = (py1 - py0) * 0.3;
    // Inside the frame even when the parent bleeds; over the corner read last.
    const left = mirrored ? Math.min(px1, bx1) - 4 - w : Math.max(x0, bx0) + 4;
    const bottom = Math.min(y1, fy1) - 4;
    panels.push({ id: newId(project, "panel"), shape: rectShape([left, bottom - h, left + w, bottom]), order: 0, fill: "white", z: 1 });
  }
  return panels;
}

/**
 * Replace the page's panels with a pattern's (with `count`, made to have that
 * many). What was in the panels goes along in panel order (the first panel's
 * into the new first panel, and so on; past the last new panel, into the
 * last), with the panels' memos.
 */
export function applyPattern(project: Project, page: Page, patternId: string, count?: number): void {
  const before = [...page.panels].sort((a, b) => a.order - b.order).map((panel) => ({ note: panel.note, carried: carryContents(page, panel) }));
  page.panels = patternPanels(project, patternId, gutters(project), count);
  orderPanels(page, project.binding);
  const after = [...page.panels].sort((a, b) => a.order - b.order);
  const shared = new Map<Panel, number>();
  before.forEach(({ note, carried }, k) => {
    const panel = after[Math.min(k, after.length - 1)];
    if (!panel) return;
    followPanel(page, panel, carried);
    if (note) panel.note = [panel.note, note].filter(Boolean).join("\n");
    shared.set(panel, (shared.get(panel) ?? 0) + 1);
  });
  assignPanels(page);
  // Several panels' dialogue in one: laid out again so it does not pile up.
  for (const [panel, count] of shared) if (count > 1) arrangePanel(project, page, panel);
  sortLines(page, project.binding);
}

// --- what is drawn of the borders -----------------------------------------------

function insideShape(shape: readonly Point[], [x, y]: Point): boolean {
  let inside = false;
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const [xi, yi] = shape[i];
    const [xj, yj] = shape[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Where segment a-b crosses segment c-d, as a fraction along a-b. */
function crossing(a: Point, b: Point, c: Point, d: Point): number | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const det = rx * sy - ry * sx;
  if (Math.abs(det) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / det;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / det;
  return t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1 ? t : null;
}

/** The parts of a polyline outside every one of `covers`. */
export function clipOutside(points: readonly Point[], closed: boolean, covers: readonly (readonly Point[])[]): { points: Point[]; closed: boolean }[] {
  if (!covers.length) return [{ points: [...points], closed }];
  const count = closed ? points.length : points.length - 1;
  const pieces: [Point, Point][] = [];
  let cut = false;
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ts = [0, 1];
    for (const cover of covers) {
      for (let k = 0; k < cover.length; k++) {
        const t = crossing(a, b, cover[k], cover[(k + 1) % cover.length]);
        if (t !== null) ts.push(t);
      }
    }
    ts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1] - ts[k] < 1e-9) continue;
      const p: Point = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]];
      const q: Point = [a[0] + (b[0] - a[0]) * ts[k + 1], a[1] + (b[1] - a[1]) * ts[k + 1]];
      const mid: Point = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      if (covers.some((cover) => insideShape(cover, mid))) {
        cut = true;
        continue;
      }
      pieces.push([p, q]);
    }
  }
  if (!cut) return [{ points: [...points], closed }];
  // Join pieces that meet end to start.
  const runs: Point[][] = [];
  for (const [p, q] of pieces) {
    const last = runs[runs.length - 1];
    const end = last?.[last.length - 1];
    if (end && Math.hypot(end[0] - p[0], end[1] - p[1]) < 1e-6) last.push(q);
    else runs.push([p, q]);
  }
  // A closed outline cut somewhere: its last run continues into its first.
  if (closed && runs.length > 1) {
    const first = runs[0];
    const last = runs[runs.length - 1];
    const end = last[last.length - 1];
    if (Math.hypot(end[0] - first[0][0], end[1] - first[0][1]) < 1e-6) {
      runs[0] = [...last, ...first.slice(1)];
      runs.pop();
    }
  }
  return runs.map((run) => ({ points: run, closed: false }));
}

/** Cut a polyline into dashes (破線), lengths in mm. */
export function dashes(points: readonly Point[], closed: boolean, on = 3, off = 1.6): Point[][] {
  const out: Point[][] = [];
  const all = closed ? [...points, points[0]] : [...points];
  let drawing = true;
  let left = on;
  let current: Point[] = [all[0]];
  for (let i = 0; i + 1 < all.length; i++) {
    let a = all[i];
    const b = all[i + 1];
    let length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (length > 1e-9) {
      const step = Math.min(left, length);
      const t = step / length;
      const p: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (drawing) current.push(p);
      left -= step;
      length -= step;
      a = p;
      if (left <= 1e-9) {
        if (drawing && current.length > 1) out.push(current);
        drawing = !drawing;
        left = drawing ? on : off;
        current = [p];
      }
    }
  }
  if (drawing && current.length > 1) out.push(current);
  return out;
}

/** Fills that hide what is under them. */
function covers(panel: Panel): boolean {
  return !!panel.fill && panel.fill !== "none";
}

export interface BorderLine {
  panel: Panel;
  points: Point[];
  closed: boolean;
}

/**
 * The border lines of a page as drawn: open edges left out, wavy borders
 * waved, and parts under a covering panel stacked above (はめ込み) or under a
 * はみ出し removed. Dashed borders stay whole; they are dashed when drawn.
 */
export function borderLines(page: Page): BorderLine[] {
  const panels = stacked(page.panels);
  const breakouts = (page.breakouts ?? []).filter((b) => b.shape.length >= 3).map((b) => b.shape);
  const lines: BorderLine[] = [];
  panels.forEach((panel, index) => {
    const border = panel.border ?? "solid";
    if (border === "none") return;
    const above = panels.slice(index + 1).filter((other) => covers(other) && (other.z ?? 0) > (panel.z ?? 0)).map((other) => other.shape);
    for (const run of borderRuns(panel)) {
      const points = border === "wavy" ? wavy(run.points, run.closed) : run.points;
      for (const piece of clipOutside(points, run.closed, [...above, ...breakouts])) lines.push({ panel, ...piece });
    }
  });
  return lines;
}

/** How far (mm) a 裁ち切り edge of a frame reaches past the canvas, so CSP draws its border off the page. */
const PAST_CANVAS_MM = 3;

/**
 * The panels a CSP コマ枠フォルダー can hold as they are drawn here, each
 * with its outline as a frame: a plain border (solid or thick), not an inset
 * or a 見開き half, and not cut by a panel above or a はみ出し. A 裁ち切り
 * edge must lie on the canvas edge (and not on `gutter`, the side of a
 * spread page that meets its facing page); it is moved past the canvas. The
 * other panels keep their borders as lines.
 */
export function framePanels(page: Page, format: PageFormat, gutter: Side | null = null): { panel: Panel; outline: Point[] }[] {
  const pieces = new Map<string, number>();
  for (const line of borderLines(page)) pieces.set(line.panel.id, (pieces.get(line.panel.id) ?? 0) + line.points.length);
  const sides: Side[] = ["top", "bottom", "left", "right"];
  const result: { panel: Panel; outline: Point[] }[] = [];
  for (const panel of page.panels) {
    const border = panel.border ?? "solid";
    if ((border !== "solid" && border !== "thick") || (panel.z ?? 0) > 0 || panel.spread || panel.shape.length < 3) continue;
    const runs = borderRuns(panel);
    // Cut by a panel above or a はみ出し: the drawn border has other points than its runs.
    if (pieces.get(panel.id) !== runs.reduce((sum, run) => sum + run.points.length, 0)) continue;
    const n = panel.shape.length;
    const outline = panel.shape.map((point): Point => [point[0], point[1]]);
    let framable = true;
    for (const edge of panel.openEdges ?? []) {
      const [a, b] = [panel.shape[edge], panel.shape[(edge + 1) % n]];
      const side = sides.find((side) => onCanvasSide(a, side, format) && onCanvasSide(b, side, format));
      if (!side || side === gutter) {
        framable = false;
        break;
      }
      for (const index of [edge, (edge + 1) % n]) {
        const [x, y] = outline[index];
        const [w, h] = format.canvasMm;
        outline[index] = {
          top: [x, -PAST_CANVAS_MM],
          bottom: [x, h + PAST_CANVAS_MM],
          left: [-PAST_CANVAS_MM, y],
          right: [w + PAST_CANVAS_MM, y],
        }[side] as Point;
      }
    }
    if (framable) result.push({ panel, outline });
  }
  return result;
}

/** Line width of a panel border on the manuscript, in mm. */
export function borderWidthMm(panel: Panel): number {
  return panelLineMm(panel);
}

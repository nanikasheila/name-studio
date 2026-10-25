// ネームデータ（正本）の編集: the edits the editor makes to the name data. Its
// types live in model.ts and plane geometry in geometry.ts; both are exported
// from here too. Coordinates are millimetres on the page canvas, origin at its
// top left. Functions here change the project in place; the editor takes a
// snapshot before each change for undo.

import { storedOutline } from "./balloon";
import { APP_FONT_PT, defaultFontPt, setDefaultFontPt } from "./style";
import { bounds, area, centroid, insidePolygon, segmentDistance, boxCenter, inheritOpenEdges } from "./geometry";
import type {
  Point,
  BoxMm,
  Binding,
  LineKind,
  BalloonShape,
  PageFormat,
  Panel,
  Line,
  StrokePoint,
  Stroke,
  EraseMode,
  Page,
  FillTone,
  Fill,
  StickyColor,
  Sticky,
  StickyLink,
  BuiltinShapeId,
  StoryShape,
  Character,
  Scene,
  Project,
  Gutters,
} from "./model";
import { wrapDialogue } from "./wrap";

export * from "./geometry";
export type * from "./model";

export const TONE_LABELS: Record<FillTone, string> = { black: "黒（ベタ）", gray: "グレー", white: "白" };

export function addFill(project: Project, page: Page, shape: Point[], tone: FillTone): Fill {
  const fill: Fill = { id: newId(project, "fill"), shape };
  if (tone !== "black") fill.tone = tone;
  page.fills = [...(page.fills ?? []), fill];
  return fill;
}

export const STICKY_COLORS: Record<StickyColor, { label: string; fill: string }> = {
  yellow: { label: "黄", fill: "#fff3a8" },
  pink: { label: "桃", fill: "#ffd3e0" },
  blue: { label: "青", fill: "#cfe6ff" },
  green: { label: "緑", fill: "#d4f2cf" },
};

/** Width of a sticky note and the size of its text, in mm on the page. */
export const STICKY_WIDTH_MM = 64;
export const STICKY_TEXT_MM = 6;

/** The rows a sticky's text takes (wrapped to its width). */
export function stickyRows(text: string): string[] {
  const perRow = Math.floor((STICKY_WIDTH_MM - 4) / STICKY_TEXT_MM);
  const rows: string[] = [];
  for (const paragraph of (text || "メモ").replace(/\r\n?/g, "\n").split("\n")) {
    const chars = [...paragraph];
    if (!chars.length) rows.push("");
    for (let i = 0; i < chars.length; i += perRow) rows.push(chars.slice(i, i + perRow).join(""));
  }
  return rows;
}

export function stickyBox(sticky: Sticky): BoxMm {
  const [x, y] = sticky.at;
  return [x, y, x + STICKY_WIDTH_MM, y + 4 + stickyRows(sticky.text).length * STICKY_TEXT_MM * 1.3];
}

export function addSticky(project: Project, page: Page, at: Point, text = ""): Sticky {
  const sticky: Sticky = { id: newId(project, "sticky"), text, at };
  keepStickyOnPage(project, sticky);
  (page.stickies ??= []).push(sticky);
  return sticky;
}

/** Keep a 付箋 on its own page, so it does not cover the facing page of a spread. */
export function keepStickyOnPage(project: Project, sticky: Sticky): void {
  const [width, height] = project.pageFormat.canvasMm;
  const [x0, y0, x1, y1] = stickyBox(sticky);
  const x = Math.min(Math.max(x0, 0), Math.max(0, width - (x1 - x0)));
  const y = Math.min(Math.max(y0, 0), Math.max(0, height - (y1 - y0)));
  sticky.at = [x, y];
}

/** The box a link's point is measured from: the panel's bounds or the line's box. */
function linkBase(page: Page, kind: StickyLink["kind"], id: string): BoxMm | null {
  if (kind === "panel") {
    const panel = page.panels.find((p) => p.id === id);
    return panel ? bounds(panel.shape) : null;
  }
  return page.lines.find((l) => l.id === id)?.box ?? null;
}

/** Where on the page a 付箋 points (null: it is about nothing there). */
export function stickyAnchor(page: Page, sticky: Sticky): Point | null {
  const link = sticky.link;
  const base = link && linkBase(page, link.kind, link.id);
  return link && base ? [base[0] + link.at[0], base[1] + link.at[1]] : null;
}

/** Tie a 付箋 to a panel or a line, pointing at `point` on it; false when it is not on the page. */
export function linkSticky(page: Page, sticky: Sticky, kind: StickyLink["kind"], id: string, point: Point): boolean {
  const base = linkBase(page, kind, id);
  if (!base) return false;
  sticky.link = { kind, id, at: [point[0] - base[0], point[1] - base[1]] };
  return true;
}

/** Let go of links to panels and lines no longer on the page; how many were let go. */
export function dropLostLinks(page: Page): number {
  let lost = 0;
  for (const sticky of page.stickies ?? []) {
    if (sticky.link && !linkBase(page, sticky.link.kind, sticky.link.id)) {
      delete sticky.link;
      lost++;
    }
  }
  return lost;
}

/** What a 付箋 is about, in a few words (empty: nothing). */
export function linkLabel(page: Page, sticky: Sticky): string {
  const link = sticky.link;
  if (!link || !linkBase(page, link.kind, link.id)) return "";
  if (link.kind === "panel") return `コマ ${page.panels.find((p) => p.id === link.id)!.order}`;
  const text = page.lines.find((l) => l.id === link.id)!.text.replace(/\s+/g, "");
  return `セリフ「${[...text].length > 10 ? `${[...text].slice(0, 10).join("")}…` : text}」`;
}

export function removeSticky(page: Page, id: string): void {
  page.stickies = (page.stickies ?? []).filter((sticky) => sticky.id !== id);
  if (!page.stickies.length) delete page.stickies;
}

/** Story shapes to hold the page split against: parts and their share of the pages. */
export const STRUCTURES: Record<BuiltinShapeId, StoryShape> = {
  kishotenketsu: {
    id: "kishotenketsu",
    label: "起承転結",
    parts: [
      { name: "起", share: 0.2 },
      { name: "承", share: 0.3 },
      { name: "転", share: 0.3 },
      { name: "結", share: 0.2 },
    ],
  },
  threeAct: {
    id: "threeAct",
    label: "三幕構成",
    parts: [
      { name: "第1幕（設定）", share: 0.25 },
      { name: "第2幕（対立）", share: 0.5 },
      { name: "第3幕（解決）", share: 0.25 },
    ],
    beats: [
      { name: "第1ターニングポイント", at: 0.25 },
      { name: "ミッドポイント", at: 0.5 },
      { name: "第2ターニングポイント", at: 0.75 },
    ],
  },
  johakyu: {
    id: "johakyu",
    label: "序破急",
    parts: [
      { name: "序", share: 0.25 },
      { name: "破", share: 0.5 },
      { name: "急", share: 0.25 },
    ],
  },
  // Blake Snyder's beat sheet, its 110 pages scaled to the name.
  saveTheCat: {
    id: "saveTheCat",
    label: "Save the Cat",
    parts: [
      { name: "セットアップ", share: 10 / 110 },
      { name: "きっかけ・悩みのとき", share: 15 / 110 },
      { name: "お楽しみ", share: 30 / 110 },
      { name: "迫り来る悪い奴ら", share: 20 / 110 },
      { name: "心の暗闇", share: 10 / 110 },
      { name: "フィナーレ", share: 25 / 110 },
    ],
    beats: [
      { name: "オープニング・イメージ", at: 0 },
      { name: "テーマの提示", at: 5 / 110 },
      { name: "きっかけ", at: 12 / 110 },
      { name: "第1ターニングポイント", at: 25 / 110 },
      { name: "サブプロット", at: 30 / 110 },
      { name: "ミッドポイント", at: 55 / 110 },
      { name: "すべてを失って", at: 75 / 110 },
      { name: "第2ターニングポイント", at: 85 / 110 },
      { name: "ファイナル・イメージ", at: 1 },
    ],
  },
};

export const FORMAT_VERSION = 2;
export const MM_PER_PT = 25.4 / 72;
/** Gap between panels side by side (左右) and one above the other (上下). */
export const DEFAULT_GUTTERS: Gutters = { across: 2, down: 6 };
/** The widest コマ間 that can be set (mm). */
export const MAX_GUTTER_SETTING_MM = 40;
/** 縦スクロール: panels one above the other are far apart, as the strip is read scrolling. */
export const SCROLL_GUTTERS: Gutters = { across: 3, down: 24 };

/** The コマ間 new panels of the project get. */
export function gutters(project: Project): Gutters {
  return project.gutters ?? DEFAULT_GUTTERS;
}

/** Sets the project's コマ間 (each 0 to MAX_GUTTER_SETTING_MM, 0.1 mm steps); the default is kept as none. */
export function setGutters(project: Project, next: Gutters): void {
  const clamp = (value: number, fallback: number) =>
    Number.isFinite(value) ? Math.round(Math.min(Math.max(value, 0), MAX_GUTTER_SETTING_MM) * 10) / 10 : fallback;
  const value = { across: clamp(next.across, gutters(project).across), down: clamp(next.down, gutters(project).down) };
  if (value.across === DEFAULT_GUTTERS.across && value.down === DEFAULT_GUTTERS.down) delete project.gutters;
  else project.gutters = value;
}

export const KIND_LABELS: Record<LineKind, string> = {
  speech: "セリフ",
  thought: "モノローグ",
  narration: "ナレーション",
  sfx: "描き文字",
  aside: "小書き",
};

/** A3 canvas, B4 trim and a 180 x 270 mm basic frame (same as the Rust default). */
export function defaultPageFormat(): PageFormat {
  return { canvasMm: [297, 420], trimMm: [257, 364], basicMm: [180, 270], basicOffsetMm: [0, 0] };
}

/**
 * 縦スクロール (Webtoon): one piece (区切り) of the strip, about two phone
 * screens tall. The strip is not cut, so the trim is the whole piece; the
 * basic frame keeps panels off its sides and apart across the pieces.
 */
export function scrollPageFormat(): PageFormat {
  return { canvasMm: [120, 240], trimMm: [120, 240], basicMm: [108, 228], basicOffsetMm: [0, 0] };
}

/** What kind of name it is: a right-bound (manga) or left-bound book, or a 縦スクロール strip (read top to bottom, left-bound otherwise). */
export type NameKind = Binding | "scroll";

export function nameKind(project: Project): NameKind {
  return project.scroll ? "scroll" : project.binding;
}

export function newProject(title: string, pageCount: number, kind: NameKind = "right"): Project {
  const project: Project = {
    formatVersion: FORMAT_VERSION,
    title,
    author: "",
    binding: kind === "right" ? "right" : "left",
    pageFormat: kind === "scroll" ? scrollPageFormat() : defaultPageFormat(),
    pages: [],
    characters: [],
    scenes: [],
    emotions: [],
    brushes: [],
    nextId: 1,
  };
  if (kind === "scroll") {
    project.scroll = true;
    project.gutters = { ...SCROLL_GUTTERS };
  }
  for (let i = 0; i < pageCount; i++) project.pages.push(emptyPage(newId(project, "page")));
  return project;
}

export function emptyPage(id: string): Page {
  return { id, memo: "", panels: [], lines: [], strokes: [], roughs: [], breakouts: [] };
}

/** Fill in fields the Rust side leaves out when they are empty. */
export function normalize(project: Project): Project {
  project.characters ??= [];
  project.scenes ??= [];
  project.emotions ??= [];
  project.author ??= "";
  project.brushes ??= [];
  for (const brush of project.brushes) {
    brush.kind ??= "pen";
    brush.opacity ??= 1;
    brush.hardness ??= 1;
    brush.stabilization ??= 0;
    brush.taperInMm ??= 0;
    brush.taperOutMm ??= 0;
    brush.thickness ??= 100;
    brush.rotation ??= 0;
  }
  const beforeShapes = (project.formatVersion ?? 1) < 2;
  const stored = (project.alternatives ?? []).flatMap((set) => set.options.flatMap((option) => (option.pages ??= [])));
  for (const page of [...project.pages, ...stored]) {
    page.memo ??= "";
    page.panels ??= [];
    page.lines ??= [];
    page.strokes ??= [];
    page.roughs ??= [];
    page.breakouts ??= [];
    for (const line of page.lines) {
      line.kind ??= "speech";
      // Before balloon shapes (format 1), an outline the editor did not make
      // (it made 40-point ellipses and 4-point boxes) came from CSP.
      if (beforeShapes && !line.balloonShape && line.balloon && line.balloon.length !== 40 && line.balloon.length !== 4) line.balloonShape = "custom";
    }
  }
  for (const scene of project.scenes) scene.summary ??= "";
  for (const point of project.emotions) point.note ??= "";
  project.pageFormat.basicOffsetMm ??= [0, 0];
  // Saved again by this version, the file may hold parts older versions drop.
  project.formatVersion = Math.max(project.formatVersion ?? FORMAT_VERSION, FORMAT_VERSION);
  return project;
}

export function newId(project: Project, prefix: string): string {
  return `${prefix}${project.nextId++}`;
}

// --- geometry ----------------------------------------------------------------

function centred(format: PageFormat, size: [number, number], offset: [number, number]): BoxMm {
  const x0 = (format.canvasMm[0] - size[0]) / 2 + offset[0];
  const y0 = (format.canvasMm[1] - size[1]) / 2 + offset[1];
  return [x0, y0, x0 + size[0], y0 + size[1]];
}

export function trimBox(format: PageFormat): BoxMm {
  return centred(format, format.trimMm, [0, 0]);
}

export function basicBox(format: PageFormat): BoxMm {
  return centred(format, format.basicMm, format.basicOffsetMm);
}

/** Keep the part of `shape` where `side(point) >= 0` (Sutherland–Hodgman, one edge). */
export function clipHalfPlane(shape: readonly Point[], side: (p: Point) => number): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < shape.length; i++) {
    const current = shape[i];
    const next = shape[(i + 1) % shape.length];
    const sc = side(current);
    const sn = side(next);
    if (sc >= 0) result.push(current);
    if ((sc >= 0) !== (sn >= 0)) {
      const t = sc / (sc - sn);
      result.push([current[0] + t * (next[0] - current[0]), current[1] + t * (next[1] - current[1])]);
    }
  }
  return dedupe(result);
}

function dedupe(shape: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of shape) {
    const last = result[result.length - 1];
    if (!last || Math.hypot(last[0] - point[0], last[1] - point[1]) > 1e-6) result.push(point);
  }
  if (result.length > 1) {
    const [first, last] = [result[0], result[result.length - 1]];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) result.pop();
  }
  return result;
}

/** The gutter for a cut from `a` to `b`: mostly vertical cuts separate panels side by side. */
export function gutterFor(a: Point, b: Point, gutters = DEFAULT_GUTTERS): number {
  return Math.abs(b[0] - a[0]) < Math.abs(b[1] - a[1]) ? gutters.across : gutters.down;
}

/**
 * Cut a polygon along the straight line through `a` and `b`, leaving `gutter`
 * mm between the two halves. Returns null when the line misses the polygon or
 * one half would be too small to be a panel.
 */
export function splitShape(shape: readonly Point[], a: Point, b: Point, gutter: number): [Point[], Point[]] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return null;
  const distance = (p: Point) => ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length;
  const first = clipHalfPlane(shape, (p) => distance(p) - gutter / 2);
  const second = clipHalfPlane(shape, (p) => -distance(p) - gutter / 2);
  const minimum = 4; // mm²
  if (first.length < 3 || second.length < 3 || area(first) < minimum || area(second) < minimum) return null;
  return [first, second];
}

/** Whether the segment `a`-`b` crosses the polygon's outline or lies inside it. */
export function segmentTouches(shape: readonly Point[], a: Point, b: Point): boolean {
  if (insidePolygon(shape, a) || insidePolygon(shape, b)) return true;
  const cross = (o: Point, p: Point, q: Point) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  for (let i = 0; i < shape.length; i++) {
    const c = shape[i];
    const d = shape[(i + 1) % shape.length];
    const d1 = cross(a, b, c);
    const d2 = cross(a, b, d);
    const d3 = cross(c, d, a);
    const d4 = cross(c, d, b);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  }
  return false;
}

/** Make an almost horizontal or vertical cut exactly so (within `degrees`). */
export function snapCut(a: Point, b: Point, degrees = 6): Point {
  const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const off = (target: number) => Math.abs(((angle - target + 540) % 360) - 180);
  if (off(0) <= degrees || off(180) <= degrees) return [b[0], a[1]];
  if (off(90) <= degrees || off(-90) <= degrees) return [a[0], b[1]];
  return b;
}

/** Edges a panel corner snaps to: the canvas, the trim and the basic frame. */
export function snapLines(format: PageFormat): { xs: number[]; ys: number[] } {
  const trim = trimBox(format);
  const basic = basicBox(format);
  return {
    xs: [0, format.canvasMm[0], trim[0], trim[2], basic[0], basic[2]],
    ys: [0, format.canvasMm[1], trim[1], trim[3], basic[1], basic[3]],
  };
}

export function snapPoint([x, y]: Point, lines: { xs: number[]; ys: number[] }, tolerance: number): Point {
  const nearest = (value: number, candidates: number[]) => {
    let best = value;
    let distance = tolerance;
    for (const candidate of candidates) {
      if (Math.abs(candidate - value) <= distance) {
        best = candidate;
        distance = Math.abs(candidate - value);
      }
    }
    return best;
  };
  return [nearest(x, lines.xs), nearest(y, lines.ys)];
}

// --- panels --------------------------------------------------------------------

/**
 * Reading order of panels in a right-bound book (same rule as the Rust
 * import): rows top to bottom, a panel starts a new row when its top is below
 * the current row's middle; right to left inside a row.
 */
export function orderPanels(page: Page, binding: Binding = "right"): void {
  const sorted = [...page.panels].sort((a, b) => bounds(a.shape)[1] - bounds(b.shape)[1]);
  const rows = new Map<Panel, number>();
  let row = 0;
  let rowMiddle = -Infinity;
  sorted.forEach((panel, index) => {
    const [, y0, , y1] = bounds(panel.shape);
    if (index > 0 && y0 >= rowMiddle) row++;
    if (index === 0 || y0 >= rowMiddle) rowMiddle = (y0 + y1) / 2;
    rows.set(panel, row);
  });
  const side = (panel: Panel) => (binding === "right" ? -bounds(panel.shape)[2] : bounds(panel.shape)[0]);
  sorted.sort((a, b) => rows.get(a)! - rows.get(b)! || side(a) - side(b));
  sorted.forEach((panel, index) => (panel.order = index + 1));
  page.panels = sorted;
}

export function addPanel(project: Project, page: Page, shape: Point[]): Panel {
  const panel: Panel = { id: newId(project, "panel"), shape, order: page.panels.length + 1 };
  page.panels.push(panel);
  orderPanels(page, project.binding);
  assignPanels(page);
  return panel;
}

/** Split every panel the cut `a`-`b` touches. Returns the ids of the new panels. */
export function cutPanels(project: Project, page: Page, a: Point, b: Point, gaps = gutters(project)): string[] {
  const gutter = gutterFor(a, b, gaps);
  const created: string[] = [];
  const panels: Panel[] = [];
  for (const panel of page.panels) {
    const halves = segmentTouches(panel.shape, a, b) ? splitShape(panel.shape, a, b, gutter) : null;
    if (!halves) {
      panels.push(panel);
      continue;
    }
    // Both halves keep the panel's look; edges cut from an open edge stay open.
    const [first, second] = halves.map((shape) => {
      const half: Panel = { ...panel, shape };
      const open = inheritOpenEdges(panel.shape, panel.openEdges, shape);
      if (open.length) half.openEdges = open;
      else delete half.openEdges;
      return half;
    });
    if (panel.spread) {
      // A 見開き has one half per page: it stays with the part at the gutter.
      const [w] = project.pageFormat.canvasMm;
      const atGutter = (half: Panel) => half.shape.some(([x]) => x <= 0.05 || x >= w - 0.05);
      if (atGutter(first)) delete second.spread;
      else delete first.spread;
    }
    panels.push(first);
    const id = newId(project, "panel");
    panels.push({ ...second, id, order: 0 });
    created.push(id);
  }
  if (!created.length) return created;
  page.panels = panels;
  orderPanels(page, project.binding);
  assignPanels(page);
  return created;
}

export function removePanel(page: Page, panelId: string, binding: Binding = "right"): void {
  page.panels = page.panels.filter((panel) => panel.id !== panelId);
  orderPanels(page, binding);
  assignPanels(page);
}

/** Give each line the panel its centre is in. */
export function assignPanels(page: Page): void {
  // A panel on top (an inset, はめ込み) before the one under it, then reading order.
  const panels = [...page.panels].sort((a, b) => (b.z ?? 0) - (a.z ?? 0) || a.order - b.order);
  for (const line of page.lines) {
    const center = boxCenter(line.box);
    const panel = panels.find((p) => insidePolygon(p.shape, center));
    if (panel) line.panel = panel.id;
    else delete line.panel;
  }
}

// --- lines -----------------------------------------------------------------------

/** Line pitch as a multiple of the font size. */
export const LINE_PITCH = 1.15;

const HALF_WIDTH = /[\u0020-\u007e\uff61-\uff9f]/;
/** How wide a half-width letter is, in full-width ones (for sans-serif Latin, a little over half). */
const HALF_WIDTH_EM = 0.6;

/** Text written mostly in half-width letters (English and the like). */
export function mostlyHalfWidth(text: string): boolean {
  const chars = [...text];
  return chars.filter((char) => HALF_WIDTH.test(char)).length * 2 > chars.length;
}

/** Size of a text block, in mm: vertical columns right to left, or horizontal rows. */
export function textSize(text: string, fontSizePt: number, vertical: boolean): [number, number] {
  const size = fontSizePt * MM_PER_PT;
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  // Across, half-width letters (Latin, digits, ｱ) take about half a full-width one; down a column every character takes a whole cell.
  const length = (row: string) => (vertical ? [...row].length : [...row].reduce((sum, char) => sum + (HALF_WIDTH.test(char) ? HALF_WIDTH_EM : 1), 0));
  const longest = Math.max(1, ...rows.map(length));
  const across = size * (1 + (rows.length - 1) * LINE_PITCH);
  return vertical ? [across, longest * size] : [longest * size, across];
}

/** Outline for a line's balloon, or undefined for kinds drawn without one. */
export function balloonFor(kind: LineKind, box: BoxMm): Point[] | undefined {
  return storedOutline({ id: "", text: "", kind, box, fontSizePt: APP_FONT_PT[kind], vertical: true });
}

/** Resize a line's box around its centre to fit its text, and redo its balloon. */
export function fitLine(line: Line): void {
  const [w, h] = textSize(line.text, line.fontSizePt, line.vertical);
  const [cx, cy] = boxCenter(line.box);
  const box: BoxMm = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  if (line.balloonShape === "custom" && line.balloon) {
    // An imported outline follows its text.
    const [ox, oy] = boxCenter(line.box);
    line.balloon = line.balloon.map(([x, y]) => [x + cx - ox, y + cy - oy]);
  }
  line.box = box;
  const balloon = storedOutline(line);
  if (balloon) line.balloon = balloon;
  else delete line.balloon;
}

/**
 * New text for a line, its reading start kept where it is: the top right of
 * vertical text (its first column), the top left of horizontal text. The
 * balloon grows away from there, and the tails keep pointing where they did.
 */
export function setLineText(line: Line, text: string): void {
  const [x0, y0, x1] = line.box;
  line.text = text;
  fitLine(line);
  moveLine(line, line.vertical ? x1 - line.box[2] : x0 - line.box[0], y0 - line.box[1]);
}

/** A long line typed in one go, broken the way a letterer would (one already broken by hand is left as it is). */
export function wrapTypedLine(line: Line): boolean {
  if (line.kind === "sfx" || line.text.includes("\n")) return false;
  // Lines across hold more than columns down, and Latin letters are narrow.
  const wrapped = wrapDialogue(line.text, line.vertical ? 8 : mostlyHalfWidth(line.text) ? 20 : 12);
  if (wrapped === line.text) return false;
  setLineText(line, wrapped);
  return true;
}

/** New dialogue is written top to bottom in a manga (right binding), across in a left-bound book. */
export function writesVertically(project: Project): boolean {
  return project.binding === "right";
}

/**
 * 右綴じ・左綴じ: the way the book reads. The panels and lines on every page
 * are numbered again in the new order; with `turnText` the lines written the
 * old way's usual direction (縦書き in a right-bound book) take the new one's.
 */
export function setBinding(project: Project, binding: Binding, turnText = true): void {
  if (project.binding === binding) return;
  const wasVertical = writesVertically(project);
  project.binding = binding;
  const nowVertical = writesVertically(project);
  for (const page of project.pages) {
    if (turnText && wasVertical !== nowVertical) {
      for (const line of page.lines) {
        if (line.vertical !== wasVertical) continue;
        line.vertical = nowVertical;
        fitLine(line);
      }
    }
    orderPanels(page, binding);
    sortLines(page, binding);
  }
}

export function addLine(project: Project, page: Page, center: Point, text = "セリフ", kind: LineKind = "speech"): Line {
  const line: Line = {
    id: newId(project, "line"),
    text,
    kind,
    box: [center[0], center[1], center[0], center[1]],
    fontSizePt: defaultFontPt(kind, project.style),
    vertical: writesVertically(project),
  };
  const shape = project.lineShapes?.[kind];
  if (shape && shape !== "auto") line.balloonShape = shape;
  fitLine(line);
  page.lines.push(line);
  assignPanels(page);
  sortLines(page, project.binding);
  return line;
}

/** Change a line's kind; a balloon that had the old kind's usual shape takes the new kind's. */
export function setLineKind(project: Project, line: Line, kind: LineKind): void {
  const usual = (k: LineKind) => project.lineShapes?.[k] ?? "auto";
  if ((line.balloonShape ?? "auto") === usual(line.kind)) {
    const shape = usual(kind);
    if (shape === "auto") delete line.balloonShape;
    else line.balloonShape = shape;
  }
  line.kind = kind;
  fitLine(line);
}

/**
 * 作品の既定にする: new lines of `kind` get `shape`, and so do the lines of
 * that kind that had the usual shape until now. Returns how many changed.
 */
export function setDefaultShape(project: Project, kind: LineKind, shape: BalloonShape): number {
  const before = project.lineShapes?.[kind] ?? "auto";
  const shapes = { ...project.lineShapes };
  if (shape === "auto") delete shapes[kind];
  else shapes[kind] = shape;
  if (Object.keys(shapes).length) project.lineShapes = shapes;
  else delete project.lineShapes;
  let changed = 0;
  for (const page of project.pages) {
    for (const line of page.lines) {
      if (line.kind !== kind || (line.balloonShape ?? "auto") !== before || before === shape) continue;
      if (shape === "auto") delete line.balloonShape;
      else line.balloonShape = shape;
      fitLine(line);
      changed++;
    }
  }
  return changed;
}

/**
 * 文字の大きさの既定 of a kind of line (null: the app's). The lines of that
 * kind still at the old default size take the new one; returns how many.
 */
export function setDefaultLineSize(project: Project, kind: LineKind, pt: number | null): number {
  const before = defaultFontPt(kind, project.style);
  setDefaultFontPt(project, kind, pt);
  const after = defaultFontPt(kind, project.style);
  if (after === before) return 0;
  let changed = 0;
  for (const page of project.pages) {
    for (const line of page.lines) {
      if (line.kind !== kind || line.fontSizePt !== before) continue;
      line.fontSizePt = after;
      setLineText(line, line.text);
      changed++;
    }
  }
  return changed;
}

/** Move a line with its balloon; tails keep pointing at their speakers. */
export function moveLine(line: Line, dx: number, dy: number): void {
  const [x0, y0, x1, y1] = line.box;
  line.box = [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
  if (line.balloon) line.balloon = line.balloon.map(([x, y]) => [x + dx, y + dy]);
}

/**
 * Reading order: by panel, then from the top right towards the bottom left
 * (manga, right binding) or from the top left towards the bottom right (left binding).
 */
export function sortLines(page: Page, binding: Binding = "right"): void {
  const order = new Map(page.panels.map((panel) => [panel.id, panel.order]));
  const key = (line: Line) => {
    const [cx, cy] = boxCenter(line.box);
    return { panel: line.panel ? order.get(line.panel) ?? Infinity : Infinity, diagonal: binding === "right" ? cy - cx : cy + cx };
  };
  page.lines.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka.panel - kb.panel || ka.diagonal - kb.diagonal;
  });
}

export function movePanel(panel: Panel, dx: number, dy: number): void {
  panel.shape = panel.shape.map(([x, y]) => [x + dx, y + dy]);
}

export function moveStroke(stroke: Stroke, dx: number, dy: number): void {
  stroke.points = stroke.points.map(([x, y, ...rest]) => [x + dx, y + dy, ...rest] as StrokePoint);
}

// --- strokes -------------------------------------------------------------------

export function addStroke(
  project: Project,
  page: Page,
  points: StrokePoint[],
  widthMm: number,
  brush?: string,
): Stroke | null {
  if (points.length < 2) return null;
  const stroke: Stroke = { id: newId(project, "stroke"), points: simplify(points, 0.15), widthMm, closed: false };
  // Point lists are shared by undo and saving (snapshot.ts, projectjson.ts) and
  // never changed in place; in development a change in place fails loudly.
  if (import.meta.env.DEV) for (const point of Object.freeze(stroke.points)) Object.freeze(point);
  if (brush) stroke.brush = brush;
  page.strokes.push(stroke);
  return stroke;
}

/** Drop points closer than `tolerance` mm to the previous kept one. */
export function simplify(points: StrokePoint[], tolerance: number): StrokePoint[] {
  const result: StrokePoint[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= tolerance) result.push(point);
  }
  const end = points[points.length - 1];
  if (result[result.length - 1] !== end) result.push(end);
  return result;
}

export function strokeHit(stroke: Stroke, point: Point, radius: number): boolean {
  const pts = stroke.points;
  if (pts.length === 1) return Math.hypot(pts[0][0] - point[0], pts[0][1] - point[1]) <= radius;
  for (let i = 1; i < pts.length; i++) {
    const a: Point = [pts[i - 1][0], pts[i - 1][1]];
    const b: Point = [pts[i][0], pts[i][1]];
    if (segmentDistance(point, a, b) <= radius + stroke.widthMm / 2) return true;
  }
  return false;
}

/** Remove strokes under the eraser; returns how many went. */
export function eraseStrokes(page: Page, point: Point, radius: number): number {
  const before = page.strokes.length;
  page.strokes = page.strokes.filter((stroke) => !strokeHit(stroke, point, radius));
  return before - page.strokes.length;
}

/** Erase like a CSP vector eraser; returns how many strokes changed. */
export function eraseWith(project: Project, page: Page, point: Point, radius: number, mode: EraseMode): number {
  if (mode === "whole") return eraseStrokes(page, point, radius);
  const others = page.strokes.slice();
  let changed = 0;
  const result: Stroke[] = [];
  for (const stroke of page.strokes) {
    if (stroke.points.length < 2 || !strokeHit(stroke, point, radius)) {
      result.push(stroke);
      continue;
    }
    const pieces =
      mode === "touched"
        ? cutAround(stroke.points, point, radius + stroke.widthMm / 2)
        : cutBetweenCrossings(stroke, others, point);
    changed++;
    for (const [index, piece] of pieces.entries()) {
      const part: Stroke = { ...stroke, id: index === 0 ? stroke.id : newId(project, "stroke"), points: piece.points };
      const cut: [boolean, boolean] = [piece.cutStart || !!stroke.cut?.[0], piece.cutEnd || !!stroke.cut?.[1]];
      if (cut[0] || cut[1]) part.cut = cut;
      else delete part.cut;
      result.push(part);
    }
  }
  page.strokes = result;
  return changed;
}

/** A piece left of a line, and whether each of its ends is where the eraser cut. */
interface Piece {
  points: StrokePoint[];
  cutStart: boolean;
  cutEnd: boolean;
}

/** 触れた部分: the runs of the line outside the circle. */
function cutAround(points: StrokePoint[], center: Point, radius: number): Piece[] {
  // Put extra points where segments pass the circle so the cut lands close to it.
  const step = Math.max(radius / 3, 0.05);
  const dense: StrokePoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (segmentDistance(center, [a[0], a[1]], [b[0], b[1]]) <= radius) {
      const count = Math.min(Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step), 2000);
      for (let k = 1; k < count; k++) dense.push(lerpPoint(a, b, k / count));
    }
    dense.push(b);
  }
  const pieces: Piece[] = [];
  let run: StrokePoint[] = [];
  let start = 0;
  dense.forEach((p, index) => {
    if (Math.hypot(p[0] - center[0], p[1] - center[1]) > radius) {
      if (!run.length) start = index;
      run.push(p);
      return;
    }
    if (run.length >= 2) pieces.push({ points: run, cutStart: start > 0, cutEnd: true });
    run = [];
  });
  if (run.length >= 2) pieces.push({ points: run, cutStart: start > 0, cutEnd: false });
  return pieces;
}

/** 交点まで: remove the stretch under the eraser up to the nearest crossings with other lines. */
function cutBetweenCrossings(stroke: Stroke, others: Stroke[], center: Point): Piece[] {
  const pts = stroke.points;
  const lengths = [0];
  for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = lengths[lengths.length - 1];
  // Where along the line the eraser is.
  let at = 0;
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const t = projectOnSegment(center, pts[i - 1], pts[i]);
    const p = lerpPoint(pts[i - 1], pts[i], t);
    const d = Math.hypot(p[0] - center[0], p[1] - center[1]);
    if (d < best) {
      best = d;
      at = lengths[i - 1] + t * (lengths[i] - lengths[i - 1]);
    }
  }
  let from = 0;
  let to = total;
  for (const other of others) {
    if (other === stroke) continue;
    for (let i = 1; i < pts.length; i++) {
      for (let j = 1; j < other.points.length; j++) {
        const t = crossing(pts[i - 1], pts[i], other.points[j - 1], other.points[j]);
        if (t === null) continue;
        const distance = lengths[i - 1] + t * (lengths[i] - lengths[i - 1]);
        if (distance < at) from = Math.max(from, distance);
        else if (distance > at) to = Math.min(to, distance);
      }
    }
  }
  const pieces: Piece[] = [
    { points: slicePolyline(pts, lengths, 0, from), cutStart: false, cutEnd: true },
    { points: slicePolyline(pts, lengths, to, total), cutStart: true, cutEnd: false },
  ];
  return pieces.filter(({ points: piece }) =>
    piece.length >= 2 && Math.hypot(piece[0][0] - piece[piece.length - 1][0], piece[0][1] - piece[piece.length - 1][1]) > 1e-6,
  );
}

function lerpPoint(a: StrokePoint, b: StrokePoint, t: number): StrokePoint {
  const length = Math.min(a.length, b.length);
  return a.slice(0, length).map((value, i) => value + (b[i] - value) * t) as StrokePoint;
}

function projectOnSegment(p: Point, a: StrokePoint, b: StrokePoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  return length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
}

/** Where segment ab crosses cd, as a fraction of ab; null when they do not. */
function crossing(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): number | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denominator;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** The part of a line between two distances along it. */
function slicePolyline(pts: StrokePoint[], lengths: number[], from: number, to: number): StrokePoint[] {
  if (to - from <= 1e-9) return [];
  const at = (distance: number): StrokePoint => {
    for (let i = 1; i < pts.length; i++) {
      if (distance <= lengths[i] || i === pts.length - 1) {
        const span = lengths[i] - lengths[i - 1];
        return lerpPoint(pts[i - 1], pts[i], span === 0 ? 0 : (distance - lengths[i - 1]) / span);
      }
    }
    return pts[pts.length - 1];
  };
  const result: StrokePoint[] = [at(from)];
  for (let i = 0; i < pts.length; i++) if (lengths[i] > from && lengths[i] < to) result.push(pts[i]);
  result.push(at(to));
  return result;
}

// --- pages -----------------------------------------------------------------------

export function pageIndex(project: Project, pageId: string): number {
  return project.pages.findIndex((page) => page.id === pageId);
}

export function insertPage(project: Project, index: number): Page {
  const page = emptyPage(newId(project, "page"));
  project.pages.splice(Math.max(0, Math.min(index, project.pages.length)), 0, page);
  return page;
}

/** Remove a page with what refers to it: emotion values and scene ends. */
export function removePage(project: Project, pageId: string): void {
  const index = pageIndex(project, pageId);
  if (index < 0) return;
  project.pages.splice(index, 1);
  project.emotions = project.emotions.filter((point) => point.page !== pageId);
  // 別案 of only this page go with it.
  if (project.alternatives) {
    for (const set of project.alternatives) set.pageIds = set.pageIds.filter((id) => id !== pageId);
    project.alternatives = project.alternatives.filter((set) => set.pageIds.length);
    if (!project.alternatives.length) delete project.alternatives;
  }
  const neighbour = (forward: boolean) => {
    const near = forward ? project.pages[index] : project.pages[index - 1];
    return (near ?? project.pages[index - 1] ?? project.pages[index])?.id;
  };
  project.scenes = project.scenes.flatMap((scene) => {
    if (scene.firstPage === pageId) scene.firstPage = neighbour(true) ?? "";
    if (scene.lastPage === pageId) scene.lastPage = neighbour(false) ?? "";
    const first = pageIndex(project, scene.firstPage);
    const last = pageIndex(project, scene.lastPage);
    return first < 0 || last < 0 || first > last ? [] : [scene];
  });
}

export function movePage(project: Project, pageId: string, step: number): void {
  const index = pageIndex(project, pageId);
  const target = index + step;
  if (index < 0 || target < 0 || target >= project.pages.length) return;
  const [page] = project.pages.splice(index, 1);
  project.pages.splice(target, 0, page);
  // Keep scenes in page order after the move.
  for (const scene of project.scenes) {
    if (pageIndex(project, scene.firstPage) > pageIndex(project, scene.lastPage)) {
      [scene.firstPage, scene.lastPage] = [scene.lastPage, scene.firstPage];
    }
  }
}

// --- characters, scenes and emotions ----------------------------------------------

/** Categorical colours in a fixed order, checked for colour-blind separation. */
export const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];

export function addCharacter(project: Project, name: string): Character {
  const character: Character = {
    id: newId(project, "character"),
    name,
    // Past eight the colours repeat; the name tells them apart.
    color: PALETTE[project.characters.length % PALETTE.length],
  };
  project.characters.push(character);
  return character;
}

export function removeCharacter(project: Project, characterId: string): void {
  project.characters = project.characters.filter((character) => character.id !== characterId);
  project.emotions = project.emotions.filter((point) => point.character !== characterId);
  for (const page of project.pages) {
    for (const line of page.lines) if (line.speaker === characterId) delete line.speaker;
  }
}

/** Set (or with `null`, clear) how a character feels at a page. */
export function setEmotion(project: Project, characterId: string, pageId: string, value: number | null, note?: string): void {
  const existing = project.emotions.find((point) => point.character === characterId && point.page === pageId);
  if (value === null) {
    project.emotions = project.emotions.filter((point) => point !== existing);
    return;
  }
  const clamped = Math.max(-1, Math.min(1, value));
  if (existing) {
    existing.value = clamped;
    if (note !== undefined) existing.note = note;
  } else {
    project.emotions.push({ character: characterId, page: pageId, value: clamped, note: note ?? "" });
  }
}

export function addScene(project: Project, firstPage: string, lastPage: string, title: string): Scene {
  const scene: Scene = { id: newId(project, "scene"), title, summary: "", firstPage, lastPage };
  project.scenes.push(scene);
  sortScenes(project);
  return scene;
}

/**
 * A scene over pages `first`..`last` (0-based) that takes the place of the
 * scenes it overlaps; a scene it replaces over the very same pages hands on
 * its summary when the new one has none. Returns the scene and how many it replaced.
 */
export function putScene(project: Project, first: number, last: number, title: string, summary = ""): { scene: Scene; replaced: number } {
  let kept = "";
  let replaced = 0;
  project.scenes = project.scenes.filter((s) => {
    const [a, b] = [pageIndex(project, s.firstPage), pageIndex(project, s.lastPage)];
    if (b < first || a > last) return true;
    if (a === first && b === last) kept = s.summary;
    // The very same scene taken in again is not counted as replaced.
    if (!(a === first && b === last && s.title === title)) replaced++;
    return false;
  });
  const scene = addScene(project, project.pages[first].id, project.pages[last].id, title);
  scene.summary = summary || kept;
  return { scene, replaced };
}

export function sortScenes(project: Project): void {
  project.scenes.sort((a, b) => pageIndex(project, a.firstPage) - pageIndex(project, b.firstPage));
}

/** The scene a page belongs to (the first one that covers it). */
export function sceneOf(project: Project, pageId: string): Scene | undefined {
  const index = pageIndex(project, pageId);
  return project.scenes.find(
    (scene) => pageIndex(project, scene.firstPage) <= index && index <= pageIndex(project, scene.lastPage),
  );
}

/** Lines in reading order, with their page number (1-based). */
export function script(project: Project): { page: number; line: Line }[] {
  return project.pages.flatMap((page, index) => page.lines.map((line) => ({ page: index + 1, line })));
}

/** Count of characters spoken per page, a rough measure of how text heavy it is. */
export function textAmount(page: Page): number {
  return page.lines.reduce((sum, line) => sum + [...line.text.replace(/\s/g, "")].length, 0);
}

/** 囲って消す: remove the parts of rough lines inside `shape` (as CSP deletes
 * a selection on a vector layer); returns how many lines changed. */
export function eraseInside(project: Project, page: Page, shape: readonly Point[]): number {
  if (shape.length < 3) return 0;
  const [x0, y0, x1, y1] = bounds([...shape]);
  let changed = 0;
  const result: Stroke[] = [];
  for (const stroke of page.strokes) {
    const [sx0, sy0, sx1, sy1] = bounds(stroke.points.map(([x, y]) => [x, y] as Point));
    const near = sx1 >= x0 && sx0 <= x1 && sy1 >= y0 && sy0 <= y1;
    if (!near) {
      result.push(stroke);
      continue;
    }
    const pieces = cutInside(stroke.points, shape);
    if (pieces.length === 1 && !pieces[0].cutStart && !pieces[0].cutEnd && pieces[0].points.length === stroke.points.length) {
      result.push(stroke);
      continue;
    }
    changed++;
    for (const [index, piece] of pieces.entries()) {
      const part: Stroke = { ...stroke, id: index === 0 ? stroke.id : newId(project, "stroke"), points: piece.points };
      const cut: [boolean, boolean] = [piece.cutStart || !!stroke.cut?.[0], piece.cutEnd || !!stroke.cut?.[1]];
      if (cut[0] || cut[1]) part.cut = cut;
      else delete part.cut;
      result.push(part);
    }
  }
  page.strokes = result;
  // Fills go when most of their outline is inside.
  const fills = (page.fills ?? []).filter((fill) => fill.shape.filter((p) => insidePolygon(shape, p)).length < fill.shape.length / 2);
  changed += (page.fills?.length ?? 0) - fills.length;
  if (page.fills) page.fills = fills;
  return changed;
}

/** The runs of a line outside `shape`, cut close to its edge. */
function cutInside(points: StrokePoint[], shape: readonly Point[]): Piece[] {
  const inside = (p: StrokePoint) => insidePolygon(shape, [p[0], p[1]]);
  const [x0, y0, x1, y1] = bounds([...shape]);
  // Put extra points on segments that reach the outline so the cut lands close to it.
  const dense: StrokePoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const reaches = Math.max(a[0], b[0]) >= x0 && Math.min(a[0], b[0]) <= x1 && Math.max(a[1], b[1]) >= y0 && Math.min(a[1], b[1]) <= y1;
    if (reaches) {
      const count = Math.min(Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1), 2000);
      for (let k = 1; k < count; k++) dense.push(lerpPoint(a, b, k / count));
    }
    dense.push(b);
  }
  const pieces: Piece[] = [];
  let run: StrokePoint[] = [];
  let start = 0;
  dense.forEach((p, index) => {
    if (!inside(p)) {
      if (!run.length) start = index;
      run.push(p);
      return;
    }
    if (run.length >= 2) pieces.push({ points: run, cutStart: start > 0, cutEnd: true });
    run = [];
  });
  if (run.length >= 2) pieces.push({ points: run, cutStart: start > 0, cutEnd: false });
  return pieces;
}

/** 範囲選択: rough lines mostly inside `shape`, dialogue whose box centre is, and panels, fills and はみ出し wholly inside (not halves of 見開き panels). */
export function pickInside(page: Page, shape: readonly Point[]): { strokes: string[]; lines: string[]; panels: string[]; fills: string[]; breakouts: string[] } {
  if (shape.length < 3) return { strokes: [], lines: [], panels: [], fills: [], breakouts: [] };
  // Panels, fills and はみ出し only when all of them is inside.
  const whole = (points: readonly Point[]) => points.length > 0 && points.every((point) => insidePolygon(shape, point));
  const strokes = page.strokes
    .filter((stroke) => {
      const inside = stroke.points.filter(([x, y]) => insidePolygon(shape, [x, y])).length;
      return inside > 0 && inside >= stroke.points.length / 2;
    })
    .map((stroke) => stroke.id);
  const lines = page.lines
    .filter(({ box: [x0, y0, x1, y1] }) => insidePolygon(shape, [(x0 + x1) / 2, (y0 + y1) / 2]))
    .map((line) => line.id);
  return {
    strokes,
    lines,
    panels: page.panels.filter((panel) => !panel.spread && whole(panel.shape)).map((panel) => panel.id),
    fills: (page.fills ?? []).filter((fill) => whole(fill.shape)).map((fill) => fill.id),
    breakouts: page.breakouts.filter((breakout) => whole(breakout.shape)).map((breakout) => breakout.id),
  };
}

/** A line split where it crosses `x` (the gutter of a spread): runs in order,
 * each marked with the side it is on (`beyond`: x greater than the gutter)
 * and a crossing point shared by neighbouring runs. */
export function splitAtX(points: StrokePoint[], x: number): { points: StrokePoint[]; beyond: boolean }[] {
  const runs: { points: StrokePoint[]; beyond: boolean }[] = [];
  for (const point of points) {
    const beyond = point[0] > x;
    const run = runs[runs.length - 1];
    if (!run) {
      runs.push({ points: [point], beyond });
      continue;
    }
    if (run.beyond === beyond) {
      run.points.push(point);
      continue;
    }
    const last = run.points[run.points.length - 1];
    const t = (x - last[0]) / (point[0] - last[0]);
    const crossing = lerpPoint(last, point, Number.isFinite(t) ? t : 0);
    crossing[0] = x;
    run.points.push(crossing);
    runs.push({ points: [crossing.slice() as StrokePoint, point], beyond });
  }
  return runs.filter((run) => run.points.length >= 2);
}

/**
 * A line drawn over several pages (連続 shows them all on one canvas): its
 * runs, each on the page `pageOf` says its points are over. A point off every
 * page stays with the run before it. Across a gutter (`gutter` gives its x)
 * the two runs end exactly there; between pages apart, each run takes the
 * next point too, so the line reaches each page's edge, where the page cuts it.
 */
export function splitOverPages<K>(
  points: StrokePoint[],
  first: K,
  pageOf: (point: StrokePoint) => K | null,
  gutter: (from: K, to: K) => number | null,
): { page: K; points: StrokePoint[] }[] {
  const runs: { page: K; points: StrokePoint[] }[] = [];
  for (const point of points) {
    const run = runs[runs.length - 1];
    const page = pageOf(point) ?? run?.page ?? first;
    if (!run) {
      runs.push({ page, points: [point] });
      continue;
    }
    if (run.page === page) {
      run.points.push(point);
      continue;
    }
    const last = run.points[run.points.length - 1];
    const x = gutter(run.page, page);
    if (x === null) {
      run.points.push(point);
      runs.push({ page, points: [last.slice() as StrokePoint, point] });
      continue;
    }
    const t = (x - last[0]) / (point[0] - last[0]);
    const crossing = lerpPoint(last, point, Number.isFinite(t) ? t : 0);
    crossing[0] = x;
    run.points.push(crossing);
    runs.push({ page, points: [crossing.slice() as StrokePoint, point] });
  }
  return runs.filter((run) => run.points.length >= 2);
}

/** Whether page `index` and the next one should go to CSP as one 見開き page. */
export function wantsSpread(project: Project, index: number): boolean {
  // 縦スクロール: no spreads; each piece is a page of its own.
  if (project.scroll) return false;
  const page = project.pages[index];
  const next = project.pages[index + 1];
  if (!page || !next) return false;
  if (page.joinNext) return true;
  // A panel across the gutter can only be one panel on a spread page.
  const shared = new Set(next.panels.map((panel) => panel.spread).filter(Boolean));
  return page.panels.some((panel) => panel.spread && shared.has(panel.spread));
}

// --- コマに中身が付いてくる -------------------------------------------------------

/** The panel that owns a point: the topmost one there (insets over their panel). */
function ownerAt(page: Page, point: Point): Panel | undefined {
  let owner: Panel | undefined;
  for (const panel of page.panels) {
    if (!insidePolygon(panel.shape, point)) continue;
    if (!owner || (panel.z ?? 0) > (owner.z ?? 0)) owner = panel;
  }
  return owner;
}

/** What a panel carries along: dialogue whose box centre and rough lines most of whose points are in it. */
export function panelContents(page: Page, panel: Panel): { strokes: string[]; lines: string[] } {
  const owns = (point: Point) => ownerAt(page, point)?.id === panel.id;
  const strokes = page.strokes
    .filter((stroke) => {
      const inside = stroke.points.filter(([x, y]) => owns([x, y])).length;
      return inside > 0 && inside >= stroke.points.length / 2;
    })
    .map((stroke) => stroke.id);
  const lines = page.lines.filter((line) => owns(boxCenter(line.box))).map((line) => line.id);
  return { strokes, lines };
}

/** The contents of a panel as they were, to follow the panel as it changes. */
export interface CarriedContents {
  box: BoxMm;
  fills?: { id: string; shape: Point[] }[];
  strokes: { id: string; points: StrokePoint[] }[];
  lines: { id: string; box: BoxMm; balloon?: Point[]; tails?: Point[] }[];
}

export function carryContents(page: Page, panel: Panel): CarriedContents {
  const { strokes, lines } = panelContents(page, panel);
  const owned = (page.fills ?? []).filter((fill) => ownerAt(page, centroid(fill.shape))?.id === panel.id);
  return {
    box: bounds(panel.shape),
    ...(owned.length ? { fills: owned.map((fill) => ({ id: fill.id, shape: fill.shape.map((p) => [...p] as Point) })) } : {}),
    strokes: page.strokes.filter((s) => strokes.includes(s.id)).map((s) => ({ id: s.id, points: s.points.map((p) => [...p] as StrokePoint) })),
    lines: page.lines
      .filter((l) => lines.includes(l.id))
      .map((l) => ({
        id: l.id,
        box: [...l.box] as BoxMm,
        ...(l.balloon ? { balloon: l.balloon.map((p) => [...p] as Point) } : {}),
        ...(l.tails ? { tails: l.tails.map((t) => [...t.tip] as Point) } : {}),
      })),
  };
}

/**
 * Put the carried contents where the panel now is: positions follow the
 * panel's box (moved, and stretched when a corner is dragged). Rough lines
 * keep their proportions, scaled by the smaller stretch; dialogue keeps its
 * size and moves with its centre.
 */
export function followPanel(page: Page, panel: Panel, carried: CarriedContents): void {
  const [ox0, oy0, ox1, oy1] = carried.box;
  const [nx0, ny0, nx1, ny1] = bounds(panel.shape);
  const sx = ox1 > ox0 ? (nx1 - nx0) / (ox1 - ox0) : 1;
  const sy = oy1 > oy0 ? (ny1 - ny0) / (oy1 - oy0) : 1;
  const map = ([x, y]: readonly number[]): Point => [nx0 + (x - ox0) * sx, ny0 + (y - oy0) * sy];
  const uniform = Math.min(sx, sy);
  for (const { id, shape } of carried.fills ?? []) {
    const fill = page.fills?.find((f) => f.id === id);
    if (!fill) continue;
    const [cx0, cy0, cx1, cy1] = bounds(shape);
    const centre: Point = [(cx0 + cx1) / 2, (cy0 + cy1) / 2];
    const [mx, my] = map(centre);
    fill.shape = shape.map(([x, y]) => [mx + (x - centre[0]) * uniform, my + (y - centre[1]) * uniform]);
  }
  for (const { id, points } of carried.strokes) {
    const stroke = page.strokes.find((s) => s.id === id);
    if (!stroke) continue;
    const [cx0, cy0, cx1, cy1] = bounds(points.map(([x, y]) => [x, y] as Point));
    const centre: Point = [(cx0 + cx1) / 2, (cy0 + cy1) / 2];
    const [mx, my] = map(centre);
    stroke.points = points.map(([x, y, ...rest]) => [mx + (x - centre[0]) * uniform, my + (y - centre[1]) * uniform, ...rest] as StrokePoint);
  }
  for (const { id, box, balloon, tails } of carried.lines) {
    const line = page.lines.find((l) => l.id === id);
    if (!line) continue;
    const [mx, my] = map(boxCenter(box));
    const [cx, cy] = boxCenter(box);
    const [dx, dy] = [mx - cx, my - cy];
    line.box = [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
    if (balloon) line.balloon = balloon.map(([x, y]) => [x + dx, y + dy]);
    if (tails && line.tails) line.tails.forEach((tail, i) => tails[i] && (tail.tip = map(tails[i])));
  }
}

// --- 入れ替え（R14） -------------------------------------------------------------

/** The pages that move with page `index`: it and its 見開き partner, as first and last index. */
export function pageBlock(project: Project, index: number): [number, number] {
  let [first, last] = [index, index];
  if (wantsSpread(project, index)) last = index + 1;
  else if (index > 0 && wantsSpread(project, index - 1)) first = index - 1;
  return [first, last];
}

/**
 * Move pages `first`..`last` (inclusive) to before page `target` (an index
 * from before the move; `pages.length` is the end). A target between the two
 * pages of a 見開き moves to before the pair. Scenes keep the pages that stay;
 * moved pages join the scene they land in, unless their whole scene moved
 * with them. Returns whether anything moved.
 */
export function movePagesTo(project: Project, first: number, last: number, target: number): boolean {
  const pages = project.pages;
  if (first < 0 || last >= pages.length || first > last) return false;
  if (target > 0 && target < pages.length && wantsSpread(project, target - 1)) target--;
  if (target >= first && target <= last + 1) return false;
  const moved = new Set(pages.slice(first, last + 1).map((page) => page.id));
  const staying = new Map(
    project.scenes.map((scene) => {
      const [a, b] = [pageIndex(project, scene.firstPage), pageIndex(project, scene.lastPage)];
      return [scene, pages.slice(a, b + 1).filter((page) => !moved.has(page.id)).map((page) => page.id)];
    }),
  );
  const block = pages.splice(first, last - first + 1);
  pages.splice(target > last ? target - block.length : target, 0, ...block);
  for (const scene of project.scenes) {
    const members = staying.get(scene) ?? [];
    // A scene moved whole keeps its ends; others keep the pages that stayed.
    if (!members.length) continue;
    const at = members.map((id) => pageIndex(project, id));
    scene.firstPage = members[at.indexOf(Math.min(...at))];
    scene.lastPage = members[at.indexOf(Math.max(...at))];
  }
  sortScenes(project);
  return true;
}

/** Move a scene's pages (with any 見開き partners at its ends) to before page `target`. */
export function moveScene(project: Project, sceneId: string, target: number): boolean {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) return false;
  const first = pageBlock(project, pageIndex(project, scene.firstPage))[0];
  const last = pageBlock(project, pageIndex(project, scene.lastPage))[1];
  if (first < 0 || last < first) return false;
  return movePagesTo(project, first, last, target);
}

/**
 * コマの入れ替え: the dialogue, rough lines, fills and 演出メモ of two panels
 * change places (the panels stay), fitted to their new panel as when a panel
 * is reshaped.
 * The panels may be on different pages.
 */
export function swapPanelContents(pageA: Page, panelA: Panel, pageB: Page, panelB: Panel, binding: Binding = "right"): void {
  if (panelA === panelB) return;
  const carriedA = carryContents(pageA, panelA);
  const carriedB = carryContents(pageB, panelB);
  if (pageA !== pageB) {
    const take = (from: Page, to: Page, carried: CarriedContents) => {
      const strokes = new Set(carried.strokes.map((s) => s.id));
      const lines = new Set(carried.lines.map((l) => l.id));
      const fills = new Set((carried.fills ?? []).map((f) => f.id));
      to.strokes.push(...from.strokes.filter((s) => strokes.has(s.id)));
      to.lines.push(...from.lines.filter((l) => lines.has(l.id)));
      from.strokes = from.strokes.filter((s) => !strokes.has(s.id));
      from.lines = from.lines.filter((l) => !lines.has(l.id));
      if (fills.size) {
        (to.fills ??= []).push(...(from.fills ?? []).filter((f) => fills.has(f.id)));
        from.fills = (from.fills ?? []).filter((f) => !fills.has(f.id));
        if (!from.fills.length) delete from.fills;
      }
    };
    take(pageA, pageB, carriedA);
    take(pageB, pageA, carriedB);
  }
  followPanel(pageB, panelB, carriedA);
  followPanel(pageA, panelA, carriedB);
  // The 演出メモ is about what is in the panel, so it goes along.
  const [noteA, noteB] = [panelA.note, panelB.note];
  if (noteB) panelA.note = noteB;
  else delete panelA.note;
  if (noteA) panelB.note = noteA;
  else delete panelB.note;
  for (const page of new Set([pageA, pageB])) {
    assignPanels(page);
    sortLines(page, binding);
  }
}

/** How many pages at the end have nothing on them (no panels, lines, strokes, roughs, fills or memo). */
export function trailingEmptyPages(project: Project): number {
  let count = 0;
  for (let i = project.pages.length - 1; i >= 0; i--) {
    const page = project.pages[i];
    const filled = page.panels.length + page.lines.length + page.strokes.length + page.roughs.length + (page.fills?.length ?? 0) + (page.references?.length ?? 0) > 0 || page.memo.trim() !== "";
    if (filled) break;
    count++;
  }
  return count;
}

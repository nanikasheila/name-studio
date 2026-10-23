// セリフの並べ直し: the dialogue of a panel laid out again in reading order,
// right to left from the top right, wrapping down; long lines broken into
// short ones first, as narrow as it takes to fit the panel's height, and
// clear of the faces drawn in the rough.
import { figures } from "./autotail";
import { balloonExtent } from "./balloon";
import {
  assignPanels,
  basicBox,
  bounds,
  boxCenter,
  centroid,
  fitLine,
  insidePolygon,
  moveLine,
  sortLines,
  type BoxMm,
  type Line,
  type Page,
  type Panel,
  type Point,
  type Project,
} from "./project";
import { wrapDialogue } from "./wrap";

const MARGIN = 3;
const GAP = 2;
/** Characters per line tried, widest first. */
const WIDTHS = [8, 7, 6, 5, 4, 3];

/** Where dialogue may go in a panel: its box, kept inside the basic frame (a 裁ち切り panel reaches past it). */
export function placingBox(project: Project, panel: Panel | undefined): BoxMm {
  const frame = basicBox(project.pageFormat);
  if (!panel) return frame;
  const [x0, y0, x1, y1] = bounds(panel.shape);
  const inside: BoxMm = [Math.max(x0, frame[0]), Math.max(y0, frame[1]), Math.min(x1, frame[2]), Math.min(y1, frame[3])];
  // A panel wholly outside the frame (in the bleed) keeps its own box.
  return inside[2] - inside[0] > 10 && inside[3] - inside[1] > 10 ? inside : [x0, y0, x1, y1];
}

/** How much smaller (pt) text may get to fit a short panel. */
const SMALLER_PT = 2;

/**
 * Break a long line that has no breaks of its own, narrower until its
 * balloon fits `height`; when even the narrowest does not, a little smaller
 * text, and failing that the shortest it can be.
 */
export function wrapToFit(line: Line, height: number): void {
  if (line.kind === "sfx" || line.text.includes("\n")) return;
  const original = line.text;
  const size = line.fontSizePt;
  let best: { text: string; pt: number; height: number } | null = null;
  for (let pt = size; pt >= size - SMALLER_PT; pt--) {
    line.fontSizePt = pt;
    for (const width of WIDTHS) {
      line.text = wrapDialogue(original, width);
      fitLine(line);
      const [, y0, , y1] = balloonExtent(line);
      if (y1 - y0 <= height) return;
      if (!best || y1 - y0 < best.height - 0.5) best = { text: line.text, pt, height: y1 - y0 };
    }
  }
  if (!best) return;
  line.text = best.text;
  line.fontSizePt = best.pt;
  fitLine(line);
}

/**
 * Lay `lines` out over `box` in reading order: right to left, a new row below
 * when one is full; a full panel piles them at its bottom, still inside.
 * With `shape`, a line whose centre would fall outside it is pulled in, so
 * that it stays in its panel.
 */
export function layOut(lines: readonly Line[], box: BoxMm, shape?: readonly Point[], wrap = true, avoid: readonly BoxMm[] = []): void {
  const height = box[3] - box[1] - 2 * MARGIN;
  let right = box[2] - MARGIN;
  let top = box[1] + MARGIN;
  let rowHeight = 0;
  for (const line of lines) {
    if (wrap) wrapToFit(line, height);
    // Room for the balloon around the text, not just the text.
    const [lx0, ly0, lx1, ly1] = balloonExtent(line);
    const [w, h] = [lx1 - lx0, ly1 - ly0];
    if (right - w < box[0] + MARGIN && rowHeight > 0) {
      right = box[2] - MARGIN;
      top += rowHeight + GAP;
      rowHeight = 0;
    }
    let y = Math.max(box[1], Math.min(top, box[3] - MARGIN - h));
    if (avoid.length) [right, y] = clearOf(avoid, box, right, y, w, h);
    moveLine(line, right - w - lx0, y - ly0);
    right -= w + GAP;
    rowHeight = Math.max(rowHeight, y + h - top);
    if (shape) pullInside(line, shape);
  }
}

/**
 * Where a w×h balloon whose top right is (right, y) best keeps off the faces:
 * moved left past a face or down below it, as little as it takes, or where it
 * covers the least of them when there is no room to keep clear.
 */
function clearOf(avoid: readonly BoxMm[], box: BoxMm, right: number, y: number, w: number, h: number): [number, number] {
  const covered = (r: number, top: number) =>
    avoid.reduce((sum, [x0, y0, x1, y1]) => sum + Math.max(0, Math.min(r, x1) - Math.max(r - w, x0)) * Math.max(0, Math.min(top + h, y1) - Math.max(top, y0)), 0);
  const [minRight, maxY] = [Math.min(right, box[0] + MARGIN + w), Math.max(y, box[3] - MARGIN - h)];
  const rights = [right, ...avoid.map((b) => Math.max(minRight, Math.min(right, b[0] - GAP)))];
  const tops = [y, ...avoid.map((b) => Math.min(maxY, Math.max(y, b[3] + GAP)))];
  let best: [number, number] = [right, y];
  let cost = covered(right, y) * 10;
  if (!cost) return best;
  for (const r of rights) {
    for (const top of tops) {
      const c = covered(r, top) * 10 + (right - r) + (top - y);
      if (c < cost) [best, cost] = [[r, top], c];
    }
  }
  return best;
}

/** The faces in a panel's rough: the top of each figure, where a balloon should not go. */
export function faces(page: Page, panel: Panel): BoxMm[] {
  return figures(page, panel).map(([x0, y0, x1, y1]) => {
    const size = Math.min(12, (y1 - y0) * 0.15) + 2;
    const cx = (x0 + x1) / 2;
    return [Math.max(x0, cx - size), y0, Math.min(x1, cx + size), y0 + 2 * size] as BoxMm;
  });
}

/** Move `line` towards the middle of `shape` until its centre is inside it. */
function pullInside(line: Line, shape: readonly Point[]): void {
  const target = centroid(shape);
  for (let step = 0; step < 20 && !insidePolygon(shape, boxCenter(line.box)); step++) {
    const [cx, cy] = boxCenter(line.box);
    moveLine(line, (target[0] - cx) * 0.2, (target[1] - cy) * 0.2);
  }
}

/** How far (mm) a balloon may reach over its panel's border before it counts. */
const SPILL_MM = 2;

/** Whether a balloon (its box) reaches past a panel's border by more than a touch. */
export function spills(box: BoxMm, shape: readonly Point[]): boolean {
  const [x0, y0, x1, y1] = box;
  const inset = (x: number, y: number): Point => [x + Math.sign((x0 + x1) / 2 - x) * SPILL_MM, y + Math.sign((y0 + y1) / 2 - y) * SPILL_MM];
  return [inset(x0, y0), inset(x1, y0), inset(x1, y1), inset(x0, y1)].some((corner) => !insidePolygon(shape, corner));
}

/**
 * はみ出しを直す: in every panel where dialogue reaches past the border, that
 * dialogue is broken again (narrower, its line breaks redone) and the
 * panel's dialogue laid out again. Returns how many panels were redone.
 */
export function fitSpills(project: Project): number {
  let redone = 0;
  for (const page of project.pages) {
    for (const panel of page.panels) {
      const spilled = page.lines.filter((line) => line.panel === panel.id && line.kind !== "sfx" && spills(balloonExtent(line), panel.shape));
      if (!spilled.length) continue;
      for (const line of spilled) line.text = line.text.replace(/\n/g, "");
      arrangePanel(project, page, panel);
      redone++;
    }
  }
  return redone;
}

/** このコマのセリフを並べ直す: the panel's dialogue in its reading order. Returns how many lines moved. */
export function arrangePanel(project: Project, page: Page, panel: Panel): number {
  sortLines(page);
  const lines = page.lines.filter((line) => line.panel === panel.id);
  if (!lines.length) return 0;
  layOut(lines, placingBox(project, panel), panel.shape, true, faces(page, panel));
  assignPanels(page);
  sortLines(page);
  return lines.length;
}

/** このページのセリフを並べ直す: every panel's. Returns how many lines moved. */
export function arrangePage(project: Project, page: Page): number {
  assignPanels(page);
  return [...page.panels].sort((a, b) => a.order - b.order).reduce((sum, panel) => sum + arrangePanel(project, page, panel), 0);
}

// セリフの並べ直し: the dialogue of a panel laid out again in reading order,
// right to left from the top right, wrapping down; long lines broken into
// short ones first, as narrow as it takes to fit the panel's height.
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
const WIDTHS = [8, 7, 6, 5];

/** Where dialogue may go in a panel: its box, kept inside the basic frame (a 裁ち切り panel reaches past it). */
export function placingBox(project: Project, panel: Panel | undefined): BoxMm {
  const frame = basicBox(project.pageFormat);
  if (!panel) return frame;
  const [x0, y0, x1, y1] = bounds(panel.shape);
  const inside: BoxMm = [Math.max(x0, frame[0]), Math.max(y0, frame[1]), Math.min(x1, frame[2]), Math.min(y1, frame[3])];
  // A panel wholly outside the frame (in the bleed) keeps its own box.
  return inside[2] - inside[0] > 10 && inside[3] - inside[1] > 10 ? inside : [x0, y0, x1, y1];
}

/** Break a long line that has no breaks of its own, narrower until its balloon fits `height`. */
export function wrapToFit(line: Line, height: number): void {
  if (line.kind === "sfx" || line.text.includes("\n")) return;
  const original = line.text;
  for (const width of WIDTHS) {
    line.text = wrapDialogue(original, width);
    fitLine(line);
    const [, y0, , y1] = balloonExtent(line);
    if (y1 - y0 <= height) return;
  }
}

/**
 * Lay `lines` out over `box` in reading order: right to left, a new row below
 * when one is full; a full panel piles them at its bottom, still inside.
 * With `shape`, a line whose centre would fall outside it is pulled in, so
 * that it stays in its panel.
 */
export function layOut(lines: readonly Line[], box: BoxMm, shape?: readonly Point[], wrap = true): void {
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
    const y = Math.max(box[1], Math.min(top, box[3] - MARGIN - h));
    moveLine(line, right - w - lx0, y - ly0);
    right -= w + GAP;
    rowHeight = Math.max(rowHeight, h);
    if (shape) pullInside(line, shape);
  }
}

/** Move `line` towards the middle of `shape` until its centre is inside it. */
function pullInside(line: Line, shape: readonly Point[]): void {
  const target = centroid(shape);
  for (let step = 0; step < 20 && !insidePolygon(shape, boxCenter(line.box)); step++) {
    const [cx, cy] = boxCenter(line.box);
    moveLine(line, (target[0] - cx) * 0.2, (target[1] - cy) * 0.2);
  }
}

/** このコマのセリフを並べ直す: the panel's dialogue in its reading order. Returns how many lines moved. */
export function arrangePanel(project: Project, page: Page, panel: Panel): number {
  sortLines(page);
  const lines = page.lines.filter((line) => line.panel === panel.id);
  if (!lines.length) return 0;
  layOut(lines, placingBox(project, panel), panel.shape);
  assignPanels(page);
  sortLines(page);
  return lines.length;
}

/** このページのセリフを並べ直す: every panel's. Returns how many lines moved. */
export function arrangePage(project: Project, page: Page): number {
  assignPanels(page);
  return [...page.panels].sort((a, b) => a.order - b.order).reduce((sum, panel) => sum + arrangePanel(project, page, panel), 0);
}

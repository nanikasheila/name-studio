// セリフの並べ直し: the dialogue of a panel laid out again in reading order,
// right to left from the top right, wrapping down; long lines broken into
// short ones first, as narrow as it takes to fit the panel's height, and
// clear of the faces drawn in the rough. A left-bound book reads from the
// top left: the same layouts run on the page seen in a mirror.
import { figures } from "./autotail";
import { balloonExtent, resolvedShape, storedOutline } from "./balloon";
import {
  assignPanels,
  basicBox,
  bounds,
  boxCenter,
  centroid,
  fitLine,
  insidePolygon,
  mostlyHalfWidth,
  moveLine,
  sortLines,
  type Binding,
  type BoxMm,
  type Line,
  type Page,
  type Panel,
  type Point,
  type Project,
} from "./project";
import { wrapDialogue } from "./wrap";

/** A page seen in a mirror (x → -x) or as it is: what is not mirrored in place goes through it. */
export interface ReadingFlip {
  box(box: BoxMm): BoxMm;
  shape(shape: readonly Point[]): Point[];
}

const AS_IT_IS: ReadingFlip = { box: (box) => box, shape: (shape) => [...shape] };
const MIRROR: ReadingFlip = {
  box: ([x0, y0, x1, y1]) => [-x1, y0, -x0, y1],
  shape: (shape) => shape.map(([x, y]): Point => [-x, y]),
};

function mirrorLine(line: Line): void {
  line.box = MIRROR.box(line.box);
  if (line.balloon) line.balloon = MIRROR.shape(line.balloon);
  if (line.tails) line.tails = line.tails.map((tail) => ({ ...tail, tip: [-tail.tip[0], tail.tip[1]], ...(tail.bend !== undefined ? { bend: -tail.bend } : {}) }));
}

/**
 * Run `lay` (a layout that reads right to left from the top right) for a
 * book bound on `binding`: as it is for a manga, and for a left-bound book
 * with `lines` mirrored (x → -x) so that it reads from the top left. What
 * `lay` takes besides the lines (boxes, outlines, faces worked out before)
 * goes through the flip it is given. The lines are mirrored back after and
 * their balloons drawn again the right way round.
 */
export function inReadingDirection<T>(binding: Binding, lines: readonly Line[], lay: (flip: ReadingFlip) => T): T {
  if (binding === "right") return lay(AS_IT_IS);
  for (const line of lines) mirrorLine(line);
  try {
    return lay(MIRROR);
  } finally {
    for (const line of lines) {
      mirrorLine(line);
      if (resolvedShape(line) === "custom") continue;
      const outline = storedOutline(line);
      if (outline) line.balloon = outline;
      else delete line.balloon;
    }
  }
}

const MARGIN = 3;
const GAP = 2;
/** Characters per line tried, widest first. */
const WIDTHS = [8, 7, 6, 5, 4, 3];
/** Across, the lines are longer, and wider ones make a lower balloon (Latin letters are narrow). */
const ACROSS_WIDTHS = [12, 14, 16, 10, 8];
const LATIN_WIDTHS = [20, 24, 28, 16, 12];

/** The line lengths (characters) to try for `line`, the usual first. */
function widthsFor(line: Line, text: string): number[] {
  if (line.vertical) return WIDTHS;
  return mostlyHalfWidth(text) ? LATIN_WIDTHS : ACROSS_WIDTHS;
}

/** A line's text without the breaks the app put in (words written in Latin letters keep their spaces). */
function unbroken(text: string): string {
  return text.replace(/\n/g, mostlyHalfWidth(text) ? " " : "");
}

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
    for (const width of widthsFor(line, original)) {
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
    let [ex0, ey0, width] = [lx0, ly0, w];
    if (avoid.length) {
      let place = clearOf(avoid, box, right, y, w, h);
      // Still over a face: broken another way (taller and narrower, or the
      // other way round) it may fit beside or above it.
      if (place.covered >= 1 && wrap) {
        let text = line.text;
        for (const other of rewraps(line, height)) {
          line.text = other;
          fitLine(line);
          const [cx0, cy0, cx1, cy1] = balloonExtent(line);
          const top = Math.max(box[1], Math.min(y, box[3] - MARGIN - (cy1 - cy0)));
          const tried = clearOf(avoid, box, right, top, cx1 - cx0, cy1 - cy0);
          if (tried.cost < place.cost - 1) [place, text] = [tried, other];
        }
        line.text = text;
        fitLine(line);
        const extent = balloonExtent(line);
        [ex0, ey0, width] = [extent[0], extent[1], extent[2] - extent[0]];
      }
      [right, y] = [place.right, place.top];
    }
    moveLine(line, right - width - ex0, y - ey0);
    // A slanted or odd-shaped panel may be too narrow where the row starts: further along, inside.
    if (shape) slideInside(line, shape, box, avoid);
    const placed = balloonExtent(line);
    right = placed[0] - GAP;
    rowHeight = Math.max(rowHeight, placed[3] - top);
    if (shape) pullInside(line, shape);
  }
}

/**
 * Where a w×h balloon whose top right is (right, y) best keeps off the faces:
 * moved left past a face or down below it, as little as it takes, or where it
 * covers the least of them when there is no room to keep clear.
 */
function clearOf(avoid: readonly BoxMm[], box: BoxMm, right: number, y: number, w: number, h: number): { right: number; top: number; covered: number; cost: number } {
  const covered = (r: number, top: number) =>
    avoid.reduce((sum, [x0, y0, x1, y1]) => sum + Math.max(0, Math.min(r, x1) - Math.max(r - w, x0)) * Math.max(0, Math.min(top + h, y1) - Math.max(top, y0)), 0);
  const [minRight, maxY] = [Math.min(right, box[0] + MARGIN + w), Math.max(y, box[3] - MARGIN - h)];
  const rights = [right, ...avoid.map((b) => Math.max(minRight, Math.min(right, b[0] - GAP)))];
  const tops = [y, ...avoid.map((b) => Math.min(maxY, Math.max(y, b[3] + GAP)))];
  let best = { right, top: y, covered: covered(right, y), cost: covered(right, y) * COVER_COST };
  if (!best.cost) return best;
  for (const r of rights) {
    for (const top of tops) {
      const area = covered(r, top);
      const cost = area * COVER_COST + (right - r) + (top - y);
      if (cost < best.cost) best = { right: r, top, covered: area, cost };
    }
  }
  return best;
}

/** What one mm² over a face costs against one mm moved. */
const COVER_COST = 10;

/**
 * Other ways to break a line the app broke itself (a line broken by hand is
 * kept as it is), that fit `height`.
 */
function rewraps(line: Line, height: number): string[] {
  if (line.kind === "sfx") return [];
  const joined = unbroken(line.text);
  const own = [...widthsFor(line, joined), ...(line.vertical ? [9, 10, 12] : [])].map((width) => wrapDialogue(joined, width));
  if (line.text.includes("\n") && !own.includes(line.text)) return [];
  const original = line.text;
  const fits = [...new Set(own)].filter((text) => {
    if (text === original) return false;
    line.text = text;
    fitLine(line);
    const [, y0, , y1] = balloonExtent(line);
    return y1 - y0 <= height;
  });
  line.text = original;
  fitLine(line);
  return fits;
}

/**
 * When `line`'s balloon reaches past the panel's border (a slanted panel
 * narrows towards one end), move it along the row and up or down, as little
 * as it takes, to where it is inside, no more over a face than it was.
 */
function slideInside(line: Line, shape: readonly Point[], box: BoxMm, avoid: readonly BoxMm[]): void {
  const extent = balloonExtent(line);
  if (!spills(extent, shape)) return;
  const [x0, y0, x1, y1] = extent;
  const covered = (dx: number, dy: number) =>
    avoid.reduce((sum, [ax0, ay0, ax1, ay1]) => sum + Math.max(0, Math.min(x1 + dx, ax1) - Math.max(x0 + dx, ax0)) * Math.max(0, Math.min(y1 + dy, ay1) - Math.max(y0 + dy, ay0)), 0);
  const now = covered(0, 0);
  let best: { dx: number; dy: number; cost: number } | null = null;
  for (let dx = 0; x0 - dx >= box[0] - SPILL_MM; dx += 1) {
    if (best && dx >= best.cost) break;
    for (let dy = -10; dy <= 10; dy += 1) {
      const cost = dx + Math.abs(dy);
      if (best && cost >= best.cost) continue;
      if (spills([x0 - dx, y0 + dy, x1 - dx, y1 + dy], shape) || covered(-dx, dy) > now) continue;
      best = { dx, dy, cost };
    }
  }
  if (best) moveLine(line, -best.dx, best.dy);
}

/** Move `line` as little as it takes off `avoid` (faces, other balloons), inside `box`. */
export function moveClear(line: Line, box: BoxMm, avoid: readonly BoxMm[]): void {
  const [x0, y0, x1, y1] = balloonExtent(line);
  const { right, top } = clearOf(avoid, box, x1, y0, x1 - x0, y1 - y0);
  moveLine(line, right - x1, top - y0);
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

/** How much of a face (mm²) a balloon may cover before it counts: about a corner of it. */
const FACE_MM2 = 8;

/** Whether `line`'s balloon covers a face in its panel's rough (sound effects may). */
export function onFace(page: Page, line: Line): boolean {
  const panel = page.panels.find((p) => p.id === line.panel);
  if (!panel || line.kind === "sfx") return false;
  const [x0, y0, x1, y1] = balloonExtent(line);
  return faces(page, panel).some((face) => Math.max(0, Math.min(x1, face[2]) - Math.max(x0, face[0])) * Math.max(0, Math.min(y1, face[3]) - Math.max(y0, face[1])) > FACE_MM2);
}

/**
 * 顔からずらす: each balloon on a face moved off it, as little as it takes
 * (clear of the panel's other balloons); where that is not enough, the
 * panel's dialogue laid out again. Returns how many lines were on a face.
 */
export function clearFaces(project: Project): number {
  let found = 0;
  for (const page of project.pages) {
    for (const panel of page.panels) {
      const covering = page.lines.filter((line) => line.panel === panel.id && onFace(page, line));
      if (!covering.length) continue;
      found += covering.length;
      const box = placingBox(project, panel);
      for (const line of covering) {
        const avoid = [...faces(page, panel), ...page.lines.filter((other) => other !== line && other.panel === panel.id).map(balloonExtent)];
        inReadingDirection(project.binding, [line], (flip) => moveClear(line, flip.box(box), avoid.map(flip.box)));
      }
      if (covering.some((line) => onFace(page, line))) arrangePanel(project, page, panel);
    }
  }
  return found;
}

/** このコマのセリフを並べ直す: the panel's dialogue in its reading order. Returns how many lines moved. */
export function arrangePanel(project: Project, page: Page, panel: Panel): number {
  sortLines(page, project.binding);
  const lines = page.lines.filter((line) => line.panel === panel.id);
  if (!lines.length) return 0;
  const [box, avoid] = [placingBox(project, panel), faces(page, panel)];
  inReadingDirection(project.binding, lines, (flip) => layOut(lines, flip.box(box), flip.shape(panel.shape), true, avoid.map(flip.box)));
  assignPanels(page);
  sortLines(page, project.binding);
  return lines.length;
}

/** このページのセリフを並べ直す: every panel's. Returns how many lines moved. */
export function arrangePage(project: Project, page: Page): number {
  assignPanels(page);
  return [...page.panels].sort((a, b) => a.order - b.order).reduce((sum, panel) => sum + arrangePanel(project, page, panel), 0);
}

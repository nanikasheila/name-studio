// ネーム画像の取り込み: a picture holding many pages of a name (a ミニネーム,
// a name sheet written out from CSP, thumbnails drawn on paper and scanned)
// cut into its pages, in reading order. A page is found as a shape that
// stands out from the paper around it (its frame, or a white page on a grey
// ground); pages that touch are told apart by the lines between them and by
// the shape a page has. A frame drawn inside every page (the 基本枠 of a
// name sheet) is found too, to lay the pages by it.
//
// Computation only: the picture comes small and grey (`Gray`); reading it
// and cutting the pages out of the full picture is imageimport.ts's.
import type { BoxMm, PageFormat } from "./model";
import { basicBox, trimBox } from "./pagebox";

/** A picture as luminance (0 black – 255 white), one byte a pixel. */
export interface Gray {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** `[x0, y0, x1, y1]` in px of the picture looked at (x1, y1 past the last pixel). */
export type PxBox = [number, number, number, number];

/** Where a page's own frame lies in it, as fractions of its width and height. */
export type InnerFrame = [number, number, number, number];

export type ReadingOrder = "rtl" | "ltr" | "blocks-rtl" | "blocks-ltr";

export interface FoundPages {
  /** The pages found, in no order (see `orderCells`). */
  cells: PxBox[];
  /** The frame every page has inside (most of them), when there is one. */
  inner: InnerFrame | null;
  /** What the picture's ground (paper) is, and how far from it counts as drawn. */
  paper: number;
  tolerance: number;
}

/** The grey RGBA pixels become (Rec. 601 luma). */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    // Clear pixels are paper.
    const a = rgba[p + 3] / 255;
    const luma = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    data[i] = Math.round(luma * a + 255 * (1 - a));
  }
  return { width, height, data };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The paper: the usual grey along the picture's edges, and how much it varies (a scan's grain). */
export function paperOf(gray: Gray): { paper: number; tolerance: number } {
  const { width, height, data } = gray;
  const samples: number[] = [];
  const step = Math.max(1, Math.floor((width + height) / 2000));
  for (let x = 0; x < width; x += step) samples.push(data[x], data[(height - 1) * width + x]);
  for (let y = 0; y < height; y += step) samples.push(data[y * width], data[y * width + width - 1]);
  const paper = median(samples);
  const spread = median(samples.map((value) => Math.abs(value - paper))) * 1.4826;
  return { paper, tolerance: Math.max(18, Math.min(70, 4 * spread)) };
}

/** 1 where the picture differs from the paper (lines, drawing, a page on a darker ground). */
function inkOf(gray: Gray, paper: number, tolerance: number): Uint8Array {
  const ink = new Uint8Array(gray.data.length);
  for (let i = 0; i < ink.length; i++) ink[i] = Math.abs(gray.data[i] - paper) > tolerance ? 1 : 0;
  return ink;
}

/** `mask` grown by `r` px each way (a square), closing small breaks in the lines. */
function grow(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const across = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    // Two sweeps: the nearest ink to the left and to the right of each pixel.
    let left = -Infinity;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) left = x;
      if (x - left <= r) across[row + x] = 1;
    }
    let right = Infinity;
    for (let x = width - 1; x >= 0; x--) {
      if (mask[row + x]) right = x;
      if (right - x <= r) across[row + x] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) {
    let up = -Infinity;
    for (let y = 0; y < height; y++) {
      if (across[y * width + x]) up = y;
      if (y - up <= r) out[y * width + x] = 1;
    }
    let down = Infinity;
    for (let y = height - 1; y >= 0; y--) {
      if (across[y * width + x]) down = y;
      if (down - y <= r) out[y * width + x] = 1;
    }
  }
  return out;
}

/** 1 for the paper reached from the picture's edges without crossing a (grown) line. */
function groundOf(wall: Uint8Array, width: number, height: number): Uint8Array {
  const ground = new Uint8Array(wall.length);
  const queue = new Int32Array(wall.length);
  let head = 0;
  let tail = 0;
  const seed = (i: number) => {
    if (!wall[i] && !ground[i]) {
      ground[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) seed(i - 1);
    if (x < width - 1) seed(i + 1);
    if (i >= width) seed(i - width);
    if (i < wall.length - width) seed(i + width);
  }
  return ground;
}

/** The boxes of the shapes standing out from the ground (4-connected), with how many pixels each has. */
function shapesOf(ground: Uint8Array, width: number, height: number): { box: PxBox; pixels: number }[] {
  const seen = new Uint8Array(ground.length);
  const queue = new Int32Array(ground.length);
  const shapes: { box: PxBox; pixels: number }[] = [];
  for (let start = 0; start < ground.length; start++) {
    if (ground[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let [x0, y0, x1, y1] = [width, height, 0, 0];
    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      const y = (i - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const visit = (j: number) => {
        if (!ground[j] && !seen[j]) {
          seen[j] = 1;
          queue[tail++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (y > 0) visit(i - width);
      if (y < height - 1) visit(i + width);
    }
    shapes.push({ box: [x0, y0, x1 + 1, y1 + 1], pixels: tail });
  }
  return shapes;
}

interface LineRun {
  /** Middle of the line (px). */
  at: number;
  /** How much of the span it covers (0–1), at its strongest. */
  cover: number;
}

/** What is drawn in a box of the picture: what differs from the box's own usual grey (a white page on a grey ground has its lines, not itself). */
interface Plane {
  ink: Uint8Array;
  box: PxBox;
}

function planeOf(gray: Gray, box: PxBox, tolerance: number): Plane {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const samples: number[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * (y1 - y0)) / 4000)));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) samples.push(gray.data[y * gray.width + x]);
  const own = median(samples);
  const ink = new Uint8Array(w * (y1 - y0));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) ink[(y - y0) * w + x - x0] = Math.abs(gray.data[y * gray.width + x] - own) > tolerance ? 1 : 0;
  return { ink, box };
}

/**
 * Lines across a plane (vertical: running top to bottom, at each x; else
 * horizontal), as runs of a few neighbouring rows of pixels that cover at
 * least `least` of the span between `from` and `to` (fractions of it).
 * Wide runs are areas drawn, not lines.
 */
function linesIn(plane: Plane, vertical: boolean, least: number, from = 0, to = 1, region: PxBox = plane.box): LineRun[] {
  const [x0, y0, x1, y1] = region;
  const stride = plane.box[2] - plane.box[0];
  const [ox, oy] = [x0 - plane.box[0], y0 - plane.box[1]];
  const w = x1 - x0;
  const [span, across] = vertical ? [y1 - y0, w] : [w, y1 - y0];
  const b0 = Math.round(span * from);
  const b1 = Math.max(b0 + 1, Math.round(span * to));
  const covers: number[] = [];
  for (let a = 0; a < across; a++) {
    let count = 0;
    for (let b = b0; b < b1; b++) count += vertical ? plane.ink[(oy + b) * stride + ox + a] : plane.ink[(oy + a) * stride + ox + b];
    covers.push(count / (b1 - b0));
  }
  const widest = Math.max(4, across * 0.04);
  const start0 = vertical ? x0 : y0;
  // How much of the span a run of neighbouring rows covers between them (a line a little tilted, or between two rows of pixels, is drawn in both).
  const covered = (first: number, last: number) => {
    let count = 0;
    for (let b = b0; b < b1; b++) {
      for (let a = first; a < last; a++) {
        if (vertical ? plane.ink[(oy + b) * stride + ox + a] : plane.ink[(oy + a) * stride + ox + b]) {
          count++;
          break;
        }
      }
    }
    return count / (b1 - b0);
  };
  const runs: LineRun[] = [];
  let start = -1;
  for (let k = 0; k <= covers.length; k++) {
    const on = k < covers.length && covers[k] >= least / 2;
    if (on && start < 0) start = k;
    if (!on && start >= 0) {
      if (k - start <= widest) {
        const cover = covered(start, k);
        let weight = 0;
        let sum = 0;
        for (let j = start; j < k; j++) {
          weight += covers[j];
          sum += covers[j] * (j + 0.5);
        }
        if (cover >= least) runs.push({ at: start0 + sum / weight, cover });
      }
      start = -1;
    }
  }
  return runs;
}

/** Fractions of a span near its ends where a line is the shape's own edge, not one between pages. */
const EDGE = 0.04;
/** Lines between pages cover this much of the span; one this strong must be explained (a page edge). */
const SPLIT_LINE = 0.6;
const STRONG_LINE = 0.92;

/**
 * A shape cut into `columns` x `rows` pages, best fitting the lines in it and
 * the page's shape (`aspect`: width / height); the cuts lie on the lines.
 */
function splitShape(gray: Gray, box: PxBox, aspect: number, tolerance: number): PxBox[] {
  const [x0, y0, x1, y1] = box;
  const plane = planeOf(gray, box, tolerance);
  const w = x1 - x0;
  const h = y1 - y0;
  const inside = (runs: LineRun[], span: number, start: number) => runs.filter((run) => run.at - start > span * EDGE && start + span - run.at > span * EDGE);
  const vertical = inside(linesIn(plane, true, SPLIT_LINE), w, x0);
  const horizontal = inside(linesIn(plane, false, SPLIT_LINE), h, y0);
  // Cuts for n pieces of a span: on the nearest line when there is one; how many had none; how many strong lines were left over.
  const cuts = (runs: LineRun[], n: number, start: number, span: number) => {
    const at: number[] = [start];
    let missing = 0;
    const used = new Set<LineRun>();
    for (let k = 1; k < n; k++) {
      const expected = start + (span * k) / n;
      const reach = Math.max(2, (span / n) * 0.12);
      const near = runs.filter((run) => Math.abs(run.at - expected) <= reach).sort((a, b) => Math.abs(a.at - expected) - Math.abs(b.at - expected))[0];
      if (near) used.add(near);
      else missing++;
      at.push(near ? near.at : expected);
    }
    at.push(start + span);
    const leftOver = runs.filter((run) => run.cover >= STRONG_LINE && !used.has(run)).length;
    return { at, missing, leftOver };
  };
  const most = (span: number, cell: number) => Math.max(1, Math.min(60, Math.round(span / Math.max(1, cell)) * 2 + 2));
  let best: { score: number; xs: number[]; ys: number[] } | null = null;
  for (let columns = 1; columns <= most(w, h * aspect); columns++) {
    const across = cuts(vertical, columns, x0, w);
    for (let rows = 1; rows <= most(h, w / aspect); rows++) {
      const down = cuts(horizontal, rows, y0, h);
      const shape = Math.abs(Math.log(w / columns / (h / rows) / aspect));
      const score = shape + 0.12 * (across.missing + down.missing) + 0.12 * (across.leftOver + down.leftOver) + 0.001 * (columns * rows);
      if (!best || score < best.score) best = { score, xs: across.at, ys: down.at };
    }
  }
  const { xs, ys } = best!;
  const cells: PxBox[] = [];
  for (let r = 0; r + 1 < ys.length; r++) {
    for (let c = 0; c + 1 < xs.length; c++) cells.push(toFrame(plane, [Math.round(xs[c]), Math.round(ys[r]), Math.round(xs[c + 1]), Math.round(ys[r + 1])]));
  }
  return cells;
}

/**
 * A page's box drawn in to its frame: a page number or words touching the
 * frame from outside make the shape larger than the page. Each edge goes to
 * the outermost line along it (most of the page long) a little way in, if
 * there is one; a page with no frame (white on a grey ground) keeps its box.
 */
function toFrame(plane: Plane, cell: PxBox): PxBox {
  const [x0, y0, x1, y1] = cell;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 12 || h < 12) return cell;
  const band = 0.06;
  const columns = linesIn(plane, true, 0.8, 0.1, 0.9, cell);
  const rows = linesIn(plane, false, 0.8, 0.1, 0.9, cell);
  const left = columns.filter((run) => run.at <= x0 + w * band).sort((a, b) => a.at - b.at)[0];
  const right = columns.filter((run) => run.at >= x1 - w * band).sort((a, b) => b.at - a.at)[0];
  const top = rows.filter((run) => run.at <= y0 + h * band).sort((a, b) => a.at - b.at)[0];
  const bottom = rows.filter((run) => run.at >= y1 - h * band).sort((a, b) => b.at - a.at)[0];
  // The line itself belongs to the page: its middle, out to its outer edge (about a pixel).
  return [
    left ? Math.max(x0, Math.floor(left.at - 0.5)) : x0,
    top ? Math.max(y0, Math.floor(top.at - 0.5)) : y0,
    right ? Math.min(x1, Math.ceil(right.at + 0.5)) : x1,
    bottom ? Math.min(y1, Math.ceil(bottom.at + 0.5)) : y1,
  ];
}

/**
 * The frame every page has inside (a name sheet's 基本枠), as a fraction of
 * the page; null unless most pages have one, in the same place.
 */
function innerFrameOf(gray: Gray, cells: PxBox[], tolerance: number): InnerFrame | null {
  // Each side's candidate lines on every page (fractions of the page), then the place most pages have one.
  const sides: number[][][] = [[], [], [], []];
  let looked = 0;
  for (const [x0, y0, x1, y1] of cells) {
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 24 || h < 24) continue;
    looked++;
    const plane = planeOf(gray, [x0, y0, x1, y1], tolerance);
    const columns = linesIn(plane, true, 0.7, 0.2, 0.8).map((run) => (run.at - x0) / w);
    const rows = linesIn(plane, false, 0.7, 0.2, 0.8).map((run) => (run.at - y0) / h);
    sides[0].push(columns.filter((at) => at >= 0.03 && at <= 0.35));
    sides[2].push(columns.filter((at) => at >= 0.65 && at <= 0.97));
    sides[1].push(rows.filter((at) => at >= 0.03 && at <= 0.35));
    sides[3].push(rows.filter((at) => at >= 0.65 && at <= 0.97));
  }
  const reach = 0.012;
  const frame: number[] = [];
  for (const [k, candidates] of sides.entries()) {
    // Where most pages have a line (panel lines differ from page to page; the frame does not); the outer one of equals.
    let best: { at: number; pages: number } | null = null;
    for (const at of candidates.flat()) {
      const pages = candidates.filter((lines) => lines.some((other) => Math.abs(other - at) <= reach)).length;
      const outer = k < 2 ? at < (best?.at ?? Infinity) : at > (best?.at ?? -Infinity);
      if (!best || pages > best.pages || (pages === best.pages && outer)) best = { at, pages };
    }
    if (!best || best.pages < Math.max(2, looked * 0.7)) return null;
    frame.push(median(candidates.flatMap((lines) => lines.filter((other) => Math.abs(other - best!.at) <= reach))));
  }
  return frame as InnerFrame;
}

/** Lines are grown by this much (px) to close small breaks before the paper is found. */
const CLOSE = 1;

/** A shape's box without the ring the growing of its lines added (none at the picture's edges, where there is no ring). */
function trimmed([x0, y0, x1, y1]: PxBox, width: number, height: number): PxBox {
  return [x0 > 0 ? x0 + CLOSE : x0, y0 > 0 ? y0 + CLOSE : y0, x1 < width ? x1 - CLOSE : x1, y1 < height ? y1 - CLOSE : y1];
}

/**
 * The pages in a picture of many. `aspect` is a page's width / height as
 * drawn (the name's trim, say); pages far from it in shape or much smaller
 * than the rest (a title, a page number standing alone) are left out.
 */
export function findPages(gray: Gray, aspect: number): FoundPages {
  const { width, height } = gray;
  const { paper, tolerance } = paperOf(gray);
  const ink = inkOf(gray, paper, tolerance);
  const ground = groundOf(grow(ink, width, height, CLOSE), width, height);
  const least = Math.max(6, Math.min(width, height) * 0.025);
  const shapes = shapesOf(ground, width, height).filter(({ box }) => box[2] - box[0] >= least && box[3] - box[1] >= least);
  let cells = shapes.map(({ box }) => trimmed(box, width, height)).flatMap((box) => splitShape(gray, box, aspect, tolerance));
  // A page holds no page: shapes inside one (its panels, where the ground got in at a broken corner) are part of it.
  const slack = Math.max(2, Math.min(width, height) * 0.005);
  cells = cells.filter((cell, i) => !cells.some((other, j) => j !== i && (other[2] - other[0]) * (other[3] - other[1]) > (cell[2] - cell[0]) * (cell[3] - cell[1]) && other[0] - slack <= cell[0] && other[1] - slack <= cell[1] && other[2] + slack >= cell[2] && other[3] + slack >= cell[3]));
  const area = median(cells.map(([x0, y0, x1, y1]) => (x1 - x0) * (y1 - y0)));
  cells = cells.filter(([x0, y0, x1, y1]) => {
    const shape = Math.abs(Math.log((x1 - x0) / (y1 - y0) / aspect));
    return (x1 - x0) * (y1 - y0) >= area * 0.4 && shape <= Math.log(1.6);
  });
  return { cells, inner: innerFrameOf(gray, cells, tolerance), paper, tolerance };
}

/** The most a picture is looked at for being tilted (degrees, either way). */
export const MAX_SKEW = 3;

/**
 * How far the picture is turned clockwise (degrees), as a sheet scanned a
 * little askew: the angle at which the lines drawn in it (page frames, panel
 * lines, rows of pages) line up best across and down. 0 when it is straight
 * or nothing says otherwise.
 */
export function skewOf(gray: Gray): number {
  const { width, height, data } = gray;
  const { paper, tolerance } = paperOf(gray);
  // The drawn pixels, no more than ~300k of them, measured from the middle.
  const xs: number[] = [];
  const ys: number[] = [];
  let drawn = 0;
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i] - paper) > tolerance) drawn++;
  const every = Math.max(1, Math.ceil(drawn / 300_000));
  for (let y = 0, n = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.abs(data[y * width + x] - paper) <= tolerance || n++ % every) continue;
      xs.push(x - width / 2);
      ys.push(y - height / 2);
    }
  }
  if (xs.length < 100) return 0;
  const reach = Math.ceil(Math.hypot(width, height) / 2) + 2;
  const rows = new Float64Array(2 * reach + 1);
  const columns = new Float64Array(2 * reach + 1);
  // How sharply the drawn pixels gather into rows and columns when turned back by `degrees`.
  const sharpness = (degrees: number) => {
    const t = Math.tan((degrees * Math.PI) / 180);
    rows.fill(0);
    columns.fill(0);
    for (let i = 0; i < xs.length; i++) {
      rows[Math.round(ys[i] - xs[i] * t) + reach]++;
      columns[Math.round(xs[i] + ys[i] * t) + reach]++;
    }
    let sum = 0;
    for (let i = 0; i < rows.length; i++) sum += rows[i] * rows[i] + columns[i] * columns[i];
    return sum;
  };
  let best = 0;
  let bestScore = sharpness(0);
  const straight = bestScore;
  for (const step of [0.1, 0.01]) {
    const around = best;
    const span = step === 0.1 ? MAX_SKEW : 0.1;
    for (let degrees = around - span; degrees <= around + span + 1e-9; degrees += step) {
      const score = sharpness(degrees);
      if (score > bestScore) {
        best = degrees;
        bestScore = score;
      }
    }
  }
  // Too little to tell from straight: leave it.
  if (Math.abs(best) < 0.03 || bestScore < straight * 1.02) return 0;
  return Math.round(best * 100) / 100;
}

/**
 * The picture turned `degrees` clockwise about its middle (negative turns a
 * tilted one straight), the same size, the corners it uncovers made paper.
 */
export function turnGray(gray: Gray, degrees: number, paper = 255): Gray {
  const { width, height, data } = gray;
  const out = new Uint8Array(width * height).fill(paper);
  const a = (-degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = width / 2;
  const cy = height / 2;
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const sx = Math.floor(cx + dx * cos - dy * sin);
      const sy = Math.floor(cy + dx * sin + dy * cos);
      if (sx >= 0 && sy >= 0 && sx < width && sy < height) out[y * width + x] = data[sy * width + sx];
    }
  }
  return { width, height, data: out };
}

/** The picture cut into an even grid of `rows` x `columns` over what is drawn on it (the paper around left out). */
export function gridPages(gray: Gray, rows: number, columns: number): PxBox[] {
  const { width, height } = gray;
  const { paper, tolerance } = paperOf(gray);
  const ground = groundOf(grow(inkOf(gray, paper, tolerance), width, height, CLOSE), width, height);
  let [x0, y0, x1, y1] = [width, height, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (ground[y * width + x]) continue;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y >= y1) y1 = y + 1;
    }
  }
  if (x1 <= x0 || y1 <= y0) [x0, y0, x1, y1] = [0, 0, width, height];
  else [x0, y0, x1, y1] = trimmed([x0, y0, x1, y1], width, height);
  const cells: PxBox[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      cells.push([
        Math.round(x0 + ((x1 - x0) * c) / columns),
        Math.round(y0 + ((y1 - y0) * r) / rows),
        Math.round(x0 + ((x1 - x0) * (c + 1)) / columns),
        Math.round(y0 + ((y1 - y0) * (r + 1)) / rows),
      ]);
    }
  }
  return cells;
}

/** Pages side by side in rows (each in no order), the rows going down. */
function rowsOf(cells: PxBox[]): PxBox[][] {
  const tall = median(cells.map(([, y0, , y1]) => y1 - y0));
  const byTop = [...cells].sort((a, b) => a[1] + a[3] - (b[1] + b[3]));
  const rows: PxBox[][] = [];
  for (const cell of byTop) {
    const middle = (cell[1] + cell[3]) / 2;
    const row = rows[rows.length - 1];
    if (row && middle - (row[0][1] + row[0][3]) / 2 < tall / 2) row.push(cell);
    else rows.push([cell]);
  }
  return rows;
}

/** Row by row, the rows going down; along a row right to left (`rtl`) or left to right. */
function inRows(cells: PxBox[], rtl: boolean): PxBox[] {
  return rowsOf(cells).flatMap((row) => row.sort((a, b) => (rtl ? b[0] + b[2] - (a[0] + a[2]) : a[0] + a[2] - (b[0] + b[2]))));
}

/** Pages in blocks side by side with room between them (the halves of a name sheet), each block read row by row. */
function blocksOf(cells: PxBox[]): PxBox[][] {
  const wide = median(cells.map(([x0, , x1]) => x1 - x0));
  const byLeft = [...cells].sort((a, b) => a[0] - b[0]);
  const blocks: { right: number; cells: PxBox[] }[] = [];
  for (const cell of byLeft) {
    const block = blocks[blocks.length - 1];
    if (block && cell[0] - block.right < wide * 0.2) {
      block.cells.push(cell);
      block.right = Math.max(block.right, cell[2]);
    } else blocks.push({ right: cell[2], cells: [cell] });
  }
  return blocks.map((block) => block.cells);
}

/** Read block by block when the pages lie in two or more blocks of several rows and columns each, as on a name sheet. */
export function guessOrder(cells: PxBox[], rightToLeft: boolean): ReadingOrder {
  const blocks = blocksOf(cells);
  const many = blocks.length >= 2 && blocks.every((block) => {
    const rows = rowsOf(block).length;
    return rows >= 2 && block.length / rows >= 3;
  });
  return many ? (rightToLeft ? "blocks-rtl" : "blocks-ltr") : rightToLeft ? "rtl" : "ltr";
}

/** The pages in reading order. */
export function orderCells(cells: PxBox[], order: ReadingOrder): PxBox[] {
  if (!cells.length) return [];
  if (order === "rtl" || order === "ltr") return inRows(cells, order === "rtl");
  const rtl = order === "blocks-rtl";
  const blocks = blocksOf(cells);
  if (rtl) blocks.reverse();
  return blocks.flatMap((block) => inRows(block, rtl));
}

/** What a page's picture is laid by: its outer edge on the trim, the canvas or the 基本枠, or its own inner frame on the 基本枠. */
export type ImportFit = "trim" | "canvas" | "basic" | "inner";

/** The shape (width / height) of what `fit` lays the outer edge of a page's picture on. */
export function fitAspect(format: PageFormat, fit: Exclude<ImportFit, "inner">): number {
  const [x0, y0, x1, y1] = fit === "trim" ? trimBox(format) : fit === "basic" ? basicBox(format) : [0, 0, ...format.canvasMm];
  return (x1 - x0) / (y1 - y0);
}

/**
 * Where on the page (mm) a page's picture of `widthPx` x `heightPx` goes:
 * as large as fits in the target, its middle on the target's middle, its
 * shape kept. With `inner`, the picture's inner frame is what is fitted to
 * the 基本枠 (and the rest of the picture lies around it).
 */
export function placeOnPage(format: PageFormat, fit: ImportFit, widthPx: number, heightPx: number, inner: InnerFrame | null = null): BoxMm {
  if (fit === "inner" && inner) {
    const [bx0, by0, bx1, by1] = basicBox(format);
    const iw = (inner[2] - inner[0]) * widthPx;
    const ih = (inner[3] - inner[1]) * heightPx;
    const scale = Math.min((bx1 - bx0) / iw, (by1 - by0) / ih);
    const cx = (bx0 + bx1) / 2 - ((inner[0] + inner[2]) / 2) * widthPx * scale;
    const cy = (by0 + by1) / 2 - ((inner[1] + inner[3]) / 2) * heightPx * scale;
    return [cx, cy, cx + widthPx * scale, cy + heightPx * scale];
  }
  const [tx0, ty0, tx1, ty1] = fit === "trim" ? trimBox(format) : fit === "basic" || fit === "inner" ? basicBox(format) : [0, 0, ...format.canvasMm];
  const scale = Math.min((tx1 - tx0) / widthPx, (ty1 - ty0) / heightPx);
  const w = widthPx * scale;
  const h = heightPx * scale;
  const x = (tx0 + tx1 - w) / 2;
  const y = (ty0 + ty1 - h) / 2;
  return [x, y, x + w, y + h];
}

// Dialogue (セリフ): adding lines, their kind, balloon and size, wrapping the
// text to fit, and writing vertically or across with the binding.

import { storedOutline } from "./balloon";
import { APP_FONT_PT, defaultFontPt, linePitch, setDefaultFontPt, setLineSpacingStyle, useStyle } from "./style";
import { boxCenter } from "./geometry";
import type { BalloonShape, Binding, BoxMm, Line, LineKind, Page, Point, Project } from "./model";
import { wrapDialogue } from "./wrap";
import { MM_PER_PT, newId } from "./project";
import { assignPanels, orderPanels, sortLines } from "./readingorder";

export const KIND_LABELS: Record<LineKind, string> = {
  speech: "セリフ",
  thought: "モノローグ",
  narration: "ナレーション",
  sfx: "描き文字",
  aside: "小書き",
};

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
  const across = size * (1 + (rows.length - 1) * linePitch());
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

/**
 * セリフの行間 of the name (%; null: the app's). Every line is laid out
 * again from its reading start; returns how many lines there are.
 */
export function setLineSpacing(project: Project, percent: number | null): number {
  setLineSpacingStyle(project, percent);
  useStyle(project.style);
  let changed = 0;
  for (const page of project.pages) {
    for (const line of page.lines) {
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

/** Lines in reading order, with their page number (1-based). */
export function script(project: Project): { page: number; line: Line }[] {
  return project.pages.flatMap((page, index) => page.lines.map((line) => ({ page: index + 1, line })));
}

/** Count of characters spoken per page, a rough measure of how text heavy it is. */
export function textAmount(page: Page): number {
  return page.lines.reduce((sum, line) => sum + [...line.text.replace(/\s/g, "")].length, 0);
}

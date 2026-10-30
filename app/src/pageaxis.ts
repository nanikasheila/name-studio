// The page axis of 物語の帯: where each page's column and each boundary
// between pages is, in px from the strip's left edge. The pages run from the
// left, or from the right as on the canvas of a 右綴じ name (設定 › 表示).

export interface PageAxis {
  /** Pages in the name. */
  count: number;
  /** Width of one page column, px. */
  column: number;
  /** Page 1 at the right end, the pages running to the left. */
  reversed: boolean;
}

/** Where page boundary `boundary` is (0 = before the first page, count = after the last). */
export function boundaryX(axis: PageAxis, boundary: number): number {
  return (axis.reversed ? axis.count - boundary : boundary) * axis.column;
}

/** Left edge of page `index`'s column. */
export function cellX(axis: PageAxis, index: number): number {
  return Math.min(boundaryX(axis, index), boundaryX(axis, index + 1));
}

/** Left edge and width of pages `first`..`last`. */
export function spanX(axis: PageAxis, first: number, last: number): { left: number; width: number } {
  const [a, b] = [boundaryX(axis, first), boundaryX(axis, last + 1)];
  return { left: Math.min(a, b), width: Math.abs(b - a) };
}

/** The page column at `x` (clamped), and the page boundary nearest it. */
export function pageAt(axis: PageAxis, x: number): { index: number; boundary: number } {
  const count = Math.max(axis.count, 1);
  // Columns counted in reading order.
  const along = (axis.reversed ? count * axis.column - x : x) / axis.column;
  return {
    index: Math.max(0, Math.min(count - 1, Math.floor(along))),
    boundary: Math.max(0, Math.min(count, Math.round(along))),
  };
}

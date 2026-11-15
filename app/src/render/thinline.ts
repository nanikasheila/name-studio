// Lines thinner than the screen can show well. Drawing them wider than they
// are (as a floor on the width) made them look thicker the further the view
// was zoomed out; instead they are drawn that wide but fainter, with the ink
// of their real width, as a print shrunk down looks.

/** The faintest a line thinner than the thinnest shown is drawn (of its ink), so it never vanishes. */
export const FAINTEST = 0.25;

/**
 * The thinnest a line shows (px). A number: thinner lines are drawn that wide
 * but fainter (the paper, as it is). `{ widen }`: thinner lines are drawn
 * that wide, at full ink, for small pictures (ミニビュー, page lists) where
 * seeing what is drawn matters more than how thick it is.
 */
export type Thinnest = number | { widen: number };

/**
 * How a line `widthPx` wide is shown when lines show at least `thinnest`:
 * [width, ink]. A thinner line is drawn that wide but fainter, carrying the
 * ink of its real width, so zoomed out it looks as thin as it is (not
 * thicker), and is still seen.
 */
export function thinLine(widthPx: number, thinnest: Thinnest): [number, number] {
  if (typeof thinnest === "object") return [Math.max(widthPx, thinnest.widen), 1];
  if (!(thinnest > 0) || widthPx >= thinnest) return [widthPx, 1];
  return [thinnest, Math.max(widthPx / thinnest, FAINTEST)];
}

/** The width (px) below which a line is drawn wider. */
export function thinnestPx(thinnest: Thinnest): number {
  return typeof thinnest === "object" ? thinnest.widen : thinnest;
}

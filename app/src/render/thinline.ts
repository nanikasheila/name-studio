// Lines thinner than the screen can show well. Drawing them wider than they
// are (as a floor on the width) made them look thicker the further the view
// was zoomed out; instead they are drawn that wide but fainter, with the ink
// of their real width, as a print shrunk down looks.

/** The faintest a line thinner than the thinnest shown is drawn (of its ink), so it never vanishes. */
export const FAINTEST = 0.25;

/**
 * How a line `widthPx` wide is shown when lines show at least `minWidthPx`:
 * [width, ink]. A thinner line is drawn that wide but fainter, carrying the
 * ink of its real width, so zoomed out it looks as thin as it is (not
 * thicker), and is still seen.
 */
export function thinLine(widthPx: number, minWidthPx: number): [number, number] {
  if (!(minWidthPx > 0) || widthPx >= minWidthPx) return [widthPx, 1];
  return [minWidthPx, Math.max(widthPx / minWidthPx, FAINTEST)];
}

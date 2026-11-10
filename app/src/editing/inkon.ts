// Words on a colour chosen by the name (a part of the story's shape, a
// character): dark or white, whichever reads better on it. White on the
// yellow of 結 was 2.2 : 1; the better of the two is never under 4.5 : 1.

/** Black words and white ones: of the two, the better is at least 4.58 : 1 on any colour (a softer black would fall short on mid greys). */
export const DARK_INK = "#000000";
export const LIGHT_INK = "#ffffff";

/** `#rgb` or `#rrggbb` as three numbers 0–255; null for anything else. */
export function parseHex(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) return [...hex].map((c) => Number.parseInt(c + c, 16)) as [number, number, number];
  if (/^[0-9a-f]{6}$/i.test(hex)) return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  return null;
}

/** Relative luminance (WCAG): 0 black – 1 white. */
export function luminance([r, g, b]: readonly [number, number, number]): number {
  const linear = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Contrast of two colours (WCAG): 1 the same – 21 black on white. */
export function contrast(a: string, b: string): number {
  const [la, lb] = [a, b].map((color) => luminance(parseHex(color) ?? [255, 255, 255]));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The ink for words on `color`: dark or white, the one that stands out more (white when the colour cannot be read). */
export function inkOn(color: string): string {
  if (!parseHex(color)) return LIGHT_INK;
  return contrast(color, DARK_INK) >= contrast(color, LIGHT_INK) ? DARK_INK : LIGHT_INK;
}

// 色: colours as `#rrggbb` (what the name data keeps on a line or a fill) and
// the conversions the colour palette needs (RGB ↔ HSV, as CSP's カラーサークル
// and スライダー show them). Pure.

export type Rgb = [number, number, number];
/** Hue 0..360, saturation and value 0..1. */
export type Hsv = [number, number, number];
/** Hue 0..360, lightness and saturation 0..1 (CSP's HLS 色空間: the order its sliders show). */
export type Hls = [number, number, number];

/** The pen's own black: a line in it keeps no colour of its own (the rough's ink). */
export const BLACK = "#000000";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** `#rgb` or `#rrggbb` (with or without #, any case) as RGB; null when it is not one. */
export function parseHex(text: string): Rgb | null {
  const hex = text.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) return [0, 1, 2].map((i) => Number.parseInt(hex[i] + hex[i], 16)) as Rgb;
  if (/^[0-9a-f]{6}$/i.test(hex)) return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
  return null;
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(clamp(v, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** A colour as the data keeps it (`#rrggbb`, lower case), or null. */
export function normalHex(text: string): string | null {
  const rgb = parseHex(text);
  return rgb ? toHex(rgb) : null;
}

export function rgbToHsv([r, g, b]: Rgb): Hsv {
  const [rf, gf, bf] = [r / 255, g / 255, b / 255];
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === rf) h = 60 * (((gf - bf) / delta) % 6);
    else if (max === gf) h = 60 * ((bf - rf) / delta + 2);
    else h = 60 * ((rf - gf) / delta + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : delta / max, max];
}

export function hsvToRgb([h, s, v]: Hsv): Rgb {
  const hue = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const m = v - c;
  const [r, g, b] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function rgbToHls([r, g, b]: Rgb): Hls {
  const [h, , v] = rgbToHsv([r, g, b]);
  const min = Math.min(r, g, b) / 255;
  const l = (v + min) / 2;
  const s = v === min ? 0 : (v - min) / (1 - Math.abs(2 * l - 1));
  return [h, l, clamp(s, 0, 1)];
}

export function hlsToRgb([h, l, s]: Hls): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const v = l + c / 2;
  return hsvToRgb([h, v === 0 ? 0 : c / v, v]);
}

/** Whether a colour is the pen's black (none on the line). */
export function isBlack(color: string | undefined | null): boolean {
  return !color || normalHex(color) === BLACK;
}

/** The colour a line or fill keeps: none for black. */
export function ownColor(color: string): string | undefined {
  const hex = normalHex(color);
  return hex && hex !== BLACK ? hex : undefined;
}

/** CSP's 基本色 set: black, greys, white and the clear colours one tells characters apart with. */
export const BASIC_COLORS: readonly string[] = [
  "#000000",
  "#595959",
  "#a6a6a6",
  "#ffffff",
  "#e5383b",
  "#f08c2e",
  "#f2c230",
  "#4caf50",
  "#2a9d8f",
  "#3a7bd5",
  "#6a4fc8",
  "#c2459b",
  "#8b5a2b",
  "#f4a6b8",
  "#9fd3f5",
  "#b8e0a8",
];

// 作品の既定: the sizes and line widths a name draws with (Project.style) —
// the text size new lines of each kind get, and how thick panel borders and
// balloons are drawn and exported. A panel may have a border width of its
// own (Panel.lineMm). Unset values are the app's, below.
import type { LineKind, NameStyle, Panel, Project } from "./model";

/** The app's text size (pt) for each kind of line. */
export const APP_FONT_PT: Record<LineKind, number> = { speech: 13, thought: 13, narration: 12, sfx: 13, aside: 13 };
export const APP_PANEL_LINE_MM = 0.6;
export const APP_THICK_LINE_MM = 1.2;
export const APP_BALLOON_LINE_MM = 0.3;

export const MIN_FONT_PT = 4;
export const MAX_FONT_PT = 72;
export const MIN_LINE_MM = 0.05;
export const MAX_LINE_MM = 5;

/** The style of the name being drawn (set when the name is shown or changed). */
let current: NameStyle = {};

/** The name drawn from now on uses this style. */
export function useStyle(style: NameStyle | undefined): void {
  current = style ?? {};
}

/** The text size (pt) a new line of `kind` gets. */
export function defaultFontPt(kind: LineKind, style: NameStyle | undefined = current): number {
  return style?.fontPt?.[kind] ?? APP_FONT_PT[kind];
}

/** The width (mm) of plain borders, or of 太枠 with `thick`. */
export function styleLineMm(thick: boolean, style: NameStyle | undefined = current): number {
  return thick ? (style?.thickLineMm ?? APP_THICK_LINE_MM) : (style?.panelLineMm ?? APP_PANEL_LINE_MM);
}

/** Line width (mm) of a panel's border: its own, else the name's for its kind of border. */
export function panelLineMm(panel: Pick<Panel, "border" | "lineMm">, style: NameStyle | undefined = current): number {
  return panel.lineMm ?? styleLineMm(panel.border === "thick", style);
}

/** Line width (mm) of balloon outlines. */
export function balloonLineMm(style: NameStyle | undefined = current): number {
  return style?.balloonLineMm ?? APP_BALLOON_LINE_MM;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round2 = (value: number) => Math.round(value * 100) / 100;

/** A text size kept as set (to 0.5 pt, within the limits). */
export function fontPtValue(value: number): number {
  return clamp(Math.round(value * 2) / 2, MIN_FONT_PT, MAX_FONT_PT);
}

/** A line width kept as set (to 0.01 mm, within the limits). */
export function lineMmValue(value: number): number {
  return clamp(round2(value), MIN_LINE_MM, MAX_LINE_MM);
}

function keep(project: Project, style: NameStyle): void {
  if (style.fontPt && !Object.keys(style.fontPt).length) delete style.fontPt;
  if (Object.keys(style).length) project.style = style;
  else delete project.style;
}

/** 文字の大きさの既定 of a kind of line; null (or the app's size) clears it. */
export function setDefaultFontPt(project: Project, kind: LineKind, pt: number | null): void {
  const style = { ...project.style, fontPt: { ...project.style?.fontPt } };
  const value = pt === null || !Number.isFinite(pt) ? null : fontPtValue(pt);
  if (value === null || value === APP_FONT_PT[kind]) delete style.fontPt[kind];
  else style.fontPt[kind] = value;
  keep(project, style);
}

export type StyleLine = "panelLineMm" | "thickLineMm" | "balloonLineMm";

const APP_LINES: Record<StyleLine, number> = { panelLineMm: APP_PANEL_LINE_MM, thickLineMm: APP_THICK_LINE_MM, balloonLineMm: APP_BALLOON_LINE_MM };

/** A line width of the name's; null (or the app's width) clears it. */
export function setStyleLine(project: Project, key: StyleLine, mm: number | null): void {
  const style = { ...project.style };
  const value = mm === null || !Number.isFinite(mm) ? null : lineMmValue(mm);
  if (value === null || value === APP_LINES[key]) delete style[key];
  else style[key] = value;
  keep(project, style);
}

/** A panel's own border width; null (or the name's for its border) clears it. */
export function setPanelLineMm(panel: Panel, mm: number | null, style: NameStyle | undefined): void {
  const value = mm === null || !Number.isFinite(mm) ? null : lineMmValue(mm);
  if (value === null || value === styleLineMm(panel.border === "thick", style)) delete panel.lineMm;
  else panel.lineMm = value;
}

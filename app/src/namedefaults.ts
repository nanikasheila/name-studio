// 新しいネームの既定: a name's own settings (コマ間, the sizes and line widths,
// the balloon shapes and fonts for each kind of line) kept on this computer
// so that the names made from now on start with them (kept by prefs.ts).
import type { BalloonShape, Gutters, LineFonts, LineKind, NameStyle, Project } from "./model";

export interface NewNameDefaults {
  gutters?: Gutters;
  lineShapes?: Partial<Record<LineKind, BalloonShape>>;
  fonts?: LineFonts;
  style?: NameStyle;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What a name passes on to new ones (only what it has set). */
export function defaultsOf(project: Project): NewNameDefaults {
  const defaults: NewNameDefaults = {};
  // A 縦スクロール name's gutters are for the strip, not for pages.
  if (project.gutters && !project.scroll) defaults.gutters = copy(project.gutters);
  if (project.lineShapes) defaults.lineShapes = copy(project.lineShapes);
  if (project.fonts) defaults.fonts = copy(project.fonts);
  if (project.style) defaults.style = copy(project.style);
  return defaults;
}

/** Defaults as read back, or null when there are none (or they do not read). */
export function defaultsFrom(kept: unknown): NewNameDefaults | null {
  if (!isObject(kept)) return null;
  const defaults: NewNameDefaults = {};
  if (isObject(kept.gutters) && typeof kept.gutters.across === "number" && typeof kept.gutters.down === "number") {
    defaults.gutters = { across: kept.gutters.across, down: kept.gutters.down };
  }
  for (const key of ["lineShapes", "fonts", "style"] as const) {
    if (isObject(kept[key])) (defaults as Record<string, unknown>)[key] = kept[key];
  }
  return Object.keys(defaults).length ? defaults : null;
}

/** A new name takes the kept defaults; true when there were any. */
export function applyNewNameDefaults(project: Project, defaults: NewNameDefaults | null): boolean {
  if (!defaults) return false;
  if (defaults.gutters && !project.scroll) project.gutters = copy(defaults.gutters);
  if (defaults.lineShapes) project.lineShapes = copy(defaults.lineShapes);
  if (defaults.fonts) project.fonts = copy(defaults.fonts);
  if (defaults.style) project.style = copy(defaults.style);
  return true;
}

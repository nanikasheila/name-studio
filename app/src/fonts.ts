// フォント: what each line of dialogue is set in. A name chooses a font for
// each kind of line and for 強調 (Project.fonts), and a line may take its own
// (Line.font). Fonts are named as CLIP STUDIO PAINT shows them, so that the
// name goes into the CSP text layer as it is; the fonts on this computer
// (listed by the Rust side) tell how to draw each on the canvas and the
// PostScript name CSP keeps beside it.
import type { FontRole, Line, LineFonts, Project } from "./model";

export const FONT_ROLE_LABELS: Record<FontRole, string> = {
  speech: "通常（セリフ）",
  emphasis: "強調",
  thought: "モノローグ",
  narration: "ナレーション",
  sfx: "描き文字",
  aside: "小書き",
};

/** The font used when none is chosen, as the person sees it named. */
export const APP_FONT_LABEL = "アプリの既定（游ゴシック）";

/** What a line is drawn in when no font is chosen, or the chosen one is not on this computer. */
export const APP_FONT = '"Yu Gothic", "Hiragino Sans", "Noto Sans JP", sans-serif';

/** A font face on this computer (fonts.rs `FontFace`). */
export interface FontFace {
  name: string;
  families: string[];
  postscript: string;
  weight: number;
  italic: boolean;
  japanese: boolean;
}

/**
 * Usual Japanese fonts, offered when the computer's own list cannot be read
 * (in a plain browser): those that come with Windows and macOS.
 */
export const COMMON_FONTS = [
  "游ゴシック",
  "游ゴシック Medium",
  "游ゴシック Bold",
  "游明朝",
  "游明朝 Demibold",
  "BIZ UDゴシック",
  "BIZ UD明朝 Medium",
  "UD デジタル 教科書体 N-R",
  "メイリオ",
  "ＭＳ ゴシック",
  "ＭＳ 明朝",
  "ヒラギノ角ゴシック W3",
  "ヒラギノ明朝 ProN",
];

let installed: FontFace[] = [];
let byName = new Map<string, FontFace>();
/** The fonts of the name being drawn (set when the name is shown or changed). */
let current: LineFonts = {};

export function setInstalledFonts(faces: FontFace[]): void {
  installed = faces;
  byName = new Map(faces.map((face) => [face.name, face]));
}

export function installedFonts(): readonly FontFace[] {
  return installed;
}

export function installedFont(name: string): FontFace | undefined {
  return byName.get(name);
}

/** Names to offer: this computer's fonts (Japanese ones first), else the usual ones. */
export function fontChoices(): string[] {
  return installed.length ? installed.map((face) => face.name) : COMMON_FONTS;
}

/** The name drawn from now on uses these fonts. */
export function useFonts(fonts: LineFonts | undefined): void {
  current = fonts ?? {};
}

/** The font chosen for a role, falling back to セリフ's for the others; null: none. */
export function roleFont(fonts: LineFonts | undefined, role: FontRole): string | null {
  return fonts?.[role] || (role === "speech" ? null : fonts?.speech || null);
}

/** The font a line is set in: its own, else 強調's when it is marked so, else its kind's (else セリフ's); null: the app's. */
export function lineFont(line: Pick<Line, "font" | "emphasis" | "kind">, fonts: LineFonts | undefined = current): string | null {
  if (line.font) return line.font;
  if (line.emphasis && fonts?.emphasis) return fonts.emphasis;
  return roleFont(fonts, line.kind);
}

/** Whether a line is drawn bold: 強調 without a font of its own for it (that font is bold enough). */
export function lineBold(line: Pick<Line, "font" | "emphasis">, fonts: LineFonts | undefined = current): boolean {
  return !!line.emphasis && !line.font && !fonts?.emphasis;
}

const quoted = (family: string) => `"${family.replace(/["\\]/g, "")}"`;

/** A canvas font for `name` (null: the app's) at `sizePx`. */
export function canvasFont(name: string | null, sizePx: number, bold = false): string {
  const face = name ? byName.get(name) : undefined;
  const weight = bold ? "bold" : face ? String(face.weight) : "normal";
  const style = face?.italic ? "italic " : "";
  const families = name ? `${[...new Set([...(face?.families ?? []), name])].map(quoted).join(", ")}, ` : "";
  return `${style}${weight} ${sizePx}px ${families}${APP_FONT}`;
}

/** The font a line goes to CSP in, when it is on this computer (CSP needs its PostScript name too). */
export function cspFont(line: Line, fonts: LineFonts | undefined = current): { name: string; postscript: string } | null {
  const name = lineFont(line, fonts);
  const face = name ? byName.get(name) : undefined;
  return face?.postscript ? { name: face.name, postscript: face.postscript } : null;
}

/** 用途ごとのフォント: set (or with an empty name, clear) the font for a role. */
export function setRoleFont(project: Project, role: FontRole, name: string): void {
  const fonts = { ...project.fonts };
  const value = name.trim();
  if (value) fonts[role] = value;
  else delete fonts[role];
  if (Object.keys(fonts).length) project.fonts = fonts;
  else delete project.fonts;
}

/** The roles in the order they are set: 通常 first, then 強調 and the other kinds. */
export const FONT_ROLES: FontRole[] = ["speech", "emphasis", "thought", "narration", "sfx", "aside"];

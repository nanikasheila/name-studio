// 画面の見た目: how the app's own screen looks (not the pages): a colour
// theme, the screen's font and the size of its words, and CSS of the user's
// own, kept on this computer. The colours are the tokens at the top of
// styles.css; a theme is a data-theme on the root, the font and size are
// tokens set on it, and the user's CSS is a style sheet after the app's.
// The paper and what stands for it keep their colours whatever the theme.
import { readJson, writeJson } from "./settings";

export type ThemeId = "system" | "light" | "dark" | "sepia" | "contrast-dark" | "contrast-light";

export interface Theme {
  id: ThemeId;
  label: string;
  /** One line on what it is for. */
  note: string;
}

export const THEMES: readonly Theme[] = [
  { id: "system", label: "Windows に合わせる", note: "Windows の明るい・暗いに合わせて切り替わります" },
  { id: "light", label: "明るい", note: "白い地に黒い文字" },
  { id: "dark", label: "暗い", note: "暗い地に明るい文字。夜や暗い部屋で" },
  { id: "sepia", label: "目にやさしい", note: "生成りの地に茶の文字。まぶしさと青みを抑えます" },
  { id: "contrast-dark", label: "高コントラスト（黒）", note: "黒い地に白い文字と黄色。見分けやすさを第一に" },
  { id: "contrast-light", label: "高コントラスト（白）", note: "白い地に黒い文字と濃い青。見分けやすさを第一に" },
];

export interface Look {
  theme: ThemeId;
  /** The screen's font; null for the app's (Yu Gothic UI). */
  font: string | null;
  /** The size of the screen's words, in px (the app's sizes are written at 14). */
  sizePx: number;
  /** The user's own CSS, kept even while it is off. */
  css: string;
  cssOn: boolean;
}

export const DEFAULT_SIZE_PX = 14;
export const MIN_SIZE_PX = 11;
export const MAX_SIZE_PX = 20;
export const DEFAULT_LOOK: Look = { theme: "system", font: null, sizePx: DEFAULT_SIZE_PX, css: "", cssOn: false };

/** The fonts after the one chosen, as at the top of styles.css. */
export const UI_FONT_STACK = '"Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", sans-serif';

/** The fixed keys that put the look back however the screen looks (not in キー設定, so they cannot be lost). */
export const RESET_KEYS = "Ctrl+Shift+Alt+R";

const LOOK_KEY = "namestudio.look";

/** A look read back from storage (or anything): what does not read is the default. */
export function lookFrom(value: unknown): Look {
  const kept = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const theme = THEMES.some((t) => t.id === kept.theme) ? (kept.theme as ThemeId) : DEFAULT_LOOK.theme;
  const font = typeof kept.font === "string" && kept.font.trim() ? kept.font.trim() : null;
  const size = Number(kept.sizePx);
  const sizePx = Number.isFinite(size) ? clampSize(size) : DEFAULT_SIZE_PX;
  const css = typeof kept.css === "string" ? kept.css : "";
  return { theme, font, sizePx, css, cssOn: kept.cssOn === true && css.trim() !== "" };
}

/** A size in whole px from the smallest to the largest. */
export function clampSize(px: number): number {
  return Math.min(MAX_SIZE_PX, Math.max(MIN_SIZE_PX, Math.round(px)));
}

export function readLook(): Look {
  return lookFrom(readJson(LOOK_KEY, null));
}

export function writeLook(look: Look): void {
  writeJson(LOOK_KEY, look);
}

/** The CSS font-family for `font` (quoted, so any name is one name), then the app's. */
export function fontStack(font: string | null): string {
  if (!font) return UI_FONT_STACK;
  return `"${font.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\n\r\f]/g, " ")}", ${UI_FONT_STACK}`;
}

/** What is worth saying about CSS before it is used: braces that do not pair, an @import (not followed). */
export function cssNotes(css: string): string[] {
  const notes: string[] = [];
  // Comments and strings say nothing about the braces.
  const bare = css.replace(/\/\*[\s\S]*?(\*\/|$)/g, "").replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""');
  let depth = 0;
  let early = false;
  for (const c of bare) {
    if (c === "{") depth++;
    else if (c === "}" && --depth < 0) {
      early = true;
      depth = 0;
    }
  }
  if (early) notes.push("開いていない } があります（その先が読まれないことがあります）");
  if (depth > 0) notes.push(`閉じていない { が ${depth} 個あります（その先が読まれません）`);
  if (/@import\b/i.test(bare)) notes.push("@import は読み込みません（中身をここに書いてください）");
  return notes;
}

/** The screen's colours, with what each is for: the tokens a user's CSS is given to change. */
export const COLOR_TOKENS: readonly [string, string][] = [
  ["--bg", "窓の地・入力欄"],
  ["--panel", "欄・ボタン・ダイアログ"],
  ["--line", "区切り線・枠"],
  ["--text", "文字"],
  ["--muted", "控えめな文字（説明・数）"],
  ["--accent", "選んでいるもの・主なボタン"],
  ["--on-accent", "--accent の上の文字"],
  ["--stage", "ページのまわり"],
  ["--on-stage", "ページのまわりの文字"],
  ["--hover", "ポインターが乗ったところ"],
  ["--warn-bg", "注意の地（未保存・見つからないファイル）"],
  ["--warn-text", "注意の文字"],
  ["--warn-line", "注意の枠"],
  ["--error-bg", "失敗の地"],
  ["--error-text", "失敗の文字"],
  ["--error-line", "失敗の枠"],
  ["--caution", "気をつけることの文字"],
  ["--danger", "消すボタン・まちがった値"],
  ["--c-panel", "コマ（道具と詳細の色）"],
  ["--c-line", "セリフ"],
  ["--c-pen", "ペン・消しゴム"],
  ["--c-fill", "塗り"],
  ["--c-breakout", "はみ出し"],
  ["--c-sticky", "付箋"],
  ["--c-page", "ページ"],
  ["--series-1", "グラフ・時系列の色 1"],
  ["--series-2", "グラフの色 2"],
  ["--grid", "グラフの目盛り"],
  ["--reader-bg", "読む表示のまわり"],
  ["--reader-text", "読む表示の文字"],
];

/** A start for the user's CSS: every colour token with its value now and what it is for. */
export function cssTemplate(values: Record<string, string>): string {
  const width = Math.max(...COLOR_TOKENS.map(([name, ]) => name.length + (values[name] ?? "").length));
  const rows = COLOR_TOKENS.map(([name, what]) => {
    const row = `  ${name}: ${values[name] ?? ""};`;
    return `${row.padEnd(width + 5)} /* ${what} */`;
  });
  return [
    "/* Name Studio の画面のカスタム CSS。",
    "   今の配色の色を書き出しました。変えたい行だけ残して書き換えます。",
    "   紙面（ページ）の色はここでは変わりません。 */",
    ":root, [data-theme] {",
    ...rows,
    "}",
    "",
    "/* 例: ボタンの角をもっと丸く */",
    "/* button { border-radius: 12px; } */",
    "",
  ].join("\n");
}

// --- on the screen ------------------------------------------------------------------------

/** The user's CSS as a style sheet after the app's (a constructed sheet: no @import, no inline style rules needed). */
let userSheet: CSSStyleSheet | null = null;

function setUserCss(css: string | null): void {
  if (typeof document === "undefined" || typeof CSSStyleSheet === "undefined") return;
  if (!userSheet) userSheet = new CSSStyleSheet();
  userSheet.replaceSync(css ?? "");
  const others = document.adoptedStyleSheets.filter((sheet) => sheet !== userSheet);
  document.adoptedStyleSheets = css ? [...others, userSheet] : others;
}

/** How many rules of the user's CSS the screen took (what did not read is left out by the browser). */
export function userCssRules(): number {
  return userSheet && typeof document !== "undefined" && document.adoptedStyleSheets.includes(userSheet) ? userSheet.cssRules.length : 0;
}

/** The look now on the screen (which may be one being tried, not yet kept). */
let shown: Look = DEFAULT_LOOK;

export function shownLook(): Look {
  return shown;
}

/** Puts `look` on the screen (not kept: `writeLook` keeps it). */
export function applyLook(look: Look, root: HTMLElement = document.documentElement): void {
  shown = look;
  if (look.theme === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = look.theme;
  if (look.font) root.style.setProperty("--ui-font", fontStack(look.font));
  else root.style.removeProperty("--ui-font");
  if (look.sizePx !== DEFAULT_SIZE_PX) root.style.setProperty("--text-size", `${look.sizePx}px`);
  else root.style.removeProperty("--text-size");
  setUserCss(look.cssOn ? look.css : null);
}

/** The colour tokens as the screen shows them now (hex, or rgb() with alpha), for the CSS template. */
export function tokenValues(): Record<string, string> {
  const probe = document.createElement("span");
  probe.hidden = true;
  document.body.append(probe);
  const values: Record<string, string> = {};
  for (const [name] of COLOR_TOKENS) {
    probe.style.color = `var(${name})`;
    values[name] = hexOf(getComputedStyle(probe).color);
  }
  probe.remove();
  return values;
}

/** "rgb(47, 111, 219)" as "#2f6fdb" (a colour with alpha stays as it is). */
export function hexOf(color: string): string {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(color.trim());
  if (!m || (m[4] !== undefined && Number(m[4]) < 1)) return color;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}

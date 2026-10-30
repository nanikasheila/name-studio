// The fill tool's sub tools, as CSP's 塗りつぶし has them, and each one's
// own settings (CSP's ツールプロパティ): kept on this computer as plain
// values (prefs.ts reads and writes them).

import { REFER_LABELS, type FillOptions, type FillRefer } from "./fillregion";
import type { FillTone } from "./model";

/** How the fill tool fills: CSP's sub tools of 塗りつぶし and 投げなわ塗り. */
export type FillWay = "click" | "enclose" | "lasso" | "remaining";

export const FILL_WAYS: readonly FillWay[] = ["click", "enclose", "lasso", "remaining"];

export const FILL_WAY_LABELS: Record<FillWay, string> = {
  click: "塗りつぶし",
  enclose: "囲って塗る",
  lasso: "投げなわ塗り",
  remaining: "塗り残し部分に塗る",
};

/** What each way does, for its button and the hint under the tools. */
export const FILL_WAY_HINTS: Record<FillWay, string> = {
  click: "クリックした所の、線とコマ枠で閉じた範囲を塗る。塗りの上をクリックするとその色に変える",
  enclose: "囲んだ中の、線で閉じた範囲をまとめて塗る（囲みからはみ出す範囲は塗らない）",
  lasso: "囲んだ形をそのまま塗る",
  remaining: "なぞった所の、線と塗りの間に残った小さな隙間を塗る",
};

/** The ways that look at the lines, with settings of their own. */
export type AreaWay = Exclude<FillWay, "lasso">;

/** 隙間閉じ: CSP's four steps, as the widest gap (mm) each closes. */
export const GAP_STEPS: readonly { mm: number; label: string }[] = [
  { mm: 0, label: "しない" },
  { mm: 0.5, label: "小（0.5 mm）" },
  { mm: 1, label: "中（1 mm）" },
  { mm: 2, label: "大（2 mm）" },
];

export { REFER_LABELS };

export interface FillSettings {
  way: FillWay;
  tone: FillTone;
  /** Each way's own 隙間閉じ, ベクターの中心で塗り止まり, 領域拡縮 and 参照. */
  options: Record<AreaWay, FillOptions>;
  /** 塗り残し部分に塗る: the brush's size (mm across). */
  brushMm: number;
  /** Each way's fills go under the rough lines (as CSP's fill layer under the drawing) or over them. */
  under: Record<FillWay, boolean>;
}

const AREA_WAYS: readonly AreaWay[] = ["click", "enclose", "remaining"];

/** As CSP's 他レイヤー参照 starts: small gaps closed, up to the middle of the lines. */
function defaultOptions(): FillOptions {
  return { gapMm: 0.5, center: true, growMm: 0, refer: "all" };
}

/**
 * Out of the box: 投げなわ塗り in black over the lines, as the fill tool has
 * always been; the ways that fill up to the lines go under them.
 */
export function defaultFillSettings(): FillSettings {
  return {
    way: "lasso",
    tone: "black",
    options: { click: defaultOptions(), enclose: defaultOptions(), remaining: defaultOptions() },
    brushMm: 3,
    under: { click: true, enclose: true, lasso: false, remaining: true },
  };
}

export const MAX_GROW_MM = 2;
export const BRUSH_MM: readonly [number, number] = [0.5, 30];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Settings read back (anything unreadable is the default). */
export function fillSettingsFrom(raw: unknown): FillSettings {
  const settings = defaultFillSettings();
  if (!raw || typeof raw !== "object") return settings;
  const value = raw as Partial<Record<keyof FillSettings, unknown>>;
  if (FILL_WAYS.includes(value.way as FillWay)) settings.way = value.way as FillWay;
  if (value.tone === "black" || value.tone === "gray" || value.tone === "white") settings.tone = value.tone;
  if (typeof value.brushMm === "number" && Number.isFinite(value.brushMm)) settings.brushMm = clamp(value.brushMm, ...BRUSH_MM);
  const options = value.options && typeof value.options === "object" ? (value.options as Record<string, unknown>) : {};
  for (const way of AREA_WAYS) settings.options[way] = optionsFrom(options[way], settings.options[way]);
  const under = value.under && typeof value.under === "object" ? (value.under as Record<string, unknown>) : {};
  for (const way of FILL_WAYS) if (typeof under[way] === "boolean") settings.under[way] = under[way] as boolean;
  return settings;
}

function optionsFrom(raw: unknown, fallback: FillOptions): FillOptions {
  if (!raw || typeof raw !== "object") return fallback;
  const value = raw as Partial<Record<keyof FillOptions, unknown>>;
  const number = (x: unknown, min: number, max: number, none: number) => (typeof x === "number" && Number.isFinite(x) ? clamp(x, min, max) : none);
  return {
    gapMm: number(value.gapMm, 0, GAP_STEPS[GAP_STEPS.length - 1].mm, fallback.gapMm),
    center: typeof value.center === "boolean" ? value.center : fallback.center,
    growMm: number(value.growMm, -MAX_GROW_MM, MAX_GROW_MM, fallback.growMm),
    refer: (Object.keys(REFER_LABELS) as FillRefer[]).includes(value.refer as FillRefer) ? (value.refer as FillRefer) : fallback.refer,
  };
}

/** The way after `way` (G again, as CSP's sub tools cycle). */
export function nextFillWay(way: FillWay): FillWay {
  return FILL_WAYS[(FILL_WAYS.indexOf(way) + 1) % FILL_WAYS.length];
}

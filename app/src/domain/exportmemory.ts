// How each name was written out last (where to, from which template, which
// layers), so that the next export starts from it and 「前回と同じ設定で書き出す」
// needs no dialog. Kept per name on this computer (prefs.ts): the folders are
// this computer's. The CSP page settings themselves live in the name (cspPage).
import type { ExportForm, Fit } from "./export";
import { MINI_DEFAULTS, type MiniFormat, type MiniOptions } from "./mininame";
import { IMAGE_DEFAULTS, IMAGE_FORMATS, IMAGE_UNITS, type ImageFormat, type ImageOptions } from "./imageexport";

export type ExportKind = "csp" | "pdf" | "image" | "mini" | "text";
export type TemplateMode = "builtin" | "file";
export type PanelExport = "lines" | "masks" | "frames";

/** How the rough (each ラフ線のレイヤー and the name sheet's rough) goes to the CSP pages. */
export interface RoughOptions {
  /** As image (raster) layers, not vector lines. */
  raster: boolean;
  /** The CSP layers' opacity in percent (1..100), times each ラフ線のレイヤー's own. */
  opacity: number;
  /** CSP's レイヤーカラー on, in `color`. */
  layerColor: boolean;
  /** The レイヤーカラー (`#rrggbb`), kept while it is off. */
  color: string;
}

/** The colour CSP gives a layer when its レイヤーカラー is turned on (as found in CSP's own files). */
export const CSP_LAYER_COLOR = "#3e8cec";

/** The rough as it has always been written: vector lines, half opacity as a 下描き layer (else full), its own colours. */
export function roughDefaults(draftRough: boolean): RoughOptions {
  return { raster: false, opacity: draftRough ? 50 : 100, layerColor: false, color: CSP_LAYER_COLOR };
}

/** What the export takes of `rough` (the opacity 0..1, the colour only when on). */
export function roughRequest(rough: RoughOptions): { raster: boolean; opacity: number; color?: string } {
  return { raster: rough.raster, opacity: rough.opacity / 100, ...(rough.layerColor ? { color: rough.color } : {}) };
}

export interface ExportMemory {
  /** When it was written out (ms since 1970). */
  timeMs: number;
  kind: ExportKind;
  form: ExportForm;
  mode: TemplateMode;
  panels: PanelExport;
  editable: boolean;
  draftRough: boolean;
  /** The rough's layers: raster or vector, opacity, レイヤーカラー. */
  rough: RoughOptions;
  notes: boolean;
  /** 指示 into the CSP pages (下描き layers) and onto the PDF. */
  marks: boolean;
  pdf: { area: "trim" | "canvas"; dpi: number };
  /** ミニネーム: every page on one sheet, as a picture or a one-page PDF. */
  mini: MiniOptions & { format: MiniFormat };
  /** 画像・PSD: each page or 見開き a file. */
  image: ImageOptions;
  /** The PDF, ミニネーム and script files written last, and the folder of the pictures. */
  files: { pdf?: string; image?: string; mini?: string; text?: string };
}

/** How many names' exports are kept (the oldest go first). */
export const EXPORT_MEMORIES = 60;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
const percent = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 100 ? Math.round(value) : null;
const hexColor = (value: unknown): string | null =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;

/** A kept memory, read leniently (what cannot be read takes the dialog's default); null if it is not one. */
export function memoryFrom(value: unknown): ExportMemory | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const form = (typeof v.form === "object" && v.form !== null ? v.form : {}) as Record<string, unknown>;
  const pdf = (typeof v.pdf === "object" && v.pdf !== null ? v.pdf : {}) as Record<string, unknown>;
  const mini = (typeof v.mini === "object" && v.mini !== null ? v.mini : {}) as Record<string, unknown>;
  const image = (typeof v.image === "object" && v.image !== null ? v.image : {}) as Record<string, unknown>;
  const files = (typeof v.files === "object" && v.files !== null ? v.files : {}) as Record<string, unknown>;
  const rough = (typeof v.rough === "object" && v.rough !== null ? v.rough : {}) as Record<string, unknown>;
  if (!Number.isFinite(v.timeMs)) return null;
  const draftRough = flag(v.draftRough, true);
  // Kept before these were chosen: as it was written then.
  const roughBefore = roughDefaults(draftRough);
  return {
    timeMs: v.timeMs as number,
    kind: oneOf(v.kind, ["csp", "pdf", "image", "mini", "text"], "csp"),
    form: {
      template: text(form.template),
      outDir: text(form.outDir),
      fit: oneOf<Fit>(form.fit, ["basic", "trim", "cell"], "basic"),
      makeWork: flag(form.makeWork, true),
      workTemplate: text(form.workTemplate),
      workName: text(form.workName),
      storyIndex: text(form.storyIndex),
    },
    mode: oneOf(v.mode, ["builtin", "file"], "builtin"),
    panels: oneOf(v.panels, ["lines", "masks", "frames"], "lines"),
    editable: flag(v.editable, true),
    draftRough,
    rough: {
      raster: flag(rough.raster, roughBefore.raster),
      opacity: percent(rough.opacity) ?? roughBefore.opacity,
      layerColor: flag(rough.layerColor, roughBefore.layerColor),
      color: hexColor(rough.color) ?? roughBefore.color,
    },
    notes: flag(v.notes, true),
    marks: flag(v.marks, true),
    pdf: {
      area: oneOf(pdf.area, ["trim", "canvas"], "trim"),
      dpi: Number.isFinite(pdf.dpi) && (pdf.dpi as number) > 0 ? (pdf.dpi as number) : 200,
    },
    mini: {
      format: oneOf<MiniFormat>(mini.format, ["png", "jpeg", "pdf"], "png"),
      area: oneOf(mini.area, ["trim", "canvas"], MINI_DEFAULTS.area),
      dpi: Number.isFinite(mini.dpi) && (mini.dpi as number) > 0 ? (mini.dpi as number) : MINI_DEFAULTS.dpi,
      columns: Number.isInteger(mini.columns) && (mini.columns as number) >= 0 ? (mini.columns as number) : MINI_DEFAULTS.columns,
      numbers: flag(mini.numbers, MINI_DEFAULTS.numbers),
      title: flag(mini.title, MINI_DEFAULTS.title),
    },
    image: {
      format: oneOf<ImageFormat>(image.format, IMAGE_FORMATS, IMAGE_DEFAULTS.format),
      unit: oneOf(image.unit, IMAGE_UNITS, IMAGE_DEFAULTS.unit),
      area: oneOf(image.area, ["trim", "canvas"], IMAGE_DEFAULTS.area),
      dpi: Number.isFinite(image.dpi) && (image.dpi as number) > 0 ? (image.dpi as number) : IMAGE_DEFAULTS.dpi,
      paper: flag(image.paper, IMAGE_DEFAULTS.paper),
    },
    files: {
      ...(text(files.pdf) ? { pdf: text(files.pdf) } : {}),
      ...(text(files.image) ? { image: text(files.image) } : {}),
      ...(text(files.mini) ? { mini: text(files.mini) } : {}),
      ...(text(files.text) ? { text: text(files.text) } : {}),
    },
  };
}

/** A name's path as a key: Windows paths ignore case and either slash. */
export function memoryKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** The kept memories with `memory` for the name at `path`; the oldest beyond `max` go. */
export function withMemory(
  kept: Record<string, ExportMemory>,
  path: string,
  memory: ExportMemory,
  max = EXPORT_MEMORIES,
): Record<string, ExportMemory> {
  const next = { ...kept, [memoryKey(path)]: memory };
  const keys = Object.keys(next).sort((a, b) => next[b].timeMs - next[a].timeMs);
  return Object.fromEntries(keys.slice(0, max).map((key) => [key, next[key]]));
}

const KIND_NAMES: Record<Exclude<ExportKind, "csp">, string> = { pdf: "PDF", image: "画像", mini: "ミニネーム", text: "台本" };
const IMAGE_FORMAT_NAMES: Record<ImageFormat, string> = { png: "PNG", jpeg: "JPEG", psd: "PSD" };
const MINI_FORMATS: Record<MiniFormat, string> = { png: "PNG 画像", jpeg: "JPEG 画像", pdf: "1 ページの PDF" };

/** What 「前回と同じ設定で書き出す」 would do, in a line (null: it needs the dialog first). */
export function againSummary(memory: ExportMemory | null): string | null {
  if (!memory) return null;
  if (memory.kind === "csp") return memory.form.outDir ? `CSP のページを ${memory.form.outDir} に` : null;
  const file = memory.files[memory.kind];
  if (memory.kind === "image") return file ? `${IMAGE_FORMAT_NAMES[memory.image.format]} を ${file} に` : null;
  return file ? `${KIND_NAMES[memory.kind]}を ${file} に` : null;
}

/** What the export about to be made is written from (beyond its settings). */
export interface SummaryOf {
  /** Pages (縦スクロール: pieces). */
  pages: number;
  scroll: boolean;
  /** The CSP page made by the tool (ツールで設定する), with its 用紙's short name if it is one. */
  page: { trimMm: [number, number]; resolution: number; preset: string | null } | null;
  /** The name has 指示 (a 指示のレイヤー with lines on it). */
  marks?: boolean;
  /** 画像・PSD: what it makes (imageSummary) and where. */
  images?: { summary: string; folder: string };
}

const PANELS_SHORT: Record<PanelExport, string> = { lines: "コマ枠の線", masks: "コマごとのマスク", frames: "コマ枠フォルダー" };
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** What 「書き出す」 will make, in a line: how many pages, of what, to where. */
export function exportSummary(settings: Omit<ExportMemory, "timeMs" | "files">, of: SummaryOf): string {
  const pages = `${of.pages} ${of.scroll ? "区切り" : "ページ"}`;
  if (settings.kind === "pdf")
    return `${pages}を 1 つの PDF に（${settings.pdf.dpi} dpi・${settings.pdf.area === "trim" ? "仕上がりで切る" : "キャンバス全体"}${of.marks ? (settings.marks ? "・指示付き" : "・指示なし") : ""}）`;
  if (settings.kind === "mini") {
    const across = settings.mini.columns > 0 ? `横に ${settings.mini.columns} ${of.scroll ? "列" : "見開き"}` : "並びはおまかせ";
    return `${pages}を 1 枚のミニネームに（${MINI_FORMATS[settings.mini.format]}・${settings.mini.dpi} dpi・${across}）`;
  }
  if (settings.kind === "text") return `${pages}のセリフを台本（.txt）に`;
  if (settings.kind === "image")
    return `${pages}を ${of.images?.summary ?? "画像"} にして ${of.images?.folder || "（書き出し先が未選択）"} に`;
  const builtin = settings.mode === "builtin" && of.page;
  const parts = [
    pages,
    builtin
      ? (of.page!.preset ?? `仕上がり ${of.page!.trimMm[0]}×${of.page!.trimMm[1]} mm`)
      : `ひな形 ${settings.form.template ? fileName(settings.form.template) : "未選択"}`,
    builtin ? `${of.page!.resolution} dpi` : null,
    settings.editable ? "直せる線とセリフ" : "画像の線とセリフ",
    roughSummary(settings.draftRough, settings.rough, settings.editable),
    PANELS_SHORT[settings.panels],
    settings.notes ? "メモ付き" : null,
    of.marks && settings.marks ? "指示付き" : null,
  ].filter((part): part is string => !!part);
  const work = settings.form.makeWork ? `作品「${settings.form.workName || "（名前なし）"}」とページ` : "ページだけ";
  return `${parts.join("・")} → ${work}を ${settings.form.outDir || "（書き出し先が未選択）"} に`;
}

/** The rough in the line of what 書き出す makes: 下描き, and what differs from how it has always gone. */
export function roughSummary(draftRough: boolean, rough: RoughOptions, editable: boolean): string | null {
  const usual = roughDefaults(draftRough);
  const more = [
    rough.raster && editable ? "ラスター" : null,
    rough.opacity !== usual.opacity ? `不透明度 ${rough.opacity}%` : null,
    rough.layerColor ? "レイヤーカラー" : null,
  ].filter((part): part is string => !!part);
  if (!draftRough && !more.length) return null;
  return `${draftRough ? "ラフは下描き" : "ラフ"}${more.length ? `（${more.join("・")}）` : ""}`;
}

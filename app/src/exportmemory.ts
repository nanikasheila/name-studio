// How each name was written out last (where to, from which template, which
// layers), so that the next export starts from it and 「前回と同じ設定で書き出す」
// needs no dialog. Kept per name on this computer (prefs.ts): the folders are
// this computer's. The CSP page settings themselves live in the name (cspPage).
import type { ExportForm, Fit } from "./export";
import { MINI_DEFAULTS, type MiniFormat, type MiniOptions } from "./mininame";

export type ExportKind = "csp" | "pdf" | "mini" | "text";
export type TemplateMode = "builtin" | "file";
export type PanelExport = "lines" | "masks" | "frames";

export interface ExportMemory {
  /** When it was written out (ms since 1970). */
  timeMs: number;
  kind: ExportKind;
  form: ExportForm;
  mode: TemplateMode;
  panels: PanelExport;
  editable: boolean;
  draftRough: boolean;
  notes: boolean;
  pdf: { area: "trim" | "canvas"; dpi: number };
  /** ミニネーム: every page on one sheet, as a picture or a one-page PDF. */
  mini: MiniOptions & { format: MiniFormat };
  /** The PDF, ミニネーム and script files written last. */
  files: { pdf?: string; mini?: string; text?: string };
}

/** How many names' exports are kept (the oldest go first). */
export const EXPORT_MEMORIES = 60;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

/** A kept memory, read leniently (what cannot be read takes the dialog's default); null if it is not one. */
export function memoryFrom(value: unknown): ExportMemory | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const form = (typeof v.form === "object" && v.form !== null ? v.form : {}) as Record<string, unknown>;
  const pdf = (typeof v.pdf === "object" && v.pdf !== null ? v.pdf : {}) as Record<string, unknown>;
  const mini = (typeof v.mini === "object" && v.mini !== null ? v.mini : {}) as Record<string, unknown>;
  const files = (typeof v.files === "object" && v.files !== null ? v.files : {}) as Record<string, unknown>;
  if (!Number.isFinite(v.timeMs)) return null;
  return {
    timeMs: v.timeMs as number,
    kind: oneOf(v.kind, ["csp", "pdf", "mini", "text"], "csp"),
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
    draftRough: flag(v.draftRough, true),
    notes: flag(v.notes, true),
    pdf: { area: oneOf(pdf.area, ["trim", "canvas"], "trim"), dpi: Number.isFinite(pdf.dpi) && (pdf.dpi as number) > 0 ? (pdf.dpi as number) : 200 },
    mini: {
      format: oneOf<MiniFormat>(mini.format, ["png", "jpeg", "pdf"], "png"),
      area: oneOf(mini.area, ["trim", "canvas"], MINI_DEFAULTS.area),
      dpi: Number.isFinite(mini.dpi) && (mini.dpi as number) > 0 ? (mini.dpi as number) : MINI_DEFAULTS.dpi,
      columns: Number.isInteger(mini.columns) && (mini.columns as number) >= 0 ? (mini.columns as number) : MINI_DEFAULTS.columns,
      numbers: flag(mini.numbers, MINI_DEFAULTS.numbers),
      title: flag(mini.title, MINI_DEFAULTS.title),
    },
    files: {
      ...(text(files.pdf) ? { pdf: text(files.pdf) } : {}),
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
export function withMemory(kept: Record<string, ExportMemory>, path: string, memory: ExportMemory, max = EXPORT_MEMORIES): Record<string, ExportMemory> {
  const next = { ...kept, [memoryKey(path)]: memory };
  const keys = Object.keys(next).sort((a, b) => next[b].timeMs - next[a].timeMs);
  return Object.fromEntries(keys.slice(0, max).map((key) => [key, next[key]]));
}

const KIND_NAMES: Record<Exclude<ExportKind, "csp">, string> = { pdf: "PDF", mini: "ミニネーム", text: "台本" };
const MINI_FORMATS: Record<MiniFormat, string> = { png: "PNG 画像", jpeg: "JPEG 画像", pdf: "1 ページの PDF" };

/** What 「前回と同じ設定で書き出す」 would do, in a line (null: it needs the dialog first). */
export function againSummary(memory: ExportMemory | null): string | null {
  if (!memory) return null;
  if (memory.kind === "csp") return memory.form.outDir ? `CSP のページを ${memory.form.outDir} に` : null;
  const file = memory.files[memory.kind];
  return file ? `${KIND_NAMES[memory.kind]}を ${file} に` : null;
}

/** What the export about to be made is written from (beyond its settings). */
export interface SummaryOf {
  /** Pages (縦スクロール: pieces). */
  pages: number;
  scroll: boolean;
  /** The CSP page made by the tool (ツールで設定する), with its 用紙's short name if it is one. */
  page: { trimMm: [number, number]; resolution: number; preset: string | null } | null;
}

const PANELS_SHORT: Record<PanelExport, string> = { lines: "コマ枠の線", masks: "コマごとのマスク", frames: "コマ枠フォルダー" };
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** What 「書き出す」 will make, in a line: how many pages, of what, to where. */
export function exportSummary(settings: Omit<ExportMemory, "timeMs" | "files">, of: SummaryOf): string {
  const pages = `${of.pages} ${of.scroll ? "区切り" : "ページ"}`;
  if (settings.kind === "pdf") return `${pages}を 1 つの PDF に（${settings.pdf.dpi} dpi・${settings.pdf.area === "trim" ? "仕上がりで切る" : "キャンバス全体"}）`;
  if (settings.kind === "mini") {
    const across = settings.mini.columns > 0 ? `横に ${settings.mini.columns} ${of.scroll ? "列" : "見開き"}` : "並びはおまかせ";
    return `${pages}を 1 枚のミニネームに（${MINI_FORMATS[settings.mini.format]}・${settings.mini.dpi} dpi・${across}）`;
  }
  if (settings.kind === "text") return `${pages}のセリフを台本（.txt）に`;
  const builtin = settings.mode === "builtin" && of.page;
  const parts = [
    pages,
    builtin ? (of.page!.preset ?? `仕上がり ${of.page!.trimMm[0]}×${of.page!.trimMm[1]} mm`) : `ひな形 ${settings.form.template ? fileName(settings.form.template) : "未選択"}`,
    builtin ? `${of.page!.resolution} dpi` : null,
    settings.editable ? "直せる線とセリフ" : "画像の線とセリフ",
    settings.draftRough ? "ラフは下描き" : null,
    PANELS_SHORT[settings.panels],
    settings.notes ? "メモ付き" : null,
  ].filter((part): part is string => !!part);
  const work = settings.form.makeWork ? `作品「${settings.form.workName || "（名前なし）"}」とページ` : "ページだけ";
  return `${parts.join("・")} → ${work}を ${settings.form.outDir || "（書き出し先が未選択）"} に`;
}

// Writing the open sheet out as page files and a CSP EX work (.cmc).
import type { ExportRequest, ExportSource, SplitReport as ExportReport, Fit, OverwriteCheck, WrittenCheck } from "../generated/ipc";

export type { ExportRequest, ExportSource, Fit, OverwriteCheck, WrittenCheck, SplitReport as ExportReport } from "../generated/ipc";

export interface ExportForm {
  template: string;
  outDir: string;
  fit: Fit;
  makeWork: boolean;
  workTemplate: string;
  workName: string;
  storyIndex: string;
}

/** Folder of a path, for both Windows and POSIX separators. */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? "" : path.slice(0, cut);
}

function samePath(a: string, b: string): boolean {
  const normal = (path: string) =>
    path
      .replace(/[\\/]+$/, "")
      .replace(/\\/g, "/")
      .toLowerCase();
  return normal(a) === normal(b);
}

/**
 * Check the form; the request, or a message saying what is missing.
 * `sources` are the files being written out (the sheet, or the name data and
 * its sheet); their folders are refused as the output folder.
 */
export function buildRequest(form: ExportForm, sources: string | string[]): ExportRequest | string {
  if (!form.template) return "ひな形のページ（CSP で保存した空のページ）を選んでください";
  if (!form.outDir) return "書き出し先のフォルダーを選んでください";
  const inputs = [...[sources].flat(), form.template, ...(form.makeWork ? [form.workTemplate] : [])];
  if (inputs.some((input) => input && samePath(folderOf(input), form.outDir))) {
    return "元のファイルと同じフォルダーには書き出せません（上書きを防ぐため）";
  }
  let storyIndex: number | null = null;
  if (form.storyIndex.trim()) {
    storyIndex = Number(form.storyIndex);
    if (!Number.isInteger(storyIndex) || storyIndex < 0) return "話数は 0 以上の整数で入力してください";
  }
  if (form.makeWork) {
    if (!form.workTemplate) return "作品ファイルのひな形（.cmc）を選んでください";
    if (!form.workName.trim()) return "作品名を入力してください";
    if (/[\\/:*?"<>|]/.test(form.workName)) return "作品名に使えない文字が入っています";
  }
  return {
    template: form.template,
    outDir: form.outDir,
    fit: form.fit,
    workTemplate: form.makeWork ? form.workTemplate : null,
    workName: form.makeWork ? form.workName.trim() : null,
    storyIndex,
  };
}

/** One line per page with warnings, plus the work and sheet warnings. */
export function summarize(report: ExportReport): string[] {
  const lines = [`${report.pages.length} ページを書き出しました`];
  if (report.work) lines.push(`作品ファイル: ${report.work}`);
  for (const page of report.pages) {
    for (const warning of page.warnings) lines.push(`${page.number} ページ: ${warning}`);
  }
  return lines.concat(report.warnings);
}

const listed = (names: string[]) => (names.length > 6 ? `${names.slice(0, 6).join("、")} ほか ${names.length - 6} 件` : names.join("、"));

/** The name a source was kept as: its title, and its file when it has one. */
function sourceName(source: ExportSource): string {
  const file = source.path?.split(/[\\/]/).pop();
  const title = source.title?.trim();
  if (title && file) return `「${title}」（${file}）`;
  return `「${title || file || "名前のないネーム"}」`;
}

/** What to tell before writing over files in the export folder, or null when nothing there needs a word. */
export function overwriteWarning(check: OverwriteCheck): string | null {
  const other = check.existing.length ? check.otherSource : null;
  // Only this name's own files, unchanged since the last export: writing them again is the usual thing.
  if (!check.changed.length && !check.unknown.length && !other) return null;
  const lines = [`書き出し先に CSP のファイルが ${check.existing.length} 件あり、同じ名前のものは上書きされます。`];
  if (other) {
    lines.push("", `このフォルダーには、別のネーム${sourceName(other)}から書き出したページがあります。`);
  }
  if (check.changed.length) {
    lines.push("", `前回の書き出しのあとに変更されたファイル（CSP で描き進めた可能性があります）:`, listed(check.changed));
  }
  if (check.unknown.length) {
    lines.push("", `この書き出しで作ったものではないファイル:`, listed(check.unknown));
  }
  lines.push(
    "",
    check.changed.length
      ? "上書きしますか？ 「新しいフォルダーに書き出す」なら、今のファイルはそのまま残ります。描き進めたページにセリフの直しだけ入れるなら「セリフだけ反映…」を使ってください。"
      : "上書きしますか？ 「新しいフォルダーに書き出す」なら、今のファイルはそのまま残ります。",
  );
  return lines.join("\n");
}

/**
 * What to tell before writing over picture, PDF or script files, or null
 * when every one there is this app's own as it wrote it (`what`: "画像", "PDF").
 */
export function writtenWarning(check: WrittenCheck, what: string, renameLabel: string): string | null {
  if (!check.changed.length && !check.unknown.length) return null;
  const one = check.existing.length === 1;
  const lines = [
    one
      ? `書き出し先に同じ名前の${what}「${check.existing[0]}」があり、上書きされます。`
      : `書き出し先に同じ名前の${what}が ${check.existing.length} 個あり、上書きされます。`,
  ];
  if (check.changed.length) {
    lines.push(
      "",
      one && !check.unknown.length
        ? "前に書き出したあとに変更されています（ほかのツールで描き込んだり、書き込みを入れたりした可能性があります）。"
        : `前に書き出したあとに変更されたもの（ほかのツールで描き込んだ可能性があります）: ${listed(check.changed)}`,
    );
  }
  if (check.unknown.length) {
    lines.push(
      "",
      one && !check.changed.length
        ? "このアプリで書き出したものではありません。"
        : `このアプリで書き出したものではないもの: ${listed(check.unknown)}`,
    );
  }
  lines.push("", `上書きしますか？ 「${renameLabel}」なら、今のファイルはそのまま残ります。`);
  return lines.join("\n");
}

/** `base` with `_n` after it (a folder, or a file name's stem): 第4話 → 第4話_2. */
export function numbered(base: string, n: number): string {
  return `${base.replace(/[\\/]+$/, "")}_${n}`;
}

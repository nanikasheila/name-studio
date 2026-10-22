// Writing the open sheet out as page files and a CSP EX work (.cmc).

export type Fit = "basic" | "trim" | "cell";

export interface ExportForm {
  template: string;
  outDir: string;
  fit: Fit;
  makeWork: boolean;
  workTemplate: string;
  workName: string;
  storyIndex: string;
}

/** What `export_pages` takes (src-tauri/src/lib.rs `ExportRequest`). */
export interface ExportRequest {
  template: string;
  outDir: string;
  fit: Fit;
  workTemplate: string | null;
  workName: string | null;
  storyIndex: number | null;
}

/** What `export_pages` returns (clip-core `SplitReport`). */
export interface ExportReport {
  pages: { number: number; path: string; layers: number; warnings: string[] }[];
  work: string | null;
  warnings: string[];
}

/** Folder of a path, for both Windows and POSIX separators. */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? "" : path.slice(0, cut);
}

function samePath(a: string, b: string): boolean {
  const normal = (path: string) => path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return normal(a) === normal(b);
}

/** Check the form; the request, or a message saying what is missing. */
export function buildRequest(form: ExportForm, sheetPath: string): ExportRequest | string {
  if (!form.template) return "ひな形のページ（CSP で保存した空のページ）を選んでください";
  if (!form.outDir) return "書き出し先のフォルダーを選んでください";
  const inputs = [sheetPath, form.template, ...(form.makeWork ? [form.workTemplate] : [])];
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

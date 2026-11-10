// What セリフだけ反映 did, page by page: to go to each page from the result,
// and as the entry kept in the export folder's record of runs.
import type { DialogueUpdateSummary } from "./nameexport";

/** A page (or a spread) the run changed, or one to look at. */
export interface UpdatedPage {
  /** Page numbers from 1. */
  pages: number[];
  text: string;
  /** Something to look at in CSP: changed there too, a layer or the page missing, a problem on reading back. */
  attention: boolean;
}

const where = (pages: number[]) => (pages.length > 1 ? `${pages[0]}–${pages.at(-1)} ページ` : `${pages[0]} ページ`);

/** The pages the run changed or could not, in page order; pages left as they were are left out. */
export function updatedPages(summary: DialogueUpdateSummary): UpdatedPage[] {
  const rows: UpdatedPage[] = [];
  for (const page of summary.pages) {
    const parts: string[] = [];
    if (page.added.length) parts.push(`足した ${page.added.length}`);
    if (page.retired.length) parts.push(`（旧）にして隠した ${page.retired.length}`);
    if (page.replaced.length) parts.push("フキダシを入れ替えた");
    if (page.notes) parts.push("メモを描き直した");
    if (page.marks?.length) parts.push("指示を描き直した");
    if (page.conflicts.length) parts.push(`CSP でも直した「${page.conflicts.join("」「")}」をネームのものに`);
    const lost = page.notFound.filter((name) => name !== "ページのファイル");
    if (page.notFound.includes("ページのファイル")) parts.push("ページのファイルがありません");
    else if (lost.length) parts.push(`「${lost.join("」「")}」レイヤーがないのでフキダシは前のまま`);
    if (page.problems.length) parts.push(`自己確認の問題: ${page.problems.join("／")}`);
    if (!parts.length) continue;
    rows.push({ pages: page.pages, text: `${where(page.pages)}: ${parts.join("・")}`, attention: !!(page.conflicts.length || page.notFound.length || page.problems.length) });
  }
  return rows.sort((a, b) => a.pages[0] - b.pages[0]);
}

/** The run's entry in the record kept with the CSP pages: when, which name, the result and each page. */
export function updateRecord(summary: DialogueUpdateSummary, title: string, firstLine: string, now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const when = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
  const backup = summary.pages.find((page) => page.backup)?.backup?.replace(/[\\/][^\\/]+$/, "");
  return [
    `■ ${when} 「${title}」セリフだけ反映`,
    firstLine,
    ...updatedPages(summary).map((row) => `${row.attention ? "！" : "・"}${row.text}`),
    ...(backup ? [`反映する前のページ: ${backup}`] : []),
  ].join("\n");
}

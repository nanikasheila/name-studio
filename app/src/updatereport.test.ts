import { describe, expect, it } from "vitest";
import type { DialogueUpdateReport, DialogueUpdateSummary } from "./nameexport";
import { updateRecord, updatedPages } from "./updatereport";

const page = (pages: number[], over: Partial<DialogueUpdateReport> = {}): DialogueUpdateReport & { pages: number[] } => ({
  path: `C:\\out\\${pages[0]}.clip`,
  backup: null,
  kept: 3,
  retired: [],
  added: [],
  foreign: 0,
  leftAsInCsp: 0,
  replaced: [],
  notFound: [],
  conflicts: [],
  notes: false,
  problems: [],
  pages,
  ...over,
});

const SUMMARY: DialogueUpdateSummary = {
  changed: 3,
  warnings: [],
  pages: [
    page([5], { added: ["いくぞ"], retired: ["行くぞ", "待て"], replaced: ["b1"], backup: "C:\\out\\name-studio-backup\\20261028-100000\\005.clip" }),
    page([1]),
    page([2, 3], { conflicts: ["はい"], retired: ["はい"], added: ["はい！"], backup: "C:\\out\\name-studio-backup\\20261028-100000\\002.clip" }),
    page([7], { notFound: ["ページのファイル"] }),
    page([8], { notes: true, marks: ["指示"], backup: "C:\\out\\name-studio-backup\\20261028-100000\\008.clip" }),
  ],
};

describe("updatedPages", () => {
  it("lists each page the run changed or could not, in page order, and marks those to look at in CSP", () => {
    expect(updatedPages(SUMMARY)).toEqual([
      { pages: [2, 3], text: "2–3 ページ: 足した 1・（旧）にして隠した 1・CSP でも直した「はい」をネームのものに", attention: true },
      { pages: [5], text: "5 ページ: 足した 1・（旧）にして隠した 2・フキダシを入れ替えた", attention: false },
      { pages: [7], text: "7 ページ: ページのファイルがありません", attention: true },
      { pages: [8], text: "8 ページ: メモを描き直した・指示を描き直した", attention: false },
    ]);
  });
});

describe("updateRecord", () => {
  it("is the run's entry: when, which name, the result, each page and where the pages before it went", () => {
    const entry = updateRecord(SUMMARY, "第4話", "3 ページに反映しました", new Date(2026, 9, 28, 10, 5));
    expect(entry.split("\n")).toEqual([
      "■ 2026-10-28 10:05 「第4話」セリフだけ反映",
      "3 ページに反映しました",
      "！2–3 ページ: 足した 1・（旧）にして隠した 1・CSP でも直した「はい」をネームのものに",
      "・5 ページ: 足した 1・（旧）にして隠した 2・フキダシを入れ替えた",
      "！7 ページ: ページのファイルがありません",
      "・8 ページ: メモを描き直した・指示を描き直した",
      "反映する前のページ: C:\\out\\name-studio-backup\\20261028-100000",
    ]);
  });
});

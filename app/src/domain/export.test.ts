import { describe, expect, it } from "vitest";
import { buildRequest, folderOf, overwriteWarning, summarize, type ExportForm } from "./export";

const form: ExportForm = {
  template: "C:\\work\\template\\page.clip",
  outDir: "C:\\work\\out",
  fit: "basic",
  makeWork: true,
  workTemplate: "C:\\work\\name\\name.cmc",
  workName: "第1話",
  storyIndex: "",
};
const sheet = "C:\\work\\name\\name.clip";

describe("buildRequest", () => {
  it("builds the request", () => {
    expect(buildRequest(form, sheet)).toEqual({
      template: form.template,
      outDir: form.outDir,
      fit: "basic",
      workTemplate: form.workTemplate,
      workName: "第1話",
      storyIndex: null,
    });
    expect(buildRequest({ ...form, makeWork: false, storyIndex: "12" }, sheet)).toMatchObject({
      workTemplate: null,
      workName: null,
      storyIndex: 12,
    });
  });

  it("refuses to write next to the inputs", () => {
    expect(buildRequest({ ...form, outDir: "C:/work/name/" }, sheet)).toMatch(/同じフォルダー/);
    expect(buildRequest({ ...form, outDir: "C:\\work\\template" }, sheet)).toMatch(/同じフォルダー/);
  });

  it("says what is missing", () => {
    expect(buildRequest({ ...form, template: "" }, sheet)).toMatch(/ひな形のページ/);
    expect(buildRequest({ ...form, workTemplate: "" }, sheet)).toMatch(/\.cmc/);
    expect(buildRequest({ ...form, workName: "a/b" }, sheet)).toMatch(/使えない文字/);
    expect(buildRequest({ ...form, storyIndex: "1.5" }, sheet)).toMatch(/話数/);
  });
});

describe("helpers", () => {
  it("finds folders and summarizes reports", () => {
    expect(folderOf("/home/a/b.clip")).toBe("/home/a");
    expect(folderOf("C:\\a\\b.clip")).toBe("C:\\a");
    const lines = summarize({
      pages: [{ number: 3, path: "p", layers: 2, warnings: ["注意"] }],
      work: "w.cmc",
      warnings: ["全体"],
    });
    expect(lines).toEqual(["1 ページを書き出しました", "作品ファイル: w.cmc", "3 ページ: 注意", "全体"]);
  });
});

describe("buildRequest with several sources", () => {
  it("refuses the folder of any source", () => {
    const sources = ["C:\\work\\project\\name.namestudio", "C:\\work\\out\\sheet.clip"];
    expect(buildRequest(form, sources)).toMatch(/同じフォルダー/);
    expect(typeof buildRequest(form, sources.slice(0, 1))).toBe("object");
  });
});

describe("上書きの知らせ", () => {
  const check = (changed: string[], unknown: string[]) => ({ existing: [...changed, ...unknown, "page0001.clip"], changed, unknown, lastExportMs: 1 });

  it("says nothing when only the last export's own files are there", () => {
    expect(overwriteWarning(check([], []))).toBeNull();
    expect(overwriteWarning({ existing: [], changed: [], unknown: [], lastExportMs: null })).toBeNull();
  });

  it("names pages changed in CSP since the last export", () => {
    const text = overwriteWarning(check(["page0003.clip"], []))!;
    expect(text).toContain("page0003.clip");
    expect(text).toContain("CSP で描き進めた");
    const many = overwriteWarning(check([], Array.from({ length: 9 }, (_, i) => `p${i}.clip`)))!;
    expect(many).toContain("ほか 3 件");
  });
});

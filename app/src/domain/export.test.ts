import { describe, expect, it } from "vitest";
import { buildRequest, folderOf, numbered, overwriteWarning, summarize, writtenWarning, type ExportForm } from "./export";

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
  const check = (changed: string[], unknown: string[]) => ({
    existing: [...changed, ...unknown, "page0001.clip"],
    changed,
    unknown,
    lastExportMs: 1,
    otherSource: null,
  });

  it("says nothing when only the last export's own files are there", () => {
    expect(overwriteWarning(check([], []))).toBeNull();
    expect(overwriteWarning({ existing: [], changed: [], unknown: [], lastExportMs: null, otherSource: null })).toBeNull();
  });

  it("names pages changed in CSP since the last export", () => {
    const text = overwriteWarning(check(["page0003.clip"], []))!;
    expect(text).toContain("page0003.clip");
    expect(text).toContain("CSP で描き進めた");
    const many = overwriteWarning(
      check(
        [],
        Array.from({ length: 9 }, (_, i) => `p${i}.clip`),
      ),
    )!;
    expect(many).toContain("ほか 3 件");
  });
});

describe("overwriteWarning of a folder another name was written to", () => {
  it("tells it even when its pages were not drawn on", () => {
    const text = overwriteWarning({
      existing: ["page0001.clip", "第3話.cmc"],
      changed: [],
      unknown: [],
      lastExportMs: 1,
      otherSource: { path: "C:\\ネーム\\第3話.namestudio", title: "第3話" },
    })!;
    expect(text).toContain("別のネーム「第3話」（第3話.namestudio）");
    expect(text).toContain("新しいフォルダーに書き出す");
    // Nothing there to write over: nothing to tell.
    expect(
      overwriteWarning({ existing: [], changed: [], unknown: [], lastExportMs: 1, otherSource: { path: null, title: "第3話" } }),
    ).toBeNull();
  });
});

describe("writtenWarning", () => {
  const written = (existing: string[], changed: string[], unknown: string[]) => ({ existing, changed, unknown });

  it("says nothing of the app's own files as it wrote them", () => {
    expect(writtenWarning(written(["a_001.png", "a_002.png"], [], []), "画像", "別の名前で書き出す")).toBeNull();
    expect(writtenWarning(written([], [], []), "PDF", "別の名前で保存…")).toBeNull();
  });

  it("names a file written on since, and one from elsewhere", () => {
    const pdf = writtenWarning(written(["第4話.pdf"], ["第4話.pdf"], []), "PDF", "別の名前で保存…")!;
    expect(pdf).toContain("「第4話.pdf」");
    expect(pdf).toContain("変更されています");
    expect(pdf).toContain("「別の名前で保存…」");
    const pictures = writtenWarning(written(["a_001.png", "a_002.png", "a_003.png"], ["a_002.png"], ["a_003.png"]), "画像", "x")!;
    expect(pictures).toContain("3 個");
    expect(pictures).toContain("変更されたもの（ほかのツールで描き込んだ可能性があります）: a_002.png");
    expect(pictures).toContain("書き出したものではないもの: a_003.png");
  });
});

describe("numbered", () => {
  it("puts the number after the folder or the stem", () => {
    expect(numbered("C:\\書き出し\\第4話\\", 2)).toBe("C:\\書き出し\\第4話_2");
    expect(numbered("第4話", 3)).toBe("第4話_3");
  });
});

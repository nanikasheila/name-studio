import { describe, expect, it } from "vitest";
import { againSummary, exportSummary, memoryFrom, withMemory, type ExportMemory } from "./exportmemory";

const memory = (timeMs: number, outDir = "C:/out"): ExportMemory => ({
  timeMs,
  kind: "csp",
  form: { template: "", outDir, fit: "basic", makeWork: true, workTemplate: "", workName: "第4話", storyIndex: "4" },
  mode: "builtin",
  panels: "masks",
  editable: true,
  draftRough: false,
  notes: true,
  pdf: { area: "trim", dpi: 200 },
  mini: { format: "png", area: "trim", dpi: 100, columns: 0, numbers: true, title: true },
  files: {},
});

describe("export memory", () => {
  it("reads back what it kept", () => {
    const kept = memory(5);
    expect(memoryFrom(JSON.parse(JSON.stringify(kept)))).toEqual(kept);
  });

  it("reads leniently: what cannot be read takes the default", () => {
    expect(memoryFrom(null)).toBeNull();
    expect(memoryFrom({ kind: "csp" })).toBeNull();
    const read = memoryFrom({ timeMs: 1, kind: "zip", form: { outDir: 3, fit: "page" }, panels: "x", pdf: { dpi: -1 }, files: { pdf: "a.pdf", text: 2 } });
    expect(read).toMatchObject({ kind: "csp", form: { outDir: "", fit: "basic", makeWork: true }, panels: "lines", pdf: { area: "trim", dpi: 200 }, files: { pdf: "a.pdf" } });
    expect(read?.files.text).toBeUndefined();
    // Kept before the ミニネーム: its defaults.
    expect(read?.mini).toEqual({ format: "png", area: "trim", dpi: 100, columns: 0, numbers: true, title: true });
    expect(memoryFrom({ timeMs: 1, kind: "mini", mini: { format: "gif", dpi: 72, columns: 3, numbers: false }, files: { mini: "C:/m.png" } })).toMatchObject({
      kind: "mini",
      mini: { format: "png", dpi: 72, columns: 3, numbers: false, title: true },
      files: { mini: "C:/m.png" },
    });
  });

  it("keeps one per name, the same file however its path is written", () => {
    let kept = withMemory({}, "C:\\ネーム\\第4話.namestudio", memory(1, "C:/a"));
    kept = withMemory(kept, "c:/ネーム/第4話.NAMESTUDIO", memory(2, "C:/b"));
    expect(Object.values(kept).map((m) => m.form.outDir)).toEqual(["C:/b"]);
  });

  it("lets the oldest go", () => {
    let kept: Record<string, ExportMemory> = {};
    for (let i = 0; i < 5; i++) kept = withMemory(kept, `/n${i}`, memory(i), 3);
    expect(Object.keys(kept)).toEqual(["/n4", "/n3", "/n2"]);
  });

  it("says what exporting again does, or that the dialog is needed", () => {
    expect(againSummary(null)).toBeNull();
    expect(againSummary(memory(1))).toBe("CSP のページを C:/out に");
    expect(againSummary(memory(1, ""))).toBeNull();
    expect(againSummary({ ...memory(1), kind: "pdf", files: { pdf: "C:/n.pdf" } })).toBe("PDFを C:/n.pdf に");
    expect(againSummary({ ...memory(1), kind: "text" })).toBeNull();
    expect(againSummary({ ...memory(1), kind: "mini", files: { mini: "C:/n.png" } })).toBe("ミニネームを C:/n.png に");
  });
});

describe("what 書き出す will make", () => {
  const settings = {
    kind: "csp" as const,
    form: { template: "", outDir: "C:/out", fit: "basic" as const, makeWork: true, workTemplate: "", workName: "ユメノストラ", storyIndex: "4" },
    mode: "builtin" as const,
    panels: "lines" as const,
    editable: true,
    draftRough: true,
    notes: false,
    pdf: { area: "trim" as const, dpi: 200 },
    mini: { format: "pdf" as const, area: "trim" as const, dpi: 100, columns: 0, numbers: true, title: true },
  };
  const of = { pages: 21, scroll: false, page: { trimMm: [257, 364] as [number, number], resolution: 600, preset: "商業誌 B4" } };

  it("says the pages, the paper, the layers and where, for CSP", () => {
    expect(exportSummary(settings, of)).toBe("21 ページ・商業誌 B4・600 dpi・直せる線とセリフ・ラフは下描き・コマ枠の線 → 作品「ユメノストラ」とページを C:/out に");
    expect(exportSummary({ ...settings, mode: "file", form: { ...settings.form, template: "C:\\t\\page.clip", outDir: "", makeWork: false } }, of)).toBe(
      "21 ページ・ひな形 page.clip・直せる線とセリフ・ラフは下描き・コマ枠の線 → ページだけを （書き出し先が未選択） に",
    );
    expect(exportSummary(settings, { ...of, page: { ...of.page, preset: null } })).toContain("仕上がり 257×364 mm");
  });

  it("says the PDF's resolution and area, and the script", () => {
    expect(exportSummary({ ...settings, kind: "pdf" }, of)).toBe("21 ページを 1 つの PDF に（200 dpi・仕上がりで切る）");
    expect(exportSummary({ ...settings, kind: "text" }, { ...of, scroll: true })).toBe("21 区切りのセリフを台本（.txt）に");
  });

  it("says the ミニネーム's form, resolution and how many across", () => {
    expect(exportSummary({ ...settings, kind: "mini" }, of)).toBe("21 ページを 1 枚のミニネームに（1 ページの PDF・100 dpi・並びはおまかせ）");
    expect(exportSummary({ ...settings, kind: "mini", mini: { ...settings.mini, format: "jpeg", columns: 4 } }, { ...of, scroll: true })).toBe(
      "21 区切りを 1 枚のミニネームに（JPEG 画像・100 dpi・横に 4 列）",
    );
  });
});

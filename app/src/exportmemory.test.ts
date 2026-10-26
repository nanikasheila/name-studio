import { describe, expect, it } from "vitest";
import { againSummary, memoryFrom, withMemory, type ExportMemory } from "./exportmemory";

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
  });
});

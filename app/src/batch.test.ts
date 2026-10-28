import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { command: string; args: Record<string, unknown> }[] = [];
const exported: unknown[] = [];
const options: { template: string; workTemplate: string | null; donors: string[] }[] = [];
/** What Rust finds a newer version added to the name (none: an older Rust side that cannot tell). */
let unknownFields: string[] | null = null;
/** Something going wrong after the pages were checked (putting the report together). */
let failLate = false;
/** What the export says it left out or changed on the way. */
let exportWarnings: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "load_project") {
      // What Rust sends for a name with no brushes, characters or scenes.
      return { title: "t", pageFormat: { canvasMm: [257, 364], trimMm: [220, 310], basicMm: [180, 270] }, pages: [{ id: "p1", panels: [], lines: [] }] };
    }
    if (command === "unknown_project_fields") return unknownFields;
    if (command === "prepare_builtin_template") return { page: "/data/page.clip", parts: "/data/parts.clip", work: "/data/work.cmc" };
    return null;
  },
}));

vi.mock("./nameexport", () => ({
  exportToCsp: async (project: unknown, given: (typeof options)[number]) => {
    exported.push(project);
    options.push(given);
    return { warnings: exportWarnings };
  },
  checkSummary: () => ({ ok: true, lines: [] }),
  missingEditable: () => {
    if (failLate) throw new Error("late");
    return [];
  },
  imagesNote: () => "",
  ROUGH_LAYERS: ["ラフ線"],
}));

import { runBatchExport } from "./batch";

describe("runBatchExport", () => {
  beforeEach(() => {
    calls.length = 0;
    exported.length = 0;
    options.length = 0;
    unknownFields = null;
    failLate = false;
    exportWarnings = [];
  });

  it("reports a failure after the check as a failure, with the exit code", async () => {
    failLate = true;
    await runBatchExport({ project: "a.namestudio", template: "t.clip", outDir: "out", workTemplate: null, workName: null, storyIndex: null, report: "out/r.json" }, () => undefined);
    const written = calls.find((c) => c.command === "write_text_file");
    expect(JSON.parse(written?.args.text as string)).toEqual({ ok: false, error: "Error: late" });
    expect(calls.at(-1)).toEqual({ command: "end_batch_export", args: { code: 1 } });
  });

  it("says first in the report when the name holds parts a newer version added", async () => {
    unknownFields = ["pages.strokes.wobble"];
    await runBatchExport({ project: "a.namestudio", template: "t.clip", outDir: "out", workTemplate: null, workName: null, storyIndex: null, report: "out/r.json" }, () => undefined);
    const written = calls.find((c) => c.command === "write_text_file");
    const report = JSON.parse(written?.args.text as string) as { ok: boolean; summary: string[] };
    expect(report).not.toHaveProperty("error");
    expect(report.ok).toBe(true);
    expect(report.summary[0]).toMatch(/^注意: このネームには、この版が知らない項目があります.*pages\.strokes\.wobble/);
  });

  it("puts what the export left out in the report, after what the name itself is told", async () => {
    unknownFields = ["pages.strokes.wobble"];
    exportWarnings = ["読めない画像 1 枚は書き出していません: 1 ページ「資料」"];
    await runBatchExport({ project: "a.namestudio", template: "t.clip", outDir: "out", workTemplate: null, workName: null, storyIndex: null, report: "out/r.json" }, () => undefined);
    const written = calls.find((c) => c.command === "write_text_file");
    const report = JSON.parse(written?.args.text as string) as { ok: boolean; summary: string[] };
    expect(report.ok).toBe(true);
    expect(report.summary.slice(0, 2)).toEqual([expect.stringMatching(/^注意: このネームには/), "注意: 読めない画像 1 枚は書き出していません: 1 ページ「資料」"]);
  });

  it("fills in the lists a saved name leaves out before exporting", async () => {
    await runBatchExport(
      { project: "a.namestudio", template: "t.clip", outDir: "out", workTemplate: null, workName: null, storyIndex: null, report: "out/r.json" },
      () => undefined,
    );
    const project = exported[0] as { brushes: unknown[]; characters: unknown[]; pages: { roughs?: unknown[] }[] };
    expect(project.brushes).toEqual([]);
    expect(project.characters).toEqual([]);
    const report = calls.find((call) => call.command === "write_text_file");
    expect(JSON.parse(String(report?.args.text))).toMatchObject({ ok: true, summary: [] });
    expect(calls.at(-1)).toEqual({ command: "end_batch_export", args: { code: 0 } });
  });

  it("makes the template from the name's settings with --builtin", async () => {
    await runBatchExport(
      { project: "a.namestudio", template: null, builtin: true, outDir: "out", workTemplate: null, workName: "作品", storyIndex: 2, report: "out/r.json" },
      () => undefined,
    );
    const prepare = calls.find((call) => call.command === "prepare_builtin_template");
    const setup = prepare?.args.setup as { canvasMm: number[]; trimMm: number[]; title: string; storyIndex: number; rightBinding: boolean };
    expect(setup.canvasMm).toEqual([257, 364]);
    expect(setup.trimMm).toEqual([220, 310]);
    expect([setup.title, setup.storyIndex]).toEqual(["作品", 2]);
    expect(options[0].template).toBe("/data/page.clip");
    expect(options[0].workTemplate).toBe("/data/work.cmc");
    expect(options[0].donors).toContain("/data/parts.clip");
    expect(calls.at(-1)).toEqual({ command: "end_batch_export", args: { code: 0 } });
  });
});

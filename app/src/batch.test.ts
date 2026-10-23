import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { command: string; args: Record<string, unknown> }[] = [];
const exported: unknown[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "load_project") {
      // What Rust sends for a name with no brushes, characters or scenes.
      return { title: "t", pageFormat: { canvasMm: [257, 364], trimMm: [220, 310], basicMm: [180, 270] }, pages: [{ id: "p1", panels: [], lines: [] }] };
    }
    return null;
  },
}));

vi.mock("./nameexport", () => ({
  exportToCsp: async (project: unknown) => {
    exported.push(project);
    return {};
  },
  checkSummary: () => ({ ok: true, lines: [] }),
}));

import { runBatchExport } from "./batch";

describe("runBatchExport", () => {
  beforeEach(() => {
    calls.length = 0;
    exported.length = 0;
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
    expect(JSON.parse(String(report?.args.text)).ok).toBe(true);
    expect(calls.at(-1)).toEqual({ command: "end_batch_export", args: { code: 0 } });
  });
});

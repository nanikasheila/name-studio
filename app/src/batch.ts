// Writing a name out for CSP from the command line (see src-tauri/src/batch.rs):
// the window opens, writes the pages and the work, leaves a JSON report and closes.

import { invoke } from "@tauri-apps/api/core";
import { checkSummary, exportToCsp, imagesNote, missingEditable, ROUGH_LAYERS } from "./nameexport";
import { normalize, type Project } from "./project";

export interface BatchExport {
  project: string;
  template: string;
  outDir: string;
  workTemplate: string | null;
  workName: string | null;
  storyIndex: number | null;
  /** 見本のページ: .clip files to copy text and vector layers from. */
  donors?: string[];
  /** The rough as 下描き layers (on unless --no-draft-rough). */
  draftRough?: boolean;
  report: string;
}

/** The export the app was started for (or why its arguments are wrong), or null for a normal start. */
export async function batchExportTask(): Promise<BatchExport | { error: string } | null> {
  try {
    return await invoke<BatchExport | null>("batch_export_task");
  } catch (error) {
    return { error: String(error) };
  }
}

/** Run the export, write the report and close the app (exit code 0 when everything checked out). */
export async function runBatchExport(task: BatchExport | { error: string }, status: (text: string) => void): Promise<void> {
  if ("error" in task) {
    // No report path to trust: the arguments themselves are wrong.
    status(`書き出せません: ${task.error}`);
    await invoke("end_batch_export", { code: 2 });
    return;
  }
  const started = Date.now();
  let result: Record<string, unknown>;
  let ok = false;
  try {
    status(`${task.project} を書き出し中…`);
    // Not asked here (no one to ask): what was overwritten goes in the report.
    const overwrite = await invoke("check_export_target", { outDir: task.outDir }).catch(() => null);
    // As when the window opens a file: empty lists are left out of the saved JSON.
    const project = normalize(await invoke<Project>("load_project", { path: task.project }));
    const report = await exportToCsp(
      project,
      {
        template: task.template,
        outDir: task.outDir,
        workTemplate: task.workTemplate,
        workName: task.workName,
        storyIndex: task.storyIndex,
        inputs: [task.project, project.source?.path].filter((path): path is string => !!path),
        donors: [...(task.donors ?? []), project.source?.path].filter((path): path is string => !!path),
        draftLayers: task.draftRough === false ? [] : ROUGH_LAYERS,
      },
      true,
      status,
    );
    if (!report) throw new Error("書き出しが止まりました");
    const check = checkSummary(report);
    ok = check.ok;
    // Read back as written, but not editable in CSP: said first, so it is not missed.
    const missing = missingEditable(report);
    const summary = missing.length ? [`注意: ${imagesNote(missing)}`, ...check.lines] : check.lines;
    result = { ok, seconds: (Date.now() - started) / 1000, summary, overwrite, ...report };
  } catch (error) {
    result = { ok, error: String(error) };
  }
  await invoke("write_text_file", { path: task.report, text: JSON.stringify(result, null, 2) }).catch(() => undefined);
  await invoke("end_batch_export", { code: ok ? 0 : 1 });
}

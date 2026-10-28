// Writing a name out for CSP from the command line (see src-tauri/src/batch.rs):
// the window opens, writes the pages and the work, leaves a JSON report and closes.

import { call, type BatchExport } from "./backend";
export type { BatchExport } from "./backend";
import { checkSummary, dialogueUpdateSummary, exportToCsp, imagesNote, missingEditable, readCspDialogue, ROUGH_LAYERS, updateCspDialogue } from "./nameexport";
import { normalize, unknownFieldsNote } from "./project";
import { projectBody } from "./projectjson";
import { applyTakeBack, planTakeBack, takeBackSummary } from "./readback";
import { cspPageOf, pageSetup, piecesPerPage, setupProblem } from "./csppage";
import { installedFont } from "./fonts";
import type { Project } from "./model";

/** The template page and work to write with, and pages to copy layers from: the given ones, or with --builtin those made from the name's CSP page settings. */
async function templatesFor(task: BatchExport, project: Project): Promise<{ template: string; workTemplate: string | null; donors: string[]; pieces?: number }> {
  if (!task.builtin) {
    if (!task.template) throw new Error("--template（ページのひな形 .clip）がありません");
    return { template: task.template, workTemplate: task.workTemplate, donors: [] };
  }
  const setup = pageSetup(project, cspPageOf(project), { title: task.workName ?? project.title, storyIndex: task.storyIndex ?? project.storyIndex ?? null, author: project.author }, (name) => installedFont(name)?.postscript);
  const problem = setupProblem(setup);
  if (problem) throw new Error(problem);
  const built = await call("prepare_builtin_template", { setup });
  // A work only when it is given a name.
  return { template: built.page, workTemplate: task.workName ? (task.workTemplate ?? built.work) : null, donors: [built.parts], pieces: piecesPerPage(project, cspPageOf(project)) };
}

/** The export the app was started for (or why its arguments are wrong), or null for a normal start. */
export async function batchExportTask(): Promise<BatchExport | { error: string } | null> {
  try {
    return await call("batch_export_task");
  } catch (error) {
    return { error: String(error) };
  }
}

/** Run the export, write the report and close the app (exit code 0 when everything checked out). */
export async function runBatchExport(task: BatchExport | { error: string }, status: (text: string) => void): Promise<void> {
  if ("error" in task) {
    // No report path to trust: the arguments themselves are wrong.
    status(`書き出せません: ${task.error}`);
    await call("end_batch_export", { code: 2 });
    return;
  }
  const started = Date.now();
  let result: Record<string, unknown>;
  let ok = false;
  try {
    status(`${task.project} を書き出し中…`);
    // Not asked here (no one to ask): what was overwritten goes in the report.
    const overwrite = await call("check_export_target", { outDir: task.outDir }).catch(() => null);
    // As when the window opens a file: empty lists are left out of the saved JSON.
    const project = normalize(await call("load_project", { path: task.project }));
    // Parts a newer version added are not written out: said first in the report.
    const unknown = unknownFieldsNote((await call("unknown_project_fields", { path: task.project }).catch(() => null)) ?? []);
    const notes = unknown ? [`注意: ${unknown}`] : [];
    const templates = await templatesFor(task, project);
    if (task.readDialogue) {
      const units = await readCspDialogue(
        project,
        {
          template: templates.template,
          outDir: task.outDir,
          workTemplate: null,
          workName: null,
          storyIndex: null,
          inputs: [task.project, project.source?.path].filter((path): path is string => !!path),
          donors: [...(task.donors ?? []), project.source?.path, ...templates.donors].filter((path): path is string => !!path),
        },
        status,
      );
      const plan = planTakeBack(project, units);
      const changes = plan.retyped.length + plan.added.length + plan.removed.length;
      if (changes) {
        applyTakeBack(project, plan);
        await call("save_project", projectBody({ path: task.project, previousPath: task.project }, project));
        await call("adopt_name_dialogue", { paths: plan.paths });
      }
      ok = !plan.missing.length;
      const summary = [changes ? `CSP のセリフを読み戻して ${task.project} に保存しました` : "CSP で直したセリフはありませんでした", ...takeBackSummary(plan)];
      result = { ok, seconds: (Date.now() - started) / 1000, summary, ...plan };
    } else if (task.updateDialogue) {
      const summary = await updateCspDialogue(
        project,
        {
          template: templates.template,
          outDir: task.outDir,
          workTemplate: null,
          workName: null,
          storyIndex: null,
          inputs: [task.project, project.source?.path].filter((path): path is string => !!path),
          donors: [...(task.donors ?? []), project.source?.path, ...templates.donors].filter((path): path is string => !!path),
          notes: task.notes !== false,
          marks: task.marks !== false,
        },
        status,
      );
      const check = dialogueUpdateSummary(summary);
      ok = check.ok;
      result = { ok, seconds: (Date.now() - started) / 1000, summary: [...notes, ...check.lines], ...summary };
    } else {
      const report = await exportToCsp(
        project,
        {
          template: templates.template,
          outDir: task.outDir,
          workTemplate: templates.workTemplate,
          workName: task.workName,
          storyIndex: task.storyIndex,
          inputs: [task.project, project.source?.path].filter((path): path is string => !!path),
          donors: [...(task.donors ?? []), project.source?.path, ...templates.donors].filter((path): path is string => !!path),
          draftLayers: task.draftRough === false ? [] : ROUGH_LAYERS,
          frameFolders: task.frameFolders === true,
          panelMasks: task.panelMasks === true,
          notes: task.notes !== false,
          marks: task.marks !== false,
        },
        true,
        status,
        undefined,
        templates.pieces,
      );
      if (!report) throw new Error("書き出しが止まりました");
      const check = checkSummary(report);
      ok = check.ok;
      // Read back as written, but not editable in CSP: said first, so it is not missed.
      const missing = missingEditable(report);
      // What was left out or changed on the way (pictures that could not be read, pages not joined as a spread).
      const warnings = (report.warnings ?? []).map((warning) => `注意: ${warning}`);
      const summary = [...notes, ...warnings, ...(missing.length ? [`注意: ${imagesNote(missing)}`] : []), ...check.lines];
      result = { ok, seconds: (Date.now() - started) / 1000, summary, overwrite, ...report };
    }
  } catch (error) {
    // Whatever went well before, the export did not finish: not ok, and the exit code says so.
    ok = false;
    result = { ok, error: String(error) };
  }
  await call("write_text_file", { path: task.report, text: JSON.stringify(result, null, 2) }).catch(() => undefined);
  await call("end_batch_export", { code: ok ? 0 : 1 });
}

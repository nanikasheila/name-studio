// The dialog for taking in a Markdown script (R7): paste or open a file,
// see what will be read, choose where it goes, then deal it out.
import { applyScript, parseScript, type ScriptDoc, type ScriptImportReport } from "./scriptimport";
import type { Project } from "./project";

export interface ScriptDialogHost {
  project(): Project | null;
  /** Run `change` as one undoable step. */
  edit(change: (project: Project) => void): void;
  /** The script went onto the name: show its first page. */
  done(report: ScriptImportReport, firstPage: number): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Text of a file: UTF-8, or Shift_JIS (common for Japanese text on Windows). */
export async function readTextFile(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

export class ScriptDialog {
  private doc: ScriptDoc | null = null;

  constructor(private readonly host: ScriptDialogHost) {
    $("sd-text").addEventListener("input", () => this.preview());
    $<HTMLInputElement>("sd-file").addEventListener("change", async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      $<HTMLTextAreaElement>("sd-text").value = await readTextFile(file);
      (event.target as HTMLInputElement).value = "";
      this.preview();
    });
    $("sd-start").addEventListener("input", () => this.preview());
    $("sd-run").addEventListener("click", () => this.run());
  }

  open(): void {
    const project = this.host.project();
    if (!project) return;
    // Onto the first page that has no dialogue yet.
    const empty = project.pages.findIndex((page) => !page.lines.length);
    $<HTMLInputElement>("sd-start").value = String((empty < 0 ? project.pages.length : empty) + 1);
    this.preview();
    $<HTMLDialogElement>("script-dialog").showModal();
  }

  private preview(): void {
    const text = $<HTMLTextAreaElement>("sd-text").value;
    const project = this.host.project();
    this.doc = text.trim() ? parseScript(text) : null;
    const run = $<HTMLButtonElement>("sd-run");
    const summary = $("sd-summary");
    if (!this.doc || !project) {
      summary.textContent = "Markdown の台本を貼り付けるか、ファイルを開いてください。";
      run.disabled = true;
      return;
    }
    const pages = this.doc.pages;
    const panels = pages.reduce((sum, page) => sum + page.panels.filter((p) => p.lines.length || p.notes.length).length, 0);
    const lines = pages.reduce((sum, page) => sum + page.panels.reduce((n, p) => n + p.lines.length, 0), 0);
    const speakers = new Set(pages.flatMap((page) => page.panels.flatMap((p) => p.lines.map((l) => l.speaker).filter(Boolean))));
    const known = new Set(project.characters.map((c) => c.name));
    const fresh = [...speakers].filter((name) => !known.has(name!));
    const start = this.start(project);
    const added = Math.max(0, start + pages.length - project.pages.length);
    const scenes = new Set(pages.map((page) => page.scene).filter(Boolean)).size;
    summary.textContent = [
      `${pages.length} ページ・コマ ${panels}・セリフ ${lines}${scenes ? `・シーン ${scenes}` : ""}${this.doc.title ? `（${this.doc.title}）` : ""}`,
      `${start + 1} ページから入れます${added ? `（ページを ${added} 枚足します）` : ""}。`,
      fresh.length ? `新しい登場人物: ${fresh.join("、")}` : "",
      ...this.doc.warnings,
    ]
      .filter(Boolean)
      .join("\n");
    run.disabled = lines === 0;
  }

  private start(project: Project): number {
    const value = Number.parseInt($<HTMLInputElement>("sd-start").value, 10);
    return Math.max(0, Math.min(Number.isFinite(value) ? value - 1 : 0, project.pages.length));
  }

  private run(): void {
    const project = this.host.project();
    const doc = this.doc;
    if (!project || !doc) return;
    const start = this.start(project);
    const makePanels = $<HTMLInputElement>("sd-panels").checked;
    let report: ScriptImportReport | null = null;
    this.host.edit((p) => (report = applyScript(p, doc, { startPage: start, makePanels })));
    $<HTMLDialogElement>("script-dialog").close();
    if (report) this.host.done(report, start + 1);
  }
}

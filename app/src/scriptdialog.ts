// The dialog for taking in a Markdown script (R7) or plot: paste or open a
// file, see what will be read, choose where it goes, then deal it out.
import { applyPlot, looksLikePlot, parsePlot, type PlotDoc, type PlotImportReport } from "./plotimport";
import { applyScript, parseScript, type ScriptDoc, type ScriptImportReport } from "./scriptimport";
import { PATTERNS } from "./koma";
import type { Project } from "./project";
import { $ } from "./dom";

export interface ScriptDialogHost {
  project(): Project | null;
  /** Run `change` as one undoable step. */
  edit(change: (project: Project) => void): void;
  /** The script went onto the name: show its first page. */
  done(report: ScriptImportReport, firstPage: number): void;
  /** Whether page 1 stands alone in the spreads (left-hand pages get notes on their left). */
  firstAlone(): boolean;
  /** The plot went onto the name. */
  plotDone(report: PlotImportReport): void;
}

/** Text of a file: UTF-8, or Shift_JIS (common for Japanese text on Windows). */
export async function readTextFile(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** Where the plot's 付箋 go: the page they name, the page they are most about, or the first page. */
function stickyWhere(plot: PlotDoc): string {
  const named = plot.notes.filter((n) => n.page && !n.guessed).length;
  const guessed = plot.notes.filter((n) => n.guessed).length;
  const first = plot.notes.length - named - guessed;
  return `付箋: ${[named ? `書いてあるページへ ${named}` : "", guessed ? `中身の近いページへ ${guessed}` : "", first ? `1 ページへ ${first}` : ""].filter(Boolean).join("・")}`;
}

export class ScriptDialog {
  private doc: ScriptDoc | null = null;
  private plot: PlotDoc | null = null;

  constructor(private readonly host: ScriptDialogHost) {
    $("sd-text").addEventListener("input", () => this.preview(true));
    $<HTMLInputElement>("sd-file").addEventListener("change", async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      $<HTMLTextAreaElement>("sd-text").value = await readTextFile(file);
      (event.target as HTMLInputElement).value = "";
      this.preview(true);
    });
    $("sd-start").addEventListener("input", () => this.preview());
    $("sd-mode").addEventListener("change", () => this.preview());
    $("sd-notes").addEventListener("change", () => this.preview());
    $("sd-update").addEventListener("change", () => this.preview());
    $("sd-run").addEventListener("click", () => this.run());
    const pattern = $<HTMLSelectElement>("sd-pattern");
    for (const item of PATTERNS) pattern.append(Object.assign(document.createElement("option"), { value: item.id, textContent: item.label, title: item.note }));
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

  /** What will be read and where it goes; `newText`: new text, so a numbered script starts at its own first page. */
  private preview(newText = false): void {
    const text = $<HTMLTextAreaElement>("sd-text").value;
    const project = this.host.project();
    this.doc = text.trim() ? parseScript(text) : null;
    const first = this.doc?.pages[0]?.number;
    if (newText && first && project) $<HTMLInputElement>("sd-start").value = String(Math.min(first, project.pages.length + 1));
    const run = $<HTMLButtonElement>("sd-run");
    const summary = $("sd-summary");
    const dialogue = this.doc?.pages.reduce((sum, page) => sum + page.panels.reduce((n, p) => n + p.lines.length, 0), 0) ?? 0;
    const mode = $<HTMLSelectElement>("sd-mode").value;
    const asPlot = !!this.doc && (mode === "plot" || (mode === "auto" && looksLikePlot(text, dialogue)));
    this.plot = asPlot ? parsePlot(text) : null;
    $("sd-plot-hint").hidden = !asPlot;
    $("sd-script-hint").hidden = asPlot;
    $("sd-start-row").hidden = asPlot;
    $("sd-panels-row").hidden = asPlot;
    $("sd-pattern-row").hidden = asPlot;
    $("sd-pattern-hint").hidden = asPlot;
    $("sd-notes-row").hidden = !asPlot;
    $("sd-update-row").hidden = true;
    if (this.plot && project) {
      const plot = this.plot;
      const notes = $<HTMLInputElement>("sd-notes").checked ? plot.notes.length : 0;
      const needed = Math.max(0, ...plot.pages.map((p) => p.last), ...plot.scenes.map((s) => s.last));
      const added = Math.max(0, needed - project.pages.length);
      summary.textContent = [
        `プロットとして読みます${plot.title ? `（${plot.title}）` : ""}: ページのメモ ${plot.pages.length}・シーン ${plot.scenes.length}・付箋 ${notes}${plot.total ? `・合計 ${plot.total} ページ` : ""}`,
        added ? `ページを ${added} 枚足します。` : "",
        notes ? stickyWhere(plot) : "",
        plot.scenes.length ? `シーン: ${plot.scenes.map((s) => `${s.title}（${s.first === s.last ? s.first : `${s.first}〜${s.last}`}）`).join("、")}` : "",
        project.scenes.length && plot.scenes.length ? "重なる今のシーンは置き換えます。" : "",
      ]
        .filter(Boolean)
        .join("\n");
      run.disabled = !plot.pages.length && !plot.scenes.length && !notes;
      return;
    }
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
    const shaped = pages.filter((page) => page.pattern).length;
    // Pages that already have dialogue: brought in line with the script, or given a second copy.
    const spoken = project.pages.slice(start, start + pages.length).filter((page) => page.lines.length).length;
    $("sd-update-row").hidden = !spoken;
    const update = spoken > 0 && $<HTMLInputElement>("sd-update").checked;
    let changes = "";
    if (spoken) {
      if (update) {
        const trial = applyScript(structuredClone(project), this.doc, { startPage: start, makePanels: true, update: true });
        changes = [
          `セリフのある ${spoken} ページは台本に合わせて直します: 書き換え ${trial.changed}・足す ${trial.added}・消す ${trial.removed}・そのまま ${trial.kept}${trial.notes ? `、コマのメモの書き換え ${trial.notes}` : ""}`,
          trial.insertedPages ? `台本で増えたページ ${trial.insertedPages} 枚を、その位置に入れます。` : "",
          trial.leftPages.length ? `台本にないページ ${trial.leftPages.join("・")} はそのままにします（要らなければページ一覧で消してください）。` : "",
        ]
          .filter(Boolean)
          .join("\n");
      } else changes = `注意: セリフのある ${spoken} ページに、台本のセリフをもう一組足します（今のセリフは残ります）`;
    }
    summary.textContent = [
      `${pages.length} ページ・コマ ${panels}・セリフ ${lines}${scenes ? `・シーン ${scenes}` : ""}${this.doc.title ? `（${this.doc.title}）` : ""}`,
      `${start + 1} ページから入れます${added ? `（ページを ${added} 枚足します）` : ""}。`,
      changes,
      fresh.length ? `新しい登場人物: ${fresh.join("、")}` : "",
      shaped ? `型を指定したページ: ${shaped}` : "",
      scenes && project.scenes.length ? "重なる今のシーンは台本のシーンに置き換えます（同じページ範囲のシーンの要約は引き継ぎます）。" : "",
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
    const plot = this.plot;
    if (project && plot) {
      const doc = $<HTMLInputElement>("sd-notes").checked ? plot : { ...plot, notes: [] };
      let report: PlotImportReport | null = null;
      this.host.edit((p) => (report = applyPlot(p, doc, this.host.firstAlone())));
      $<HTMLDialogElement>("script-dialog").close();
      if (report) this.host.plotDone(report);
      return;
    }
    const doc = this.doc;
    if (!project || !doc) return;
    const start = this.start(project);
    const makePanels = $<HTMLInputElement>("sd-panels").checked;
    const pattern = $<HTMLSelectElement>("sd-pattern").value || undefined;
    const update = !$("sd-update-row").hidden && $<HTMLInputElement>("sd-update").checked;
    let report: ScriptImportReport | null = null;
    this.host.edit((p) => (report = applyScript(p, doc, { startPage: start, makePanels, pattern, update })));
    $<HTMLDialogElement>("script-dialog").close();
    if (report) this.host.done(report, start + 1);
  }
}

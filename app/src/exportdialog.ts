// The dialog that writes the name data out (CSP pages and work, PDF, script).
import { invoke } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { buildRequest, folderOf, overwriteWarning, type ExportForm, type OverwriteCheck } from "./export";
import {
  checkSummary,
  dialogueUpdateSummary,
  exportPdf,
  exportToCsp,
  imagesNote,
  missingEditable,
  readCspDialogue,
  ROUGH_LAYERS,
  scriptText,
  updateCspDialogue,
} from "./nameexport";
import { applyTakeBack, planTakeBack, takeBackSummary } from "./readback";
import { ISSUE_LABELS, checkName, issueSummary } from "./namecheck";
import type { Project, RoughImage } from "./project";

export interface ExportDialogHost {
  project(): Project | null;
  /** Where the name data is saved, if it is. */
  projectPath(): string | null;
  rough(rough: RoughImage): Promise<CanvasImageSource | null>;
  status(message: string): void;
  /** Run `change` as one undoable step. */
  edit(change: (project: Project) => void): void;
  /** Show a line of dialogue on its page, selected. */
  goTo(pageId: string, lineId: string): void;
  /** Give speech with no tail one; how many were added. */
  addTails(): number;
  /** Lay out again the panels whose dialogue reaches past their border; how many. */
  fitSpills(): number;
  /** Move the dialogue off the faces in the rough; how many lines were on one. */
  clearFaces(): number;
}

type Kind = "csp" | "pdf" | "text";

/** 見本のページ: kept on this computer for the next export. */
const DONOR_KEY = "namestudio.exportDonor";

function readDonor(): string {
  try {
    return localStorage.getItem(DONOR_KEY) ?? "";
  } catch {
    return "";
  }
}


const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class ExportDialog {
  private kind: Kind = "csp";
  private readonly form: ExportForm = {
    template: "",
    outDir: "",
    fit: "basic",
    makeWork: true,
    workTemplate: "",
    workName: "",
    storyIndex: "",
  };
  private editable = true;
  /** The rough written as 下描き layers at half opacity, to ink over. */
  private draftRough = true;
  /** Panels as a コマ枠フォルダー (copied from a finished page), with a layer in it to ink on. */
  private frameFolders = false;
  /** The name's memos as a 下描き layer, to see while inking. */
  private notes = true;
  private busy = false;
  /** A CSP page with text and vector layers to copy, when the template has none. */
  private donor = readDonor();

  constructor(private readonly host: ExportDialogHost) {
    for (const kind of ["csp", "pdf", "text"] as const) {
      $(`ne-kind-${kind}`).addEventListener("click", () => {
        this.kind = kind;
        this.show();
        this.message("");
      });
    }
    $("ne-pick-template").addEventListener("click", () => this.pick("template"));
    $("ne-pick-out-dir").addEventListener("click", () => this.pick("outDir"));
    $("ne-pick-work-template").addEventListener("click", () => this.pick("workTemplate"));
    $("ne-pick-donor").addEventListener("click", () => void this.pickDonor());
    $("ne-clear-donor").addEventListener("click", () => this.setDonor(""));
    $<HTMLInputElement>("ne-make-work").addEventListener("change", (event) => {
      this.form.makeWork = (event.target as HTMLInputElement).checked;
      this.show();
    });
    $<HTMLInputElement>("ne-editable").addEventListener("change", (event) => {
      this.editable = (event.target as HTMLInputElement).checked;
    });
    $<HTMLInputElement>("ne-draft").addEventListener("change", (event) => {
      this.draftRough = (event.target as HTMLInputElement).checked;
    });
    $<HTMLInputElement>("ne-notes").addEventListener("change", (event) => {
      this.notes = (event.target as HTMLInputElement).checked;
    });
    $<HTMLInputElement>("ne-frames").addEventListener("change", (event) => {
      this.frameFolders = (event.target as HTMLInputElement).checked;
    });
    $("ne-run").addEventListener("click", () => void this.run());
    $("ne-update").addEventListener("click", () => void this.update());
    $("ne-readback").addEventListener("click", () => void this.readBack());
  }

  open(): void {
    const project = this.host.project();
    if (!project) return;
    this.form.workName ||= project.title;
    if (!this.form.storyIndex && project.storyIndex !== undefined) this.form.storyIndex = String(project.storyIndex);
    this.show();
    this.message("");
    this.renderCheck(project);
    $<HTMLDialogElement>("name-export-dialog").showModal();
  }

  /** 書き出す前の確認: what will need fixing by hand afterwards, each one a click away. */
  private renderCheck(project: Project): void {
    const issues = checkName(project);
    const details = $<HTMLDetailsElement>("ne-check");
    details.classList.toggle("clean", !issues.length);
    $("ne-check-summary").textContent = issues.length
      ? `書き出す前の確認: ${issueSummary(issues)}（押すとそのセリフへ）`
      : "書き出す前の確認: フキダシの重なり・コマの外・はみ出し・仕上がりの外・しっぽなし・顔にかかるセリフはありません";
    const list = $("ne-check-list");
    list.replaceChildren(
      ...issues.slice(0, 60).map((issue) => {
        const item = document.createElement("button");
        item.type = "button";
        item.textContent = `${issue.page} ページ  ${ISSUE_LABELS[issue.kind]}  「${issue.text}」`;
        item.addEventListener("click", () => {
          $<HTMLDialogElement>("name-export-dialog").close();
          this.host.goTo(issue.pageId, issue.lineId);
        });
        return item;
      }),
    );
    if (issues.length > 60) list.append(Object.assign(document.createElement("p"), { className: "hint", textContent: `ほか ${issues.length - 60} 件` }));
    if (issues.some((issue) => issue.kind === "tail")) {
      const fix = Object.assign(document.createElement("button"), { type: "button", className: "fix", textContent: "しっぽのないセリフ全部にしっぽを付ける（コマのラフの人物へ向ける）" });
      fix.addEventListener("click", () => {
        this.host.addTails();
        const updated = this.host.project();
        if (updated) this.renderCheck(updated);
      });
      list.prepend(fix);
    }
    if (issues.some((issue) => issue.kind === "face")) {
      const fix = Object.assign(document.createElement("button"), { type: "button", className: "fix", textContent: "顔にかかるセリフをずらす（よけきれないコマは並べ直す）" });
      fix.addEventListener("click", () => {
        this.host.clearFaces();
        const updated = this.host.project();
        if (updated) this.renderCheck(updated);
      });
      list.prepend(fix);
    }
    if (issues.some((issue) => issue.kind === "spill")) {
      const fix = Object.assign(document.createElement("button"), { type: "button", className: "fix", textContent: "はみ出したセリフのコマを並べ直す（改行し直して細く）" });
      fix.addEventListener("click", () => {
        this.host.fitSpills();
        const updated = this.host.project();
        if (updated) this.renderCheck(updated);
      });
      list.prepend(fix);
    }
  }

  private sources(): string[] {
    const project = this.host.project();
    return [this.host.projectPath(), project?.source?.path].filter((path): path is string => !!path);
  }

  private show(): void {
    for (const kind of ["csp", "pdf", "text"] as const) {
      $(`ne-kind-${kind}`).classList.toggle("active", kind === this.kind);
      $(`ne-${kind}`).hidden = kind !== this.kind;
    }
    $("ne-update").hidden = this.kind !== "csp";
    $("ne-readback").hidden = this.kind !== "csp";
    const path = (id: string, value: string) => {
      $(id).textContent = value || "未選択";
      $(id).title = value;
    };
    path("ne-template", this.form.template);
    path("ne-out-dir", this.form.outDir);
    path("ne-work-template", this.form.workTemplate);
    path("ne-donor", this.donor);
    $("ne-clear-donor").hidden = !this.donor;
    $<HTMLInputElement>("ne-editable").checked = this.editable;
    $<HTMLInputElement>("ne-draft").checked = this.draftRough;
    $<HTMLInputElement>("ne-frames").checked = this.frameFolders;
    $<HTMLInputElement>("ne-notes").checked = this.notes;
    $<HTMLInputElement>("ne-make-work").checked = this.form.makeWork;
    $("ne-work-fields").hidden = !this.form.makeWork;
    $<HTMLInputElement>("ne-work-name").value = this.form.workName;
    $<HTMLInputElement>("ne-story-index").value = this.form.storyIndex;
  }

  private message(text: string, error = false): void {
    const node = $("ne-message");
    node.textContent = text;
    node.classList.toggle("error", error);
  }

  private async pick(field: "template" | "workTemplate" | "outDir"): Promise<void> {
    this.readFields();
    const start = this.form[field] ? folderOf(this.form[field]) : folderOf(this.sources()[0] ?? "");
    const path =
      field === "outDir"
        ? await open({ directory: true, defaultPath: this.form.outDir || start || undefined })
        : await open({
            multiple: false,
            defaultPath: start || undefined,
            filters:
              field === "template"
                ? [{ name: "CLIP STUDIO PAINT のページ", extensions: ["clip"] }]
                : [{ name: "CLIP STUDIO PAINT EX の作品", extensions: ["cmc"] }],
          });
    if (typeof path === "string") this.form[field] = path;
    this.show();
    this.message("");
  }

  private async pickDonor(): Promise<void> {
    const start = folderOf(this.donor || this.form.template || this.sources()[0] || "");
    const path = await open({ multiple: false, defaultPath: start || undefined, filters: [{ name: "CLIP STUDIO PAINT のページ", extensions: ["clip"] }] });
    if (typeof path === "string") this.setDonor(path);
  }

  private setDonor(path: string): void {
    this.donor = path;
    try {
      if (path) localStorage.setItem(DONOR_KEY, path);
      else localStorage.removeItem(DONOR_KEY);
    } catch {
      // Not kept for the next start.
    }
    this.show();
  }

  private readFields(): void {
    this.form.workName = $<HTMLInputElement>("ne-work-name").value;
    this.form.storyIndex = $<HTMLInputElement>("ne-story-index").value;
  }

  private async run(): Promise<void> {
    const project = this.host.project();
    if (!project || this.busy) return;
    this.readFields();
    const button = $<HTMLButtonElement>("ne-run");
    const progress = (text: string) => {
      this.message(text);
      this.host.status(text);
    };
    try {
      this.busy = true;
      button.disabled = true;
      const started = performance.now();
      const seconds = () => ((performance.now() - started) / 1000).toFixed(1);
      if (this.kind === "csp") {
        const request = buildRequest(this.form, this.sources());
        if (typeof request === "string") {
          this.message(request, true);
          return;
        }
        // 上書きの知らせ: pages there may have been drawn on in CSP since.
        const target = await invoke<OverwriteCheck>("check_export_target", { outDir: request.outDir }).catch(() => null);
        const warning = target && overwriteWarning(target);
        if (warning && !(await ask(warning, { title: "Name Studio", kind: "warning", okLabel: "上書きする", cancelLabel: "やめる" }))) {
          this.message("書き出しをやめました。CSP の作業を残すには、別のフォルダーを選んでください。");
          return;
        }
        const report = await exportToCsp(
          project,
          {
            template: request.template,
            outDir: request.outDir,
            workTemplate: request.workTemplate,
            workName: request.workName,
            storyIndex: request.storyIndex,
            inputs: this.sources(),
            donors: [this.donor, project.source?.path].filter((path): path is string => !!path),
            draftLayers: this.draftRough ? ROUGH_LAYERS : [],
            frameFolders: this.frameFolders,
            notes: this.notes,
          },
          this.editable,
          progress,
          (missing) =>
            ask(
              `ひな形・見本のページ・ネーム用紙に CSP の${missing.join("と")}のレイヤーがありません。このまま書き出すと、その部分は画像レイヤーになり、CSP で直せません。\n\n` +
                "CSP でテキストとベクター線を描いて保存したページを「見本のページ」に選ぶと、直せるレイヤーで書き出せます。",
              { title: "Name Studio", kind: "warning", okLabel: "画像のまま書き出す", cancelLabel: "やめて見本を選ぶ" },
            ),
        );
        if (!report) {
          this.message("書き出しをやめました。「見本のページ」に、CSP でテキストとベクター線を描いて保存したページ（.clip）を選んでください。");
          this.host.status("書き出しをやめました");
          return;
        }
        const spreads = report.spreads ? `（うち見開きページ ${report.spreads} 枚）` : "";
        const lines = [`${report.pages.length} 枚のページを書き出しました${spreads}（${seconds()} 秒）`];
        if (report.work) lines.push(`作品ファイル: ${report.work}`);
        lines.push(...(report.warnings ?? []));
        if (this.editable) {
          const missing = missingEditable(report);
          if (missing.length) lines.push(imagesNote(missing));
        }
        const check = checkSummary(report);
        lines.push(...check.lines);
        this.message(lines.join("\n"), !check.ok);
        this.host.status(
          check.ok
            ? `${report.pages.length} 枚のページを ${this.form.outDir} に書き出しました（自己確認 OK）`
            : `書き出したページに問題があります: ${check.lines[1]}`,
        );
      } else {
        const extension = this.kind === "pdf" ? "pdf" : "txt";
        const base = (this.host.projectPath() ?? project.title ?? "ネーム").replace(/\.[^.\\/]+$/, "");
        const path = await save({
          defaultPath: `${base}${this.kind === "text" ? "_台本" : ""}.${extension}`,
          filters: [{ name: this.kind === "pdf" ? "PDF" : "テキスト", extensions: [extension] }],
        });
        if (!path) return;
        if (this.sources().some((source) => source.toLowerCase() === path.toLowerCase())) {
          this.message("元のファイルには上書きできません", true);
          return;
        }
        if (this.kind === "pdf") {
          await exportPdf(
            project,
            path,
            {
              area: $<HTMLSelectElement>("ne-pdf-area").value as "trim" | "canvas",
              dpi: Number($<HTMLSelectElement>("ne-pdf-dpi").value),
            },
            (rough) => this.host.rough(rough),
            progress,
          );
        } else {
          await invoke("write_text_file", { path, text: scriptText(project) });
        }
        this.message(`書き出しました（${seconds()} 秒）: ${path}`);
        this.host.status(`書き出しました: ${path}`);
      }
    } catch (error) {
      this.message(`書き出せませんでした: ${error}`, true);
    } finally {
      this.busy = false;
      button.disabled = false;
    }
  }

  /** セリフだけ反映: the changed dialogue into pages drawn on in CSP since the export. */
  private async update(): Promise<void> {
    const project = this.host.project();
    if (!project || this.busy) return;
    this.readFields();
    const request = buildRequest(this.form, this.sources());
    if (typeof request === "string") {
      this.message(request, true);
      return;
    }
    const target = await invoke<OverwriteCheck>("check_export_target", { outDir: request.outDir }).catch(() => null);
    if (!target?.existing.some((name) => name.toLowerCase().endsWith(".clip"))) {
      this.message("書き出し先に CSP のページがありません。前に書き出したフォルダーを選んでください", true);
      return;
    }
    const go = await ask(
      `${request.outDir} のページに、ネームで変わったセリフとフキダシだけを入れます。\n\n` +
        "・描いたレイヤーやほかのレイヤーはそのままです\n" +
        "・前のセリフとフキダシは消さずに隠し、名前の頭に「（旧）」を付けます（見比べてから CSP で消せます）\n" +
        "・CSP で直したセリフや足したテキストはそのままです\n" +
        "・「メモ（ネーム）」レイヤーは、メモが変わっていれば描き直します\n" +
        "・変える前のページは name-studio-backup フォルダーに控えます\n\n" +
        "CSP でページを開いていたら、保存して閉じてから続けてください。書き出したときと同じひな形・ページ数で反映します。",
      { title: "Name Studio", kind: "info", okLabel: "反映する", cancelLabel: "やめる" },
    );
    if (!go) return;
    const button = $<HTMLButtonElement>("ne-update");
    try {
      this.busy = true;
      button.disabled = true;
      const summary = await updateCspDialogue(
        project,
        {
          template: request.template,
          outDir: request.outDir,
          workTemplate: null,
          workName: null,
          storyIndex: null,
          inputs: this.sources(),
          donors: [this.donor, project.source?.path].filter((path): path is string => !!path),
          notes: this.notes,
        },
        (text) => {
          this.message(text);
          this.host.status(text);
        },
      );
      const result = dialogueUpdateSummary(summary);
      this.message(result.lines.join("\n"), !result.ok);
      this.host.status(result.lines[0]);
    } catch (error) {
      this.message(`反映できませんでした: ${error}`, true);
    } finally {
      this.busy = false;
      button.disabled = false;
    }
  }

  /** CSP のセリフを読み戻す: dialogue retyped, added or deleted in CSP since the export, into the name. */
  private async readBack(): Promise<void> {
    const project = this.host.project();
    if (!project || this.busy) return;
    this.readFields();
    const request = buildRequest(this.form, this.sources());
    if (typeof request === "string") {
      this.message(request, true);
      return;
    }
    const target = await invoke<OverwriteCheck>("check_export_target", { outDir: request.outDir }).catch(() => null);
    if (!target?.existing.some((name) => name.toLowerCase().endsWith(".clip"))) {
      this.message("書き出し先に CSP のページがありません。前に書き出したフォルダーを選んでください", true);
      return;
    }
    const button = $<HTMLButtonElement>("ne-readback");
    try {
      this.busy = true;
      button.disabled = true;
      const units = await readCspDialogue(
        project,
        {
          template: request.template,
          outDir: request.outDir,
          workTemplate: null,
          workName: null,
          storyIndex: null,
          inputs: this.sources(),
          donors: [this.donor, project.source?.path].filter((path): path is string => !!path),
        },
        (text) => this.message(text),
      );
      const plan = planTakeBack(project, units);
      const summary = takeBackSummary(plan);
      const changes = plan.retyped.length + plan.added.length + plan.removed.length;
      if (!changes) {
        this.message(["CSP で直したセリフはありませんでした", ...summary].join("\n"));
        return;
      }
      const go = await ask(`${request.outDir} のページで CSP で変えたセリフを、ネームに入れます。\n\n${summary.join("\n")}\n\nネームで変えたところはそのままです。元に戻すは Ctrl+Z。`, {
        title: "Name Studio",
        kind: "info",
        okLabel: "読み戻す",
        cancelLabel: "やめる",
      });
      if (!go) {
        this.message("読み戻しませんでした");
        return;
      }
      this.host.edit((p) => applyTakeBack(p, plan));
      // From now on these texts count as the name's: セリフだけ反映 leaves them as they are.
      await invoke("adopt_name_dialogue", { paths: plan.paths });
      const done = `CSP のセリフを読み戻しました（直した ${plan.retyped.length}・足した ${plan.added.length}・消した ${plan.removed.length}）。元に戻すは Ctrl+Z`;
      this.message([done, ...summary.filter((line) => !/^CSP で(直した|足した|消した)/.test(line))].join("\n"));
      this.host.status(done);
    } catch (error) {
      this.message(`読み戻せませんでした: ${error}`, true);
    } finally {
      this.busy = false;
      button.disabled = false;
    }
  }
}

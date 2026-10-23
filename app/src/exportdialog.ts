// The dialog that writes the name data out (CSP pages and work, PDF, script).
import { invoke } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { buildRequest, folderOf, overwriteWarning, type ExportForm, type OverwriteCheck } from "./export";
import { checkSummary, exportPdf, exportToCsp, scriptText } from "./nameexport";
import type { Project, RoughImage } from "./project";

export interface ExportDialogHost {
  project(): Project | null;
  /** Where the name data is saved, if it is. */
  projectPath(): string | null;
  rough(rough: RoughImage): Promise<CanvasImageSource | null>;
  status(message: string): void;
}

type Kind = "csp" | "pdf" | "text";


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
  private busy = false;

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
    $<HTMLInputElement>("ne-make-work").addEventListener("change", (event) => {
      this.form.makeWork = (event.target as HTMLInputElement).checked;
      this.show();
    });
    $<HTMLInputElement>("ne-editable").addEventListener("change", (event) => {
      this.editable = (event.target as HTMLInputElement).checked;
    });
    $("ne-run").addEventListener("click", () => void this.run());
  }

  open(): void {
    const project = this.host.project();
    if (!project) return;
    this.form.workName ||= project.title;
    if (!this.form.storyIndex && project.storyIndex !== undefined) this.form.storyIndex = String(project.storyIndex);
    this.show();
    this.message("");
    $<HTMLDialogElement>("name-export-dialog").showModal();
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
    const path = (id: string, value: string) => {
      $(id).textContent = value || "未選択";
      $(id).title = value;
    };
    path("ne-template", this.form.template);
    path("ne-out-dir", this.form.outDir);
    path("ne-work-template", this.form.workTemplate);
    $<HTMLInputElement>("ne-editable").checked = this.editable;
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
            donors: project.source ? [project.source.path] : [],
          },
          this.editable,
          progress,
        );
        const spreads = report.spreads ? `（うち見開きページ ${report.spreads} 枚）` : "";
        const lines = [`${report.pages.length} 枚のページを書き出しました${spreads}（${seconds()} 秒）`];
        if (report.work) lines.push(`作品ファイル: ${report.work}`);
        lines.push(...(report.warnings ?? []));
        if (this.editable) {
          const missing = [!report.vectorLayers && "ベクター線", !report.textLayers && "テキスト"].filter(Boolean);
          if (missing.length) {
            lines.push(
              `ひな形とネーム用紙に CSP の${missing.join("と")}レイヤーが見つからないため、その部分は画像レイヤーにしました。` +
                "CSP の .clip のネーム用紙から取り込んだネームなら、用紙の線やテキストを写して使えます。",
            );
          }
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
}

// The dialog that writes the name data out (CSP pages and work, PDF, script).
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { buildRequest, folderOf, type ExportForm } from "./export";
import { exportPdf, exportToCsp, scriptText } from "./nameexport";
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
        const report = await exportToCsp(
          project,
          {
            template: request.template,
            outDir: request.outDir,
            workTemplate: request.workTemplate,
            workName: request.workName,
            storyIndex: request.storyIndex,
            inputs: this.sources(),
          },
          progress,
        );
        const lines = [`${report.pages.length} ページを書き出しました（${seconds()} 秒）`];
        if (report.work) lines.push(`作品ファイル: ${report.work}`);
        this.message(lines.join("\n"));
        this.host.status(`${report.pages.length} ページを ${this.form.outDir} に書き出しました`);
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

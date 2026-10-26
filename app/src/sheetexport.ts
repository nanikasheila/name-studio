// Writing the pages of an open name sheet out as CLIP STUDIO PAINT pages (and
// a work), from the viewer: the template, the folder and how the name layers
// fit the page, chosen in a dialog.
import { open } from "@tauri-apps/plugin-dialog";
import { call } from "./backend";
import { $ } from "./dom";
import { buildRequest, folderOf, summarize, type ExportForm, type Fit } from "./export";

export class SheetExport {
  private readonly form: ExportForm = {
    template: "",
    outDir: "",
    fit: "basic",
    makeWork: true,
    workTemplate: "",
    workName: "",
    storyIndex: "",
  };

  constructor(
    /** Where the sheet open now is ("" when none is). */
    private readonly sheetPath: () => string,
    private readonly setStatus: (message: string) => void,
  ) {
    $("export").addEventListener("click", () => void this.open());
    $("pick-template").addEventListener("click", () => void this.pick("template"));
    $("pick-out-dir").addEventListener("click", () => void this.pick("outDir"));
    $("pick-work-template").addEventListener("click", () => void this.pick("workTemplate"));
    $("export-make-work").addEventListener("change", (event) => {
      this.form.makeWork = (event.target as HTMLInputElement).checked;
      $("work-fields").hidden = !this.form.makeWork;
    });
    $("export-run").addEventListener("click", () => void this.run());
  }

  private show(): void {
    const form = this.form;
    const show = (id: string, path: string) => {
      $(id).textContent = path || "未選択";
      $(id).title = path;
    };
    show("export-template", form.template);
    show("export-out-dir", form.outDir);
    show("export-work-template", form.workTemplate);
    $<HTMLSelectElement>("export-fit").value = form.fit;
    $<HTMLInputElement>("export-make-work").checked = form.makeWork;
    $("work-fields").hidden = !form.makeWork;
    $<HTMLInputElement>("export-work-name").value = form.workName;
    $<HTMLInputElement>("export-story-index").value = form.storyIndex;
  }

  private message(text: string, error = false): void {
    const message = $("export-message");
    message.textContent = text;
    message.classList.toggle("error", error);
  }

  private async open(): Promise<void> {
    if (!this.sheetPath()) return;
    try {
      const defaults = await call("export_defaults");
      if (!this.form.workTemplate && defaults.workTemplate) this.form.workTemplate = defaults.workTemplate;
      this.form.workName ||= defaults.workName;
    } catch (error) {
      this.setStatus(String(error));
    }
    this.show();
    this.message("");
    $<HTMLDialogElement>("export-dialog").showModal();
  }

  private async pick(field: "template" | "workTemplate" | "outDir"): Promise<void> {
    const form = this.form;
    const start = form[field] ? folderOf(form[field]) : folderOf(this.sheetPath());
    const path =
      field === "outDir"
        ? await open({ directory: true, defaultPath: form.outDir || start })
        : await open({
            multiple: false,
            defaultPath: start || undefined,
            filters: field === "template" ? [{ name: "CLIP STUDIO PAINT のページ", extensions: ["clip"] }] : [{ name: "CLIP STUDIO PAINT EX の作品", extensions: ["cmc"] }],
          });
    if (typeof path === "string") form[field] = path;
    this.show();
    this.message("");
  }

  private async run(): Promise<void> {
    const form = this.form;
    form.fit = $<HTMLSelectElement>("export-fit").value as Fit;
    form.makeWork = $<HTMLInputElement>("export-make-work").checked;
    form.workName = $<HTMLInputElement>("export-work-name").value;
    form.storyIndex = $<HTMLInputElement>("export-story-index").value;
    const request = buildRequest(form, this.sheetPath());
    if (typeof request === "string") {
      this.message(request, true);
      return;
    }
    const button = $<HTMLButtonElement>("export-run");
    button.disabled = true;
    this.message("書き出し中…");
    const started = performance.now();
    try {
      const report = await call("export_pages", { request });
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      this.message(summarize(report).join("\n"));
      this.setStatus(`${report.pages.length} ページを ${form.outDir} に書き出しました（${seconds} 秒）`);
    } catch (error) {
      this.message(String(error), true);
    } finally {
      button.disabled = false;
    }
  }
}

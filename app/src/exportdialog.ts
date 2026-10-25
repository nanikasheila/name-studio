// The dialog that writes the name data out (CSP pages and work, PDF, script).
import { call } from "./backend";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { buildRequest, folderOf, overwriteWarning, type ExportForm } from "./export";
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
import { $, element } from "./dom";
import { readText, writeText } from "./settings";
import { cspPageOf, firstPageLeft, joinedPage, pageSetup, piecesPerPage, pixelSize, presetOf, PRESETS, setupProblem, withPreset } from "./csppage";
import type { CspPage } from "./model";
import { fontField } from "./fontpicker";
import { installedFont } from "./fonts";

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
  return readText(DONOR_KEY) ?? "";
}

/** How the CSP pages are made: from the settings here, or from a CSP-made template. */
type TemplateMode = "builtin" | "file";
const MODE_KEY = "namestudio.exportTemplateMode";

/** How panels go to CSP (kept on this computer for the next export). */
type PanelExport = "lines" | "masks" | "frames";
const PANELS_KEY = "namestudio.exportPanels";

function readPanels(): PanelExport {
  const value = readText(PANELS_KEY);
  return value === "masks" || value === "frames" ? value : "lines";
}

const PANEL_HINTS: Record<PanelExport, string> = {
  lines: "コマ枠を線で書き、ラフ線はページに 1 枚のレイヤーにします。",
  masks:
    "コマごとにフォルダー「コマ1」「コマ2」…を作り、コマの形（はみ出しの範囲を含む）のレイヤーマスクを付けます。コマのラフ線と空の「ペン入れ」レイヤーが中に入り、コマの外に出た線は切らずにマスクで隠すだけです。飛び出させたいところは CSP でマスクを描き足してください。コマ枠の線はフォルダーの上に置きます。",
  frames:
    "コマを CSP のコマ枠フォルダー「コマ」にし、中に空の「ペン入れ」レイヤーを入れます（試験中）。コマ枠フォルダーを作って保存した CSP のページを見本に選んでください。",
};

/** The CSP page's number fields, with where each goes in a `CspPage`. */
const PAGE_FIELDS: [string, (page: CspPage) => number, (page: CspPage, value: number) => void][] = [
  ["ne-canvas-w", (p) => p.canvasMm[0], (p, v) => (p.canvasMm[0] = v)],
  ["ne-canvas-h", (p) => p.canvasMm[1], (p, v) => (p.canvasMm[1] = v)],
  ["ne-trim-w", (p) => p.trimMm[0], (p, v) => (p.trimMm[0] = v)],
  ["ne-trim-h", (p) => p.trimMm[1], (p, v) => (p.trimMm[1] = v)],
  ["ne-bleed", (p) => p.bleedMm, (p, v) => (p.bleedMm = v)],
  ["ne-basic-w", (p) => p.basicMm[0], (p, v) => (p.basicMm[0] = v)],
  ["ne-basic-h", (p) => p.basicMm[1], (p, v) => (p.basicMm[1] = v)],
  ["ne-basic-x", (p) => p.basicOffsetMm[0], (p, v) => (p.basicOffsetMm[0] = v)],
  ["ne-basic-y", (p) => p.basicOffsetMm[1], (p, v) => (p.basicOffsetMm[1] = v)],
];

/** What the pages are written from: the template page and work, and pages to copy layers from. */
interface Templates {
  template: string;
  workTemplate: string;
  donors: string[];
  /** 縦スクロール, joined: pieces on each page of the built-in template. */
  pieces?: number;
}


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
  /** How panels go to CSP: border lines only, a folder with a layer mask each, or a コマ枠フォルダー. */
  private panels: PanelExport = readPanels();
  /** The name's memos as a 下描き layer, to see while inking. */
  private notes = true;
  private busy = false;
  /** A CSP page with text and vector layers to copy, when the template has none. */
  private donor = readDonor();
  private mode: TemplateMode = readText(MODE_KEY) === "file" ? "file" : "builtin";
  /** CSP のページ設定 being edited (the name's, saved with it on writing out). */
  private page: CspPage | null = null;
  private author = "";

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
    $<HTMLSelectElement>("ne-panels").addEventListener("change", (event) => {
      this.panels = (event.target as HTMLSelectElement).value as PanelExport;
      writeText(PANELS_KEY, this.panels);
      this.show();
    });
    for (const mode of ["builtin", "file"] as const) {
      $(`ne-mode-${mode}`).addEventListener("click", () => {
        this.readFields();
        this.mode = mode;
        writeText(MODE_KEY, mode);
        this.show();
        this.message("");
      });
    }
    const presets = $<HTMLSelectElement>("ne-preset");
    presets.replaceChildren(
      element("option", { value: "", textContent: "手で決める" }),
      ...PRESETS.map((preset) => element("option", { value: preset.id, textContent: preset.label })),
    );
    presets.addEventListener("change", () => {
      if (!this.page || !presets.value) return;
      this.page = withPreset(this.readPage(this.page), presets.value);
      this.showPage();
    });
    for (const [id] of PAGE_FIELDS) $(id).addEventListener("input", () => this.pageChanged());
    for (const id of ["ne-dpi", "ne-first-side", "ne-nombre-start", "ne-join-pieces"]) $(id).addEventListener("change", () => this.pageChanged());
    $("ne-run").addEventListener("click", () => void this.run());
    $("ne-update").addEventListener("click", () => void this.update());
    $("ne-readback").addEventListener("click", () => void this.readBack());
  }

  open(): void {
    const project = this.host.project();
    if (!project) return;
    this.form.workName ||= project.title;
    if (!this.form.storyIndex && project.storyIndex !== undefined) this.form.storyIndex = String(project.storyIndex);
    this.page = cspPageOf(project);
    this.author = project.author;
    this.showPage();
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
    const builtin = this.mode === "builtin";
    for (const mode of ["builtin", "file"] as const) $(`ne-mode-${mode}`).classList.toggle("active", mode === this.mode);
    $("ne-builtin").hidden = !builtin;
    for (const id of ["ne-template-label", "ne-template", "ne-pick-template", "ne-template-hint", "ne-work-template-label", "ne-work-template", "ne-pick-work-template"]) {
      $(id).hidden = builtin;
    }
    $<HTMLInputElement>("ne-story-index").placeholder = builtin ? "なし" : "ひな形のまま";
    path("ne-template", this.form.template);
    path("ne-out-dir", this.form.outDir);
    path("ne-work-template", this.form.workTemplate);
    path("ne-donor", this.donor);
    $("ne-clear-donor").hidden = !this.donor;
    $<HTMLInputElement>("ne-editable").checked = this.editable;
    $<HTMLInputElement>("ne-draft").checked = this.draftRough;
    $<HTMLSelectElement>("ne-panels").value = this.panels;
    $("ne-panels-hint").textContent = PANEL_HINTS[this.panels];
    $<HTMLInputElement>("ne-notes").checked = this.notes;
    $<HTMLInputElement>("ne-make-work").checked = this.form.makeWork;
    $("ne-work-fields").hidden = !this.form.makeWork;
    const project = this.host.project();
    const left = project?.binding === "left";
    const hint = $("ne-binding-hint");
    hint.hidden = !left || builtin;
    hint.textContent = project?.scroll
      ? "このネームは縦スクロールです。区切りごとに CSP のページになり、ページはひな形の基本枠に合わせて置かれます。区切りと同じ縦横比（幅 120 × 高さ 240 mm など）で作った CSP のページをひな形にしてください。作品（.cmc）は区切りを順に並べたものになります。"
      : "このネームは左綴じです。作品の綴じ方はひな形の作品のままになるので、CSP で左綴じにして保存した作品をひな形に選んでください（ページの中身は左から右へ読む並びで書き出します）。";
    $("ne-pdf-binding").textContent = left ? "左綴じ" : "右綴じ";
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
    writeText(DONOR_KEY, path || null);
    this.show();
  }

  private readFields(): void {
    this.form.workName = $<HTMLInputElement>("ne-work-name").value;
    this.form.storyIndex = $<HTMLInputElement>("ne-story-index").value;
    if (this.page) this.page = this.readPage(this.page);
    this.author = $<HTMLInputElement>("ne-author").value;
  }

  /** `page` with what the CSP page fields hold (a field left empty keeps its value). */
  private readPage(page: CspPage): CspPage {
    const next = structuredClone(page);
    for (const [id, , set] of PAGE_FIELDS) {
      const input = $<HTMLInputElement>(id);
      const value = input.valueAsNumber;
      if (Number.isFinite(value)) set(next, value);
    }
    next.resolution = Number($<HTMLSelectElement>("ne-dpi").value) || next.resolution;
    const project = this.host.project();
    const left = $<HTMLSelectElement>("ne-first-side").value === "left";
    // Kept only when it differs from what the binding has.
    if (project && left === firstPageLeft(project, { ...next, firstPageLeft: undefined })) delete next.firstPageLeft;
    else next.firstPageLeft = left;
    const start = $<HTMLInputElement>("ne-nombre-start").valueAsNumber;
    if (Number.isInteger(start) && start !== 1) next.nombreStart = start;
    else delete next.nombreStart;
    if (project?.scroll && $<HTMLInputElement>("ne-join-pieces").checked) next.joinPieces = true;
    else delete next.joinPieces;
    return next;
  }

  /** Fill the CSP page fields from `this.page`. */
  private showPage(): void {
    const page = this.page;
    const project = this.host.project();
    if (!page || !project) return;
    for (const [id, get] of PAGE_FIELDS) $<HTMLInputElement>(id).value = String(get(page));
    const dpi = $<HTMLSelectElement>("ne-dpi");
    if (![...dpi.options].some((option) => Number(option.value) === page.resolution)) {
      dpi.append(element("option", { value: String(page.resolution), textContent: String(page.resolution) }));
    }
    dpi.value = String(page.resolution);
    $<HTMLSelectElement>("ne-first-side").value = firstPageLeft(project, page) ? "left" : "right";
    $<HTMLInputElement>("ne-nombre-start").value = String(page.nombreStart ?? 1);
    $<HTMLInputElement>("ne-join-pieces").checked = !!page.joinPieces;
    for (const row of document.querySelectorAll<HTMLElement>(".ne-join")) row.hidden = !project.scroll;
    $<HTMLInputElement>("ne-author").value = this.author;
    $("ne-binding-label").textContent = project.scroll ? "縦スクロール（左綴じとして作ります）" : project.binding === "left" ? "左綴じ（ネームの綴じ方）" : "右綴じ（ネームの綴じ方）";
    $("ne-story-font").replaceChildren(
      fontField(page.font ?? "", "ＭＳ ゴシック（内蔵の既定）", (name) => {
        if (!this.page) return;
        if (name) this.page.font = name;
        else delete this.page.font;
      }, "作品情報（作品名・話数・作者名）とノンブルの書体", "作品名 1話"),
    );
    this.pageChanged();
  }

  /** After a CSP page field changed: the preset it matches and the size in px. */
  private pageChanged(): void {
    if (!this.page) return;
    this.page = this.readPage(this.page);
    $<HTMLSelectElement>("ne-preset").value = presetOf(this.page) ?? "";
    const [w, h] = pixelSize(this.page);
    $("ne-px").textContent = `${w} × ${h} px`;
    const project = this.host.project();
    const pieces = project ? piecesPerPage(project, this.page) : 1;
    $("ne-join-info").textContent = pieces > 1 ? `${pieces} 区切りで 1 ページ（${w} × ${pixelSize(joinedPage(this.page, pieces))[1]} px、${Math.ceil(project!.pages.length / pieces)} ページ）` : "";
  }

  /**
   * The template page and work to write from: the chosen CSP files, or the
   * built-in ones made for the settings here (which are then kept with the name).
   */
  private async templates(project: Project): Promise<Templates | string> {
    if (this.mode === "file" || !this.page) return { template: this.form.template, workTemplate: this.form.workTemplate, donors: [] };
    const storyIndex = this.form.storyIndex.trim() ? Number(this.form.storyIndex) : null;
    if (storyIndex !== null && !(Number.isInteger(storyIndex) && storyIndex >= 0)) return "話数は 0 以上の整数で入力してください";
    const setup = pageSetup(project, this.page, { title: this.form.workName, storyIndex, author: this.author }, (name) => installedFont(name)?.postscript);
    const problem = setupProblem(setup);
    if (problem) return problem;
    const built = await call("prepare_builtin_template", { setup });
    const page = this.page;
    const author = this.author.trim();
    if (JSON.stringify(project.cspPage ?? null) !== JSON.stringify(page) || project.author !== author) {
      this.host.edit((p) => {
        p.cspPage = structuredClone(page);
        p.author = author;
      });
    }
    return { template: built.page, workTemplate: built.work, donors: [built.parts], pieces: piecesPerPage(project, page) };
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
        const templates = await this.templates(project);
        const request = typeof templates === "string" ? templates : buildRequest({ ...this.form, template: templates.template, workTemplate: templates.workTemplate }, this.sources());
        if (typeof request === "string" || typeof templates === "string") {
          this.message(String(request), true);
          return;
        }
        // 上書きの知らせ: pages there may have been drawn on in CSP since.
        const target = await call("check_export_target", { outDir: request.outDir }).catch(() => null);
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
            donors: [this.donor, project.source?.path, ...templates.donors].filter((path): path is string => !!path),
            draftLayers: this.draftRough ? ROUGH_LAYERS : [],
            frameFolders: this.panels === "frames",
            panelMasks: this.panels === "masks",
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
          templates.pieces,
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
          await call("write_text_file", { path, text: scriptText(project) });
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
    const templates = await this.templates(project);
    const request = typeof templates === "string" ? templates : buildRequest({ ...this.form, template: templates.template, workTemplate: templates.workTemplate }, this.sources());
    if (typeof request === "string" || typeof templates === "string") {
      this.message(String(request), true);
      return;
    }
    const target = await call("check_export_target", { outDir: request.outDir }).catch(() => null);
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
          donors: [this.donor, project.source?.path, ...templates.donors].filter((path): path is string => !!path),
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
    const templates = await this.templates(project);
    const request = typeof templates === "string" ? templates : buildRequest({ ...this.form, template: templates.template, workTemplate: templates.workTemplate }, this.sources());
    if (typeof request === "string" || typeof templates === "string") {
      this.message(String(request), true);
      return;
    }
    const target = await call("check_export_target", { outDir: request.outDir }).catch(() => null);
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
          donors: [this.donor, project.source?.path, ...templates.donors].filter((path): path is string => !!path),
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
      await call("adopt_name_dialogue", { paths: plan.paths });
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

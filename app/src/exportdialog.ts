// The dialog that writes the name data out (CSP pages and work, PDF, script).
import { call } from "./backend";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { buildRequest, folderOf, overwriteWarning, type ExportForm } from "./export";
import {
  checkSummary,
  dialogueUpdateSummary,
  exportPdf,
  exportToCsp,
  ExportStopped,
  imagesNote,
  missingEditable,
  readCspDialogue,
  ROUGH_LAYERS,
  scriptText,
  updateCspDialogue,
} from "./nameexport";
import { applyTakeBack, planTakeBack, takeBackSummary } from "./readback";
import { ISSUE_LABELS, checkName, issueSummary } from "./namecheck";
import { $, element } from "./dom";
import { readText, writeText } from "./settings";
import { compactStory, cspPageOf, firstPageLeft, joinedPage, pageSetup, piecesPerPage, pixelSize, presetOf, PRESETS, setupProblem, withPreset } from "./csppage";
import type { CspPage, CspStory, NombrePlace, Project, RoughImage, StoryPosition } from "./model";
import { fontField } from "./fontpicker";
import { chooseTakeBack } from "./readbackpick";
import { againSummary, exportSummary, type ExportKind, type ExportMemory, type PanelExport, type TemplateMode } from "./exportmemory";
import { keepExportMemory, loadExportMemory } from "./prefs";
import { installedFont } from "./fonts";
import { hasMarks } from "./roughlayers";

export interface ExportDialogHost {
  project(): Project | null;
  /** Where the name data is saved, if it is. */
  projectPath(): string | null;
  /** Which opened name it is (a new one per name opened, even unsaved ones). */
  projectId(): number;
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

type Kind = ExportKind;

/** 見本のページ: kept on this computer for the next export. */
const DONOR_KEY = "namestudio.exportDonor";

function readDonor(): string {
  return readText(DONOR_KEY) ?? "";
}

/** How the CSP pages are made: from the settings here, or from a CSP-made template. */
const MODE_KEY = "namestudio.exportTemplateMode";
/** Whether 詳しい設定 was left open. */
const MORE_KEY = "namestudio.exportMoreOpen";

/** How panels go to CSP (kept on this computer for the next export). */
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

/** The fields of the 作品情報・ノンブル settings besides 作品名・話数・作者名. */
const STORY_FIELDS = [
  "ne-subtitle",
  "ne-title-pos",
  "ne-author-pos",
  "ne-page-number",
  "ne-page-number-start",
  "ne-page-number-pos",
  "ne-nombre-place",
  "ne-nombre-color",
  "ne-nombre-edge",
  "ne-nombre-edge-mm",
  "ne-nombre-size",
  "ne-nombre-prefix",
  "ne-nombre-suffix",
  "ne-nombre-x",
  "ne-nombre-y",
];

/** What the story fields say (none: CSP's defaults). */
function readStory(): CspStory | undefined {
  const value = (id: string) => $<HTMLInputElement | HTMLSelectElement>(id).value;
  const number = (id: string, fallback: number) => {
    const read = $<HTMLInputElement>(id).valueAsNumber;
    return Number.isFinite(read) ? read : fallback;
  };
  const checked = (id: string) => $<HTMLInputElement>(id).checked;
  const story: CspStory = {
    subtitle: value("ne-subtitle"),
    titlePosition: value("ne-title-pos") as StoryPosition,
    authorPosition: value("ne-author-pos") as StoryPosition,
  };
  if (checked("ne-page-number")) story.pageNumber = { start: Math.max(0, Math.round(number("ne-page-number-start", 1))), position: value("ne-page-number-pos") as StoryPosition };
  const place = value("ne-nombre-place");
  if (place !== "hidden") {
    story.nombre = {
      place: place as NombrePlace,
      white: value("ne-nombre-color") === "white",
      edgeMm: checked("ne-nombre-edge") ? number("ne-nombre-edge-mm", 0.3) : undefined,
      prefix: value("ne-nombre-prefix"),
      suffix: value("ne-nombre-suffix"),
      offsetMm: [number("ne-nombre-x", 0), number("ne-nombre-y", 5)],
      sizePt: number("ne-nombre-size", 9),
    };
  }
  return compactStory(story);
}

/** Fill the story fields from `story`. */
function showStory(story: CspStory | undefined): void {
  const set = (id: string, value: string) => ($<HTMLInputElement | HTMLSelectElement>(id).value = value);
  set("ne-subtitle", story?.subtitle ?? "");
  set("ne-title-pos", story?.titlePosition ?? "left");
  set("ne-author-pos", story?.authorPosition ?? "center");
  $<HTMLInputElement>("ne-page-number").checked = !!story?.pageNumber;
  set("ne-page-number-start", String(story?.pageNumber?.start ?? 1));
  set("ne-page-number-pos", story?.pageNumber?.position ?? "right");
  const nombre = story?.nombre;
  set("ne-nombre-place", nombre?.place ?? "hidden");
  set("ne-nombre-color", nombre?.white ? "white" : "black");
  $<HTMLInputElement>("ne-nombre-edge").checked = nombre?.edgeMm !== undefined;
  set("ne-nombre-edge-mm", String(nombre?.edgeMm ?? 0.3));
  set("ne-nombre-size", String(nombre?.sizePt ?? 9));
  set("ne-nombre-prefix", nombre?.prefix ?? "");
  set("ne-nombre-suffix", nombre?.suffix ?? "");
  set("ne-nombre-x", String(nombre?.offsetMm?.[0] ?? 0));
  set("ne-nombre-y", String(nombre?.offsetMm?.[1] ?? 5));
  showStoryRows();
}

/** The rows of a shown ノンブル only with one; the ページ番号's settings only with it. */
function showStoryRows(): void {
  const shown = $<HTMLSelectElement>("ne-nombre-place").value !== "hidden";
  for (const row of document.querySelectorAll<HTMLElement>(".ne-shown")) row.hidden = !shown;
  const numbered = $<HTMLInputElement>("ne-page-number").checked;
  for (const id of ["ne-page-number-start", "ne-page-number-pos"]) $<HTMLInputElement>(id).disabled = !numbered;
  $<HTMLInputElement>("ne-nombre-edge-mm").disabled = !$<HTMLInputElement>("ne-nombre-edge").checked;
}

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
  /** 指示 (the 指示のレイヤー): to CSP as 下描き layers, onto the PDF's pages. */
  private marks = true;
  private busy = false;
  /** 中止 was pressed: the export stops at the next page. */
  private stopping = false;
  /** A CSP page with text and vector layers to copy, when the template has none. */
  private donor = readDonor();
  private mode: TemplateMode = readText(MODE_KEY) === "file" ? "file" : "builtin";
  /** CSP のページ設定 being edited (the name's, saved with it on writing out). */
  private page: CspPage | null = null;
  private author = "";
  /** The name the settings here are for (another name starts from its own last export). */
  /** The opened name (`projectId`) the form is for. */
  private settingsFor: number | null = null;

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
      this.showSummary();
    });
    $<HTMLInputElement>("ne-draft").addEventListener("change", (event) => {
      this.draftRough = (event.target as HTMLInputElement).checked;
      this.showSummary();
    });
    $<HTMLInputElement>("ne-notes").addEventListener("change", (event) => {
      this.notes = (event.target as HTMLInputElement).checked;
      this.showSummary();
    });
    for (const id of ["ne-marks", "ne-pdf-marks"]) {
      $<HTMLInputElement>(id).addEventListener("change", (event) => {
        this.marks = (event.target as HTMLInputElement).checked;
        for (const other of ["ne-marks", "ne-pdf-marks"]) $<HTMLInputElement>(other).checked = this.marks;
        this.showSummary();
      });
    }
    $<HTMLInputElement>("ne-work-name").addEventListener("input", (event) => {
      this.form.workName = (event.target as HTMLInputElement).value;
      this.showSummary();
    });
    for (const id of ["ne-pdf-area", "ne-pdf-dpi"]) $(id).addEventListener("change", () => this.showSummary());
    const more = $<HTMLDetailsElement>("ne-more");
    more.open = readText(MORE_KEY) === "open";
    more.addEventListener("toggle", () => writeText(MORE_KEY, more.open ? "open" : null));
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
    for (const id of ["ne-dpi", "ne-first-side", "ne-nombre-start", "ne-join-pieces", ...STORY_FIELDS]) $(id).addEventListener("change", () => this.pageChanged());
    $("ne-run").addEventListener("click", () => void this.run());
    $("ne-stop").addEventListener("click", () => {
      this.stopping = true;
      const stop = $<HTMLButtonElement>("ne-stop");
      stop.disabled = true;
      stop.textContent = "中止しています…";
    });
    $("ne-update").addEventListener("click", () => void this.update());
    $("ne-readback").addEventListener("click", () => void this.readBack());
  }

  open(): void {
    const project = this.host.project();
    if (!project) return;
    const path = this.host.projectPath();
    // Another name: its own last export, else nothing from the one before
    // (two unsaved names have no path to tell them apart).
    if (this.host.projectId() !== this.settingsFor) {
      this.settingsFor = this.host.projectId();
      const memory = path ? loadExportMemory(path) : null;
      if (memory) this.apply(memory);
      else this.forgetOtherName();
    }
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

  /**
   * 前回と同じ設定で書き出す: this name's last export again, with no choices to
   * make (the dialog shows how it goes). The first time, the dialog is opened
   * to choose.
   */
  async exportAgain(): Promise<void> {
    if (!this.host.project() || this.busy) return;
    const path = this.host.projectPath();
    const memory = path ? loadExportMemory(path) : null;
    this.open();
    const what = againSummary(memory);
    if (!memory || !what) {
      this.message(
        path
          ? "このネームはこの PC でまだ書き出していません。設定を選んで「書き出す」を押すと、次からは「前回と同じ設定で書き出す」（Ctrl+Shift+E）でそのまま書き出せます。"
          : "ネームを保存すると、書き出しの設定をネームごとに覚えます。設定を選んで「書き出す」を押してください。",
      );
      return;
    }
    this.apply(memory);
    this.show();
    this.host.status(`前回と同じ設定で書き出します: ${what}`);
    await this.run(true);
  }

  /**
   * CSP のセリフを読み戻す from a command: the dialog opens on CSP, with this
   * name's last export, and reads back from its folder.
   */
  async readBackAgain(): Promise<void> {
    if (!this.host.project() || this.busy) return;
    this.open();
    this.kind = "csp";
    this.show();
    await this.readBack();
  }

  /** The settings of a name's last export, into the dialog. */
  private apply(memory: ExportMemory): void {
    this.kind = memory.kind;
    Object.assign(this.form, memory.form);
    this.mode = memory.mode;
    this.panels = memory.panels;
    this.editable = memory.editable;
    this.draftRough = memory.draftRough;
    this.notes = memory.notes;
    this.marks = memory.marks;
    $<HTMLSelectElement>("ne-pdf-area").value = memory.pdf.area;
    $<HTMLSelectElement>("ne-pdf-dpi").value = String(memory.pdf.dpi);
  }

  /** Another name with no export kept: not the last name's folder or work name (one name must not write over another's pages). */
  private forgetOtherName(): void {
    this.form.outDir = "";
    this.form.workName = "";
    this.form.storyIndex = "";
  }

  /** Keep how this name was just written out, for the next time. */
  private remember(file?: string): void {
    const path = this.host.projectPath();
    if (!path) return;
    const files = { ...(loadExportMemory(path)?.files ?? {}) };
    if (file && this.kind !== "csp") files[this.kind] = file;
    keepExportMemory(path, { timeMs: Date.now(), ...this.settings(), files });
    this.settingsFor = this.host.projectId();
  }

  /** The choices made here. */
  private settings(): Omit<ExportMemory, "timeMs" | "files"> {
    return {
      kind: this.kind,
      form: { ...this.form },
      mode: this.mode,
      panels: this.panels,
      editable: this.editable,
      draftRough: this.draftRough,
      notes: this.notes,
      marks: this.marks,
      pdf: { area: $<HTMLSelectElement>("ne-pdf-area").value as "trim" | "canvas", dpi: Number($<HTMLSelectElement>("ne-pdf-dpi").value) },
    };
  }

  /** What 書き出す will make, in a line above the buttons. */
  private showSummary(): void {
    const project = this.host.project();
    if (!project) return;
    const page = this.page;
    const preset = page && PRESETS.find((candidate) => candidate.id === presetOf(page));
    $("ne-summary").textContent = exportSummary(this.settings(), {
      pages: project.pages.length,
      scroll: !!project.scroll,
      page: page && { trimMm: page.trimMm, resolution: page.resolution, preset: preset ? preset.label.split("（")[0] : null },
      marks: hasMarks(project),
    });
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
    // Reading back and 反映 work on pages written out before: a folder first.
    for (const id of ["ne-update", "ne-readback"]) {
      const button = $<HTMLButtonElement>(id);
      button.hidden = this.kind !== "csp";
      button.disabled = !this.form.outDir;
      button.title = this.form.outDir ? (button.dataset.title ??= button.title) : "書き出し先（前に書き出したフォルダー）を選ぶと使えます";
    }
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
    for (const id of ["ne-marks", "ne-pdf-marks"]) $<HTMLInputElement>(id).checked = this.marks;
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
    // A template still to choose: its field in view.
    if (this.kind === "csp" && !builtin && !this.form.template) $<HTMLDetailsElement>("ne-more").open = true;
    this.showSummary();
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
    const story = readStory();
    if (story) next.story = story;
    else delete next.story;
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
    showStory(page.story);
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
    showStoryRows();
    $<HTMLSelectElement>("ne-preset").value = presetOf(this.page) ?? "";
    const [w, h] = pixelSize(this.page);
    $("ne-px").textContent = `${w} × ${h} px`;
    const project = this.host.project();
    const pieces = project ? piecesPerPage(project, this.page) : 1;
    this.showSummary();
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

  /** Writes the name out; `again`: to the PDF or script file written last, without asking where. */
  private async run(again = false): Promise<void> {
    const project = this.host.project();
    if (!project || this.busy) return;
    this.readFields();
    const button = $<HTMLButtonElement>("ne-run");
    const stop = $<HTMLButtonElement>("ne-stop");
    this.stopping = false;
    const progress = (text: string) => {
      // 中止: at the next page, before it is written.
      if (this.stopping) throw new ExportStopped();
      this.message(text);
      this.host.status(text);
    };
    try {
      this.busy = true;
      button.disabled = true;
      stop.hidden = false;
      stop.disabled = false;
      stop.textContent = "中止";
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
            marks: this.marks,
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
        this.remember();
        this.host.status(
          check.ok
            ? `${report.pages.length} 枚のページを ${this.form.outDir} に書き出しました（自己確認 OK）`
            : `書き出したページに問題があります: ${check.lines[1]}`,
        );
      } else {
        const extension = this.kind === "pdf" ? "pdf" : "txt";
        const base = (this.host.projectPath() ?? project.title ?? "ネーム").replace(/\.[^.\\/]+$/, "");
        const last = this.host.projectPath() ? loadExportMemory(this.host.projectPath()!)?.files[this.kind] : undefined;
        const path =
          again && last
            ? last
            : await save({
                defaultPath: last ?? `${base}${this.kind === "text" ? "_台本" : ""}.${extension}`,
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
              marks: this.marks,
            },
            (rough) => this.host.rough(rough),
            progress,
          );
        } else {
          await call("write_text_file", { path, text: scriptText(project) });
        }
        this.message(`書き出しました（${seconds()} 秒）: ${path}`);
        this.remember(path);
        this.host.status(`書き出しました: ${path}`);
      }
    } catch (error) {
      if (error instanceof ExportStopped) {
        const text = error.written
          ? `${error.written} 枚まで書き出したところでやめました。それより後のページと作品ファイルは前のままです`
          : "書き出しをやめました（何も書き換えていません）";
        this.message(text);
        this.host.status(text);
      } else this.message(`書き出せませんでした: ${error}`, true);
    } finally {
      this.busy = false;
      button.disabled = false;
      stop.hidden = true;
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
      // One change at a time: what is left unticked stays as the name has it.
      const picked = await chooseTakeBack(plan, request.outDir);
      if (!picked) {
        this.message("読み戻しませんでした");
        return;
      }
      this.host.edit((p) => applyTakeBack(p, picked));
      // From now on these texts count as the name's: セリフだけ反映 leaves them as they are.
      const recorded = await call("adopt_name_dialogue", { paths: plan.paths }).then(
        () => null,
        (error) => `ただし書き出し先に記録できませんでした（${error}）。次のセリフだけ反映で、CSP のセリフが「（旧）」になることがあります`,
      );
      const left = changes - picked.retyped.length - picked.added.length - picked.removed.length;
      const done = `CSP のセリフを読み戻しました（直した ${picked.retyped.length}・足した ${picked.added.length}・消した ${picked.removed.length}${left ? `。ネームのままにしたもの ${left}` : ""}）。元に戻すは Ctrl+Z${recorded ? `。${recorded}` : ""}`;
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

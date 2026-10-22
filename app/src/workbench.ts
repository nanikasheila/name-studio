// The name editor around the canvas: the open project, saving, undo, the
// page list, the script, the cast and the inspector for the selection.
import { invoke } from "@tauri-apps/api/core";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { addBrushes, loadLibrary } from "./brush";
import { BrushDialog } from "./brushdialog";
import { PageEditor, isTyping, type Selection, type Tool } from "./editor";
import { ExportDialog } from "./exportdialog";
import { History } from "./history";
import { Overview, type OverviewKind } from "./overview";
import {
  KIND_LABELS,
  addCharacter,
  addPanel,
  assignPanels,
  basicBox,
  fitLine,
  insertPage,
  movePage,
  normalize,
  orderPanels,
  pageIndex,
  rectShape,
  removeCharacter,
  removePage,
  removePanel,
  sceneOf,
  sortLines,
  textAmount,
  type Brush,
  type Line,
  type LineKind,
  type Page,
  type Project,
  type RoughImage,
} from "./project";

export const PROJECT_EXTENSION = "namestudio";
const ROUGH_MAX_HEIGHT = 1600;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

interface WorkbenchState {
  project: Project | null;
  path: string | null;
  dirty: boolean;
  /** Snapshot taken by `begin`, pushed to history by `commit`. */
  pending: string | null;
  roughs: Map<string, ImageBitmap | "loading" | "failed">;
}

export class Workbench {
  readonly editor: PageEditor;
  private readonly history = new History<Project>();
  private readonly state: WorkbenchState = { project: null, path: null, dirty: false, pending: null, roughs: new Map() };
  private sideTab: "pages" | "script" | "cast" = "pages";
  readonly overview: Overview;
  private readonly exportDialog: ExportDialog;
  private readonly brushDialog: BrushDialog;
  private view: "edit" | OverviewKind = "edit";

  constructor(private readonly setStatus: (message: string) => void, private readonly onTitle: (title: string) => void) {
    this.editor = new PageEditor($<HTMLCanvasElement>("editor-canvas"), {
      project: () => this.state.project,
      begin: () => this.begin(),
      commit: () => this.commit(),
      cancel: () => (this.state.pending = null),
      selectionChanged: () => this.renderInspector(),
      rough: (rough) => this.rough(rough),
      status: (message) => this.setStatus(message),
    });
    this.overview = new Overview($("overview"), {
      project: () => this.state.project,
      edit: (change) => this.edit(change),
      openPage: (pageNumber) => {
        this.setView("edit");
        this.editor.selection = null;
        this.editor.showPage(pageNumber);
        this.renderAll();
      },
    });
    this.exportDialog = new ExportDialog({
      project: () => this.state.project,
      projectPath: () => this.state.path,
      rough: (rough) => this.loadRough(rough),
      status: (message) => this.setStatus(message),
    });
    this.brushDialog = new BrushDialog({
      project: () => this.state.project,
      edit: (change) => this.edit(change),
      imported: (brushes) => {
        const kind = this.editor.tool === "eraser" ? "eraser" : "pen";
        const brush = brushes.find((b) => b.kind === kind) ?? brushes[0];
        if (brush) this.useBrush(brush);
      },
    });
    this.bindControls();
  }

  setView(view: "edit" | OverviewKind): void {
    this.view = view;
    for (const name of ["edit", "structure", "emotion", "timeline"] as const) {
      $(`view-${name}`).classList.toggle("active", name === view);
    }
    for (const node of document.querySelectorAll<HTMLElement>(".edit-only")) node.hidden = view !== "edit";
    $("overview").hidden = view === "edit";
    if (view === "edit") this.editor.resize();
    else this.overview.kind = view;
    this.renderAll();
  }

  get project(): Project | null {
    return this.state.project;
  }

  get dirty(): boolean {
    return this.state.dirty;
  }

  // --- opening and saving --------------------------------------------------------

  /** Ask before throwing away unsaved changes. */
  async confirmDiscard(): Promise<boolean> {
    if (!this.state.project || !this.state.dirty) return true;
    return ask("保存していない変更があります。破棄して続けますか？", { title: "Name Studio", kind: "warning" });
  }

  show(project: Project, path: string | null, message: string): void {
    this.state.project = normalize(project);
    this.state.path = path;
    this.state.dirty = false;
    this.state.pending = null;
    this.state.roughs = new Map();
    this.history.clear();
    this.editor.selection = null;
    this.editor.spreadIndex = 0;
    this.editor.resetView();
    this.editor.resize();
    this.renderAll();
    this.setStatus(message);
  }

  async load(path: string): Promise<void> {
    const project = await invoke<Project>("load_project", { path });
    this.show(project, path, `${project.pages.length} ページのネームを開きました`);
  }

  async importSheet(sheetPath: string): Promise<void> {
    this.setStatus("ネーム用紙から取り込み中…");
    const result = await invoke<{ project: Project; warnings: string[] }>("import_project", { path: sheetPath });
    const p = result.project;
    const lines = p.pages.reduce((sum, page) => sum + page.lines.length, 0);
    const panels = p.pages.reduce((sum, page) => sum + page.panels.length, 0);
    const warnings = result.warnings.length ? ` ／ ${result.warnings.join(" ／ ")}` : "";
    this.show(p, null, `${p.pages.length} ページ、コマ ${panels}、セリフ ${lines} を取り込みました。保存先はまだ決まっていません${warnings}`);
    this.state.dirty = true;
    this.updateTitle();
  }

  async save(saveAs = false): Promise<boolean> {
    const project = this.state.project;
    if (!project) return false;
    let path = this.state.path;
    if (!path || saveAs) {
      const suggested = project.source?.path.replace(/\.clip$/i, `.${PROJECT_EXTENSION}`) ?? `${project.title || "ネーム"}.${PROJECT_EXTENSION}`;
      const picked = await save({
        defaultPath: path ?? suggested,
        filters: [{ name: "ネームデータ", extensions: [PROJECT_EXTENSION] }],
      });
      if (!picked) return false;
      path = picked.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`) ? picked : `${picked}.${PROJECT_EXTENSION}`;
    }
    try {
      await invoke("save_project", { path, project });
      this.state.path = path;
      this.state.dirty = false;
      this.updateTitle();
      this.setStatus(`保存しました: ${path}`);
      return true;
    } catch (error) {
      this.setStatus(`保存できませんでした: ${error}`);
      return false;
    }
  }

  // --- changes and undo -------------------------------------------------------------

  private begin(): void {
    if (this.state.project) this.state.pending = JSON.stringify(this.state.project);
  }

  private commit(): void {
    if (this.state.pending === null) return;
    this.history.recordSnapshot(this.state.pending);
    this.state.pending = null;
    this.changed();
  }

  /** Run `change` as one undoable step. */
  edit(change: (project: Project) => void): void {
    const project = this.state.project;
    if (!project) return;
    this.begin();
    change(project);
    this.commit();
  }

  private changed(): void {
    this.state.dirty = true;
    this.renderAll();
  }

  undo(): void {
    this.restore(this.history.undo(this.state.project!));
  }

  redo(): void {
    this.restore(this.history.redo(this.state.project!));
  }

  private restore(project: Project | null): void {
    if (!project) return;
    this.state.project = project;
    this.state.dirty = true;
    const s = this.editor.selection;
    if (s && !this.findSelected(s)) this.editor.selection = null;
    this.renderAll();
  }

  private findSelected(s: Selection): boolean {
    const page = this.state.project?.pages.find((p) => p.id === s.pageId);
    if (!page) return false;
    const list = s.kind === "panel" ? page.panels : s.kind === "line" ? page.lines : page.strokes;
    return list.some((item) => item.id === s.id);
  }

  // --- roughs -------------------------------------------------------------------------

  private roughKey(rough: RoughImage): string {
    return `${rough.layerId}:${rough.sheetCrop.join(",")}`;
  }

  /** A rough as drawn so far, starting to load it when it is not there yet. */
  private rough(rough: RoughImage): CanvasImageSource | null {
    const cached = this.state.roughs.get(this.roughKey(rough));
    if (cached instanceof ImageBitmap) return cached;
    if (!cached) void this.loadRough(rough).then((image) => image && this.editor.draw());
    return null;
  }

  /** Pixels of a rough from the source sheet (null when the sheet cannot be read). */
  async loadRough(rough: RoughImage): Promise<ImageBitmap | null> {
    const source = this.state.project?.source;
    if (!source) return null;
    const key = this.roughKey(rough);
    const cached = this.state.roughs.get(key);
    if (cached instanceof ImageBitmap) return cached;
    if (cached === "failed") return null;
    const roughs = this.state.roughs;
    roughs.set(key, "loading");
    try {
      const bytes = await invoke<ArrayBuffer>("rough_image", {
        sheet: source.path,
        layerId: rough.layerId,
        crop: rough.sheetCrop,
        maxHeight: ROUGH_MAX_HEIGHT,
      });
      const image = bytes.byteLength ? await createImageBitmap(new Blob([bytes], { type: "image/png" })) : null;
      roughs.set(key, image ?? "failed");
      return image;
    } catch (error) {
      roughs.set(key, "failed");
      this.setStatus(`ラフ画像を読めませんでした（元のネーム用紙が必要です）: ${error}`);
      return null;
    }
  }

  // --- rendering ------------------------------------------------------------------------

  renderAll(): void {
    this.renderBrushBar();
    if (this.view === "edit") this.editor.draw();
    else this.overview.render();
    this.renderSide();
    this.renderInspector();
    this.updateTitle();
    $<HTMLButtonElement>("undo").disabled = !this.history.canUndo;
    $<HTMLButtonElement>("redo").disabled = !this.history.canRedo;
    const pages = this.editor.currentPages().sort((a, b) => a - b);
    $("editor-page-label").textContent = this.state.project
      ? `${pages.join("–") || "-"} / ${this.state.project.pages.length}`
      : "-";
  }

  private updateTitle(): void {
    const project = this.state.project;
    if (!project) return;
    const name = this.state.path?.split(/[\\/]/).pop() ?? "（未保存）";
    this.onTitle(`${this.state.dirty ? "● " : ""}${name} — ${project.title}`);
  }

  private renderSide(): void {
    $("side-pages").hidden = this.sideTab !== "pages";
    $("side-script").hidden = this.sideTab !== "script";
    $("side-cast").hidden = this.sideTab !== "cast";
    for (const tab of ["pages", "script", "cast"] as const) $(`tab-${tab}`).classList.toggle("active", this.sideTab === tab);
    const project = this.state.project;
    if (!project) return;
    if (this.sideTab === "pages") this.renderPages(project);
    if (this.sideTab === "script") this.renderScript(project);
    if (this.sideTab === "cast") this.renderCast(project);
  }

  private renderPages(project: Project): void {
    const title = element("input", { type: "text", value: project.title, placeholder: "作品名" });
    title.addEventListener("change", () => this.edit((p) => (p.title = title.value.trim())));
    const story = element("input", { type: "number", min: "0", value: project.storyIndex === undefined ? "" : String(project.storyIndex), placeholder: "話数" });
    story.addEventListener("change", () =>
      this.edit((p) => {
        const value = parseInt(story.value, 10);
        if (Number.isInteger(value) && value >= 0) p.storyIndex = value;
        else delete p.storyIndex;
      }),
    );
    const work = element("div", { className: "cast-item work" }, title, story);
    const current = new Set(this.editor.currentPages());
    const items = project.pages.map((page, index) => {
      const scene = sceneOf(project, page.id);
      const sceneLabel = scene && scene.firstPage === page.id ? element("span", { className: "scene", textContent: scene.title }) : "";
      const item = element(
        "div",
        { className: `page-item${current.has(index + 1) ? " current" : ""}` },
        element("span", { className: "number", textContent: String(index + 1) }),
        element("span", { className: "memo" }, sceneLabel, page.memo.split("\n")[0] || ""),
        element("span", { className: "count", textContent: `コマ ${page.panels.length}・字 ${textAmount(page)}` }),
      );
      item.addEventListener("click", () => {
        if (this.view !== "edit") this.setView("edit");
        this.editor.selection = null;
        this.editor.showPage(index + 1);
        this.renderAll();
      });
      return item;
    });
    const add = element("button", { textContent: "最後にページを足す" });
    add.addEventListener("click", () => this.edit((p) => insertPage(p, p.pages.length)));
    $("side-pages").replaceChildren(work, ...items, element("div", { className: "side-actions" }, add));
  }

  private renderScript(project: Project): void {
    const names = new Map(project.characters.map((character) => [character.id, character.name]));
    const children: HTMLElement[] = [];
    project.pages.forEach((page, index) => {
      children.push(element("div", { className: "script-page", textContent: `${index + 1} ページ` }));
      for (const line of page.lines) {
        const who = line.kind === "narration" ? "N" : line.kind === "sfx" ? "音" : names.get(line.speaker ?? "") ?? "？";
        const selected = this.editor.selection?.kind === "line" && this.editor.selection.id === line.id;
        const row = element(
          "div",
          { className: `script-line ${line.kind}${selected ? " current" : ""}` },
          element("span", { className: "who", textContent: who }),
          element("span", { className: "text", textContent: line.text.replace(/\s+/g, " ") }),
        );
        row.addEventListener("click", () => {
          if (this.view !== "edit") this.setView("edit");
          this.editor.showPage(index + 1);
          this.editor.select({ kind: "line", pageId: page.id, id: line.id });
          this.renderAll();
        });
        children.push(row);
      }
    });
    if (!children.length) children.push(element("p", { className: "hint", textContent: "ページがありません" }));
    $("side-script").replaceChildren(...children);
  }

  private renderCast(project: Project): void {
    const rows = project.characters.map((character) => {
      const name = element("input", { type: "text", value: character.name });
      name.addEventListener("change", () => this.edit(() => (character.name = name.value.trim() || character.name)));
      const color = element("input", { type: "color", value: character.color ?? "#2f6fdb" });
      color.addEventListener("change", () => this.edit(() => (character.color = color.value)));
      const spoken = project.pages.reduce((sum, page) => sum + page.lines.filter((l) => l.speaker === character.id).length, 0);
      const remove = element("button", { className: "danger", textContent: "削除", title: `セリフ ${spoken} 件の話者が空になります` });
      remove.addEventListener("click", () => this.edit((p) => removeCharacter(p, character.id)));
      return element("div", { className: "cast-item" }, color, name, element("span", { className: "count", textContent: `${spoken}` }), remove);
    });
    const add = element("button", { textContent: "人物を足す" });
    add.addEventListener("click", () => this.edit((p) => addCharacter(p, `人物${p.characters.length + 1}`)));
    const hint = element("p", { className: "hint", textContent: "セリフを選んで、右の欄で話者を選べます。" });
    $("side-cast").replaceChildren(...rows, element("div", { className: "side-actions" }, add), hint);
  }

  // --- inspector --------------------------------------------------------------------------

  renderInspector(): void {
    const panel = $("inspector");
    const project = this.state.project;
    if (!project) {
      panel.replaceChildren();
      return;
    }
    const s = this.editor.selection;
    const page = s ? project.pages.find((p) => p.id === s.pageId) : this.editor.focusPage();
    if (!page) {
      panel.replaceChildren(element("p", { className: "hint", textContent: "ページがありません。左の「最後にページを足す」で始めましょう。" }));
      return;
    }
    if (s?.kind === "line") {
      const line = page.lines.find((l) => l.id === s.id);
      if (line) return panel.replaceChildren(...this.lineInspector(project, page, line));
    }
    if (s?.kind === "panel") {
      const target = page.panels.find((p) => p.id === s.id);
      if (target) return panel.replaceChildren(...this.panelInspector(project, page, target.id, target.order));
    }
    if (s?.kind === "stroke") {
      const remove = element("button", { className: "danger", textContent: "この線を消す" });
      remove.addEventListener("click", () => this.deleteSelection());
      return panel.replaceChildren(element("h2", { textContent: "ラフの線" }), remove);
    }
    panel.replaceChildren(...this.pageInspector(project, page));
  }

  /** A text field edited live; the whole edit becomes one undo step. */
  private liveText(field: HTMLInputElement | HTMLTextAreaElement, apply: (value: string) => void): void {
    let snapshot: string | null = null;
    field.addEventListener("focus", () => (snapshot = JSON.stringify(this.state.project)));
    field.addEventListener("input", () => {
      apply(field.value);
      this.state.dirty = true;
      this.editor.draw();
      this.updateTitle();
    });
    field.addEventListener("change", () => {
      if (snapshot !== null && snapshot !== JSON.stringify(this.state.project)) this.history.recordSnapshot(snapshot);
      snapshot = JSON.stringify(this.state.project);
      this.renderSide();
      $<HTMLButtonElement>("undo").disabled = !this.history.canUndo;
    });
  }

  private lineInspector(project: Project, page: Page, line: Line): HTMLElement[] {
    const text = element("textarea", { value: line.text, spellcheck: false });
    this.liveText(text, (value) => {
      line.text = value;
      fitLine(line);
    });
    const kind = element("select");
    for (const [value, label] of Object.entries(KIND_LABELS)) kind.append(element("option", { value, textContent: label }));
    kind.value = line.kind;
    kind.addEventListener("change", () =>
      this.edit(() => {
        line.kind = kind.value as LineKind;
        fitLine(line);
      }),
    );
    const speaker = element("select");
    speaker.append(element("option", { value: "", textContent: "（なし）" }));
    for (const character of project.characters) speaker.append(element("option", { value: character.id, textContent: character.name }));
    speaker.append(element("option", { value: "__new", textContent: "新しい人物…" }));
    speaker.value = line.speaker ?? "";
    speaker.addEventListener("change", () =>
      this.edit((p) => {
        if (speaker.value === "__new") {
          // Named in the 人物 tab; a prompt here would interrupt the writing.
          line.speaker = addCharacter(p, `人物${p.characters.length + 1}`).id;
          this.setStatus("人物を足しました。名前は左の「人物」で変えられます");
        } else if (speaker.value) {
          line.speaker = speaker.value;
        } else {
          delete line.speaker;
        }
      }),
    );
    const size = element("input", { type: "number", min: "4", max: "72", step: "0.5", value: String(round(line.fontSizePt)) });
    size.addEventListener("change", () =>
      this.edit(() => {
        const value = Number(size.value);
        if (value > 0) line.fontSizePt = value;
        fitLine(line);
      }),
    );
    const vertical = element("input", { type: "checkbox", checked: line.vertical });
    vertical.addEventListener("change", () =>
      this.edit(() => {
        line.vertical = vertical.checked;
        fitLine(line);
      }),
    );
    const remove = element("button", { className: "danger", textContent: "このセリフを消す" });
    remove.addEventListener("click", () => this.deleteSelection());
    const panelNumber = page.panels.find((p) => p.id === line.panel)?.order;
    setTimeout(() => {
      if (line.text === "セリフ") {
        text.focus();
        text.select();
      }
    });
    return [
      element("h2", { textContent: `${pageIndex(project, page.id) + 1} ページのセリフ${panelNumber ? `（${panelNumber} コマ目）` : ""}` }),
      element("label", {}, "文字", text),
      element("div", { className: "row" }, element("label", {}, "種類", kind), element("label", {}, "話者", speaker)),
      element("div", { className: "row" }, element("label", {}, "文字の大きさ（pt）", size), element("label", { className: "inline" }, vertical, "縦書き")),
      element("p", { className: "hint", textContent: "改行で行を分けます。フキダシは文字に合わせて大きさが変わります。ドラッグか矢印キーで動かせます。" }),
      remove,
    ];
  }

  private panelInspector(project: Project, page: Page, panelId: string, order: number): HTMLElement[] {
    const remove = element("button", { className: "danger", textContent: "このコマを消す" });
    remove.addEventListener("click", () => this.deleteSelection());
    const lines = page.lines.filter((line) => line.panel === panelId).length;
    return [
      element("h2", { textContent: `${pageIndex(project, page.id) + 1} ページ ${order} コマ目` }),
      element("p", { className: "hint", textContent: `セリフ ${lines} 件。角の四角をドラッグすると形を変えられます（枠に吸い付きます。Alt で吸い付かない）。` }),
      remove,
    ];
  }

  private pageInspector(project: Project, page: Page): HTMLElement[] {
    const index = pageIndex(project, page.id);
    const memo = element("textarea", { value: page.memo, placeholder: "このページで描くこと、狙い" });
    this.liveText(memo, (value) => (page.memo = value));
    const button = (label: string, action: () => void, disabled = false) => {
      const b = element("button", { textContent: label, disabled });
      b.addEventListener("click", action);
      return b;
    };
    const frame = button(
      "基本枠を 1 コマにする",
      () => this.edit((p) => addPanel(p, page, rectShape(basicBox(p.pageFormat)))),
      page.panels.length > 0,
    );
    const reorder = button("コマ番号を振り直す", () =>
      this.edit((p) => {
        orderPanels(page, p.binding);
        assignPanels(page);
        sortLines(page);
      }),
    );
    const after = button("後ろにページを足す", () => this.edit((p) => insertPage(p, index + 1)));
    const before = button("前にページを足す", () => this.edit((p) => insertPage(p, index)));
    const earlier = button("1 つ前へ", () => this.edit((p) => movePage(p, page.id, -1)), index === 0);
    const later = button("1 つ後ろへ", () => this.edit((p) => movePage(p, page.id, 1)), index === project.pages.length - 1);
    const remove = button("このページを消す", async () => {
      const filled = page.panels.length + page.lines.length + page.strokes.length > 0;
      if (filled && !(await ask(`${index + 1} ページを消しますか？（元に戻すで戻せます）`, { title: "Name Studio", kind: "warning" }))) return;
      this.edit((p) => removePage(p, page.id));
    });
    remove.className = "danger";
    return [
      element("h2", { textContent: `${index + 1} ページ` }),
      element("label", {}, "メモ", memo),
      element("h3", { textContent: "コマ" }),
      element("div", { className: "row" }, frame, reorder),
      element("p", { className: "hint", textContent: "コマ割り: コマを横切るように線を引くと割れます（ほぼ水平・垂直はまっすぐに。Alt で斜め）。コマの外をドラッグすると新しいコマ。" }),
      element("h3", { textContent: "ページ" }),
      element("div", { className: "row" }, before, after),
      element("div", { className: "row" }, earlier, later),
      remove,
    ];
  }

  deleteSelection(): void {
    const s = this.editor.selection;
    if (!s) return;
    this.edit((project) => {
      const page = project.pages.find((p) => p.id === s.pageId);
      if (!page) return;
      if (s.kind === "panel") removePanel(page, s.id, project.binding);
      if (s.kind === "line") page.lines = page.lines.filter((line) => line.id !== s.id);
      if (s.kind === "stroke") page.strokes = page.strokes.filter((stroke) => stroke.id !== s.id);
    });
    this.editor.select(null);
  }

  // --- controls -------------------------------------------------------------------------------

  setTool(tool: Tool): void {
    this.editor.setTool(tool);
    for (const name of ["select", "cut", "text", "pen", "eraser"] as const) {
      $(`tool-${name}`).classList.toggle("active", name === tool);
    }
    this.renderBrushBar();
  }

  // --- pens and erasers -------------------------------------------------------------------

  /** Use a brush for its kind of tool, with its own size. */
  private useBrush(brush: Brush | null, kind: "pen" | "eraser" = brush?.kind ?? "pen"): void {
    if (kind === "eraser") {
      this.editor.eraserBrush = brush?.id ?? null;
      if (brush) this.editor.eraserSizeMm = brush.sizeMm;
    } else {
      this.editor.penBrush = brush?.id ?? null;
      this.editor.penWidthMm = brush ? brush.sizeMm : 0.4;
    }
    if (this.editor.tool !== kind) this.setTool(kind);
    else this.renderBrushBar();
    this.editor.draw();
  }

  /** The pen / eraser chooser: the project's brushes, then ones taken in other projects. */
  private renderBrushBar(): void {
    const tool = this.editor.tool;
    const bar = $("brush-bar");
    bar.classList.toggle("off", tool !== "pen" && tool !== "eraser");
    const project = this.state.project;
    if (!project || (tool !== "pen" && tool !== "eraser")) return;
    const kind = tool;
    const current = this.editor.brush(kind);
    const select = $<HTMLSelectElement>("brush-select");
    select.replaceChildren();
    const option = (value: string, label: string) => Object.assign(document.createElement("option"), { value, textContent: label });
    select.append(option("", kind === "pen" ? "標準のペン" : "標準の消しゴム（線ごと）"));
    for (const brush of project.brushes.filter((b) => b.kind === kind)) select.append(option(brush.id, brush.name));
    const others = loadLibrary()
      .map((brush, index) => ({ brush, index }))
      .filter(({ brush }) => brush.kind === kind && !project.brushes.some((b) => b.source === brush.source && b.name === brush.name));
    if (others.length) {
      const group = document.createElement("optgroup");
      group.label = "ほかのネームで取り込んだもの";
      for (const { brush, index } of others) group.append(option(`library:${index}`, brush.name));
      select.append(group);
    }
    select.value = current?.id ?? "";
    select.title = current?.source ?? "ペン・消しゴムの種類";
    const size = $<HTMLInputElement>("brush-size");
    const plainEraser = kind === "eraser" && !current;
    size.disabled = plainEraser;
    const sizeMm = kind === "pen" ? this.editor.penWidthMm : this.editor.eraserSizeMm;
    if (document.activeElement !== size) size.value = plainEraser ? "" : String(Math.round(sizeMm * 100) / 100);
    $("brush-tip-label").hidden = !current?.tip;
    $<HTMLInputElement>("brush-tip").checked = !!current?.tip?.enabled;
  }

  private chooseBrush(value: string): void {
    const kind = this.editor.tool === "eraser" ? "eraser" : "pen";
    const project = this.state.project;
    if (!project) return;
    if (value.startsWith("library:")) {
      const brush = loadLibrary()[Number(value.slice("library:".length))];
      if (!brush) return;
      let added: Brush[] = [];
      this.edit((p) => {
        added = addBrushes(p, [brush]);
      });
      this.useBrush(added[0] ?? null, kind);
      return;
    }
    this.useBrush(project.brushes.find((brush) => brush.id === value) ?? null, kind);
  }

  private bindControls(): void {
    for (const name of ["select", "cut", "text", "pen", "eraser"] as const) {
      $(`tool-${name}`).addEventListener("click", () => this.setTool(name));
    }
    $("undo").addEventListener("click", () => this.undo());
    $<HTMLSelectElement>("brush-select").addEventListener("change", (event) => {
      this.chooseBrush((event.target as HTMLSelectElement).value);
    });
    $<HTMLInputElement>("brush-size").addEventListener("change", (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      if (!(value > 0)) return;
      if (this.editor.tool === "eraser") this.editor.eraserSizeMm = value;
      else this.editor.penWidthMm = value;
      this.editor.draw();
    });
    $<HTMLInputElement>("brush-tip").addEventListener("change", (event) => {
      const kind = this.editor.tool === "eraser" ? "eraser" : "pen";
      const id = this.editor.brush(kind)?.id;
      const enabled = (event.target as HTMLInputElement).checked;
      this.edit((project) => {
        const tip = project.brushes.find((brush) => brush.id === id)?.tip;
        if (tip) tip.enabled = enabled;
      });
    });
    $("brush-import").addEventListener("click", () => void this.brushDialog.open());
    $("name-export").addEventListener("click", () => this.exportDialog.open());
    $("redo").addEventListener("click", () => this.redo());
    $("editor-next").addEventListener("click", () => this.flip(1));
    $("editor-prev").addEventListener("click", () => this.flip(-1));
    $<HTMLInputElement>("editor-first-alone").addEventListener("change", (event) => {
      this.editor.firstAlone = (event.target as HTMLInputElement).checked;
      this.editor.spreadIndex = 0;
      this.renderAll();
    });
    for (const name of ["edit", "structure", "emotion", "timeline"] as const) {
      $(`view-${name}`).addEventListener("click", () => this.setView(name));
    }
    for (const tab of ["pages", "script", "cast"] as const) {
      $(`tab-${tab}`).addEventListener("click", () => {
        this.sideTab = tab;
        this.renderSide();
      });
    }
  }

  private flip(step: number): void {
    this.editor.selection = null;
    this.editor.flip(step);
    this.renderAll();
  }

  /** Keyboard shortcuts while the editor is shown; true when handled. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.state.project) return false;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "s") {
      void this.save(event.shiftKey);
      return true;
    }
    if (isTyping(event)) return false;
    if (mod && event.key.toLowerCase() === "z") {
      if (event.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && event.key.toLowerCase() === "y") {
      this.redo();
      return true;
    }
    if (mod) return false;
    const views: Record<string, "edit" | OverviewKind> = { F1: "edit", F2: "structure", F3: "emotion", F4: "timeline" };
    if (views[event.key]) {
      this.setView(views[event.key]);
      return true;
    }
    if (this.view !== "edit") return false;
    const tools: Record<string, Tool> = { v: "select", k: "cut", t: "text", p: "pen", e: "eraser" };
    const tool = tools[event.key.toLowerCase()];
    if (tool) {
      this.setTool(tool);
      return true;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      this.deleteSelection();
      return true;
    }
    if (event.key === "Escape") {
      this.editor.select(null);
      return true;
    }
    const step = event.shiftKey ? 5 : 0.5;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const arrow = arrows[event.key];
    if (arrow) {
      if (this.editor.selection) return this.editor.nudge(...arrow);
      // Right-bound book: the next spread is to the left.
      this.flip(event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0);
      return true;
    }
    return false;
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

// The name editor around the canvas: the open project, saving, undo, the
// page list, the script, the cast and the inspector for the selection.
import { invoke } from "@tauri-apps/api/core";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { Autosaver, autosaveToFile, formatTime } from "./autosave";
import { addBrushes, loadLibrary } from "./brush";
import { BrushDialog } from "./brushdialog";
import { ERASE_MODE_LABELS, PageEditor, isTyping, type EditorEraseMode, type Selection, type Tool } from "./editor";
import { SHAPE_LABELS, TAIL_LABELS, defaultTailStyle, resolvedShape } from "./balloon";
import { ExportDialog } from "./exportdialog";
import { History } from "./history";
import { VersionDialog, type VersionInfo } from "./versiondialog";
import {
  BORDER_LABELS,
  EFFECT_LABELS,
  FILL_LABELS,
  PATTERNS,
  SIDE_LABELS,
  addInset,
  applyPattern,
  bleedPanel,
  facingPage,
  isBled,
  rotatePanel,
  spreadPanel,
  spreadTwin,
  unspreadPanel,
  type Side,
} from "./koma";
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
  type BalloonShape,
  type Line,
  type LineKind,
  type Page,
  type Panel,
  type PanelBorder,
  type PanelEffect,
  type PanelFill,
  type Project,
  type RoughImage,
  type TailStyle,
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

/** A drop-down of labelled values. */
function choice<T extends string>(labels: Record<T, string>, value: T, change: (value: T) => void, skip: T[] = []): HTMLSelectElement {
  const select = element("select");
  for (const [key, label] of Object.entries(labels) as [T, string][]) {
    if (!skip.includes(key) || key === value) select.append(element("option", { value: key, textContent: label }));
  }
  select.value = value;
  select.addEventListener("change", () => change(select.value as T));
  return select;
}

interface WorkbenchState {
  project: Project | null;
  path: string | null;
  dirty: boolean;
  /** Counts changes, so a save knows whether more came while it ran. */
  revision: number;
  /** Snapshot taken by `begin`, pushed to history by `commit`. */
  pending: string | null;
  roughs: Map<string, ImageBitmap | "loading" | "failed">;
}

export class Workbench {
  readonly editor: PageEditor;
  private readonly history = new History<Project>();
  private readonly state: WorkbenchState = { project: null, path: null, dirty: false, revision: 0, pending: null, roughs: new Map() };
  private sideTab: "pages" | "script" | "cast" = "pages";
  readonly overview: Overview;
  private readonly exportDialog: ExportDialog;
  private readonly brushDialog: BrushDialog;
  private readonly versionDialog: VersionDialog;
  private readonly autosaver = new Autosaver(
    () => this.autosave(),
    () => this.state.pending !== null,
  );
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
    this.versionDialog = new VersionDialog({
      path: () => this.state.path,
      restore: (version) => this.restoreVersion(version),
      autosaveChanged: () => this.autosaver.notify(),
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

  /**
   * Before the project is closed: let autosave write it to its file, then
   * ask before throwing away what is still unsaved (and its autosave copy).
   */
  async confirmDiscard(): Promise<boolean> {
    if (!this.state.project) return true;
    if (this.state.dirty && this.state.path && autosaveToFile()) await this.autosaver.flush();
    if (!this.state.dirty) return true;
    const discard = await ask("保存していない変更があります。破棄して続けますか？", { title: "Name Studio", kind: "warning" });
    if (discard) {
      this.autosaver.reset();
      await invoke("discard_recovery", { path: this.state.path }).catch(() => undefined);
    }
    return discard;
  }

  show(project: Project, path: string | null, message: string): void {
    this.state.project = normalize(project);
    this.state.path = path;
    this.state.dirty = false;
    this.state.pending = null;
    this.state.roughs = new Map();
    this.history.clear();
    this.autosaver.reset();
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
    this.markDirty();
    this.updateTitle();
  }

  /** A project kept by autosave that was not saved, opened as unsaved changes. */
  showRecovered(project: Project, path: string | null, timeMs: number): void {
    const name = path?.split(/[\\/]/).pop() ?? "未保存のネーム";
    this.show(project, path, `${name} を ${formatTime(timeMs)} の自動保存から復元しました。保存すると確定します`);
    this.markDirty();
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
    const revision = this.state.revision;
    try {
      await invoke("save_project", { path, project, previousPath: this.state.path });
      this.state.path = path;
      if (this.state.revision === revision) {
        this.state.dirty = false;
        this.autosaver.reset();
      }
      this.updateTitle();
      this.setStatus(`保存しました: ${path}`);
      return true;
    } catch (error) {
      this.setStatus(`保存できませんでした: ${error}`);
      return false;
    }
  }

  /** Autosave: the file itself when it has one (and that is on), else a copy. */
  private async autosave(): Promise<void> {
    const project = this.state.project;
    if (!project) return;
    const path = this.state.path;
    const revision = this.state.revision;
    try {
      const result = await invoke<{ savedToFile: boolean; version: VersionInfo | null }>("autosave_project", {
        path,
        project,
        toFile: autosaveToFile(),
      });
      if (result.savedToFile && this.state.path === path && this.state.revision === revision) {
        this.state.dirty = false;
        this.updateTitle();
      }
    } catch (error) {
      this.setStatus(`自動保存できませんでした: ${error}`);
      throw error;
    }
  }

  /** Show the versions of this project. */
  openVersions(): void {
    if (this.state.project) void this.versionDialog.open();
  }

  /** Bring an earlier version back as one undoable change. */
  private async restoreVersion(version: VersionInfo): Promise<void> {
    const current = this.state.project;
    if (!current) return;
    const path = this.state.path;
    const older = await invoke<Project>("load_version", { path, id: version.id });
    await invoke("record_version", { path, project: current, kind: "beforeRestore" });
    this.history.record(current);
    this.state.project = normalize(older);
    this.editor.selection = null;
    this.state.roughs = new Map();
    this.changed();
    this.setStatus(`${formatTime(version.timeMs)} の版に戻しました。「元に戻す」で戻る前に戻せます`);
  }

  // --- changes and undo -------------------------------------------------------------

  /** Note a change: the title shows it and autosave picks it up. */
  private markDirty(): void {
    this.state.dirty = true;
    this.state.revision += 1;
    this.autosaver.notify();
  }

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
    this.markDirty();
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
    this.markDirty();
    const s = this.editor.selection;
    if (s && !this.findSelected(s)) this.editor.selection = null;
    this.renderAll();
  }

  private findSelected(s: Selection): boolean {
    const page = this.state.project?.pages.find((p) => p.id === s.pageId);
    if (!page) return false;
    const lists = { panel: page.panels, line: page.lines, stroke: page.strokes, breakout: page.breakouts };
    if (s.kind === "group") return !!s.items?.every((item) => lists[item.kind].some((x: { id: string }) => x.id === item.id));
    return lists[s.kind].some((item: { id: string }) => item.id === s.id);
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
    if (s?.kind === "group") {
      const strokes = s.items?.filter((item) => item.kind === "stroke").length ?? 0;
      const lines = (s.items?.length ?? 0) - strokes;
      const remove = element("button", { className: "danger", textContent: "選んだものを消す（Delete）" });
      remove.addEventListener("click", () => this.deleteSelection());
      return panel.replaceChildren(
        element("h2", { textContent: "範囲選択" }),
        element("p", { className: "hint", textContent: `ラフの線 ${strokes} 本、セリフ ${lines} 個。ドラッグや矢印キーでまとめて動かせます。` }),
        remove,
      );
    }
    if (s?.kind === "stroke") {
      const stroke = page.strokes.find((x) => x.id === s.id);
      const remove = element("button", { className: "danger", textContent: "この線を消す" });
      remove.addEventListener("click", () => this.deleteSelection());
      const over = element("input", { type: "checkbox", checked: !!stroke?.over });
      over.addEventListener("change", () =>
        this.edit(() => {
          if (!stroke) return;
          if (over.checked) stroke.over = true;
          else delete stroke.over;
        }),
      );
      return panel.replaceChildren(
        element("h2", { textContent: "ラフの線" }),
        element("label", { className: "inline" }, over, "コマ枠の上に描く（はみ出し）"),
        remove,
      );
    }
    if (s?.kind === "breakout") {
      const breakout = page.breakouts.find((x) => x.id === s.id);
      if (breakout) {
        const note = element("input", { type: "text", value: breakout.note ?? "", placeholder: "例: 全身が枠を突き抜ける" });
        this.liveText(note, (value) => {
          if (value) breakout.note = value;
          else delete breakout.note;
        });
        const remove = element("button", { className: "danger", textContent: "このはみ出しを消す" });
        remove.addEventListener("click", () => this.deleteSelection());
        return panel.replaceChildren(
          element("h2", { textContent: "はみ出し" }),
          element("p", {
            className: "hint",
            textContent: "この中ではコマ枠と間白が消えます。中でペンを描き始めた線は、コマ枠の上に描かれます（CSP では「はみ出し（ラフ線）」レイヤー）。",
          }),
          element("label", {}, "メモ", note),
          remove,
        );
      }
    }
    panel.replaceChildren(...this.pageInspector(project, page));
  }

  /** A text field edited live; the whole edit becomes one undo step. */
  private liveText(field: HTMLInputElement | HTMLTextAreaElement, apply: (value: string) => void): void {
    let snapshot: string | null = null;
    field.addEventListener("focus", () => (snapshot = JSON.stringify(this.state.project)));
    field.addEventListener("input", () => {
      apply(field.value);
      this.markDirty();
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
    const shape = choice(
      SHAPE_LABELS,
      line.balloonShape ?? "auto",
      (value: BalloonShape) =>
        this.edit(() => {
          if (value === "auto") delete line.balloonShape;
          else line.balloonShape = value;
          fitLine(line);
        }),
      ["custom"],
    );
    const flag = (label: string, checked: boolean, set: (on: boolean) => void) => {
      const box = element("input", { type: "checkbox", checked });
      box.addEventListener("change", () => this.edit(() => set(box.checked)));
      return element("label", { className: "inline" }, box, label);
    };
    const inverted = flag("白抜き", !!line.inverted, (on) => (on ? (line.inverted = true) : delete line.inverted));
    const emphasis = flag("太字（強調）", !!line.emphasis, (on) => (on ? (line.emphasis = true) : delete line.emphasis));
    const hasBalloon = resolvedShape(line) !== "none";
    const tails = line.tails ?? [];
    const addTail = element("button", { textContent: "しっぽを足す", disabled: !hasBalloon });
    addTail.addEventListener("click", () =>
      this.edit(() => {
        const [x0, , , y1] = line.box;
        // Down and to the left; drag the round handle to the speaker.
        const offset = (line.tails?.length ?? 0) * 8;
        line.tails = [...(line.tails ?? []), { tip: [x0 - 6 - offset, y1 + 12], style: defaultTailStyle(line) }];
      }),
    );
    const removeTail = element("button", { textContent: "しっぽを消す", disabled: !tails.length });
    removeTail.addEventListener("click", () =>
      this.edit(() => {
        line.tails = (line.tails ?? []).slice(0, -1);
        if (!line.tails.length) delete line.tails;
      }),
    );
    const tailStyle = choice(TAIL_LABELS, tails[tails.length - 1]?.style ?? defaultTailStyle(line), (value: TailStyle) =>
      this.edit(() => {
        for (const tail of line.tails ?? []) tail.style = value;
      }),
    );
    tailStyle.disabled = !tails.length;
    const names = new Map(project.characters.map((c) => [c.id, c.name]));
    const link = element("select");
    link.append(element("option", { value: "", textContent: "（つながない）" }));
    for (const other of page.lines) {
      if (other.id === line.id || other.linkTo === line.id) continue;
      const who = names.get(other.speaker ?? "");
      const text = other.text.replace(/\s+/g, " ").slice(0, 12);
      link.append(element("option", { value: other.id, textContent: `${who ? `${who}：` : ""}${text}` }));
    }
    link.value = line.linkTo ?? "";
    link.disabled = !hasBalloon;
    link.addEventListener("change", () =>
      this.edit(() => {
        if (link.value) line.linkTo = link.value;
        else delete line.linkTo;
      }),
    );
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
      element("div", { className: "row" }, emphasis, inverted),
      element("h3", { textContent: "フキダシ" }),
      element("label", {}, "形", shape),
      element("div", { className: "row" }, addTail, removeTail),
      element("label", {}, `しっぽ（${tails.length} 本）`, tailStyle),
      element("label", {}, "つなぐ（連結フキダシ）", link),
      element("p", {
        className: "hint",
        textContent:
          "しっぽの丸い先をドラッグして話者に向けます（コマの外の話者にも）。2本以上で同時に話す声。改行で行を分けます。ドラッグか矢印キーで動かせます。",
      }),
      remove,
    ];
  }

  private panelInspector(project: Project, page: Page, panelId: string, order: number): HTMLElement[] {
    const panel = page.panels.find((p) => p.id === panelId)!;
    const remove = element("button", { className: "danger", textContent: "このコマを消す" });
    remove.addEventListener("click", () => this.deleteSelection());
    const lines = page.lines.filter((line) => line.panel === panelId).length;
    const set = <K extends keyof Panel>(key: K, value: Panel[K], none: Panel[K]) =>
      this.edit(() => {
        if (value === none) delete panel[key];
        else panel[key] = value;
      });
    const border = choice(BORDER_LABELS, panel.border ?? "solid", (value: PanelBorder) => set("border", value, "solid"));
    const fill = choice(FILL_LABELS, panel.fill ?? "none", (value: PanelFill) => set("fill", value, "none"));
    const effect = choice(EFFECT_LABELS, panel.effect ?? "none", (value: PanelEffect) => set("effect", value, "none"));
    const bleeds = (["top", "right", "bottom", "left"] as Side[]).map((side) => {
      const box = element("input", { type: "checkbox", checked: isBled(panel, side, project.pageFormat) });
      box.addEventListener("change", () => this.edit((p) => bleedPanel(panel, side, p.pageFormat, box.checked)));
      return element("label", { className: "inline" }, box, SIDE_LABELS[side]);
    });
    const button = (label: string, action: (p: Project) => void, title = "") => {
      const b = element("button", { textContent: label, title });
      b.addEventListener("click", () => this.edit(action));
      return b;
    };
    const tiltLeft = button("⟲ 2°", () => rotatePanel(panel, -2), "左に傾ける");
    const tiltRight = button("⟳ 2°", () => rotatePanel(panel, 2), "右に傾ける");
    const raise = button("前へ", () => (panel.z = (panel.z ?? 0) + 1), "重なりで上にする");
    const lower = button("後ろへ", () => {
      panel.z = (panel.z ?? 0) - 1;
      if (!panel.z) delete panel.z;
    }, "重なりで下にする");
    const inset = element("button", { textContent: "はめ込みコマを足す", title: "このコマの左下に重ねる小さなコマ" });
    inset.addEventListener("click", () => {
      let created: Panel | null = null;
      this.edit((p) => (created = addInset(p, page, panel)));
      if (created) this.editor.select({ kind: "panel", pageId: page.id, id: (created as Panel).id });
    });
    const firstAlone = this.editor.firstAlone;
    const spread = panel.spread
      ? button("見開きをやめる", (p) => unspreadPanel(p, page, panel, firstAlone), "向かいのページの半分を消して、このページだけのコマに戻す")
      : button("見開きにする", (p) => spreadPanel(p, page, panel, firstAlone), "のどをまたいで向かいのページまで伸ばす");
    spread.disabled = !panel.spread && !facingPage(project, page, firstAlone);
    const note = element("input", { type: "text", value: panel.note ?? "", placeholder: "例: 俯瞰で教室全体 / 間" });
    this.liveText(note, (value) => {
      if (value) panel.note = value;
      else delete panel.note;
    });
    return [
      element("h2", { textContent: `${pageIndex(project, page.id) + 1} ページ ${order} コマ目` }),
      element("label", {}, "演出メモ", note),
      element("div", { className: "row" }, element("label", {}, "枠線", border), element("label", {}, "塗り", fill)),
      element("label", {}, "背景の効果", effect),
      element("h3", { textContent: "裁ち切り（ページの外まで）" }),
      element("div", { className: "row" }, ...bleeds),
      spread,
      element("h3", { textContent: "形と重なり" }),
      element("div", { className: "row" }, tiltLeft, tiltRight, raise, lower),
      inset,
      element("p", {
        className: "hint",
        textContent: `セリフ ${lines} 件。角の四角をドラッグすると形を変えられます（枠に吸い付きます。Alt で吸い付かない）。重なり ${panel.z ?? 0}。`,
      }),
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
    const pattern = element("select");
    for (const item of PATTERNS) pattern.append(element("option", { value: item.id, textContent: item.label, title: item.note }));
    const patternNote = element("p", { className: "hint", textContent: PATTERNS[0].note });
    pattern.addEventListener("change", () => (patternNote.textContent = PATTERNS.find((item) => item.id === pattern.value)?.note ?? ""));
    const applyButton = button("このページに当てる", async () => {
      if (page.panels.length && !(await ask("今のコマを置き換えますか？（元に戻すで戻せます）", { title: "Name Studio", kind: "warning" }))) return;
      this.edit((p) => {
        applyPattern(p, page, pattern.value);
        sortLines(page);
      });
    });
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
      element("h3", { textContent: "コマ割りの型" }),
      element("div", { className: "row" }, pattern, applyButton),
      patternNote,
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
      if (s.kind === "panel") {
        // The other half of a 見開き stays as a panel of its own page.
        const panel = page.panels.find((p) => p.id === s.id);
        const twin = panel && spreadTwin(project, page, panel);
        if (twin) delete twin.panel.spread;
        removePanel(page, s.id, project.binding);
      }
      if (s.kind === "line") page.lines = page.lines.filter((line) => line.id !== s.id);
      if (s.kind === "stroke") page.strokes = page.strokes.filter((stroke) => stroke.id !== s.id);
      if (s.kind === "breakout") page.breakouts = page.breakouts.filter((breakout) => breakout.id !== s.id);
      if (s.kind === "group") {
        const ids = new Set(s.items?.map((item) => item.id));
        page.strokes = page.strokes.filter((stroke) => !ids.has(stroke.id));
        page.lines = page.lines.filter((line) => !ids.has(line.id));
        for (const line of page.lines) if (line.linkTo && ids.has(line.linkTo)) delete line.linkTo;
      }
      if (s.kind === "line") {
        // Balloons joined to the removed one come loose.
        for (const line of page.lines) if (line.linkTo === s.id) delete line.linkTo;
      }
    });
    this.editor.select(null);
  }

  // --- controls -------------------------------------------------------------------------------

  setTool(tool: Tool): void {
    this.editor.setTool(tool);
    for (const name of ["select", "cut", "text", "pen", "eraser", "breakout"] as const) {
      $(`tool-${name}`).classList.toggle("active", name === tool);
    }
    this.renderBrushBar();
  }

  // --- pens and erasers -------------------------------------------------------------------

  /** Switch how the eraser erases, keeping the tool in hand. */
  setEraseMode(mode: EditorEraseMode): void {
    this.editor.eraseMode = mode;
    this.renderBrushBar();
    this.editor.draw();
    this.setStatus(`消し方: ${ERASE_MODE_LABELS[mode]}`);
  }

  /** Use a brush for its kind of tool, with its own size. */
  private useBrush(brush: Brush | null, kind: "pen" | "eraser" = brush?.kind ?? "pen"): void {
    if (kind === "eraser") {
      this.editor.eraserBrush = brush?.id ?? null;
      if (brush) this.editor.eraserSizeMm = brush.sizeMm;
      // A CSP vector eraser brings its way of erasing; it can be switched after.
      if (brush?.erase) this.editor.eraseMode = brush.erase;
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
    select.append(option("", kind === "pen" ? "標準のペン" : "標準の消しゴム"));
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
    $("erase-modes").hidden = kind !== "eraser";
    for (const mode of Object.keys(ERASE_MODE_LABELS) as EditorEraseMode[]) {
      $(`erase-${mode}`).classList.toggle("active", this.editor.eraseMode === mode);
    }
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
    for (const name of ["select", "cut", "text", "pen", "eraser", "breakout"] as const) {
      $(`tool-${name}`).addEventListener("click", () => this.setTool(name));
    }
    $("undo").addEventListener("click", () => this.undo());
    for (const mode of Object.keys(ERASE_MODE_LABELS) as EditorEraseMode[]) {
      $(`erase-${mode}`).addEventListener("click", () => this.setEraseMode(mode));
    }
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
    $("versions").addEventListener("click", () => this.openVersions());
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
    const tools: Record<string, Tool> = { v: "select", k: "cut", t: "text", p: "pen", e: "eraser", b: "breakout" };
    const tool = tools[event.key.toLowerCase()];
    if (tool === "eraser" && this.editor.tool === "eraser") {
      // E again: the next way of erasing, as CSP's sub tools cycle.
      const modes = Object.keys(ERASE_MODE_LABELS) as EditorEraseMode[];
      this.setEraseMode(modes[(modes.indexOf(this.editor.eraseMode) + 1) % modes.length]);
      return true;
    }
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

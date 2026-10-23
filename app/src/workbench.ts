// The name editor around the canvas: the open project, saving, undo, the
// page list, the script, the cast and the inspector for the selection.
import { invoke } from "@tauri-apps/api/core";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { Autosaver, autosaveToFile, formatTime } from "./autosave";
import { addBrushes, loadLibrary } from "./brush";
import { BrushDialog } from "./brushdialog";
import { dragSort } from "./dragsort";
import { AltDialog } from "./altdialog";
import { ScriptDialog } from "./scriptdialog";
import { ShortcutDialog } from "./shortcutdialog";
import { PenDialog } from "./pendialog";
import { arrangePage, arrangePanel, fitSpills } from "./arrange";
import { LayerView, moveIntoPanel, type LayerRef } from "./layers";
import { penPreferences } from "./pen";
import { comboOf, Shortcuts, type ActionId } from "./shortcuts";
import { alternativesOf, joinAlternative, makeAlternative, useAlternative } from "./alternatives";
import {
  ERASE_MODE_LABELS,
  PANEL_CARRIES_KEY,
  SHOW_NOTES_KEY,
  PageEditor,
  isTyping,
  pickedSummary,
  writeFlag,
  type EditorEraseMode,
  type Selection,
  type Tool,
} from "./editor";
import { SHAPE_LABELS, TAIL_LABELS, defaultTailStyle, resolvedShape } from "./balloon";
import { ExportDialog } from "./exportdialog";
import { History } from "./history";
import { VersionDialog, type VersionInfo } from "./versiondialog";
import {
  BORDER_LABELS,
  EFFECT_LABELS,
  FILL_LABELS,
  PATTERNS,
  patternCount,
  SIDE_LABELS,
  addInset,
  applyPattern,
  bleedPanel,
  facingPage,
  isBled,
  rotatePanel,
  spreadPanel,
  spreadPair,
  setSpreadPage,
  spreadTwin,
  unspreadPanel,
  type Side,
} from "./koma";
import { joinPanels, joinedShape, neighbours } from "./komaedit";
import { addAutoTails, wantsTail } from "./autotail";
import { Overview, type OverviewKind } from "./overview";
import { pageParts } from "./shapes";
import {
  KIND_LABELS,
  TONE_LABELS,
  addCharacter,
  addPanel,
  assignPanels,
  basicBox,
  fitLine,
  setDefaultShape,
  setLineText,
  setLineKind,
  wrapTypedLine,
  insertPage,
  movePage,
  movePagesTo,
  pageBlock,
  normalize,
  orderPanels,
  pageIndex,
  rectShape,
  removeCharacter,
  removePage,
  removeSticky,
  STICKY_COLORS,
  removePanel,
  sceneOf,
  sortLines,
  trailingEmptyPages,
  swapPanelContents,
  textAmount,
  type Brush,
  type BalloonShape,
  type Line,
  type FillTone,
  type LineKind,
  type Alternatives,
  type Page,
  type Sticky,
  type StickyColor,
  type Panel,
  type PanelBorder,
  type PanelEffect,
  type PanelFill,
  type Project,
  type RoughImage,
  type TailStyle,
  wantsSpread,
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
  /** Characters whose lines are listed in the 人物 tab. */
  private openCast = new Set<string>();
  private sideTab: "pages" | "script" | "cast" | "notes" | "layers" = "pages";
  private readonly layerView = new LayerView({
    selected: (ref) => this.layerSelected(ref),
    select: (ref) => this.selectLayer(ref),
    hidden: () => this.editor.hidden,
    setHidden: (keys, hide) => {
      for (const key of keys) {
        if (hide) this.editor.hidden.add(key);
        else this.editor.hidden.delete(key);
      }
      // Hidden things cannot stay picked.
      const s = this.editor.selection;
      if (s && s.kind !== "group" && this.editor.hidden.has(`${s.kind}:${s.id}`)) this.editor.select(null);
      this.editor.draw();
      this.renderLayers();
    },
    drop: (ref, to) => this.dropLayer(ref, to),
    lineLabel: (page, id) => {
      const text = page.lines.find((l) => l.id === id)?.text.replace(/\s+/g, " ").trim() ?? "";
      return text.length > 14 ? `${text.slice(0, 14)}…` : text || "（空）";
    },
  });
  readonly overview: Overview;
  private readonly exportDialog: ExportDialog;
  private readonly altDialog: AltDialog;
  private readonly scriptDialog: ScriptDialog;
  readonly shortcuts = new Shortcuts();
  private readonly shortcutDialog = new ShortcutDialog(this.shortcuts);
  private readonly penDialog = new PenDialog(penPreferences);
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
      actions: (selection) => this.actions(selection),
      run: (action) => this.run(action),
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
      movePages: (first, last, target) => this.movePages(first, last, target),
      makeOption: (first, last) => this.makeOption(first, last),
      status: (message) => this.setStatus(message),
      importText: () => this.scriptDialog.open(),
    });
    this.scriptDialog = new ScriptDialog({
      project: () => this.state.project,
      edit: (change) => this.edit(change),
      done: (report, firstPage) => {
        if (this.view !== "edit") this.setView("edit");
        this.editor.selection = null;
        this.editor.showPage(firstPage);
        this.renderAll();
        const who = report.characters.length ? `、登場人物 ${report.characters.join("・")} を足しました` : "";
        const scenes = report.replacedScenes ? `、重なっていたシーン ${report.replacedScenes} を台本のシーンに置き換えました` : "";
        const fixed = report.changed + report.added + report.removed + report.kept;
        const inserted = report.insertedPages ? `、ページを ${report.insertedPages} 枚入れました` : "";
        const left = report.leftPages.length ? `、台本にないページ ${report.leftPages.join("・")} はそのまま` : "";
        const update = fixed ? `。セリフを台本に合わせました: 書き換え ${report.changed}・足す ${report.added}・消す ${report.removed}・そのまま ${report.kept}${inserted}${left}` : "";
        this.setStatus(`台本を ${report.pages} ページに入れました（セリフ ${report.lines}、作ったコマ ${report.panels}${who}${scenes}）${update}。元に戻すは Ctrl+Z`);
      },
      plotDone: (report) => {
        // The plot is about the whole: show it on the board.
        this.setView("board");
        const added = report.addedPages ? `、ページを ${report.addedPages} 枚足しました` : "";
        this.setStatus(`プロットを取り込みました: ページのメモ ${report.memos}・シーン ${report.scenes}・付箋 ${report.stickies}${added}。元に戻すは Ctrl+Z`);
      },
    });
    this.altDialog = new AltDialog({
      project: () => this.state.project,
      edit: (change) => this.edit(change),
      shown: (set) => this.showSet(set),
    });
    this.exportDialog = new ExportDialog({
      project: () => this.state.project,
      projectPath: () => this.state.path,
      rough: (rough) => this.loadRough(rough),
      status: (message) => this.setStatus(message),
      goTo: (pageId, lineId) => this.goTo(pageId, "line", lineId),
      addTails: () => this.addTails(),
      fitSpills: () => {
        let redone = 0;
        this.edit((p) => (redone = fitSpills(p)));
        this.setStatus(redone ? `はみ出したセリフのあるコマ ${redone} 個を並べ直しました（元に戻すは Ctrl+Z）` : "はみ出したセリフはありません");
        return redone;
      },
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
    for (const name of ["edit", "board", "structure", "emotion", "timeline"] as const) {
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
    // A sheet often has more page cells than the episode: the empty ones at the end can go.
    const empty = trailingEmptyPages(p);
    if (empty > 0 && empty < p.pages.length) {
      const keep = p.pages.length - empty;
      if (await ask(`ネーム用紙の後ろの ${empty} ページは空です。除いて ${keep} ページにしますか？（あとで足すこともできます）`, { title: "Name Studio", kind: "info" })) {
        p.pages.splice(keep);
      }
    }
    const lines = p.pages.reduce((sum, page) => sum + page.lines.length, 0);
    const panels = p.pages.reduce((sum, page) => sum + page.panels.length, 0);
    const warnings = result.warnings.length ? ` ／ ${result.warnings.join(" ／ ")}` : "";
    const margins = p.pages.filter((page) => page.memo.includes("余白: ")).length;
    const marginNote = margins ? `（余白の文字は ${margins} ページのメモに入れました）` : "";
    this.show(p, null, `${p.pages.length} ページ、コマ ${panels}、セリフ ${lines} を取り込みました${marginNote}。保存先はまだ決まっていません${warnings}`);
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
    const lists = { panel: page.panels, line: page.lines, stroke: page.strokes, breakout: page.breakouts, sticky: page.stickies ?? [], fill: page.fills ?? [] };
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
    $("side-notes").hidden = this.sideTab !== "notes";
    $("side-layers").hidden = this.sideTab !== "layers";
    for (const tab of ["pages", "script", "cast", "notes"] as const) $(`tab-${tab}`).classList.toggle("active", this.sideTab === tab);
    $("tab-layers-edit").classList.toggle("active", this.sideTab === "layers");
    const project = this.state.project;
    if (!project) return;
    if (this.sideTab === "pages") this.renderPages(project);
    if (this.sideTab === "script") this.renderScript(project);
    if (this.sideTab === "cast") this.renderCast(project);
    if (this.sideTab === "notes") this.renderNotes(project);
    if (this.sideTab === "layers") this.renderLayers();
  }

  // --- レイヤー（コマ枠フォルダ） ----------------------------------------------------------

  private renderLayers(): void {
    const project = this.state.project;
    if (!project || this.sideTab !== "layers") return;
    const pages = this.editor
      .currentPages()
      .sort((a, b) => a - b)
      .map((number) => ({ page: project.pages[number - 1], number }))
      .filter(({ page }) => page);
    this.layerView.render($("side-layers"), pages);
  }

  private layerSelected(ref: LayerRef): boolean {
    const s = this.editor.selection;
    if (!s || s.pageId !== ref.pageId) return false;
    if (ref.kind === "strokes") {
      const picked = s.kind === "group" ? (s.items ?? []).filter((item) => item.kind === "stroke").map((item) => item.id) : s.kind === "stroke" ? [s.id] : [];
      return picked.length === ref.ids.length && ref.ids.every((id) => picked.includes(id));
    }
    return s.kind === ref.kind && s.id === ref.id;
  }

  private selectLayer(ref: LayerRef): void {
    if (this.editor.tool !== "select") this.setTool("select");
    if (ref.kind === "strokes") {
      const items = ref.ids.map((id) => ({ kind: "stroke" as const, id }));
      this.editor.select(items.length === 1 ? { kind: "stroke", pageId: ref.pageId, id: ref.ids[0] } : { kind: "group", pageId: ref.pageId, id: "group", items });
    } else {
      this.editor.select({ kind: ref.kind, pageId: ref.pageId, id: ref.id });
    }
    this.renderLayers();
  }

  private dropLayer(ref: LayerRef, to: { pageId: string; panelId: string }): void {
    const project = this.state.project;
    const from = project?.pages.find((p) => p.id === ref.pageId);
    const page = project?.pages.find((p) => p.id === to.pageId);
    const panel = page?.panels.find((p) => p.id === to.panelId);
    if (!project || !from || !page || !panel) return;
    if (ref.kind === "panel") {
      const source = from.panels.find((p) => p.id === ref.id);
      if (!source || source === panel) return;
      this.edit(() => swapPanelContents(from, source, page, panel));
      this.setStatus(`コマ ${source.order} とコマ ${panel.order} の中身を入れ替えました`);
      return;
    }
    let moved = false;
    this.edit(() => {
      moved = moveIntoPanel(from, ref, page, panel);
      for (const p of new Set([from, page])) {
        assignPanels(p);
        sortLines(p);
      }
    });
    if (moved) this.setStatus(`コマ ${panel.order} へ移しました（元に戻すは Ctrl+Z）`);
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
    // 話の型の色分け: each page marked with the part it falls in.
    const parts = pageParts(project);
    const items = project.pages.map((page, index) => {
      const scene = sceneOf(project, page.id);
      const sceneLabel = scene && scene.firstPage === page.id ? element("span", { className: "scene", textContent: scene.title }) : "";
      const part = parts[index];
      const item = element(
        "div",
        { className: `page-item${current.has(index + 1) ? " current" : ""}${part ? " tinted" : ""}`, title: part ? `${part.name}` : "" },
        element("span", { className: "number", textContent: String(index + 1) }),
        element("span", { className: "memo" }, sceneLabel, page.memo.split("\n")[0] || ""),
        ...this.optionTag(project, page),
        element("span", { className: "count", textContent: `コマ ${page.panels.length}・字 ${textAmount(page)}${page.stickies?.length ? `・付箋 ${page.stickies.length}` : ""}` }),
      );
      if (part) item.style.setProperty("--part", part.color);
      item.addEventListener("click", () => {
        if (this.view !== "edit") this.setView("edit");
        this.editor.selection = null;
        this.editor.showPage(index + 1);
        this.renderAll();
      });
      return item;
    });
    // Drag a page (a 見開き moves as a pair) to put it elsewhere.
    dragSort(items, {
      axis: "y",
      block: (index) => pageBlock(project, index),
      drop: (first, last, target) => this.movePages(first, last, target),
    });
    const add = element("button", { textContent: "最後にページを足す" });
    add.addEventListener("click", () => this.edit((p) => insertPage(p, p.pages.length)));
    $("side-pages").replaceChildren(work, ...items, element("div", { className: "side-actions" }, add));
  }

  /** The 別案 in use on a page, for the page list. */
  private optionTag(project: Project, page: Page): HTMLElement[] {
    const set = alternativesOf(project, page.id);
    const option = set?.options.find((o) => o.id === set.active);
    return option ? [element("span", { className: "option-tag", textContent: option.name, title: `別案 ${set!.options.length} つのうち使用中の案` })] : [];
  }

  /** Move pages by dragging and keep the same pages in view. */
  movePages(first: number, last: number, target: number): void {
    const project = this.state.project;
    if (!project) return;
    const shown = this.editor.currentPages().map((number) => project.pages[number - 1]?.id);
    let moved = false;
    this.edit((p) => (moved = movePagesTo(p, first, last, target)));
    if (!moved) return;
    const index = project.pages.findIndex((page) => page.id === shown[0]);
    if (index >= 0) this.editor.showPage(index + 1);
    const count = last - first + 1;
    this.setStatus(`${count === 1 ? `${first + 1} ページ` : `${first + 1}–${last + 1} ページ`}を動かしました（元に戻すは Ctrl+Z）`);
    this.renderAll();
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
    const take = element("button", { textContent: "台本・プロットを取り込む…", title: "Markdown の台本（コマとセリフ）か、プロット（ページごとの文）を取り込む" });
    take.addEventListener("click", () => this.scriptDialog.open());
    $("side-script").replaceChildren(element("div", { className: "side-actions top" }, take), ...children);
  }

  private renderCast(project: Project): void {
    const rows = project.characters.map((character) => {
      const name = element("input", { type: "text", value: character.name });
      name.addEventListener("change", () => this.edit(() => (character.name = name.value.trim() || character.name)));
      const color = element("input", { type: "color", value: character.color ?? "#2f6fdb" });
      color.addEventListener("change", () => this.edit(() => (character.color = color.value)));
      const said = project.pages.flatMap((page, index) => page.lines.filter((l) => l.speaker === character.id).map((line) => ({ page, index, line })));
      const remove = element("button", { className: "danger", textContent: "削除", title: `セリフ ${said.length} 件の話者が空になります` });
      remove.addEventListener("click", () => this.edit((p) => removeCharacter(p, character.id)));
      // 口調: kept beside the name, to write the dialogue in voice.
      const tone = element("textarea", { className: "tone", rows: 2, placeholder: "口調のメモ（一人称・語尾・口ぐせ）", value: character.tone ?? "" });
      tone.addEventListener("change", () => {
        const text = tone.value.trim();
        // Also fires on the blur when the list is drawn again: only a real change is an edit.
        if (text === (character.tone ?? "")) return;
        this.edit(() => {
          if (text) character.tone = text;
          else delete character.tone;
        });
      });
      // その人のセリフを並べて、口調が揃っているか見る。
      const open = this.openCast.has(character.id);
      const toggle = element("button", { className: "count", textContent: `${open ? "▾" : "▸"} ${said.length}`, title: "この人のセリフを並べる" });
      toggle.addEventListener("click", () => {
        if (open) this.openCast.delete(character.id);
        else this.openCast.add(character.id);
        this.renderCast(project);
      });
      const list = open
        ? [
            element(
              "ol",
              { className: "cast-lines" },
              ...said.map(({ page, index, line }) => {
                const item = element("li", { textContent: `${index + 1}  ${line.text.replace(/\s+/g, "")}`, title: "このセリフへ" });
                item.addEventListener("click", () => this.goTo(page.id, "line", line.id));
                return item;
              }),
            ),
          ]
        : [];
      return element("div", { className: "cast-block" }, element("div", { className: "cast-item" }, color, name, toggle, remove), tone, ...list);
    });
    const add = element("button", { textContent: "人物を足す" });
    add.addEventListener("click", () => this.edit((p) => addCharacter(p, `人物${p.characters.length + 1}`)));
    const hint = element("p", { className: "hint", textContent: "セリフを選んで、右の欄で話者を選べます。数を押すとその人のセリフを並べます。" });
    $("side-cast").replaceChildren(...rows, element("div", { className: "side-actions" }, add), hint);
  }

  /** 付箋の一覧: every page's stickies in one place, the open questions of the name. */
  private renderNotes(project: Project): void {
    const items = project.pages.flatMap((page, index) =>
      (page.stickies ?? []).map((sticky) => {
        const swatch = element("span", { className: "swatch" });
        swatch.style.background = STICKY_COLORS[sticky.color ?? "yellow"].fill;
        const text = element("span", { className: "note-text", textContent: sticky.text.trim() || "（空の付箋）" });
        const where = element("span", { className: "count", textContent: `${index + 1}` });
        const row = element("div", { className: "note-item", title: "この付箋へ" }, swatch, where, text);
        row.addEventListener("click", () => this.goTo(page.id, "sticky", sticky.id));
        const done = element("button", { className: "small", textContent: "済み", title: "決まったので付箋を外す（元に戻すで戻せます）" });
        done.addEventListener("click", (event) => {
          event.stopPropagation();
          this.edit(() => removeSticky(page, sticky.id));
        });
        row.append(done);
        return row;
      }),
    );
    const head = element("p", { className: "hint", textContent: items.length ? `付箋 ${items.length} 枚（未決のこと）。押すとその付箋へ、決まったら「済み」。` : "付箋はありません。付箋ツールでページに貼ると、ここに集まります。" });
    $("side-notes").replaceChildren(head, ...items);
  }

  /** Show a page in the editor with one of its things selected. */
  private goTo(pageId: string, kind: "line" | "sticky", id: string): void {
    const index = this.state.project?.pages.findIndex((p) => p.id === pageId) ?? -1;
    if (index < 0) return;
    if (this.view !== "edit") this.setView("edit");
    if (this.editor.tool !== "select") this.setTool("select");
    this.editor.showPage(index + 1);
    this.editor.select({ kind, pageId, id });
    this.renderAll();
  }

  // --- inspector --------------------------------------------------------------------------

  renderInspector(): void {
    this.renderInspectorPanel();
    this.renderLayers();
    // The bar's buttons hold the objects of the project as it is now.
    this.editor.renderBar();
  }

  /** The bar of actions beside the selection: what is used most, without going to the right. */
  private actions(selection: Selection): HTMLElement[] {
    const project = this.state.project;
    const page = project?.pages.find((p) => p.id === selection.pageId);
    if (!project || !page) return [];
    const button = (label: string, title: string, run: () => void, className = "") => {
      const b = element("button", { textContent: label, title, className });
      b.addEventListener("click", run);
      return b;
    };
    const copy = button("コピー", "コピー（Ctrl+C）。Ctrl+V でポインターのあるページへ", () => this.editor.copy());
    const transform = button(
      "変形",
      "拡大縮小・回転・自由変形（Ctrl+T）。四角で大きさ、丸で回転、Ctrl + 角で自由変形。Enter で終わる",
      () => this.editor.toggleTransform(),
      this.editor.isTransforming ? "active" : "",
    );
    const remove = button("消す", "消す（Delete）", () => this.deleteSelection(), "danger");
    switch (selection.kind) {
      case "panel": {
        const panel = page.panels.find((p) => p.id === selection.id);
        if (!panel) return [];
        const inset = button("はめ込み", "このコマの角に重ねる小さなコマを足す", () => {
          let created: Panel | null = null;
          this.edit((p) => (created = addInset(p, page, panel)));
          if (created) this.editor.select({ kind: "panel", pageId: page.id, id: (created as Panel).id });
        });
        const hasLines = page.lines.some((line) => line.panel === panel.id);
        const arrange = button("セリフを並べる", "このコマのセリフを読む順に右上から並べ直す（長いセリフは改行）", () => this.arrange(page.id, panel.id));
        return [
          button("メモ", "このコマのメモをその場で書く（コマをダブルクリックでも）", () => this.editor.editInPlace(page.id, "note", panel.id)),
          transform,
          ...(hasLines ? [arrange] : []),
          inset,
          copy,
          remove,
        ];
      }
      case "line": {
        const line = page.lines.find((l) => l.id === selection.id);
        if (!line) return [];
        const kind = choice(KIND_LABELS, line.kind, (value: LineKind) => this.edit((p) => setLineKind(p, line, value)));
        kind.title = "種類";
        const tail = button("しっぽ", "しっぽを足す。丸い先をドラッグして話者に向ける", () =>
          this.edit(() => {
            const [x0, , , y1] = line.box;
            const offset = (line.tails?.length ?? 0) * 8;
            line.tails = [...(line.tails ?? []), { tip: [x0 - 6 - offset, y1 + 12], style: defaultTailStyle(line) }];
          }),
        );
        tail.disabled = resolvedShape(line) === "none";
        return [button("書く", "その場で書き直す（ダブルクリックでも）", () => this.editor.editInPlace(page.id, "line", line.id)), kind, tail, transform, copy, remove];
      }
      case "stroke":
      case "group":
        return [
          button("左右反転", "左右を入れ替える", () => this.editor.transformSelection("flipH")),
          button("⟳ 90°", "右に 90° 回す", () => this.editor.transformSelection("right")),
          copy,
          remove,
        ];
      case "fill": {
        const fill = page.fills?.find((f) => f.id === selection.id);
        if (!fill) return [];
        const tone = choice(TONE_LABELS, fill.tone ?? "black", (value: FillTone) =>
          this.edit(() => {
            if (value === "black") delete fill.tone;
            else fill.tone = value;
          }),
        );
        return [tone, transform, copy, remove];
      }
      case "breakout":
        return [transform, copy, remove];
      default:
        return [copy, remove];
    }
  }

  /** そのページのメモ（プロット）, kept in sight while working on its panels and dialogue. */
  private pageMemo(project: Project, page: Page): HTMLElement[] {
    const memo = page.memo.trim();
    if (!memo) return [];
    const box = element("div", { className: "page-memo", title: "ページのメモ（ページを選ぶと直せます）" });
    box.append(element("span", { className: "label", textContent: `${pageIndex(project, page.id) + 1} ページのメモ` }), element("div", { textContent: memo }));
    return [box];
  }

  private renderInspectorPanel(): void {
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
      if (line) return panel.replaceChildren(...this.pageMemo(project, page), ...this.lineInspector(project, page, line));
    }
    if (s?.kind === "panel") {
      const target = page.panels.find((p) => p.id === s.id);
      if (target) return panel.replaceChildren(...this.pageMemo(project, page), ...this.panelInspector(project, page, target.id, target.order));
    }
    if (s?.kind === "sticky") {
      const sticky = page.stickies?.find((n) => n.id === s.id);
      if (sticky) return panel.replaceChildren(...this.stickyInspector(sticky));
    }
    if (s?.kind === "fill") {
      const fill = page.fills?.find((f) => f.id === s.id);
      if (fill) {
        const tone = choice(TONE_LABELS, fill.tone ?? "black", (value: FillTone) =>
          this.edit(() => {
            if (value === "black") delete fill.tone;
            else fill.tone = value;
          }),
        );
        const remove = element("button", { className: "danger", textContent: "この塗りを消す" });
        remove.addEventListener("click", () => this.deleteSelection());
        return panel.replaceChildren(
          element("h2", { textContent: "塗り" }),
          element("label", {}, "色", tone),
          element("p", { className: "hint", textContent: "ドラッグや矢印キーで動かせます。コマを動かすと一緒に動きます。CSP には「コマの塗り・効果」の画像レイヤーで書き出します。" }),
          remove,
        );
      }
    }
    if (s?.kind === "group") {
      const remove = element("button", { className: "danger", textContent: "選んだものを消す（Delete）" });
      remove.addEventListener("click", () => this.deleteSelection());
      return panel.replaceChildren(
        element("h2", { textContent: "範囲選択" }),
        element("p", {
          className: "hint",
          textContent: `${pickedSummary(s.items ?? [])}。ドラッグや矢印キーでまとめて動かせます（コマは中に描いたものと一緒に）。枠の四角で大きさ（Shift で縦横別々、Alt で中心から）、上の丸で向き（Shift で 15° ずつ）、Ctrl + 角で自由変形。Shift + クリックで足す・外す。Ctrl+C / Ctrl+V でほかのページへも写せます。`,
        }),
        ...this.transformButtons(),
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
        ...this.transformButtons(),
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
    this.liveText(text, (value) => setLineText(line, value));
    // Done typing a long line in one go: broken into short lines (before the change is recorded).
    text.addEventListener("change", () => {
      if (wrapTypedLine(line)) {
        text.value = line.text;
        this.editor.draw();
      }
    }, { capture: true });
    const kind = element("select");
    for (const [value, label] of Object.entries(KIND_LABELS)) kind.append(element("option", { value, textContent: label }));
    kind.value = line.kind;
    kind.addEventListener("change", () => this.edit((p) => setLineKind(p, line, kind.value as LineKind)));
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
        setLineText(line, line.text);
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
    // 作品の既定: this kind of line gets this shape from now on.
    const current = line.balloonShape ?? "auto";
    const usual = project.lineShapes?.[line.kind] ?? "auto";
    const makeDefault = element("button", {
      textContent: `「${KIND_LABELS[line.kind]}」の既定にする`,
      title: "この作品で、この種類のセリフを作るときの形にする。今までの既定の形だった同じ種類のセリフも変わります",
      disabled: current === usual || current === "custom",
    });
    makeDefault.addEventListener("click", () => {
      let changed = 0;
      this.edit((p) => {
        changed = setDefaultShape(p, line.kind, current);
      });
      this.setStatus(`「${KIND_LABELS[line.kind]}」の形を「${SHAPE_LABELS[current]}」にしました（同じ種類のほかのセリフ ${changed} 個も変えました）。台本の取り込みや新しいセリフもこの形になります`);
    });
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
      // Written on the page itself when it is open there.
      if (line.text === "セリフ" && !this.editor.editingInPlace) {
        text.focus();
        text.select();
      }
    });
    return [
      element("h2", { textContent: `${pageIndex(project, page.id) + 1} ページのセリフ${panelNumber ? `（${panelNumber} コマ目）` : ""}` }),
      element("label", {}, "文字", text),
      element("div", { className: "row" }, element("label", {}, "種類", kind), element("label", {}, "話者", speaker)),
      ...(toneOf(project, line.speaker) ? [element("p", { className: "hint tone-hint", textContent: `口調: ${toneOf(project, line.speaker)}` })] : []),
      element("div", { className: "row" }, element("label", {}, "文字の大きさ（pt）", size), element("label", { className: "inline" }, vertical, "縦書き")),
      element("div", { className: "row" }, emphasis, inverted),
      element("h3", { textContent: "フキダシ" }),
      element("label", {}, "形", shape),
      makeDefault,
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
    const carries = element("input", { type: "checkbox", checked: this.editor.panelCarries });
    carries.addEventListener("change", () => {
      this.editor.panelCarries = carries.checked;
      writeFlag(PANEL_CARRIES_KEY, carries.checked);
    });
    const note = element("input", { type: "text", value: panel.note ?? "", placeholder: "例: 俯瞰で教室全体 / 間" });
    this.liveText(note, (value) => {
      if (value) panel.note = value;
      else delete panel.note;
    });
    return [
      element("h2", { textContent: `${pageIndex(project, page.id) + 1} ページ ${order} コマ目` }),
      element("label", {}, "メモ（ページの上にも出ます。コマをダブルクリックでその場で書けます）", note),
      element("div", { className: "row" }, element("label", {}, "枠線", border), element("label", {}, "塗り", fill)),
      element("label", {}, "背景の効果", effect),
      element("h3", { textContent: "裁ち切り（ページの外まで）" }),
      element("div", { className: "row" }, ...bleeds),
      spread,
      element("h3", { textContent: "形と重なり" }),
      element("label", { className: "inline" }, carries, "動かす・形を変えるとき、中のセリフとラフ線も一緒に"),
      element("div", { className: "row" }, tiltLeft, tiltRight, raise, lower),
      inset,
      ...(lines
        ? [
            (() => {
              const b = element("button", { textContent: "このコマのセリフを並べ直す", title: "読む順に右上から並べ直す。長いセリフは句読点や助詞のあとで改行する" });
              b.addEventListener("click", () => this.arrange(page.id, panel.id));
              return b;
            })(),
          ]
        : []),
      ...this.joinButtons(page, panel),
      element("p", {
        className: "hint",
        textContent: `セリフ ${lines} 件。コマの境目（間白）をドラッグすると両側のコマが一緒に動き、外側の辺なら辺だけが動きます。境目をダブルクリックで隣とつなげます。角の四角をドラッグすると形を変えられます（枠に吸い付きます。Alt で吸い付かない）。右上の番号を別のコマへドラッグ（または Alt + ドラッグ）すると中身を入れ替えます。重なり ${panel.z ?? 0}。`,
      }),
      remove,
    ];
  }

  /** しっぽを付ける: on one page, or on every page. Returns how many were added. */
  private addTails(pageId?: string): number {
    let added = 0;
    this.edit((p) => {
      for (const page of p.pages) if (!pageId || page.id === pageId) added += addAutoTails(page);
    });
    this.setStatus(added ? `しっぽ ${added} 本を話者（コマのラフ）へ向けて付けました。丸い先をドラッグで直せます（元に戻すは Ctrl+Z）` : "しっぽのないセリフはありません");
    return added;
  }

  /** セリフの並べ直し: a panel's dialogue, or every panel's on the page. */
  private arrange(pageId: string, panelId?: string): void {
    let moved = 0;
    this.edit((p) => {
      const page = p.pages.find((x) => x.id === pageId);
      const panel = page?.panels.find((x) => x.id === panelId);
      if (!page) return;
      moved = panel ? arrangePanel(p, page, panel) : arrangePage(p, page);
    });
    this.setStatus(moved ? `セリフ ${moved} 個を読む順に並べ直しました（元に戻すは Ctrl+Z）` : "並べ直すセリフがありません（コマの中のセリフだけを並べます）");
  }

  /** 反転・回転 of the selected rough lines and dialogue. */
  private transformButtons(): HTMLElement[] {
    const make = (label: string, how: "flipH" | "flipV" | "left" | "right", title: string) => {
      const b = element("button", { textContent: label, title });
      b.addEventListener("click", () => this.editor.transformSelection(how));
      return b;
    };
    return [
      element("h3", { textContent: "変形" }),
      element("div", { className: "row" }, make("左右反転", "flipH", "左右を入れ替える"), make("上下反転", "flipV", "上下を入れ替える")),
      element("div", { className: "row" }, make("⟲ 90°", "left", "左に 90° 回す"), make("⟳ 90°", "right", "右に 90° 回す")),
    ];
  }

  /** つなげる: one button per panel across a border from this one. */
  private joinButtons(page: Page, panel: Panel): HTMLElement[] {
    const found = neighbours(page, panel);
    if (!found.length) return [];
    const order = { right: 0, top: 1, bottom: 2, left: 3 } as const;
    const buttons = found
      .sort((a, b) => order[a.side] - order[b.side])
      .map(({ panel: other, side }) => {
        const b = element("button", { textContent: `${SIDE_LABELS[side]}の ${other.order} とつなげる`, title: "間白をなくして 1 つのコマにする" });
        b.disabled = !!panel.spread || !!other.spread || !joinedShape(panel, other);
        if (b.disabled) b.title = "形がそろっていないか見開きのコマなので、つなげられません";
        b.addEventListener("click", () => {
          let joined = false;
          this.edit((p) => {
            const target = p.pages.find((x) => x.id === page.id);
            const a = target?.panels.find((x) => x.id === panel.id);
            const c = target?.panels.find((x) => x.id === other.id);
            if (!target || !a || !c) return;
            const [first, second] = a.order < c.order ? [a, c] : [c, a];
            joined = joinPanels(target, first, second, p.binding);
            if (joined) {
              assignPanels(target);
              sortLines(target);
              this.editor.selection = { kind: "panel", pageId: page.id, id: first.id };
            }
          });
          if (joined) this.setStatus("コマをつなげました（元に戻すは Ctrl+Z）");
        });
        return b;
      });
    return [element("h3", { textContent: "つなげる" }), element("div", { className: "row" }, ...buttons)];
  }

  private stickyInspector(sticky: Sticky): HTMLElement[] {
    const text = element("textarea", { value: sticky.text, placeholder: "気づいたこと、直したいこと" });
    this.liveText(text, (value) => (sticky.text = value));
    const colors = (Object.keys(STICKY_COLORS) as StickyColor[]).map((color) => {
      const chip = element("button", { className: `sticky-color${(sticky.color ?? "yellow") === color ? " active" : ""}`, textContent: STICKY_COLORS[color].label, title: `${STICKY_COLORS[color].label}色` });
      chip.style.background = STICKY_COLORS[color].fill;
      chip.addEventListener("click", () =>
        this.edit(() => {
          if (color === "yellow") delete sticky.color;
          else sticky.color = color;
        }),
      );
      return chip;
    });
    const remove = element("button", { className: "danger", textContent: "この付箋をはがす" });
    remove.addEventListener("click", () => this.deleteSelection());
    // A new note: ready to write in.
    if (!sticky.text) setTimeout(() => text.focus(), 0);
    return [
      element("h2", { textContent: "付箋" }),
      element("label", {}, "メモ", text),
      element("div", { className: "row sticky-colors" }, ...colors),
      element("p", { className: "hint", textContent: "付箋は作業用のメモで、CSP・PDF には書き出しません。ドラッグで動かせます。" }),
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
    for (const item of PATTERNS) pattern.append(element("option", { value: item.id, textContent: `${item.label}（${patternCount(item.id)}）`, title: item.note }));
    const patternNote = element("p", { className: "hint", textContent: PATTERNS[0].note });
    // コマ数: empty keeps the pattern's own; the page's count is one click away.
    const count = element("input", { type: "number", min: "1", max: "12", step: "1", className: "count", title: "コマ数（空なら型のまま）" });
    count.placeholder = String(patternCount(pattern.value));
    pattern.addEventListener("change", () => {
      patternNote.textContent = PATTERNS.find((item) => item.id === pattern.value)?.note ?? "";
      count.placeholder = String(patternCount(pattern.value));
    });
    const applyButton = button("このページに当てる", async () => {
      const question = "今のコマを置き換えますか？中のセリフ・ラフ線・コマのメモは、コマの順に新しいコマへ移します（元に戻すで戻せます）";
      if (page.panels.length && !(await ask(question, { title: "Name Studio", kind: "warning" }))) return;
      this.edit((p) => {
        const wanted = Number(count.value);
        applyPattern(p, page, pattern.value, wanted >= 1 ? Math.min(12, Math.round(wanted)) : undefined);
        sortLines(page);
      });
    });
    // A page added inside a 別案 belongs to that option (another ページ配分).
    const after = button("後ろにページを足す", () => this.edit((p) => joinAlternative(p, insertPage(p, index + 1).id, page.id, true)));
    const before = button("前にページを足す", () => this.edit((p) => joinAlternative(p, insertPage(p, index).id, page.id, false)));
    const earlier = button("1 つ前へ", () => this.edit((p) => movePage(p, page.id, -1)), index === 0);
    const later = button("1 つ後ろへ", () => this.edit((p) => movePage(p, page.id, 1)), index === project.pages.length - 1);
    const remove = button("このページを消す", async () => {
      const filled = page.panels.length + page.lines.length + page.strokes.length > 0;
      if (filled && !(await ask(`${index + 1} ページを消しますか？（元に戻すで戻せます）`, { title: "Name Studio", kind: "warning" }))) return;
      this.edit((p) => removePage(p, page.id));
    });
    remove.className = "danger";
    const pair = spreadPair(project, page, this.editor.firstAlone);
    const spreadSection: HTMLElement[] = [];
    if (pair) {
      const pairIndex = pageIndex(project, pair[0].id);
      const forced = wantsSpread(project, pairIndex) && !pair[0].joinNext;
      const box = element("input", { type: "checkbox", checked: wantsSpread(project, pairIndex), disabled: forced });
      box.addEventListener("change", () => this.edit((p) => setSpreadPage(p, page, this.editor.firstAlone, box.checked)));
      spreadSection.push(
        element("h3", { textContent: "見開き" }),
        element("label", { className: "inline" }, box, `${pairIndex + 1}–${pairIndex + 2} ページを CSP で 1 枚の見開きページにする`),
        element("p", {
          className: "hint",
          textContent: forced
            ? "ノドをまたぐコマがあるので、見開きページとして書き出します。"
            : "書き出すと、CSP の見開きページ（幅 2 倍の 1 ファイル）になります。ノドをまたいで線やコマを描けます。",
        }),
      );
    }
    const set = alternativesOf(project, page.id);
    const altSection: HTMLElement[] = [element("h3", { textContent: "別案" })];
    if (set) {
      const chips = set.options.map((option) => {
        const chip = button(option.name, () => this.useOption(set, option.id), false);
        if (option.id === set.active) chip.className = "in-use";
        chip.title = option.id === set.active ? "使用中" : "この案にする";
        return chip;
      });
      const first = pageIndex(project, set.pageIds[0]);
      const last = pageIndex(project, set.pageIds[set.pageIds.length - 1]);
      altSection.push(
        element("div", { className: "alt-chips" }, ...chips),
        element(
          "div",
          { className: "row" },
          button("比べる…", () => this.altDialog.open(set.id)),
          button("もう 1 案", () => this.makeOption(first, last)),
        ),
        element("p", { className: "hint", textContent: "案を押すとその案に入れ替わります。ページを足すと、その案だけのページになります（ページ配分の案）。" }),
      );
    } else {
      altSection.push(element("div", { className: "row" }, button("このページの別案を作る", () => this.makeOption(index, index))));
      if (pair) {
        const pairIndex = pageIndex(project, pair[0].id);
        altSection.push(element("div", { className: "row" }, button(`${pairIndex + 1}–${pairIndex + 2} ページの別案を作る`, () => this.makeOption(pairIndex, pairIndex + 1))));
      }
      altSection.push(element("p", { className: "hint", textContent: "今のページを写した案ができ、そちらを編集します。元の案はそのまま残り、比べて選べます。" }));
    }
    return [
      element("h2", { textContent: `${index + 1} ページ` }),
      element("label", {}, "メモ", memo),
      element("h3", { textContent: "コマ" }),
      element("div", { className: "row" }, frame, reorder),
      button("このページのセリフを並べ直す", () => this.arrange(page.id), !page.lines.length),
      button("しっぽのないセリフにしっぽを付ける", () => this.addTails(page.id), !page.lines.some((line) => wantsTail(page, line))),
      element("p", { className: "hint", textContent: "コマ割り: コマを横切るように線を引くと割れます（ほぼ水平・垂直はまっすぐに。Alt で斜め）。コマの外をドラッグすると新しいコマ。" }),
      element("h3", { textContent: "コマ割りの型" }),
      element("div", { className: "row" }, pattern, element("label", { className: "inline" }, count, "コマ")),
      applyButton,
      patternNote,
      element(
        "p",
        { className: "hint" },
        "コマ数を入れると、型の見た目のまま段のコマをつなげる・割って合わせます。",
        ...(page.panels.length
          ? [" ", button(`今のコマ数（${page.panels.length}）にする`, () => (count.value = String(page.panels.length)), false)]
          : []),
      ),
      ...spreadSection,
      ...altSection,
      element("h3", { textContent: "ページ" }),
      element("div", { className: "row" }, before, after),
      element("div", { className: "row" }, earlier, later),
      remove,
    ];
  }

  /** 別案: copy pages `first`..`last` as a new option and edit it. */
  makeOption(first: number, last: number): void {
    let set: Alternatives | null = null;
    this.edit((p) => (set = makeAlternative(p, first, last)));
    if (!set) {
      this.setStatus("一部のページがほかの別案に入っているため、この範囲の別案は作れません");
      return;
    }
    const made = set as Alternatives;
    this.showSet(made);
    const name = made.options.find((option) => option.id === made.active)?.name;
    this.setStatus(`別案「${name}」を作りました。元の案と比べるには「比べる…」`);
  }

  private useOption(set: Alternatives, optionId: string): void {
    this.edit((p) => useAlternative(p, set.id, optionId));
    this.showSet(set);
    this.setStatus(`「${set.options.find((option) => option.id === optionId)?.name}」にしました（元に戻すは Ctrl+Z）`);
  }

  /** Show the first page of a set's option in use. */
  private showSet(set: Alternatives): void {
    const project = this.state.project;
    if (!project) return;
    const index = pageIndex(project, set.pageIds[0]);
    if (index < 0) return;
    if (this.view !== "edit") this.setView("edit");
    this.editor.selection = null;
    this.editor.showPage(index + 1);
    this.renderAll();
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
      if (s.kind === "sticky") removeSticky(page, s.id);
      if (s.kind === "fill" && page.fills) page.fills = page.fills.filter((fill) => fill.id !== s.id);
      if (s.kind === "group") {
        const ids = (kind: string) => new Set(s.items?.filter((item) => item.kind === kind).map((item) => item.id));
        const [strokes, lines, panels, fills, breakouts] = ["stroke", "line", "panel", "fill", "breakout"].map(ids);
        page.strokes = page.strokes.filter((stroke) => !strokes.has(stroke.id));
        page.lines = page.lines.filter((line) => !lines.has(line.id));
        for (const line of page.lines) if (line.linkTo && lines.has(line.linkTo)) delete line.linkTo;
        page.breakouts = page.breakouts.filter((breakout) => !breakouts.has(breakout.id));
        if (page.fills) page.fills = page.fills.filter((fill) => !fills.has(fill.id));
        if (panels.size) {
          // What was drawn in the panels stays, as when one panel is removed.
          page.panels = page.panels.filter((panel) => !panels.has(panel.id));
          orderPanels(page, project.binding);
          assignPanels(page);
        }
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
    for (const name of ["select", "cut", "text", "pen", "eraser", "fill", "breakout", "sticky"] as const) {
      $(`tool-${name}`).classList.toggle("active", name === tool);
    }
    $("fill-tones").hidden = tool !== "fill";
    this.renderBrushBar();
  }

  /** 投げなわ塗り: what the fill tool fills with. */
  private setFillTone(tone: FillTone): void {
    this.editor.fillTone = tone;
    for (const name of ["black", "gray", "white"] as const) $(`fill-${name}`).classList.toggle("active", name === tone);
    if (this.editor.tool !== "fill") this.setTool("fill");
    this.setStatus(`塗り: ${TONE_LABELS[tone]}`);
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
    for (const tone of ["black", "gray", "white"] as const) {
      $(`fill-${tone}`).addEventListener("click", () => this.setFillTone(tone));
    }
    for (const name of ["select", "cut", "text", "pen", "eraser", "fill", "breakout", "sticky"] as const) {
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
    $("shortcuts").addEventListener("click", () => this.shortcutDialog.open());
    $("pen-settings").addEventListener("click", () => this.penDialog.open());
    $("redo").addEventListener("click", () => this.redo());
    $("editor-next").addEventListener("click", () => this.flip(1));
    $("editor-prev").addEventListener("click", () => this.flip(-1));
    const showNotes = $<HTMLInputElement>("show-notes");
    showNotes.checked = this.editor.showNotes;
    showNotes.addEventListener("change", () => {
      this.editor.showNotes = showNotes.checked;
      writeFlag(SHOW_NOTES_KEY, showNotes.checked);
      this.editor.draw();
    });
    $<HTMLInputElement>("editor-first-alone").addEventListener("change", (event) => {
      this.editor.firstAlone = (event.target as HTMLInputElement).checked;
      this.editor.spreadIndex = 0;
      this.renderAll();
    });
    for (const name of ["edit", "board", "structure", "emotion", "timeline"] as const) {
      $(`view-${name}`).addEventListener("click", () => this.setView(name));
    }
    for (const tab of ["pages", "script", "cast", "notes"] as const) {
      $(`tab-${tab}`).addEventListener("click", () => {
        this.sideTab = tab;
        this.renderSide();
      });
    }
    $("tab-layers-edit").addEventListener("click", () => {
      this.sideTab = "layers";
      this.renderSide();
    });
  }

  private flip(step: number): void {
    this.editor.selection = null;
    this.editor.flip(step);
    this.renderAll();
  }

  /** Keyboard shortcuts while the editor is shown; true when handled. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.state.project) return false;
    const combo = comboOf(event);
    const action = combo ? this.shortcuts.actionFor(combo) : null;
    // Saving works from a text field too; the rest leaves typing alone.
    if (action === "save" || action === "saveAs") {
      void this.save(action === "saveAs");
      return true;
    }
    if (isTyping(event) || document.querySelector("dialog[open]")) return false;
    // Arrows move what is selected (Shift: further) before anything else.
    const step = event.shiftKey ? 5 : 0.5;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const arrow = arrows[event.key];
    if (arrow && this.view === "edit" && this.editor.selection && !event.ctrlKey && !event.metaKey && !event.altKey) {
      return this.editor.nudge(...arrow);
    }
    return action ? this.run(action) : false;
  }

  /** Run a shortcut's action; false when it does not apply now. */
  run(action: ActionId): boolean {
    const views: Partial<Record<ActionId, "edit" | OverviewKind>> = {
      "view.edit": "edit",
      "view.board": "board",
      "view.structure": "structure",
      "view.emotion": "emotion",
      "view.timeline": "timeline",
    };
    const view = views[action];
    if (view) {
      this.setView(view);
      return true;
    }
    if (action === "view.fit" || action === "view.rotateLeft" || action === "view.rotateRight") {
      if (this.view !== "edit") return false;
      if (action === "view.fit") this.editor.fitView();
      else this.editor.rotateView(action === "view.rotateLeft" ? -15 : 15);
      return true;
    }
    if (action === "view.focus") {
      // As CSP's Tab: the side panels go, the pages take the room.
      document.body.classList.toggle("focus-mode");
      this.editor.resize();
      this.setStatus(document.body.classList.contains("focus-mode") ? "左右の欄を隠しました（Tab で戻す）" : "");
      return true;
    }
    if (action === "undo") this.undo();
    else if (action === "redo") this.redo();
    else if (this.view !== "edit") return false;
    if (action === "undo" || action === "redo") return true;
    const tools: Partial<Record<ActionId, Tool>> = {
      "tool.select": "select",
      "tool.cut": "cut",
      "tool.text": "text",
      "tool.pen": "pen",
      "tool.eraser": "eraser",
      "tool.fill": "fill",
      "tool.breakout": "breakout",
      "tool.sticky": "sticky",
    };
    const tool = tools[action];
    const nextEraseMode = () => {
      // As CSP's sub tools cycle.
      const modes = Object.keys(ERASE_MODE_LABELS) as EditorEraseMode[];
      this.setEraseMode(modes[(modes.indexOf(this.editor.eraseMode) + 1) % modes.length]);
    };
    if (tool === "eraser" && this.editor.tool === "eraser") {
      nextEraseMode();
      return true;
    }
    if (tool) {
      this.setTool(tool);
      return true;
    }
    switch (action) {
      case "eraser.next":
        if (this.editor.tool !== "eraser") this.setTool("eraser");
        else nextEraseMode();
        return true;
      case "brush.bigger":
      case "brush.smaller":
        return this.resizeBrush(action === "brush.bigger" ? 1.25 : 0.8);
      case "delete":
        this.deleteSelection();
        return true;
      case "copy":
        return this.editor.copy();
      case "cut":
        if (!this.editor.copy()) return false;
        this.deleteSelection();
        this.setStatus("切り取りました。Ctrl+V で、ポインターのあるページに貼り付けます");
        return true;
      case "paste":
        return this.editor.paste();
      case "selectAll":
        return this.editor.selectAll();
      case "flip.horizontal":
        return this.editor.transformSelection("flipH");
      case "flip.vertical":
        return this.editor.transformSelection("flipV");
      case "transform":
        return this.editor.toggleTransform();
      case "deselect":
        // Esc ends 変形 first, then lets go of the selection.
        if (this.editor.isTransforming) this.editor.toggleTransform(false);
        else this.editor.select(null);
        return true;
      case "page.next":
      case "page.previous":
        // Right-bound book: the next spread is to the left.
        this.flip(action === "page.next" ? 1 : -1);
        return true;
      case "option.make": {
        const [first] = this.editor.currentPages();
        if (!first) return false;
        this.makeOption(first - 1, first - 1);
        return true;
      }
      default:
        return false;
    }
  }

  /** ] / [: the pen or eraser in hand a size up or down. */
  private resizeBrush(factor: number): boolean {
    const tool = this.editor.tool;
    if (tool !== "pen" && tool !== "eraser") return false;
    const round2 = (value: number) => Math.round(value * 100) / 100;
    if (tool === "pen") this.editor.penWidthMm = Math.min(20, Math.max(0.05, round2(this.editor.penWidthMm * factor)));
    else this.editor.eraserSizeMm = Math.min(50, Math.max(0.2, round2(this.editor.eraserSizeMm * factor)));
    this.renderBrushBar();
    this.editor.draw();
    this.setStatus(`${tool === "pen" ? "ペン" : "消しゴム"}の太さ: ${tool === "pen" ? this.editor.penWidthMm : this.editor.eraserSizeMm} mm`);
    return true;
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The 口調 memo of a speaker, if they have one. */
function toneOf(project: Project, speaker: string | undefined): string | undefined {
  return speaker ? project.characters.find((character) => character.id === speaker)?.tone : undefined;
}

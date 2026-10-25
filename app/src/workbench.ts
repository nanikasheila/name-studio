// The name editor around the canvas: the open project, saving, undo, the
// page list, the script, the cast and the inspector for the selection.
import { call } from "./backend";
import { useFonts } from "./fonts";
import { useStyle } from "./style";
import { $, element, plainButton } from "./dom";
import { Inspector } from "./inspector";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { heldThumbnail, pageGlyph } from "./glyph";
import { heldNear, holdPanel, movePanelToPage, placeHeld } from "./hold";
import { Autosaver, autosaveToFile, formatTime } from "./autosave";
import { addBrushes, loadLibrary } from "./brush";
import { BrushDialog } from "./brushdialog";
import { dragSort } from "./dragsort";
import { AltDialog } from "./altdialog";
import { ScriptDialog } from "./scriptdialog";
import { ShortcutDialog } from "./shortcutdialog";
import { SettingsDialog } from "./settingsdialog";
import { PenDialog } from "./pendialog";
import { arrangePage, arrangePanel, clearFaces, fitSpills } from "./arrange";
import { LayerView, moveIntoPanel, type LayerRef } from "./layers";
import { penPreferences } from "./pen";
import { comboOf, Shortcuts, type ActionId } from "./shortcuts";
import { Docks, type PaletteDef, type PaletteId } from "./dock";
import { alternativesOf, makeAlternative, useAlternative } from "./alternatives";
import {
  ERASE_MODE_LABELS,
  SHOW_NOTES_KEY,
  SINGLE_PAGE_KEY,
  CONTINUOUS_KEY,
  ROWS_KEY,
  PANEL_MODE_LABELS,
  PageEditor,
  isTyping,
  type EditorEraseMode,
  type PanelMode,
  type Selection,
  type Tool,
} from "./editor";
import { ExportDialog } from "./exportdialog";
import { History } from "./history";
import { clearAlert, showAlert } from "./alerts";
import { logError } from "./errorlog";
import { projectBody } from "./projectjson";
import { repair } from "./repair";
import { addReference, opacityOf, readImage, removeReference, savedForm } from "./references";
import { type Snapshot, Snapshotter, sameSnapshot } from "./snapshot";
import { VersionDialog, type VersionInfo } from "./versiondialog";
import {
  spreadTwin,
} from "./koma";
import { addAutoTails } from "./autotail";
import { Board, type LaneId } from "./board";
import { pageParts } from "./shapes";
import {
  TONE_LABELS,
  addCharacter,
  assignPanels,
  insertPage,
  movePagesTo,
  pageBlock,
  normalize,
  orderPanels,
  pageIndex,
  removeCharacter,
  removeSticky,
  STICKY_COLORS,
  linkLabel,
  removePanel,
  sceneOf,
  sortLines,
  trailingEmptyPages,
  swapPanelContents,
  textAmount,
  type Brush,
  type FillTone,
  type Alternatives,
  type Page,
  type Panel,
  type Point,
  type Project,
  type RoughImage,
  type StoredImage,
  newId,
} from "./project";
import { readFlag, writeCount, writeFlag } from "./settings";

export const PROJECT_EXTENSION = "namestudio";
const ROUGH_MAX_HEIGHT = 1600;

interface WorkbenchState {
  project: Project | null;
  path: string | null;
  dirty: boolean;
  /** Counts changes, so a save knows whether more came while it ran. */
  revision: number;
  /** Snapshot taken by `begin`, pushed to history by `commit`. */
  pending: Snapshot | null;
  roughs: Map<string, ImageBitmap | "loading" | "failed">;
}

/** What a held panel is carried as when dragged from the 保留 list. */
const HELD_TYPE = "application/x-name-studio-held";
const SIDE_FOLDED_KEY = "namestudio.sideFolded";
/** The palettes' icons. */
const PAGES_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="2.5" width="12" height="15" rx="1"/><path d="M4 9h12M10 9v8.5"/></svg>';
const SCRIPT_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h10v15H5z"/><path d="M8 6.5h4M8 9.5h4M8 12.5h2.5"/></svg>';
const CAST_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6.5" r="3"/><path d="M4 17c0-3.3 2.7-5.2 6-5.2s6 1.9 6 5.2"/></svg>';
const NOTES_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 3h13v9l-5 5h-8z"/><path d="M11.5 17v-5h5"/></svg>';
const HELD_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="3.5" width="13" height="13" rx="1" stroke-dasharray="2.2 2"/><path d="M10 7v6M7 10h6"/></svg>';
const LAYERS_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3l7 3.8-7 3.8-7-3.8z"/><path d="M3 10.5l7 3.8 7-3.8M3 14l7 3.8 7-3.8"/></svg>';
const INSPECTOR_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5.5h8M15 5.5h2M3 10h3M10 10h7M3 14.5h7M14 14.5h3"/><circle cx="13" cy="5.5" r="2"/><circle cx="8" cy="10" r="2"/><circle cx="12" cy="14.5" r="2"/></svg>';

/** One line under the tool's name in the options row. */
const TOOL_HINTS: Record<Tool, string> = {
  select: "クリックで選ぶ・ドラッグで動かす・ダブルクリックで書き込む。Shift で足す、囲んでまとめて選ぶ",
  cut: "コマを横切るように引くと割れる（Alt で斜め）。Shift + コマの外のドラッグで新しいコマ",
  text: "クリックした所にセリフを置く。選んで Alt+ホイールで文字の大きさ",
  pen: "",
  eraser: "",
  fill: "囲んだ所を塗る",
  breakout: "コマを突き抜ける所を囲む。中に描いた線はコマ枠の上に",
  sticky: "クリックで付箋を貼る（書き出しには入りません）",
  reference: "写真や背景を薄く敷く。Ctrl+V・ドロップでも貼れる。ドラッグで動かし、角で大きさ（CSP には下描きレイヤーで出ます）",
};

/** コマ割り: the hint for each way of making panels. */
const PANEL_HINTS: Record<PanelMode, string> = {
  cut: TOOL_HINTS.cut,
  rect: "ドラッグで四角いコマを描く。コマの中に描くと、はめ込み（Alt で吸着しない）",
  polygon: "クリックで角を置く。最初の角・ダブルクリック・Enter で閉じてコマに。Backspace で 1 つ戻す、Esc でやめる",
};

const CONTINUOUS_TITLE = "全ページを一枚のキャンバスに並べ、どのページにもそのまま描く（F7）";
const ROWS_TITLE = "見開きを何行に並べるか。1 で全ページを横一列に（Alt+↑ / Alt+↓）";

export class Workbench {
  readonly editor: PageEditor;
  private readonly history = new History<Project, Snapshot>(new Snapshotter<Project>());
  private readonly state: WorkbenchState = { project: null, path: null, dirty: false, revision: 0, pending: null, roughs: new Map() };
  /** Characters whose lines are listed in the 人物 tab. */
  private openCast = new Set<string>();
  /** What the last copy here put on the system clipboard ("failed" when it could not), to tell it from a picture copied later. */
  private copyMark: string | null = null;
  /** The browser's paste event came after Ctrl+V. */
  private pasteHandled = true;
  /** The palettes beside the pages (left or right, several at once). */
  private docks!: Docks;
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
  readonly board: Board;
  private readonly inspector: Inspector;
  private readonly exportDialog: ExportDialog;
  private readonly altDialog: AltDialog;
  private readonly scriptDialog: ScriptDialog;
  readonly shortcuts = new Shortcuts();
  private readonly shortcutDialog = new ShortcutDialog(this.shortcuts);
  private readonly penDialog = new PenDialog(penPreferences);
  private readonly brushDialog: BrushDialog;
  private readonly settingsDialog: SettingsDialog;
  private readonly versionDialog: VersionDialog;
  private readonly autosaver = new Autosaver(
    () => this.autosave(),
    () => this.state.pending !== null,
  );

  constructor(private readonly setStatus: (message: string) => void, private readonly onTitle: (title: string) => void) {
    this.editor = new PageEditor($<HTMLCanvasElement>("editor-canvas"), {
      project: () => this.state.project,
      begin: () => this.begin(),
      commit: () => this.commit(),
      cancel: () => (this.state.pending = null),
      selectionChanged: () => {
        this.board.deselect();
        this.renderInspector();
      },
      rough: (rough) => this.rough(rough),
      status: (message) => this.setStatus(message),
      actions: (selection) => this.inspector.actions(selection),
      run: (action) => this.run(action),
      spreadChanged: () => this.renderAll(),
      referenceChanged: () => this.renderReferenceBar(),
    });
    this.board = new Board($("story"), $("story-handle"), {
      project: () => this.state.project,
      edit: (change) => this.edit(change),
      openPage: (pageNumber) => {
        this.board.deselect();
        this.editor.selection = null;
        this.editor.showPage(pageNumber);
        this.renderAll();
      },
      selectPanel: (pageId, panelId) => this.goTo(pageId, "panel", panelId),
      movePages: (first, last, target) => this.movePages(first, last, target),
      makeOption: (first, last) => this.makeOption(first, last),
      currentPages: () => this.editor.currentPages(),
      inspect: () => this.renderInspector(),
      status: (message) => this.setStatus(message),
    });
    this.inspector = new Inspector({
      editor: this.editor,
      board: this.board,
      project: () => this.state.project,
      edit: (change) => this.edit(change),
      status: (message) => this.setStatus(message),
      deleteSelection: () => this.deleteSelection(),
      removeTail: (pageId, lineId, index) => this.removeTail(pageId, lineId, index),
      liveText: (field, apply) => this.liveText(field, apply),
      liveNumber: (field, apply) => this.liveNumber(field, apply),
      arrange: (pageId, panelId) => this.arrange(pageId, panelId),
      addTails: (pageId) => this.addTails(pageId),
      holdSelected: (page, panel) => this.holdSelected(page, panel),
      moveSelectedTo: (page, panel, to) => this.moveSelectedTo(page, panel, to),
      makeOption: (first, last) => this.makeOption(first, last),
      useOption: (set, optionId) => this.useOption(set, optionId),
      compare: (setId) => this.altDialog.open(setId),
    });
    this.settingsDialog = new SettingsDialog({
      editor: this.editor,
      project: () => this.state.project,
      edit: (change) => this.edit(change),
      status: (message) => this.setStatus(message),
      snapChanged: () => this.showPanelModes(),
      autosaveChanged: () => this.autosaver.notify(),
      openPenSettings: () => this.penDialog.open(),
      openShortcuts: () => this.shortcutDialog.open(),
    });
    // The page takes whatever room the strip and the side panels leave.
    new ResizeObserver(() => this.editor.resize()).observe($("editor-canvas").parentElement!);
    this.scriptDialog = new ScriptDialog({
      project: () => this.state.project,
      firstAlone: () => this.editor.firstAlone,
      edit: (change) => this.edit(change),
      done: (report, firstPage) => {
        this.editor.selection = null;
        this.editor.showPage(firstPage);
        this.renderAll();
        const who = report.characters.length ? `、登場人物 ${report.characters.join("・")} を足しました` : "";
        const scenes = report.replacedScenes ? `、重なっていたシーン ${report.replacedScenes} を台本のシーンに置き換えました` : "";
        const fixed = report.changed + report.added + report.removed + report.kept;
        const inserted = report.insertedPages ? `、ページを ${report.insertedPages} 枚入れました` : "";
        const left = report.leftPages.length ? `、台本にないページ ${report.leftPages.join("・")} はそのまま` : "";
        const update = fixed ? `。セリフを台本に合わせました: 書き換え ${report.changed}・足す ${report.added}・消す ${report.removed}・そのまま ${report.kept}${report.notes ? `、コマのメモの書き換え ${report.notes}` : ""}${inserted}${left}` : "";
        this.setStatus(`台本を ${report.pages} ページに入れました（セリフ ${report.lines}、作ったコマ ${report.panels}${who}${scenes}）${update}。元に戻すは Ctrl+Z`);
      },
      plotDone: (report) => {
        // The plot is about the whole: the strip shows it large.
        if (!this.board.expanded) this.board.toggleWide(true);
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
      edit: (change) => this.edit(change),
      goTo: (pageId, lineId) => this.goTo(pageId, "line", lineId),
      addTails: () => this.addTails(),
      fitSpills: () => {
        let redone = 0;
        this.edit((p) => (redone = fitSpills(p)));
        this.setStatus(redone ? `はみ出したセリフのあるコマ ${redone} 個を並べ直しました（元に戻すは Ctrl+Z）` : "はみ出したセリフはありません");
        return redone;
      },
      clearFaces: () => {
        let moved = 0;
        this.edit((p) => (moved = clearFaces(p)));
        this.setStatus(moved ? `顔にかかっていたセリフ ${moved} 個をずらしました（元に戻すは Ctrl+Z）` : "顔にかかるセリフはありません");
        return moved;
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
    this.showViewMode();
    this.setTool(this.editor.tool);
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
      await call("discard_recovery", { path: this.state.path }).catch(() => undefined);
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
    this.showViewMode();
    this.renderAll();
    this.setStatus(message);
  }

  async load(path: string): Promise<void> {
    const project = await call("load_project", { path });
    this.show(project, path, `${project.pages.length} ページのネームを開きました`);
  }

  async importSheet(sheetPath: string): Promise<void> {
    this.setStatus("ネーム用紙から取り込み中…");
    const result = await call("import_project", { path: sheetPath });
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
    const mended = repair(normalize(project));
    const note = mended.length ? `（${mended.length} か所の問題を直しました）` : "";
    this.show(project, path, `${name} を ${formatTime(timeMs)} の自動保存から復元しました${note}。保存すると確定します`);
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
    // Loose ends the save check would refuse are mended first, as a step that can be undone.
    this.begin();
    const mended = repair(project);
    if (mended.length) this.commit();
    else this.state.pending = null;
    const revision = this.state.revision;
    try {
      await call("save_project", projectBody({ path, previousPath: this.state.path }, savedForm(project)));
      this.state.path = path;
      if (this.state.revision === revision) {
        this.state.dirty = false;
        this.autosaver.reset();
      }
      this.updateTitle();
      clearAlert("save");
      if (mended.length) clearAlert("autosave");
      const note = mended.length ? `（保存の前に ${mended.length} か所直しました: ${mended.slice(0, 2).join("／")}${mended.length > 2 ? " ほか" : ""}。元に戻すは Ctrl+Z）` : "";
      this.setStatus(`保存しました: ${path}${note}`);
      return true;
    } catch (error) {
      this.setStatus(`保存できませんでした: ${error}`);
      showAlert("save", `保存できませんでした。\n${error}`, "error");
      void logError(`save: ${error}`);
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
      const result = await call(
        "autosave_project",
        projectBody({ path, toFile: autosaveToFile() }, savedForm(project)),
      );
      if (result.savedToFile && this.state.path === path && this.state.revision === revision) {
        this.state.dirty = false;
        this.updateTitle();
      }
      if (result.problems?.length) {
        const list = result.problems.slice(0, 3).join("\n");
        showAlert(
          "autosave",
          `自動保存: ${path && autosaveToFile() ? "ファイルに書けない" : ""}問題があるので、控えだけに残しています。保存（Ctrl+S）すると直してから保存します。\n${list}`,
          "warning",
        );
      } else {
        clearAlert("autosave");
      }
    } catch (error) {
      this.setStatus(`自動保存できませんでした: ${error}`);
      showAlert("autosave", `自動保存できませんでした（次の変更でもう一度試します）。\n${error}`, "error");
      void logError(`autosave: ${error}`);
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
    const older = await call("load_version", { path, id: version.id });
    await call("record_version", projectBody({ path, kind: "beforeRestore" }, savedForm(current)));
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
    if (this.state.project) this.state.pending = this.history.snapshot(this.state.project);
  }

  private commit(): void {
    if (this.state.pending === null) return;
    this.history.recordSnapshot(this.state.pending);
    this.state.pending = null;
    this.changed();
  }

  /** Run `change` as one undoable step; a change that fails is undone. */
  edit(change: (project: Project) => void): void {
    const project = this.state.project;
    if (!project) return;
    this.begin();
    try {
      change(project);
    } catch (error) {
      this.failed(error);
      return;
    }
    this.commit();
  }

  /**
   * Something went wrong: the change under way (begun, not yet committed) is
   * undone so the name is never left half changed, the person is told, and a
   * note goes to the log.
   */
  failed(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const undone = this.rollBack();
    showAlert(
      "failure",
      undone ? `問題が起きたので、途中の操作を取り消しました（ほかの作業はそのままです）。\n${message}` : `問題が起きました: ${message}`,
      "error",
      undone ? undefined : 15,
    );
    void logError(error);
  }

  private rollBack(): boolean {
    const pending = this.state.pending;
    if (pending === null) return false;
    this.state.pending = null;
    this.state.project = this.history.revert(pending);
    this.editor.dropDrag();
    const s = this.editor.selection;
    if (s && !this.findSelected(s)) this.editor.selection = null;
    this.renderAll();
    return true;
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
      const bytes = await call("rough_image", {
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
    useFonts(this.state.project?.fonts);
    useStyle(this.state.project?.style);
    this.renderBrushBar();
    this.editor.draw();
    this.board.update(this.state.revision);
    this.renderSide();
    this.renderInspector();
    this.updateTitle();
    $<HTMLButtonElement>("undo").disabled = !this.history.canUndo;
    $<HTMLButtonElement>("redo").disabled = !this.history.canRedo;
    if (this.editor.continuous) this.showRows();
    const pages = this.editor.currentPages().sort((a, b) => a - b);
    $("editor-page-label").textContent = this.state.project
      ? `${pages.join("–") || "-"} / ${this.state.project.pages.length}`
      : "-";
    const leftIsNext = this.leftward() === 1;
    $("editor-next").title = leftIsNext ? "次へ（←）" : "前へ（←）";
    $("editor-prev").title = leftIsNext ? "前へ（→）" : "次へ（→）";
    $("first-alone-label").title = `見開きの組み方: 1 ページ目を${leftIsNext ? "左" : "右"}ページだけで始める`;
    // 保留: the held panels meant for around these pages, a click away.
    const badge = $("held-badge");
    const near = this.state.project && pages.length ? heldNear(this.state.project, pages[0] - 1, pages[pages.length - 1] - 1).length : 0;
    const all = this.state.project?.held?.length ?? 0;
    badge.hidden = !all;
    badge.textContent = near ? `保留 ${near}（このあたり）` : `保留 ${all}`;
    badge.classList.toggle("near", near > 0);
  }

  private updateTitle(): void {
    const project = this.state.project;
    if (!project) return;
    const name = this.state.path?.split(/[\\/]/).pop() ?? "（未保存）";
    this.onTitle(`${this.state.dirty ? "● " : ""}${name} — ${project.title}`);
  }

  /** What the open palettes hold (those folded or hidden wait until they open). */
  private renderSide(): void {
    const project = this.state.project;
    if (!project || !this.docks) return;
    const open = (id: PaletteId) => this.docks.isOpen(id);
    if (open("pages")) this.renderPages(project);
    if (open("script")) this.renderScript(project);
    if (open("cast")) this.renderCast(project);
    if (open("notes")) this.renderNotes(project);
    if (open("held")) this.renderHeld(project);
    if (open("layers")) this.renderLayers();
  }

  // --- レイヤー（コマ枠フォルダ） ----------------------------------------------------------

  private renderLayers(): void {
    const project = this.state.project;
    if (!project || !this.docks.isOpen("layers")) return;
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
      this.edit((project) => swapPanelContents(from, source, page, panel, project.binding));
      this.setStatus(`コマ ${source.order} とコマ ${panel.order} の中身を入れ替えました`);
      return;
    }
    let moved = false;
    this.edit(() => {
      moved = moveIntoPanel(from, ref, page, panel);
      for (const p of new Set([from, page])) {
        assignPanels(p);
        sortLines(p, this.state.project?.binding);
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
        pageGlyph(project, page),
        element("span", { className: "number", textContent: String(index + 1) }),
        element("span", { className: "memo" }, sceneLabel, page.memo.split("\n")[0] || ""),
        ...this.optionTag(project, page),
        element(
          "span",
          { className: "count", title: `コマ ${page.panels.length}・字 ${textAmount(page)}${page.stickies?.length ? `・付箋 ${page.stickies.length}` : ""}（コマの濃さはセリフの量）` },
          `${textAmount(page)}字`,
          ...(page.stickies?.length ? [element("span", { className: "sticky-count", textContent: String(page.stickies.length) })] : []),
          ...(heldNear(project, index, index).length ? [element("span", { className: "held-count", title: "このあたりに入れたい保留のコマ", textContent: `保${heldNear(project, index, index).length}` })] : []),
        ),
      );
      if (part) item.style.setProperty("--part", part.color);
      item.addEventListener("click", () => {
        this.board.deselect();
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
        const about = linkLabel(page, sticky);
        const where = element("span", { className: "count", textContent: `${index + 1}`, title: about ? `${index + 1} ページの${about}` : `${index + 1} ページ` });
        if (about) text.append(element("small", { className: "note-link", textContent: ` → ${about}` }));
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

  /** 保留: panels waiting for a place, with the page each is meant for. */
  private renderHeld(project: Project): void {
    const held = project.held ?? [];
    const shown = new Set(this.editor.currentPages().map((n) => project.pages[n - 1]?.id));
    const target = this.editor.selection?.kind === "panel" ? this.editor.selection : null;
    const items = held.map((h) => {
      const near = element("select", { title: "このあたりのページに入れたい" });
      near.append(element("option", { value: "", textContent: "ページ未定" }));
      project.pages.forEach((page, index) => near.append(element("option", { value: page.id, textContent: `${index + 1} ページあたり` })));
      near.value = project.pages.some((p) => p.id === h.near) ? h.near! : "";
      near.addEventListener("change", () =>
        this.edit(() => {
          if (near.value) h.near = near.value;
          else delete h.near;
        }),
      );
      const words = h.lines.map((l) => l.text.replace(/\s+/g, "")).filter(Boolean).join(" / ");
      const put = plainButton("このページに置く", () => {
        const page = this.editor.focusPage();
        if (page) this.putHeld(h.id, page);
      });
      put.title = "今のページの、元と同じ位置に置く（ページへドラッグしても置けます）";
      const into = plainButton("選んだコマへ", () => {
        const page = project.pages.find((p) => p.id === target?.pageId);
        const panel = page?.panels.find((p) => p.id === target?.id);
        if (page && panel) this.putHeld(h.id, page, undefined, panel);
      });
      into.title = "選んでいるコマに、中身（セリフ・ラフ線）を合わせて入れる";
      into.disabled = !target;
      const drop = plainButton("消す", () => this.edit((p) => (p.held = (p.held ?? []).filter((x) => x.id !== h.id))));
      drop.className = "danger small";
      const item = element(
        "div",
        { className: `held-item${h.near && shown.has(h.near) ? " near" : ""}`, draggable: true, title: "ページへドラッグして置く。コマの上で離すと、そのコマに中身を入れる" },
        heldThumbnail(project, h),
        element(
          "div",
          { className: "held-body" },
          element("div", { className: "held-words", textContent: words || h.panel.note || "（セリフなし）" }),
          ...(h.panel.note && words ? [element("div", { className: "held-note", textContent: h.panel.note })] : []),
          near,
          element("div", { className: "held-actions" }, put, into, drop),
        ),
      );
      item.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData(HELD_TYPE, h.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      return item;
    });
    const head = element("p", {
      className: "hint",
      textContent: held.length
        ? `保留のコマ ${held.length}。ページへドラッグで置く（コマの上で離すと中身をそのコマへ）。`
        : "保留のコマはありません。コマを選んで「保留」を押すと、中身ごとここへ移ります。置き場所が決まったら、ページへドラッグして戻します。",
    });
    $("side-held").replaceChildren(head, ...items);
  }

  /** Put a held panel on `page`: into `panel`, at `point`, or where it was. */
  private putHeld(id: string, page: Page, point?: Point, panel?: Panel): void {
    const held = this.state.project?.held?.find((h) => h.id === id);
    if (!held) return;
    let placed: Panel | null = null;
    this.edit((p) => {
      const at = p.pages.find((x) => x.id === page.id);
      const into = panel && at?.panels.find((x) => x.id === panel.id);
      if (at) placed = placeHeld(p, at, held, point, into);
    });
    if (!placed) return;
    const index = this.state.project!.pages.findIndex((x) => x.id === page.id);
    this.editor.showPage(index + 1);
    this.editor.select({ kind: "panel", pageId: page.id, id: (placed as Panel).id });
    this.setStatus(panel ? `保留のコマの中身を ${index + 1} ページのコマ ${(placed as Panel).order} に入れました` : `保留のコマを ${index + 1} ページに置きました（コマ ${(placed as Panel).order}）`);
    this.renderAll();
  }

  /** Take the selected panel off its page into 保留. */
  private holdSelected(page: Page, panel: Panel): void {
    const index = this.state.project!.pages.indexOf(page);
    this.edit((p) => {
      const at = p.pages.find((x) => x.id === page.id);
      const target = at?.panels.find((x) => x.id === panel.id);
      if (at && target) holdPanel(p, at, target);
    });
    this.editor.select(null);
    this.setStatus(`${index + 1} ページのコマ ${panel.order} を中身ごと保留にしました（左の「保留」から、ページへドラッグで戻せます）`);
    this.renderAll();
  }

  /** Move the selected panel with what is in it to another page. */
  private moveSelectedTo(page: Page, panel: Panel, to: Page): void {
    let moved: Panel | null = null;
    this.edit((p) => {
      const from = p.pages.find((x) => x.id === page.id);
      const target = from?.panels.find((x) => x.id === panel.id);
      const dest = p.pages.find((x) => x.id === to.id);
      if (from && target && dest) moved = movePanelToPage(p, from, target, dest);
    });
    if (!moved) return;
    const index = this.state.project!.pages.findIndex((x) => x.id === to.id);
    this.editor.showPage(index + 1);
    this.editor.select({ kind: "panel", pageId: to.id, id: (moved as Panel).id });
    this.setStatus(`コマを中身ごと ${index + 1} ページへ移しました（コマ ${(moved as Panel).order}）。重なったら動かすか、コマ割りで整えてください`);
    this.renderAll();
  }

  /** Show a page in the editor with one of its things selected. */
  private goTo(pageId: string, kind: "line" | "sticky" | "panel", id: string): void {
    const index = this.state.project?.pages.findIndex((p) => p.id === pageId) ?? -1;
    if (index < 0) return;
    if (this.editor.tool !== "select" && !(kind === "panel" && this.editor.tool === "cut")) this.setTool("select");
    this.editor.showPage(index + 1);
    this.editor.select({ kind, pageId, id });
    this.renderAll();
  }

  // --- inspector --------------------------------------------------------------------------

  renderInspector(): void {
    this.inspector.render();
    this.inspector.dress();
    this.renderLayers();
    // The bar's buttons hold the objects of the project as it is now.
    this.editor.renderBar();
  }


  /** A text field edited live; the whole edit becomes one undo step. */
  private liveText(field: HTMLInputElement | HTMLTextAreaElement, apply: (value: string) => void): void {
    let snapshot: Snapshot | null = null;
    const take = () => (this.state.project ? this.history.snapshot(this.state.project) : null);
    field.addEventListener("focus", () => (snapshot = take()));
    field.addEventListener("input", () => {
      apply(field.value);
      this.markDirty();
      this.editor.draw();
      this.updateTitle();
    });
    field.addEventListener("change", () => {
      const now = take();
      if (snapshot !== null && now !== null && !sameSnapshot(snapshot, now)) this.history.recordSnapshot(snapshot);
      snapshot = now;
      this.renderSide();
      $<HTMLButtonElement>("undo").disabled = !this.history.canUndo;
    });
  }

  /**
   * A number edited live: typing, the arrows and the mouse wheel (over the
   * field, focused or not) show at once on the page; a moment after the last
   * change it becomes one undo step. The field stays where it is, so the
   * wheel can go on turning.
   */
  private liveNumber(field: HTMLInputElement, apply: (value: number) => void): void {
    let snapshot: Snapshot | null = null;
    let timer: number | undefined;
    const take = () => (this.state.project ? this.history.snapshot(this.state.project) : null);
    const record = () => {
      window.clearTimeout(timer);
      timer = undefined;
      const now = take();
      if (snapshot !== null && now !== null && !sameSnapshot(snapshot, now)) this.history.recordSnapshot(snapshot);
      snapshot = null;
      $<HTMLButtonElement>("undo").disabled = !this.history.canUndo;
    };
    const set = (value: number) => {
      if (!Number.isFinite(value) || value <= 0) return;
      snapshot ??= take();
      apply(value);
      this.markDirty();
      this.editor.draw();
      this.updateTitle();
      window.clearTimeout(timer);
      timer = window.setTimeout(record, 700);
    };
    field.addEventListener("input", () => set(Number(field.value)));
    field.addEventListener("change", (event) => event.stopPropagation());
    field.addEventListener("blur", record);
    field.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const step = Number(field.step) || 1;
        const [min, max] = [Number(field.min || -Infinity), Number(field.max || Infinity)];
        const next = Math.min(max, Math.max(min, Math.round((Number(field.value) + (event.deltaY < 0 ? step : -step)) / step) * step));
        if (next === Number(field.value)) return;
        field.value = String(next);
        set(next);
      },
      { passive: false },
    );
  }


  /** しっぽを付ける: on one page, or on every page. Returns how many were added. */
  private addTails(pageId?: string): number {
    let added = 0;
    this.edit((p) => {
      for (const page of p.pages) if (!pageId || page.id === pageId) added += addAutoTails(page, p.binding);
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
    this.editor.selection = null;
    this.editor.showPage(index + 1);
    this.renderAll();
  }

  /** Take one しっぽ off a line; the line stays selected. */
  removeTail(pageId: string, lineId: string, index: number): void {
    let removed = false;
    this.edit((project) => {
      const line = project.pages.find((p) => p.id === pageId)?.lines.find((l) => l.id === lineId);
      if (!line?.tails?.[index]) return;
      line.tails = line.tails.filter((_, i) => i !== index);
      if (!line.tails.length) delete line.tails;
      removed = true;
    });
    if (!removed) return;
    this.editor.select({ kind: "line", pageId, id: lineId });
    this.setStatus(`${index + 1} 本目のしっぽを消しました（元に戻すは Ctrl+Z）`);
  }

  deleteSelection(): void {
    if (this.editor.tool === "reference") {
      this.removeChosenReference();
      return;
    }
    const s = this.editor.selection;
    if (!s) return;
    // A chosen しっぽ: that tail alone goes.
    if (s.kind === "line" && s.tail !== undefined) {
      const line = this.state.project?.pages.find((p) => p.id === s.pageId)?.lines.find((l) => l.id === s.id);
      if (line?.tails?.[s.tail]) {
        this.removeTail(s.pageId, line.id, s.tail);
        return;
      }
    }
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
    for (const name of ["select", "cut", "text", "pen", "eraser", "fill", "breakout", "sticky", "reference"] as const) {
      $(`tool-${name}`).classList.toggle("active", name === tool);
    }
    $("fill-tones").hidden = tool !== "fill";
    $("panel-modes").hidden = tool !== "cut";
    $("grid-snap-label").hidden = tool !== "cut";
    $("reference-bar").classList.toggle("off", tool !== "reference");
    if (tool !== "reference" && this.editor.reference) this.editor.chooseReference(null);
    this.renderReferenceBar();
    // The options row names the tool and shows only what it has; nothing else moves.
    const button = $(`tool-${tool}`);
    const name = $("tool-name");
    name.replaceChildren(...[...button.childNodes].map((node) => node.cloneNode(true)));
    name.style.setProperty("--tool", getComputedStyle(button).getPropertyValue("--tool"));
    $("tool-hint").textContent = TOOL_HINTS[tool];
    this.showPanelModes();
    this.renderBrushBar();
  }

  /** コマ割り: how a drag makes panels, and whether they snap to the grid. */
  private showPanelModes(): void {
    const mode = this.editor.panelMode;
    for (const name of Object.keys(PANEL_MODE_LABELS) as PanelMode[]) $(`panel-${name}`).classList.toggle("active", name === mode);
    $<HTMLInputElement>("grid-snap").checked = this.editor.snapping.grid;
    if (this.editor.tool === "cut") $("tool-hint").textContent = PANEL_HINTS[mode];
  }

  private setPanelMode(mode: PanelMode): void {
    this.editor.setPanelMode(mode);
    if (this.editor.tool !== "cut") this.setTool("cut");
    this.showPanelModes();
  }

  private showViewMode(): void {
    const { continuous } = this.editor;
    // 縦スクロール: no spreads; a piece at a time or the strip.
    const scroll = !!this.state.project?.scroll;
    const single = this.editor.single || scroll;
    $("spread-mode").hidden = scroll;
    $("first-alone-label").hidden = scroll;
    $("spread-mode").classList.toggle("active", !single && !continuous);
    $("single-mode").classList.toggle("active", single && !continuous);
    $("continuous-mode").classList.toggle("active", continuous);
    $("single-mode").title = scroll ? "区切りを 1 つずつ大きく見る" : "1 ページずつ大きく見る";
    $("continuous-mode").title = scroll ? "縦に続く帯として見る（F7）" : CONTINUOUS_TITLE;
    const alone = single && !continuous;
    $<HTMLInputElement>("editor-first-alone").disabled = alone;
    $("first-alone-label").setAttribute("aria-disabled", String(alone));
    $("rows-control").hidden = !continuous;
    this.showRows();
  }

  /** 連続: the rows slider, as far as one spread a row. */
  private showRows(): void {
    const range = $<HTMLInputElement>("rows-range");
    range.max = String(Math.max(1, this.editor.spreadList().length));
    const rows = this.editor.rowCount();
    range.value = String(rows);
    const scroll = !!this.state.project?.scroll;
    $("rows-value").textContent = scroll ? `${rows} 列` : `${rows} 行`;
    range.parentElement!.title = scroll ? "縦の帯を何列に分けて並べるか。1 で一本の帯に（Alt+↑ / Alt+↓）" : ROWS_TITLE;
  }

  /** 見開き, 単独 or 連続 (all pages on one canvas): keeps the page in view. */
  setView(mode: "spread" | "single" | "continuous"): void {
    const page = this.editor.focusPage();
    const project = this.state.project;
    this.editor.continuous = mode === "continuous";
    if (mode !== "continuous") this.editor.single = mode === "single";
    writeFlag(CONTINUOUS_KEY, this.editor.continuous);
    writeFlag(SINGLE_PAGE_KEY, this.editor.single);
    this.showViewMode();
    const index = page && project ? project.pages.indexOf(page) : -1;
    this.editor.spreadIndex = 0;
    // 連続: a few spreads on screen around the page, then out or in with the wheel.
    this.editor.resetView(this.editor.continuous ? 0.5 : 1);
    if (index >= 0) this.editor.showPage(index + 1);
    this.renderAll();
    if (this.editor.continuous && project?.scroll) this.setStatus("区切りを縦の帯に並べました。ホイールで上下、Ctrl+ホイールで拡大縮小、列数は下のつまみ（Alt+↑↓）");
    else if (this.editor.continuous) this.setStatus("全ページを一枚に並べました。行数は下のつまみ（Alt+↑↓）、全体は Ctrl+Alt+0、横へは Shift+ホイール");
  }

  /** 連続: the spreads in `rows` rows. */
  private setRows(rows: number): void {
    if (!this.editor.continuous) return;
    this.editor.setRows(rows);
    writeCount(ROWS_KEY, this.editor.rows);
    this.showRows();
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
  // --- 資料画像 ---------------------------------------------------------------------------

  /** The picture chosen with the 資料 tool, and its page. */
  private chosenReference() {
    const chosen = this.editor.reference;
    const page = chosen && this.state.project?.pages.find((p) => p.id === chosen.pageId);
    const reference = page?.references?.find((r) => r.id === chosen!.id);
    return page && reference ? { page, reference } : null;
  }

  private renderReferenceBar(): void {
    const chosen = this.chosenReference();
    const opacity = $<HTMLInputElement>("reference-opacity");
    opacity.disabled = !chosen;
    if (chosen) opacity.value = String(opacityOf(chosen.reference));
    $<HTMLButtonElement>("reference-remove").disabled = !chosen;
  }

  private removeChosenReference(): void {
    const chosen = this.chosenReference();
    if (!chosen) return;
    this.edit(() => removeReference(chosen.page, chosen.reference.id));
    this.editor.chooseReference(null);
    this.setStatus("資料画像を外しました（Ctrl+Z で戻せます）");
  }

  /**
   * Picture files (or a pasted picture) laid on a page: the page under the
   * pointer (or dropped on), else the one worked on. Each is made smaller when
   * large, kept once in the name, and chosen with the 資料 tool to move at once.
   */
  async pasteImages(files: File[], where?: { page: Page; point?: Point }): Promise<boolean> {
    const project = this.state.project;
    const pictures = files.filter((file) => file.type.startsWith("image/"));
    if (!project || !pictures.length) return false;
    const target = where ?? this.editor.pasteTarget();
    if (!target) return false;
    this.setStatus("画像を読み込んでいます…");
    try {
      const images: StoredImage[] = [];
      for (const file of pictures) images.push(await readImage(file, file.name || "貼り付けた画像"));
      if (this.state.project !== project || !project.pages.includes(target.page)) return false;
      let last: string | null = null;
      this.edit(() => {
        images.forEach((image, i) => {
          // Numbered inside the step, so undo takes the number back with the picture.
          image.id = newId(project, "image");
          const at = target.point && ([target.point[0] + i * 8, target.point[1] + i * 8] as Point);
          last = addReference(project, target.page, image, at).id;
        });
      });
      if (this.editor.tool !== "reference") this.setTool("reference");
      if (last) this.editor.chooseReference({ pageId: target.page.id, id: last });
      const number = project.pages.indexOf(target.page) + 1;
      this.setStatus(`${number} ページに資料画像を貼りました。ドラッグで動かし、角で大きさを変えます`);
      return true;
    } catch (error) {
      showAlert("reference", `画像を貼れませんでした: ${error instanceof Error ? error.message : String(error)}`, "error", 8);
      logError(error);
      return false;
    }
  }

  private bindReferences(): void {
    const file = $<HTMLInputElement>("reference-file");
    $("reference-add").addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const files = [...(file.files ?? [])];
      file.value = "";
      const page = this.editor.focusPage();
      void this.pasteImages(files, page ? { page } : undefined);
    });
    this.liveNumber($<HTMLInputElement>("reference-opacity"), (value) => {
      const chosen = this.chosenReference();
      if (chosen) chosen.reference.opacity = Math.min(1, value);
    });
    $("reference-remove").addEventListener("click", () => this.removeChosenReference());
    // Ctrl+V: a picture on the clipboard (copied after the last copy made here) is laid on the page.
    document.addEventListener("paste", (event) => {
      this.pasteHandled = true;
      if (!this.state.project || isTyping(event) || document.querySelector("dialog[open]")) return;
      if (!$("editor-canvas").getClientRects().length) return;
      const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      const ours = this.copyMark === "failed" || (this.copyMark !== null && event.clipboardData?.getData("text/plain") === this.copyMark);
      if (files.length && !ours) {
        event.preventDefault();
        void this.pasteImages(files);
      } else if (this.editor.paste()) event.preventDefault();
    });
    // Picture files dropped from outside on a page.
    const canvas = $("editor-canvas");
    canvas.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    canvas.addEventListener("drop", (event) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.some((f) => f.type.startsWith("image/"))) return;
      event.preventDefault();
      const where = this.editor.pageAtClient(event.clientX, event.clientY);
      void this.pasteImages(files, where ?? undefined);
    });
  }

  /**
   * Copy here, marking the system clipboard so a later Ctrl+V knows whether
   * a picture there came after it (and so is the one meant).
   */
  private copyItems(): boolean {
    if (!this.editor.copy()) return false;
    const mark = `name-studio:${Date.now()}`;
    this.copyMark = "failed";
    if (!navigator.clipboard) return true;
    void navigator.clipboard
      .writeText(mark)
      .then(() => (this.copyMark = mark))
      .catch(() => (this.copyMark = "failed"));
    return true;
  }

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
    for (const mode of Object.keys(PANEL_MODE_LABELS) as PanelMode[]) {
      $(`panel-${mode}`).addEventListener("click", () => this.setPanelMode(mode));
    }
    $<HTMLInputElement>("grid-snap").addEventListener("change", (event) => {
      this.settingsDialog.changeSnap({ grid: (event.target as HTMLInputElement).checked });
    });
    $("settings").addEventListener("click", () => this.settingsDialog.open());
    for (const name of ["select", "cut", "text", "pen", "eraser", "fill", "breakout", "sticky", "reference"] as const) {
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
    // The buttons point the way the pages lie: left is next in a right-bound book.
    $("editor-next").addEventListener("click", () => this.flip(this.leftward()));
    $("editor-prev").addEventListener("click", () => this.flip(-this.leftward()));
    const showNotes = $<HTMLInputElement>("show-notes");
    showNotes.checked = this.editor.showNotes;
    showNotes.addEventListener("change", () => {
      this.editor.showNotes = showNotes.checked;
      writeFlag(SHOW_NOTES_KEY, showNotes.checked);
      this.editor.draw();
    });
    $("spread-mode").addEventListener("click", () => this.setView("spread"));
    $("single-mode").addEventListener("click", () => this.setView("single"));
    $("continuous-mode").addEventListener("click", () => this.setView("continuous"));
    $<HTMLInputElement>("rows-range").addEventListener("input", (event) => this.setRows(Number((event.target as HTMLInputElement).value)));
    $("fit-all").addEventListener("click", () => this.editor.fitAll());
    $<HTMLInputElement>("editor-first-alone").addEventListener("change", (event) => {
      this.editor.firstAlone = (event.target as HTMLInputElement).checked;
      this.editor.spreadIndex = 0;
      this.renderAll();
    });
    // The palettes: left or right, several at once, as CSP's.
    const palette = (id: PaletteId, title: string, tip: string, icon: string, tabId = `tab-${id}`): PaletteDef => ({
      id,
      title,
      tip,
      icon,
      tabId,
      body: $(id === "inspector" ? "inspector" : `side-${id}`),
    });
    this.docks = new Docks(
      { left: $("dock-left"), right: $("dock-right") },
      [
        palette("pages", "ページ", "ページの一覧（ドラッグで並べ替え）", PAGES_ICON),
        palette("script", "台本", "全ページのセリフを台本の形で。台本・プロットの取り込みも", SCRIPT_ICON),
        palette("cast", "人物", "登場人物（名前・色・口調）", CAST_ICON),
        palette("notes", "付箋", "全ページの付箋（未決のこと）", NOTES_ICON),
        palette("held", "保留", "置き場所の決まっていないコマ（保留）", HELD_ICON),
        palette("layers", "レイヤー", "見開きのコマと、その中のセリフ・ラフ線・塗り（CSP のコマ枠フォルダのように）", LAYERS_ICON, "tab-layers-edit"),
        palette("inspector", "詳細", "選んだもの（ページ・コマ・セリフ・付箋など）の設定", INSPECTOR_ICON),
      ],
      () => this.renderSide(),
      undefined,
      // On a narrow screen the strip under the page lists the pages: the left column starts folded.
      readFlag(SIDE_FOLDED_KEY, window.innerWidth < 1500),
    );
    $("held-badge").addEventListener("click", () => this.docks.open("held"));
    this.bindReferences();
    // A held panel dropped on a page: into the panel there, else where it is dropped.
    const canvas = $("editor-canvas");
    canvas.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes(HELD_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    canvas.addEventListener("drop", (event) => {
      const id = event.dataTransfer?.getData(HELD_TYPE);
      if (!id) return;
      event.preventDefault();
      const where = this.editor.pageAtClient(event.clientX, event.clientY);
      if (where) this.putHeld(id, where.page, where.point, where.panel);
    });
  }

  /** The step that goes one spread to the left: on in a right-bound book, back in a left-bound one. */
  private leftward(): number {
    return this.state.project?.binding === "left" ? -1 : 1;
  }

  private flip(step: number): void {
    this.board.deselect();
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
    if (arrow && this.editor.selection && !event.ctrlKey && !event.metaKey && !event.altKey) {
      return this.editor.nudge(...arrow);
    }
    return action ? this.run(action) : false;
  }

  /** Run a shortcut's action; false when it does not apply now. */
  run(action: ActionId): boolean {
    // The strip under the page: F6 makes it large, F1 brings it back; F2–F4 show its lanes.
    if (action === "view.board" || action === "view.edit") {
      this.board.toggleWide(action === "view.board" ? undefined : false);
      return true;
    }
    const lanes: Partial<Record<ActionId, LaneId[]>> = {
      "view.structure": ["scene", "text"],
      "view.emotion": ["emotion"],
      "view.timeline": ["time"],
    };
    const shown = lanes[action];
    if (shown) {
      for (const lane of shown) this.board.toggleLane(lane, true);
      return true;
    }
    if (action === "view.continuous") {
      this.setView(this.editor.continuous ? (this.editor.single ? "single" : "spread") : "continuous");
      return true;
    }
    if (action === "view.fewerRows" || action === "view.moreRows") {
      if (!this.editor.continuous) this.setView("continuous");
      this.setRows(this.editor.rowCount() + (action === "view.moreRows" ? 1 : -1));
      return true;
    }
    if (action === "view.all") {
      if (!this.editor.continuous) this.setView("continuous");
      this.editor.fitAll();
      return true;
    }
    if (action === "view.fit" || action === "view.rotateLeft" || action === "view.rotateRight") {
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
      "tool.reference": "reference",
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
        return this.copyItems();
      case "cut":
        if (!this.copyItems()) return false;
        this.deleteSelection();
        this.setStatus("切り取りました。Ctrl+V で、ポインターのあるページに貼り付けます");
        return true;
      case "paste":
        // The browser's paste event comes next, with the clipboard's picture if there is one;
        // where it does not come, what was copied here is pasted.
        this.pasteHandled = false;
        window.setTimeout(() => {
          if (!this.pasteHandled) this.editor.paste();
        }, 60);
        return false;
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
        // 左へ・右へ: the next spread is to the left in a right-bound book, to the right in a left-bound one.
        this.flip(action === "page.next" ? this.leftward() : -this.leftward());
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


// The name editor around the canvas: opening the name (the session keeps it
// and its undo steps; saving it is namesaver.ts), the palettes beside the pages (the
// lists are in sidelists.ts) and the inspector for the selection. The bars
// above the pages are controlbar.ts and referencebar.ts; the changes the
// palettes and commands ask for are nameedits.ts.
import { call } from "./backend";
import { useFonts } from "./fonts";
import { useStyle } from "./style";
import { $, isTyping } from "./dom";
import { Inspector } from "./inspector";
import { ask } from "@tauri-apps/plugin-dialog";
import { heldNear } from "./hold";
import { formatTime } from "./autosave";
import { penPreferences, rememberName } from "./prefs";
import { NameSaver } from "./namesaver";
import { BrushDialog } from "./brushdialog";
import { BrushEditor } from "./brusheditor";
import { AltDialog } from "./altdialog";
import { ScriptDialog } from "./scriptdialog";
import { ShortcutDialog } from "./shortcutdialog";
import { SettingsDialog } from "./settingsdialog";
import { PenDialog } from "./pendialog";
import { PerfDialog } from "./perfdialog";
import { perfMeter } from "./perfmeter";
import { LayerView, type LayerRef } from "./layers";
import { RoughPanel } from "./roughpanel";
import { SeriesPanel } from "./seriespanel";
import { isMark, ROUGH_BASE } from "./roughlayers";
import { buildCommands } from "./actions";
import { replaceSubtoolCommands, type Command } from "./commands";
import { CommandPalette } from "./palette";
import { comboOf, Shortcuts, type ActionId } from "./shortcuts";
import type { HelpKind } from "./helptopics";
import type { Docks, PaletteId } from "./dock";
import { PageEditor, type EditorEraseMode, type Tool } from "./editor";
import { ExportDialog } from "./exportdialog";
import { clearAlert, showAlert } from "./alerts";
import { logError } from "./errorlog";
import { projectBody, writeAhead } from "./projectjson";
import { repair } from "./repair";
import { savedForm } from "./references";
import { Session } from "./session";
import { HELD_TYPE, SideLists, draggedHeld } from "./sidelists";
import { DropHint, dropPlan } from "./drophint";
import { pointOff } from "./aside";
import { VersionDialog, type VersionInfo } from "./versiondialog";
import { Board } from "./board";
import type { Point, Project } from "./model";
import { normalize, trailingEmptyPages, unknownFieldsNote } from "./project";
import { stillThere } from "./removal";
import { localStore } from "./settings";
import { LiveFields } from "./livefields";
import { saveState } from "./savestate";
import { NameEdits, pickedStrokes } from "./nameedits";
import { editorDocks } from "./palettes";
import { ReferenceBar } from "./referencebar";
import { RoughCache } from "./roughcache";
import { Reader } from "./reader";
import { SpringTool } from "./springtool";
import { ControlBar } from "./controlbar";

/** After a line drawn with the pen, what lies around the pages is drawn again once the pen has rested this long (ms). */
const PEN_REST_MS = 500;

export class Workbench {
  readonly editor: PageEditor;
  /** The open name, unsaved or not, and its undo steps. */
  private readonly session = new Session(() => this.saver.notify());
  /** Rough images read from the source sheet. */
  private readonly roughs = new RoughCache({
    sheet: () => this.session.project?.source?.path,
    status: (message) => this.setStatus(message),
    arrived: () => this.editor.draw(),
  });
  /** Text and number fields that show on the page as they change. */
  private readonly live = new LiveFields({
    session: this.session,
    changed: () => {
      this.editor.draw();
      this.updateTitle();
    },
    recorded: () => ($<HTMLButtonElement>("undo").disabled = !this.session.canUndo),
    settled: () => this.renderSide(),
  });
  /** The lists beside the pages: ページ, 台本, 人物, 付箋, 保留. */
  private readonly lists = new SideLists({
    edit: (change) => this.edit(change),
    currentPages: () => this.editor.currentPages(),
    selection: () => this.editor.selection,
    focusPage: () => this.editor.focusPage(),
    openPage: (number) => {
      this.board.deselect();
      this.editor.selection = null;
      this.editor.showPage(number);
      this.renderAll();
    },
    showSelected: (number, selection) => {
      this.editor.showPage(number);
      this.editor.select(selection);
      this.renderAll();
    },
    goTo: (pageId, kind, id) => this.goTo(pageId, kind, id),
    movePages: (first, last, target) => this.edits.movePages(first, last, target),
    putHeld: (id, page, point, panel) => this.edits.putHeld(id, page, point, panel),
    layHeld: (id, page) => (page ? this.edits.layHeld(id, page) : this.edits.unlayHeld(id)),
    openScript: () => this.scriptDialog.open(),
  });
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
    drop: (ref, to) => this.edits.dropLayer(ref, to),
    lineLabel: (page, id) => {
      const text = page.lines.find((l) => l.id === id)?.text.replace(/\s+/g, " ").trim() ?? "";
      return text.length > 14 ? `${text.slice(0, 14)}…` : text || "（空）";
    },
    isMark: (page, id) => isMark(this.session.project ?? {}, page.strokes.find((stroke) => stroke.id === id) ?? {}),
  });
  private readonly roughPanel = new RoughPanel({
    project: () => this.session.project,
    editor: () => this.editor,
    status: (message) => this.setStatus(message),
    picked: (tool) => (tool ? this.setTool(tool) : undefined, this.renderLayers()),
    change: (change) => this.edits.changeRough(change),
    selectedStrokes: () => pickedStrokes(this.editor.selection).length,
  });
  private readonly seriesPanel = new SeriesPanel({
    project: () => this.session.project,
    path: () => this.session.path,
    edit: (change) => this.edit(change),
    status: (message) => this.setStatus(message),
    save: () => this.save(),
    open: async (path) => {
      if (!(await this.confirmDiscard())) return;
      try {
        await this.load(path);
      } catch (error) {
        this.setStatus(`開けませんでした: ${error}`);
      }
    },
    refresh: () => {
      if (this.docks?.isOpen("series")) this.seriesPanel.render($("side-series"));
    },
    adopt: async (project, path, message) => {
      if (!(await this.confirmDiscard())) return;
      this.show(project, path, message);
      this.markDirty();
      await this.save();
    },
  });
  readonly board: Board;
  private readonly inspector: Inspector;
  /** The bars above the pages: the tool and its options, how the pages are shown. */
  private readonly bars: ControlBar;
  /** 資料画像: the 資料 tool's bar, pasting and dropping pictures. */
  private readonly references: ReferenceBar;
  /** The changes the palettes, the inspector and the commands ask for. */
  private readonly edits: NameEdits;
  private readonly exportDialog: ExportDialog;
  private readonly altDialog: AltDialog;
  private readonly scriptDialog: ScriptDialog;
  /** Everything that can be done by name: the keys, the key settings and the command palette run these. */
  private readonly commands: Command[];
  readonly shortcuts: Shortcuts;
  private readonly shortcutDialog: ShortcutDialog;
  private readonly palette: CommandPalette;
  private readonly penDialog = new PenDialog(penPreferences);
  private readonly perfDialog = new PerfDialog(
    () => perfMeter.report(),
    () => perfMeter.reset(),
    (message) => this.setStatus(message),
  );
  private readonly brushDialog: BrushDialog;
  private readonly brushEditor: BrushEditor;
  private readonly settingsDialog: SettingsDialog;
  private readonly versionDialog: VersionDialog;
  /** 一時切り替え: a tool's key held lends the tool. */
  private readonly spring = new SpringTool<Tool>();
  /** The timer of `afterLine`. */
  private resting = 0;
  /** 読む表示: the name read through as the book. */
  private readonly reader: Reader;
  /** Saving and autosaving the open name. */
  private readonly saver = new NameSaver({
    session: this.session,
    series: this.seriesPanel,
    setStatus: (message) => this.setStatus(message),
    begin: () => this.begin(),
    commit: () => this.commit(),
    changed: () => this.updateTitle(),
  });

  constructor(private readonly setStatus: (message: string) => void, private readonly onTitle: (title: string) => void, help: (kind: HelpKind) => void = () => {}) {
    this.editor = new PageEditor($<HTMLCanvasElement>("editor-canvas"), {
      project: () => this.session.project,
      begin: () => this.begin(),
      commit: (line) => this.commit(line),
      cancel: () => this.session.cancel(),
      selectionChanged: () => {
        this.board.deselect();
        this.renderInspector();
      },
      useTool: (tool) => this.setTool(tool),
      rough: (rough) => this.roughs.get(rough),
      status: (message) => this.setStatus(message),
      actions: (selection) => this.inspector.actions(selection),
      run: (action) => this.run(action),
      spreadChanged: () => this.renderAll(),
      referenceChanged: () => this.references.render(),
    });
    const around = {
      editor: this.editor,
      project: () => this.session.project,
      edit: (change: (project: Project) => void) => this.edit(change),
      status: (message: string) => this.setStatus(message),
    };
    this.bars = new ControlBar({
      ...around,
      renderAll: () => this.renderAll(),
      toolChanged: (tool) => this.references.toolChanged(tool),
      snapGrid: (on) => this.settingsDialog.changeSnap({ grid: on }),
      rough: (change) => this.edits.changeRough(change),
      subtoolsShown: () => this.docks?.isOpen("subtools") ?? false,
      keysOf: (command) => this.shortcuts.keys(command),
      bindKey: (command, combo) => {
        const taken = this.shortcuts.bind(command, combo);
        return taken && (this.commands.find((c) => c.id === taken)?.label ?? taken);
      },
      unbindKey: (command, combo) => this.shortcuts.unbind(command, combo),
      openBrushEditor: (kind) => this.brushEditor.openFor(kind),
      importBrushes: () => void this.brushDialog.open(),
    });
    this.references = new ReferenceBar({
      ...around,
      setTool: (tool) => this.setTool(tool),
      liveNumber: (field, apply) => this.live.number(field, apply),
    });
    this.edits = new NameEdits({
      ...around,
      renderAll: () => this.renderAll(),
      layersChanged: () => this.renderLayers(),
    });
    this.board = new Board($("story"), $("story-handle"), $("page-nav"), {
      project: () => this.session.project,
      edit: (change) => this.edit(change),
      openPage: (pageNumber) => {
        this.board.deselect();
        this.editor.selection = null;
        this.editor.showPage(pageNumber);
        this.renderAll();
      },
      selectPanel: (pageId, panelId) => this.goTo(pageId, "panel", panelId),
      movePages: (first, last, target) => this.edits.movePages(first, last, target),
      makeOption: (first, last) => this.edits.makeOption(first, last),
      currentPages: () => this.editor.currentPages(),
      // What is picked in the strip is the one selection: the page's lets go.
      inspect: () => (this.board.selected && this.editor.select(null, true), this.renderInspector()),
      status: (message) => this.setStatus(message),
    });
    this.inspector = new Inspector({
      editor: this.editor,
      board: this.board,
      project: () => this.session.project,
      edit: (change) => this.edit(change),
      status: (message) => this.setStatus(message),
      deleteSelection: () => this.deleteSelection(),
      removeTail: (pageId, lineId, index) => this.edits.removeTail(pageId, lineId, index),
      liveText: (field, apply) => this.live.text(field, apply),
      liveNumber: (field, apply) => this.live.number(field, apply),
      arrange: (pageId, panelId) => this.edits.arrange(pageId, panelId),
      addTails: (pageId) => this.edits.addTails(pageId),
      holdSelected: (page, panel) => this.edits.holdSelected(page, panel),
      moveSelectedTo: (page, panel, to) => this.edits.moveSelectedTo(page, panel, to),
      makeOption: (first, last) => this.edits.makeOption(first, last),
      useOption: (set, optionId) => this.edits.useOption(set, optionId),
      compare: (setId) => this.altDialog.open(setId),
    });
    this.settingsDialog = new SettingsDialog({
      editor: this.editor,
      project: () => this.session.project,
      edit: (change) => this.edit(change),
      status: (message) => this.setStatus(message),
      snapChanged: () => this.bars.showPanelModes(),
      stripOrderChanged: () => this.board.redraw(),
      // What is unsaved goes where autosave says now.
      autosaveChanged: () => this.saver.settingsChanged(),
      autosaveTimingChanged: () => this.saver.timingChanged(),
      busy: () => this.session.project !== null,
      openPenSettings: () => this.penDialog.open(),
      openShortcuts: () => this.shortcutDialog.open(),
      prepareRestart: () => this.confirmDiscard(),
    });
    this.commands = buildCommands({
      editor: this.editor,
      board: this.board,
      hasProject: () => this.session.project !== null,
      status: (message) => this.setStatus(message),
      save: (saveAs) => void this.save(saveAs),
      undo: () => this.undo(),
      redo: () => this.redo(),
      setView: (mode) => this.bars.setView(mode),
      setRows: (rows) => this.bars.setRows(rows),
      setTool: (tool) => this.setTool(tool),
      setEraseMode: (mode) => this.setEraseMode(mode),
      setFillWay: (way) => (way === "next" ? this.bars.fills.nextWay() : this.bars.fills.setWay(way)),
      setPanelMode: (mode) => this.bars.setPanelMode(mode),
      holdSelected: () => this.edits.holdSelection(),
      tidyPanels: () => this.edits.tidyPanels(),
      readBack: () => void this.exportDialog.readBackAgain(),
      nextStory: () => {
        if (!this.seriesPanel.inSeries) return false;
        this.docks.open("series");
        void this.seriesPanel.createNext();
        return true;
      },
      resizeBrush: (factor) => this.bars.resizeBrush(factor),
      deleteSelection: () => this.deleteSelection(),
      copyItems: () => this.references.copyItems(),
      paste: () => this.references.paste(),
      // 左へ・右へ: the next spread is to the left in a right-bound book, to the right in a left-bound one.
      flipLeft: (step) => this.flip(step * this.leftward()),
      makeOption: (first, last) => this.edits.makeOption(first, last),
      toggleFocus: () => this.toggleFocus(),
      arrange: (pageId) => this.edits.arrange(pageId),
      addTails: (pageId) => this.edits.addTails(pageId),
      addPageAfter: (page) => this.edits.addPageAfter(page),
      openPalette: (id) => this.docks.open(id),
      openCommandPalette: () => this.palette.open(),
      openPerfReport: () => this.perfDialog.open(),
      exportAgain: () => void this.exportDialog.exportAgain(),
      click: (id) => {
        const target = pressable(id);
        target?.click();
        return target !== null;
      },
      canClick: (id) => pressable(id) !== null,
      help,
    });
    this.shortcuts = new Shortcuts(localStore(), this.commands);
    this.shortcuts.onChange(() => this.bars.subtools.render(true));
    this.shortcutDialog = new ShortcutDialog(this.shortcuts);
    this.palette = new CommandPalette({
      commands: () => this.commands,
      keysOf: (id) => this.shortcuts.keys(id),
      run: (command) => {
        if (!command.run()) return;
        this.editor.draw();
      },
      status: (message) => this.setStatus(message),
    });
    $("pen-perf").addEventListener("click", () => this.perfDialog.open());
    new ResizeObserver(() => this.editor.resize()).observe($("editor-canvas").parentElement!); // the page takes the room the strip and side panels leave
    this.scriptDialog = new ScriptDialog({
      project: () => this.session.project,
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
      project: () => this.session.project,
      edit: (change) => this.edit(change),
      shown: (set) => this.edits.showSet(set),
    });
    this.exportDialog = new ExportDialog({
      project: () => this.session.project,
      projectPath: () => this.session.path,
      projectId: () => this.session.id,
      rough: (rough) => this.roughs.load(rough),
      roughProblem: (rough) => this.roughs.problem(rough),
      relinkSheet: (path) =>
        this.edit((project) => {
          if (project.source) project.source.path = path;
        }),
      firstAlone: () => this.editor.firstAlone,
      status: (message) => this.setStatus(message),
      edit: (change) => this.edit(change),
      goTo: (pageId, lineId) => this.goTo(pageId, "line", lineId),
      showPage: (pageNumber) => {
        this.editor.showPage(pageNumber);
        this.renderAll();
      },
      addTails: () => this.edits.addTails(),
      fitSpills: () => this.edits.fitSpills(),
      clearFaces: () => this.edits.clearFaces(),
    });
    this.brushDialog = new BrushDialog({
      project: () => this.session.project,
      edit: (change) => this.edit(change),
      imported: (brushes) => {
        const kind = this.editor.tool === "eraser" ? "eraser" : "pen";
        const brush = brushes.find((b) => b.kind === kind) ?? brushes[0];
        if (brush) this.bars.useBrush(brush);
        this.brushEditor.refresh();
      },
    });
    this.brushEditor = new BrushEditor({
      project: () => this.session.project,
      edit: (change) => this.edit(change),
      inHand: (kind) => this.editor.brush(kind) ?? null,
      changed: (brush, kind) => this.bars.useBrush(brush, kind),
      importFromCsp: () => void this.brushDialog.open(),
    });
    this.versionDialog = new VersionDialog({
      path: () => this.session.path,
      restore: (version) => this.restoreVersion(version),
      autosaveChanged: () => this.saver.settingsChanged(),
    });
    this.reader = new Reader({
      project: () => this.session.project,
      firstAlone: () => this.editor.firstAlone,
      page: () => {
        const project = this.session.project;
        const focused = this.editor.focusPage();
        const index = focused && project ? project.pages.indexOf(focused) : -1;
        return index >= 0 ? index + 1 : (this.editor.currentPages()[0] ?? 1);
      },
      rough: (rough) => this.roughs.load(rough),
      closed: (pageNumber) => this.editor.showPage(pageNumber),
    });
    this.bindControls();
    this.bars.showViewMode();
    this.setTool(this.editor.tool);
  }

  get project(): Project | null {
    return this.session.project;
  }

  /** What the open name holds and what is kept to draw it, for 動作の記録 (perfmeter.ts). */
  resources(): Record<string, number> {
    const project = this.session.project;
    const { undo, redo } = this.session.historyDepth;
    const kept = this.editor.kept;
    const mb = (pixels: number) => Math.round((pixels * 4) / 104857.6) / 10;
    return {
      pages: project?.pages.length ?? 0,
      strokes: project?.pages.reduce((sum, page) => sum + page.strokes.length, 0) ?? 0,
      undo,
      redo,
      linePictures: kept.linePictures,
      linePicturesMb: mb(kept.linePixels),
      screenCopyMb: mb(kept.screenPixels),
    };
  }

  get dirty(): boolean {
    return this.session.dirty;
  }

  /** As CSP's Tab: the side palettes and the story band go, the pages take the room. */
  private toggleFocus(): void {
    const focus = document.body.classList.toggle("focus-mode");
    $("focus-mode").setAttribute("aria-pressed", String(focus));
    this.editor.resize();
    // Back: the band and the palettes catch up with what changed while they were hidden.
    if (!focus) this.renderAll();
    this.setStatus(focus ? "左右の欄と下の帯を隠しました（Tab で戻す）" : "");
  }

  // --- opening and saving --------------------------------------------------------

  /**
   * Before the project is closed: let autosave write it to its file, then
   * ask whether to save what is still unsaved, throw it away (and its
   * autosave copy) or go back to it.
   */
  /** Before the open name goes: saved, or let go when the person says so. False: keep it open. */
  confirmDiscard(): Promise<boolean> {
    return this.saver.confirmDiscard();
  }

  show(project: Project, path: string | null, message: string): void {
    this.seriesPanel.follow(this.session.open(project, path), path);
    clearAlert("series");
    clearAlert("unknown-fields");
    this.saver.opened();
    this.roughs.clear();
    this.editor.selection = null;
    this.editor.roughLayer = ROUGH_BASE;
    this.editor.spreadIndex = 0;
    this.editor.resetView();
    this.editor.resize();
    this.bars.showViewMode();
    this.renderAll();
    this.setStatus(message);
    if (this.session.project) writeAhead(this.session.project);
  }

  async load(path: string): Promise<void> {
    const project = await call("load_project", { path });
    const series = await this.seriesPanel.attach(project, path);
    this.show(project, path, `${project.pages.length} ページのネームを開きました${series}`);
    this.saver.loaded(path);
    rememberName(path, project);
    const unknown = unknownFieldsNote((await call("unknown_project_fields", { path }).catch(() => null)) ?? []);
    if (unknown && this.session.path === path) showAlert("unknown-fields", unknown, "warning");
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
    this.saver.recovered(path, timeMs);
    this.markDirty();
    this.updateTitle();
  }

  save(saveAs = false): Promise<boolean> {
    return this.saver.save(saveAs);
  }

  /** Show the versions of this project. */
  openVersions(): void {
    if (this.session.project) void this.versionDialog.open();
  }

  /** Bring an earlier version back as one undoable change. */
  private async restoreVersion(version: VersionInfo): Promise<void> {
    const current = this.session.project;
    if (!current) return;
    const path = this.session.path;
    const older = await call("load_version", { path, id: version.id });
    await call("record_version", projectBody({ path, kind: "beforeRestore" }, savedForm(current)));
    this.session.replace(older);
    this.editor.selection = null;
    this.roughs.clear();
    this.renderAll();
    this.setStatus(`${formatTime(version.timeMs)} の版に戻しました。「元に戻す」で戻る前に戻せます`);
  }

  // --- changes and undo -------------------------------------------------------------

  /** Note a change: the title shows it and autosave picks it up. */
  private markDirty(): void {
    this.session.markDirty();
  }

  private begin(): void {
    this.session.begin();
  }

  private commit(line = false): void {
    if (!this.session.commit()) return;
    if (line) this.afterLine();
    else this.renderAll();
  }

  /**
   * A line drawn with the pen: the pages show it already. The strip, the
   * palettes and the inspector (all of them drawn anew, the pages' pictures
   * with them) follow once the pen rests, so lines drawn one after another
   * do not stop for them.
   */
  private afterLine(): void {
    this.updateTitle();
    $<HTMLButtonElement>("undo").disabled = !this.session.canUndo;
    $<HTMLButtonElement>("redo").disabled = !this.session.canRedo;
    clearTimeout(this.resting);
    this.resting = window.setTimeout(() => {
      this.resting = 0;
      if (this.editor.dragging) this.afterLine();
      else this.renderAll();
    }, PEN_REST_MS);
  }

  /** Run `change` as one undoable step; a change that fails is undone. */
  edit(change: (project: Project) => void): void {
    const project = this.session.project;
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
    if (!this.session.rollBack()) return false;
    this.editor.dropDrag();
    this.dropLostSelection();
    this.renderAll();
    return true;
  }

  undo(): void {
    if (this.session.undo()) this.restored();
  }

  redo(): void {
    if (this.session.redo()) this.restored();
  }

  private restored(): void {
    this.dropLostSelection();
    this.renderAll();
    this.brushEditor.refresh();
  }

  /** The selection goes when what it picked is no longer there. */
  private dropLostSelection(): void {
    const s = this.editor.selection;
    if (s && !stillThere(this.session.project, s)) this.editor.selection = null;
  }

  // --- rendering ------------------------------------------------------------------------

  renderAll(): void {
    clearTimeout(this.resting);
    this.resting = 0;
    useFonts(this.session.project?.fonts);
    useStyle(this.session.project?.style);
    // The pens of this name (and of others) as commands, for their keys.
    replaceSubtoolCommands(this.commands, this.bars.subtoolCommands(() => this.session.project !== null));
    this.bars.renderBrushBar();
    this.editor.draw();
    this.board.update(this.session.revision);
    this.renderSide();
    this.renderInspector();
    this.updateTitle();
    $<HTMLButtonElement>("undo").disabled = !this.session.canUndo;
    $<HTMLButtonElement>("redo").disabled = !this.session.canRedo;
    if (this.editor.continuous) this.bars.showRows();
    const pages = this.editor.currentPages().sort((a, b) => a - b);
    $("editor-page-label").textContent = this.session.project
      ? `${pages.join("–") || "-"} / ${this.session.project.pages.length}`
      : "-";
    const leftIsNext = this.leftward() === 1;
    $("editor-next").title = leftIsNext ? "次へ（←）" : "前へ（←）";
    $("editor-prev").title = leftIsNext ? "前へ（→）" : "次へ（→）";
    $("first-alone-label").title = `見開きの組み方: 1 ページ目を${leftIsNext ? "左" : "右"}ページだけで始める`;
    // 保留: the held panels meant for around these pages, a click away.
    const badge = $("held-badge");
    const near = this.session.project && pages.length ? heldNear(this.session.project, pages[0] - 1, pages[pages.length - 1] - 1).length : 0;
    const all = this.session.project?.held?.length ?? 0;
    badge.hidden = !all;
    badge.textContent = near ? `保留 ${near}（このあたり）` : `保留 ${all}`;
    badge.classList.toggle("near", near > 0);
  }

  private updateTitle(): void {
    const project = this.session.project;
    if (!project) return;
    const name = this.session.path?.split(/[\\/]/).pop() ?? "（未保存）";
    this.onTitle(`${this.session.dirty ? "● " : ""}${name} — ${project.title}`);
    const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
    const state = saveState({ ...this.saver.facts(), hasPath: !!this.session.path, dirty: this.session.dirty }, clock);
    const node = $("save-state");
    node.textContent = state.text;
    node.title = state.detail;
    node.dataset.tone = state.tone;
  }

  /** What the open palettes hold (those folded or hidden wait until they open). */
  private renderSide(): void {
    const project = this.session.project;
    if (!project || !this.docks) return;
    const open = (id: PaletteId) => this.docks.isOpen(id);
    if (open("subtools")) this.bars.subtools.render();
    if (open("pages")) this.lists.pages(project);
    if (open("script")) this.lists.script(project);
    if (open("cast")) this.lists.cast(project);
    if (open("notes")) this.lists.notes(project);
    if (open("held")) this.lists.held(project);
    if (open("layers")) this.renderLayers();
    if (open("series")) this.seriesPanel.render($("side-series"));
  }

  // --- レイヤー（コマ枠フォルダ） ----------------------------------------------------------

  private renderLayers(): void {
    const project = this.session.project;
    if (!project || !this.docks.isOpen("layers")) return;
    const pages = this.editor
      .currentPages()
      .sort((a, b) => a - b)
      .map((number) => ({ page: project.pages[number - 1], number }))
      .filter(({ page }) => page);
    this.roughPanel.render($("rough-layers"));
    this.layerView.render($("layer-rows"), pages);
  }

  private layerSelected(ref: LayerRef): boolean {
    const s = this.editor.selection;
    if (!s || s.pageId !== ref.pageId) return false;
    if (ref.kind === "strokes") {
      const picked = pickedStrokes(s);
      return picked.length === ref.ids.length && ref.ids.every((id) => picked.includes(id));
    }
    return s.kind === ref.kind && s.id === ref.id;
  }

  private selectLayer(ref: LayerRef): void {
    if (ref.kind === "strokes") {
      const items = ref.ids.map((id) => ({ kind: "stroke" as const, id }));
      this.editor.select(items.length === 1 ? { kind: "stroke", pageId: ref.pageId, id: ref.ids[0] } : { kind: "group", pageId: ref.pageId, id: "group", items });
    } else {
      this.editor.select({ kind: ref.kind, pageId: ref.pageId, id: ref.id });
    }
    this.renderLayers();
  }

  /** Show a page in the editor with one of its things selected (a tool that does not keep it gives way to the select tool). */
  private goTo(pageId: string, kind: "line" | "sticky" | "panel", id: string): void {
    const index = this.session.project?.pages.findIndex((p) => p.id === pageId) ?? -1;
    if (index < 0) return;
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

  /** What is selected goes; with the 資料 tool, the chosen picture. */
  deleteSelection(): void {
    if (this.editor.tool === "reference") this.references.removeChosen();
    else this.edits.deleteSelection();
  }

  // --- controls -------------------------------------------------------------------------------

  setTool(tool: Tool): void {
    this.bars.setTool(tool);
  }

  /** Switch how the eraser erases, keeping the tool in hand. */
  setEraseMode(mode: EditorEraseMode): void {
    this.bars.setEraseMode(mode);
  }

  private bindControls(): void {
    this.bars.bind();
    $("settings").addEventListener("click", () => this.settingsDialog.open());
    $("undo").addEventListener("click", () => this.undo());
    $("redo").addEventListener("click", () => this.redo());
    $("brush-import").addEventListener("click", () => void this.brushDialog.open());
    $("brush-edit").addEventListener("click", () => this.brushEditor.openFor(this.editor.tool === "eraser" ? "eraser" : "pen"));
    $("name-export").addEventListener("click", () => this.exportDialog.open());
    $("focus-mode").addEventListener("click", () => this.toggleFocus());
    $("read-mode").addEventListener("click", () => void this.reader.open());
    // 一時切り替え: let go of a held tool key (or end the stroke made with it) for the tool from before.
    const giveBack = (tool: Tool | null) => tool && this.session.project && this.setTool(tool);
    $("editor-canvas").addEventListener("pointerdown", () => this.spring.pointerDown());
    window.addEventListener("pointerup", () => giveBack(this.spring.pointerUp()), true);
    window.addEventListener("keyup", (event) => giveBack(this.spring.release(event.code, performance.now())));
    window.addEventListener("blur", () => this.spring.reset());
    $("versions").addEventListener("click", () => this.openVersions());
    $("shortcuts").addEventListener("click", () => this.shortcutDialog.open());
    $("pen-settings").addEventListener("click", () => this.penDialog.open());
    // The buttons point the way the pages lie: left is next in a right-bound book.
    $("editor-next").addEventListener("click", () => this.flip(this.leftward()));
    $("editor-prev").addEventListener("click", () => this.flip(-this.leftward()));
    this.docks = editorDocks(() => this.renderSide());
    $("held-badge").addEventListener("click", () => this.docks.open("held"));
    $("panel-tidy").addEventListener("click", () => this.edits.tidyPanels());
    this.references.bind();
    // A held panel dropped on a page: into the panel there, else where it is dropped.
    const canvas = $("editor-canvas");
    // While it is dragged: where it would go.
    const hint = new DropHint(canvas.parentElement!);
    canvas.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes(HELD_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const held = this.session.project?.held?.find((h) => h.id === draggedHeld());
      const where = held && this.editor.pageAtClient(event.clientX, event.clientY);
      const plan = where && dropPlan(this.session.project!, held, where);
      const points = plan?.shape.map((point) => this.editor.clientOf(where!.page.id, point));
      if (plan && points?.every((p) => p !== null)) hint.show(plan.kind, points as Point[], plan.text);
      else hint.hide();
    });
    canvas.addEventListener("dragleave", () => hint.hide());
    canvas.addEventListener("drop", (event) => {
      hint.hide();
      const id = event.dataTransfer?.getData(HELD_TYPE);
      if (!id) return;
      event.preventDefault();
      const where = this.editor.pageAtClient(event.clientX, event.clientY);
      const format = this.session.project?.pageFormat;
      // Off the page: laid in its 欄外.
      if (where && format && pointOff(where.point, format)) this.edits.layHeld(id, where.page, where.point);
      else if (where) this.edits.putHeld(id, where.page, where.point, where.panel);
    });
  }

  /** The step that goes one spread to the left: on in a right-bound book, back in a left-bound one. */
  private leftward(): number {
    return this.session.project?.binding === "left" ? -1 : 1;
  }

  private flip(step: number): void {
    this.board.deselect();
    this.editor.selection = null;
    this.editor.flip(step);
    this.renderAll();
  }

  /** Keyboard shortcuts while the editor is shown; true when handled. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.session.project) return false;
    const combo = comboOf(event);
    const action = combo ? this.shortcuts.actionFor(combo) : null;
    // Saving works from a text field too; the rest leaves typing alone.
    if (action === "save" || action === "saveAs") {
      void this.save(action === "saveAs");
      return true;
    }
    if (isTyping(event) || document.querySelector("dialog[open]")) return false;
    // Arrows move what is selected (資料: the chosen picture; Shift: further) before anything else.
    const step = event.shiftKey ? 5 : 0.5;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const arrow = arrows[event.key];
    const plain = arrow && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (plain && (this.editor.selection ? this.editor.nudge(...arrow) : this.references.nudgeChosen(...arrow))) return true;
    // A tool's key held: its repeats change nothing (the eraser's would cycle how it erases).
    if (event.repeat && this.spring.holds(event.code)) return true;
    const from = this.editor.tool;
    const done = action ? this.run(action) : false;
    if (done && action?.startsWith("tool.") && this.editor.tool !== from) this.spring.press(event.code, from, performance.now());
    return done;
  }

  /** Run a command (a shortcut's action, an action bar's button); false when it does not apply now. */
  run(action: ActionId): boolean {
    return this.commands.find((command) => command.id === action)?.run() ?? false;
  }
}

/** The button with this id when it is on screen and can be pressed, else null. */
function pressable(id: string): HTMLButtonElement | null {
  const target = document.getElementById(id);
  if (!(target instanceof HTMLButtonElement) || target.disabled || target.closest("[hidden]")) return null;
  return target;
}

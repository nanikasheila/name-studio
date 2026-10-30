// The bars above the pages: the tool in hand and its options row (コマ割り's
// ways, the fill's tones, the pen or eraser and its size), and how the pages
// are shown (見開き, 単独 or 連続 and its rows).
import { addBrushes } from "./brush";
import { clampSize, sizeInHand, withHandSize } from "./brushpicks";
import { BrushSource } from "./brushsource";
import { subtoolCommandId, type Command } from "./commands";
import { $, element } from "./dom";
import { ERASE_MODE_LABELS, PANEL_MODE_LABELS, type EditorEraseMode, type PageEditor, type PanelMode, type Tool } from "./editor";
import type { Brush, BrushKind, FillTone, Project } from "./model";
import { CONTINUOUS_KEY, loadHandSizes, loadLibrary, ROWS_KEY, saveHandSizes, SHOW_NOTES_KEY, SINGLE_PAGE_KEY } from "./prefs";
import { SubToolPanel } from "./subtools";
import { writeCount, writeFlag } from "./settings";
import { TONE_LABELS } from "./strokes";
import { MarkBar } from "./markbar";
import { fitRow } from "./rowfit";
import type { RoughChange } from "./roughpanel";
import { TOOL_IDS, TOOLS, type ToolId } from "./tooldefs";

/** コマ割り: the hint for each way of making panels. */
const PANEL_HINTS: Record<PanelMode, string> = {
  cut: TOOLS.cut.hint,
  sketch: "紙のように描く: 囲むと仮のコマ、横切ると割る、コマの間をぐしゃぐしゃでつなげる。決まったら「整える」で清書",
  rect: "ドラッグで四角いコマを描く。コマの中に描くと、はめ込み（Alt で吸着しない）",
  polygon: "クリックで角を置く。最初の角・ダブルクリック・Enter で閉じてコマに。Backspace で 1 つ戻す、Esc でやめる",
};

const CONTINUOUS_TITLE = "全ページを一枚のキャンバスに並べ、どのページにもそのまま描く（F7）";
const ROWS_TITLE = "見開きを何行に並べるか。1 で全ページを横一列に（Alt+↑ / Alt+↓）";

/** What the bars need from the editor around them. */
export interface ControlBarHost {
  readonly editor: PageEditor;
  project(): Project | null;
  /** Run a change as one undoable step. */
  edit(change: (project: Project) => void): void;
  status(message: string): void;
  renderAll(): void;
  /** The tool in hand changed (the 資料 bar follows it). */
  toolChanged(tool: Tool): void;
  /** The grid check box: panels snap to the grid or not. */
  snapGrid(on: boolean): void;
  /** A change to the layers (指示のレイヤー), as one undoable step. */
  rough(change: RoughChange): void;
  /** The サブツール palette is on screen. */
  subtoolsShown(): boolean;
  /** The keys of a command, and giving or taking one (the label of the command it was taken from). */
  keysOf(command: string): string[];
  bindKey(command: string, combo: string): string | null;
  unbindKey(command: string, combo: string): void;
  /** ペン・消しゴムの設定, and taking them over from CSP. */
  openBrushEditor(kind: BrushKind): void;
  importBrushes(): void;
}

export class ControlBar {
  /** The 指示 tool's bar. */
  private readonly marks: MarkBar;

  /** サブツール: the kinds of the tool in hand, and ツールプロパティ. */
  readonly subtools: SubToolPanel;
  /** The size each pen was last used at (this computer). */
  private handSizes = loadHandSizes();

  constructor(private readonly host: ControlBarHost) {
    $("editor-tools").replaceChildren(...TOOL_IDS.map(toolButton));
    this.marks = new MarkBar({ ...host, setTool: (tool) => this.setTool(tool) });
    this.subtools = new SubToolPanel($("side-subtools"), {
      tool: () => this.editor.tool,
      shown: () => host.subtoolsShown(),
      keysOf: (command) => host.keysOf(command),
      bindKey: (command, combo) => host.bindKey(command, combo),
      unbindKey: (command, combo) => host.unbindKey(command, combo),
      status: (message) => host.status(message),
    });
    const brushes = {
      editor: host.editor,
      project: () => host.project(),
      edit: (change: (project: Project) => void) => host.edit(change),
      useBrush: (brush: Brush | null, kind: BrushKind) => this.useBrush(brush, kind),
      setSize: (kind: BrushKind, mm: number) => this.setSize(kind, mm),
      setEraseMode: (mode: EditorEraseMode) => this.setEraseMode(mode),
      openEditor: (kind: BrushKind) => host.openBrushEditor(kind),
      importBrushes: () => host.importBrushes(),
      status: (message: string) => host.status(message),
      refresh: () => this.subtools.render(true),
    };
    this.subtools.add(new BrushSource("pen", brushes));
    this.subtools.add(new BrushSource("eraser", brushes));
  }

  /** A command for each sub tool, to take it up by name (Ctrl+K) or by its keys. */
  subtoolCommands(available: () => boolean): Command[] {
    return this.subtools.all().flatMap((source) =>
      source.list().map((tool) => ({
        id: subtoolCommandId(tool.ref),
        label: `${source.label}: ${tool.name}`,
        group: "サブツール",
        keys: [],
        words: "持ち替え サブツール ブラシ",
        available,
        run: () => {
          if (!available()) return false;
          source.pick(tool.ref);
          return true;
        },
      })),
    );
  }

  private get editor(): PageEditor {
    return this.host.editor;
  }

  setTool(tool: Tool): void {
    this.editor.setTool(tool);
    for (const name of TOOL_IDS) $(`tool-${name}`).classList.toggle("active", name === tool);
    $("fill-tones").hidden = tool !== "fill";
    $("panel-modes").hidden = tool !== "cut";
    $("grid-snap-label").hidden = tool !== "cut";
    $("panel-tidy").hidden = tool !== "cut";
    $("reference-bar").classList.toggle("off", tool !== "reference");
    this.host.toolChanged(tool);
    // The options row names the tool and shows only what it has; nothing else moves.
    const button = $(`tool-${tool}`);
    const name = $("tool-name");
    name.replaceChildren(...[...button.childNodes].map((node) => node.cloneNode(true)));
    name.style.setProperty("--tool", getComputedStyle(button).getPropertyValue("--tool"));
    $("tool-hint").textContent = TOOLS[tool].hint;
    this.showPanelModes();
    this.renderBrushBar();
  }

  /** コマ割り: how a drag makes panels, and whether they snap to the grid. */
  showPanelModes(): void {
    const mode = this.editor.panelMode;
    for (const name of Object.keys(PANEL_MODE_LABELS) as PanelMode[]) $(`panel-${name}`).classList.toggle("active", name === mode);
    $<HTMLInputElement>("grid-snap").checked = this.editor.snapping.grid;
    if (this.editor.tool === "cut") $("tool-hint").textContent = PANEL_HINTS[mode];
  }

  setPanelMode(mode: PanelMode): void {
    this.editor.setPanelMode(mode);
    if (this.editor.tool !== "cut") this.setTool("cut");
    this.showPanelModes();
  }

  showViewMode(): void {
    const { continuous } = this.editor;
    // 縦スクロール: no spreads; a piece at a time or the strip.
    const scroll = !!this.host.project()?.scroll;
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
  showRows(): void {
    const range = $<HTMLInputElement>("rows-range");
    range.max = String(Math.max(1, this.editor.spreadList().length));
    const rows = this.editor.rowCount();
    range.value = String(rows);
    const scroll = !!this.host.project()?.scroll;
    $("rows-value").textContent = scroll ? `${rows} 列` : `${rows} 行`;
    range.parentElement!.title = scroll ? "縦の帯を何列に分けて並べるか。1 で一本の帯に（Alt+↑ / Alt+↓）" : ROWS_TITLE;
  }

  /** 見開き, 単独 or 連続 (all pages on one canvas): keeps the page in view. */
  setView(mode: "spread" | "single" | "continuous"): void {
    const page = this.editor.focusPage();
    const project = this.host.project();
    this.editor.continuous = mode === "continuous";
    if (mode !== "continuous") this.editor.single = mode === "single";
    writeFlag(CONTINUOUS_KEY, this.editor.continuous);
    writeFlag(SINGLE_PAGE_KEY, this.editor.single);
    this.showViewMode();
    const index = page && project ? project.pages.indexOf(page) : -1;
    this.editor.spreadIndex = 0;
    // 連続: the rows as tall as the stage around the page (縦スクロール: a few pieces), then out or in with the wheel.
    this.editor.resetView(this.editor.continuous && project?.scroll ? 0.5 : 1);
    if (index >= 0) this.editor.showPage(index + 1);
    if (this.editor.continuous && !project?.scroll) this.editor.fitRows();
    this.host.renderAll();
    if (this.editor.continuous && project?.scroll) this.host.status("区切りを縦の帯に並べました。ホイールで上下、Ctrl+ホイールで拡大縮小、列数は下のつまみ（Alt+↑↓）");
    else if (this.editor.continuous) this.host.status("全ページを一枚に並べました。行数は下のつまみ（Alt+↑↓）、全体は Ctrl+Alt+0、横へは Shift+ホイール");
  }

  /** 連続: the spreads in `rows` rows. */
  setRows(rows: number): void {
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
    this.host.status(`塗り: ${TONE_LABELS[tone]}`);
  }

  // --- pens and erasers -------------------------------------------------------------------

  /** Switch how the eraser erases, keeping the tool in hand. */
  setEraseMode(mode: EditorEraseMode): void {
    this.editor.eraseMode = mode;
    this.renderBrushBar();
    this.editor.draw();
    this.host.status(`消し方: ${ERASE_MODE_LABELS[mode]}`);
  }

  /** Use a brush for its kind of tool, at the size it was last used at (its own, once that is set anew). */
  useBrush(brush: Brush | null, kind: BrushKind = brush?.kind ?? "pen"): void {
    const size = sizeInHand(this.handSizes, kind, brush);
    if (kind === "eraser") {
      this.editor.eraserBrush = brush?.id ?? null;
      if (brush) this.editor.eraserSizeMm = size;
      // A CSP vector eraser brings its way of erasing; it can be switched after.
      if (brush?.erase) this.editor.eraseMode = brush.erase;
    } else {
      this.editor.penBrush = brush?.id ?? null;
      this.editor.penWidthMm = size;
    }
    if (this.editor.tool !== kind) this.setTool(kind);
    else this.renderBrushBar();
    this.editor.draw();
  }

  /** The size of the pen or eraser in hand; the pen keeps it for the next time it is taken up. */
  setSize(kind: BrushKind, mm: number): void {
    const size = clampSize(kind, mm);
    if (kind === "pen") this.editor.penWidthMm = size;
    else this.editor.eraserSizeMm = size;
    this.handSizes = withHandSize(this.handSizes, kind, this.editor.brush(kind) ?? null, size);
    saveHandSizes(this.handSizes);
    this.renderBrushBar();
    this.editor.draw();
  }

  /** The pen / eraser chooser: the project's brushes, then ones taken in other projects. */
  renderBrushBar(): void {
    this.marks.render();
    this.subtools.render();
    const tool = this.editor.tool;
    const bar = $("brush-bar");
    bar.classList.toggle("off", tool !== "pen" && tool !== "eraser");
    const project = this.host.project();
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
    const project = this.host.project();
    if (!project) return;
    if (value.startsWith("library:")) {
      const brush = loadLibrary()[Number(value.slice("library:".length))];
      if (!brush) return;
      let added: Brush[] = [];
      this.host.edit((p) => {
        added = addBrushes(p, [brush]);
      });
      this.useBrush(added[0] ?? null, kind);
      return;
    }
    this.useBrush(project.brushes.find((brush) => brush.id === value) ?? null, kind);
  }

  /** ] / [: the pen or eraser in hand a size up or down. */
  resizeBrush(factor: number): boolean {
    const tool = this.editor.tool;
    if (tool === "mark") return this.marks.resize(factor), this.editor.draw(), true;
    if (tool !== "pen" && tool !== "eraser") return false;
    this.setSize(tool, (tool === "pen" ? this.editor.penWidthMm : this.editor.eraserSizeMm) * factor);
    this.host.status(`${tool === "pen" ? "ペン" : "消しゴム"}の太さ: ${tool === "pen" ? this.editor.penWidthMm : this.editor.eraserSizeMm} mm`);
    return true;
  }

  /** The bars' buttons, boxes and sliders. */
  bind(): void {
    this.marks.bind();
    // The row under the pages: all of its switches in sight, never scrolled sideways.
    fitRow($("page-nav"), 3);
    for (const tone of ["black", "gray", "white"] as const) {
      $(`fill-${tone}`).addEventListener("click", () => this.setFillTone(tone));
    }
    for (const mode of Object.keys(PANEL_MODE_LABELS) as PanelMode[]) {
      $(`panel-${mode}`).addEventListener("click", () => this.setPanelMode(mode));
    }
    $<HTMLInputElement>("grid-snap").addEventListener("change", (event) => this.host.snapGrid((event.target as HTMLInputElement).checked));
    for (const name of TOOL_IDS) $(`tool-${name}`).addEventListener("click", () => this.setTool(name));
    for (const mode of Object.keys(ERASE_MODE_LABELS) as EditorEraseMode[]) {
      $(`erase-${mode}`).addEventListener("click", () => this.setEraseMode(mode));
    }
    $<HTMLSelectElement>("brush-select").addEventListener("change", (event) => {
      this.chooseBrush((event.target as HTMLSelectElement).value);
    });
    $<HTMLInputElement>("brush-size").addEventListener("change", (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      if (!(value > 0)) return;
      this.setSize(this.editor.tool === "eraser" ? "eraser" : "pen", value);
    });
    $<HTMLInputElement>("brush-tip").addEventListener("change", (event) => {
      const kind = this.editor.tool === "eraser" ? "eraser" : "pen";
      const id = this.editor.brush(kind)?.id;
      const enabled = (event.target as HTMLInputElement).checked;
      this.host.edit((project) => {
        const tip = project.brushes.find((brush) => brush.id === id)?.tip;
        if (tip) tip.enabled = enabled;
      });
    });
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
      this.host.renderAll();
    });
  }
}

/** A tool's button on the rail (the first, 選択, in hand at the start). */
function toolButton(id: ToolId): HTMLButtonElement {
  const tool = TOOLS[id];
  const button = element("button", { id: `tool-${id}`, className: id === TOOL_IDS[0] ? "active" : "", title: tool.title });
  button.dataset.command = `tool.${id}`;
  button.innerHTML = `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true">${tool.icon}</svg>`;
  button.append(element("span", { textContent: tool.name }));
  return button;
}

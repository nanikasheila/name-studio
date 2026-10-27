// The bars above the pages: the tool in hand and its options row (コマ割り's
// ways, the fill's tones, the pen or eraser and its size), and how the pages
// are shown (見開き, 単独 or 連続 and its rows).
import { addBrushes } from "./brush";
import { $ } from "./dom";
import { ERASE_MODE_LABELS, PANEL_MODE_LABELS, type EditorEraseMode, type PageEditor, type PanelMode, type Tool } from "./editor";
import type { Brush, FillTone, Project } from "./model";
import { CONTINUOUS_KEY, loadLibrary, ROWS_KEY, SHOW_NOTES_KEY, SINGLE_PAGE_KEY } from "./prefs";
import { writeCount, writeFlag } from "./settings";
import { TONE_LABELS } from "./strokes";
import { MarkBar } from "./markbar";
import type { RoughChange } from "./roughpanel";

const TOOLS = ["select", "cut", "text", "pen", "mark", "eraser", "fill", "breakout", "sticky", "reference"] as const satisfies readonly Tool[];

/** One line under the tool's name in the options row. */
const TOOL_HINTS: Record<Tool, string> = {
  select: "クリックで選ぶ・ドラッグで動かす・ダブルクリックで書き込む。Shift で足す、囲んでまとめて選ぶ",
  cut: "コマを横切るように引くと割れる（Alt で斜め）。Shift + コマの外のドラッグで新しいコマ",
  text: "クリックした所にセリフを置く。選んで Alt+ホイールで文字の大きさ",
  pen: "",
  mark: "指示を描きなぐる。消しゴム側か「消す」で指示だけ消す。CSP へは下描きレイヤー「指示」",
  eraser: "",
  fill: "囲んだ所を塗る",
  breakout: "コマを突き抜ける所を囲む。中に描いた線はコマ枠の上に",
  sticky: "クリックで付箋を貼る（書き出しには入りません）",
  reference: "写真や背景を薄く敷く。Ctrl+V・ドロップでも貼れる。ドラッグで動かし、角で大きさ（CSP には下描きレイヤーで出ます）",
};

/** コマ割り: the hint for each way of making panels. */
const PANEL_HINTS: Record<PanelMode, string> = {
  cut: TOOL_HINTS.cut,
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
}

export class ControlBar {
  /** The 指示 tool's bar. */
  private readonly marks: MarkBar;

  constructor(private readonly host: ControlBarHost) {
    this.marks = new MarkBar({ ...host, setTool: (tool) => this.setTool(tool) });
  }

  private get editor(): PageEditor {
    return this.host.editor;
  }

  setTool(tool: Tool): void {
    this.editor.setTool(tool);
    for (const name of TOOLS) $(`tool-${name}`).classList.toggle("active", name === tool);
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
    $("tool-hint").textContent = TOOL_HINTS[tool];
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

  /** Use a brush for its kind of tool, with its own size. */
  useBrush(brush: Brush | null, kind: "pen" | "eraser" = brush?.kind ?? "pen"): void {
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
  renderBrushBar(): void {
    this.marks.render();
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
    const round2 = (value: number) => Math.round(value * 100) / 100;
    if (tool === "pen") this.editor.penWidthMm = Math.min(20, Math.max(0.05, round2(this.editor.penWidthMm * factor)));
    else this.editor.eraserSizeMm = Math.min(50, Math.max(0.2, round2(this.editor.eraserSizeMm * factor)));
    this.renderBrushBar();
    this.editor.draw();
    this.host.status(`${tool === "pen" ? "ペン" : "消しゴム"}の太さ: ${tool === "pen" ? this.editor.penWidthMm : this.editor.eraserSizeMm} mm`);
    return true;
  }

  /** The bars' buttons, boxes and sliders. */
  bind(): void {
    this.marks.bind();
    for (const tone of ["black", "gray", "white"] as const) {
      $(`fill-${tone}`).addEventListener("click", () => this.setFillTone(tone));
    }
    for (const mode of Object.keys(PANEL_MODE_LABELS) as PanelMode[]) {
      $(`panel-${mode}`).addEventListener("click", () => this.setPanelMode(mode));
    }
    $<HTMLInputElement>("grid-snap").addEventListener("change", (event) => this.host.snapGrid((event.target as HTMLInputElement).checked));
    for (const name of TOOLS) $(`tool-${name}`).addEventListener("click", () => this.setTool(name));
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

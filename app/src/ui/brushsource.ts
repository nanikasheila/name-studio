// サブツールの欄のペンと消しゴム: the pens (or erasers) to pick, each with a
// line drawn the way it draws, and ツールプロパティ for the one in hand:
// its size (a slider, a box and the round buttons of ブラシサイズ), its
// opacity and 手ブレ補正, how an eraser erases, and the way to all its
// settings.
import { ask } from "../platform/dialogs";
import { addBrushes } from "../domain/brush";
import { freeName } from "../domain/listorder";
import { newId } from "../domain/project";
import {
  brushPicks,
  brushRef,
  clampSize,
  reorderBrushes,
  sizeLabel,
  sizeOfSlider,
  sliderOf,
  SLIDER_STEPS,
  withoutPreset,
  withPreset,
  type BrushPick,
} from "../editing/brushpicks";
import {
  applyCspSettings,
  bytesOf,
  cspSettingsFor,
  ensureCspSettings,
  parseEffector,
  setSetting,
  settingsSignature,
} from "../domain/cspsettings";
import { brushPropItems, COLUMNS, defaultBrushItems, effectorOfColumn, ERASE_MODE, SIZE_BUTTONS, TIP_SHAPE } from "../editing/brushitems";
import type { CspColumn } from "../generated/csp-columns";
import type { PropItem } from "../editing/toolprops";
import { element } from "../platform/dom";
import { ERASE_MODE_LABELS, type EditorEraseMode, type PageEditor } from "./editor";
import type { Brush, BrushKind, Project, Stroke, StrokePoint } from "../model/model";
import { drawStroke, INK, loadTips } from "../render/pagedraw";
import { loadLibrary, loadSizePresets, penPreferences, saveSizePresets, saveToLibrary } from "../platform/prefs";
import type { SubTool, SubToolMenuItem, SubToolSource } from "./subtools";

export interface BrushSourceHost {
  readonly editor: PageEditor;
  project(): Project | null;
  /** Run a change as one undoable step. */
  edit(change: (project: Project) => void): void;
  /** Take the brush up (with its kind of tool), at the size it was last used at. */
  useBrush(brush: Brush | null, kind: BrushKind): void;
  /** The size of the pen or eraser in hand. */
  setSize(kind: BrushKind, mm: number): void;
  setEraseMode(mode: EditorEraseMode): void;
  /** ペン・消しゴムの設定 (every setting), on the one in hand; on the settings with `words` when given. */
  openEditor(kind: BrushKind, words?: string): void;
  /** Take pens and erasers over from CSP. */
  importBrushes(): void;
  status(message: string): void;
  /** Show the palette again (a size button added, …). */
  refresh(): void;
}

const NAMES: Record<BrushKind, string> = { pen: "ペン", eraser: "消しゴム" };
const PLAIN: Record<BrushKind, string> = { pen: "標準のペン", eraser: "標準の消しゴム" };
const OTHER_NAMES = "ほかのネームで取り込んだもの";

/** Samples drawn once, by what of the brush they show. */
const samples = new Map<string, HTMLCanvasElement>();
/** Tip pictures loaded (a sample drawn before its tip loaded is drawn again once). */
const tipsReady = new Set<string>();

/** What a sample depends on: the brush's drawing values (not its CSP rows, nor its tip's whole picture). */
function sampleKey(brush: Brush | null, kind: BrushKind, width: number, height: number): string {
  if (!brush) return `${kind}/${width}x${height}`;
  const { csp: _csp, tip, id: _id, name: _name, source: _source, ...values } = brush;
  const shape = tip && {
    enabled: tip.enabled,
    interval: tip.interval,
    size: [tip.width, tip.height],
    picture: tip.pngBase64.length + tip.pngBase64.slice(-24),
  };
  return JSON.stringify([kind, width, height, values, shape]);
}

/** Sample px per page mm. */
const SAMPLE_SCALE = 4;

/** A line across the sample, light to firm to light, slow then quick. */
function sampleStroke(widthMm: number, heightMm: number): Stroke {
  const points: StrokePoint[] = [];
  const count = 48;
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const x = 1.5 + t * (widthMm - 3);
    const y = heightMm / 2 + Math.sin(t * Math.PI * 2) * heightMm * 0.22;
    points.push([x, y, Math.max(0.05, Math.sin(t * Math.PI)), 0, t * 0.6]);
  }
  return { id: "sample", points, widthMm: 1, closed: false };
}

/** What the brush draws, on a canvas the size of the row's. */
function sample(brush: Brush | null, kind: BrushKind, width: number, height: number): HTMLCanvasElement {
  const key = sampleKey(brush, kind, width, height);
  const kept = samples.get(key);
  if (kept) return kept;
  const canvas = element("canvas", { width, height });
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const ratio = width / 96;
    const m = { scale: SAMPLE_SCALE * ratio, x: 0, y: 0 };
    const stroke = sampleStroke(width / m.scale, height / m.scale);
    const eraser = kind === "eraser";
    // As thick as reads in a row; the size itself is written beside it.
    stroke.widthMm = eraser ? 2.2 : 0.9;
    drawStroke(ctx, stroke, m, eraser ? "rgba(214, 72, 72, 0.6)" : INK, 0.7, brush ?? undefined);
  }
  if (samples.size > 300) samples.clear();
  samples.set(key, canvas);
  return canvas;
}

export class BrushSource implements SubToolSource {
  readonly label: string;

  constructor(
    readonly tool: BrushKind,
    private readonly host: BrushSourceHost,
  ) {
    this.label = NAMES[tool];
  }

  private get kind(): BrushKind {
    return this.tool;
  }

  private picks(): BrushPick[] {
    const project = this.host.project();
    return project ? brushPicks(project, loadLibrary(), this.kind) : [];
  }

  private inHand(): Brush | null {
    return this.host.editor.brush(this.kind) ?? null;
  }

  private sizeInHand(): number {
    return this.kind === "pen" ? this.host.editor.penWidthMm : this.host.editor.eraserSizeMm;
  }

  list(): SubTool[] {
    const inHand = this.current();
    return this.picks().map((pick) => {
      const own = pick.brush ? pick.brush.sizeMm : null;
      const size = pick.ref === inHand ? this.sizeInHand() : own;
      return {
        ref: pick.ref,
        name: pick.brush?.name ?? PLAIN[this.kind],
        detail: size === null ? "" : sizeLabel(size),
        group: pick.library ? OTHER_NAMES : undefined,
        movable: !!pick.brush && !pick.library,
        sample: (canvas) => this.drawSample(canvas, pick.brush),
      };
    });
  }

  private drawSample(canvas: HTMLCanvasElement, brush: Brush | null): void {
    const ratio = window.devicePixelRatio || 1;
    const [width, height] = [Math.round(96 * ratio), Math.round(20 * ratio)];
    canvas.width = width;
    canvas.height = height;
    const paint = () => canvas.getContext("2d")?.drawImage(sample(brush, this.kind, width, height), 0, 0);
    paint();
    const tip = brush?.tip;
    if (brush && tip?.enabled && !tipsReady.has(tip.pngBase64)) {
      void loadTips([brush]).then(() => {
        tipsReady.add(tip.pngBase64);
        samples.delete(sampleKey(brush, this.kind, width, height));
        canvas.getContext("2d")?.clearRect(0, 0, width, height);
        paint();
      });
    }
  }

  current(): string | null {
    return brushRef(this.kind, this.inHand());
  }

  pick(ref: string): void {
    const pick = this.picks().find((p) => p.ref === ref);
    if (!pick) return;
    let brush = pick.brush;
    if (brush && pick.library) {
      // Taken in another name: it comes into this one.
      const from = brush;
      let added: Brush[] = [];
      this.host.edit((project) => {
        added = addBrushes(project, [from]);
      });
      brush = added[0] ?? null;
    }
    this.host.useBrush(brush, this.kind);
    this.host.status(`${NAMES[this.kind]}: ${brush?.name ?? PLAIN[this.kind]}`);
  }

  reorder(first: number, last: number, target: number): void {
    const kind = this.kind;
    this.host.edit((project) => {
      project.brushes = reorderBrushes(project.brushes, kind, first, last, target);
    });
  }

  menu(ref: string): SubToolMenuItem[] {
    const pick = this.picks().find((p) => p.ref === ref);
    if (!pick?.brush) return [];
    return [
      {
        label: "設定…（CSP の項目すべて）",
        run: () => {
          if (this.current() !== ref) this.pick(ref);
          this.host.openEditor(this.kind);
        },
      },
    ];
  }

  /** The name's own brush behind a ref (not the plain one, nor one of another name). */
  private own(ref: string): Brush | null {
    const pick = this.picks().find((p) => p.ref === ref);
    return pick?.brush && !pick.library ? pick.brush : null;
  }

  duplicate(ref: string): void {
    const source = this.picks().find((p) => p.ref === ref)?.brush;
    if (!source) {
      this.host.status(`${PLAIN[this.kind]}は複製できません（「設定…」の「新しく作る」で作れます）`);
      return;
    }
    let made: Brush | null = null;
    this.host.edit((project) => {
      const copy = structuredClone(source);
      copy.id = newId(project, "brush");
      copy.name = freeName(
        `${source.name} のコピー`,
        project.brushes.filter((b) => b.kind === source.kind).map((b) => b.name),
      );
      // Right under the one copied (when it is the name's own).
      const at = project.brushes.findIndex((b) => b.id === source.id);
      project.brushes.splice(at >= 0 ? at + 1 : project.brushes.length, 0, copy);
      made = copy;
    });
    if (!made) return;
    saveToLibrary([made]);
    this.host.useBrush(made, this.kind);
    this.host.status(`「${(made as Brush).name}」を作りました（名前・設定は「設定…」で。元に戻すは Ctrl+Z）`);
  }

  canRemove(ref: string): boolean {
    return !!this.own(ref);
  }

  async remove(ref: string): Promise<void> {
    const brush = this.own(ref);
    const project = this.host.project();
    if (!brush || !project) return;
    const lines = project.pages.reduce((sum, page) => sum + page.strokes.filter((stroke) => stroke.brush === brush.id).length, 0);
    if (
      lines &&
      !(await ask(
        `「${brush.name}」で描いた線が ${lines} 本あります。削除すると、その線は${PLAIN[this.kind]}で描いた形になります。削除しますか？`,
        {
          title: "Name Studio",
          kind: "warning",
        },
      ))
    )
      return;
    const inHand = this.inHand()?.id === brush.id;
    this.host.edit((p) => {
      p.brushes = p.brushes.filter((b) => b.id !== brush.id);
    });
    if (inHand) this.host.useBrush(null, this.kind);
    this.host.status(`「${brush.name}」を削除しました（元に戻すで戻せます）`);
  }

  /** F2: the name is changed in the settings, with the brush in hand. */
  rename(ref: string): void {
    if (!this.own(ref)) return;
    if (this.current() !== ref) this.pick(ref);
    this.host.openEditor(this.kind);
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#be-name")?.select());
  }

  footer(box: HTMLElement): void {
    const settings = element("button", {
      type: "button",
      textContent: "設定…",
      title: "ペン・消しゴムの設定: 新しく作る・複製・CSP のサブツール詳細の項目すべて・.sut に書き出して CSP へ",
    });
    settings.addEventListener("click", () => this.host.openEditor(this.kind));
    const take = element("button", { type: "button", textContent: "取り込み…", title: "CLIP STUDIO PAINT のペン・消しゴムを取り込む" });
    take.addEventListener("click", () => this.host.importBrushes());
    box.append(settings, take);
  }

  // --- ツールプロパティ --------------------------------------------------------------

  currentName(): string {
    return this.inHand()?.name ?? PLAIN[this.kind];
  }

  details(words = ""): void {
    this.host.openEditor(this.kind, words);
  }

  items(): PropItem[] {
    return brushPropItems(this.kind, this.inHand());
  }

  defaultItems(): string[] {
    return defaultBrushItems(this.kind, this.inHand());
  }

  item(id: string): HTMLElement | null {
    const brush = this.inHand();
    const kind = this.kind;
    const words = (node: HTMLElement, label: string) => {
      node.dataset.setting = label;
      return node;
    };
    switch (id) {
      case "BrushSize":
        return words(this.withEffector(this.sizeRow(), brush, "BrushSize"), "ブラシサイズ");
      case SIZE_BUTTONS:
        return this.presetRow();
      case ERASE_MODE:
        return kind === "eraser" ? this.eraseRow() : null;
      case TIP_SHAPE:
        return brush?.tip ? this.tipRow(brush) : null;
      case "Opacity":
        if (!brush) return null;
        return words(
          this.withEffector(
            this.percentRow("不透明度", Math.round(brush.opacity * 100), 1, 100, (value) =>
              this.setCsp(brush, "Opacity", value, `不透明度 ${value}%`),
            ),
            brush,
            "Opacity",
          ),
          "不透明度",
        );
      case "FlickerReduction":
        if (brush)
          return words(
            this.percentRow("手ブレ補正", Math.round(brush.stabilization), 0, 100, (value) =>
              this.setCsp(brush, "FlickerReduction", value, `手ブレ補正 ${value}`),
            ),
            "手ブレ補正",
          );
        if (kind !== "pen") return null;
        // The 標準のペン keeps its 手ブレ補正 in the pen settings (all names alike).
        return this.percentRow("手ブレ補正", penPreferences.settings.stabilization, 0, 100, (value) => {
          penPreferences.update({ stabilization: value });
          this.host.status(`${PLAIN.pen}: 手ブレ補正 ${value}`);
        });
      default: {
        const column = COLUMNS.get(id);
        if (!brush || !column) return null;
        const node = this.cspRow(brush, column);
        return node && words(this.withEffector(node, brush, id), column.label);
      }
    }
  }

  note(): HTMLElement | null {
    if (this.inHand()) return null;
    return element("p", {
      className: "subtool-note",
      textContent:
        this.kind === "pen"
          ? "標準のペンは太さと手ブレ補正だけ変えられます。ほかの項目は「設定…」で作ったペンか、取り込んだペンで。"
          : "標準の消しゴムは太さと消し方だけ変えられます。ほかの項目は「設定…」で作った消しゴムか、取り込んだ消しゴムで。",
    });
  }

  /** ブラシサイズ palette: the round buttons, large. */
  sizes(box: HTMLElement): void {
    const row = this.presetRow();
    row.classList.add("large");
    box.append(
      element("div", { className: "subtool-props-title", textContent: `${this.currentName()} ${sizeLabel(this.sizeInHand())} mm` }),
      row,
    );
  }

  /** A row with the 影響元 button of its 影響元設定 (筆圧・傾き・速度), which opens it in the settings. */
  private withEffector(row: HTMLElement, brush: Brush | null, column: string): HTMLElement {
    const effector = brush && effectorOfColumn(column);
    if (!brush || !effector) return row;
    const tool = brush.csp;
    const value = tool?.settings[effector];
    const parsed = value && typeof value === "object" ? parseEffector(bytesOf(value.blob)) : null;
    const on = !!parsed && (parsed.inputs & 0xf0) !== 0;
    const label = COLUMNS.get(column)?.label ?? column;
    const button = element("button", {
      type: "button",
      className: `icon-button effector-button${on ? " on" : ""}`,
      title: `${label}の影響元設定（筆圧・傾き・速度）${on ? ": 使っている" : ""}。クリックで詳細設定に`,
      innerHTML: EFFECTOR_ICON,
    });
    button.setAttribute("aria-label", `${label}の影響元設定`);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      this.host.openEditor(this.kind, label);
    });
    row.append(button);
    return row;
  }

  /** Any other CSP setting of the brush: a check box, a choice, or a number (a slider when it has a range). */
  private cspRow(brush: Brush, column: CspColumn): HTMLElement | null {
    const tool = brush.csp ?? cspSettingsFor(brush);
    const value = tool.settings[column.column];
    const edit = column.edit;
    const title = [column.label, column.values].filter(Boolean).join("\n");
    if (edit.kind === "check") {
      const check = element("input", { type: "checkbox", checked: typeof value === "number" && value !== 0 });
      check.addEventListener("change", () =>
        this.setCsp(brush, column.column, check.checked ? 1 : 0, `${column.label} ${check.checked ? "オン" : "オフ"}`),
      );
      return element("label", { className: "subtool-check", title }, check, ` ${column.label}`);
    }
    if (edit.kind === "choice") {
      const select = element("select");
      select.setAttribute("aria-label", column.label);
      if (typeof value !== "number") select.append(element("option", { value: "", textContent: "（CSP の初期値）" }));
      for (const [option, label] of edit.options) select.append(element("option", { value: String(option), textContent: label }));
      if (typeof value === "number" && !edit.options.some(([option]) => option === value))
        select.append(element("option", { value: String(value), textContent: String(value) }));
      select.value = typeof value === "number" ? String(value) : "";
      select.addEventListener("change", () => {
        if (select.value === "") return;
        const label = edit.options.find(([option]) => String(option) === select.value)?.[1] ?? select.value;
        this.setCsp(brush, column.column, Number(select.value), `${column.label} ${label}`);
      });
      return element("label", { className: "subtool-field", title }, element("span", { textContent: column.label }), select);
    }
    if (edit.kind !== "number") return null;
    const current = typeof value === "number" ? value : null;
    const unitColumn = COLUMNS.get(`${column.column}Unit`);
    const unitValue = unitColumn ? tool.settings[unitColumn.column] : undefined;
    const unit = unitColumn ? (unitValue === 2 ? "×10px" : "px") : (edit.unit ?? "");
    const clamp = (n: number) => {
      let next = edit.integer ? Math.round(n) : Math.round(n * 1000) / 1000;
      if (edit.min !== undefined) next = Math.max(edit.min, next);
      if (edit.max !== undefined) next = Math.min(edit.max, next);
      return next;
    };
    const number = element("input", {
      type: "number",
      value: current === null ? "" : String(Math.round(current * 1000) / 1000),
      placeholder: "初期値",
    });
    number.setAttribute("aria-label", column.label);
    if (edit.min !== undefined) number.min = String(edit.min);
    if (edit.max !== undefined) number.max = String(edit.max);
    number.step = edit.integer ? "1" : "any";
    const said = (n: number) => `${column.label} ${n}${unit}`;
    number.addEventListener("change", () => {
      if (number.value === "" || !Number.isFinite(Number(number.value))) return;
      const next = clamp(Number(number.value));
      this.setCsp(brush, column.column, next, said(next));
    });
    const parts: HTMLElement[] = [element("span", { textContent: column.label })];
    if (edit.min !== undefined && edit.max !== undefined) {
      const range = element("input", {
        type: "range",
        min: String(edit.min),
        max: String(edit.max),
        step: edit.integer ? "1" : String((edit.max - edit.min) / 100),
        value: String(current ?? edit.min),
      });
      range.setAttribute("aria-label", column.label);
      range.addEventListener("input", () => (number.value = range.value));
      range.addEventListener("change", () => {
        const next = clamp(Number(range.value));
        this.setCsp(brush, column.column, next, said(next));
      });
      parts.push(range);
    }
    parts.push(number);
    if (unit) parts.push(element("span", { className: "unit", textContent: unit }));
    return element("div", { className: "subtool-field", title }, ...parts);
  }

  private tipRow(brush: Brush): HTMLElement {
    const check = element("input", { type: "checkbox", checked: !!brush.tip?.enabled });
    check.addEventListener("change", () => {
      const id = brush.id;
      this.host.edit((project) => {
        const tip = project.brushes.find((b) => b.id === id)?.tip;
        if (tip) tip.enabled = check.checked;
      });
    });
    return element(
      "label",
      { className: "subtool-check", title: "CSP の素材のサムネイルから作った先端の形で描く" },
      check,
      " 先端の形で描く",
    );
  }

  private sizeRow(): HTMLElement {
    const kind = this.kind;
    const mm = this.sizeInHand();
    const range = element("input", {
      type: "range",
      min: "0",
      max: String(SLIDER_STEPS),
      step: "1",
      value: String(sliderOf(kind, mm)),
    });
    range.setAttribute("aria-label", "ブラシサイズ");
    const number = element("input", { type: "number", min: "0.05", max: "50", step: "0.05", value: String(mm) });
    number.setAttribute("aria-label", "ブラシサイズ（mm）");
    // While dragged the pen in hand follows at once; the palette is drawn again when let go.
    range.addEventListener("input", () => {
      const size = sizeOfSlider(kind, Number(range.value));
      number.value = String(size);
      this.host.setSize(kind, size);
    });
    range.addEventListener("change", () => this.host.refresh());
    number.addEventListener("change", () => {
      const value = Number(number.value);
      if (value > 0) this.host.setSize(kind, clampSize(kind, value));
      this.host.refresh();
    });
    return element(
      "label",
      { className: "subtool-field", title: "ブラシサイズ（mm）。] / [ でも変えられます" },
      element("span", { textContent: "ブラシサイズ" }),
      range,
      number,
      element("span", { className: "unit", textContent: "mm" }),
    );
  }

  /** ブラシサイズ: round buttons for the sizes used most, as CSP's palette. */
  private presetRow(): HTMLElement {
    const kind = this.kind;
    const presets = loadSizePresets();
    const now = this.sizeInHand();
    const row = element("div", { className: "size-presets" });
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "ブラシサイズの候補");
    const biggest = Math.max(...presets[kind], 1);
    for (const mm of presets[kind]) {
      const dot = element("i", {});
      // The dot grows with the size, but by ratio (a 20 mm eraser still fits).
      const d = 3 + 15 * Math.sqrt(mm / biggest);
      dot.style.width = dot.style.height = `${d.toFixed(1)}px`;
      const button = element(
        "button",
        { type: "button", className: mm === now ? "active" : "", title: `${sizeLabel(mm)} mm（右クリックで候補から外す）` },
        dot,
        element("span", { textContent: sizeLabel(mm) }),
      );
      button.addEventListener("click", () => {
        this.host.setSize(kind, mm);
        this.host.refresh();
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        saveSizePresets(withoutPreset(loadSizePresets(), kind, mm));
        this.host.status(`${sizeLabel(mm)} mm を候補から外しました`);
        this.host.refresh();
      });
      row.append(button);
    }
    const add = element("button", {
      type: "button",
      className: "add",
      textContent: "＋",
      title: "今の太さを候補に足す（右クリックで候補を初めの並びに戻す）",
    });
    add.addEventListener("click", () => {
      saveSizePresets(withPreset(loadSizePresets(), kind, this.sizeInHand()));
      this.host.refresh();
    });
    add.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      saveSizePresets(null);
      this.host.status("ブラシサイズの候補を初めの並びに戻しました");
      this.host.refresh();
    });
    row.append(add);
    return row;
  }

  private percentRow(label: string, value: number, min: number, max: number, set: (value: number) => void): HTMLElement {
    const range = element("input", { type: "range", min: String(min), max: String(max), step: "1", value: String(value) });
    range.setAttribute("aria-label", label);
    const shown = element("output", { textContent: String(value) });
    range.addEventListener("input", () => (shown.textContent = range.value));
    range.addEventListener("change", () => set(Number(range.value)));
    return element("label", { className: "subtool-field" }, element("span", { textContent: label }), range, shown);
  }

  /** A CSP setting of the brush, as one undoable step (its drawing values follow it). */
  private setCsp(brush: Brush, column: string, value: number, said: string): void {
    const id = brush.id;
    let changed: Brush | null = null;
    this.host.edit((project) => {
      const own = project.brushes.find((b) => b.id === id);
      if (!own) return;
      ensureCspSettings(own);
      setSetting(own.csp!, column, value);
      applyCspSettings(own);
      changed = own;
    });
    if (changed) saveToLibrary([changed]);
    this.host.status(`${brush.name}: ${said}`);
  }

  private eraseRow(): HTMLElement {
    const row = element("div", { className: "segmented subtool-erase" });
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "消し方");
    for (const mode of Object.keys(ERASE_MODE_LABELS) as EditorEraseMode[]) {
      const button = element("button", {
        type: "button",
        textContent: ERASE_MODE_LABELS[mode],
        className: this.host.editor.eraseMode === mode ? "active" : "",
      });
      button.addEventListener("click", () => this.host.setEraseMode(mode));
      row.append(button);
    }
    return element("div", { className: "subtool-field" }, element("span", { textContent: "消し方" }), row);
  }

  /** What the palette shows of this kind now, to skip drawing it again unchanged. */
  signature(): string {
    const brush = this.inHand();
    const rows = this.list().map((tool) => [tool.ref, tool.name, tool.detail, tool.group]);
    const own = this.host.project()?.brushes.map((b) => [b.id, b.sizeMm, b.opacity, b.stabilization, b.tip?.enabled]);
    return JSON.stringify([
      rows,
      own,
      this.current(),
      this.sizeInHand(),
      this.host.editor.eraseMode,
      brush?.id,
      // The settings ツールプロパティ may show, and of the pictures and graphs (影響元設定) their size.
      brush?.csp && settingsSignature(brush.csp.settings),
      loadSizePresets()[this.kind],
      penPreferences.settings.stabilization,
    ]);
  }
}

const EFFECTOR_ICON =
  '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 16c4 0 5-12 14-12"/><path d="M3 16h14" stroke-dasharray="1.5 2"/></svg>';

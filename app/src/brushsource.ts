// サブツールの欄のペンと消しゴム: the pens (or erasers) to pick, each with a
// line drawn the way it draws, and ツールプロパティ for the one in hand:
// its size (a slider, a box and the round buttons of ブラシサイズ), its
// opacity and 手ブレ補正, how an eraser erases, and the way to all its
// settings.
import { addBrushes } from "./brush";
import { brushPicks, brushRef, clampSize, reorderBrushes, sizeLabel, sizeOfSlider, sliderOf, SLIDER_STEPS, withoutPreset, withPreset, type BrushPick } from "./brushpicks";
import { applyCspSettings, ensureCspSettings, setSetting } from "./cspsettings";
import { element } from "./dom";
import { ERASE_MODE_LABELS, type EditorEraseMode, type PageEditor } from "./editor";
import type { Brush, BrushKind, Project, Stroke, StrokePoint } from "./model";
import { drawStroke, INK, loadTips } from "./pagedraw";
import { loadLibrary, loadSizePresets, saveSizePresets, saveToLibrary } from "./prefs";
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
  /** ペン・消しゴムの設定 (every setting), on the one in hand. */
  openEditor(kind: BrushKind): void;
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
  const shape = tip && { enabled: tip.enabled, interval: tip.interval, size: [tip.width, tip.height], picture: tip.pngBase64.length + tip.pngBase64.slice(-24) };
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
        detail: size === null || (this.kind === "eraser" && !pick.brush) ? "" : sizeLabel(size),
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

  footer(box: HTMLElement): void {
    const settings = element("button", { type: "button", textContent: "設定…", title: "ペン・消しゴムの設定: 新しく作る・複製・CSP のサブツール詳細の項目すべて・.sut に書き出して CSP へ" });
    settings.addEventListener("click", () => this.host.openEditor(this.kind));
    const take = element("button", { type: "button", textContent: "取り込み…", title: "CLIP STUDIO PAINT のペン・消しゴムを取り込む" });
    take.addEventListener("click", () => this.host.importBrushes());
    box.append(settings, take);
  }

  // --- ツールプロパティ --------------------------------------------------------------

  properties(box: HTMLElement): void {
    const brush = this.inHand();
    const kind = this.kind;
    box.append(element("div", { className: "subtool-props-title", textContent: brush?.name ?? PLAIN[kind] }));
    const plainEraser = kind === "eraser" && !brush;
    box.append(this.sizeRow(plainEraser));
    if (!plainEraser) box.append(this.presetRow());
    if (brush) {
      box.append(
        this.percentRow("不透明度", Math.round(brush.opacity * 100), 1, 100, (value) => this.setCsp(brush, "Opacity", value, `不透明度 ${value}%`)),
        this.percentRow("手ブレ補正", Math.round(brush.stabilization), 0, 100, (value) => this.setCsp(brush, "FlickerReduction", value, `手ブレ補正 ${value}`)),
      );
    } else {
      box.append(element("p", { className: "subtool-note", textContent: kind === "pen" ? "標準のペンは太さだけ変えられます。ほかの項目は「設定…」で作ったペンか、取り込んだペンで。" : "標準の消しゴムは画面の上で決まった大きさです。" }));
    }
    if (kind === "eraser") box.append(this.eraseRow());
    if (brush?.tip) {
      const check = element("input", { type: "checkbox", checked: brush.tip.enabled });
      check.addEventListener("change", () => {
        const id = brush.id;
        this.host.edit((project) => {
          const tip = project.brushes.find((b) => b.id === id)?.tip;
          if (tip) tip.enabled = check.checked;
        });
      });
      box.append(element("label", { className: "subtool-check", title: "CSP の素材のサムネイルから作った先端の形で描く" }, check, " 先端の形で描く"));
    }
  }

  private sizeRow(disabled: boolean): HTMLElement {
    const kind = this.kind;
    const mm = this.sizeInHand();
    const range = element("input", { type: "range", min: "0", max: String(SLIDER_STEPS), step: "1", value: String(sliderOf(kind, mm)), disabled });
    range.setAttribute("aria-label", "ブラシサイズ");
    const number = element("input", { type: "number", min: "0.05", max: "50", step: "0.05", value: disabled ? "" : String(mm), disabled });
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
    return element("label", { className: "subtool-field", title: "ブラシサイズ（mm）。] / [ でも変えられます" }, element("span", { textContent: "ブラシサイズ" }), range, number, element("span", { className: "unit", textContent: "mm" }));
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
      const button = element("button", { type: "button", className: mm === now ? "active" : "", title: `${sizeLabel(mm)} mm（右クリックで候補から外す）` }, dot, element("span", { textContent: sizeLabel(mm) }));
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
    const add = element("button", { type: "button", className: "add", textContent: "＋", title: "今の太さを候補に足す（右クリックで候補を初めの並びに戻す）" });
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
      const button = element("button", { type: "button", textContent: ERASE_MODE_LABELS[mode], className: this.host.editor.eraseMode === mode ? "active" : "" });
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
    return JSON.stringify([rows, own, this.current(), this.sizeInHand(), this.host.editor.eraseMode, brush?.id, loadSizePresets()[this.kind]]);
  }
}

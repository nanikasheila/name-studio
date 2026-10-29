// ペン・消しゴムの設定: every setting of CSP's サブツール詳細 palette, edited
// on the brush's own CSP rows (Brush.csp, see cspsettings.ts), tried on a
// pad that redraws as they change, and written back to CSP as a .sut that
// サブツールの読み込み takes in.
import { save } from "@tauri-apps/plugin-dialog";
import { call, type CspToolLocations } from "./backend";
import { DEFAULT_BRUSH_DPI } from "./brush";
import { BrushPad, GraphBox } from "./brushpad";
import {
  applyCspSettings,
  blobOf,
  bytesOf,
  defaultInOutTargets,
  IN_OUT_ITEMS,
  inOutTargetsBytes,
  parseInOutTargets,
  type InOutTarget,
  cspSettingsFor,
  effectorBytes,
  effectorOf,
  ensureCspSettings,
  INPUTS,
  materialNames,
  newBrush,
  newEffector,
  setSetting,
  type Effector,
  type Graph,
} from "./cspsettings";
import { $, element } from "./dom";
import { CSP_COLUMNS, type CspColumn } from "./generated/csp-columns";
import type { Brush, BrushKind, CspToolData, CspValue, Project } from "./model";
import { saveToLibrary } from "./prefs";
import { newId } from "./project";

export interface BrushEditorHost {
  project(): Project | null;
  /** Run `change` as one undoable step. */
  edit(change: (project: Project) => void): void;
  /** The brush of `kind` in hand (none: the plain one). */
  inHand(kind: BrushKind): Brush | null;
  /** A brush was set anew (or made, or `null`: taken away); the one in hand takes it up. */
  changed(brush: Brush | null, kind: BrushKind): void;
  /** Open the dialog that takes brushes over from CSP. */
  importFromCsp(): void;
}

/** The palette's groups for pens and erasers, in CSP's order; the others show when asked for (or set). */
const PEN_GROUPS = [
  "ブラシサイズ",
  "不透明度",
  "インク",
  "アンチエイリアス",
  "ブラシ先端",
  "ストローク",
  "紙質",
  "散布効果",
  "入り抜き",
  "水彩",
  "水彩境界",
  "補正",
  "消去",
  "色の変化",
  "線",
  "ベクター線",
  "2-ブラシ形状",
  "ブラシサイズ（デュアルブラシ）",
  "インク（デュアルブラシ）",
  "アンチエイリアス（デュアルブラシ）",
  "ブラシ先端（デュアルブラシ）",
  "ストローク（デュアルブラシ）",
  "紙質（デュアルブラシ）",
  "散布効果（デュアルブラシ）",
];
/** Groups open at first. */
const OPEN_GROUPS = new Set(["ブラシサイズ", "不透明度", "インク", "入り抜き", "補正", "消去"]);
/** Items that come first in their group (the rest follow by name). */
const FIRST = [
  "BrushSize",
  "BrushSizeUnit",
  "Opacity",
  "AntiAlias",
  "BrushFlow",
  "CompositeMode",
  "BrushUsePatternImage",
  "BrushHardness",
  "BrushInterval",
  "BrushAutoIntervalType",
  "BrushThickness",
  "BrushRotation",
  "BrushInOutType",
  "BrushUseIn",
  "BrushInLength",
  "BrushInRatio",
  "BrushUseOut",
  "BrushOutLength",
  "BrushOutRatio",
  "FlickerReduction",
  "FlickerReductionBySpeed",
  "BrushUseRevision",
  "BrushRevision",
  "BrushUseVectorMagnet",
  "BrushVectorMagnetPower",
  "BrushUseVectorEraser",
  "BrushVectorEraserType",
];
/** Columns kept as they are and not shown (the palette's own layout). */
const HIDDEN = new Set(["VariantShowParam", "VariantShowSeparator"]);

const COLUMNS = new Map(CSP_COLUMNS.map((column) => [column.column, column]));

/** The value column an `…Unit` or `…Effector` column goes with, shown on its row. */
function partnerOf(column: string): string | null {
  if (column === "BrushOpacityEffector") return "Opacity";
  for (const suffix of ["Unit", "Effector"]) {
    if (column.endsWith(suffix) && COLUMNS.has(column.slice(0, -suffix.length))) return column.slice(0, -suffix.length);
  }
  return null;
}

function rank(column: string): number {
  const index = FIRST.indexOf(column);
  return index < 0 ? FIRST.length : index;
}

/** A plain button that does not send the dialog's form. */
function button(label: string, action: () => void, title = ""): HTMLButtonElement {
  const node = element("button", { type: "button", textContent: label, title });
  node.addEventListener("click", action);
  return node;
}

function uniqueName(project: Project, kind: BrushKind, name: string): string {
  const taken = new Set(project.brushes.filter((b) => b.kind === kind).map((b) => b.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
}

export class BrushEditor {
  private kind: BrushKind = "pen";
  private selected: string | null = null;
  private filter = "";
  private everything = false;
  private readonly open = new Set(OPEN_GROUPS);
  private readonly pad: BrushPad;
  private locations: CspToolLocations | null = null;

  constructor(private readonly host: BrushEditorHost) {
    this.pad = new BrushPad($<HTMLCanvasElement>("be-pad"));
    $("be-pad-clear").addEventListener("click", () => this.pad.clear());
    for (const kind of ["pen", "eraser"] as const) $(`be-kind-${kind}`).addEventListener("click", () => this.showKind(kind));
    $("be-new").addEventListener("click", () => this.create());
    $("be-duplicate").addEventListener("click", () => this.duplicate());
    $("be-delete").addEventListener("click", () => void this.remove());
    $("be-export").addEventListener("click", () => void this.exportSut());
    $("be-import").addEventListener("click", () => this.host.importFromCsp());
    $<HTMLInputElement>("be-filter").addEventListener("input", (event) => {
      this.filter = (event.target as HTMLInputElement).value.trim();
      this.renderSettings();
    });
    $<HTMLInputElement>("be-everything").addEventListener("change", (event) => {
      this.everything = (event.target as HTMLInputElement).checked;
      this.renderSettings();
    });
    $<HTMLInputElement>("be-name").addEventListener("change", (event) => {
      const name = (event.target as HTMLInputElement).value.trim();
      if (name) this.change((brush) => (brush.name = name));
      else this.render();
    });
  }

  /** Open on the brush in hand (or the first of its kind). */
  openFor(kind: BrushKind): void {
    const project = this.host.project();
    if (!project) return;
    this.kind = kind;
    this.selected = this.host.inHand(kind)?.id ?? project.brushes.find((b) => b.kind === kind)?.id ?? null;
    this.message("");
    $<HTMLDialogElement>("brush-editor").showModal();
    this.render();
  }

  /** After the name changed under it (undo, another dialog): show it as it is now. */
  refresh(): void {
    if ($<HTMLDialogElement>("brush-editor").open) this.render();
  }

  private brush(): Brush | null {
    const project = this.host.project();
    return project?.brushes.find((b) => b.id === this.selected && b.kind === this.kind) ?? null;
  }

  private showKind(kind: BrushKind): void {
    this.kind = kind;
    const project = this.host.project();
    this.selected = this.host.inHand(kind)?.id ?? project?.brushes.find((b) => b.kind === kind)?.id ?? null;
    this.render();
  }

  // --- changes ----------------------------------------------------------------------------

  /** Change the brush as one undoable step; its drawing values follow its CSP settings. */
  private change(apply: (brush: Brush) => void): void {
    const id = this.selected;
    let changed: Brush | null = null;
    this.host.edit((project) => {
      const brush = project.brushes.find((b) => b.id === id);
      if (!brush) return;
      ensureCspSettings(brush);
      apply(brush);
      applyCspSettings(brush);
      changed = brush;
    });
    if (changed) {
      saveToLibrary([changed]);
      this.host.changed(changed, this.kind);
    }
    this.render();
  }

  /** Change a CSP setting (undefined: back to CSP's own initial value). */
  private set(column: string, value: CspValue | Uint8Array | undefined): void {
    this.change((brush) => setSetting(brush.csp!, column, value));
  }

  /** Show a change on the pad (and the summary) while it is being made. */
  private preview(apply: (tool: CspToolData) => void): void {
    const brush = this.brush();
    if (!brush) return;
    const draft = structuredClone(brush);
    ensureCspSettings(draft);
    apply(draft.csp!);
    applyCspSettings(draft);
    this.pad.show(draft);
  }

  private create(): void {
    const kind = this.kind;
    let made: Brush | null = null;
    this.host.edit((project) => {
      const brush = newBrush(kind, newId(project, "brush"), uniqueName(project, kind, kind === "pen" ? "新しいペン" : "新しい消しゴム"));
      project.brushes.push(brush);
      made = brush;
    });
    if (!made) return;
    this.selected = (made as Brush).id;
    this.host.changed(made, kind);
    this.render();
    $<HTMLInputElement>("be-name").select();
  }

  private duplicate(): void {
    const source = this.brush();
    if (!source) return;
    let made: Brush | null = null;
    this.host.edit((project) => {
      const copy = structuredClone(source);
      copy.id = newId(project, "brush");
      copy.name = uniqueName(project, copy.kind, `${source.name} のコピー`);
      ensureCspSettings(copy);
      project.brushes.push(copy);
      made = copy;
    });
    if (!made) return;
    this.selected = (made as Brush).id;
    saveToLibrary([made]);
    this.host.changed(made, this.kind);
    this.render();
  }

  private async remove(): Promise<void> {
    const brush = this.brush();
    const project = this.host.project();
    if (!brush || !project) return;
    const lines = project.pages.reduce((sum, page) => sum + page.strokes.filter((stroke) => stroke.brush === brush.id).length, 0);
    if (lines) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const sure = await ask(`「${brush.name}」で描いた線が ${lines} 本あります。削除すると、その線は標準の${brush.kind === "pen" ? "ペン" : "消しゴム"}で描いた形になります。削除しますか？`, {
        title: "Name Studio",
        kind: "warning",
        okLabel: "削除する",
        cancelLabel: "やめる",
      });
      if (!sure) return;
    }
    const id = brush.id;
    const wasInHand = this.host.inHand(this.kind)?.id === id;
    this.host.edit((p) => {
      p.brushes = p.brushes.filter((b) => b.id !== id);
    });
    if (wasInHand) this.host.changed(null, this.kind);
    this.selected = this.host.project()?.brushes.find((b) => b.kind === this.kind)?.id ?? null;
    this.message(`「${brush.name}」を削除しました（元に戻すで戻せます）。`);
    this.render();
  }

  // --- .sut -------------------------------------------------------------------------------

  private async exportSut(): Promise<void> {
    const brush = this.brush();
    if (!brush) return;
    const tool = brush.csp ?? cspSettingsFor(brush);
    const name = brush.name.replace(/[\\/:*?"<>|]/g, "_");
    const path = await save({ defaultPath: `${name}.sut`, filters: [{ name: "CSP のサブツール", extensions: ["sut"] }] });
    if (!path) return;
    this.locations ??= await call("csp_tool_locations").catch(() => ({ tools: null, materials: null }));
    this.message("書き出し中…");
    try {
      const written = await call("write_csp_sub_tool", { path, tool, name: brush.name, materials: this.locations.materials });
      const missing = written.missingMaterials.length
        ? `\n素材が見つからず入れられなかったもの: ${written.missingMaterials.join("、")}（CSP に同じ素材があればそのまま使えます）`
        : "";
      this.message(`書き出しました: ${path}\nCSP のサブツールパレットのメニュー「サブツールの読み込み」で読み込めます。${missing}`);
    } catch (error) {
      this.message(`書き出せませんでした: ${error}`, true);
    }
  }

  // --- what is shown ----------------------------------------------------------------------

  private render(): void {
    const project = this.host.project();
    if (!project) return;
    for (const kind of ["pen", "eraser"] as const) $(`be-kind-${kind}`).classList.toggle("active", this.kind === kind);
    const list = $("be-list");
    list.replaceChildren();
    const brushes = project.brushes.filter((b) => b.kind === this.kind);
    if (!brushes.some((b) => b.id === this.selected)) this.selected = brushes[0]?.id ?? null;
    const inHand = this.host.inHand(this.kind)?.id;
    for (const brush of brushes) {
      const row = element("button", { type: "button", className: `be-item${brush.id === this.selected ? " selected" : ""}`, title: brush.source ?? "" });
      row.append(element("span", { textContent: brush.name }));
      if (brush.id === inHand) row.append(element("span", { className: "badge", textContent: "使用中" }));
      row.addEventListener("click", () => {
        this.selected = brush.id;
        this.host.changed(brush, this.kind);
        this.render();
      });
      list.append(row);
    }
    if (!brushes.length) {
      list.append(element("p", { className: "hint", textContent: `${this.kind === "pen" ? "ペン" : "消しゴム"}はまだありません。「新規」で作るか、CSP から取り込みます。` }));
    }
    const brush = this.brush();
    for (const id of ["be-duplicate", "be-delete", "be-export"]) $<HTMLButtonElement>(id).disabled = !brush;
    $("be-main").classList.toggle("none", !brush);
    const name = $<HTMLInputElement>("be-name");
    name.value = brush?.name ?? "";
    name.disabled = !brush;
    $("be-source").textContent = brush ? (brush.csp ? (brush.source ?? "") : `${brush.source ?? ""}（CSP の設定は、この道具の値から作りました）`) : "";
    this.pad.show(brush);
    this.renderSettings();
  }

  private renderSettings(): void {
    const box = $("be-settings");
    box.replaceChildren();
    const brush = this.brush();
    if (!brush) return;
    // A brush with no CSP settings is shown with those made from its values.
    const tool = brush.csp ?? cspSettingsFor(brush);
    const words = this.filter.toLowerCase();
    const matches = (column: CspColumn) =>
      !words || [column.label, column.group, column.column, column.values].some((text) => text.toLowerCase().includes(words));
    const groups = new Map<string, CspColumn[]>();
    const known = [...COLUMNS.values()];
    // Settings the table does not know (a newer CSP) are kept and shown as they are.
    for (const column of Object.keys(tool.settings)) {
      if (!COLUMNS.has(column) && !HIDDEN.has(column)) {
        known.push({ column, group: "その他", label: column, values: "", sure: false, edit: { kind: "fixed" } });
      }
    }
    for (const column of known) {
      const partner = partnerOf(column.column);
      // Shown on the row of the value it goes with.
      if (partner && COLUMNS.get(partner)?.group === column.group) continue;
      const group = column.group;
      const isPenGroup = PEN_GROUPS.includes(group) || group === "その他";
      const used = tool.settings[column.column] !== undefined;
      if (!this.everything && !isPenGroup && !used) continue;
      const rowMatches = matches(column) || [`${column.column}Unit`, `${column.column}Effector`].some((c) => COLUMNS.has(c) && matches(COLUMNS.get(c)!));
      if (!rowMatches) continue;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(column);
    }
    const order = (group: string) => {
      const index = PEN_GROUPS.indexOf(group);
      return index < 0 ? PEN_GROUPS.length : index;
    };
    const sorted = [...groups.entries()].sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b, "ja"));
    for (const [group, columns] of sorted) {
      columns.sort((a, b) => rank(a.column) - rank(b.column) || a.column.localeCompare(b.column));
      const details = element("details", { className: "be-group" });
      details.open = !!words || this.open.has(group);
      details.addEventListener("toggle", () => {
        if (words) return;
        if (details.open) this.open.add(group);
        else this.open.delete(group);
      });
      const set = columns.filter((c) => tool.settings[c.column] !== undefined).length;
      details.append(element("summary", {}, group, element("small", { textContent: ` ${set}/${columns.length}` })));
      for (const column of columns) details.append(this.row(tool, column));
      box.append(details);
    }
    if (!sorted.length) box.append(element("p", { className: "hint", textContent: "見つかりませんでした。" }));
  }

  /** One setting: its label, its value, and the unit and 影響元設定 that go with it. */
  private row(tool: CspToolData, column: CspColumn): HTMLElement {
    const row = element("div", { className: "be-row" });
    const value = tool.settings[column.column];
    const label = element("span", { className: "be-label", textContent: column.label, title: [column.column, column.values, column.sure ? "" : "（意味は推測）"].filter(Boolean).join("\n") });
    if (!column.sure) label.classList.add("unsure");
    const field = element("span", { className: "be-field" });
    // An 影響元設定 of its own is edited under the row.
    if (column.edit.kind !== "effector") field.append(this.input(column, value));
    const unit = COLUMNS.get(`${column.column}Unit`);
    if (unit?.edit.kind === "choice") {
      field.append(this.input(unit, tool.settings[unit.column]));
      // CSP keeps lengths in pixels: the mm they are on the page.
      if (typeof value === "number") {
        const dpi = tool.dpi || DEFAULT_BRUSH_DPI;
        const mm = (value * (tool.settings[unit.column] === 2 ? 10 : 1) * 25.4) / dpi;
        field.append(element("small", { className: "be-mm", textContent: `= ${mm >= 10 ? mm.toFixed(1) : mm.toFixed(2)} mm`, title: `${dpi} dpi の原稿で` }));
      }
    }
    if (value !== undefined && column.edit.kind !== "fixed" && column.edit.kind !== "materials") {
      field.append(button("×", () => this.set(column.column, undefined), "CSP の初期値に戻す（この項目を書かない）"));
    }
    row.append(label, field);
    const effector = column.column === "Opacity" ? "BrushOpacityEffector" : `${column.column}Effector`;
    if (column.edit.kind === "effector") row.append(this.effector(tool, column.column));
    else if (COLUMNS.get(effector)?.edit.kind === "effector") row.append(this.effector(tool, effector));
    return row;
  }

  private input(column: CspColumn, value: CspValue | undefined): HTMLElement {
    const edit = column.edit;
    const name = column.column;
    switch (edit.kind) {
      case "check": {
        const box = element("input", { type: "checkbox", checked: typeof value === "number" && value !== 0 });
        box.addEventListener("change", () => this.set(name, box.checked ? 1 : 0));
        return box;
      }
      case "choice": {
        const select = element("select");
        if (typeof value !== "number") select.append(element("option", { value: "", textContent: "（CSP の初期値）" }));
        for (const [option, label] of edit.options) select.append(element("option", { value: String(option), textContent: label }));
        if (typeof value === "number" && !edit.options.some(([option]) => option === value)) {
          select.append(element("option", { value: String(value), textContent: String(value) }));
        }
        select.value = typeof value === "number" ? String(value) : "";
        select.addEventListener("change", () => this.set(name, select.value === "" ? undefined : Number(select.value)));
        return select;
      }
      case "number": {
        const input = element("input", { type: "number", value: typeof value === "number" ? String(Math.round(value * 1000) / 1000) : "", placeholder: "初期値" });
        if (edit.min !== undefined) input.min = String(edit.min);
        if (edit.max !== undefined) input.max = String(edit.max);
        input.step = edit.integer ? "1" : "any";
        const read = (): number | null => {
          if (input.value === "") return null;
          let number = Number(input.value);
          if (!Number.isFinite(number)) return null;
          if (edit.integer) number = Math.round(number);
          if (edit.min !== undefined) number = Math.max(edit.min, number);
          if (edit.max !== undefined) number = Math.min(edit.max, number);
          return number;
        };
        input.addEventListener("input", () => {
          const number = read();
          if (number !== null) this.preview((tool) => setSetting(tool, name, number));
        });
        input.addEventListener("change", () => this.set(name, read() ?? undefined));
        const wrap = element("span", { className: "be-number" }, input);
        if (edit.unit) wrap.append(element("small", { textContent: edit.unit }));
        return wrap;
      }
      case "text": {
        const input = element("input", { type: "text", value: typeof value === "string" ? value : "" });
        input.addEventListener("change", () => this.set(name, input.value || undefined));
        return input;
      }
      case "materials": {
        const blob = value && typeof value === "object" ? value.blob : null;
        const names = blob ? materialNames(bytesOf(blob)) : [];
        return element("span", { className: "be-fixed", textContent: names.length ? names.join("、") : "なし", title: "素材は CSP で選び直してください（.sut には素材も入れて書き出します）" });
      }
      default:
        if (name === "BrushInOutTarget") return this.inOutTargets(value);
        return element("span", { className: "be-fixed", textContent: value === undefined ? "（なし）" : typeof value === "object" ? `${Math.round((value.blob.length * 3) / 4)} バイト` : String(value), title: "CSP の値のまま書き出します" });
    }
  }

  /** 入り抜きの影響先: which settings 入り抜き changes, each down to its least value. */
  private inOutTargets(value: CspValue | undefined): HTMLElement {
    const blob = value && typeof value === "object" ? bytesOf(value.blob) : null;
    const stored = blob ? parseInOutTargets(blob) : null;
    if (blob && !stored) return element("span", { className: "be-fixed", textContent: "（読めない形式なので、そのまま書き出します）" });
    const targets = stored ?? defaultInOutTargets();
    const box = element("span", { className: "be-targets" });
    const commit = (change: (targets: InOutTarget[]) => void) => {
      const next = targets.map((t) => ({ ...t }));
      change(next);
      this.set("BrushInOutTarget", inOutTargetsBytes(next));
    };
    targets.forEach((target, index) => {
      const label = IN_OUT_ITEMS[target.item];
      // Items CSP's list does not show are kept as they are.
      if (!label) return;
      const on = element("input", { type: "checkbox", checked: target.on });
      on.addEventListener("change", () => commit((next) => (next[index].on = on.checked)));
      const item = element("label", { className: "check" }, on, ` ${label}`);
      if (target.on) {
        const min = element("input", { type: "number", min: "0", max: "100", step: "1", value: String(target.min), title: "入り抜きの端での値（%）" });
        min.addEventListener("change", () => commit((next) => (next[index].min = Math.min(100, Math.max(0, Math.round(Number(min.value) || 0))))));
        item.append(element("span", { className: "be-number" }, element("small", { textContent: "最小値" }), min, element("small", { textContent: "%" })));
      }
      box.append(item);
    });
    return box;
  }

  /** 影響元設定: which inputs change the value, their least value and their graphs. */
  private effector(tool: CspToolData, column: string): HTMLElement {
    const box = element("div", { className: "be-effector" });
    const stored = blobOf(tool, column);
    const effector = effectorOf(tool, column);
    if (stored && !effector) {
      box.append(element("small", { className: "hint", textContent: "影響元設定（このツールの形式は読めないので、そのまま書き出します）" }));
      return box;
    }
    const current: Effector = effector ?? newEffector();
    const offered = current.offered || 0xf0;
    const inputs = element("span", { className: "be-inputs" }, element("small", { textContent: "影響元" }));
    const commit = (change: (effector: Effector) => void) => {
      this.change((brush) => {
        const next = effectorOf(brush.csp!, column) ?? newEffector();
        change(next);
        setSetting(brush.csp!, column, effectorBytes(next));
      });
    };
    const live = (change: (effector: Effector) => void) => {
      this.preview((draft) => {
        const next = effectorOf(draft, column) ?? newEffector();
        change(next);
        setSetting(draft, column, effectorBytes(next));
      });
    };
    INPUTS.forEach(({ bit, label }) => {
      if (!(offered & bit)) return;
      const on = !!(current.inputs & bit);
      const toggle = button(label, () => commit((next) => (next.inputs = on ? next.inputs & ~bit : next.inputs | bit)), `${label}で変える`);
      toggle.classList.toggle("active", on);
      inputs.append(toggle);
    });
    box.append(inputs);
    const graphs = element("div", { className: "be-graphs" });
    INPUTS.forEach(({ bit, label }, index) => {
      if (!(current.inputs & bit)) return;
      const cell = element("div", { className: "be-graph-cell" });
      const minimum = element("input", { type: "number", min: "0", max: "100", step: "1", value: String(current.minimum[index]) });
      const readMinimum = () => Math.min(100, Math.max(0, Math.round(Number(minimum.value) || 0)));
      minimum.addEventListener("input", () => live((next) => (next.minimum[index] = readMinimum())));
      minimum.addEventListener("change", () => commit((next) => (next.minimum[index] = readMinimum())));
      cell.append(element("small", { textContent: `${label} 最小値` }), element("span", { className: "be-number" }, minimum, element("small", { textContent: "%" })));
      const key = (["pressure", "tilt", "speed"] as const)[index];
      if (key) {
        const fallback: Graph = key === "speed" ? [[0, 1], [1, 0]] : [[0, 0], [1, 1]];
        const graph = new GraphBox(
          current[key] ?? fallback,
          (points) => live((next) => (next[key] = points)),
          (points) => commit((next) => (next[key] = points)),
        );
        cell.append(graph.canvas);
      }
      graphs.append(cell);
    });
    if (graphs.childElementCount) box.append(graphs);
    return box;
  }

  private message(text: string, error = false): void {
    const node = $("be-message");
    node.textContent = text;
    node.classList.toggle("error", error);
  }
}

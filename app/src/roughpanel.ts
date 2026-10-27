// The ラフ線のレイヤー list at the top of the レイヤー palette: the layer the pen
// draws on (the row picked), and for each layer its eye, lock and opacity, as
// CSP's layer palette. The top of the list is the top layer. Above them the
// 指示のレイヤー, each in its colour: the row picked is what the 指示 tool
// draws on.
import type { PageEditor, Tool } from "./editor";
import type { Project, RoughLayer } from "./model";
import { layerOf, layerStrokeCount, markColor, markLayersOf, MARK_COLORS, MARK_COLOR_NAMES, opacityOfLayer, roughLayersOf } from "./roughlayers";
import { markPen } from "./toolmark";

export type RoughChange =
  | { kind: "add" }
  /** A 指示のレイヤー in the next colour. */
  | { kind: "addMarks" }
  /** Every 指示のレイヤー shown or hidden. */
  | { kind: "showMarks"; shown: boolean }
  | { kind: "rename"; id: string; name: string }
  | { kind: "look"; id: string; change: Partial<Pick<RoughLayer, "hidden" | "opacity" | "locked" | "color">> }
  | { kind: "move"; id: string; step: 1 | -1 }
  | { kind: "remove"; id: string; mergeDown: boolean }
  /** The lines selected on the page onto this layer. */
  | { kind: "takeSelected"; id: string };

export interface RoughPanelHost {
  project(): Project | null;
  editor(): PageEditor;
  status(message: string): void;
  /** A layer was picked: the tool that draws on it taken up (when it changes), the list shown again. */
  picked(tool: Tool | null): void;
  change(change: RoughChange): void;
  /** How many lines are selected on the page (to move onto a layer). */
  selectedStrokes(): number;
}

export class RoughPanel {
  constructor(private readonly host: RoughPanelHost) {}

  render(container: HTMLElement): void {
    const project = this.host.project();
    if (!project) {
      container.replaceChildren();
      return;
    }
    const layers = roughLayersOf(project);
    const active = layerOf(project, { layer: this.host.editor().roughLayer }).id;
    const marks = markLayersOf(project);
    const activeMark = (marks.find((layer) => layer.id === markPen.layer) ?? marks[marks.length - 1])?.id;
    const markHead = element("div", "rough-head");
    markHead.append(element("span", "layer-page", "指示のレイヤー"));
    const addMarks = button("＋", marks.length ? "別の色の指示のレイヤーを足す" : "指示のレイヤーを作る（指示ツール R で描いても作られます）", () => this.host.change({ kind: "addMarks" }));
    addMarks.id = "marks-add";
    markHead.append(addMarks);
    const markRows = [...marks].reverse().map((layer, fromTop) => this.row(project, layer, layer.id === activeMark, fromTop, marks.length));
    const head = element("div", "rough-head");
    head.append(element("span", "layer-page", "ラフ線のレイヤー"));
    const add = button("＋", "レイヤーを足す（いま選んでいるレイヤーの上に）", () => this.host.change({ kind: "add" }));
    add.id = "rough-add";
    head.append(add);
    const rows = [...layers].reverse().map((layer, fromTop) => this.row(project, layer, layer.id === active, fromTop, layers.length));
    const picked = this.host.selectedStrokes();
    const tools = element("div", "rough-tools");
    if (picked) {
      const take = button(`選んだラフ線 ${picked} 本をこのレイヤーへ`, "ページで選んでいるラフ線を、選んでいるレイヤーへ移す", () =>
        this.host.change({ kind: "takeSelected", id: active }),
      );
      take.id = "rough-take";
      tools.append(take);
    }
    container.replaceChildren(markHead, ...markRows, head, ...rows, tools);
  }

  /** A row picked: the pen draws on a ラフ線のレイヤー, the 指示 tool on a 指示のレイヤー. */
  private pick(layer: RoughLayer): void {
    const editor = this.host.editor();
    if (layer.marks) markPen.layer = layer.id;
    else editor.roughLayer = layer.id;
    this.host.status(layer.marks ? `指示ツールでレイヤー「${layer.name}」に描きます` : `ペンでレイヤー「${layer.name}」に描きます`);
    const tool = layer.marks ? (editor.tool === "mark" ? null : "mark") : editor.tool === "mark" ? "pen" : null;
    this.host.picked(tool);
  }

  private row(project: Project, layer: RoughLayer, active: boolean, fromTop: number, count: number): HTMLElement {
    const row = element("div", `rough-row${active ? " selected" : ""}${layer.hidden ? " hidden-layer" : ""}`);
    row.dataset.rough = layer.id;
    row.title = layer.marks ? "押すと、指示ツールでこのレイヤーに描きます" : "押すと、ペンでこのレイヤーに描きます";
    row.addEventListener("click", () => this.pick(layer));
    const look = (change: RoughChange & { kind: "look" }) => (event: Event) => {
      event.stopPropagation();
      this.host.change(change);
    };
    const eye = button(
      layer.hidden ? "－" : "👁",
      layer.hidden ? "画面に出す" : "画面から隠す（CSP へは隠したレイヤーで書き出します）",
      look({ kind: "look", id: layer.id, change: { hidden: !layer.hidden } }),
    );
    eye.className = "layer-eye";
    const lock = button(
      layer.locked ? "🔒" : "🔓",
      layer.locked ? "ロックを外す" : "ロックする（描く・消す・選ぶができなくなります）",
      look({ kind: "look", id: layer.id, change: { locked: !layer.locked } }),
    );
    lock.className = `layer-eye rough-lock${layer.locked ? " on" : ""}`;
    // A 指示のレイヤー's colour: pressed, the next one.
    const swatches: HTMLElement[] = [];
    if (layer.marks) {
      const color = markColor(layer);
      const named = (c: string) => MARK_COLOR_NAMES[c as (typeof MARK_COLORS)[number]] ?? c;
      const next = MARK_COLORS[(MARK_COLORS.indexOf(color as (typeof MARK_COLORS)[number]) + 1) % MARK_COLORS.length];
      const swatch = button("", `色: ${named(color)}（押すと${named(next)}に）`, look({ kind: "look", id: layer.id, change: { color: next } }));
      swatch.className = "mark-swatch";
      swatch.style.background = color;
      swatch.setAttribute("aria-label", `${layer.name}の色: ${named(color)}`);
      row.dataset.color = color;
      swatches.push(swatch);
    }
    const name = element("span", "layer-name", layer.name);
    name.title = "ダブルクリックで名前を変える";
    name.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.rename(name, layer);
    });
    const lines = element("span", "layer-detail", `${layerStrokeCount(project, layer.id)} 本`);
    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "10";
    opacity.max = "100";
    opacity.step = "5";
    opacity.value = String(Math.round(opacityOfLayer(layer) * 100));
    opacity.className = "rough-opacity";
    opacity.title = `不透明度 ${opacity.value}%`;
    opacity.setAttribute("aria-label", `${layer.name}の不透明度`);
    opacity.addEventListener("click", (event) => event.stopPropagation());
    opacity.addEventListener("change", () => this.host.change({ kind: "look", id: layer.id, change: { opacity: Number(opacity.value) / 100 } }));
    const menu = element("span", "rough-menu");
    const up = button("↑", "上へ", (event) => {
      event.stopPropagation();
      this.host.change({ kind: "move", id: layer.id, step: 1 });
    });
    up.disabled = fromTop === 0;
    const down = button("↓", "下へ", (event) => {
      event.stopPropagation();
      this.host.change({ kind: "move", id: layer.id, step: -1 });
    });
    down.disabled = fromTop === count - 1;
    const merge = button("⤓", "下のレイヤーと結合（線を下のレイヤーへ移して、このレイヤーを消す）", (event) => {
      event.stopPropagation();
      this.host.change({ kind: "remove", id: layer.id, mergeDown: true });
    });
    merge.disabled = fromTop === count - 1;
    const remove = button("×", "レイヤーを線ごと消す（元に戻せます）", (event) => {
      event.stopPropagation();
      this.host.change({ kind: "remove", id: layer.id, mergeDown: false });
    });
    remove.disabled = count < 2 && !layer.marks;
    menu.append(up, down, merge, remove);
    row.append(eye, lock, ...swatches, name, lines, opacity, menu);
    return row;
  }

  private rename(name: HTMLElement, layer: RoughLayer): void {
    const input = document.createElement("input");
    input.type = "text";
    input.value = layer.name;
    input.className = "rough-rename";
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      if (keep && text && text !== layer.name) this.host.change({ kind: "rename", id: layer.id, name: text });
      else input.replaceWith(name);
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("blur", () => finish(true));
    name.replaceWith(input);
    input.focus();
    input.select();
  }
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, title: string, click: (event: MouseEvent) => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  node.title = title;
  node.addEventListener("click", click);
  node.addEventListener("pointerdown", (event) => event.stopPropagation());
  return node;
}

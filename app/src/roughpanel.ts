// The ラフ線のレイヤー list at the top of the レイヤー palette: the layer the pen
// draws on (the row picked), and for each layer its eye, lock and opacity, as
// CSP's layer palette. The top of the list is the top layer.
import type { Project, RoughLayer } from "./model";
import { layerStrokeCount, opacityOfLayer, roughLayersOf } from "./roughlayers";

export type RoughChange =
  | { kind: "add" }
  | { kind: "rename"; id: string; name: string }
  | { kind: "look"; id: string; change: Partial<Pick<RoughLayer, "hidden" | "opacity" | "locked">> }
  | { kind: "move"; id: string; step: 1 | -1 }
  | { kind: "remove"; id: string; mergeDown: boolean }
  /** The lines selected on the page onto this layer. */
  | { kind: "takeSelected"; id: string };

export interface RoughPanelHost {
  project(): Project | null;
  /** The layer the pen draws on. */
  active(): string;
  setActive(id: string): void;
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
    const active = this.host.active();
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
    container.replaceChildren(head, ...rows, tools);
  }

  private row(project: Project, layer: RoughLayer, active: boolean, fromTop: number, count: number): HTMLElement {
    const row = element("div", `rough-row${active ? " selected" : ""}${layer.hidden ? " hidden-layer" : ""}`);
    row.dataset.rough = layer.id;
    row.title = "押すと、ペンでこのレイヤーに描きます";
    row.addEventListener("click", () => this.host.setActive(layer.id));
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
    remove.disabled = count < 2;
    menu.append(up, down, merge, remove);
    row.append(eye, lock, name, lines, opacity, menu);
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

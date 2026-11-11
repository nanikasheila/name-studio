// The wrench under ツールプロパティ (as CSP's): which settings the palette
// shows for the sub tool in hand. Every item it can show, under CSP's
// headings, with a check box each and a search; beside them the ones shown,
// in their order, dragged into another. A change shows at once; 初めに戻す
// brings back what the sub tool shows out of the box, and the other button
// gives the same items to every sub tool of the tool.
import { $, element } from "../platform/dom";
import { dragSort } from "./dragsort";
import { matchingItems, movedItems, toggledItem, type PropItem } from "../editing/toolprops";

/** What the dialog edits: one sub tool's items. */
export interface ToolPropsTarget {
  /** The sub tool's name, and its tool's ("ペン"). */
  name: string;
  toolLabel: string;
  available(): PropItem[];
  shown(): string[];
  /** Whether it shows a choice of its own (else its tool's or the one out of the box). */
  own(): boolean;
  /** Show these (null: back to the ones out of the box). */
  set(items: string[] | null): void;
  /** Every sub tool of the tool shows these. */
  setForTool(items: string[]): void;
}

export class ToolPropsDialog {
  private target: ToolPropsTarget | null = null;
  private filter = "";

  constructor() {
    $<HTMLInputElement>("tp-filter").addEventListener("input", (event) => {
      this.filter = (event.target as HTMLInputElement).value;
      this.renderItems();
    });
    $("tp-reset").addEventListener("click", () => {
      this.target?.set(null);
      this.render();
    });
    $("tp-all-kind").addEventListener("click", () => {
      const target = this.target;
      if (!target) return;
      target.setForTool(target.shown());
      this.render();
      $("tp-where").textContent = `${target.toolLabel}のサブツールすべてに、この項目と順を使います。`;
    });
  }

  open(target: ToolPropsTarget): void {
    this.target = target;
    this.filter = "";
    $<HTMLInputElement>("tp-filter").value = "";
    $("tp-all-kind").textContent = `ほかの${target.toolLabel}にも使う`;
    this.render();
    const dialog = $<HTMLDialogElement>("toolprops-dialog");
    if (!dialog.open) dialog.showModal();
  }

  isOpen(): boolean {
    return $<HTMLDialogElement>("toolprops-dialog").open;
  }

  /** The sub tool in hand changed under it: show that one's (or close when it has none). */
  follow(target: ToolPropsTarget | null): void {
    if (!this.isOpen()) return;
    if (!target) {
      $<HTMLDialogElement>("toolprops-dialog").close();
      return;
    }
    this.target = target;
    this.render();
  }

  private render(): void {
    const target = this.target;
    if (!target) return;
    $("tp-where").textContent = `${target.name}（${target.own() ? "このサブツールだけの項目" : `${target.toolLabel}に共通の項目`}）`;
    this.renderItems();
    this.renderOrder();
  }

  private change(items: string[]): void {
    this.target?.set(items);
    this.render();
  }

  private renderItems(): void {
    const target = this.target;
    const box = $("tp-items");
    box.replaceChildren();
    if (!target) return;
    const available = target.available();
    const shown = new Set(target.shown());
    const found = matchingItems(available, this.filter);
    let group: string | null = null;
    let list: HTMLElement | null = null;
    for (const item of found) {
      if (item.group !== group || !list) {
        group = item.group;
        list = element("div", { className: "tp-group" }, element("h4", { textContent: group }));
        box.append(list);
      }
      const check = element("input", { type: "checkbox", checked: shown.has(item.id) });
      check.addEventListener("change", () => this.change(toggledItem(target.shown(), item.id, check.checked, available)));
      list.append(element("label", { className: "tp-item", title: item.hint ?? "" }, check, element("span", { textContent: item.label })));
    }
    if (!found.length) box.append(element("p", { className: "hint", textContent: "見つかりませんでした。" }));
  }

  private renderOrder(): void {
    const target = this.target;
    const box = $("tp-order");
    box.replaceChildren();
    if (!target) return;
    const labels = new Map(target.available().map((item) => [item.id, item.label]));
    const shown = target.shown();
    const rows = shown.map((id) => {
      const hide = element("button", { type: "button", className: "icon-button", textContent: "×", title: "出さない" });
      hide.addEventListener("pointerdown", (event) => event.stopPropagation());
      hide.addEventListener("click", () => this.change(shown.filter((x) => x !== id)));
      const row = element(
        "div",
        { className: "tp-row", title: "ドラッグで並べ替え" },
        element("span", { className: "tp-grip", textContent: "⋮⋮" }),
        element("span", { textContent: labels.get(id) ?? id }),
        hide,
      );
      row.dataset.item = id;
      return row;
    });
    box.append(...rows);
    if (!rows.length) box.append(element("p", { className: "hint", textContent: "何も出しません。左で選んでください。" }));
    dragSort(rows, { axis: "y", drop: (first, last, target) => this.change(movedItems(shown, first, last, target)) });
  }
}

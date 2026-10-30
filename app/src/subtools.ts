// サブツール (the palette, as CSP's サブツール and ツールプロパティ): the kinds
// of the tool in hand to pick from at a click (pens and erasers, …), each with
// a sample of what it draws and the key that takes it up, and under them the
// settings of the one in hand. Each tool with kinds of its own gives a
// SubToolSource; the palette shows the one of the tool in hand.
import { subtoolCommandId } from "./commands";
import { dragSort } from "./dragsort";
import { element } from "./dom";
import { keyLabel } from "./helptopics";
import { comboOf } from "./shortcuts";
import type { ToolId } from "./tooldefs";

/** One kind to pick. */
export interface SubTool {
  /** Stays the same from name to name (its keys go by it); starts with its tool's name ("pen:…"). */
  ref: string;
  name: string;
  /** Beside the name (its size). */
  detail?: string;
  /** Under a heading of its own (those taken in other names). */
  group?: string;
  /** Can be dragged to another place among those of no group. */
  movable?: boolean;
  /** What it draws, on the row's small canvas. */
  sample?: (canvas: HTMLCanvasElement) => void;
}

export interface SubToolMenuItem {
  label: string;
  run: () => void;
}

/** The kinds of one tool. */
export interface SubToolSource {
  tool: ToolId;
  /** Its tab ("ペン"). */
  label: string;
  list(): SubTool[];
  /** The kind in hand (its ref). */
  current(): string | null;
  /** Take it up (with its tool). */
  pick(ref: string): void;
  /** The movable ones `first`..`last` before the one at `target` of them. */
  reorder?(first: number, last: number, target: number): void;
  /** ツールプロパティ: the settings of the kind in hand, into `box`. */
  properties(box: HTMLElement): void;
  /** More for a row's menu (right click). */
  menu?(ref: string): SubToolMenuItem[];
  /** Under the list (取り込み…, 新規…). */
  footer?(box: HTMLElement): void;
  /** What it shows now, in a word: the same one again is not drawn again. */
  signature?(): string;
}

export interface SubToolHost {
  /** The tool in hand. */
  tool(): ToolId;
  /** Whether the palette is on screen (else it is drawn when it opens). */
  shown(): boolean;
  keysOf(command: string): string[];
  /** Give the key to the command; the label of the one it was taken from. */
  bindKey(command: string, combo: string): string | null;
  unbindKey(command: string, combo: string): void;
  status(message: string): void;
}

export class SubToolPanel {
  private readonly sources = new Map<ToolId, SubToolSource>();
  /** The tab shown: the tool in hand when it has kinds, else the one shown last. */
  private showing: ToolId | null = null;
  private inHand: ToolId | null = null;
  /** The sub tool waiting for a key press. */
  private listening: string | null = null;
  private menu: HTMLElement | null = null;
  /** What was drawn last (see SubToolSource.signature). */
  private drawn = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly host: SubToolHost,
  ) {
    // While waiting, the next key press is its key (Esc gives up); it does nothing else.
    window.addEventListener(
      "keydown",
      (event) => {
        if (!this.listening) return;
        event.preventDefault();
        event.stopPropagation();
        const ref = this.listening;
        if (event.key === "Escape") {
          this.listening = null;
          this.host.status("");
          this.render(true);
          return;
        }
        const combo = comboOf(event);
        if (!combo) return;
        this.listening = null;
        const taken = this.host.bindKey(subtoolCommandId(ref), combo);
        const name = this.find(ref)?.name ?? ref;
        this.host.status(taken ? `${keyLabel(combo)} を「${taken}」から外して「${name}」に割り当てました` : `${keyLabel(combo)} で「${name}」を持ちます`);
        this.render(true);
      },
      { capture: true },
    );
    window.addEventListener("pointerdown", (event) => {
      if (this.menu && !this.menu.contains(event.target as Node)) this.closeMenu();
    });
  }

  add(source: SubToolSource): void {
    this.sources.set(source.tool, source);
  }

  /** All the sources, for their commands. */
  all(): SubToolSource[] {
    return [...this.sources.values()];
  }

  private source(): SubToolSource | null {
    const tool = this.host.tool();
    // A tool taken up shows its kinds; a tab chosen stays until then.
    if (tool !== this.inHand) {
      this.inHand = tool;
      if (this.sources.has(tool)) this.showing = tool;
    }
    this.showing ??= this.sources.keys().next().value ?? null;
    return this.showing ? (this.sources.get(this.showing) ?? null) : null;
  }

  private find(ref: string): SubTool | undefined {
    for (const source of this.sources.values()) {
      const found = source.list().find((tool) => tool.ref === ref);
      if (found) return found;
    }
    return undefined;
  }

  /** Wait for the key to take `ref` up with. */
  listen(ref: string): void {
    this.listening = ref;
    this.host.status("割り当てるキーを押してください（Esc でやめる）");
    this.render(true);
  }

  /** Draw it as it is now; `force`: even when it looks the same (keys changed, …). */
  render(force = false): void {
    if (!this.host.shown()) {
      this.drawn = "";
      return;
    }
    const source = this.source();
    if (!source) {
      this.root.replaceChildren();
      return;
    }
    const drawn = source.signature ? `${source.tool}\n${this.listening}\n${source.signature()}` : "";
    if (!force && drawn && drawn === this.drawn) return;
    // A slider or box being used is not taken from under the pen; it is drawn again when let go.
    const active = document.activeElement;
    if (!force && active instanceof HTMLInputElement && this.root.contains(active)) {
      this.drawn = "";
      return;
    }
    this.drawn = drawn;
    const tabs = element("div", { className: "segmented subtool-tabs" });
    tabs.setAttribute("role", "tablist");
    for (const other of this.sources.values()) {
      const tab = element("button", { type: "button", textContent: other.label, className: other === source ? "active" : "" });
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(other === source));
      tab.addEventListener("click", () => {
        this.showing = other.tool;
        this.render(true);
      });
      tabs.append(tab);
    }
    const list = element("div", { className: "subtool-list" });
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", `${source.label}の種類`);
    const tools = source.list();
    const current = source.current();
    const movable: HTMLElement[] = [];
    let group: string | undefined;
    for (const tool of tools) {
      if (tool.group !== group) {
        group = tool.group;
        if (group) list.append(element("div", { className: "subtool-group", textContent: group }));
      }
      const row = this.row(source, tool, tool.ref === current);
      if (tool.movable && !tool.group) movable.push(row);
      list.append(row);
    }
    if (source.reorder && movable.length > 1) dragSort(movable, { axis: "y", drop: (first, last, target) => source.reorder?.(first, last, target) });
    const props = element("div", { className: "subtool-props" });
    props.setAttribute("aria-label", "ツールプロパティ");
    source.properties(props);
    const footer = element("div", { className: "subtool-footer" });
    source.footer?.(footer);
    this.root.replaceChildren(tabs, list, footer, props);
    list.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }

  private row(source: SubToolSource, tool: SubTool, current: boolean): HTMLElement {
    const command = subtoolCommandId(tool.ref);
    const keys = this.host.keysOf(command);
    const waiting = this.listening === tool.ref;
    const canvas = element("canvas", { className: "subtool-sample", width: 96, height: 20 });
    const row = element(
      "div",
      { className: `subtool-row${current ? " current" : ""}${waiting ? " waiting" : ""}` },
      canvas,
      element("span", { className: "subtool-name", textContent: tool.name }),
      element("span", { className: "subtool-detail", textContent: tool.detail ?? "" }),
    );
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(current));
    row.title = `${tool.name}: クリックで持つ${tool.movable ? "・ドラッグで並べ替え" : ""}・右クリックでキーの割り当て`;
    row.dataset.ref = tool.ref;
    const key = element("button", {
      type: "button",
      className: `subtool-key${keys.length ? " set" : ""}`,
      textContent: waiting ? "キーを押す…" : keys.length ? keys.map(keyLabel).join(" ") : "⌨",
      title: keys.length ? `このキーで持つ。クリックで別のキーに（右クリックで外す）` : "キーを割り当てる（押すとこのペンを持つ）",
    });
    key.addEventListener("pointerdown", (event) => event.stopPropagation());
    key.addEventListener("click", (event) => {
      event.stopPropagation();
      if (waiting) {
        this.listening = null;
        this.host.status("");
        this.render(true);
      } else this.listen(tool.ref);
    });
    key.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      for (const combo of keys) this.host.unbindKey(command, combo);
      if (keys.length) this.host.status(`「${tool.name}」のキーを外しました`);
      this.render(true);
    });
    row.append(key);
    row.addEventListener("click", () => source.pick(tool.ref));
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openMenu(source, tool, keys, event.clientX, event.clientY);
    });
    tool.sample?.(canvas);
    return row;
  }

  private openMenu(source: SubToolSource, tool: SubTool, keys: string[], x: number, y: number): void {
    this.closeMenu();
    const command = subtoolCommandId(tool.ref);
    const items: SubToolMenuItem[] = [
      { label: keys.length ? "キーを変える…" : "キーを割り当てる…", run: () => this.listen(tool.ref) },
      ...(keys.length
        ? [
            {
              label: `キーを外す（${keys.map(keyLabel).join(" / ")}）`,
              run: () => {
                for (const combo of keys) this.host.unbindKey(command, combo);
                this.render(true);
              },
            },
          ]
        : []),
      ...(source.menu?.(tool.ref) ?? []),
    ];
    const menu = element("div", { className: "subtool-menu" });
    menu.setAttribute("role", "menu");
    for (const item of items) {
      const button = element("button", { type: "button", textContent: item.label });
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", () => {
        this.closeMenu();
        item.run();
      });
      menu.append(button);
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    document.body.append(menu);
    // Kept inside the window.
    const box = menu.getBoundingClientRect();
    if (box.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - box.width - 4)}px`;
    if (box.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - box.height - 4)}px`;
    this.menu = menu;
    menu.querySelector("button")?.focus();
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }
}

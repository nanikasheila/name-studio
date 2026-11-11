// サブツール (the palette, as CSP's サブツール and ツールプロパティ): the kinds
// of the tool in hand to pick from at a click (pens and erasers, …), each with
// a sample of what it draws and the key that takes it up, and under them the
// settings of the one in hand. Each tool with kinds of its own gives a
// SubToolSource; the palette shows the one of the tool in hand.
//
// ツールプロパティ and ブラシサイズ are palettes of their own (as in CSP), so
// they can sit in another column or tab. ツールプロパティ shows the items
// chosen for the sub tool in hand (the wrench under it, toolpropsdialog.ts).
import { subtoolCommandId } from "../editing/commands";
import { loadToolProps, saveToolProps } from "../platform/prefs";
import { hasOwnChoice, shownItems, withChoice, withChoiceForTool, type PropItem } from "../editing/toolprops";
import { openMenu } from "./popupmenu";
import { ToolPropsDialog, type ToolPropsTarget } from "./toolpropsdialog";
import { dragSort } from "./dragsort";
import { element } from "../platform/dom";
import { keyLabel } from "../editing/helptopics";
import { ListPicker } from "./listops";
import { SEPARATOR } from "./popupmenu";
import { comboOf } from "../editing/shortcuts";
import type { ToolId } from "../editing/tooldefs";

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
  /** ツールプロパティ: the settings of the kind in hand, into `box` (when it has no `items`). */
  properties?(box: HTMLElement): void;
  /** ツールプロパティ: every setting it can show for the kind in hand, in their order. */
  items?(): PropItem[];
  /** The ones shown out of the box. */
  defaultItems?(): string[];
  /** One of them as a row (null: nothing to show for it now). */
  item?(id: string): HTMLElement | null;
  /** Under the items, whichever are shown (a note on what the plain pen can change, …). */
  note?(): HTMLElement | null;
  /** The name of the kind in hand (ツールプロパティ's title). */
  currentName?(): string;
  /** サブツール詳細: every setting of the kind in hand, on those with `words` when given. */
  details?(words?: string): void;
  /** ブラシサイズ: the round buttons of the sizes, large, into `box`. */
  sizes?(box: HTMLElement): void;
  /** More for a row's menu (right click). */
  menu?(ref: string): SubToolMenuItem[];
  /** Under the list (取り込み…, 新規…). */
  footer?(box: HTMLElement): void;
  /** What it shows now, in a word: the same one again is not drawn again. */
  signature?(): string;
  /** 複製 (Ctrl+D): a copy of the kind, under it. */
  duplicate?(ref: string): void;
  /** 削除 (Delete); `canRemove` says which can go. */
  remove?(ref: string): void;
  canRemove?(ref: string): boolean;
  /** F2: its name. */
  rename?(ref: string): void;
}

/** The palettes drawn here: the kinds, ツールプロパティ and ブラシサイズ. */
export type SubToolPart = "list" | "props" | "sizes";

export interface SubToolRoots {
  list: HTMLElement;
  props: HTMLElement;
  sizes: HTMLElement;
}

export interface SubToolHost {
  /** The tool in hand. */
  tool(): ToolId;
  /** Whether a part is on screen (else it is drawn when it opens). */
  shown(part: SubToolPart): boolean;
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
  /** The rows' keys and menu, as the other lists'. */
  private readonly picker: ListPicker;
  /** What was drawn last in each part (see SubToolSource.signature). */
  private readonly drawn: Record<SubToolPart, string> = { list: "", props: "", sizes: "" };
  private readonly root: HTMLElement;
  private readonly dialog = new ToolPropsDialog();

  constructor(
    private readonly roots: SubToolRoots,
    private readonly host: SubToolHost,
  ) {
    this.root = roots.list;
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
        this.host.status(
          taken ? `${keyLabel(combo)} を「${taken}」から外して「${name}」に割り当てました` : `${keyLabel(combo)} で「${name}」を持ちます`,
        );
        this.render(true);
      },
      { capture: true },
    );
    this.picker = this.bind();
  }

  private bind(): ListPicker {
    const source = () => this.source();
    const movable = () =>
      source()
        ?.list()
        .filter((tool) => tool.movable && !tool.group) ?? [];
    const step = (ref: string, to: -1 | 1 | "first" | "last"): [number, number] | null => {
      const list = movable();
      const at = list.findIndex((tool) => tool.ref === ref);
      if (at < 0) return null;
      const target = to === "first" ? 0 : to === "last" ? list.length : to < 0 ? at - 1 : at + 2;
      return target < 0 || target > list.length || target === at || target === at + 1 ? null : [at, target];
    };
    return new ListPicker(this.root, {
      noun: "サブツール",
      single: true,
      ids: () =>
        source()
          ?.list()
          .map((tool) => tool.ref) ?? [],
      open: (ref) => source()?.pick(ref),
      duplicate: (ids) => source()?.duplicate?.(ids[0]),
      remove: (ids) => {
        const s = source();
        if (s?.remove && (s.canRemove?.(ids[0]) ?? true)) s.remove(ids[0]);
        else this.host.status("標準のペン・消しゴムとほかのネームのものは消せません");
      },
      rename: (ref) => source()?.rename?.(ref),
      move: (ids, to) => {
        const at = step(ids[0], to);
        if (at) source()?.reorder?.(at[0], at[0], at[1]);
      },
      canMove: (ids, to) => !!step(ids[0], to),
      extra: (ids) => {
        const ref = ids[0];
        const keys = this.host.keysOf(subtoolCommandId(ref));
        const own = source()?.menu?.(ref) ?? [];
        return [
          ...own.map((item) => ({ label: item.label, run: item.run })),
          ...(own.length ? [SEPARATOR] : []),
          { label: keys.length ? "キーを変える…" : "キーを割り当てる…", run: () => this.listen(ref) },
          ...(keys.length ? [{ label: `キーを外す（${keys.map(keyLabel).join(" / ")}）`, run: () => this.unbind(ref) }] : []),
        ];
      },
    });
  }

  private unbind(ref: string): void {
    const command = subtoolCommandId(ref);
    const keys = this.host.keysOf(command);
    for (const combo of keys) this.host.unbindKey(command, combo);
    if (keys.length) this.host.status(`「${this.find(ref)?.name ?? ref}」のキーを外しました`);
    this.render(true);
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

  /** Draw what is on screen as it is now; `force`: even when it looks the same (keys changed, …). */
  render(force = false): void {
    const source = this.source();
    for (const part of ["list", "props", "sizes"] as const) {
      if (!this.host.shown(part)) {
        this.drawn[part] = "";
        continue;
      }
      const root = this.roots[part];
      if (!source) {
        root.replaceChildren();
        this.drawn[part] = "";
        continue;
      }
      const extra = part === "props" ? JSON.stringify(this.shownNow(source)) : "";
      const drawn = source.signature ? `${source.tool}\n${this.listening}\n${extra}\n${source.signature()}` : "";
      if (!force && drawn && drawn === this.drawn[part]) continue;
      // A slider or box being used is not taken from under the pen; it is drawn again when let go.
      const active = document.activeElement;
      if (!force && (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) && root.contains(active)) {
        this.drawn[part] = "";
        continue;
      }
      this.drawn[part] = drawn;
      if (part === "list") this.renderList(source);
      else if (part === "props") this.renderProps(source);
      else this.renderSizes(source);
    }
    this.dialog.follow(source?.items ? this.target(source) : null);
  }

  private renderList(source: SubToolSource): void {
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
      const row = this.row(tool, tool.ref === current);
      if (tool.movable && !tool.group) movable.push(row);
      list.append(row);
    }
    if (source.reorder && movable.length > 1)
      dragSort(movable, { axis: "y", drop: (first, last, target) => source.reorder?.(first, last, target) });
    const footer = element("div", { className: "subtool-footer" });
    source.footer?.(footer);
    this.root.replaceChildren(tabs, list, footer);
    list.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }

  // --- ツールプロパティ ----------------------------------------------------------------

  /** The ref the items are kept by: the kind in hand (or the tool, when it has none). */
  private refOf(source: SubToolSource): string {
    return source.current() ?? `${source.tool}:none`;
  }

  /** The items shown for the kind in hand now. */
  private shownNow(source: SubToolSource): string[] {
    if (!source.items) return [];
    return shownItems(loadToolProps(), this.refOf(source), source.tool, source.items(), source.defaultItems?.() ?? []);
  }

  private setShown(source: SubToolSource, items: string[] | null, forTool = false): void {
    const ref = this.refOf(source);
    const choices = loadToolProps();
    saveToolProps(forTool && items ? withChoiceForTool(choices, source.tool, items) : withChoice(choices, ref, items));
    this.render(true);
  }

  /** The wrench's dialog on the kind in hand. */
  private target(source: SubToolSource): ToolPropsTarget {
    return {
      name: source.currentName?.() ?? source.label,
      toolLabel: source.label,
      available: () => source.items?.() ?? [],
      shown: () => this.shownNow(source),
      own: () => hasOwnChoice(loadToolProps(), this.refOf(source)),
      set: (items) => this.setShown(source, items),
      setForTool: (items) => this.setShown(source, items, true),
    };
  }

  /** 表示する項目…: the wrench. */
  chooseItems(): void {
    const source = this.source();
    if (!source?.items) {
      this.host.status("この道具のツールプロパティは項目を選べません");
      return;
    }
    this.dialog.open(this.target(source));
  }

  private renderProps(source: SubToolSource): void {
    const box = element("div", { className: "subtool-props" });
    box.setAttribute("aria-label", "ツールプロパティ");
    if (source.items && source.item) {
      const name = source.currentName?.();
      if (name) box.append(element("div", { className: "subtool-props-title", textContent: name }));
      const shown = this.shownNow(source);
      for (const id of shown) {
        const node = source.item(id);
        if (!node) continue;
        const wrap = element("div", { className: "toolprop-item" }, node);
        wrap.dataset.item = id;
        wrap.addEventListener("contextmenu", (event) => {
          if ((event.target as HTMLElement).closest("button.size-presets, .size-presets button")) return;
          event.preventDefault();
          openMenu(
            [
              {
                label: "この項目を出さない",
                run: () =>
                  this.setShown(
                    source,
                    this.shownNow(source).filter((x) => x !== id),
                  ),
              },
              { label: "表示する項目…", run: () => this.chooseItems() },
              ...(source.details ? [{ label: "詳細設定で開く…", run: () => source.details?.(node.dataset.setting ?? "") }] : []),
            ],
            event.clientX,
            event.clientY,
            "ツールプロパティの項目",
          );
        });
        box.append(wrap);
      }
      if (!shown.length)
        box.append(element("p", { className: "subtool-note", textContent: "出す項目がありません。下のスパナで選べます。" }));
      const note = source.note?.();
      if (note) box.append(note);
    } else source.properties?.(box);
    const bar = element("div", { className: "toolprops-bar" });
    if (source.details) {
      const details = element("button", {
        type: "button",
        className: "icon-button",
        title: "サブツール詳細: すべての設定を開く（CSP のサブツール詳細のように）",
        innerHTML: DETAILS_ICON,
      });
      details.setAttribute("aria-label", "サブツール詳細");
      details.addEventListener("click", () => source.details?.());
      bar.append(details);
    }
    if (source.items) {
      const wrench = element("button", {
        type: "button",
        id: "toolprops-wrench",
        className: "icon-button",
        title: "ツールプロパティに出す項目を選ぶ（CSP のスパナのように）",
        innerHTML: WRENCH_ICON,
      });
      wrench.setAttribute("aria-label", "表示する項目");
      wrench.addEventListener("click", () => this.chooseItems());
      bar.append(wrench);
    }
    this.roots.props.replaceChildren(box, bar);
  }

  private renderSizes(source: SubToolSource): void {
    const box = this.roots.sizes;
    box.replaceChildren();
    if (source.sizes) source.sizes(box);
    else box.append(element("p", { className: "subtool-note", textContent: "ペンか消しゴムを持つと、太さの丸ボタンが出ます。" }));
  }

  private row(tool: SubTool, current: boolean): HTMLElement {
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
    row.title = `${tool.name}: クリックで持つ${tool.movable ? "・ドラッグで並べ替え" : ""}・右クリックでメニュー（複製・削除・並べ替え・キーの割り当て）`;
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
      this.unbind(tool.ref);
    });
    row.append(key);
    this.picker.row(row, tool.ref);
    tool.sample?.(canvas);
    return row;
  }
}

const svgIcon = (inner: string) => `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true">${inner}</svg>`;
const WRENCH_ICON = svgIcon(
  '<path d="M12.8 3.2a4 4 0 0 0-4.6 5.3L3.5 13.2a1.6 1.6 0 0 0 2.3 2.3l4.7-4.7a4 4 0 0 0 5.3-4.6l-2.4 2.4-2.1-.5-.5-2.1z"/>',
);
const DETAILS_ICON = svgIcon(
  '<path d="M4 5h12M4 10h12M4 15h12"/><circle cx="8" cy="5" r="1.6"/><circle cx="13" cy="10" r="1.6"/><circle cx="7" cy="15" r="1.6"/>',
);

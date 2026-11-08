// The operations every managing list shares with the page list (pagelist.ts):
// rows picked one, several (Ctrl / Shift + click, Shift + ↑↓) or all
// (Ctrl+A), and the same keys and the same menu order for putting in,
// copying, moving and removing what they list. Each list says which of them
// it has; the ones it has not are not offered.
import { type MenuItem, openMenu, SEPARATOR } from "./popupmenu";

type Entry = MenuItem | typeof SEPARATOR;

/** What a list can do with its rows (by id, in the list's order). */
export interface ListActions {
  /** The ids of the rows shown, in their order. */
  ids(): string[];
  /** One for each row: the list's word for it ("人物", "付箋"). */
  noun: string;
  /** Only one row at a time (no Ctrl / Shift). */
  single?: boolean;
  /** A plain click, Enter or an arrow: show it, go to it (the row is picked first). */
  open?(id: string): void;
  /** Whether ↑↓ open the row they come to too (false: they only pick it; Enter opens). */
  arrowsOpen?: boolean;
  /** Insert / Shift+Insert: a new one after (or before) `at` (empty: at the end). */
  insert?(after: boolean, at: string[]): void;
  /** Ctrl+D. */
  duplicate?(ids: string[]): void;
  /** Delete. */
  remove?(ids: string[]): void;
  /** The label of 削除 when it does something else (済み, シリーズから外す). */
  removeLabel?: string;
  /** Alt+↑↓, and 先頭へ・最後へ in the menu. */
  move?(ids: string[], to: -1 | 1 | "first" | "last"): void;
  /** Whether the picked rows can go that way (else the menu greys it). */
  canMove?(ids: string[], to: -1 | 1 | "first" | "last"): boolean;
  copy?(ids: string[]): void;
  cut?(ids: string[]): void;
  /** Ctrl+V (after `at`) / Ctrl+Shift+V (before). */
  paste?(before: boolean, at: string[]): void;
  canPaste?(): boolean;
  /** F2: its name or words. */
  rename?(id: string): void;
  /** The list's own items for the picked rows, between moving and removing. */
  extra?(ids: string[]): Entry[];
  /** The menu on no row (Ctrl+A is added). */
  empty?(): Entry[];
  /** The picked rows changed (the list draws them again, or not). */
  changed?(): void;
  /** A key of the list's own (Ctrl+E), before the shared ones; true when used. */
  key?(event: KeyboardEvent, ids: string[]): boolean;
}

/** The keys as the menus show them. */
export const LIST_KEYS = {
  insertAfter: "Insert",
  insertBefore: "Shift+Insert",
  duplicate: "Ctrl+D",
  remove: "Delete",
  earlier: "Alt+↑",
  later: "Alt+↓",
  copy: "Ctrl+C",
  cut: "Ctrl+X",
  pasteAfter: "Ctrl+V",
  pasteBefore: "Ctrl+Shift+V",
  rename: "F2",
  all: "Ctrl+A",
} as const;

/**
 * The picked rows of one list and its keys and menu. The rows are drawn by
 * the list; each is handed to `row` as it is drawn.
 */
export class ListPicker {
  private picked = new Set<string>();
  /** The row worked on (an arrow moves it). */
  private current: string | null = null;
  /** Where Shift extends from. */
  private anchor: string | null = null;

  constructor(
    readonly container: HTMLElement,
    private readonly actions: ListActions,
  ) {
    container.tabIndex = 0;
    container.classList.add("managed-list");
    container.addEventListener("keydown", (event) => {
      if ((event.target as HTMLElement).closest("input, textarea, select") && event.target !== container) return;
      if (this.key(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    container.addEventListener("contextmenu", (event) => {
      if ((event.target as HTMLElement).closest("input, textarea")) return;
      if ((event.target as HTMLElement).closest("[data-list-id]")) return;
      event.preventDefault();
      this.menuAt(null, event.clientX, event.clientY);
    });
    // Pressing elsewhere ends the list's keys: Delete there is the canvas's.
    window.addEventListener(
      "pointerdown",
      (event) => {
        if (container.contains(document.activeElement) && !container.contains(event.target as Node)) (document.activeElement as HTMLElement).blur();
      },
      true,
    );
  }

  /** The rows the commands act on, in the list's order: the picked ones, else the one worked on. */
  targets(): string[] {
    const ids = this.actions.ids();
    const picked = ids.filter((id) => this.picked.has(id));
    if (picked.length) return picked;
    return this.current && ids.includes(this.current) ? [this.current] : [];
  }

  /** Whether the row is among the picked (painted so). */
  isPicked(id: string): boolean {
    return this.targets().includes(id);
  }

  /** Pick these rows (the first is the one worked on). */
  pick(ids: readonly string[], repaint = true): void {
    this.picked = new Set(ids);
    this.current = ids[0] ?? null;
    this.anchor = this.current;
    if (repaint) this.paint();
  }

  clear(): void {
    this.picked = new Set();
    this.paint();
  }

  /** A row as it is drawn: its clicks pick it, its right click opens the menu. */
  row(element: HTMLElement, id: string): HTMLElement {
    element.dataset.listId = id;
    element.classList.toggle("picked", this.isPicked(id));
    element.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("input, textarea, select, button")) return;
      this.clicked(id, event);
    });
    element.addEventListener("contextmenu", (event) => {
      if ((event.target as HTMLElement).closest("input, textarea")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!this.isPicked(id)) this.pick([id]);
      this.menuAt(id, event.clientX, event.clientY);
    });
    return element;
  }

  private clicked(id: string, event: MouseEvent): void {
    this.container.focus({ preventScroll: true });
    if (!this.actions.single && (event.ctrlKey || event.metaKey)) {
      const now = new Set(this.targets());
      if (now.has(id) && now.size > 1) now.delete(id);
      else now.add(id);
      this.picked = now;
      this.current = id;
      this.anchor = id;
      this.paint();
      return;
    }
    if (!this.actions.single && event.shiftKey) {
      this.extendTo(id);
      return;
    }
    this.pick([id]);
    this.actions.open?.(id);
  }

  private extendTo(id: string): void {
    const ids = this.actions.ids();
    const from = ids.indexOf(this.anchor ?? this.current ?? id);
    const to = ids.indexOf(id);
    const [a, b] = [Math.min(from < 0 ? to : from, to), Math.max(from < 0 ? to : from, to)];
    this.picked = new Set(ids.slice(a, b + 1));
    this.current = id;
    this.paint();
  }

  /** The rows painted as picked or not (without drawing the list again). */
  paint(): void {
    const picked = new Set(this.targets());
    for (const row of this.container.querySelectorAll<HTMLElement>("[data-list-id]")) row.classList.toggle("picked", picked.has(row.dataset.listId ?? ""));
    this.actions.changed?.();
  }

  /** The menu for the picked rows (`id` the row pressed; null: on no row). */
  menuAt(id: string | null, x: number, y: number): void {
    const a = this.actions;
    if (id === null) {
      const items: Entry[] = [...(a.empty?.() ?? [])];
      if (!a.single && a.ids().length) items.push(...(items.length ? [SEPARATOR] : []), { label: `すべての${a.noun}を選ぶ`, keys: LIST_KEYS.all, run: () => this.selectAll() });
      if (items.length) openMenu(items, x, y, a.noun);
      return;
    }
    openMenu(this.menuItems(this.targets()), x, y, `${a.noun}のメニュー`);
  }

  /** The menu's items in the page list's order: put in, copy, move, the list's own, remove. */
  menuItems(ids: string[]): Entry[] {
    const a = this.actions;
    const groups: Entry[][] = [];
    const put: Entry[] = [];
    if (a.insert) {
      put.push({ label: "前に足す", keys: LIST_KEYS.insertBefore, run: () => a.insert!(false, ids) });
      put.push({ label: "後ろに足す", keys: LIST_KEYS.insertAfter, run: () => a.insert!(true, ids) });
    }
    if (a.duplicate) put.push({ label: "複製して後ろに入れる", keys: LIST_KEYS.duplicate, run: () => a.duplicate!(ids) });
    if (a.rename && ids.length === 1) put.push({ label: "名前を変える", keys: LIST_KEYS.rename, run: () => a.rename!(ids[0]) });
    groups.push(put);
    const clip: Entry[] = [];
    if (a.copy) clip.push({ label: "コピー", keys: LIST_KEYS.copy, run: () => a.copy!(ids) });
    if (a.cut) clip.push({ label: "切り取り", keys: LIST_KEYS.cut, run: () => a.cut!(ids) });
    if (a.paste) {
      const can = a.canPaste?.() ?? true;
      clip.push({ label: "前に貼り付け", keys: LIST_KEYS.pasteBefore, disabled: !can, run: () => a.paste!(true, ids) });
      clip.push({ label: "後ろに貼り付け", keys: LIST_KEYS.pasteAfter, disabled: !can, run: () => a.paste!(false, ids) });
    }
    groups.push(clip);
    const move: Entry[] = [];
    if (a.move) {
      const can = (to: -1 | 1 | "first" | "last") => a.canMove?.(ids, to) ?? true;
      move.push(
        { label: "1 つ前へ", keys: LIST_KEYS.earlier, disabled: !can(-1), run: () => a.move!(ids, -1) },
        { label: "1 つ後ろへ", keys: LIST_KEYS.later, disabled: !can(1), run: () => a.move!(ids, 1) },
        { label: "先頭へ", disabled: !can("first"), run: () => a.move!(ids, "first") },
        { label: "最後へ", disabled: !can("last"), run: () => a.move!(ids, "last") },
      );
    }
    groups.push(move);
    groups.push(a.extra?.(ids) ?? []);
    if (a.remove) groups.push([{ label: a.removeLabel ?? "削除", keys: LIST_KEYS.remove, danger: true, run: () => a.remove!(ids) }]);
    const items: Entry[] = [];
    for (const group of groups) {
      // The list's own may bring separators of its own.
      const trimmed = group.filter((item, i) => item !== SEPARATOR || (i > 0 && i < group.length - 1));
      if (!trimmed.length) continue;
      if (items.length) items.push(SEPARATOR);
      items.push(...trimmed);
    }
    return items;
  }

  selectAll(): void {
    if (this.actions.single) return;
    const ids = this.actions.ids();
    this.picked = new Set(ids);
    if (!this.current || !ids.includes(this.current)) this.current = ids[0] ?? null;
    this.paint();
  }

  /** Keys while the list has the focus. True when the key was used. */
  private key(event: KeyboardEvent): boolean {
    const a = this.actions;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key;
    const ids = this.targets();
    if (a.key?.(event, ids)) return true;
    if (ctrl && !event.altKey) {
      switch (key.toLowerCase()) {
        case "a":
          if (a.single) return false;
          this.selectAll();
          return true;
        case "c":
          if (!a.copy || !ids.length) return false;
          a.copy(ids);
          return true;
        case "x":
          if (!a.cut || !ids.length) return false;
          a.cut(ids);
          return true;
        case "v":
          if (!a.paste) return false;
          a.paste(event.shiftKey, ids);
          return true;
        case "d":
          if (!a.duplicate || event.shiftKey || !ids.length) return false;
          a.duplicate(ids);
          return true;
      }
      return false;
    }
    if (event.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
      if (!a.move || !ids.length) return false;
      a.move(ids, key === "ArrowUp" ? -1 : 1);
      return true;
    }
    if (event.altKey) return false;
    if (key === "Delete" || key === "Backspace") {
      if (!a.remove || !ids.length) return false;
      a.remove(ids);
      return true;
    }
    if (key === "Insert") {
      if (!a.insert) return false;
      a.insert(!event.shiftKey, ids);
      return true;
    }
    if (key === "F2") {
      if (!a.rename || ids.length !== 1) return false;
      a.rename(ids[0]);
      return true;
    }
    if (key === "Enter") {
      if (!a.open || !this.current) return false;
      a.open(this.current);
      return true;
    }
    if (key === "Escape") {
      if (!this.picked.size || this.picked.size === 1) return false;
      this.clear();
      return true;
    }
    if (key === "ContextMenu" || (key === "F10" && event.shiftKey)) {
      const row = ids[0] ? this.rowOf(ids[0]) : null;
      const box = row?.getBoundingClientRect() ?? this.container.getBoundingClientRect();
      this.menuAt(ids[0] ?? null, box.left + 24, row ? box.bottom : box.top + 24);
      return true;
    }
    if (key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End") {
      const all = this.actions.ids();
      if (!all.length) return false;
      const from = this.current ? all.indexOf(this.current) : -1;
      const to = key === "Home" ? 0 : key === "End" ? all.length - 1 : Math.max(0, Math.min(all.length - 1, from < 0 ? 0 : from + (key === "ArrowUp" ? -1 : 1)));
      const id = all[to];
      if (event.shiftKey && !a.single) {
        if (!this.anchor) this.anchor = this.current ?? id;
        this.extendTo(id);
      } else {
        this.pick([id]);
        if (a.arrowsOpen !== false) a.open?.(id);
      }
      this.rowOf(id)?.scrollIntoView({ block: "nearest" });
      return true;
    }
    return false;
  }

  private rowOf(id: string): HTMLElement | null {
    return [...this.container.querySelectorAll<HTMLElement>("[data-list-id]")].find((row) => row.dataset.listId === id) ?? null;
  }
}

export interface ToolButton {
  id?: string;
  text: string;
  title: string;
  run: () => void;
  disabled?: boolean;
}

/** The buttons over a list (as the page list's), with a note at the right. */
export function toolRow(buttons: readonly ToolButton[], note = ""): HTMLElement {
  const row = document.createElement("div");
  row.className = "page-tools list-tools";
  for (const b of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "small";
    if (b.id) button.id = b.id;
    button.textContent = b.text;
    button.title = b.title;
    button.disabled = !!b.disabled;
    button.addEventListener("click", b.run);
    row.append(button);
  }
  const span = document.createElement("span");
  span.className = "page-tools-note";
  span.textContent = note;
  row.append(span);
  return row;
}

/** Text onto the system clipboard; false when it could not be put there. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

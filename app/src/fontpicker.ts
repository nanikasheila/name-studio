// A field to choose a font in, as in CLIP STUDIO PAINT: the list opens under
// the field with every name shown in its own typeface (recently used ones
// first, then Japanese fonts, then the others), typing narrows it, and the
// font under the pointer or the arrow keys is shown large with sample text.
import { element } from "./dom";
import { canvasFont, fontChoices, installedFont } from "./fonts";
import { readJson, writeJson } from "./settings";

const SAMPLE = "あいうアイウ漢字！？";
const RECENT_KEY = "namestudio.recentFonts";
const MOST_RECENT = 8;

/** Fonts picked lately, newest first. */
export function recentFonts(): string[] {
  const kept = readJson(RECENT_KEY, []);
  return Array.isArray(kept) ? kept.filter((name): name is string => typeof name === "string").slice(0, MOST_RECENT) : [];
}

function remember(name: string): void {
  writeJson(RECENT_KEY, [name, ...recentFonts().filter((other) => other !== name)].slice(0, MOST_RECENT));
}

/** What the list shows for `query`: groups of names, recently used first. */
export function fontGroups(query: string, choices: readonly string[] = fontChoices(), recent: readonly string[] = recentFonts()): { title: string; names: string[] }[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (name: string) => {
    const face = installedFont(name);
    const text = [name, ...(face?.families ?? []), face?.postscript ?? ""].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  };
  const known = new Set(choices);
  const recents = recent.filter((name) => known.has(name) && matches(name));
  const japanese = (name: string) => installedFont(name)?.japanese ?? true;
  const rest = choices.filter(matches);
  return [
    { title: "最近使ったフォント", names: recents },
    { title: "日本語のフォント", names: rest.filter(japanese) },
    { title: "ほかのフォント", names: rest.filter((name) => !japanese(name)) },
  ].filter((group) => group.names.length);
}

/** The open list, if any (one at a time). */
let openMenu: { close(pick: boolean): void } | null = null;

/**
 * A font field: `value` the font chosen (empty: none), `fallback` what is
 * used without one (shown greyed in the field). `change` gets the name when
 * one is picked from the list or typed and the field is left (empty for
 * none). `sample` is the text the preview shows (a line's own words).
 */
export function fontField(value: string, fallback: string, change: (name: string) => void, title = "", sample = SAMPLE): HTMLElement {
  const input = element("input", { type: "text", value, placeholder: fallback, title, spellcheck: false, autocomplete: "off" });
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  const shown = element("span", { className: "font-sample", textContent: SAMPLE });
  const show = (name: string) => (shown.style.font = canvasFont(name.trim() || null, 15));
  show(value);
  const open = element("button", { type: "button", className: "font-open", textContent: "▾", title: "フォントの一覧（その書体で表示）" });
  const clear = element("button", { type: "button", className: "font-clear", textContent: "×", title: "指定をやめる" });
  clear.disabled = !value;
  // What the field holds as chosen (the name given, then each one picked).
  let chosen = value;
  const commit = (name: string) => {
    const picked = name.trim();
    input.value = picked;
    show(picked);
    if (picked) remember(picked);
    if (picked === chosen) return;
    chosen = picked;
    clear.disabled = !picked;
    change(picked);
  };
  clear.addEventListener("click", () => {
    openMenu?.close(false);
    commit("");
  });

  let menu: FontMenu | null = null;
  const openList = () => {
    if (menu || input.disabled) return;
    openMenu?.close(false);
    menu = new FontMenu(input, sample, {
      pick: (name) => commit(name),
      closed: () => {
        menu = null;
        openMenu = null;
        input.setAttribute("aria-expanded", "false");
        show(input.value);
      },
    });
    openMenu = menu;
    input.setAttribute("aria-expanded", "true");
  };
  open.addEventListener("mousedown", (event) => event.preventDefault());
  open.addEventListener("click", () => {
    if (menu) menu.close(false);
    else {
      input.focus();
      openList();
    }
  });
  input.addEventListener("click", openList);
  input.addEventListener("input", () => {
    show(input.value);
    if (!menu) openList();
    menu?.filter(input.value);
  });
  input.addEventListener("keydown", (event) => {
    if (!menu) {
      if (event.key === "ArrowDown" || (event.key === "Enter" && event.altKey)) {
        event.preventDefault();
        openList();
      } else if (event.key === "Enter") {
        event.preventDefault();
        commit(input.value);
      }
      return;
    }
    if (menu.key(event)) event.preventDefault();
  });
  input.addEventListener("blur", () => {
    // Leaving the field: a name typed in it is kept, as when Enter is pressed.
    if (menu) return;
    if (input.value.trim() !== chosen) commit(input.value);
  });
  return element("span", { className: "font-field" }, input, open, clear, shown);
}

interface MenuHost {
  pick(name: string): void;
  closed(): void;
}

/** The list under a font field. */
class FontMenu {
  private readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly previewName: HTMLDivElement;
  private readonly previewText: HTMLDivElement;
  private items: HTMLButtonElement[] = [];
  private active = -1;
  private readonly before: string;
  private readonly away = (event: Event) => {
    const target = event.target as Node | null;
    if (target && (this.root.contains(target) || this.input.parentElement?.contains(target))) return;
    // Clicked elsewhere: what was typed to narrow the list is dropped.
    this.input.value = this.before;
    this.close(false);
  };
  private readonly place = () => this.position();
  /** Esc closes the list, not the dialog the field is in. */
  private readonly dialog: HTMLDialogElement | null;
  private readonly keepDialog = (event: Event) => event.preventDefault();

  constructor(
    private readonly input: HTMLInputElement,
    sample: string,
    private readonly host: MenuHost,
  ) {
    this.before = input.value;
    this.dialog = input.closest("dialog");
    this.dialog?.addEventListener("cancel", this.keepDialog);
    this.previewName = element("div", { className: "font-preview-name" });
    this.previewText = element("div", { className: "font-preview-text", textContent: sample.trim() || SAMPLE });
    this.list = element("div", { className: "font-menu-list", role: "listbox" });
    this.root = element(
      "div",
      { className: "font-menu" },
      element("div", { className: "font-preview" }, this.previewName, this.previewText),
      this.list,
      element("p", { className: "font-menu-hint", textContent: "文字を打つと絞り込みます。↑↓←→ で選び Enter で決定、Esc でやめる" }),
    );
    // Above everything, a dialog that is open too (the top layer), where popovers are supported.
    (input.closest("dialog") ?? document.body).append(this.root);
    if ("showPopover" in this.root) {
      this.root.popover = "manual";
      (this.root as HTMLElement & { showPopover(): void }).showPopover();
    }
    this.filter("", input.value);
    this.position();
    document.addEventListener("pointerdown", this.away, true);
    window.addEventListener("resize", this.place);
    window.addEventListener("scroll", this.place, true);
  }

  /** Shows the fonts matching `query`, with `current` (or the first) made active. */
  filter(query: string, current = ""): void {
    const groups = fontGroups(query);
    this.items = [];
    this.list.replaceChildren(
      ...groups.map((group) =>
        element(
          "section",
          {},
          element("h4", { textContent: group.title }),
          element(
            "div",
            { className: "font-menu-grid" },
            ...group.names.map((name) => {
              const item = element("button", { type: "button", className: "font-item", textContent: name, title: name, tabIndex: -1 });
              item.setAttribute("role", "option");
              item.style.font = canvasFont(name, 15);
              const index = this.items.length;
              item.addEventListener("mousedown", (event) => event.preventDefault());
              item.addEventListener("mouseenter", () => this.setActive(index, false));
              item.addEventListener("click", () => this.choose(name));
              this.items.push(item);
              return item;
            }),
          ),
        ),
      ),
    );
    if (!groups.length) this.list.append(element("p", { className: "font-menu-empty", textContent: "合うフォントがありません。Enter でこの名前のまま使います" }));
    const at = current ? this.items.findIndex((item) => item.textContent === current) : -1;
    this.setActive(at >= 0 ? at : query.trim() ? 0 : -1, true);
    if (at < 0 && !query.trim()) this.preview(current || null);
  }

  /** Handles a key in the field; true when it was the list's. */
  key(event: KeyboardEvent): boolean {
    switch (event.key) {
      case "ArrowRight":
        if (this.input.selectionStart !== this.input.value.length && this.active < 0) return false;
        this.setActive(Math.min(this.items.length - 1, this.active + 1), true);
        return true;
      case "ArrowLeft":
        if (this.active < 0) return false;
        this.setActive(Math.max(0, this.active - 1), true);
        return true;
      case "ArrowDown":
      case "ArrowUp":
        this.setActive(this.vertical(event.key === "ArrowDown" ? 1 : -1), true);
        return true;
      case "Enter": {
        const item = this.items[this.active];
        this.choose(item?.textContent ?? this.input.value);
        return true;
      }
      case "Escape":
        event.stopPropagation();
        this.input.value = this.before;
        this.close(false);
        return true;
      case "Tab": {
        // Leaving with Tab takes the font picked in the list, else what was there before.
        const item = this.items[this.active];
        this.input.value = item?.textContent ?? this.before;
        this.close(!!item);
        return false;
      }
      default:
        return false;
    }
  }

  close(pick: boolean): void {
    document.removeEventListener("pointerdown", this.away, true);
    window.removeEventListener("resize", this.place);
    window.removeEventListener("scroll", this.place, true);
    this.root.remove();
    // The dialog's own Esc comes after the key that closed the list.
    const dialog = this.dialog;
    setTimeout(() => dialog?.removeEventListener("cancel", this.keepDialog), 0);
    this.host.closed();
    if (pick) this.host.pick(this.input.value);
  }

  private choose(name: string): void {
    this.input.value = name;
    this.close(false);
    this.host.pick(name);
  }

  /** The item in the next row (or the one before) nearest across. */
  private vertical(step: 1 | -1): number {
    if (this.active < 0) return step > 0 ? 0 : -1;
    const from = this.items[this.active].getBoundingClientRect();
    let best = this.active;
    let bestScore = Infinity;
    for (const [index, item] of this.items.entries()) {
      const box = item.getBoundingClientRect();
      const down = (box.top - from.top) * step;
      if (down <= 1) continue;
      const score = down * 4 + Math.abs(box.left - from.left);
      if (score < bestScore) {
        bestScore = score;
        best = index;
      }
    }
    return best;
  }

  private setActive(index: number, scroll: boolean): void {
    this.items[this.active]?.classList.remove("active");
    this.active = index;
    const item = this.items[index];
    if (!item) return;
    item.classList.add("active");
    if (scroll) item.scrollIntoView({ block: "nearest" });
    this.preview(item.textContent);
  }

  private preview(name: string | null): void {
    this.previewName.textContent = name ?? "（フォントを選んでいません）";
    this.previewText.style.font = canvasFont(name, 26);
  }

  /** Under the field, or above it when there is no room below. */
  private position(): void {
    if (!this.input.isConnected) {
      this.close(false);
      return;
    }
    const field = (this.input.parentElement ?? this.input).getBoundingClientRect();
    const width = Math.min(560, window.innerWidth - 16);
    const left = Math.max(8, Math.min(field.left, window.innerWidth - width - 8));
    const below = window.innerHeight - field.bottom - 8;
    const above = field.top - 8;
    const height = Math.min(440, Math.max(below, above));
    this.root.style.left = `${left}px`;
    this.root.style.width = `${width}px`;
    this.root.style.maxHeight = `${height}px`;
    this.root.style.top = below >= Math.min(300, above) ? `${field.bottom + 2}px` : `${Math.max(8, field.top - 2 - Math.min(height, this.root.offsetHeight || height))}px`;
  }
}

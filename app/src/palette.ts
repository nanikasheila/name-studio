// 命令パレット (Ctrl+K): every command found by a few letters of its name,
// with its keys beside it, run with Enter. What cannot be done now shows
// greyed. The commands used last come first.
import { findCommands, usedNow, type Command } from "./commands";
import { element } from "./dom";
import { loadRecentCommands, saveRecentCommands } from "./prefs";

export interface PaletteHost {
  commands(): readonly Command[];
  keysOf(id: string): string[];
  run(command: Command): void;
  status(message: string): void;
}

export class CommandPalette {
  private readonly dialog: HTMLDialogElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private shown: Command[] = [];
  private index = 0;

  constructor(private readonly host: PaletteHost) {
    this.input = element("input", { type: "search", placeholder: "命令を探す（例: 並べ直す、書き出す、連続）", className: "cmdp-input" });
    this.input.setAttribute("aria-label", "命令を探す");
    this.input.setAttribute("aria-controls", "cmdp-list");
    this.list = element("div", { className: "cmdp-list", id: "cmdp-list" });
    this.list.setAttribute("role", "listbox");
    this.dialog = element("dialog", { className: "command-palette", id: "command-palette" }, this.input, this.list);
    document.body.append(this.dialog);
    this.input.addEventListener("input", () => {
      this.index = 0;
      this.render();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        this.index = (this.index + step + this.shown.length) % Math.max(1, this.shown.length);
        this.render();
      } else if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        this.close();
      } else if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        const command = this.shown[this.index];
        if (command) this.choose(command);
      }
    });
    // A click outside the box closes it.
    this.dialog.addEventListener("click", (event) => {
      if (event.target === this.dialog) this.close();
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(): void {
    if (this.dialog.open) return;
    this.input.value = "";
    this.index = 0;
    this.render();
    this.dialog.showModal();
    this.input.focus();
  }

  /** Closes it; the keys go back to the pages, not to the hidden search field. */
  close(): void {
    this.input.blur();
    this.dialog.close();
  }

  private choose(command: Command): void {
    if (command.available && !command.available()) {
      this.host.status(`「${command.label}」はいま使えません`);
      return;
    }
    this.close();
    saveRecentCommands(usedNow(loadRecentCommands(), command.id));
    this.host.run(command);
  }

  private render(): void {
    this.shown = findCommands(this.input.value, this.host.commands(), loadRecentCommands());
    this.index = Math.min(this.index, Math.max(0, this.shown.length - 1));
    const recent = new Set(this.input.value.trim() ? [] : loadRecentCommands());
    const rows = this.shown.map((command, i) => {
      const keys = this.host.keysOf(command.id);
      const row = element(
        "div",
        { className: "cmdp-item", id: `cmdp-item-${i}` },
        element("span", { className: "cmdp-group", textContent: recent.has(command.id) ? "最近" : command.group }),
        element("span", { className: "cmdp-label", textContent: command.label }),
        element("span", { className: "cmdp-keys", textContent: keys.join("  ") }),
      );
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === this.index));
      if (i === this.index) row.classList.add("current");
      if (command.available && !command.available()) row.classList.add("unavailable");
      row.addEventListener("mousemove", () => {
        if (this.index === i) return;
        this.index = i;
        for (const other of this.list.children) other.classList.toggle("current", other === row);
      });
      row.addEventListener("click", () => this.choose(command));
      return row;
    });
    this.list.replaceChildren(...(rows.length ? rows : [element("div", { className: "cmdp-nothing", textContent: "見つかりません" })]));
    this.input.setAttribute("aria-activedescendant", rows.length ? `cmdp-item-${this.index}` : "");
    this.list.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }
}

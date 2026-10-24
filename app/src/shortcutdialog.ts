// The dialog for changing keyboard shortcuts (R16).
import { ACTIONS, comboOf, type ActionId, type Shortcuts } from "./shortcuts";
import { $ } from "./dom";

export class ShortcutDialog {
  /** The action waiting for a key press, if any. */
  private listening: ActionId | null = null;

  constructor(private readonly shortcuts: Shortcuts) {
    $("sc-reset").addEventListener("click", () => {
      this.shortcuts.reset();
      this.message("初期設定に戻しました");
      this.render();
    });
    // While waiting, the next key press is the new shortcut (Escape gives up).
    window.addEventListener(
      "keydown",
      (event) => {
        if (!this.listening || !$<HTMLDialogElement>("shortcut-dialog").open) return;
        event.preventDefault();
        event.stopPropagation();
        const action = this.listening;
        if (event.key === "Escape") {
          this.listening = null;
          this.message("");
          this.render();
          return;
        }
        const combo = comboOf(event);
        if (!combo) return;
        this.listening = null;
        const taken = this.shortcuts.bind(action, combo);
        const label = (id: ActionId) => ACTIONS.find((a) => a.id === id)?.label ?? id;
        this.message(taken ? `${combo} を「${label(taken)}」から外して「${label(action)}」に割り当てました` : `${combo} を「${label(action)}」に割り当てました`);
        this.render();
      },
      { capture: true },
    );
  }

  open(): void {
    this.listening = null;
    this.message("");
    this.render();
    $<HTMLDialogElement>("shortcut-dialog").showModal();
  }

  private render(): void {
    const rows: HTMLElement[] = [];
    let group = "";
    for (const action of ACTIONS) {
      if (action.group !== group) {
        group = action.group;
        rows.push(Object.assign(document.createElement("div"), { className: "sc-group", textContent: group }));
      }
      const keys = document.createElement("span");
      keys.className = "sc-keys";
      for (const combo of this.shortcuts.keys(action.id)) {
        const chip = Object.assign(document.createElement("button"), { type: "button", className: "sc-key", textContent: `${combo} ×`, title: "外す" });
        chip.addEventListener("click", () => {
          this.shortcuts.unbind(action.id, combo);
          this.render();
        });
        keys.append(chip);
      }
      const waiting = this.listening === action.id;
      const add = Object.assign(document.createElement("button"), {
        type: "button",
        className: waiting ? "sc-add waiting" : "sc-add",
        textContent: waiting ? "キーを押す…（Esc でやめる）" : "＋",
        title: "キーを足す",
      });
      add.addEventListener("click", () => {
        this.listening = waiting ? null : action.id;
        this.render();
      });
      const row = document.createElement("div");
      row.className = "sc-row";
      row.append(Object.assign(document.createElement("span"), { className: "sc-label", textContent: action.label }), keys, add);
      rows.push(row);
    }
    $("sc-list").replaceChildren(...rows);
    $<HTMLButtonElement>("sc-reset").disabled = !this.shortcuts.changed();
  }

  private message(text: string): void {
    $("sc-message").textContent = text;
  }
}

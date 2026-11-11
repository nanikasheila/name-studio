// 名前をつけた配置 (as CSP's ワークスペースの登録・管理): the icon at the foot of
// the left icons lists the arrangements of one's own to go to, and keeps the one on screen
// under a name; the dialog names, renames, orders, overwrites and takes them
// away.
import { $, element } from "../platform/dom";
import { openMenu, SEPARATOR, type MenuItem } from "./popupmenu";
import { MAX_MINE, myKey, WORKSPACES, type Workspaces } from "./workspaces";

export class WorkspaceDialog {
  constructor(private readonly workspaces: Workspaces) {
    $("ws-save").addEventListener("click", () => this.save());
    $<HTMLInputElement>("ws-name").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      this.save();
    });
  }

  /** The buttons show which arrangement is in use (after any change). */
  show(): void {
    for (const def of WORKSPACES) {
      const button = $(def.buttonId);
      button.classList.toggle("active", def.id === this.workspaces.current);
      button.setAttribute("aria-pressed", String(def.id === this.workspaces.current));
    }
    const mine = this.workspaces.currentMine;
    const button = $("ws-mine");
    button.classList.toggle("active", mine !== null);
    $("ws-mine-name").textContent = mine ?? "";
    button.title = mine
      ? `名前をつけた配置「${mine}」を使っています。押すとほかの配置へ・上書き・整理`
      : "名前をつけた配置: 今の配置を名前をつけて残す・残した配置に切り替える（CSP のワークスペースのように）";
  }

  private changed(): void {
    this.show();
  }

  /** The icon's menu: the ones of one's own, then naming the one on screen. */
  menu(anchor: HTMLElement): void {
    const box = anchor.getBoundingClientRect();
    const current = this.workspaces.currentMine;
    const items: (MenuItem | typeof SEPARATOR)[] = this.workspaces.mine.map((name) => ({
      label: `${name === current ? "✓ " : ""}${name}`,
      title: `配置「${name}」にする`,
      run: () => {
        this.workspaces.use(myKey(name));
        this.changed();
      },
    }));
    if (items.length) items.push(SEPARATOR);
    items.push(
      {
        label: current ? `「${current}」に今の配置を上書き` : "今の配置に名前をつけて残す…",
        title: current ? "この配置を今の画面のとおりに残し直す" : "欄の並び・ページの見せ方・物語の帯を名前をつけて残す",
        run: () => (current ? this.overwrite(current) : this.open(true)),
      },
      {
        label: "名前をつけた配置の整理…",
        title: "名前を変える・並べ替える・消す",
        run: () => this.open(false),
      },
    );
    openMenu(items, box.right + 2, box.top, "名前をつけた配置");
  }

  /** The dialog (naming: the name box ready to type in). */
  open(naming: boolean): void {
    const input = $<HTMLInputElement>("ws-name");
    input.value = naming ? this.freeName() : "";
    this.render();
    const dialog = $<HTMLDialogElement>("workspace-dialog");
    if (!dialog.open) dialog.showModal();
    if (naming) {
      input.focus();
      input.select();
    }
  }

  private freeName(): string {
    for (let i = 1; ; i++) {
      const name = `自分の配置 ${i}`;
      if (!this.workspaces.mine.includes(name)) return name;
    }
  }

  private save(): void {
    const input = $<HTMLInputElement>("ws-name");
    if (!this.workspaces.saveAs(input.value)) {
      input.focus();
      return;
    }
    input.value = "";
    this.changed();
    this.render();
  }

  private overwrite(name: string): void {
    this.workspaces.saveAs(name);
    this.changed();
    this.render();
  }

  private render(): void {
    const list = $("ws-list");
    const names = this.workspaces.mine;
    const current = this.workspaces.currentMine;
    $<HTMLButtonElement>("ws-save").disabled = names.length >= MAX_MINE;
    if (!names.length) {
      list.replaceChildren(
        element("p", {
          className: "hint",
          textContent: "まだありません。上で名前を入れて残すと、ここと配置のアイコンのメニューに並びます。",
        }),
      );
      return;
    }
    list.replaceChildren(
      ...names.map((name, i) => {
        const field = element("input", { type: "text", value: name, maxLength: 30, title: "名前を変える（Enter か欄の外で決まる）" });
        field.setAttribute("aria-label", `配置「${name}」の名前`);
        field.addEventListener("change", () => {
          if (field.value === name) return;
          if (this.workspaces.rename(name, field.value)) this.changed();
          this.render();
        });
        field.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" || event.isComposing) return;
          event.preventDefault();
          field.blur();
        });
        const button = (label: string, title: string, run: () => void, disabled = false) => {
          const b = element("button", { type: "button", textContent: label, title, disabled });
          b.addEventListener("click", run);
          return b;
        };
        const row = element(
          "div",
          { className: `ws-row${name === current ? " current" : ""}` },
          field,
          button("↑", "上へ", () => (this.workspaces.move(name, -1), this.render()), i === 0),
          button("↓", "下へ", () => (this.workspaces.move(name, 1), this.render()), i === names.length - 1),
          button(
            name === current ? "使用中" : "使う",
            "この配置にする",
            () => {
              this.workspaces.use(myKey(name));
              this.changed();
              this.render();
            },
            name === current,
          ),
          button("上書き", "今の画面のとおりに残し直す", () => this.overwrite(name)),
          button("消す", "この配置を消す（画面はそのまま）", () => {
            this.workspaces.remove(name);
            this.changed();
            this.render();
          }),
        );
        row.dataset.name = name;
        row.lastElementChild?.classList.add("danger");
        return row;
      }),
    );
  }
}

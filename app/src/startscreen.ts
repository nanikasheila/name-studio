// The start screen: open a file, make a new name, or pick up one of the names
// opened last with one click (each also in the command palette, Ctrl+K).
import type { Command } from "./commands";
import { $, element } from "./dom";
import { forgetName, loadRecentNames } from "./prefs";
import { splitPath, whenLabel, type RecentName } from "./recent";

export interface StartHost {
  openFile(): void;
  newName(): void;
  /** Opens a name from the list; false when it could not (moved or deleted), and it leaves the list. */
  openName(path: string): Promise<boolean>;
}

export class StartScreen {
  constructor(private readonly host: StartHost) {
    $("start-open").addEventListener("click", () => host.openFile());
    $("start-new").addEventListener("click", () => host.newName());
  }

  /** Lists the names opened last (again, after one was opened or saved). */
  render(): void {
    const names = loadRecentNames();
    $("start-recent").hidden = names.length === 0;
    $("recent-names").replaceChildren(...names.map((name) => this.row(name)));
  }

  /** The start screen's commands for the palette: open, new, and each recent name. */
  commands(): Command[] {
    const group = "開始";
    return [
      { id: "start.open", label: "開く", group, keys: ["Ctrl+O"], words: "ファイル ひらく", run: () => (this.host.openFile(), true) },
      { id: "start.new", label: "新しいネーム", group, keys: [], words: "あたらしい 白紙 作る", run: () => (this.host.newName(), true) },
      ...loadRecentNames().map((name) => ({
        id: `start.recent:${name.path}`,
        label: `${name.title || splitPath(name.path).name} を開く`,
        group: "最近のネーム",
        keys: [],
        words: splitPath(name.path).name,
        run: () => (void this.open(name.path), true),
      })),
    ];
  }

  private async open(path: string): Promise<void> {
    if (!(await this.host.openName(path))) forgetName(path);
    this.render();
  }

  private row(name: RecentName): HTMLElement {
    const { name: file, folder } = splitPath(name.path);
    const open = element(
      "button",
      { className: "recent-open", title: `開く: ${name.path}` },
      element("span", { className: "recent-title", textContent: name.title || file }),
      element("span", { className: "recent-when", textContent: `${name.pages} ページ ・ ${whenLabel(name.timeMs)}` }),
      element("span", { className: "recent-where", textContent: folder ? `${file} — ${folder}` : file }),
    );
    open.addEventListener("click", () => void this.open(name.path));
    const forget = element("button", { className: "recent-forget", title: "一覧から外す（ファイルは消えません）", textContent: "×" });
    forget.setAttribute("aria-label", `${name.title || file} を一覧から外す`);
    forget.addEventListener("click", () => {
      forgetName(name.path);
      this.render();
    });
    return element("li", { className: "recent-name" }, open, forget);
  }
}

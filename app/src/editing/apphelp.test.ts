import { describe, expect, it } from "vitest";
import { appHelp } from "./apphelp";

const COMMANDS = [
  { id: "tool.pen", label: "ペン", group: "道具" },
  { id: "view.fit", label: "全体を表示", group: "表示" },
  { id: "export.mini", label: "ミニネームを書き出す", group: "書き出し" },
];
const GUIDE = "# 使い方\n\n![絵](images/a.png)\n## コマ割り\n[README](../README.md) を見る。[公式](https://example.com)\n";

describe("appHelp", () => {
  it("lists the tools, the parts of the screen and every command with the keys as set now", () => {
    const keys: Record<string, string[]> = { "tool.pen": ["P"], "view.fit": ["Ctrl+0"] };
    const help = appHelp((id) => keys[id] ?? [], COMMANDS, GUIDE);
    expect(help).toContain("### 選択");
    expect(help).toContain("### 相談（AI）");
    expect(help).toContain("- ペン: P");
    expect(help).toContain("- ミニネームを書き出す: キーなし");
    // A step whose command has a key shows it; the screen's help uses the same words.
    expect(help).toContain("- Ctrl+0: 全体を表示");
  });

  it("follows the keys changed in キー設定", () => {
    const help = appHelp((id) => (id === "view.fit" ? ["Shift+F"] : []), COMMANDS, GUIDE);
    expect(help).toContain("- 全体を表示: Shift+F");
    expect(help).not.toContain("Ctrl+0");
  });

  it("adds the guide without its pictures and local links, or leaves it out", () => {
    const full = appHelp(() => [], COMMANDS, GUIDE);
    expect(full).toContain("# くわしい説明");
    expect(full).toContain("## 使い方");
    expect(full).toContain("README を見る。[公式](https://example.com)");
    expect(full).not.toContain("images/a.png");
    expect(appHelp(() => [], COMMANDS, GUIDE, false)).not.toContain("くわしい説明");
  });
});

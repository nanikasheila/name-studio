import { describe, expect, it } from "vitest";
import { findCommands, searchText, usedNow, RECENT_COMMANDS, type Command } from "./commands";

const command = (id: string, label: string, group = "編集", keys: string[] = [], words?: string): Command => ({ id, label, group, keys, words, run: () => true });

const LIST = [
  command("save", "保存", "ファイル", ["Ctrl+S"]),
  command("export", "書き出す…（CSP・PDF・台本）", "ファイル", [], "エクスポート clip pdf"),
  command("arrange", "このページのセリフを並べ直す", "ページ", [], "読む順 整列"),
  command("pen", "ペン", "道具", ["P"], "ラフ"),
  command("continuous", "連続（全ページを一枚のキャンバスに）と見開きを切り替える", "画面", ["F7"]),
];
const ids = (query: string, recent: string[] = []) => findCommands(query, LIST, recent).map((c) => c.id);

describe("命令パレット", () => {
  it("compares text without width, case, kana or spaces mattering", () => {
    expect(searchText("ＰＤＦ ペン")).toBe("pdfぺん");
    expect(searchText("Ctrl+S")).toBe("ctrl+s");
  });

  it("finds commands by their label, group, other words and keys", () => {
    expect(ids("ぺん")).toEqual(["pen"]);
    expect(ids("pdf")).toEqual(["export"]);
    expect(ids("ファイル")).toEqual(["save", "export"]);
    expect(ids("f7")).toEqual(["continuous"]);
    expect(ids("整列")).toEqual(["arrange"]);
  });

  it("puts labels that begin with the words first, then those that hold them, then the rest", () => {
    const list = [command("a", "セリフを書く"), command("b", "このページのセリフを並べ直す"), command("c", "台本", "セリフ")];
    expect(findCommands("セリフ", list).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("needs every word, and takes the label's characters in order", () => {
    expect(ids("ページ 並べ")).toEqual(["arrange"]);
    expect(ids("ページ 保存")).toEqual([]);
    expect(ids("せり並べ")).toEqual(["arrange"]);
    expect(ids("れき")).toEqual([]);
  });

  it("leads with the recently used ones", () => {
    expect(ids("", ["pen", "arrange"])).toEqual(["pen", "arrange", "save", "export", "continuous"]);
    expect(ids("ファイル", ["export"])).toEqual(["export", "save"]);
    const recent = Array.from({ length: RECENT_COMMANDS }, (_, i) => `c${i}`);
    expect(usedNow(recent, "c3")[0]).toBe("c3");
    expect(usedNow(recent, "new")).toHaveLength(RECENT_COMMANDS);
    expect(usedNow(recent, "new")).not.toContain(`c${RECENT_COMMANDS - 1}`);
  });
});

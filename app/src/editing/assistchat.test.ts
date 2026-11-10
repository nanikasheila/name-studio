import { describe, expect, it } from "vitest";
import {
  type AiModel,
  Conversation,
  changedPrompt,
  choiceProblem,
  firstPrompt,
  modelFor,
  orderTalks,
  readAssistSettings,
  readSavedTalk,
  talkTitle,
} from "./assistchat";

const model = (value: string, efforts: string[], isDefault = false): AiModel => ({
  value,
  label: value || "Default",
  description: "",
  efforts,
  defaultEffort: null,
  isDefault,
});
const claude = [model("", ["low", "high", "max"], true), model("opus", ["low", "medium", "high", "xhigh", "max"]), model("legacy", [])];
const codex = [model("gpt-a", ["low", "high"], true), model("gpt-b", ["medium"])];

describe("choosing a model and its effort from the tool's own list", () => {
  it("finds the model, and the tool's default for none", () => {
    expect(modelFor(claude, "opus")?.value).toBe("opus");
    expect(modelFor(claude, "")?.isDefault).toBe(true);
    expect(modelFor(codex, "")?.value).toBe("gpt-a");
    expect(modelFor(codex, "gpt-z")).toBeUndefined();
  });

  it("says what is wrong with a model or an effort not in the list", () => {
    expect(choiceProblem(claude, "opus", "xhigh")).toBeNull();
    expect(choiceProblem(claude, "", "")).toBeNull();
    expect(choiceProblem(codex, "gpt-b", "")).toBeNull();
    expect(choiceProblem(claude, "opsu", "")).toContain("「opsu」は一覧にありません");
    expect(choiceProblem(claude, "", "xhigh")).toContain("effort「xhigh」を選べません");
    expect(choiceProblem(codex, "gpt-b", "high")).toContain("medium");
    expect(choiceProblem(claude, "legacy", "low")).toContain("選べるものなし");
  });

  it("keeps the efforts chosen", () => {
    const kept = readAssistSettings({ claudeEffort: "high", codexEffort: 3 });
    expect(kept.claudeEffort).toBe("high");
    expect(kept.codexEffort).toBe("");
  });
});

describe("the question as Claude Code and Codex get it", () => {
  it("carries the name's brief, so they have it even when they cannot read files", () => {
    const first = firstPrompt("ここで詰まった", [3], "# ネーム\n[line9] 星");
    expect(first).toContain("<ネームの要約>\n# ネーム\n[line9] 星\n</ネームの要約>");
    expect(first).toContain("p3");
    expect(first.endsWith("作者の相談:\nここで詰まった")).toBe(true);
    const changed = changedPrompt("次は？", [], "# 新しいネーム");
    expect(changed).toContain("新しい要約");
    expect(changed).toContain("# 新しいネーム");
  });

  it("keeps the chosen Codex sandbox", () => {
    expect(readAssistSettings({ codexSandbox: "config" }).codexSandbox).toBe("config");
    expect(readAssistSettings({}).codexSandbox).toBe("");
  });
});

describe("kept conversations", () => {
  it("are named by the first question and read back only when whole", () => {
    expect(talkTitle([{ role: "user", text: "  1ページの\n間を相談  " }])).toBe("1ページの 間を相談");
    expect(talkTitle([{ role: "user", text: "あ".repeat(50) }])).toHaveLength(40);
    const talk = readSavedTalk({
      id: "t-1",
      kind: "codex",
      name: "a.namestudio",
      created: 1,
      updated: 2,
      session: "019c",
      dir: "C:\\s",
      entries: [
        { role: "user", text: "q" },
        { role: "nope", text: "x" },
        { role: "assistant", text: "a" },
      ],
      applied: ["1:1", 3],
    });
    expect(talk?.entries).toEqual([
      { role: "user", text: "q" },
      { role: "assistant", text: "a" },
    ]);
    expect(talk?.title).toBe("q");
    expect(talk?.applied).toEqual(["1:1"]);
    expect(readSavedTalk({ id: "t-1", kind: "gpt", entries: [] })).toBeNull();
    expect(readSavedTalk(null)).toBeNull();
    const restored = Conversation.restore(talk!);
    expect(restored.session).toBe("019c");
    expect(restored.history()).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("list this name's first, newest first", () => {
    const summary = (id: string, name: string, updated: number) => ({
      id,
      kind: "claude" as const,
      name,
      title: id,
      created: 0,
      updated,
      count: 1,
    });
    expect(orderTalks([summary("a", "x", 3), summary("b", "me", 1), summary("c", "me", 2)], "me").map((talk) => talk.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
});

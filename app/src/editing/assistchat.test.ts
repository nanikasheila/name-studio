import { describe, expect, it } from "vitest";
import {
  type AiModel,
  Conversation,
  changedPrompt,
  chatTurns,
  choiceProblem,
  firstPrompt,
  modelFor,
  orderTalks,
  readAssistSettings,
  readSavedTalk,
  stepsSummary,
  talkTitle,
  toolStep,
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

describe("what the AI did, as the conversation shows it", () => {
  it("says a step in words, with the command as it ran", () => {
    expect(toolStep("Read: ネーム.md")).toEqual({ label: "ネームの要約を読みました", detail: "ネーム.md" });
    const pwsh = toolStep(
      `command: "C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Microsoft\\\\WindowsApps\\\\pwsh.exe" -Command "Get-Content -LiteralPath 'C:/Users/me/AppData/Local/com.x/ai-sessions/session-17/.agents/skills/name-studio/SKILL.md' -Raw"`,
    );
    expect(pwsh).toEqual({
      label: "スキルの説明を読みました",
      detail: "Get-Content -LiteralPath '.agents/skills/name-studio/SKILL.md' -Raw",
    });
    expect(toolStep("command: node .claude/skills/name-studio/scripts/namestudio.mjs brief ネーム.namestudio --pages 3-5")?.label).toBe(
      "ネームの写しを読みました（p3-5）",
    );
    expect(toolStep("Bash: node .claude/skills/name-studio/scripts/namestudio.mjs apply ネーム.namestudio ops.json --dry-run")?.label).toBe(
      "変更の案を試しました",
    );
    expect(toolStep("Read: C:\\data\\ai-sessions\\s\\pages\\p003.png")?.label).toBe("p3 の絵を見ました");
    expect(toolStep("Glob: pages/*.png")?.label).toBe("フォルダーの中を調べました");
    expect(toolStep("command: bash -lc ls")).toEqual({ label: "フォルダーの中を調べました", detail: "ls" });
    expect(toolStep("Read: memo.txt")?.label).toBe("memo.txt を読みました");
    expect(toolStep("TodoWrite")?.label).toBe("TodoWrite を使いました");
  });

  it("leaves what is not a step (a note to the user) to be shown as it is", () => {
    expect(toolStep("Codex のサンドボックスがコマンドを動かせません（setup refresh had errors など）。")).toBeNull();
  });

  it("cuts the conversation into questions and replies, the steps in a row as one group", () => {
    const turns = chatTurns([
      { role: "user", text: "4〜5ページは？" },
      { role: "assistant", text: "読みますね。" },
      { role: "tool", text: "Read: ネーム.md" },
      { role: "tool", text: "Read: SKILL.md" },
      { role: "tool", text: "Read: ネーム.md" },
      { role: "assistant", text: "こう思います。" },
      { role: "tool", text: "サンドボックスが動きません。" },
      { role: "error", text: "止まりました" },
      { role: "user", text: "次は？" },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].question).toEqual({ text: "4〜5ページは？", index: 0 });
    expect(turns[0].reply.map((piece) => piece.kind)).toEqual(["text", "steps", "text", "notice", "error"]);
    const steps = turns[0].reply[1];
    expect(steps.kind === "steps" && steps.steps.length).toBe(3);
    expect(steps.kind === "steps" && stepsSummary(steps.steps)).toBe("ネームの要約を読みました・スキルの説明を読みました");
    expect(turns[0].reply[2]).toEqual({ kind: "text", text: "こう思います。", index: 5 });
    expect(turns[1]).toEqual({ question: { text: "次は？", index: 8 }, reply: [] });
    expect(chatTurns([{ role: "assistant", text: "前の続き" }])[0].question).toBeNull();
  });
});

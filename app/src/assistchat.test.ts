import { describe, expect, it } from "vitest";
import { type AiModel, choiceProblem, modelFor, readAssistSettings } from "./assistchat";

const model = (value: string, efforts: string[], isDefault = false): AiModel => ({ value, label: value || "Default", description: "", efforts, defaultEffort: null, isDefault });
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

import { describe, expect, it } from "vitest";
import { scriptText } from "./nameexport";
import { addCharacter, addLine, addPanel, addScene, newProject, rectShape } from "./project";
import { applyScript, panelBoxes, parseScript, readLine } from "./scriptimport";

const MARKDOWN = `# 星の約束

## 出会い

### 1ページ
夜の屋上。
#### コマ1 引きの絵
- ミカ「今日も星が見えないね」
- **ソラ**：見えなくても、あるよ
#### コマ2
ソラ（言えなかった）
ナレーション：その夜、二人は約束をした
SE：ガチャ

### 2ページ
[1] 「誰？」

## 別れ

### 3ページ
ミカ『またね』
`;

describe("台本の取り込み", () => {
  it("reads dialogue lines", () => {
    expect(readLine("ミカ「今日も」")).toEqual({ speaker: "ミカ", kind: "speech", text: "今日も" });
    expect(readLine("ソラ（言えない）")).toEqual({ speaker: "ソラ", kind: "thought", text: "言えない" });
    expect(readLine("ソラ: うん")).toEqual({ speaker: "ソラ", kind: "speech", text: "うん" });
    expect(readLine("N：その夜")).toEqual({ kind: "narration", text: "その夜" });
    expect(readLine("擬音：ドン")).toEqual({ kind: "sfx", text: "ドン" });
    expect(readLine("「誰？」")).toEqual({ kind: "speech", text: "誰？" });
    expect(readLine("（静かな夜）")).toBeNull();
    expect(readLine("夜の屋上。")).toBeNull();
    expect(readLine("ト書き：雨")).toBeNull();
  });

  it("reads pages, panels and scenes from Markdown", () => {
    const doc = parseScript(MARKDOWN);
    expect(doc.title).toBe("星の約束");
    expect(doc.pages.length).toBe(3);
    const [first, second, third] = doc.pages;
    expect(first.scene).toBe("出会い");
    expect(first.notes).toEqual(["夜の屋上。"]);
    expect(first.panels.length).toBe(2);
    expect(first.panels[0].notes).toEqual(["引きの絵"]);
    expect(first.panels[0].lines.map((l) => l.speaker)).toEqual(["ミカ", "ソラ"]);
    expect(first.panels[1].lines.map((l) => l.kind)).toEqual(["thought", "narration", "sfx"]);
    expect(second.scene).toBeUndefined();
    expect(second.panels[0].lines[0].text).toBe("誰？");
    expect(third.scene).toBe("別れ");
    expect(doc.warnings).toEqual([]);
  });

  it("deals the script out onto pages and panels", () => {
    const project = newProject("新しいネーム", 2);
    const report = applyScript(project, parseScript(MARKDOWN), { startPage: 0, makePanels: true });
    expect(report).toEqual({ pages: 3, panels: 4, lines: 7, characters: ["ミカ", "ソラ"], scenes: 2 });
    expect(project.title).toBe("星の約束");
    expect(project.pages.length).toBe(3);
    const page = project.pages[0];
    expect(page.memo).toBe("夜の屋上。");
    expect(page.panels.length).toBe(2);
    expect(page.panels[0].note).toBe("引きの絵");
    // Each line sits in its panel, first panel first.
    expect(page.lines.map((line) => page.panels.find((p) => p.id === line.panel)?.order)).toEqual([1, 1, 2, 2, 2]);
    const mika = project.characters.find((c) => c.name === "ミカ")!;
    expect(page.lines[0].speaker).toBe(mika.id);
    expect(project.scenes.map((s) => [s.title, s.firstPage, s.lastPage])).toEqual([
      ["出会い", project.pages[0].id, project.pages[1].id],
      ["別れ", project.pages[2].id, project.pages[2].id],
    ]);
  });

  it("uses the panels a page already has and known characters", () => {
    const project = newProject("t", 1);
    const mika = addCharacter(project, "ミカ");
    const page = project.pages[0];
    addPanel(project, page, rectShape([20, 20, 120, 120]));
    const report = applyScript(project, parseScript("### 1\n- コマ1\n- ミカ「a」\n- コマ2\n- ミカ「b」"), { startPage: 0, makePanels: true });
    expect(report.characters).toEqual([]);
    expect(page.panels.length).toBe(1);
    expect(page.lines.every((line) => line.speaker === mika.id && line.panel === page.panels[0].id)).toBe(true);
  });

  it("reads back the script the app writes", () => {
    const project = newProject("作品", 2);
    const hero = addCharacter(project, "主人公");
    const page = project.pages[0];
    addPanel(project, page, rectShape([20, 20, 120, 120]));
    const line = addLine(project, page, [60, 60], "こんにちは");
    line.speaker = hero.id;
    addLine(project, project.pages[1], [60, 60], "静かだ", "narration");
    addScene(project, page.id, project.pages[1].id, "始まり");
    const doc = parseScript(scriptText(project));
    expect(doc.pages.length).toBe(2);
    expect(doc.pages[0].scene).toBe("始まり");
    expect(doc.pages[0].panels[0].lines).toEqual([{ speaker: "主人公", kind: "speech", text: "こんにちは" }]);
    expect(doc.pages[1].panels[0].lines).toEqual([{ kind: "narration", text: "静かだ" }]);
  });

  it("lays panels out in tiers, two across past four", () => {
    expect(panelBoxes([0, 0, 100, 100], 1)).toEqual([[0, 0, 100, 100]]);
    expect(panelBoxes([0, 0, 100, 106], 2, { across: 2, down: 6 })).toEqual([[0, 0, 100, 50], [0, 56, 100, 106]]);
    const five = panelBoxes([0, 0, 102, 100], 5, { across: 2, down: 5 });
    expect(five.length).toBe(5);
    // First row: two panels, the first one on the right.
    expect(five[0][0]).toBeGreaterThan(five[1][0]);
  });
});

import { describe, expect, it } from "vitest";
import { scriptText } from "./nameexport";
import { addCharacter, addLine, addPanel, addScene, basicBox, moveLine, newProject, rectShape } from "./project";
import { applyScript, findPattern, likeness, panelBoxes, parseScript, readLine } from "./scriptimport";
import { applyPlot, parsePlot } from "./plotimport";

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
    expect(report).toEqual({ pages: 3, panels: 4, lines: 7, characters: ["ミカ", "ソラ"], scenes: 2, replacedScenes: 0, insertedPages: 0, leftPages: [], kept: 0, changed: 0, added: 0, removed: 0 });
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

  it("reads a line of dialogue before the first page heading", () => {
    const doc = parseScript("更新：10月14日\n### 1ページ\nミカ「星だ」\n");
    expect(doc.pages[0].panels[0].lines).toEqual([{ speaker: "更新", kind: "speech", text: "10月14日" }]);
    expect(doc.pages[1].panels[0].lines[0].text).toBe("星だ");
  });
});

describe("台本の取り込み: 第4話の試作から", () => {
  it("breaks long lines and keeps each in its script panel", () => {
    const project = newProject("t", 1);
    const long = "数か月前、この街の空から星がひとつ消えたことを、まだ誰も知らない。";
    const script = `### 1ページ\n- コマ1\n- ナレーション：${long}\n- コマ2\n- ストラ「はい」\n- コマ3\n- エイコ「${long}」`;
    applyScript(project, parseScript(script), { startPage: 0, makePanels: true });
    const page = project.pages[0];
    expect(page.panels.length).toBe(3);
    expect(page.lines[0].text).toContain("\n");
    expect(page.lines[0].text.replace(/\n/g, "")).toBe(long);
    // Each line in the panel the script put it in, by its centre.
    expect(page.lines.map((line) => page.panels.find((p) => p.id === line.panel)?.order)).toEqual([1, 2, 3]);
  });

  it("puts the page heading's subtitle into the page memo", () => {
    const doc = parseScript("### 1ページ 心臓の説明\n- コマ1\n- ストラ「はい」\n### 2ページ\n- ストラ「うん」");
    expect(doc.pages[0].notes).toEqual(["心臓の説明"]);
    expect(doc.pages[1].notes).toEqual([]);
  });

  it("reads balloon tags and shouts", () => {
    expect(readLine("叔母〔電話〕「もしもし」")).toEqual({ speaker: "叔母", kind: "speech", text: "もしもし", shape: "electric" });
    expect(readLine("叔母（電話）「もしもし」")).toEqual({ speaker: "叔母", kind: "speech", text: "もしもし", shape: "electric" });
    expect(readLine("局長〔無線〕：応答せよ")).toEqual({ speaker: "局長", kind: "speech", text: "応答せよ", shape: "electric" });
    expect(readLine("ストラ〔独白〕「どうしよう」")).toEqual({ speaker: "ストラ", kind: "thought", text: "どうしよう" });
    expect(readLine("ニイ「待てーっ！！」")).toEqual({ speaker: "ニイ", kind: "speech", text: "待てーっ！！", shape: "spike" });
    expect(readLine("ストラ（どうしよう）")).toEqual({ speaker: "ストラ", kind: "thought", text: "どうしよう" });
  });

  it("gives new lines the work's usual shape for their kind", () => {
    const project = newProject("t", 1);
    project.lineShapes = { thought: "polygon" };
    applyScript(project, parseScript("### 1\n- ストラ（どうしよう）\n- 叔母〔電話〕「もしもし」"), { startPage: 0, makePanels: true });
    const [thought, phone] = project.pages[0].lines;
    expect(thought.balloonShape).toBe("polygon");
    expect(phone.balloonShape).toBe("electric");
  });
});

describe("台本の取り込み: プロットのあとに", () => {
  it("takes the place of the plot's scenes it overlaps, keeping a same-page summary", () => {
    const project = newProject("t", 3);
    applyPlot(project, parsePlot("## ページ配分\n\n| 1〜2 | 2 | 屋上で出会う |\n| 3 | 1 | 別れ |\n\n### 1ページ 屋上\n\n夜。\n"));
    expect(project.scenes).toHaveLength(2);
    const report = applyScript(project, parseScript(MARKDOWN), { startPage: 0, makePanels: true });
    // 別れ is the very same scene: not counted.
    expect(report.replacedScenes).toBe(1);
    expect(project.scenes.map((s) => [s.title, s.summary])).toEqual([
      ["出会い", "屋上で出会う"],
      ["別れ", "別れ"],
    ]);
  });
});

describe("台本を直して取り込み直す", () => {
  it("changes only what changed, keeping where lines are, their shape and tails", () => {
    const project = newProject("新しいネーム", 3);
    applyScript(project, parseScript(MARKDOWN), { startPage: 0, makePanels: true });
    const page = project.pages[0];
    const [first, second] = page.lines;
    first.tails = [{ tip: [60, 150] }];
    first.balloonShape = "wavy";
    moveLine(second, -5, 8);
    const where = second.box.slice();
    const revised = MARKDOWN.replace("ミカ「今日も星が見えないね」", "ミカ「今夜も星が見えないね」").replace("SE：ガチャ", "ソラ「ねえ」").replace("[1] 「誰？」", "[1] 「誰？」\n「わたしだよ」");
    const report = applyScript(project, parseScript(revised), { startPage: 0, makePanels: true, update: true });
    expect([report.changed, report.added, report.removed, report.kept]).toEqual([1, 2, 1, 5]);
    expect(project.pages.reduce((n, p) => n + p.lines.length, 0)).toBe(8);
    expect(first.text.replace(/\n/g, "")).toBe("今夜も星が見えないね");
    expect(first.tails).toHaveLength(1);
    expect(first.balloonShape).toBe("wavy");
    expect(second.box).toEqual(where);
    expect(page.lines.some((line) => line.text === "ガチャ")).toBe(false);
    const added = project.pages[1].lines.find((line) => line.text === "わたしだよ")!;
    expect(added.panel).toBe(project.pages[1].lines[0].panel);
    // Not doubled: the memo, nor the lines when taken in once more.
    expect(page.memo).toBe("夜の屋上。");
    const again = applyScript(project, parseScript(revised), { startPage: 0, makePanels: true, update: true });
    expect([again.changed, again.added, again.removed, again.kept]).toEqual([0, 0, 0, 8]);
  });

  it("takes back the script the app writes without changing anything", () => {
    const project = newProject("新しいネーム", 3);
    applyScript(project, parseScript(MARKDOWN), { startPage: 0, makePanels: true });
    // Panel 1 of page 1 with nothing in it: the text skips it (［2］ first).
    project.pages[0].lines = project.pages[0].lines.filter((line) => line.panel !== project.pages[0].panels.find((p) => p.order === 1)!.id);
    project.pages[0].panels[0].note = "";
    const text = scriptText(project);
    expect(text).toContain("［2］");
    const report = applyScript(project, parseScript(text), { startPage: 0, makePanels: true, update: true });
    expect([report.changed, report.added, report.removed]).toEqual([0, 0, 0]);
  });

  it("finds each page again when the script puts a page in or takes one out", () => {
    const project = newProject("新しいネーム", 3);
    applyScript(project, parseScript(MARKDOWN), { startPage: 0, makePanels: true });
    const [p1, p2, p3] = project.pages;
    const ids = project.pages.flatMap((page) => page.lines.map((line) => line.id));
    // A new page 2; the old 2 and 3 are now 3 and 4.
    const revised = MARKDOWN.replace("### 2ページ", "### 2ページ\n[1] ミカ「待って」\n\n### 3ページ").replace("### 3ページ\nミカ『またね』", "### 4ページ\nミカ『またね』");
    const report = applyScript(project, parseScript(revised), { startPage: 0, makePanels: true, update: true });
    expect(report.insertedPages).toBe(1);
    expect([report.changed, report.added, report.removed]).toEqual([0, 0, 0]);
    expect(project.pages.map((page) => page.id)).toEqual([p1.id, project.pages[1].id, p2.id, p3.id]);
    expect(project.pages[1].lines.map((line) => line.text)).toEqual(["待って"]);
    expect(project.pages.flatMap((page) => page.lines.map((line) => line.id)).filter((id) => ids.includes(id))).toEqual(ids);
    // The script without its page 2 again: that page is left as it is, the others found.
    const back = applyScript(project, parseScript(MARKDOWN), { startPage: 0, makePanels: true, update: true });
    expect([back.insertedPages, back.changed, back.added, back.removed]).toEqual([0, 0, 0, 0]);
    expect(back.leftPages).toEqual([2]);
  });

  it("reads the page number of a page heading", () => {
    expect(parseScript("### 5ページ 電話\n#### コマ\nA「もしもし」\n### P6\nB「はい」").pages.map((p) => p.number)).toEqual([5, 6]);
  });

  it("tells how alike two lines read", () => {
    expect(likeness("今日も星が\n見えないね", "今日も星が見えないね")).toBe(1);
    expect(likeness("今日も星が見えないね", "今夜も星が見えないね")).toBeGreaterThan(0.6);
    expect(likeness("今日も星が見えないね", "ガチャ")).toBe(0);
  });
});

describe("台本でコマ割りの型", () => {
  it("reads 型： lines and fits the pattern to the page's panels", () => {
    expect(findPattern("導入")).toBe("opening");
    expect(findPattern("大ゴマ＋はめ込み")).toBe("bigInset");
    expect(findPattern("3段")).toBe("three");
    expect(findPattern("大きく")).toBeUndefined();
    const script = [
      "### 1ページ",
      "型：導入",
      "- コマ1",
      "- ミカ「a」",
      "- コマ2",
      "- ミカ「b」",
      "- コマ3",
      "- ミカ「c」",
      "### 2ページ",
      "- コマ1",
      "- ミカ「d」",
      "- コマ2",
      "- ミカ「e」",
    ].join("\n");
    const doc = parseScript(script);
    expect(doc.pages.map((page) => page.pattern)).toEqual(["opening", undefined]);
    expect(doc.pages[0].notes).toEqual([]);
    const project = newProject("t", 1);
    applyScript(project, doc, { startPage: 0, makePanels: true, pattern: "three" });
    expect(project.pages[0].panels.length).toBe(3);
    // 導入: the first panel bleeds off the top.
    const first = [...project.pages[0].panels].sort((a, b) => a.order - b.order)[0];
    expect(Math.min(...first.shape.map(([, y]) => y))).toBeLessThan(basicBox(project.pageFormat)[1] - 1);
    expect(project.pages[1].panels.length).toBe(2);
    for (const page of project.pages) {
      for (const line of page.lines) expect(line.panel).toBeDefined();
    }
  });
});

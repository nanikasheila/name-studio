/// <reference types="vite/client" />
import FULL_PROJECT from "../../../crates/name-model/tests/fixtures/full-project.json?raw";
import { describe, expect, it } from "vitest";
import { applyOps, nameBrief, OPS_GUIDE, opsBlocks, opsGuide, parseOps, previewOps, type AssistOp } from "./assist";
import { balloonExtent } from "./balloon";
import { boxCenter, insidePolygon } from "../model/geometry";
import type { Project } from "../model/model";
import { newProject, normalize } from "./project";
import { validate } from "./validate";

const SCRIPT = `# 屋上の約束
## 出会い
### 1ページ
夜の屋上。
#### コマ1
ミカ「今日も星が見えないね」
#### コマ2
ソラ「見えなくても、あるよ」
### 2ページ
#### コマ1
ミカ（言えなかった）
`;

function drafted(): Project {
  const project = newProject("新しいネーム", 4);
  const result = applyOps(project, [{ op: "script", text: SCRIPT }]);
  expect(result.problems).toEqual([]);
  return project;
}

const ids = (project: Project) => project.pages.flatMap((page) => page.lines.map((line) => line.id));

describe("validate", () => {
  it("passes the name the Rust side's full fixture holds", () => {
    const project = normalize(JSON.parse(FULL_PROJECT)) as Project;
    // Its one line is joined to a line it does not have (it only shows every field).
    delete project.pages[0].lines[0].linkTo;
    expect(validate(project)).toEqual([]);
  });

  it("finds what the Rust side refuses", () => {
    const project = drafted();
    project.pages[1].id = project.pages[0].id;
    project.emotions.push({ character: "nobody", page: project.pages[0].id, value: 2, note: "" });
    project.nextId = 1;
    const problems = validate(project);
    expect(problems.some((p) => p.includes("重複"))).toBe(true);
    expect(problems.some((p) => p.includes("登場人物 nobody"))).toBe(true);
    expect(problems.some((p) => p.includes("-1〜1"))).toBe(true);
    expect(problems.some((p) => p.startsWith("next_id 1"))).toBe(true);
  });
});

describe("nameBrief", () => {
  it("shows the story, the panels in reading order and the dialogue with its ids", () => {
    const project = drafted();
    const brief = nameBrief(project, { current: [1] });
    expect(brief).toContain("# ネーム「屋上の約束」");
    expect(brief).toContain("右綴じ");
    expect(brief).toContain("- ミカ（character");
    expect(brief).toContain("p1〜p2「出会い」");
    expect(brief).toContain("### p1（いま開いているページ）");
    expect(brief).toContain("メモ: 夜の屋上。");
    const first = project.pages[0].lines[0];
    expect(brief).toContain(`[${first.id}] ミカ「今日も星が見えないね」`);
    expect(brief.indexOf("コマ1（")).toBeLessThan(brief.indexOf("コマ2（"));
    expect(brief).toMatch(/\[line\d+\]（モノローグ[^）]*） ミカ「言えなかった」/);
    expect(brief).toContain("（コマもセリフもまだない）");
  });

  it("gives pages outside the range one line each", () => {
    const brief = nameBrief(drafted(), { pages: [2, 2] });
    expect(brief).toMatch(/^- p1: コマ 2・セリフ 2/m);
    expect(brief).toContain("### p2");
    expect(brief).not.toContain("### p1");
  });
});

describe("parseOps", () => {
  it("reads an array, { ops }, or one per line", () => {
    expect(parseOps('[{"op":"setTitle","title":"A"}]').ops).toHaveLength(1);
    expect(parseOps('{"ops":[{"op":"setTitle","title":"A"},{"op":"removeLine","line":"line3"}]}').ops).toHaveLength(2);
    expect(parseOps('{"op":"setTitle","title":"A"}\n{"op":"setTitle","title":"B"}').ops).toHaveLength(2);
  });

  it("tells unknown operations and missing fields", () => {
    const { ops, problems } = parseOps('[{"op":"fly"},{"op":"addLine","page":1},{"op":"setTitle","title":"ok"}]');
    expect(ops).toHaveLength(1);
    expect(problems).toEqual(["1 番目: 知らない操作 fly", '2 番目（addLine）: "text" がありません']);
    expect(parseOps("not json").problems[0]).toMatch(/JSON として読めません/);
  });

  it("finds the proposals in a reply", () => {
    const reply = '案です。\n```namestudio-ops\n[{"op":"setTitle","title":"A"}]\n```\nほかに\n```json\n{}\n```\n```namestudio-ops\n[]\n```';
    expect(opsBlocks(reply)).toEqual(['[{"op":"setTitle","title":"A"}]', "[]"]);
  });

  it("explains every operation", () => {
    const guide = opsGuide();
    for (const name of Object.keys(OPS_GUIDE)) expect(guide).toContain(`- ${name}: `);
  });
});

describe("applyOps", () => {
  it("pours a script into panels made for it", () => {
    const project = drafted();
    expect(project.title).toBe("屋上の約束");
    expect(project.pages[0].panels).toHaveLength(2);
    expect(project.pages[0].lines.map((l) => l.text.replace(/\n/g, ""))).toEqual(["今日も星が見えないね", "見えなくても、あるよ"]);
    expect(project.characters.map((c) => c.name)).toEqual(["ミカ", "ソラ"]);
    expect(validate(project)).toEqual([]);
  });

  it("adds a line in its panel after the ones there, with a new speaker in the cast", () => {
    const project = drafted();
    const page = project.pages[0];
    const panel = [...page.panels].sort((a, b) => a.order - b.order)[1];
    const result = applyOps(project, [{ op: "addLine", page: 1, panel: 2, speaker: "先生", text: "こら、何してる" }]);
    expect(result.problems).toEqual([]);
    expect(result.done[0]).toBe("人物「先生」を足しました");
    const line = page.lines.find((l) => l.text.replace(/\n/g, "") === "こら、何してる")!;
    expect(line.panel).toBe(panel.id);
    expect(project.characters.find((c) => c.id === line.speaker)?.name).toBe("先生");
    expect(insidePolygon(panel.shape, boxCenter(balloonExtent(line)))).toBe(true);
  });

  it("changes, retypes and removes lines by id", () => {
    const project = drafted();
    const [a, b] = project.pages[0].lines;
    const result = applyOps(project, [
      { op: "setLine", line: a.id, text: "星、見えないね", kind: "thought" },
      { op: "setLine", line: b.id, speaker: null, shape: "spike" },
      { op: "removeLine", line: project.pages[1].lines[0].id },
    ]);
    expect(result.problems).toEqual([]);
    expect(a.text.replace(/\n/g, "")).toBe("星、見えないね");
    expect(a.kind).toBe("thought");
    expect(b.speaker).toBeUndefined();
    expect(b.balloonShape).toBe("spike");
    expect(project.pages[1].lines).toHaveLength(0);
  });

  it("re-splits a page, the dialogue going along to the new panels", () => {
    const project = drafted();
    const before = ids(project);
    const result = applyOps(project, [{ op: "panels", page: 1, pattern: "basic4" }]);
    expect(result.problems).toEqual([]);
    const page = project.pages[0];
    expect(page.panels.length).toBeGreaterThan(2);
    expect(ids(project)).toEqual(before);
    const firstPanel = [...page.panels].sort((x, y) => x.order - y.order)[0];
    expect(page.lines[0].panel).toBe(firstPanel.id);
    applyOps(project, [{ op: "panels", page: 3, count: 3 }]);
    expect(project.pages[2].panels).toHaveLength(3);
    expect(validate(project)).toEqual([]);
  });

  it("adds, moves and deletes pages; memos, notes and stickies", () => {
    const project = drafted();
    const second = project.pages[1].id;
    const result = applyOps(project, [
      { op: "addPages", after: 1, count: 2, memos: ["引きの風景", "回想"] },
      { op: "setPageMemo", page: 2, memo: "朝", append: true },
      { op: "setPanelNote", page: 1, panel: 2, note: "アップで" },
      { op: "addSticky", page: 1, panel: 1, text: "ここは間を取りたい" },
      { op: "movePage", page: 3, to: 6 },
      { op: "deletePages", pages: [5] },
    ]);
    expect(result.problems).toEqual([]);
    expect(project.pages).toHaveLength(5);
    expect(project.pages[1].memo).toBe("引きの風景\n朝");
    expect(project.pages[2].id).toBe(second);
    expect(project.pages[4].memo).toBe("回想");
    const page = project.pages[0];
    expect([...page.panels].sort((a, b) => a.order - b.order)[1].note).toBe("アップで");
    expect(page.stickies?.[0].link?.kind).toBe("panel");
    expect(validate(project)).toEqual([]);
  });

  it("sets the story: scenes, emotions, characters and the plan", () => {
    const project = drafted();
    const result = applyOps(project, [
      { op: "setScene", title: "約束", firstPage: 3, lastPage: 4, summary: "二人が約束する", storyTime: "夜" },
      { op: "addCharacter", name: "先生", tone: "ぶっきらぼう" },
      { op: "setCharacter", character: "ミカ", tone: "明るい" },
      { op: "setEmotion", character: "ミカ", page: 2, value: -0.5, note: "言えない" },
      { op: "setPlan", targetPages: 8, structure: "kishotenketsu" },
    ]);
    expect(result.problems).toEqual([]);
    expect(project.scenes.map((s) => s.title)).toEqual(["出会い", "約束"]);
    expect(project.scenes[1].storyTime).toBe("夜");
    expect(project.characters.find((c) => c.name === "ミカ")?.tone).toBe("明るい");
    expect(project.emotions[0]).toMatchObject({ value: -0.5, note: "言えない" });
    expect(project.plan).toEqual({ targetPages: 8, structure: "kishotenketsu" });
    expect(nameBrief(project)).toContain("目標 8 ページ・話の型: 起承転結");
    expect(validate(project)).toEqual([]);
  });

  it("leaves out what cannot be done and says why", () => {
    const project = drafted();
    const ops: AssistOp[] = [
      { op: "setPageMemo", page: 9, memo: "x" },
      { op: "setLine", line: "line999", text: "x" },
      { op: "panels", page: 1, pattern: "nope" },
      { op: "setEmotion", character: "誰か", page: 1, value: 0 },
      { op: "deletePages", pages: [1, 2, 3, 4] },
      { op: "setTitle", title: "残る" },
    ];
    const result = applyOps(project, ops);
    expect(result.problems).toHaveLength(5);
    expect(result.problems[0]).toBe("1 番目（setPageMemo）: 9 ページはありません（4 ページまで）");
    expect(result.done).toEqual(["題名を「残る」に"]);
    expect(project.pages).toHaveLength(4);
  });

  it("previews without changing the name", () => {
    const project = drafted();
    const before = JSON.stringify(project);
    const preview = previewOps(project, [
      { op: "setTitle", title: "別" },
      { op: "addPages", count: 3 },
    ]);
    expect(preview.done).toEqual(["題名を「別」に", "5〜7 ページを足しました"]);
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe("what the Rust side reads", () => {
  it("is a name made by every kind of operation (checked by crates/name-model/tests/assist.rs)", async () => {
    const project = drafted();
    const first = project.pages[0].lines[0].id;
    const result = applyOps(project, [
      { op: "addPages", after: 2, count: 1, memos: ["足したページ"] },
      { op: "panels", page: 3, pattern: "opening" },
      { op: "panels", page: 4, count: 4 },
      { op: "addLine", page: 4, panel: 1, speaker: "先生", text: "おい", shape: "spike" },
      { op: "addLine", page: 4, text: "ドン", kind: "sfx" },
      { op: "setLine", line: first, text: "星が見えない" },
      { op: "setPanelNote", page: 1, panel: 1, note: "引き" },
      { op: "addSticky", page: 1, line: first, text: "言い方を考える", color: "blue" },
      { op: "setScene", title: "約束", firstPage: 3, lastPage: 5, storyTime: "夜" },
      { op: "setEmotion", character: "ミカ", page: 3, value: 0.4 },
      { op: "setPlan", targetPages: 16, structure: "threeAct" },
      { op: "setCharacter", character: "ソラ", tone: "落ち着いている" },
      { op: "movePage", page: 5, to: 4 },
    ]);
    expect(result.problems).toEqual([]);
    await expect(`${JSON.stringify(project, null, 2)}\n`).toMatchFileSnapshot("../../../crates/name-model/tests/fixtures/assist-made.json");
  });
});

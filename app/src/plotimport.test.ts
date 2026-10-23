import { describe, expect, it } from "vitest";
import { addLine, addScene, addCharacter, newProject, pageIndex } from "./project";
import { applyPlot, looksLikePlot, parsePlot } from "./plotimport";
import { parseScript } from "./scriptimport";
import { emotionRuns, emotionSeries, markSpeakingPages, speakingPages } from "./story";

// A made-up plot in the same shape as the ones written for real work.
const PLOT = `# 星の話 第1話 ページ配分付きプロット

本文6ページを想定。

## この話の流れ

ミカは星の見えない町で、星を探すソラと出会う。

## ページ配分

| 本文ページ | ページ数 | 場面 |
|---|---:|---|
| 1〜2 | 2 | 出会い。屋上のミカとソラ |
| 3〜5 | 3 | 町を出る相談 |
| 6 | 1 | 出発 |
| 合計 | 6 | |

## ページごとのプロット

### 1ページ 屋上

夜。ミカが屋上で空を見上げる。

- 星はひとつも見えない。

### 2ページ ソラ

ソラが現れる。

### 3〜4ページ 相談

二人で町を出る話をする。

### 6ページ 出発

二人が町を出る。

## 残っている論点

1. **ソラの正体。** どこまで明かすか。
2. 4ページの間の取り方。
`;

describe("プロットの取り込み", () => {
  it("reads pages, the page table and the other sections", () => {
    const doc = parsePlot(PLOT);
    expect(doc.title).toBe("星の話 第1話 ページ配分付きプロット");
    expect(doc.total).toBe(6);
    expect(doc.pages.map((p) => [p.number, p.last, p.heading])).toEqual([
      [1, 1, "屋上"],
      [2, 2, "ソラ"],
      [3, 4, "相談"],
      [6, 6, "出発"],
    ]);
    expect(doc.pages[0].text).toEqual(["夜。ミカが屋上で空を見上げる。", "星はひとつも見えない。"]);
    expect(doc.scenes.map((s) => [s.first, s.last, s.title])).toEqual([
      [1, 2, "出会い"],
      [3, 5, "町を出る相談"],
      [6, 6, "出発"],
    ]);
    expect(doc.notes.map((n) => [n.section, n.page])).toEqual([
      ["この話の流れ", undefined],
      ["残っている論点", undefined],
      ["残っている論点", 4],
    ]);
    expect(doc.notes[1].text).toBe("ソラの正体。 どこまで明かすか。");
  });

  it("tells a plot from a script", () => {
    expect(looksLikePlot(PLOT, 0)).toBe(true);
    const script = "### 1ページ\n#### コマ1\nミカ「星が見えない」\n";
    expect(looksLikePlot(script, parseScript(script).pages[0].panels[0].lines.length)).toBe(false);
  });

  it("deals the plot out as memos, scenes and stickies, adding pages", () => {
    const project = newProject("新しいネーム", 4);
    project.pages[0].memo = "前からのメモ";
    const old = addScene(project, project.pages[2].id, project.pages[3].id, "古いシーン");
    const report = applyPlot(project, parsePlot(PLOT));
    expect(report).toEqual({ memos: 4, scenes: 3, stickies: 3, addedPages: 2 });
    expect(project.title).toBe("星の話 第1話 ページ配分付きプロット");
    expect(project.pages).toHaveLength(6);
    expect(project.plan?.targetPages).toBe(6);
    expect(project.pages[0].memo).toBe("前からのメモ\n\n屋上\n夜。ミカが屋上で空を見上げる。\n星はひとつも見えない。");
    expect(project.pages[2].memo.startsWith("相談（3〜4 ページ）")).toBe(true);
    expect(project.scenes.includes(old)).toBe(false);
    expect(project.scenes.map((s) => [s.title, pageIndex(project, s.firstPage) + 1, pageIndex(project, s.lastPage) + 1])).toEqual([
      ["出会い", 1, 2],
      ["町を出る相談", 3, 5],
      ["出発", 6, 6],
    ]);
    expect(project.scenes[1].summary).toBe("町を出る相談");
    expect(project.pages[0].stickies).toHaveLength(2);
    expect(project.pages[3].stickies?.[0].text).toBe("【残っている論点】4ページの間の取り方。");
    // Taken in twice: the memos are not doubled.
    expect(applyPlot(project, parsePlot(PLOT)).memos).toBe(0);
  });
});

describe("感情曲線の点", () => {
  it("breaks the curve where pages have no value", () => {
    const runs = emotionRuns([
      { index: 0, value: 0, note: "" },
      { index: 1, value: 0.5, note: "" },
      { index: 4, value: -1, note: "" },
    ]);
    expect(runs.map((run) => run.map((s) => s.index))).toEqual([[0, 1], [4]]);
  });

  it("puts points on the pages a character speaks, between the values around", () => {
    const project = newProject("t", 6);
    const mika = addCharacter(project, "ミカ");
    for (const i of [0, 2, 3, 5]) {
      const line = addLine(project, project.pages[i], [50, 50], "…");
      line.speaker = mika.id;
    }
    expect(speakingPages(project, mika.id)).toEqual([0, 2, 3, 5]);
    project.emotions.push({ character: mika.id, page: project.pages[1].id, value: 1, note: "" });
    project.emotions.push({ character: mika.id, page: project.pages[5].id, value: -1, note: "" });
    expect(markSpeakingPages(project, mika.id)).toBe(3);
    expect(emotionSeries(project, mika.id).map((s) => [s.index, s.value])).toEqual([
      [0, 1],
      [1, 1],
      [2, 0.5],
      [3, 0],
      [5, -1],
    ]);
    expect(markSpeakingPages(project, mika.id)).toBe(0);
  });
});

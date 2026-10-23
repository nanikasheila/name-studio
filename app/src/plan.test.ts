import { describe, expect, it } from "vitest";
import { addLine, addScene, addSticky, newProject, removeSticky, stickyBox, stickyRows, STICKY_WIDTH_MM } from "./project";
import { HEAVY_TEXT, planAdvice, planParts } from "./story";

describe("構成補助", () => {
  it("lays the story shape over the pages", () => {
    const project = newProject("t", 32);
    expect(planParts(project)).toEqual([]);
    project.plan = { structure: "kishotenketsu" };
    expect(planParts(project).map((part) => [part.name, part.first + 1, part.last + 1])).toEqual([
      ["起", 1, 6],
      ["承", 7, 16],
      ["転", 17, 26],
      ["結", 27, 32],
    ]);
    project.plan = { structure: "threeAct", targetPages: 24 };
    expect(planParts(project).map((part) => part.last + 1)).toEqual([6, 18, 24]);
  });

  it("compares with the aim and points at heavy pages", () => {
    const project = newProject("t", 8);
    const [p1, , , p4, p5, , , p8] = project.pages.map((page) => page.id);
    addScene(project, p1, p4, "出会い");
    addScene(project, p5, p8, "別れ");
    project.plan = { targetPages: 10, structure: "johakyu" };
    addLine(project, project.pages[2], [50, 50], "あ".repeat(HEAVY_TEXT + 5));
    const advice = planAdvice(project).map((a) => a.text);
    expect(advice[0]).toBe("目標の 10 ページより 2 ページ少ないです");
    // Over the pages there are now: 序 1–2, 破 3–6, 急 7–8, with scenes by their middle.
    expect(advice).toContain("序: 1〜2 ページ（2 ページ） … 出会い");
    expect(advice).toContain("破: 3〜6 ページ（4 ページ） … 別れ");
    expect(advice).toContain("急: 7〜8 ページ（2 ページ） … ここに当たるシーンがありません");
    expect(advice).toContain(`3 ページ: 字が多め（${HEAVY_TEXT + 5} 字）`);
    expect(advice.some((text) => text.startsWith("まだ何もないページ: 1〜2、4〜8"))).toBe(true);
  });
});

describe("付箋", () => {
  it("wraps its text and grows with it", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const sticky = addSticky(project, page, [10, 20]);
    expect(stickyRows("")).toEqual(["メモ"]);
    const short = stickyBox(sticky);
    expect(short[2] - short[0]).toBe(STICKY_WIDTH_MM);
    sticky.text = "あ".repeat(20) + "\n次の行";
    expect(stickyRows(sticky.text)).toEqual(["あ".repeat(10), "あ".repeat(10), "次の行"]);
    expect(stickyBox(sticky)[3]).toBeGreaterThan(short[3]);
    removeSticky(page, sticky.id);
    expect(page.stickies).toBeUndefined();
  });
});

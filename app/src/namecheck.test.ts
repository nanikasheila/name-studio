import { describe, expect, it } from "vitest";
import { clearFaces } from "./arrange";
import { checkName, issueSummary } from "./namecheck";
import type { Point } from "./project";
import { addLine, addPanel, addStroke, boxCenter, insidePolygon, moveLine, newProject, rectShape, trimBox } from "./project";

describe("書き出し前の確認", () => {
  it("finds overlapping balloons, lines outside panels and the trim, and speech with no tail", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    addPanel(project, page, rectShape([40, 40, 160, 160]));
    const a = addLine(project, page, [100, 100], "おはよう");
    const b = addLine(project, page, [102, 102], "うん");
    a.tails = [{ tip: [90, 150] }];
    b.tails = [{ tip: [110, 150] }];
    const outside = addLine(project, page, [20, 20], "そと", "narration");
    const [tx0, ty0] = trimBox(project.pageFormat);
    moveLine(outside, tx0 - 10 - outside.box[0], ty0 + 5 - outside.box[1]);
    const lonely = addLine(project, page, [60, 60], "ひとり");
    const issues = checkName(project);
    const kinds = (id: string) => issues.filter((issue) => issue.lineId === id).map((issue) => issue.kind);
    expect(kinds(a.id)).toEqual(["overlap"]);
    expect(kinds(outside.id)).toEqual(["outside", "trim"]);
    expect(kinds(lonely.id)).toEqual(["tail"]);
    expect(issueSummary(issues)).toContain("しっぽなし 1");
  });

  it("finds a balloon over a face in the rough, and moves it off", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const panel = addPanel(project, page, rectShape([40, 40, 160, 130]));
    const [hx, hy] = [120, 60];
    const head: Point[] = Array.from({ length: 12 }, (_, i) => [hx + 4 * Math.cos((i / 12) * 2 * Math.PI), hy + 4 * Math.sin((i / 12) * 2 * Math.PI)]);
    for (const stroke of [head, [[hx, hy + 4], [hx, hy + 50]] as Point[]]) addStroke(project, page, stroke.map(([x, y]) => [x, y, 0.5]), 0.5);
    // Half over the head (a head wholly inside a balloon reads as text drawn by hand).
    const over = addLine(project, page, [hx + 6, hy + 4], "えっ、なに");
    over.tails = [{ tip: [hx, hy + 30] }];
    const beside = addLine(project, page, [60, 60], "ふうん");
    beside.tails = [{ tip: [70, 100] }];
    // A sound effect may go over a face.
    const sfx = addLine(project, page, [hx - 5, hy + 2], "ドン", "sfx");
    const faces = () => checkName(project).filter((issue) => issue.kind === "face").map((issue) => issue.lineId);
    expect(faces()).toEqual([over.id]);
    expect(issueSummary(checkName(project))).toContain("顔にかかるセリフ 1");
    const where = beside.box.slice();
    expect(clearFaces(project)).toBe(1);
    expect(faces()).toEqual([]);
    // The others stay where they were, the moved one in its panel.
    expect(beside.box).toEqual(where);
    expect(sfx.panel).toBe(panel.id);
    expect(insidePolygon(panel.shape, boxCenter(over.box))).toBe(true);
  });

  it("finds a balloon reaching past its own panel's border", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    addPanel(project, page, rectShape([40, 40, 160, 70]));
    const tall = addLine(project, page, [150, 45], "あ\nい\nう\nえ\nお\nか\nき\nく\nけ\nこ", "thought");
    const issues = checkName(project);
    expect(issues.filter((issue) => issue.lineId === tall.id).map((issue) => issue.kind)).toEqual(["spill"]);
  });

  it("does not count joined balloons as overlapping", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const a = addLine(project, page, [100, 100], "おはよう");
    const b = addLine(project, page, [102, 104], "うん");
    b.linkTo = a.id;
    expect(checkName(project).filter((issue) => issue.kind === "overlap")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { checkName, issueSummary } from "./namecheck";
import { addLine, addPanel, moveLine, newProject, rectShape, trimBox } from "./project";

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

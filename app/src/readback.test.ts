import { describe, expect, it } from "vitest";
import { addLine, addPanel, newProject, rectShape } from "./project";
import { applyTakeBack, planTakeBack, takeBackSummary, type ReadUnit } from "./readback";

describe("CSP のセリフを読み戻す", () => {
  it("takes back what was retyped, added and deleted in CSP, leaving the name's own changes", () => {
    const project = newProject("t", 3);
    const page = project.pages[0];
    const panel = addPanel(project, page, rectShape([20, 20, 160, 120]));
    const retyped = addLine(project, page, [140, 50], "今日も星が見えないね");
    const cut = addLine(project, page, [110, 50], "ねえ");
    const both = addLine(project, page, [80, 50], "見えなくても、あるよ");
    const same = addLine(project, page, [50, 50], "約束だよ");
    const written = project.pages[0].lines.map((line) => line.text);
    // Since the export, the name changed two lines.
    both.text = "見えなくたって、あるんだよ";
    same.text = "約束、だよ";
    const where = retyped.box.slice();
    const unit: ReadUnit = {
      pages: [0],
      path: "out/page0001.clip",
      found: true,
      written,
      texts: [
        { text: "今夜も星が見えないね", page: 0, box: where.slice() as typeof retyped.box },
        { text: "見えなくても、あるのよ", page: 0, box: both.box.slice() as typeof both.box },
        { text: "約束、だよ", page: 0, box: same.box.slice() as typeof same.box },
        { text: "……", page: 0, box: [30, 90, 40, 110] },
      ],
    };
    const plan = planTakeBack(project, [unit, { pages: [1], path: "out/page0002.clip", found: true, written: null, texts: [] }, { pages: [2], path: "out/page0003.clip", found: false, written: null, texts: [] }]);
    expect(plan.retyped.map((r) => r.to)).toEqual(["今夜も星が見えないね"]);
    expect(plan.removed.map((r) => r.text)).toEqual(["ねえ"]);
    expect(plan.added.map((a) => a.text)).toEqual(["……"]);
    expect(plan.conflicts.map((c) => c.csp)).toEqual(["見えなくても、あるのよ"]);
    expect([plan.unrecorded, plan.missing, plan.paths]).toEqual([[[1]], [[2]], ["out/page0001.clip"]]);
    expect(takeBackSummary(plan).length).toBe(6);

    applyTakeBack(project, plan);
    expect(retyped.text).toBe("今夜も星が見えないね");
    // Vertical text keeps its top right.
    expect([retyped.box[2], retyped.box[1]]).toEqual([where[2], where[1]]);
    expect(page.lines.includes(cut)).toBe(false);
    expect(both.text).toBe("見えなくたって、あるんだよ");
    const added = page.lines.find((line) => line.text === "……")!;
    expect([added.box[2], added.box[1]]).toEqual([40, 90]);
    expect(added.panel).toBe(panel.id);

    // Recorded as the name's, the pages have nothing more to take back.
    const again = planTakeBack(project, [{ ...unit, written: unit.texts.map((text) => text.text) }]);
    expect([again.retyped, again.added, again.removed, again.conflicts]).toEqual([[], [], [], []]);
  });

  it("puts a text on the page of a 見開き it is on", () => {
    const project = newProject("t", 2);
    addLine(project, project.pages[0], [150, 50], "右のページ");
    const unit: ReadUnit = {
      pages: [0, 1],
      path: "out/page0001.clip",
      found: true,
      written: ["右のページ"],
      texts: [
        { text: "右のページ", page: 0, box: null },
        { text: "左に足した", page: 1, box: [100, 40, 110, 80] },
      ],
    };
    const plan = planTakeBack(project, [unit]);
    expect(plan.added).toEqual([{ text: "左に足した", page: 1, box: [100, 40, 110, 80] }]);
    applyTakeBack(project, plan);
    expect(project.pages[1].lines.map((line) => line.text)).toEqual(["左に足した"]);
  });
});

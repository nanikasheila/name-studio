import { describe, expect, it } from "vitest";
import { addLine, addPanel, addSticky, linkLabel, linkSticky, movePanel, moveLine, newProject, rectShape, stickyAnchor } from "./project";
import { copySelection, pasteClip } from "./transform";

describe("付箋の紐づけ", () => {
  it("points at the panel or line it is about, wherever either goes", () => {
    const project = newProject("t", 2);
    const page = project.pages[0];
    const panel = addPanel(project, page, rectShape([20, 20, 100, 100]));
    const line = addLine(project, page, [60, 60], "ここ");
    const sticky = addSticky(project, page, [150, 30], "間を長く");
    expect(stickyAnchor(page, sticky)).toBeNull();
    expect(linkSticky(page, sticky, "panel", panel.id, [40, 50])).toBe(true);
    expect(stickyAnchor(page, sticky)).toEqual([40, 50]);
    expect(linkLabel(page, sticky)).toBe(`コマ ${panel.order}`);
    movePanel(panel, 10, 5);
    expect(stickyAnchor(page, sticky)).toEqual([50, 55]);
    // The note itself moves freely and stays tied.
    sticky.at = [10, 200];
    expect(stickyAnchor(page, sticky)).toEqual([50, 55]);
    linkSticky(page, sticky, "line", line.id, [line.box[0], line.box[1]]);
    moveLine(line, 3, 4);
    expect(stickyAnchor(page, sticky)).toEqual([line.box[0], line.box[1]]);
    expect(linkLabel(page, sticky)).toBe("セリフ「ここ」");
    // Gone: points at nothing, and says so.
    page.lines = [];
    expect(stickyAnchor(page, sticky)).toBeNull();
    expect(linkLabel(page, sticky)).toBe("");
    expect(linkSticky(page, sticky, "line", line.id, [0, 0])).toBe(false);
  });

  it("stays tied when copied with what it is about, and comes loose on another page without it", () => {
    const project = newProject("t", 2);
    const [page, other] = project.pages;
    const panel = addPanel(project, page, rectShape([20, 20, 100, 100]));
    const sticky = addSticky(project, page, [150, 30], "メモ");
    linkSticky(page, sticky, "panel", panel.id, [30, 30]);
    // Copying the panel brings its 付箋.
    const both = copySelection(page, { kind: "panel", pageId: page.id, id: panel.id })!;
    expect(both.stickies.map((n) => n.id)).toEqual([sticky.id]);
    const pasted = pasteClip(project, other, both);
    const copy = other.stickies!.find((n) => n.id === pasted.stickies[0])!;
    expect(copy.link?.id).toBe(pasted.panels[0]);
    const alone = copySelection(page, { kind: "sticky", pageId: page.id, id: sticky.id })!;
    const elsewhere = pasteClip(project, other, alone);
    expect(other.stickies!.find((n) => n.id === elsewhere.stickies[0])!.link).toBeUndefined();
    const here = pasteClip(project, page, alone, [5, 5]);
    expect(page.stickies!.find((n) => n.id === here.stickies[0])!.link?.id).toBe(panel.id);
  });
});

import { describe, expect, it } from "vitest";
import { arrangePage, arrangePanel, placingBox } from "./arrange";
import { addLine, addPanel, basicBox, boxCenter, insidePolygon, newProject, rectShape, setDefaultShape, setLineKind, trimBox } from "./project";

describe("セリフの並べ直し", () => {
  it("lays a panel's dialogue out right to left in reading order, broken into short lines, inside the panel", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const panel = addPanel(project, page, rectShape([40, 40, 160, 120]));
    const first = addLine(project, page, [60, 100], "数か月前、この街の空から星がひとつ消えた。");
    const second = addLine(project, page, [150, 50], "えっ");
    // Reading order: the top right one first.
    expect(arrangePanel(project, page, panel)).toBe(2);
    expect(first.text).toContain("\n");
    for (const line of [first, second]) expect(insidePolygon(panel.shape, boxCenter(line.box))).toBe(true);
    expect(boxCenter(second.box)[0]).toBeGreaterThan(boxCenter(first.box)[0]);
  });

  it("keeps dialogue of a 裁ち切り panel inside the basic frame", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const [tx0, ty0, tx1] = trimBox(project.pageFormat);
    const panel = addPanel(project, page, rectShape([tx0 - 5, ty0 - 5, tx1 + 5, 120]));
    const box = placingBox(project, panel);
    const frame = basicBox(project.pageFormat);
    expect(box[0]).toBeGreaterThanOrEqual(frame[0]);
    expect(box[1]).toBeGreaterThanOrEqual(frame[1]);
    const line = addLine(project, page, [tx0, ty0], "数か月前――");
    arrangePage(project, page);
    expect(line.box[1]).toBeGreaterThanOrEqual(frame[1]);
    expect(line.box[2]).toBeLessThanOrEqual(frame[2]);
  });
});

describe("フキダシの既定の形", () => {
  it("gives new and usual-shaped lines of a kind the work's shape, and follows kind changes", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const usual = addLine(project, page, [50, 50], "うーん", "thought");
    const own = addLine(project, page, [80, 50], "ふむ", "thought");
    own.balloonShape = "dashed";
    expect(setDefaultShape(project, "thought", "polygon")).toBe(1);
    expect(usual.balloonShape).toBe("polygon");
    expect(own.balloonShape).toBe("dashed");
    expect(addLine(project, page, [20, 20], "…", "thought").balloonShape).toBe("polygon");
    // A thought turned into speech loses the thought's shape; back again, it gets it.
    setLineKind(project, usual, "speech");
    expect(usual.balloonShape).toBeUndefined();
    setLineKind(project, usual, "thought");
    expect(usual.balloonShape).toBe("polygon");
    expect(setDefaultShape(project, "thought", "auto")).toBe(2);
    expect(project.lineShapes).toBeUndefined();
  });
});

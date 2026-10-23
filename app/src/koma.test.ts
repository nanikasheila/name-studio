import { describe, expect, it } from "vitest";
import { PATTERNS, applyPattern, fitPattern, patternCount, bleedPanel, facingPage, spreadPanel, spreadTwin, unspreadPanel, borderLines, borderRuns, clipOutside, dashes, inheritOpenEdges, isBled, patternPanels, wavy } from "./koma";
import { addLine, addStroke, basicBox, boxCenter, bounds, cutPanels, emptyPage, insidePolygon, newProject, rectShape, type Panel, type Point } from "./project";

describe("裁ち切り", () => {
  it("runs a panel off the page and back", () => {
    const project = newProject("t", 1);
    const format = project.pageFormat;
    const [x0, y0, x1, y1] = basicBox(format);
    const panel: Panel = { id: "panel1", shape: rectShape([x0, y0, x1, y0 + 60]), order: 1 };
    bleedPanel(panel, "top", format, true);
    expect(bounds(panel.shape)[1]).toBe(0);
    expect(isBled(panel, "top", format)).toBe(true);
    expect(isBled(panel, "left", format)).toBe(false);
    // rectShape goes top left, top right, ...: edge 0 is the top.
    expect(panel.openEdges).toEqual([0]);
    expect(borderRuns(panel)).toHaveLength(1);
    expect(borderRuns(panel)[0].closed).toBe(false);
    bleedPanel(panel, "top", format, false);
    expect(bounds(panel.shape)[1]).toBe(y0);
    expect(panel.openEdges).toBeUndefined();
    expect(x1).toBeGreaterThan(x0);
    expect(y1).toBeGreaterThan(y0);
  });

  it("stays open in both halves when the panel is cut", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const [x0, y0, x1] = basicBox(project.pageFormat);
    const panel: Panel = { id: "panel1", shape: rectShape([x0, y0, x1, y0 + 60]), order: 1, fill: "black" };
    bleedPanel(panel, "top", project.pageFormat, true);
    page.panels.push(panel);
    const middle = (x0 + x1) / 2;
    expect(cutPanels(project, page, [middle, -5], [middle, 100])).toHaveLength(1);
    for (const half of page.panels) {
      expect(half.fill).toBe("black");
      expect(half.openEdges).toHaveLength(1);
      const [i] = half.openEdges!;
      expect(half.shape[i][1]).toBe(0);
      expect(half.shape[(i + 1) % half.shape.length][1]).toBe(0);
    }
  });

  it("finds open edges along the old ones", () => {
    const old = rectShape([0, 0, 100, 50]);
    const left = rectShape([0, 0, 49, 50]);
    expect(inheritOpenEdges(old, [0], left)).toEqual([0]);
    expect(inheritOpenEdges(old, [1], left)).toEqual([]);
  });
});

describe("見開き", () => {
  it("runs a panel across the gutter onto the facing page and back", () => {
    const project = newProject("t", 4);
    const format = project.pageFormat;
    const [w] = format.canvasMm;
    const [x0, y0, x1] = basicBox(format);
    // Page 2 is the right page of the 2-3 spread when page 1 stands alone.
    const right = project.pages[1];
    const left = project.pages[2];
    expect(facingPage(project, right, true)).toMatchObject({ page: left, gutter: "left" });
    expect(facingPage(project, project.pages[0], true)).toBeNull();
    const panel: Panel = { id: "panel1", shape: rectShape([x0, y0, x1, y0 + 80]), order: 1, fill: "black" };
    right.panels.push(panel);
    const twin = spreadPanel(project, right, panel, true)!;
    expect(bounds(panel.shape)[0]).toBe(0);
    expect(isBled(panel, "left", format)).toBe(true);
    expect(left.panels).toEqual([twin]);
    expect(twin.spread).toBe(panel.spread);
    expect(twin.fill).toBe("black");
    // Mirrored: the twin reaches the right edge of the left page.
    expect(bounds(twin.shape)).toEqual([w - x1, y0, w, y0 + 80]);
    expect(isBled(twin, "right", format)).toBe(true);
    expect(twin.openEdges).toHaveLength(1);
    const [i] = twin.openEdges!;
    expect(twin.shape[i][0]).toBe(w);
    expect(twin.shape[(i + 1) % 4][0]).toBe(w);
    expect(spreadTwin(project, left, twin)?.panel).toBe(panel);
    expect(spreadPanel(project, right, panel, true)).toBeNull();
    // Cut down the middle, only the part at the gutter stays joined.
    const middle = (x0 + x1) / 2;
    cutPanels(project, right, [middle, y0 - 5], [middle, y0 + 90]);
    expect(right.panels.filter((p) => p.spread)).toHaveLength(1);
    right.panels = [panel];
    unspreadPanel(project, right, panel, true);
    expect(left.panels).toEqual([]);
    expect(panel.spread).toBeUndefined();
    expect(bounds(panel.shape)[0]).toBe(x0);
    expect(panel.openEdges).toBeUndefined();
  });
});

describe("borders as drawn", () => {
  it("leave out what an inset panel covers", () => {
    const page = emptyPage("page1");
    page.panels.push({ id: "panel1", shape: rectShape([0, 0, 100, 100]), order: 1 });
    page.panels.push({ id: "panel2", shape: rectShape([-5, 70, 30, 105]), order: 2, fill: "white", z: 1 });
    const lines = borderLines(page);
    const big = lines.filter((line) => line.panel.id === "panel1");
    // The corner under the inset is gone: no point of the big border is inside it.
    for (const line of big) {
      for (const [x, y] of line.points) expect(x > -5 && x < 30 && y > 70 && y < 105 && !(x === 30 || y === 70)).toBe(false);
    }
    expect(lines.filter((line) => line.panel.id === "panel2")).toHaveLength(1);
  });

  it("leave out what a breakout covers", () => {
    const page = emptyPage("page1");
    page.panels.push({ id: "panel1", shape: rectShape([0, 0, 100, 100]), order: 1 });
    page.breakouts.push({ id: "breakout1", shape: rectShape([40, -10, 60, 10]) });
    const lines = borderLines(page);
    expect(lines.length).toBe(1);
    expect(lines[0].closed).toBe(false);
    expect(lines[0].points[0]).toEqual([60, 0]);
    expect(lines[0].points[lines[0].points.length - 1]).toEqual([40, 0]);
  });

  it("skip panels without a border", () => {
    const page = emptyPage("page1");
    page.panels.push({ id: "panel1", shape: rectShape([0, 0, 100, 100]), order: 1, border: "none" });
    expect(borderLines(page)).toEqual([]);
  });

  it("clip a polyline that only touches a cover at a corner", () => {
    const square: Point[] = rectShape([0, 0, 10, 10]);
    expect(clipOutside(square, true, [rectShape([20, 20, 30, 30])])).toEqual([{ points: square, closed: true }]);
  });

  it("dash and wave", () => {
    const pieces = dashes(
      [
        [0, 0],
        [10, 0],
      ],
      false,
      3,
      2,
    );
    expect(pieces.map((p) => p[p.length - 1][0] - p[0][0])).toEqual([3, 3]);
    const waved = wavy(rectShape([0, 0, 20, 20]), true);
    expect(waved.length).toBeGreaterThan(20);
  });
});

describe("layout patterns", () => {
  it.each(PATTERNS.map((p) => p.id))("%s fits the page", (id) => {
    const project = newProject("t", 1);
    const panels = patternPanels(project, id);
    expect(panels.length).toBeGreaterThan(0);
    const [w, h] = project.pageFormat.canvasMm;
    for (const panel of panels) {
      const [x0, y0, x1, y1] = bounds(panel.shape);
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(w);
      expect(y1).toBeLessThanOrEqual(h);
      expect(x1 - x0).toBeGreaterThan(5);
      expect(y1 - y0).toBeGreaterThan(5);
    }
    expect(new Set(panels.map((p) => p.id)).size).toBe(panels.length);
  });

  it("bleeds the opening shot and adds the inset", () => {
    const project = newProject("t", 1);
    const opening = patternPanels(project, "opening");
    expect(isBled(opening[0], "top", project.pageFormat)).toBe(true);
    const big = patternPanels(project, "bigInset");
    expect(big.filter((p) => p.z === 1 && p.fill === "white")).toHaveLength(1);
  });
});

describe("型を当てる", () => {
  it("keeps the panels' memos and moves what was in them into the new panels in order", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    applyPattern(project, page, "basic4");
    const old = [...page.panels].sort((a, b) => a.order - b.order);
    old[0].note = "街の遠景";
    old[1].note = "ストラの顔";
    const first = addLine(project, page, boxCenter(bounds(old[0].shape)), "おはよう");
    const second = addLine(project, page, boxCenter(bounds(old[1].shape)), "うん");
    const stroke = addStroke(project, page, [[...boxCenter(bounds(old[1].shape)), 1], [boxCenter(bounds(old[1].shape))[0] + 5, boxCenter(bounds(old[1].shape))[1], 1]], 0.4)!;
    old[old.length - 1].note = "引き";
    applyPattern(project, page, "three");
    const panels = [...page.panels].sort((a, b) => a.order - b.order);
    expect(panels.length).toBeLessThan(old.length);
    expect(panels[0].note).toBe("街の遠景");
    expect(first.panel).toBe(panels[0].id);
    expect(panels[1].note).toBe("ストラの顔");
    expect(second.panel).toBe(panels[1].id);
    expect(insidePolygon(panels[1].shape, [stroke.points[0][0], stroke.points[0][1]])).toBe(true);
    // Fewer new panels: the rest goes into the last one.
    expect(panels[panels.length - 1].note).toContain("引き");
  });
});

describe("型をコマ数に合わせる", () => {
  it("joins and splits cells, keeping the pattern's rows, bleed and inset where it can", () => {
    const project = newProject("t", 1);
    for (const pattern of PATTERNS) {
      for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const panels = patternPanels(project, pattern.id, undefined, count);
        expect(panels.length, `${pattern.id} → ${count}`).toBe(count);
        // Still inside the page, none of zero size.
        for (const panel of panels) {
          const [x0, y0, x1, y1] = bounds(panel.shape);
          expect(x1 - x0).toBeGreaterThan(5);
          expect(y1 - y0).toBeGreaterThan(1);
        }
      }
    }
    // 導入 (6) to 5: the first row still bleeds, one two-cell row is joined.
    const opening = PATTERNS.find((p) => p.id === "opening")!;
    const five = fitPattern(opening, 5);
    expect(five.rows.map((row) => row.cells.length)).toEqual([1, 2, 1, 1]);
    expect(five.bleed).toEqual(opening.bleed);
    // 大ゴマ＋はめ込み (4) to 3 keeps the inset over the big panel; to 5 splits the top row, not the big panel.
    const big = PATTERNS.find((p) => p.id === "bigInset")!;
    expect(fitPattern(big, 3).inset).toBe(1);
    expect(fitPattern(big, 3).rows.map((row) => row.cells.length)).toEqual([1, 1]);
    expect(fitPattern(big, 5).rows.map((row) => row.cells.length)).toEqual([3, 1]);
    // The pause row is never split.
    const pause = fitPattern(PATTERNS.find((p) => p.id === "pause")!, 8);
    expect(pause.rows[1].cells.length).toBe(1);
    expect(patternCount("basic4")).toBe(6);
    expect(patternCount("bigInset")).toBe(4);
  });

  it("applies a pattern at the page's count, carrying what was in its panels", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    applyPattern(project, page, "basic4", 5);
    expect(page.panels.length).toBe(5);
    const panels = [...page.panels].sort((a, b) => a.order - b.order);
    const line = addLine(project, page, boxCenter(bounds(panels[4].shape)), "あ");
    applyPattern(project, page, "opening", 5);
    expect(page.panels.length).toBe(5);
    const last = [...page.panels].sort((a, b) => a.order - b.order)[4];
    expect(line.panel).toBe(last.id);
    expect(insidePolygon(last.shape, boxCenter(line.box))).toBe(true);
  });
});

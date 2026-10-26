import { describe, expect, it } from "vitest";
import { rectShape } from "./geometry";
import { newProject } from "./project";
import type { Stroke } from "./model";
import { drawPanelMask } from "./pagedraw";
import { panelArea, panelFolders, panelsAbove, strokePanel } from "./panelfolders";

const m = { scale: 10, x: 0, y: 0 };
const line = (id: string, points: [number, number][], over = false): Stroke => ({
  id,
  points: points.map(([x, y]) => [x, y, 1]),
  widthMm: 0.5,
  closed: false,
  ...(over ? { over } : {}),
});

describe("マスク付きフォルダー", () => {
  it("puts each rough stroke in the panel that holds most of it, an inset first", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    page.panels = [
      { id: "p1", shape: rectShape([10, 10, 100, 60]), order: 1 },
      { id: "p2", shape: rectShape([10, 70, 100, 120]), order: 2 },
      { id: "inset", shape: rectShape([60, 20, 90, 50]), order: 3, z: 1 },
    ];
    const format = project.pageFormat;
    // Runs out of p1 into the gutter and p2, but mostly in p1: kept whole, in p1.
    expect(strokePanel(page, line("a", [[20, 20], [30, 30], [40, 40], [50, 80]]), format)?.id).toBe("p1");
    expect(strokePanel(page, line("b", [[70, 30], [80, 40]]), format)?.id).toBe("inset");
    // Outside every panel, or drawn over the borders (はみ出し): left on the page.
    expect(strokePanel(page, line("c", [[2, 2], [5, 5]]), format)).toBeUndefined();
    expect(strokePanel(page, line("d", [[20, 20], [30, 30]], true), format)).toBeUndefined();
  });

  it("counts a はみ出し reaching into a panel as part of it", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    page.panels = [{ id: "p1", shape: rectShape([10, 10, 100, 60]), order: 1 }];
    page.breakouts = [
      { id: "b1", shape: rectShape([40, 50, 70, 80]) },
      { id: "b2", shape: rectShape([150, 150, 160, 160]) },
    ];
    const area = panelArea(page, page.panels[0], project.pageFormat);
    expect(area).toHaveLength(2);
    expect(area[1]).toEqual(page.breakouts[0].shape);
    // A stroke in the はみ出し only, below the panel.
    expect(strokePanel(page, line("a", [[50, 70], [60, 75]]), project.pageFormat)?.id).toBe("p1");
  });

  it("takes a 裁ち切り panel past the canvas edge", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const [w] = project.pageFormat.canvasMm;
    // The top edge (0) lies on the canvas's top.
    page.panels = [{ id: "p1", shape: rectShape([10, 0, w - 10, 60]), order: 1, openEdges: [0] }];
    const [outline] = panelArea(page, page.panels[0], project.pageFormat);
    expect(Math.min(...outline.map(([, y]) => y))).toBeLessThan(0);
  });

  it("names the folders in reading order and shares one between the halves of a 見開きコマ", () => {
    const project = newProject("t", 2);
    const [right, left] = project.pages;
    right.panels = [
      { id: "r2", shape: rectShape([10, 70, 100, 120]), order: 2 },
      { id: "r1", shape: rectShape([10, 10, 100, 60]), order: 1, spread: "s" },
    ];
    left.panels = [{ id: "l1", shape: rectShape([10, 10, 100, 60]), order: 1, spread: "s" }];
    right.strokes = [line("a", [[20, 20], [30, 30]]), line("b", [[2, 2], [4, 4]])];
    left.strokes = [line("c", [[20, 20], [30, 30]])];
    const placed = [
      { page: right, m, right: true },
      { page: left, m, right: false },
    ];
    const { folders, loose } = panelFolders(placed, project.pageFormat);
    expect(folders.map((folder) => [folder.name, folder.parts.map((part) => part.panel.id)])).toEqual([
      ["コマ1", ["r1", "l1"]],
      ["コマ2", ["r2"]],
    ]);
    expect(folders[0].parts.map((part) => part.strokes.map((stroke) => stroke.id))).toEqual([["a"], ["c"]]);
    expect(loose.map((strokes) => strokes.map((stroke) => stroke.id))).toEqual([["b"], []]);
    // Pages written one by one: each half is a panel of its own.
    expect(panelFolders([placed[1]], project.pageFormat).folders.map((folder) => folder.name)).toEqual(["コマ1"]);
  });

  it("draws the mask over the panel and its はみ出し, not under an inset above", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    page.panels = [
      { id: "p1", shape: rectShape([10, 10, 100, 60]), order: 1 },
      { id: "inset", shape: rectShape([60, 20, 90, 50]), order: 2, z: 1 },
    ];
    page.breakouts = [{ id: "b1", shape: rectShape([40, 50, 70, 80]) }];
    expect(panelsAbove(page, page.panels[0])).toEqual([page.panels[1].shape]);
    expect(panelsAbove(page, page.panels[1])).toEqual([]);
    const ops: string[] = [];
    const ctx = {
      save: () => ops.push("save"),
      restore: () => ops.push("restore"),
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      closePath: () => undefined,
      fill: () => ops.push(`fill ${ctx.globalCompositeOperation}`),
      fillStyle: "",
      globalCompositeOperation: "source-over",
    };
    const { folders } = panelFolders([{ page, m, right: true }], project.pageFormat);
    const clips: boolean[] = [];
    drawPanelMask(ctx as unknown as CanvasRenderingContext2D, folders[0], project.pageFormat, (at) => at, (right, draw) => {
      clips.push(right);
      draw();
    });
    expect(clips).toEqual([true]);
    expect(ops).toEqual(["save", "fill source-over", "fill source-over", "fill destination-out", "restore"]);
  });
});

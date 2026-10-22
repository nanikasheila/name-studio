import { describe, expect, it } from "vitest";
import { History } from "./history";
import {
  addCharacter,
  addLine,
  addPanel,
  addScene,
  addStroke,
  area,
  basicBox,
  cutPanels,
  eraseStrokes,
  insertPage,
  movePage,
  newProject,
  orderPanels,
  rectShape,
  removeCharacter,
  removePage,
  sceneOf,
  setEmotion,
  snapCut,
  snapPoint,
  snapLines,
  splitShape,
  textSize,
  type Point,
} from "./project";

const square = rectShape([0, 0, 100, 100]);

describe("splitShape", () => {
  it("cuts a rectangle with a gutter", () => {
    const halves = splitShape(square, [50, -10], [50, 110], 2)!;
    const xs = halves.map((half) => half.map(([x]) => x));
    expect(Math.min(...xs[0], ...xs[1])).toBe(0);
    expect(halves.map(area).reduce((a, b) => a + b)).toBeCloseTo(100 * 98);
    // The halves sit 1 mm either side of the cut.
    const edges = halves.map((half) => half.map(([x]) => x).filter((x) => x !== 0 && x !== 100));
    expect(edges.flat().sort()).toEqual([49, 49, 51, 51]);
  });

  it("cuts diagonally", () => {
    const halves = splitShape(square, [0, 30], [100, 70], 0)!;
    expect(halves.map(area).reduce((a, b) => a + b)).toBeCloseTo(10000);
    expect(halves.map((half) => half.length).sort()).toEqual([4, 4]);
  });

  it("refuses a cut that misses", () => {
    expect(splitShape(square, [120, 0], [120, 100], 2)).toBeNull();
  });
});

describe("panels", () => {
  it("splits the basic frame into rows and keeps the manga reading order", () => {
    const project = newProject("test", 1);
    const page = project.pages[0];
    const [x0, y0, x1, y1] = basicBox(project.pageFormat);
    addPanel(project, page, rectShape([x0, y0, x1, y1]));
    const middle = (y0 + y1) / 2;
    expect(cutPanels(project, page, [x0 - 5, middle], [x1 + 5, middle])).toHaveLength(1);
    // Cut only the top row into right and left.
    const centre = (x0 + x1) / 2;
    expect(cutPanels(project, page, [centre, y0 - 5], [centre, middle - 10])).toHaveLength(1);
    expect(page.panels).toHaveLength(3);
    const tops = page.panels.map((panel) => Math.min(...panel.shape.map(([, y]) => y)));
    const rights = page.panels.map((panel) => Math.max(...panel.shape.map(([x]) => x)));
    expect(page.panels.map((panel) => panel.order)).toEqual([1, 2, 3]);
    // 1: top right, 2: top left, 3: bottom.
    expect(rights[0]).toBeCloseTo(x1);
    expect(rights[1]).toBeCloseTo(centre - 1);
    expect(tops[2]).toBeCloseTo(middle + 3);
  });

  it("orders left to right for a left-bound book", () => {
    const project = newProject("test", 1);
    const page = project.pages[0];
    page.panels = [
      { id: "a", shape: rectShape([0, 0, 40, 40]), order: 0 },
      { id: "b", shape: rectShape([50, 0, 90, 40]), order: 0 },
    ];
    orderPanels(page, "left");
    expect(page.panels.map((panel) => panel.id)).toEqual(["a", "b"]);
  });
});

describe("lines", () => {
  it("sizes vertical text by columns and characters", () => {
    const [w, h] = textSize("あいう\nえ", 10, true);
    const size = (10 * 25.4) / 72;
    expect(h).toBeCloseTo(3 * size);
    expect(w).toBeCloseTo(size * 2.15);
  });

  it("puts a new line in the panel under it and in reading order", () => {
    const project = newProject("test", 1);
    const page = project.pages[0];
    page.panels = [
      { id: "right", shape: rectShape([100, 0, 200, 100]), order: 1 },
      { id: "left", shape: rectShape([0, 0, 95, 100]), order: 2 },
    ];
    const second = addLine(project, page, [50, 50], "後");
    const first = addLine(project, page, [150, 50], "先");
    expect(first.panel).toBe("right");
    expect(second.panel).toBe("left");
    expect(page.lines.map((line) => line.text)).toEqual(["先", "後"]);
    expect(first.balloon!.length).toBeGreaterThan(10);
  });
});

describe("strokes", () => {
  it("erases strokes under the pointer", () => {
    const project = newProject("test", 1);
    const page = project.pages[0];
    addStroke(project, page, [[0, 0, 1], [10, 0, 1]], 0.5);
    addStroke(project, page, [[0, 20, 1], [10, 20, 1]], 0.5);
    expect(eraseStrokes(page, [5, 1], 1)).toBe(1);
    expect(page.strokes).toHaveLength(1);
  });
});

describe("pages, scenes and emotions", () => {
  it("keeps scenes and emotions consistent when pages go", () => {
    const project = newProject("test", 4);
    const [p1, p2, p3, p4] = project.pages.map((page) => page.id);
    const hero = addCharacter(project, "主人公");
    const scene = addScene(project, p2, p3, "出会い");
    setEmotion(project, hero.id, p2, 0.5);
    setEmotion(project, hero.id, p3, 2);
    expect(project.emotions.map((point) => point.value)).toEqual([0.5, 1]);
    expect(sceneOf(project, p3)).toBe(scene);
    removePage(project, p2);
    expect(scene.firstPage).toBe(p3);
    expect(project.emotions).toHaveLength(1);
    removePage(project, p3);
    expect(project.scenes).toHaveLength(0);
    expect(sceneOf(project, p1)).toBeUndefined();
    insertPage(project, 0);
    movePage(project, p4, -1);
    expect(project.pages.map((page) => page.id).indexOf(p4)).toBe(1);
  });

  it("clears the speaker of removed characters", () => {
    const project = newProject("test", 1);
    const hero = addCharacter(project, "主人公");
    const line = addLine(project, project.pages[0], [10, 10]);
    line.speaker = hero.id;
    removeCharacter(project, hero.id);
    expect(line.speaker).toBeUndefined();
  });
});

describe("snapping", () => {
  it("straightens almost level cuts", () => {
    expect(snapCut([0, 0], [100, 4])).toEqual([100, 0]);
    expect(snapCut([0, 0], [100, 40])).toEqual([100, 40]);
    expect(snapCut([0, 0], [3, -100])).toEqual([0, -100]);
  });

  it("pulls corners onto the frames", () => {
    const project = newProject("test", 1);
    const lines = snapLines(project.pageFormat);
    const [x0, y0] = basicBox(project.pageFormat);
    const snapped: Point = snapPoint([x0 + 1, y0 - 1.5], lines, 2);
    expect(snapped).toEqual([x0, y0]);
  });
});

describe("History", () => {
  it("undoes and redoes", () => {
    const history = new History<{ n: number }>();
    let value = { n: 1 };
    history.record(value);
    value = { n: 2 };
    value = history.undo(value)!;
    expect(value.n).toBe(1);
    value = history.redo(value)!;
    expect(value.n).toBe(2);
    expect(history.canRedo).toBe(false);
  });
});

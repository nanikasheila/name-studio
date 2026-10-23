import { describe, expect, it } from "vitest";
import { History } from "./history";
import {
  addCharacter,
  boxCenter,
  carryContents,
  followPanel,
  movePanel,
  panelContents,
  addLine,
  addPanel,
  addScene,
  addStroke,
  area,
  basicBox,
  cutPanels,
  eraseInside,
  eraseStrokes,
  insertPage,
  movePage,
  movePagesTo,
  moveScene,
  pageBlock,
  swapPanelContents,
  addFill,
  newProject,
  orderPanels,
  pickInside,
  splitAtX,
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

describe("範囲選択と囲って消す", () => {
  function setup() {
    const project = newProject("t", 1);
    const page = project.pages[0];
    addStroke(project, page, [[0, 5, 1], [10, 5, 1]], 0.2); // crosses the box
    addStroke(project, page, [[4, 4, 1], [6, 6, 1]], 0.2); // inside
    addStroke(project, page, [[20, 20, 1], [30, 30, 1]], 0.2); // outside
    return { project, page };
  }
  const box = rectShape([3, 3, 7, 7]);

  it("erases only inside the outline, cutting lines at its edge", () => {
    const { project, page } = setup();
    const [crossing, , outside] = page.strokes;
    expect(eraseInside(project, page, box)).toBe(2);
    expect(page.strokes).toHaveLength(3);
    const pieces = page.strokes.filter((s) => s.points[0][1] === 5);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].id).toBe(crossing.id);
    expect(pieces[0].points[pieces[0].points.length - 1][0]).toBeCloseTo(3, 0);
    expect(pieces[1].points[0][0]).toBeCloseTo(7, 0);
    expect(pieces[0].cut).toEqual([false, true]);
    expect(pieces[1].cut).toEqual([true, false]);
    expect(page.strokes).toContain(outside);
    expect(eraseInside(project, page, rectShape([50, 50, 60, 60]))).toBe(0);
  });

  it("picks lines mostly inside and dialogue whose box centre is", () => {
    const { project, page } = setup();
    const line = addLine(project, page, [5, 5]);
    const picked = pickInside(page, box);
    expect(picked.strokes).toEqual([page.strokes[1].id]);
    expect(picked.lines).toEqual(line.box[0] + line.box[2] < 14 ? [line.id] : []);
  });
});

describe("見開きのノド", () => {
  it("splits a line where it crosses the gutter, sharing the crossing point", () => {
    const runs = splitAtX(
      [
        [200, 10, 0.5],
        [250, 20, 0.5],
        [300, 30, 0.5],
        [330, 30, 0.5],
      ],
      275,
    );
    expect(runs.map((run) => run.beyond)).toEqual([false, true]);
    expect(runs[0].points.at(-1)).toEqual([275, 25, 0.5]);
    expect(runs[1].points[0]).toEqual([275, 25, 0.5]);
    expect(runs[1].points.at(-1)).toEqual([330, 30, 0.5]);
  });

  it("keeps a line on one side whole, and drops a crossing with nothing after it", () => {
    expect(splitAtX([[1, 1], [2, 2]] as never, 10)).toHaveLength(1);
    const back = splitAtX([[5, 0], [15, 0], [5, 0]] as never, 10);
    expect(back.map((run) => run.beyond)).toEqual([false, true, false]);
  });
});

describe("コマに中身が付いてくる", () => {
  const setup = () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const panel = addPanel(project, page, rectShape([10, 10, 110, 110]));
    const other = addPanel(project, page, rectShape([120, 10, 170, 110]));
    const inside = addStroke(project, page, [[40, 40, 0.5], [60, 40, 0.5]], 0.5)!;
    const outside = addStroke(project, page, [[130, 40, 0.5], [150, 40, 0.5]], 0.5)!;
    const line = addLine(project, page, [50, 60], "セリフ");
    return { project, page, panel, other, inside, outside, line };
  };

  it("carries what is inside the panel, not what is in another", () => {
    const { page, panel, inside, outside, line } = setup();
    const contents = panelContents(page, panel);
    expect(contents.strokes).toEqual([inside.id]);
    expect(contents.lines).toEqual([line.id]);
    expect(contents.strokes).not.toContain(outside.id);
  });

  it("moves the contents with the panel and stretches positions with its corner", () => {
    const { page, panel, inside, outside, line } = setup();
    const carried = carryContents(page, panel);
    const lineCentre = boxCenter(line.box);
    movePanel(panel, 5, 7);
    followPanel(page, panel, carried);
    expect(inside.points[0].slice(0, 2)).toEqual([45, 47]);
    expect(outside.points[0].slice(0, 2)).toEqual([130, 40]);
    expect(boxCenter(line.box)).toEqual([lineCentre[0] + 5, lineCentre[1] + 7]);
    // Twice as wide: the stroke's centre goes twice as far from the left edge; its shape keeps its size.
    const before = carryContents(page, panel);
    panel.shape = rectShape([15, 17, 215, 117]);
    followPanel(page, panel, before);
    expect(inside.points.map((p) => Math.round(p[0]))).toEqual([85, 105]);
  });
});

describe("入れ替え", () => {
  const ids = (project: ReturnType<typeof newProject>) => project.pages.map((page) => page.id);

  it("moves pages by dragging, keeping a 見開き together", () => {
    const project = newProject("t", 6);
    const [p1, p2, p3, p4, p5, p6] = ids(project);
    project.pages[1].joinNext = true;
    expect(pageBlock(project, 2)).toEqual([1, 2]);
    expect(pageBlock(project, 1)).toEqual([1, 2]);
    expect(movePagesTo(project, 1, 2, 6)).toBe(true);
    expect(ids(project)).toEqual([p1, p4, p5, p6, p2, p3]);
    // Dropping between the two halves of a 見開き goes before the pair.
    expect(movePagesTo(project, 0, 0, 5)).toBe(true);
    expect(ids(project)).toEqual([p4, p5, p6, p1, p2, p3]);
    expect(movePagesTo(project, 0, 0, 1)).toBe(false);
  });

  it("keeps scenes on the pages that stay; a moved page joins the scene it lands in", () => {
    const project = newProject("t", 6);
    const [p1, p2, p3, p4, p5, p6] = ids(project);
    const a = addScene(project, p1, p3, "A");
    const b = addScene(project, p4, p6, "B");
    movePagesTo(project, 0, 0, 5);
    expect(ids(project)).toEqual([p2, p3, p4, p5, p1, p6]);
    expect([a.firstPage, a.lastPage]).toEqual([p2, p3]);
    expect([b.firstPage, b.lastPage]).toEqual([p4, p6]);
    expect(sceneOf(project, p1)).toBe(b);
  });

  it("moves a whole scene before another", () => {
    const project = newProject("t", 6);
    const [p1, p2, p3, p4, p5, p6] = ids(project);
    const a = addScene(project, p1, p2, "A");
    const b = addScene(project, p3, p4, "B");
    const c = addScene(project, p5, p6, "C");
    expect(moveScene(project, c.id, 0)).toBe(true);
    expect(ids(project)).toEqual([p5, p6, p1, p2, p3, p4]);
    expect(project.scenes.map((scene) => scene.title)).toEqual(["C", "A", "B"]);
    expect([a.firstPage, a.lastPage, b.firstPage, b.lastPage]).toEqual([p1, p2, p3, p4]);
    expect(moveScene(project, a.id, project.pages.length)).toBe(true);
    expect(ids(project)).toEqual([p5, p6, p3, p4, p1, p2]);
  });

  it("swaps what two panels hold, also across pages", () => {
    const project = newProject("t", 2);
    const [page, next] = project.pages;
    const big = addPanel(project, page, rectShape([10, 10, 110, 110]));
    const small = addPanel(project, page, rectShape([120, 10, 170, 60]));
    const there = addPanel(project, next, rectShape([10, 10, 60, 60]));
    const drawing = addStroke(project, page, [[40, 40, 0.5], [60, 40, 0.5]], 0.5)!;
    const said = addLine(project, page, [140, 30], "小さいコマ");
    swapPanelContents(page, big, page, small);
    expect(panelContents(page, small).strokes).toEqual([drawing.id]);
    expect(panelContents(page, big).lines).toEqual([said.id]);
    expect(said.panel).toBe(big.id);
    swapPanelContents(page, small, next, there);
    expect(page.strokes).toEqual([]);
    expect(next.strokes).toEqual([drawing]);
    expect(panelContents(next, there).strokes).toEqual([drawing.id]);
  });

  it("takes fills and the panel memo along to another page", () => {
    const project = newProject("t", 3);
    const [first, , third] = project.pages;
    const a = addPanel(project, first, rectShape([10, 10, 110, 110]));
    const b = addPanel(project, third, rectShape([10, 120, 110, 220]));
    a.note = "引きの絵";
    const fill = addFill(project, first, rectShape([20, 20, 40, 40]), "black");
    swapPanelContents(first, a, third, b);
    expect(first.fills).toBeUndefined();
    expect(third.fills).toEqual([fill]);
    expect(fill.shape[0][1]).toBeGreaterThan(120);
    expect(b.note).toBe("引きの絵");
    expect(a.note).toBeUndefined();
  });
});

describe("ネーム用紙の空のページ", () => {
  it("counts the empty pages at the end only", async () => {
    const { trailingEmptyPages, newProject, addLine } = await import("./project");
    const project = newProject("t", 6);
    expect(trailingEmptyPages(project)).toBe(6);
    addLine(project, project.pages[1], [100, 100], "あ");
    expect(trailingEmptyPages(project)).toBe(4);
    project.pages[4].memo = "余白: 引用";
    expect(trailingEmptyPages(project)).toBe(1);
  });
});

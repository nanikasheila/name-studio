import { describe, expect, it } from "vitest";
import { bounds, rectShape } from "./geometry";
import type { Page, Point, Project } from "./model";
import { basicBox } from "./pagebox";
import { addPanel } from "./panels";
import { newProject } from "./project";
import { panelsToTidy, straightenShape, tidyPanels } from "./tidy";

// The default page: canvas 297 × 420, 基本枠 58.5..238.5 × 75..345, コマ間 2 side by side and 6 between rows.
function pageWith(...shapes: Point[][]): { project: Project; page: Page; ids: string[] } {
  const project = newProject("t", 1);
  const page = project.pages[0];
  const ids = shapes.map((shape) => {
    const panel = addPanel(project, page, shape);
    panel.draft = true;
    return panel.id;
  });
  return { project, page, ids };
}

const boxOf = (page: Page, id: string) => bounds(page.panels.find((p) => p.id === id)!.shape);
const tidyAll = ({ project, page }: { project: Project; page: Page }) => tidyPanels(project, page, panelsToTidy(page).map((p) => p.id));

describe("整える", () => {
  it("makes almost level and upright edges exact, keeping slanted ones", () => {
    const shape = straightenShape([[10, 10], [100, 12], [101, 80], [9, 79]]);
    expect(shape).toHaveLength(4);
    const [x0, y0, x1, y1] = bounds(shape);
    expect(shape.every(([x, y]) => [x0, x1].includes(x) && [y0, y1].includes(y))).toBe(true);
    // A cut at 15°: stays slanted.
    const slanted = straightenShape([[10, 10], [100, 10], [100, 34], [10, 58]]);
    expect(slanted[2][1]).toBeCloseTo(34);
    expect(slanted[3][1]).toBeCloseTo(58);
  });

  it("lines a rough grid up with the frame and makes the gutters the name's", () => {
    // Two rows of two drawn loosely: edges a little off the frame, gaps uneven, one overlapping.
    const drawn = pageWith(
      [[60, 77], [146, 76], [147, 160], [59, 162]],
      [[150, 74], [237, 76], [236, 161], [151, 159]],
      [[57, 170], [120, 168], [121, 343], [58, 346]],
      [[119, 171], [240, 169], [239, 344], [122, 343]],
    );
    const result = tidyAll(drawn);
    expect(result).toEqual({ tidied: 4, kept: 0 });
    const [a, b, c, d] = drawn.ids.map((id) => boxOf(drawn.page, id));
    const [fx0, fy0, fx1, fy1] = basicBox(drawn.project.pageFormat);
    expect([a[0], c[0]]).toEqual([fx0, fx0]);
    expect([b[2], d[2]]).toEqual([fx1, fx1]);
    expect([a[1], b[1]]).toEqual([fy0, fy0]);
    expect([c[3], d[3]]).toEqual([fy1, fy1]);
    // Side by side: 2 mm apart; the rows: 6 mm apart.
    expect(b[0] - a[2]).toBeCloseTo(2);
    expect(d[0] - c[2]).toBeCloseTo(2);
    expect(c[1] - a[3]).toBeCloseTo(6);
    expect(d[1] - b[3]).toBeCloseTo(6);
    expect(drawn.page.panels.every((panel) => !panel.draft)).toBe(true);
  });

  it("takes a panel drawn well past the frame off the paper (裁ち切り)", () => {
    const drawn = pageWith([[30, 40], [270, 42], [268, 200], [31, 199]]);
    tidyAll(drawn);
    const panel = drawn.page.panels[0];
    const [x0, y0, x1, y1] = bounds(panel.shape);
    expect([x0, y0, x1]).toEqual([0, 0, 297]);
    expect(y1).toBeCloseTo(199.5, 0);
    // The three sides off the paper are left open; the bottom is drawn.
    expect(panel.openEdges).toHaveLength(3);
  });

  it("lines up with panels left as they are", () => {
    const { project, page, ids } = pageWith([[61, 150], [150, 151], [151, 250], [60, 249]]);
    const fixed = addPanel(project, page, rectShape([60, 75, 238.5, 145]));
    tidyPanels(project, page, ids);
    expect(boxOf(page, fixed.id)).toEqual([60, 75, 238.5, 145]);
    const box = boxOf(page, ids[0]);
    // Its left edge in line with the panel above, 6 mm below it.
    expect(box[0]).toBe(60);
    expect(box[1]).toBeCloseTo(151);
  });

  it("changes nothing the second time", () => {
    const drawn = pageWith(
      [[60, 77], [146, 76], [147, 160], [59, 162]],
      [[150, 74], [237, 76], [236, 161], [151, 159]],
      [[57, 170], [120, 168], [121, 343], [58, 346]],
      [[119, 171], [240, 169], [239, 344], [122, 343]],
    );
    tidyAll(drawn);
    const once = JSON.stringify(drawn.page.panels);
    for (const panel of drawn.page.panels) panel.draft = true;
    tidyAll(drawn);
    expect(JSON.stringify(drawn.page.panels)).toBe(once);
  });

  it("makes a slanted gutter even", () => {
    // A row cut at a slant: the gap 3 mm at the left, 9 at the right.
    const drawn = pageWith(
      [[58.5, 75], [238.5, 75], [238.5, 150], [58.5, 130]],
      [[58.5, 133], [238.5, 159], [238.5, 345], [58.5, 345]],
    );
    tidyAll(drawn);
    const [top, bottom] = drawn.ids.map((id) => drawn.page.panels.find((p) => p.id === id)!.shape);
    const lower = (shape: Point[], x: number) => shape.filter(([px]) => px === x).map(([, y]) => y);
    const gapAt = (x: number) => Math.min(...lower(bottom, x)) - Math.max(...lower(top, x));
    expect(gapAt(58.5)).toBeCloseTo(gapAt(238.5), 1);
    expect(gapAt(58.5)).toBeGreaterThan(5.5);
  });

  it("takes what a panel holds along", () => {
    const { project, page, ids } = pageWith([[50, 70], [150, 72], [151, 160], [49, 158]]);
    page.strokes.push({ id: "s1", points: [[100, 100, 0.5], [110, 110, 0.5]], widthMm: 0.5, closed: false });
    tidyPanels(project, page, ids);
    const [x0, y0, x1, y1] = boxOf(page, ids[0]);
    const [px, py] = page.strokes[0].points[0];
    expect(px).toBeGreaterThan(x0);
    expect(px).toBeLessThan(x1);
    expect(py).toBeGreaterThan(y0);
    expect(py).toBeLessThan(y1);
  });

  it("chooses the chosen panels, else the 仮 ones, else all", () => {
    const { project, page, ids } = pageWith([[60, 80], [140, 80], [140, 160], [60, 160]]);
    const plain = addPanel(project, page, rectShape([150, 80, 230, 160]));
    expect(panelsToTidy(page).map((p) => p.id)).toEqual(ids);
    expect(panelsToTidy(page, [plain.id]).map((p) => p.id)).toEqual([plain.id]);
    delete page.panels.find((p) => p.id === ids[0])!.draft;
    expect(panelsToTidy(page)).toHaveLength(2);
  });
});

describe("整える on panels already exact", () => {
  it("leaves every panel pattern as it is", async () => {
    const { PATTERNS, applyPattern } = await import("./koma");
    const changed: string[] = [];
    for (const pattern of PATTERNS) {
      const project = newProject("t", 1);
      const page = project.pages[0];
      applyPattern(project, page, pattern.id);
      const before = page.panels.map((panel) => ({ id: panel.id, shape: panel.shape.map((p) => [...p]), open: panel.openEdges ?? [] }));
      tidyPanels(project, page, panelsToTidy(page).map((panel) => panel.id));
      for (const { id, shape, open } of before) {
        const after = page.panels.find((panel) => panel.id === id)!;
        const same =
          after.shape.length === shape.length &&
          after.shape.every((p, i) => Math.hypot(p[0] - shape[i][0], p[1] - shape[i][1]) < 0.01) &&
          JSON.stringify(after.openEdges ?? []) === JSON.stringify(open);
        if (!same) changed.push(`${pattern.id}: ${JSON.stringify(shape)} → ${JSON.stringify(after.shape)} open ${JSON.stringify(open)} → ${JSON.stringify(after.openEdges ?? [])}`);
      }
    }
    expect(changed).toEqual([]);
  });
});

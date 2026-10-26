import { describe, expect, it } from "vitest";
import { hiddenKeys, moveIntoPanel, pageLayers } from "./layers";
import { addLine } from "./dialogue";
import { bounds, rectShape } from "./geometry";
import { addPanel } from "./panels";
import { newProject } from "./project";
import { addFill, addStroke } from "./strokes";

function sample() {
  const project = newProject("t", 2);
  const [page, facing] = project.pages;
  const first = addPanel(project, page, rectShape([20, 20, 100, 100]));
  const second = addPanel(project, page, rectShape([20, 110, 100, 190]));
  const stroke = addStroke(project, page, [[30, 30, 1], [50, 40, 1]], 0.4)!;
  const line = addLine(project, page, [70, 60], "やあ");
  const outside = addStroke(project, page, [[150, 30, 1], [160, 40, 1]], 0.4)!;
  const fill = addFill(project, page, [[25, 25], [40, 25], [40, 35]], "black");
  const other = addPanel(project, facing, rectShape([30, 30, 90, 90]));
  return { project, page, facing, first, second, stroke, line, outside, fill, other };
}

describe("layers like CSP's panel folders", () => {
  it("lists each panel with what is drawn in it, and what is outside", () => {
    const { page, first, second, stroke, line, outside, fill } = sample();
    const layers = pageLayers(page);
    const held = layers.panels.find((p) => p.panel.id === first.id)!;
    expect(held.strokes).toEqual([stroke.id]);
    expect(held.lines).toEqual([line.id]);
    expect(held.fills).toEqual([fill.id]);
    expect(layers.panels.find((p) => p.panel.id === second.id)!.strokes).toEqual([]);
    expect(layers.outside.strokes).toEqual([outside.id]);
  });

  it("hides a panel with its contents", () => {
    const { page, first, stroke, line } = sample();
    const keys = hiddenKeys(pageLayers(page), { kind: "panel", pageId: page.id, id: first.id });
    expect(keys).toEqual(expect.arrayContaining([`panel:${first.id}`, `stroke:${stroke.id}`, `line:${line.id}`]));
  });

  it("moves rough lines into another panel, keeping where they sat", () => {
    const { page, second, stroke } = sample();
    expect(moveIntoPanel(page, { kind: "strokes", pageId: page.id, ids: [stroke.id] }, page, second)).toBe(true);
    // 90 mm down: the second panel's middle is 90 mm below the first's.
    expect(stroke.points.map(([x, y]) => [x, y])).toEqual([[30, 120], [50, 130]]);
    expect(pageLayers(page).panels.find((p) => p.panel.id === second.id)!.strokes).toEqual([stroke.id]);
  });

  it("moves dialogue onto the facing page's panel, inside it", () => {
    const { page, facing, other, line } = sample();
    expect(moveIntoPanel(page, { kind: "line", pageId: page.id, id: line.id }, facing, other)).toBe(true);
    expect(page.lines).not.toContain(line);
    expect(facing.lines).toContain(line);
    const [x0, y0, x1, y1] = bounds(other.shape);
    const [cx, cy] = [(line.box[0] + line.box[2]) / 2, (line.box[1] + line.box[3]) / 2];
    expect(cx).toBeGreaterThanOrEqual(x0);
    expect(cx).toBeLessThanOrEqual(x1);
    expect(cy).toBeGreaterThanOrEqual(y0);
    expect(cy).toBeLessThanOrEqual(y1);
  });
});

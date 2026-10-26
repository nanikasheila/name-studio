import { describe, expect, it } from "vitest";
import { heldNear, holdPanel, movePanelToPage, placeHeld } from "./hold";
import { addLine } from "./dialogue";
import { bounds, rectShape } from "./geometry";
import { addPanel } from "./panels";
import { newProject } from "./project";
import { addSticky, linkSticky, stickyAnchor } from "./stickies";
import { addStroke } from "./strokes";

function setUp() {
  const project = newProject("t", 4);
  const [first, , third] = project.pages;
  const top = addPanel(project, first, rectShape([20, 20, 180, 100]));
  const bottom = addPanel(project, first, rectShape([20, 110, 180, 200]));
  const line = addLine(project, first, [150, 50], "ここで止まる");
  const other = addLine(project, first, [150, 150], "下のコマ");
  line.panel = top.id;
  other.panel = bottom.id;
  const stroke = addStroke(project, first, [[40, 40, 1], [80, 80, 1]], 0.4)!;
  const sticky = addSticky(project, first, [200, 30], "間を長く");
  linkSticky(first, sticky, "panel", top.id, [30, 30]);
  top.note = "引き";
  return { project, first, third, top, bottom, line, other, stroke, sticky };
}

describe("保留コマ", () => {
  it("takes a panel off its page with what is in it, and puts it back elsewhere", () => {
    const { project, first, third, top, bottom, line, stroke, sticky } = setUp();
    const held = holdPanel(project, first, top, third.id);
    expect(first.panels.map((p) => p.id)).toEqual([bottom.id]);
    expect(bottom.order).toBe(1);
    expect(first.lines.map((l) => l.text)).toEqual(["下のコマ"]);
    expect(first.strokes).toEqual([]);
    expect(first.stickies).toBeUndefined();
    expect(held.lines.map((l) => l.id)).toEqual([line.id]);
    expect(held.strokes.map((s) => s.id)).toEqual([stroke.id]);
    expect(held.stickies?.map((s) => s.id)).toEqual([sticky.id]);
    expect(heldNear(project, 2, 2)).toEqual([held]);
    expect(heldNear(project, 0, 1)).toEqual([]);

    // Somewhere else on the third page: shape and contents move together.
    const placed = placeHeld(project, third, held, [100, 300]);
    expect(project.held).toBeUndefined();
    const [x0, y0, x1, y1] = bounds(placed.shape);
    expect([(x0 + x1) / 2, (y0 + y1) / 2]).toEqual([100, 300]);
    expect(placed.note).toBe("引き");
    const moved = third.lines.find((l) => l.id === line.id)!;
    expect(moved.panel).toBe(placed.id);
    expect(moved.box[1]).toBeGreaterThan(y0);
    // Tied 10 mm in from the corner, as it was.
    expect(stickyAnchor(third, third.stickies![0])).toEqual([x0 + 10, y0 + 10]);
  });

  it("fits what a held panel holds into a panel it is dropped on", () => {
    const { project, first, third, top } = setUp();
    const target = addPanel(project, third, rectShape([20, 220, 100, 340]));
    const held = holdPanel(project, first, top);
    const placed = placeHeld(project, third, held, undefined, target);
    expect(placed).toBe(target);
    expect(third.panels.length).toBe(1);
    expect(target.note).toBe("引き");
    const line = third.lines[0];
    expect(line.panel).toBe(target.id);
    const [x0, y0, x1, y1] = bounds(target.shape);
    const [cx, cy] = [(line.box[0] + line.box[2]) / 2, (line.box[1] + line.box[3]) / 2];
    expect(cx > x0 && cx < x1 && cy > y0 && cy < y1).toBe(true);
    expect(third.stickies![0].link?.id).toBe(target.id);
  });

  it("moves a panel to another page where it was", () => {
    const { project, first, third, top } = setUp();
    const box = bounds(top.shape);
    const moved = movePanelToPage(project, first, top, third);
    expect(bounds(moved.shape)).toEqual(box);
    expect(third.lines.map((l) => l.text)).toEqual(["ここで止まる"]);
    expect(project.held).toBeUndefined();
    expect(first.panels.length).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { addLine } from "./dialogue";
import { rectShape } from "./geometry";
import { addPanel } from "./panels";
import { newProject } from "./project";
import { removePicked, stillThere } from "./removal";
import { addStroke } from "./strokes";

function setUp() {
  const project = newProject("t", 2);
  const [page] = project.pages;
  const top = addPanel(project, page, rectShape([20, 20, 180, 100]));
  const bottom = addPanel(project, page, rectShape([20, 110, 180, 200]));
  const line = addLine(project, page, [150, 50], "親");
  const joined = addLine(project, page, [140, 60], "子");
  joined.linkTo = line.id;
  const stroke = addStroke(
    project,
    page,
    [
      [40, 40, 1],
      [80, 80, 1],
    ],
    0.4,
  )!;
  return { project, page, top, bottom, line, joined, stroke };
}

describe("taking things off a page", () => {
  it("removes a line and lets balloons joined to it come loose", () => {
    const { project, page, line, joined } = setUp();
    removePicked(project, { kind: "line", pageId: page.id, id: line.id });
    expect(page.lines.map((l) => l.id)).toEqual([joined.id]);
    expect(joined.linkTo).toBeUndefined();
  });

  it("removes a panel and numbers the rest again", () => {
    const { project, page, top, bottom } = setUp();
    removePicked(project, { kind: "panel", pageId: page.id, id: top.id });
    expect(page.panels.map((p) => p.id)).toEqual([bottom.id]);
    expect(bottom.order).toBe(1);
  });

  it("removes what was picked together, keeping what was drawn in a removed panel", () => {
    const { project, page, top, line, joined, stroke } = setUp();
    removePicked(project, {
      kind: "group",
      pageId: page.id,
      id: "group",
      items: [
        { kind: "panel", id: top.id },
        { kind: "line", id: line.id },
      ],
    });
    expect(page.panels).toHaveLength(1);
    expect(page.lines.map((l) => l.id)).toEqual([joined.id]);
    expect(joined.linkTo).toBeUndefined();
    expect(page.strokes.map((s) => s.id)).toEqual([stroke.id]);
  });

  it("tells whether what is picked is still there", () => {
    const { project, page, line, stroke } = setUp();
    const group = {
      kind: "group" as const,
      pageId: page.id,
      id: "group",
      items: [
        { kind: "line" as const, id: line.id },
        { kind: "stroke" as const, id: stroke.id },
      ],
    };
    expect(stillThere(project, group)).toBe(true);
    removePicked(project, { kind: "stroke", pageId: page.id, id: stroke.id });
    expect(stillThere(project, group)).toBe(false);
    expect(stillThere(project, { kind: "line", pageId: page.id, id: line.id })).toBe(true);
    expect(stillThere(null, { kind: "line", pageId: page.id, id: line.id })).toBe(false);
  });
});

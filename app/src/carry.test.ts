import { describe, expect, it } from "vitest";
import { carryItems, carrySticky, type Destination } from "./carry";
import type { Line, Point } from "./model";
import { newProject } from "./project";

const line = (id: string, box: [number, number, number, number], extra: Partial<Line> = {}): Line => ({ id, text: "あ", kind: "speech", box, fontSizePt: 9, vertical: true, ...extra });

/** Two pages side by side, the second 200 mm to the left on screen: past x = 0 of the first is the second. */
function setting() {
  const project = newProject("t", 2);
  const [from, other] = project.pages;
  const under = (point: Point): Destination | null => (point[0] < 0 ? { page: other, offset: [200, 0] } : null);
  return { project, from, other, under };
}

describe("ほかのページへ運ぶ", () => {
  it("moves the lines and rough lines whose middle is over the other page, where they were on screen", () => {
    const { project, from, other, under } = setting();
    from.lines = [line("over", [-20, 10, -10, 30], { linkTo: "stay" }), line("stay", [20, 10, 30, 30])];
    from.strokes = [{ id: "s", points: [[-30, 5, 1], [-10, 5, 1]], widthMm: 0.5, closed: false }];
    const { moved, to } = carryItems(project, from, [{ kind: "line", id: "over" }, { kind: "line", id: "stay" }, { kind: "stroke", id: "s" }], under);
    expect(moved.map((item) => item.id)).toEqual(["over", "s"]);
    expect([...to]).toEqual([other]);
    expect(from.lines.map((l) => l.id)).toEqual(["stay"]);
    expect(other.lines[0].box).toEqual([180, 10, 190, 30]);
    // Joined balloons are on one page.
    expect(other.lines[0].linkTo).toBeUndefined();
    expect(other.strokes[0].points.map(([x]) => x)).toEqual([170, 190]);
  });

  it("leaves panels, fills and はみ出し on their page", () => {
    const { project, from, under } = setting();
    from.panels = [{ id: "p", shape: [[-30, 0], [-10, 0], [-10, 20], [-30, 20]], order: 1 }];
    const { moved } = carryItems(project, from, [{ kind: "panel", id: "p" }, { kind: "fill", id: "f" }], under);
    expect(moved).toEqual([]);
    expect(from.panels).toHaveLength(1);
  });

  it("puts the lines it brings in reading order there", () => {
    const { project, from, other, under } = setting();
    other.panels = [{ id: "a", shape: [[100, 0], [200, 0], [200, 100], [100, 100]], order: 1 }, { id: "b", shape: [[0, 0], [100, 0], [100, 100], [0, 100]], order: 2 }];
    other.lines = [line("later", [40, 40, 50, 60], { panel: "b" })];
    from.lines = [line("first", [-40, 40, -30, 60], { panel: "a" })];
    carryItems(project, from, [{ kind: "line", id: "first" }], under);
    expect(other.lines.map((l) => l.id)).toEqual(["first", "later"]);
  });

  it("moves a 付箋 over the other page, but not one tied to a panel or a line", () => {
    const { project, from, other, under } = setting();
    const loose = { id: "n", text: "x", at: [-60, 20] as Point };
    const tied = { id: "t", text: "x", at: [-60, 40] as Point, link: { kind: "panel" as const, id: "p", at: [0, 0] as Point } };
    from.stickies = [loose, tied];
    expect(carrySticky(project, from, loose, under)).toBe(other);
    expect(carrySticky(project, from, tied, under)).toBeNull();
    expect(from.stickies.map((n) => n.id)).toEqual(["t"]);
    expect(other.stickies?.map((n) => n.id)).toEqual(["n"]);
    expect(loose.at[0]).toBeGreaterThan(0);
  });
});


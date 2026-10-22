import { describe, expect, it } from "vitest";
import { SHAPE_LABELS, pageBalloons, resolvedShape, star, withTails } from "./balloon";
import { emptyPage, insidePolygon, normalize, newProject, type BalloonShape, type Line, type Point } from "./project";

function line(id: string, box: [number, number, number, number], extra: Partial<Line> = {}): Line {
  return { id, text: "セリフ", kind: "speech", box, fontSizePt: 13, vertical: true, ...extra };
}

const shapes = Object.keys(SHAPE_LABELS).filter((s) => !["auto", "none", "custom"].includes(s)) as BalloonShape[];

describe("balloon shapes", () => {
  it.each(shapes)("%s goes round the text", (shape) => {
    const l = line("line1", [100, 100, 112, 140], { balloonShape: shape });
    const s = star(l)!;
    const outline = s.samples.map((x) => x.point);
    expect(outline.length).toBeGreaterThanOrEqual(4);
    for (const corner of [
      [100, 100],
      [112, 100],
      [112, 140],
      [100, 140],
    ] as Point[]) {
      expect(insidePolygon(outline, corner)).toBe(true);
    }
    // Samples run round by angle.
    const angles = s.samples.map((x) => x.angle);
    expect([...angles].sort((a, b) => a - b)).toEqual(angles);
  });

  it("follows the kind of line unless chosen", () => {
    expect(resolvedShape(line("a", [0, 0, 5, 5], { kind: "thought" }))).toBe("cloud");
    expect(resolvedShape(line("a", [0, 0, 5, 5], { kind: "narration" }))).toBe("box");
    expect(resolvedShape(line("a", [0, 0, 5, 5], { kind: "aside" }))).toBe("none");
    expect(star(line("a", [0, 0, 5, 5], { kind: "sfx" }))).toBeNull();
    expect(resolvedShape(line("a", [0, 0, 5, 5], { kind: "thought", balloonShape: "spike" }))).toBe("spike");
  });

  it("keeps the same burst between redraws", () => {
    const a = star(line("line7", [0, 0, 10, 30], { balloonShape: "burst" }))!;
    const b = star(line("line7", [0, 0, 10, 30], { balloonShape: "burst" }))!;
    expect(a.samples).toEqual(b.samples);
  });
});

describe("tails", () => {
  const base = line("line1", [100, 100, 112, 140]);
  const s = star(base)!;

  it("splices a wedge reaching the speaker into the outline", () => {
    const tip: Point = [80, 170];
    const { star: tailed, extras } = withTails(s, base, [{ tip }]);
    expect(extras).toEqual([]);
    expect(tailed.samples.map((x) => x.point)).toContainEqual(tip);
    // The outline still holds the text and now also the start of the tail.
    const outline = tailed.samples.map((x) => x.point);
    expect(insidePolygon(outline, [106, 120])).toBe(true);
    expect(insidePolygon(outline, [84, 163])).toBe(true);
  });

  it("draws thought bubbles and line tails beside the outline", () => {
    const bubbles = withTails(s, base, [{ tip: [80, 170], style: "bubbles" }]);
    expect(bubbles.extras).toHaveLength(3);
    expect(bubbles.extras.every((e) => e.closed)).toBe(true);
    expect(bubbles.star.samples).toHaveLength(s.samples.length);
    const pointer = withTails(s, base, [{ tip: [60, 200], style: "line" }]);
    expect(pointer.extras).toEqual([{ points: [expect.any(Array), [60, 200]], closed: false }]);
  });

  it("ignores a tail whose tip is inside the balloon", () => {
    const { star: tailed } = withTails(s, base, [{ tip: [106, 120] }]);
    expect(tailed.samples).toEqual(s.samples);
  });
});

describe("linked balloons", () => {
  it("join into one outline with a neck", () => {
    const page = emptyPage("page1");
    page.lines.push(line("line1", [150, 100, 162, 130]), line("line2", [110, 140, 122, 170], { linkTo: "line1" }));
    const drawings = pageBalloons(page);
    expect(drawings).toHaveLength(1);
    expect(drawings[0].lines.map((l) => l.id)).toEqual(["line1", "line2"]);
    const outline = drawings[0].outline;
    expect(insidePolygon(outline, [156, 115])).toBe(true);
    expect(insidePolygon(outline, [116, 155])).toBe(true);
    // The neck between the two centres is inside too.
    expect(insidePolygon(outline, [136, 135])).toBe(true);
  });

  it("stay apart without a link", () => {
    const page = emptyPage("page1");
    page.lines.push(line("line1", [150, 100, 162, 130]), line("line2", [110, 140, 122, 170]));
    expect(pageBalloons(page)).toHaveLength(2);
  });
});

describe("older files", () => {
  it("keep imported outlines as they were drawn", () => {
    const project = newProject("t", 1);
    project.formatVersion = 1;
    const imported: Point[] = Array.from({ length: 23 }, (_, i) => [Math.cos(i) * 10, Math.sin(i) * 10]);
    project.pages[0].lines.push(line("line9", [0, 0, 4, 4], { balloon: imported }));
    normalize(project);
    expect(project.pages[0].lines[0].balloonShape).toBe("custom");
    expect(project.formatVersion).toBe(2);
  });
});

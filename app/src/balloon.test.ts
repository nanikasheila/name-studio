import { describe, expect, it } from "vitest";
import { SHAPE_LABELS, insideBalloon, pageBalloons, resolvedShape, star, tailGeometry, tailRootAt, withTails } from "./balloon";
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

  it("keeps the ends of a tall narrow ellipse round", () => {
    // One short column of text: the balloon is far taller than wide.
    const outline = star(line("line1", [100, 100, 106, 160]))!.samples.map((x) => x.point);
    // Going round, the outline turns little from one segment to the next, at the ends too.
    let sharpest = 0;
    for (let i = 0; i < outline.length; i++) {
      const [a, b, c] = [outline[i], outline[(i + 1) % outline.length], outline[(i + 2) % outline.length]];
      const turn = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]));
      sharpest = Math.max(sharpest, Math.min(turn, 2 * Math.PI - turn));
    }
    expect(sharpest).toBeLessThan((12 * Math.PI) / 180);
  });

  it("leaves the balloon where its 根本 is put, the tip staying where it is", () => {
    const l = line("line1", [100, 100, 112, 140], { tails: [{ tip: [80, 170] }] });
    const s = star(l)!;
    const free = tailGeometry(l, l.tails![0])!;
    // Towards the tip by default: down and to the left of the centre.
    expect(free.root[0]).toBeLessThan(s.center[0]);
    // Moved to the right side of the balloon.
    l.tails![0].root = 0;
    const moved = tailGeometry(l, l.tails![0])!;
    expect(moved.root[1]).toBeCloseTo(s.center[1], 5);
    expect(moved.root[0]).toBeGreaterThan(112);
    const outline = withTails(s, l).star.samples.map((sample) => sample.point);
    expect(outline).toContainEqual([80, 170]);
    // Near the tip's own direction it follows the tip again.
    const towards = Math.atan2(170 - s.center[1], 80 - s.center[0]);
    const near: Point = [s.center[0] + Math.cos(towards + 0.02) * 30, s.center[1] + Math.sin(towards + 0.02) * 30];
    expect(tailRootAt(l, l.tails![0], near)).toBeNull();
    expect(tailRootAt(l, l.tails![0], [200, s.center[1]])).toBe(0);
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

describe("bent tails", () => {
  it("bows a tail to one side and keeps it in the outline", () => {
    const straight = line("line1", [100, 100, 112, 140], { tails: [{ tip: [80, 170] }] });
    const bent = line("line1", [100, 100, 112, 140], { tails: [{ tip: [80, 170], bend: 6 }] });
    const outline = (l: Line) => withTails(star(l)!, l).star.samples.map((x) => x.point);
    const geometry = tailGeometry(bent, bent.tails![0])!;
    // The handle sits 6 mm to the side of the straight tail's middle.
    const plain = tailGeometry(straight, straight.tails![0])!;
    expect(Math.hypot(geometry.middle[0] - plain.middle[0], geometry.middle[1] - plain.middle[1])).toBeCloseTo(6);
    // The bent outline passes by the handle; the straight one stays away from it.
    const nearest = (points: Point[]) => Math.min(...points.map((p) => Math.hypot(p[0] - geometry.middle[0], p[1] - geometry.middle[1])));
    expect(nearest(outline(bent))).toBeLessThan(2.5);
    expect(nearest(outline(straight))).toBeGreaterThan(3.5);
    expect(outline(bent)).toContainEqual([80, 170]);
    // Still a closed outline with the samples in angle order.
    const angles = withTails(star(bent)!, bent).star.samples.map((x) => x.angle);
    expect([...angles].sort((a, b) => a - b)).toEqual(angles);
  });

  it("tells a point inside the balloon from one on its tail", () => {
    const l = line("line1", [100, 100, 112, 140], { tails: [{ tip: [80, 170] }] });
    expect(insideBalloon(l, [106, 120])).toBe(true);
    expect(insideBalloon(l, [82, 165])).toBe(false);
  });
});

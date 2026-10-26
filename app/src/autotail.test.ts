import { describe, expect, it } from "vitest";
import { addAutoTails, figures, wantsTail } from "./autotail";
import { balloonExtent } from "./balloon";
import { addLine } from "./dialogue";
import { boxCenter, insidePolygon, rectShape } from "./geometry";
import type { Point } from "./model";
import { addPanel } from "./panels";
import { newProject } from "./project";
import { assignPanels } from "./readingorder";
import { addStroke } from "./strokes";

/** A stick figure: head circle and body, `x` its middle, standing on `y`. */
function figure(x: number, y: number): Point[][] {
  const head: Point[] = Array.from({ length: 12 }, (_, i) => [x + 4 * Math.cos((i / 12) * 2 * Math.PI), y - 36 + 4 * Math.sin((i / 12) * 2 * Math.PI)]);
  return [head, [[x, y - 32], [x, y - 12]], [[x, y - 12], [x - 5, y]], [[x, y - 12], [x + 5, y]]];
}

describe("しっぽを付ける", () => {
  it("aims each speaker at a figure, the first to speak at the rightmost", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const panel = addPanel(project, page, rectShape([60, 60, 240, 160]));
    for (const stroke of [...figure(200, 155), ...figure(100, 155)]) addStroke(project, page, stroke.map(([x, y]) => [x, y, 0.5]), 0.5);
    expect(figures(page, panel).length).toBe(2);
    const a = addLine(project, page, [190, 80], "やあ");
    a.speaker = "a";
    const b = addLine(project, page, [110, 80], "どうも");
    b.speaker = "b";
    const again = addLine(project, page, [160, 80], "元気？");
    again.speaker = "a";
    assignPanels(page);
    expect(addAutoTails(page)).toBe(3);
    // a's tail heads right-down to the right figure, b's to the left one.
    const [ax] = a.tails![0].tip;
    const [bx] = b.tails![0].tip;
    expect(ax).toBeGreaterThan(boxCenter(a.box)[0] - 1);
    expect(bx).toBeLessThan(boxCenter(b.box)[0] + 1);
    // The same speaker again: towards the same figure (rightwards).
    expect(again.tails![0].tip[0]).toBeGreaterThan(boxCenter(again.box)[0]);
    for (const line of [a, b, again]) {
      const tip = line.tails![0].tip;
      const [x0, y0, x1, y1] = balloonExtent(line);
      // Outside its balloon, inside the panel.
      expect(tip[0] < x0 || tip[0] > x1 || tip[1] < y0 || tip[1] > y1).toBe(true);
      expect(insidePolygon(panel.shape, tip)).toBe(true);
    }
    // Nothing left to do.
    expect(addAutoTails(page)).toBe(0);
  });

  it("points down into the panel when nothing is drawn, and leaves other kinds alone", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const panel = addPanel(project, page, rectShape([60, 60, 240, 200]));
    const said = addLine(project, page, [150, 80], "あのね");
    const told = addLine(project, page, [90, 80], "昔々", "narration");
    assignPanels(page);
    expect(wantsTail(page, told)).toBe(false);
    expect(addAutoTails(page)).toBe(1);
    expect(told.tails).toBeUndefined();
    const tip = said.tails![0].tip;
    expect(tip[1]).toBeGreaterThan(balloonExtent(said)[3]);
    expect(insidePolygon(panel.shape, tip)).toBe(true);
  });
});

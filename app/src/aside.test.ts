import { describe, expect, it } from "vitest";
import { asideCount, asideRoom, heldBox, layAside, offPage, onPageOnly, reachesOff, strokeBox } from "./aside";
import { bounds, rectShape } from "./geometry";
import { holdPanel, placeHeld } from "./hold";
import { layoutPages } from "./layout";
import { addPanel } from "./panels";
import { newProject } from "./project";
import { addReference } from "./references";
import { addSticky, settleSticky, stickyBox } from "./stickies";
import { addStroke } from "./strokes";

function setUp() {
  const project = newProject("t", 4);
  const [w, h] = project.pageFormat.canvasMm;
  const first = project.pages[0];
  const onPage = addStroke(project, first, [[40, 40, 1], [80, 80, 1]], 0.4)!;
  const across = addStroke(project, first, [[w - 10, 40, 1], [w + 20, 40, 1]], 0.4)!;
  const beside = addStroke(project, first, [[w + 20, 40, 1], [w + 60, 90, 1]], 0.4)!;
  const above = addStroke(project, first, [[30, -50, 1], [90, -20, 1]], 0.4)!;
  return { project, first, w, h, onPage, across, beside, above };
}

describe("欄外", () => {
  it("tells what lies off the page from what is on it or reaches past its edge", () => {
    const { project, onPage, across, beside, above } = setUp();
    const format = project.pageFormat;
    expect([onPage, across, beside, above].map((s) => offPage(strokeBox(s), format))).toEqual([false, false, true, true]);
    expect([onPage, across, beside, above].map((s) => reachesOff(strokeBox(s), format))).toEqual([false, true, true, true]);
  });

  it("writes only what is on the page to CSP (a line reaching past the edge stays)", () => {
    const { project, first, onPage, across, w } = setUp();
    const picture = { id: "image1", name: "a.png", mime: "image/png" as const, dataBase64: "", widthPx: 100, heightPx: 100 };
    const under = addReference(project, first, picture);
    const aside = addReference(project, first, picture, [w + 80, 100]);
    addSticky(project, first, [30, 30], "ページの上");
    addSticky(project, first, [w + 30, 10], "考えごと");
    const written = onPageOnly(first, project.pageFormat);
    expect(written.strokes.map((s) => s.id)).toEqual([onPage.id, across.id]);
    expect(written.references?.map((r) => r.id)).toEqual([under.id]);
    expect(written.stickies?.map((s) => s.text)).toEqual(["ページの上"]);
    // The name itself keeps all of it.
    expect(first.strokes.length).toBe(4);
    expect(asideCount(project, first)).toBe(4);
    // A picture put beside the page is looked at, not drawn over: full strength.
    expect(aside.opacity).toBe(1);
    expect(under.opacity).toBeUndefined();
  });

  it("leaves a page with nothing beside it as it is", () => {
    const project = newProject("t", 2);
    const page = project.pages[0];
    addStroke(project, page, [[40, 40, 1], [80, 80, 1]], 0.4);
    expect(onPageOnly(page, project.pageFormat)).toBe(page);
  });

  it("keeps a 付箋 on its page or in its 欄外, never across the edge", () => {
    const project = newProject("t", 2);
    const [w, h] = project.pageFormat.canvasMm;
    const page = project.pages[0];
    const inside = addSticky(project, page, [w - 40, 50], "内");
    expect(stickyBox(inside)[2]).toBeLessThanOrEqual(w);
    const outside = addSticky(project, page, [w + 5, 50], "外");
    expect(outside.at).toEqual([w + 5, 50]);
    // Its middle off the page, but still over it: pushed out the shortest way.
    outside.at = [w - 20, h - 5];
    settleSticky(project, outside);
    expect(stickyBox(outside)[1]).toBeCloseTo(h);
    expect(offPage(stickyBox(outside), project.pageFormat)).toBe(true);
  });

  it("lays a held panel above its page, clear of what is already there", () => {
    const project = newProject("t", 4);
    const page = project.pages[1];
    const a = addPanel(project, page, rectShape([20, 20, 180, 100]));
    const b = addPanel(project, page, rectShape([20, 110, 180, 200]));
    const first = holdPanel(project, page, a);
    layAside(project, first, page);
    const second = holdPanel(project, page, b);
    layAside(project, second, page);
    const [, y0a, , y1a] = heldBox(first)!;
    const [, y0b, , y1b] = heldBox(second)!;
    expect(y1a).toBeLessThan(0);
    expect(y1b).toBeLessThan(y0a);
    expect(y1a - y0a).toBeCloseTo(80);
    expect(y1b - y0b).toBeCloseTo(90);
    expect(asideCount(project, page)).toBe(2);
    // Put on a page, it leaves the 欄外.
    const placed = placeHeld(project, project.pages[2], first, [100, 100]);
    const [px0, py0, px1, py1] = bounds(placed.shape);
    expect([(px0 + px1) / 2, (py0 + py1) / 2]).toEqual([100, 100]);
    expect(project.held?.map((h) => h.id)).toEqual([second.id]);
  });

  it("makes room between the pages of 連続 for what lies beside them", () => {
    const { project, h } = setUp();
    const [top, right, bottom, left] = asideRoom(project, 1000);
    expect(top).toBeGreaterThanOrEqual(50);
    expect(right).toBeGreaterThanOrEqual(60);
    expect(bottom).toBe(0);
    expect(left).toBe(0);
    // At most `most` on a side.
    expect(asideRoom(project, 30)[0]).toBe(30);
    const view = { single: false, continuous: true, rows: 2, zoom: 1, pan: [0, 0] as [number, number], width: 1200, height: 800 };
    const list: [number | null, number | null][] = [[1, null], [2, 3], [4, null]];
    const tight = layoutPages(project, list, 0, view);
    const roomy = layoutPages(project, list, 0, { ...view, room: [top, right, bottom, left] });
    const rowPitch = (slots: typeof tight) => slots.find((s) => s.index === 3)!.y - slots[0].y;
    expect(rowPitch(roomy) - rowPitch(tight)).toBeCloseTo((top + bottom) * tight[0].scale);
    // The first row starts low enough to show what is above it.
    expect(roomy[0].y - top * roomy[0].scale).toBeCloseTo(tight[0].y);
    expect(h).toBeGreaterThan(0);
  });
});

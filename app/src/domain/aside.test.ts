import { describe, expect, it } from "vitest";
import { asideCount, asideRooms, heldBox, layAside, offPage, onPageOnly, reachesOff, strokeBox } from "./aside";
import { bounds, rectShape } from "../model/geometry";
import { holdPanel, placeHeld } from "./hold";
import { layoutPages } from "../editing/layout";
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
    const rooms = asideRooms(project, 1000);
    const [top, right, bottom, left] = rooms[0];
    expect(top).toBeGreaterThanOrEqual(50);
    expect(right).toBeGreaterThanOrEqual(60);
    expect(bottom).toBe(0);
    expect(left).toBe(0);
    // Only for the page it lies beside.
    expect(rooms.slice(1)).toEqual([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    // At most `most` on a side.
    expect(asideRooms(project, 30)[0][0]).toBe(30);
    const view = { single: false, continuous: true, rows: 2, zoom: 1, pan: [0, 0] as [number, number], width: 1200, height: 800 };
    const list: [number | null, number | null][] = [[1, null], [2, 3], [4, null]];
    const tight = layoutPages(project, list, 0, view);
    const roomy = layoutPages(project, list, 0, { ...view, rooms });
    const rowPitch = (slots: typeof tight) => slots.find((s) => s.index === 3)!.y - slots[0].y;
    // What is above page 1 needs room above the first row only: the second row (page 4, nothing beside it) stays as close.
    expect(rowPitch(roomy)).toBeCloseTo(rowPitch(tight));
    // Something above page 4 pushes its row down by as much.
    addStroke(project, project.pages[3], [[30, -40, 1], [90, -20, 1]], 0.4);
    const four = asideRooms(project, 1000);
    expect(rowPitch(layoutPages(project, list, 0, { ...view, rooms: four })) - rowPitch(tight)).toBeCloseTo(four[3][0] * tight[0].scale);
    // The first row starts low enough to show what is above it.
    expect(roomy[0].y - top * roomy[0].scale).toBeCloseTo(tight[0].y);
    expect(h).toBeGreaterThan(0);
  });

  it("widens only the gaps beside the page with something in its 欄外", () => {
    // 1 row of spreads, right binding: [1] then [2,3], [4,5], [6,7] going left.
    const project = newProject("t", 7);
    const [w] = project.pageFormat.canvasMm;
    addSticky(project, project.pages[0], [w + 10, 20], "1 ページの右の外");
    const view = { single: false, continuous: true, rows: 1, zoom: 0.3, pan: [0, 0] as [number, number], width: 1600, height: 800 };
    const list: [number | null, number | null][] = [[1, null], [2, 3], [4, 5], [6, 7]];
    const tight = layoutPages(project, list, 0, view);
    const rooms = asideRooms(project, 1000);
    expect(rooms[0][1]).toBeGreaterThan(0);
    const roomy = layoutPages(project, list, 0, { ...view, rooms });
    const x = (slots: typeof tight, index: number) => slots.find((s) => s.index === index)!.x;
    const scale = tight[0].scale;
    // Page 1 moves left by its room on the right; every other page goes along, and the gaps between them stay.
    const shift = x(roomy, 0) - x(tight, 0);
    expect(shift).toBeCloseTo(-rooms[0][1] * scale);
    for (const index of [1, 2, 3, 4, 5, 6]) expect(x(roomy, index) - x(tight, index), `page ${index + 1}`).toBeCloseTo(shift);
    // No room above or below: the row stays where it was.
    expect(roomy[0].y).toBeCloseTo(tight[0].y);
  });

  it("keeps no room for what is hidden on screen", () => {
    const project = newProject("t", 2);
    const [w] = project.pageFormat.canvasMm;
    const sticky = addSticky(project, project.pages[1], [w + 10, 20], "外");
    expect(asideRooms(project, 1000)[1][1]).toBeGreaterThan(0);
    expect(asideRooms(project, 1000, (kind) => kind !== "sticky")[1]).toEqual([0, 0, 0, 0]);
    expect(asideRooms(project, 1000, (kind, id) => !(kind === "sticky" && id === sticky.id))[1]).toEqual([0, 0, 0, 0]);
  });
});

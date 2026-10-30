import { describe, expect, it } from "vitest";
import { area, bounds } from "./geometry";
import { fillAt, fillInside, fillUnder, type FillOptions, type FillResult, type Region } from "./fillregion";
import type { Page, Point, Project, Stroke, StrokePoint } from "./model";
import { defaultFillSettings, fillSettingsFrom, nextFillWay } from "./fillsettings";
import { carryContents, followPanel } from "./panels";
import { newProject } from "./project";
import { insideFill } from "./strokes";
import { copySelection, moveItems, pasteClip, transformBase, transformItems } from "./transform";

const OPTIONS: FillOptions = { gapMm: 0, center: true, growMm: 0, refer: "all" };

function setup(): { project: Project; page: Page } {
  const project = newProject("塗り", 1);
  return { project, page: project.pages[0] };
}

let next = 0;
/** A closed rough line through the corners (full pressure, 0.5 mm wide). */
function line(page: Page, corners: Point[], closed = true, widthMm = 0.5): Stroke {
  const points = (closed ? [...corners, corners[0]] : corners).map(([x, y]) => [x, y, 1] as StrokePoint);
  const stroke: Stroke = { id: `s${next++}`, points, widthMm, closed: false };
  page.strokes.push(stroke);
  return stroke;
}

function square(x: number, y: number, size: number): Point[] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ];
}

function regions(result: FillResult): Region[] {
  if ("none" in result) throw new Error(`no fill: ${result.none}`);
  return result.regions;
}

const filled = (region: Region) => area(region.shape) - (region.holes ?? []).reduce((sum, hole) => sum + area(hole), 0);

describe("塗りつぶし", () => {
  it("fills the closed area round the point up to the middle of the line", () => {
    const { project, page } = setup();
    line(page, square(20, 20, 30));
    const [region, ...rest] = regions(fillAt(project, page, [35, 35], OPTIONS));
    expect(rest).toEqual([]);
    const [x0, y0, x1, y1] = bounds(region.shape);
    // To the middle of the line, within a cell (0.2 mm) or so.
    for (const [got, want] of [[x0, 20], [y0, 20], [x1, 50], [y1, 50]]) expect(Math.abs(got - want)).toBeLessThan(0.35);
    expect(filled(region)).toBeGreaterThan(29.4 * 29.4);
  });

  it("stops at the edge of the line without ベクターの中心で塗り止まり", () => {
    const { project, page } = setup();
    line(page, square(20, 20, 30), true, 1);
    const [region] = regions(fillAt(project, page, [35, 35], { ...OPTIONS, center: false }));
    const [x0, , x1] = bounds(region.shape);
    expect(Math.abs(x0 - 20.5)).toBeLessThan(0.35);
    expect(Math.abs(x1 - 49.5)).toBeLessThan(0.35);
  });

  it("goes out through a gap, unless 隙間閉じ closes it", () => {
    const { project, page } = setup();
    // A square with a 0.6 mm gap in its top side.
    line(page, [[35.3, 20], [50, 20], [50, 50], [20, 50], [20, 20], [34.7, 20]], false);
    const open = fillAt(project, page, [35, 35], OPTIONS);
    expect("none" in open ? null : open.wholePage).toBe(true);
    const [region, ...rest] = regions(fillAt(project, page, [35, 35], { ...OPTIONS, gapMm: 1 }));
    expect(rest).toEqual([]);
    const [x0, y0, x1, y1] = bounds(region.shape);
    expect(x1 - x0).toBeLessThan(31);
    expect(y1 - y0).toBeLessThan(31);
    // The band the gap closing kept from the lines is filled again.
    expect(filled(region)).toBeGreaterThan(29 * 29);
  });

  it("leaves a hole round a closed line inside the area", () => {
    const { project, page } = setup();
    line(page, square(20, 20, 40));
    line(page, square(30, 30, 10));
    const [region] = regions(fillAt(project, page, [25, 25], OPTIONS));
    expect(region.holes).toHaveLength(1);
    expect(insideFill({ shape: region.shape, holes: region.holes }, [25, 25])).toBe(true);
    expect(insideFill({ shape: region.shape, holes: region.holes }, [35, 35])).toBe(false);
    // Each edge within a cell or so of the middle of its line.
    expect(Math.abs(filled(region) - (40 * 40 - 10 * 10))).toBeLessThan(50);
  });

  it("says when the point is on a line", () => {
    const { project, page } = setup();
    line(page, square(20, 20, 30), true, 2);
    expect(fillAt(project, page, [20, 35], { ...OPTIONS, center: false })).toEqual({ none: "onLine" });
  });

  it("is bounded by panel borders, and by them only with 参照 コマ枠だけ", () => {
    const { project, page } = setup();
    page.panels.push({ id: "p1", shape: square(10, 10, 60), order: 1 });
    line(page, square(20, 20, 20));
    const all = regions(fillAt(project, page, [15, 15], OPTIONS));
    expect(all[0].holes).toHaveLength(1);
    const panels = regions(fillAt(project, page, [30, 30], { ...OPTIONS, refer: "panels" }));
    expect(panels[0].holes ?? []).toEqual([]);
    expect(filled(panels[0])).toBeGreaterThan(59 * 59);
    const rough = regions(fillAt(project, page, [30, 30], { ...OPTIONS, refer: "rough" }));
    expect(filled(rough[0])).toBeLessThan(21 * 21);
  });

  it("grows and shrinks the area (領域拡縮)", () => {
    const { project, page } = setup();
    line(page, square(20, 20, 30));
    const plain = filled(regions(fillAt(project, page, [35, 35], OPTIONS))[0]);
    const grown = filled(regions(fillAt(project, page, [35, 35], { ...OPTIONS, growMm: 1 }))[0]);
    const shrunk = filled(regions(fillAt(project, page, [35, 35], { ...OPTIONS, growMm: -1 }))[0]);
    expect(grown).toBeGreaterThan(plain + 100);
    expect(shrunk).toBeLessThan(plain - 100);
  });

  it("stops at fills already made", () => {
    const { project, page } = setup();
    line(page, square(20, 20, 30));
    page.fills = [{ id: "f1", shape: [[20, 20], [50, 20], [50, 35], [20, 35]] }];
    const [region] = regions(fillAt(project, page, [35, 45], OPTIONS));
    const [, y0] = bounds(region.shape);
    expect(y0).toBeGreaterThan(34.4);
  });
});

describe("囲って塗る", () => {
  it("fills every closed area wholly inside the outline, and none that goes out of it", () => {
    const { project, page } = setup();
    line(page, square(20, 20, 10));
    line(page, square(40, 20, 10));
    // Round both: both.
    expect(regions(fillInside(project, page, square(15, 15, 40), OPTIONS))).toHaveLength(2);
    // Round the first only.
    const one = regions(fillInside(project, page, square(15, 15, 20), OPTIONS));
    expect(one).toHaveLength(1);
    expect(bounds(one[0].shape)[2]).toBeLessThan(31);
    // Over half of a square: nothing closed inside.
    expect(fillInside(project, page, square(15, 15, 10), OPTIONS)).toEqual({ none: "nothingClosed" });
  });

  it("fills the areas next to each other with no gap along the line between them", () => {
    const { project, page } = setup();
    line(page, square(20, 20, 20));
    line(page, [[30, 20], [30, 40]], false);
    const found = regions(fillInside(project, page, square(15, 15, 30), OPTIONS));
    // Both halves reach the middle line: together they are one area.
    expect(found).toHaveLength(1);
    expect(filled(found[0])).toBeGreaterThan(19.5 * 19.5);
  });
});

describe("塗り残し部分に塗る", () => {
  it("fills a sliver between a fill and the line under the brush", () => {
    const { project, page } = setup();
    line(page, square(20, 20, 30));
    // A fill that stops 1 mm short of the bottom line.
    page.fills = [{ id: "f1", shape: [[20, 20], [50, 20], [50, 49], [20, 49]] }];
    const [region] = regions(fillUnder(project, page, [[22, 49.5], [48, 49.5]], 1.5, OPTIONS));
    const [x0, y0, x1, y1] = bounds(region.shape);
    expect(y0).toBeGreaterThan(48.5);
    expect(y1).toBeLessThan(50.5);
    expect(x1 - x0).toBeGreaterThan(29);
  });

  it("leaves a large area the brush only went into", () => {
    const { project, page } = setup();
    line(page, square(20, 20, 30));
    expect(fillUnder(project, page, [[30, 30], [32, 30]], 1, OPTIONS)).toEqual({ none: "nothingClosed" });
  });
});

describe("穴のある塗り", () => {
  const holed = (): { project: Project; page: Page } => {
    const { project, page } = setup();
    page.fills = [{ id: "f1", shape: square(10, 10, 40), holes: [square(20, 20, 10)], under: true }];
    return { project, page };
  };

  it("moves, transforms, copies and follows its panel with its holes", () => {
    const { project, page } = holed();
    moveItems(page, [{ kind: "fill", id: "f1" }], 5, 0);
    expect(page.fills?.[0].holes?.[0][0]).toEqual([25, 20]);
    const base = transformBase(page, [{ kind: "fill", id: "f1" }]);
    // Twice as large about the origin.
    transformItems(page, base, [2, 0, 0, 2, 0, 0]);
    expect(page.fills?.[0].shape[0]).toEqual([30, 20]);
    expect(page.fills?.[0].holes?.[0][0]).toEqual([50, 40]);
    const clip = copySelection(page, { kind: "fill", pageId: page.id, id: "f1" });
    const pasted = pasteClip(project, page, clip!, [100, 0]);
    const copy = page.fills?.find((fill) => fill.id === pasted.fills[0]);
    expect(copy?.holes?.[0][0]).toEqual([150, 40]);
    expect(copy?.under).toBe(true);

    const { page: other } = holed();
    other.panels.push({ id: "p1", shape: square(0, 0, 60), order: 1 });
    const carried = carryContents(other, other.panels[0]);
    other.panels[0].shape = square(100, 0, 60);
    followPanel(other, other.panels[0], carried);
    expect(other.fills?.[0].holes?.[0][0]).toEqual([120, 20]);
  });

  it("is picked only where it is filled", () => {
    const { page } = holed();
    expect(insideFill(page.fills![0], [15, 15])).toBe(true);
    expect(insideFill(page.fills![0], [25, 25])).toBe(false);
  });
});

describe("塗りの設定", () => {
  it("reads back what was kept, and the default for anything unreadable", () => {
    const kept = fillSettingsFrom(JSON.parse(JSON.stringify({ ...defaultFillSettings(), way: "enclose", tone: "gray" })));
    expect(kept.way).toBe("enclose");
    expect(kept.tone).toBe("gray");
    const odd = fillSettingsFrom({ way: "bucket", tone: "red", brushMm: 999, options: { click: { gapMm: 50, center: "yes", growMm: -9, refer: "x" } }, under: { lasso: true } });
    expect(odd.way).toBe("lasso");
    expect(odd.tone).toBe("black");
    expect(odd.brushMm).toBe(30);
    expect(odd.options.click).toEqual({ gapMm: 2, center: true, growMm: -2, refer: "all" });
    expect(odd.under).toEqual({ click: true, enclose: true, lasso: true, remaining: true });
    expect(fillSettingsFrom(null)).toEqual(defaultFillSettings());
  });

  it("goes round the ways with G", () => {
    expect(nextFillWay("click")).toBe("enclose");
    expect(nextFillWay("remaining")).toBe("click");
  });
});

import { describe, expect, it } from "vitest";
import { MINI_DEFAULTS, MINI_MARGIN, MINI_MAX_PIXELS, MINI_MAX_SIDE, miniScale, miniSheet, miniTitle } from "./mininame";
import { newProject } from "./project";
import { trimBox } from "./pagebox";
import { placeNamePictures } from "./references";
import type { StoredImage } from "./model";

describe("the ミニネーム's layout", () => {
  it("lays spreads in reading order from the top right of a right-bound name, the first page alone on the left", () => {
    const project = newProject("ユメノストラ", 6);
    project.storyIndex = 4;
    const sheet = miniSheet(project, { ...MINI_DEFAULTS, columns: 2 }, true);
    const [tx0, ty0, tx1, ty1] = trimBox(project.pageFormat);
    const w = tx1 - tx0;
    const h = ty1 - ty0;
    // Spreads: [1] [2 3] / [4 5] [6]; two across.
    expect(sheet.columns).toBe(2);
    expect(sheet.rows).toBe(2);
    expect(sheet.pages.map((page) => page.index)).toEqual([0, 1, 2, 3, 4, 5]);
    const at = (n: number) => sheet.pages[n - 1].box;
    // Page 1 is a left page, in the spread at the top right.
    expect(at(1)[0]).toBeCloseTo(sheet.widthMm - MINI_MARGIN - 2 * w, 6);
    // 2 is the right page of the next spread (to the left), 3 its left page.
    expect(at(2)[2]).toBeLessThan(at(1)[0]);
    expect(at(3)[2]).toBeCloseTo(at(2)[0], 6);
    // The next row: 4 on the right, 5 beside it, 6 starts the next spread.
    expect(at(4)[1]).toBeGreaterThan(at(1)[3]);
    expect(at(4)[2]).toBeCloseTo(sheet.widthMm - MINI_MARGIN, 6);
    expect(at(5)[2]).toBeCloseTo(at(4)[0], 6);
    expect(at(6)[2]).toBeLessThan(at(5)[0]);
    for (const page of sheet.pages) {
      expect(page.box[2] - page.box[0]).toBeCloseTo(w, 6);
      expect(page.box[3] - page.box[1]).toBeCloseTo(h, 6);
      expect(page.area).toEqual(trimBox(project.pageFormat));
    }
    // Each number under its page.
    for (const page of sheet.pages) {
      const number = sheet.numbers.find((n) => n.text === String(page.index + 1))!;
      expect(number.at[0]).toBeCloseTo((page.box[0] + page.box[2]) / 2, 6);
      expect(number.at[1]).toBeGreaterThan(page.box[3]);
    }
    expect(sheet.title?.text).toBe("ユメノストラ 第4話　全 6 ページ");
    // The title on the side reading starts from.
    expect(sheet.title?.at[0]).toBeCloseTo(sheet.widthMm - MINI_MARGIN, 6);
  });

  it("mirrors it for a left-bound name, and the whole canvas when asked", () => {
    const project = newProject("left", 3, "left");
    const sheet = miniSheet(project, { ...MINI_DEFAULTS, columns: 2, area: "canvas", title: false, numbers: false }, true);
    const [cw] = project.pageFormat.canvasMm;
    const at = (n: number) => sheet.pages[n - 1].box;
    // [1] alone on the right of the first spread (top left), then [2 3].
    expect(at(1)[0]).toBeCloseTo(MINI_MARGIN + cw, 6);
    expect(at(2)[0]).toBeGreaterThan(at(1)[2]);
    expect(at(3)[0]).toBeCloseTo(at(2)[2], 6);
    expect(sheet.numbers).toEqual([]);
    expect(sheet.title).toBeNull();
    expect(sheet.pages[0].area).toEqual([0, 0, ...project.pageFormat.canvasMm]);
  });

  it("chooses how many across to come near A-size landscape", () => {
    for (const pages of [8, 16, 24, 32, 48]) {
      const sheet = miniSheet(newProject("t", pages), MINI_DEFAULTS, true);
      const aspect = sheet.widthMm / sheet.heightMm;
      expect(aspect, `${pages} pages`).toBeGreaterThan(1);
      expect(aspect, `${pages} pages`).toBeLessThan(2.2);
    }
  });

  it("lays a 縦スクロール strip in columns, the pieces touching", () => {
    const project = newProject("strip", 7, "scroll");
    const sheet = miniSheet(project, { ...MINI_DEFAULTS, columns: 2 }, true);
    const at = (n: number) => sheet.pages[n - 1].box;
    expect(sheet.rows).toBe(4);
    expect(at(2)[1]).toBeCloseTo(at(1)[3], 6);
    expect(at(4)[3] - at(1)[1]).toBeCloseTo(4 * (trimBox(project.pageFormat)[3] - trimBox(project.pageFormat)[1]), 6);
    expect(at(5)[0]).toBeGreaterThan(at(4)[2]);
    expect(at(5)[1]).toBeCloseTo(at(1)[1], 6);
    expect(miniTitle(project)).toBe("strip　全 7 区切り");
  });

  it("draws a sheet too large at a lower resolution", () => {
    expect(miniScale({ widthMm: 500, heightMm: 300 }, 100)).toEqual({ scale: 100 / 25.4, dpi: 100, reduced: false });
    const huge = miniScale({ widthMm: 3000, heightMm: 2000 }, 200);
    expect(huge.reduced).toBe(true);
    expect(3000 * huge.scale).toBeLessThanOrEqual(MINI_MAX_SIDE + 1e-6);
    expect(3000 * huge.scale * 2000 * huge.scale).toBeLessThanOrEqual(MINI_MAX_PIXELS * (1 + 1e-9));
    expect(huge.dpi).toBeLessThan(200);
  });
});

describe("laying the pictures of a name on its pages", () => {
  const image = (name: string): StoredImage => ({ id: "", name, mime: "image/jpeg", dataBase64: "AA==", widthPx: 10, heightPx: 14 });

  it("puts one on each page from the first asked, adding pages, replacing those taken in before", () => {
    const project = newProject("t", 2);
    project.pages[1].references = [{ id: "r1", image: "keep", box: [0, 0, 1, 1] }];
    project.images = [{ ...image("資料"), id: "keep" }];
    const added = placeNamePictures(project, 1, [
      { image: image("a"), box: [1, 2, 3, 4] },
      { image: image("b"), box: [5, 6, 7, 8] },
    ]);
    expect(added).toBe(1);
    expect(project.pages).toHaveLength(3);
    expect(project.pages[0].references).toBeUndefined();
    const [kept, name] = project.pages[1].references!;
    expect(kept.id).toBe("r1");
    expect(name).toMatchObject({ kind: "name", box: [1, 2, 3, 4] });
    expect(project.images.find((i) => i.id === name.image)?.name).toBe("a");
    // Again: the picture of the name is replaced, the 資料 stays.
    placeNamePictures(project, 1, [{ image: image("c"), box: [9, 9, 9, 9] }]);
    expect(project.pages[1].references!.map((r) => r.kind ?? "資料")).toEqual(["資料", "name"]);
    expect(project.images.find((i) => i.id === project.pages[1].references![1].image)?.name).toBe("c");
  });
});

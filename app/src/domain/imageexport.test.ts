import { describe, expect, it } from "vitest";
import { IMAGE_DEFAULTS, IMAGE_MAX_PIXELS, fileStem, imageFileName, imageScale, imageSheets, imageSummary } from "./imageexport";
import { newProject } from "./project";
import { trimBox } from "./pagebox";

describe("画像で書き出す: which pages go in which file", () => {
  it("writes one file a page, each cut at the trim or the whole canvas", () => {
    const project = newProject("第4話", 3);
    const [tx0, ty0, tx1, ty1] = trimBox(project.pageFormat);
    const trim = imageSheets(project, { unit: "page", area: "trim" }, true);
    expect(trim.map((sheet) => sheet.numbers)).toEqual([[1], [2], [3]]);
    expect(trim[0].widthMm).toBeCloseTo(tx1 - tx0, 6);
    expect(trim[0].heightMm).toBeCloseTo(ty1 - ty0, 6);
    expect(trim[0].pieces[0].area).toEqual(trimBox(project.pageFormat));
    const [w, h] = project.pageFormat.canvasMm;
    const canvas = imageSheets(project, { unit: "page", area: "canvas" }, true);
    expect(canvas[2]).toMatchObject({ widthMm: w, heightMm: h, pieces: [{ index: 2, area: [0, 0, w, h], box: [0, 0, w, h] }] });
  });

  it("pairs 見開き as the editor does, the right page on the right of a right-bound name, a page alone kept alone", () => {
    const project = newProject("右綴じ", 6);
    const [tx0, , tx1] = trimBox(project.pageFormat);
    const trimW = tx1 - tx0;
    // The first page alone: [1] [2 3] [4 5] [6].
    const sheets = imageSheets(project, { unit: "spread", area: "trim" }, true);
    expect(sheets.map((sheet) => sheet.numbers)).toEqual([[1], [2, 3], [4, 5], [6]]);
    const spread = sheets[1];
    expect(spread.widthMm).toBeCloseTo(2 * trimW, 6);
    // Page 2 is read first: the right half; page 3 the left.
    const right = spread.pieces.find((piece) => piece.index === 1)!;
    const left = spread.pieces.find((piece) => piece.index === 2)!;
    expect(left.box[0]).toBe(0);
    expect(right.box[0]).toBeCloseTo(trimW, 6);
    expect(right.box[2]).toBeCloseTo(spread.widthMm, 6);
    // Not alone: [1 2] [3 4] [5 6].
    expect(imageSheets(project, { unit: "spread", area: "trim" }, false).map((sheet) => sheet.numbers)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it("keeps each page's bleed on the outer side of a whole-canvas 見開き and ends it at the trim on the gutter", () => {
    const project = newProject("左綴じ", 2, "left");
    const [w, h] = project.pageFormat.canvasMm;
    const [tx0, , tx1] = trimBox(project.pageFormat);
    const [spread] = imageSheets(project, { unit: "spread", area: "canvas" }, false);
    // Left-bound: page 1 on the left.
    const [first, second] = [...spread.pieces].sort((a, b) => a.index - b.index);
    expect(first.box[0]).toBe(0);
    expect(first.area).toEqual([0, 0, tx1, h]);
    expect(second.area).toEqual([tx0, 0, w, h]);
    expect(second.box[0]).toBeCloseTo(tx1, 6);
    expect(spread.widthMm).toBeCloseTo(tx1 + (w - tx0), 6);
    expect(spread.heightMm).toBe(h);
  });

  it("joins only the pages made one 見開き (joined, or sharing a 見開きコマ), as CSP gets them", () => {
    const project = newProject("つなぐ", 5);
    project.pages[1].joinNext = true;
    expect(imageSheets(project, { unit: "joined", area: "trim" }, true).map((sheet) => sheet.numbers)).toEqual([[1], [2, 3], [4], [5]]);
  });

  it("writes a 縦スクロール name piece by piece, whatever is chosen", () => {
    const project = newProject("縦", 4);
    project.scroll = true;
    expect(imageSheets(project, { unit: "spread", area: "trim" }, false)).toHaveLength(4);
  });

  it("draws smaller only what would be too large", () => {
    const sheet = { widthMm: 500, heightMm: 360 };
    expect(imageScale([sheet], 350)).toEqual({ scale: 350 / 25.4, dpi: 350, reduced: false });
    const reduced = imageScale([sheet], 1200);
    expect(reduced.reduced).toBe(true);
    expect(sheet.widthMm * reduced.scale * sheet.heightMm * reduced.scale).toBeLessThanOrEqual(IMAGE_MAX_PIXELS * 1.0001);
    expect(reduced.dpi).toBeLessThan(1200);
  });

  it("names the files by their pages, wide enough to sort", () => {
    expect(imageFileName("第4話", { numbers: [7] }, "png", 32)).toBe("第4話_007.png");
    expect(imageFileName("第4話", { numbers: [6, 7] }, "psd", 32)).toBe("第4話_006-007.psd");
    expect(imageFileName("x", { numbers: [12] }, "jpeg", 1200)).toBe("x_0012.jpg");
    expect(fileStem('a/b:c*?"<>|. ')).toBe("a_b_c______");
    expect(fileStem("  ")).toBe("ネーム");
  });

  it("says what it makes", () => {
    const project = newProject("要約", 4);
    expect(imageSummary(project, { ...IMAGE_DEFAULTS, format: "psd", unit: "spread" }, true)).toBe(
      "3 個の PSD（レイヤー付き）（見開きごと・350 dpi・仕上がりで切る）",
    );
    expect(imageSummary(project, { ...IMAGE_DEFAULTS, paper: false }, true)).toContain("紙は透明");
    expect(imageSummary(project, { ...IMAGE_DEFAULTS, format: "jpeg", paper: false }, true)).not.toContain("透明");
  });
});

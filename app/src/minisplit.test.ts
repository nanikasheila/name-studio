import { describe, expect, it } from "vitest";
import { findPages, gridPages, guessOrder, orderCells, placeOnPage, skewOf, toGray, turnGray, type Gray, type PxBox } from "./minisplit";
import { newProject } from "./project";
import { basicBox, trimBox } from "./pagebox";

/** A white picture to draw on. */
function paper(width: number, height: number, shade = 255): Gray {
  return { width, height, data: new Uint8Array(width * height).fill(shade) };
}

function fill(gray: Gray, [x0, y0, x1, y1]: PxBox, value: number): void {
  for (let y = Math.max(0, y0); y < Math.min(gray.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(gray.width, x1); x++) gray.data[y * gray.width + x] = value;
  }
}

/** A frame `line` px thick just inside `box`. */
function frame(gray: Gray, [x0, y0, x1, y1]: PxBox, line = 2, value = 40): void {
  fill(gray, [x0, y0, x1, y0 + line], value);
  fill(gray, [x0, y1 - line, x1, y1], value);
  fill(gray, [x0, y0, x0 + line, y1], value);
  fill(gray, [x1 - line, y0, x1, y1], value);
}

/** Some drawing inside a page: panel lines, a face, words. */
function drawing(gray: Gray, [x0, y0, x1, y1]: PxBox, seed: number): void {
  const w = x1 - x0;
  const h = y1 - y0;
  fill(gray, [x0 + Math.round(w * 0.1), y0 + Math.round(h * (0.3 + 0.05 * (seed % 3))), x1 - Math.round(w * 0.1), y0 + Math.round(h * (0.3 + 0.05 * (seed % 3))) + 1], 30);
  fill(gray, [x0 + Math.round(w * 0.5), y0 + Math.round(h * 0.1), x0 + Math.round(w * 0.5) + 1, y0 + Math.round(h * 0.6)], 30);
  fill(gray, [x0 + Math.round(w * 0.2), y0 + Math.round(h * 0.7), x0 + Math.round(w * 0.35), y0 + Math.round(h * 0.8)], 90);
}

const near = (a: PxBox, b: PxBox, by = 3) => a.every((value, k) => Math.abs(value - b[k]) <= by);
const middle = ([x0, y0, x1, y1]: PxBox) => [(x0 + x1) / 2, (y0 + y1) / 2];

describe("finding the pages of a ミニネーム", () => {
  it("finds framed pages apart from each other, with drawing in them, and reads them right to left", () => {
    const gray = paper(1000, 640);
    const pages: PxBox[] = [];
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 4; column++) {
        const box: PxBox = [40 + column * 235, 30 + row * 300, 40 + column * 235 + 196, 30 + row * 300 + 277];
        frame(gray, box);
        drawing(gray, box, row * 4 + column);
        pages.push(box);
      }
    }
    // A panel line reaching the frame top to bottom does not cut its page in two.
    fill(gray, [40 + 98, 30, 40 + 100, 307], 30);
    // A page number under each page is not a page.
    fill(gray, [100, 312, 112, 324], 60);
    const found = findPages(gray, 196 / 277);
    expect(found.cells).toHaveLength(8);
    for (const page of pages) expect(found.cells.some((cell) => near(cell, page))).toBe(true);
    const order = orderCells(found.cells, guessOrder(found.cells, true));
    expect(guessOrder(found.cells, true)).toBe("rtl");
    // Top right first, along the row to the left, then the next row.
    expect(order.map(middle).map(([x, y]) => [Math.round(x), Math.round(y)])).toEqual([
      [843, 169], [608, 169], [373, 169], [138, 169],
      [843, 469], [608, 469], [373, 469], [138, 469],
    ]);
    expect(orderCells(found.cells, "ltr")[0][0]).toBe(found.cells.reduce((least, cell) => Math.min(least, cell[0]), Infinity));
  });

  it("tells apart pages that touch, by the lines between them, and finds the frame inside them (a name sheet)", () => {
    // Two halves of 4 x 4 pages, the pages of a row touching, the rows a little apart; a 基本枠 in each page.
    const gray = paper(1720, 1200);
    const cell = { w: 180, h: 256 };
    const pages: PxBox[] = [];
    for (const left of [880, 60]) {
      for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 4; column++) {
          const box: PxBox = [left + column * cell.w, 40 + row * (cell.h + 14), left + (column + 1) * cell.w, 40 + row * (cell.h + 14) + cell.h];
          frame(gray, box, 2, 20);
          frame(gray, [box[0] + 16, box[1] + 22, box[2] - 16, box[3] - 22], 1, 60);
          if ((row + column) % 2) drawing(gray, [box[0] + 16, box[1] + 22, box[2] - 16, box[3] - 22], row);
          pages.push(box);
        }
      }
    }
    const found = findPages(gray, 180 / 256);
    expect(found.cells).toHaveLength(32);
    for (const page of pages) expect(found.cells.some((cell) => near(cell, page, 3))).toBe(true);
    expect(found.inner).not.toBeNull();
    const [l, t, r, b] = found.inner!;
    expect(l).toBeCloseTo(16.5 / 180, 1);
    expect(t).toBeCloseTo(22.5 / 256, 1);
    expect(r).toBeCloseTo(163.5 / 180, 1);
    expect(b).toBeCloseTo(233.5 / 256, 1);
    // As a name sheet: the right half first, its rows right to left, then the left half.
    expect(guessOrder(found.cells, true)).toBe("blocks-rtl");
    const order = orderCells(found.cells, "blocks-rtl");
    expect(near(order[0], pages[3])).toBe(true);
    expect(near(order[3], pages[0])).toBe(true);
    expect(near(order[4], pages[7])).toBe(true);
    expect(near(order[15], pages[12])).toBe(true);
    expect(near(order[16], pages[19])).toBe(true);
    expect(near(order[31], pages[28])).toBe(true);
    // Row by row instead: the first row goes across both halves.
    expect(near(orderCells(found.cells, "rtl")[4], pages[19])).toBe(true);
  });

  it("finds white pages on a grey ground with no frames, spreads touching at the gutter, the first page alone", () => {
    const gray = paper(900, 420, 200);
    const pages: PxBox[] = [];
    // Right binding: page 1 alone on the left of the first spread (top right), then 2-3 to its left.
    const spread = (left: number, top: number, pagesIn: (0 | 1)[]) => {
      for (const side of pagesIn) {
        const box: PxBox = [left + side * 120, top, left + (side + 1) * 120, top + 170];
        fill(gray, box, 255);
        drawing(gray, box, side);
        pages.push(box);
      }
    };
    spread(640, 20, [0]);
    spread(370, 20, [1, 0]);
    spread(100, 20, [1, 0]);
    spread(640, 220, [1, 0]);
    const found = findPages(gray, 120 / 170);
    expect(found.cells).toHaveLength(7);
    const order = orderCells(found.cells, guessOrder(found.cells, true));
    for (const [k, page] of pages.entries()) expect(near(order[k], page, 2), `page ${k + 1}`).toBe(true);
  });

  it("closes a small break in a hand-drawn frame", () => {
    const gray = paper(500, 400);
    const box: PxBox = [50, 40, 250, 320];
    frame(gray, box, 2);
    fill(gray, [120, 40, 121, 42], 255);
    frame(gray, [270, 40, 470, 320], 2);
    const found = findPages(gray, 200 / 280);
    expect(found.cells).toHaveLength(2);
  });

  it("reads colour and clear pixels as grey on white paper", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
    expect([...toGray(rgba, 3, 1).data]).toEqual([76, 255, 255]);
  });

  it("cuts an even grid over what is drawn, the paper around left out", () => {
    const gray = paper(400, 300);
    fill(gray, [100, 50, 300, 250], 0);
    expect(gridPages(gray, 2, 2)).toEqual([
      [100, 50, 200, 150],
      [200, 50, 300, 150],
      [100, 150, 200, 250],
      [200, 150, 300, 250],
    ]);
  });
});

describe("laying a page's picture on the page", () => {
  const format = newProject("t", 1).pageFormat;

  it("fits the picture's edge to the trim, its shape kept", () => {
    const [tx0, ty0, tx1, ty1] = trimBox(format);
    const box = placeOnPage(format, "trim", 514, 728);
    expect(box[0]).toBeCloseTo(tx0, 0);
    expect(box[1]).toBeCloseTo(ty0, 0);
    expect(box[2]).toBeCloseTo(tx1, 0);
    expect(box[3]).toBeCloseTo(ty1, 0);
    // A wider picture: as wide as the trim, in the middle up and down.
    const wide = placeOnPage(format, "trim", 400, 400);
    expect(wide[2] - wide[0]).toBeCloseTo(tx1 - tx0, 6);
    expect((wide[1] + wide[3]) / 2).toBeCloseTo((ty0 + ty1) / 2, 6);
  });

  it("fits the picture's inner frame to the 基本枠", () => {
    const [bx0, by0, bx1, by1] = basicBox(format);
    const inner: [number, number, number, number] = [0.1, 0.1, 0.9, 0.9];
    const box = placeOnPage(format, "inner", 1000, 1400, inner);
    const scale = (box[2] - box[0]) / 1000;
    const innerBox = [box[0] + 100 * scale, box[1] + 140 * scale, box[0] + 900 * scale, box[1] + 1260 * scale];
    // Inside the 基本枠, touching it on the tighter side, centred on it.
    expect((innerBox[0] + innerBox[2]) / 2).toBeCloseTo((bx0 + bx1) / 2, 6);
    expect((innerBox[1] + innerBox[3]) / 2).toBeCloseTo((by0 + by1) / 2, 6);
    expect(Math.min(Math.abs(innerBox[2] - innerBox[0] - (bx1 - bx0)), Math.abs(innerBox[3] - innerBox[1] - (by1 - by0)))).toBeLessThan(1e-6);
  });
});

describe("a picture scanned a little askew", () => {
  it("tells how far it is turned, and finds the pages once it is turned straight", () => {
    const gray = paper(1000, 640);
    const pages: PxBox[] = [];
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 4; column++) {
        const box: PxBox = [40 + column * 235, 30 + row * 300, 40 + column * 235 + 196, 30 + row * 300 + 277];
        frame(gray, box);
        drawing(gray, box, row * 4 + column);
        pages.push(box);
      }
    }
    expect(skewOf(gray)).toBe(0);
    for (const degrees of [0.8, -1.5]) {
      const tilted = turnGray(gray, degrees);
      const skew = skewOf(tilted);
      expect(skew).toBeCloseTo(degrees, 1);
      const found = findPages(turnGray(tilted, -skew), 196 / 277);
      expect(found.cells).toHaveLength(8);
      for (const page of pages) expect(found.cells.some((cell) => near(cell, page, 4)), `${degrees}°`).toBe(true);
    }
  });
});

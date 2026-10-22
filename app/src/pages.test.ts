import { describe, expect, it } from "vitest";
import { dialogueByPage, effectiveVisibility, spreads } from "./pages";
import type { LayerView, SheetView } from "./types";

function layer(id: number, parent: number | null, extra: Partial<LayerView> = {}): LayerView {
  return {
    id, parent, depth: parent === null ? 0 : 1, name: `L${id}`, kind: "text", visible: true, opacity: 1,
    hasPixels: false, pixelOrigin: [0, 0], pixelSize: null, vectors: [], texts: [], ...extra,
  };
}

describe("spreads", () => {
  it("starts with a lone left page and pairs the rest right/left", () => {
    expect(spreads(5, true)).toEqual([[null, 1], [2, 3], [4, 5]]);
    expect(spreads(4, true)).toEqual([[null, 1], [2, 3], [4, null]]);
    expect(spreads(3, false)).toEqual([[1, 2], [3, null]]);
    expect(spreads(0, true)).toEqual([]);
  });
});

describe("effectiveVisibility", () => {
  it("hides children of a hidden folder", () => {
    const layers = [layer(1, null, { kind: "folder" }), layer(2, 1), layer(3, null)];
    const visible = effectiveVisibility(layers, new Set([1]));
    expect([...visible.values()]).toEqual([false, false, true]);
  });
});

describe("dialogueByPage", () => {
  it("assigns text to the page holding its centre, read top band first, right to left", () => {
    const text = (x: number, y: number, value: string) => ({
      text: value, bbox: [x, y, x + 10, y + 40] as [number, number, number, number],
      fontSizePx: 10, fontName: null, vertical: true, inBalloon: false,
    });
    const sheet: SheetView = {
      path: "", fileName: "", warnings: [],
      canvas: { widthPx: 400, heightPx: 600, resolution: 600, isDoublePage: false },
      cells: [
        { index: 1, rect: { x0: 200, y0: 0, x1: 400, y1: 600 }, frame: null, spread_side: null },
        { index: 2, rect: { x0: 0, y0: 0, x1: 200, y1: 600 }, frame: null, spread_side: null },
      ],
      layers: [
        layer(1, null, { texts: [text(220, 10, "左上"), text(350, 20, "右上"), text(300, 400, "下")] }),
        layer(2, null, { texts: [text(50, 50, "二ページ目")] }),
        layer(3, null, { visible: false, texts: [text(50, 300, "隠れている")] }),
      ],
    };
    const visible = effectiveVisibility(sheet.layers, new Set([3]));
    const pages = dialogueByPage(sheet, visible).map((lines) => lines.map((line) => line.text));
    expect(pages).toEqual([["右上", "左上", "下"], ["二ページ目"]]);
  });
});

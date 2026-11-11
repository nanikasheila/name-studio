import { describe, expect, it } from "vitest";
import { columnsOfShowItems, parseShowItems, showItemOf, showItemsBytes, showItemsFor } from "./cspshow";

describe("ツールプロパティの表示項目（VariantShowParam）", () => {
  it("reads and writes the item ids", () => {
    const bytes = showItemsBytes([1000, 10, 20, 40, 1241]);
    expect(bytes.length).toBe(12 + 5 * 4);
    expect([...bytes.slice(0, 12)]).toEqual([0, 0, 0, 12, 0, 0, 0, 5, 0, 0, 0, 4]);
    expect(parseShowItems(bytes)).toEqual([1000, 10, 20, 40, 1241]);
    expect(parseShowItems(new Uint8Array([0, 0, 0, 12, 0, 0, 0, 2, 0, 0, 0, 4, 0]))).toBeNull();
    expect(parseShowItems(new Uint8Array(3))).toBeNull();
  });

  it("knows the items read off CSP, and leaves out the others", () => {
    expect(columnsOfShowItems([1000, 10, 30, 20, 40, 1241, 1230])).toEqual([
      "BrushSize",
      "Opacity",
      "AntiAlias",
      "FlickerReduction",
      "BrushUseVectorMagnet",
      "BrushEnableSnap",
    ]);
    expect(showItemOf("Opacity")).toBe(10);
    expect(showItemOf("BrushHardness")).toBeUndefined();
  });

  it("writes the columns chosen in their order and keeps CSP's own items it does not know", () => {
    expect(showItemsFor(["FlickerReduction", "BrushSize", "ns:sizePresets", "BrushHardness"], [1000, 10, 30, 1151])).toEqual([
      40, 1000, 30, 1151,
    ]);
    expect(showItemsFor(["Opacity"], null)).toEqual([10]);
  });
});

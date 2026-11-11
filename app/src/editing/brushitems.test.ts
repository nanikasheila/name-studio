import { describe, expect, it } from "vitest";
import { brushPropItems, defaultBrushItems, ERASE_MODE, SIZE_BUTTONS, TIP_SHAPE } from "./brushitems";
import { newBrush } from "../domain/cspsettings";
import { showItemsBytes } from "../domain/cspshow";
import { base64Of } from "../domain/cspsettings";

describe("ツールプロパティに出せる項目（ペン・消しゴム）", () => {
  it("offers the plain pen and eraser only what they can change", () => {
    expect(brushPropItems("pen", null).map((i) => i.id)).toEqual(["BrushSize", SIZE_BUTTONS, "FlickerReduction"]);
    expect(brushPropItems("eraser", null).map((i) => i.id)).toEqual(["BrushSize", ERASE_MODE]);
  });

  it("offers a brush of its own every setting changed in a row, in CSP's order", () => {
    const pen = newBrush("pen", "b1", "Gペン");
    const ids = brushPropItems("pen", pen).map((i) => i.id);
    expect(ids.slice(0, 2)).toEqual(["BrushSize", SIZE_BUTTONS]);
    expect(ids.indexOf("BrushAtLeast1Pixel")).toBeLessThan(ids.indexOf("Opacity"));
    for (const id of ["AntiAlias", "BrushFlow", "FlickerReduction", "BrushEnableSnap", "BrushUseVectorMagnet", "BrushInOutType"])
      expect(ids).toContain(id);
    // Not graphs, units, pictures or the palette's own layout.
    for (const id of ["BrushSizeEffector", "BrushSizeUnit", "BrushPatternImageArray", "VariantShowParam"]) expect(ids).not.toContain(id);
    expect(ids).not.toContain(ERASE_MODE);
    expect(ids.indexOf("Opacity")).toBeLessThan(ids.indexOf("FlickerReduction"));
    const eraser = brushPropItems("eraser", newBrush("eraser", "b2", "硬め")).map((i) => i.id);
    expect(eraser).toContain(ERASE_MODE);
  });

  it("shows out of the box what CSP showed for the brush, else size, opacity and 手ブレ補正", () => {
    const pen = newBrush("pen", "b1", "Gペン");
    expect(defaultBrushItems("pen", pen)).toEqual(["BrushSize", SIZE_BUTTONS, "Opacity", "FlickerReduction"]);
    pen.csp = {
      ...(pen.csp ?? { settings: {}, dpi: 600 }),
      settings: { ...(pen.csp?.settings ?? {}), VariantShowParam: { blob: base64Of(showItemsBytes([1000, 10, 1230, 30])) } },
    } as typeof pen.csp;
    expect(defaultBrushItems("pen", pen)).toEqual(["BrushSize", SIZE_BUTTONS, "Opacity", "BrushEnableSnap"]);
    const eraser = newBrush("eraser", "b2", "硬め");
    eraser.tip = { enabled: true, interval: 0.1, width: 10, height: 10, pngBase64: "" } as typeof eraser.tip;
    expect(defaultBrushItems("eraser", eraser).slice(-2)).toEqual([ERASE_MODE, TIP_SHAPE]);
    expect(defaultBrushItems("pen", null)).toEqual(["BrushSize", SIZE_BUTTONS, "FlickerReduction"]);
  });
});

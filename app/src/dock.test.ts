import { describe, expect, it } from "vitest";
import { column, defaultLayout, isOpen, movePalette, readLayout } from "./dock";

describe("欄（パレット）", () => {
  it("moves a palette to the other column, before another or at the bottom, shown and open", () => {
    const layout = defaultLayout();
    movePalette(layout, "script", "right", "inspector");
    expect(column(layout, "right")).toEqual(["script", "inspector"]);
    expect(layout.palettes.script).toMatchObject({ side: "right", shown: true, folded: false });
    movePalette(layout, "notes", "right", null);
    expect(column(layout, "right")).toEqual(["script", "inspector", "notes"]);
    movePalette(layout, "inspector", "left", "pages");
    expect(column(layout, "left")[0]).toBe("inspector");
    expect(column(layout, "right")).toEqual(["script", "notes"]);
  });

  it("opens a folded column when something is put in it", () => {
    const layout = defaultLayout(true);
    expect(isOpen(layout, "pages")).toBe(false);
    movePalette(layout, "cast", "left", null);
    expect(layout.collapsed.left).toBe(false);
    expect(isOpen(layout, "cast")).toBe(true);
  });

  it("reads a kept arrangement, adding palettes it did not know and keeping widths in range", () => {
    const kept = JSON.stringify({
      order: ["inspector", "pages", "bogus"],
      palettes: { pages: { side: "right", shown: true, folded: true, weight: 2 } },
      width: { left: 5000, right: 10 },
      collapsed: { left: true },
    });
    const layout = readLayout(kept);
    expect(layout.order.slice(0, 2)).toEqual(["inspector", "pages"]);
    expect(layout.order).toHaveLength(7);
    expect(layout.palettes.pages).toEqual({ side: "right", shown: true, folded: true, weight: 2 });
    expect(layout.palettes.script.side).toBe("left");
    expect(layout.width).toEqual({ left: 640, right: 200 });
    expect(layout.collapsed).toEqual({ left: true, right: false });
    expect(readLayout("{not json").order).toHaveLength(7);
  });
});

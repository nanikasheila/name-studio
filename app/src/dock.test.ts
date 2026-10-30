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
    expect(column(layout, "left").slice(0, 3)).toEqual(["subtools", "inspector", "pages"]);
    expect(column(layout, "right")).toEqual(["script", "notes"]);
  });

  it("opens a folded column when something is put in it", () => {
    const layout = defaultLayout(true);
    expect(isOpen(layout, "pages")).toBe(false);
    movePalette(layout, "cast", "left", null);
    expect(layout.collapsed.left).toBe(false);
    expect(isOpen(layout, "cast")).toBe(true);
  });

  it("puts サブツール above the pages for those who kept an arrangement before it came", () => {
    const before = defaultLayout();
    before.order = before.order.filter((id) => id !== "subtools");
    const { subtools: _, ...palettes } = before.palettes;
    const layout = readLayout(JSON.stringify({ ...before, palettes }));
    expect(column(layout, "left").slice(0, 2)).toEqual(["subtools", "pages"]);
    expect(isOpen(layout, "subtools")).toBe(true);
  });

  it("reads a kept arrangement, adding palettes it did not know and keeping widths in range", () => {
    const kept = JSON.stringify({
      order: ["inspector", "pages", "bogus"],
      palettes: { pages: { side: "right", shown: true, folded: true, weight: 2 } },
      width: { left: 5000, right: 10 },
      collapsed: { left: true },
    });
    const layout = readLayout(kept);
    // Palettes that came after the arrangement was kept go before the one they come before by default.
    expect(layout.order.indexOf("subtools")).toBe(layout.order.indexOf("pages") - 1);
    expect(layout.order.indexOf("script")).toBeLessThan(layout.order.indexOf("inspector"));
    expect(layout.order).toHaveLength(9);
    expect(layout.palettes.subtools).toMatchObject({ side: "left", shown: true });
    expect(layout.palettes.pages).toEqual({ side: "right", shown: true, folded: true, weight: 2 });
    expect(layout.palettes.script.side).toBe("left");
    expect(layout.width).toEqual({ left: 640, right: 200 });
    expect(layout.collapsed).toEqual({ left: true, right: false });
    expect(readLayout("{not json").order).toHaveLength(9);
  });
});

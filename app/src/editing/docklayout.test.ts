import { describe, expect, it } from "vitest";
import {
  canAddColumn,
  column,
  columnsOf,
  defaultLayout,
  dockPalette,
  floatPalette,
  floating,
  frames,
  isOpen,
  joinTab,
  movePalette,
  placePalette,
  readLayout,
  showTab,
  tidy,
} from "./docklayout";

describe("欄（パレット）", () => {
  it("moves a palette to the other column, before another or at the bottom, shown and open", () => {
    const layout = defaultLayout();
    movePalette(layout, "script", "right", "inspector");
    expect(column(layout, "right")).toEqual(["assist", "script", "inspector"]);
    expect(layout.palettes.script).toMatchObject({ side: "right", shown: true, folded: false });
    movePalette(layout, "notes", "right", null);
    expect(column(layout, "right")).toEqual(["assist", "script", "inspector", "notes"]);
    movePalette(layout, "inspector", "left", "pages");
    const left = column(layout, "left");
    expect(left.indexOf("inspector")).toBe(left.indexOf("pages") - 1);
    expect(column(layout, "right")).toEqual(["assist", "script", "notes"]);
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
    const gone = ["subtools", "toolprops", "brushsize"];
    before.order = before.order.filter((id) => !gone.includes(id));
    const { subtools: _, toolprops: _t, brushsize: _b, ...palettes } = before.palettes;
    const layout = readLayout(JSON.stringify({ ...before, palettes }));
    expect(column(layout, "left").slice(0, 4)).toEqual(["subtools", "toolprops", "brushsize", "pages"]);
    expect(isOpen(layout, "subtools")).toBe(true);
    expect(isOpen(layout, "toolprops")).toBe(true);
    expect(isOpen(layout, "brushsize")).toBe(false);
  });

  it("puts ツールプロパティ (split off サブツール) right under it, wherever サブツール was kept", () => {
    const before = defaultLayout();
    before.order = before.order.filter((id) => id !== "toolprops" && id !== "brushsize");
    const { toolprops: _t, brushsize: _b, ...palettes } = before.palettes;
    palettes.subtools = { ...before.palettes.subtools, side: "right" };
    before.order = [...before.order.filter((id) => id !== "subtools"), "subtools"];
    const layout = readLayout(JSON.stringify({ ...before, palettes }));
    expect(column(layout, "right").slice(-3)).toEqual(["subtools", "toolprops", "brushsize"]);
    expect(layout.palettes.toolprops).toMatchObject({ side: "right", shown: true });
    expect(layout.palettes.brushsize).toMatchObject({ side: "right", shown: false });
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
    expect(layout.order.slice(layout.order.indexOf("subtools"), layout.order.indexOf("pages"))).toEqual([
      "subtools",
      "toolprops",
      "brushsize",
    ]);
    expect(layout.order.indexOf("script")).toBeLessThan(layout.order.indexOf("inspector"));
    expect(layout.order).toHaveLength(12);
    expect(layout.palettes.subtools).toMatchObject({ side: "left", shown: true });
    expect(layout.palettes.pages).toMatchObject({ side: "right", col: 0, shown: true, folded: true, weight: 2, tab: null, float: null });
    expect(layout.palettes.script.side).toBe("left");
    // One column a side, its width as it was (in range).
    expect(layout.widths).toEqual({ left: [640], right: [160] });
    expect(layout.collapsed).toEqual({ left: true, right: false });
    expect(readLayout("{not json").order).toHaveLength(12);
  });

  it("makes a new column at a side's edge, up to three, and drops a column left empty", () => {
    const layout = defaultLayout();
    placePalette(layout, "pages", { side: "left", col: 1, newColumn: true });
    expect(columnsOf(layout, "left")).toEqual([0, 1]);
    expect(layout.palettes.pages.col).toBe(1);
    expect(layout.widths.left).toHaveLength(2);
    // By the window's edge: the others move one in.
    placePalette(layout, "toolprops", { side: "left", col: 0, newColumn: true });
    expect([layout.palettes.toolprops.col, layout.palettes.subtools.col, layout.palettes.pages.col]).toEqual([0, 1, 2]);
    expect(canAddColumn(layout, "left")).toBe(false);
    // Moved back, its column goes.
    movePalette(layout, "toolprops", "left", "subtools");
    expect(columnsOf(layout, "left")).toEqual([0, 1]);
    expect([layout.palettes.subtools.col, layout.palettes.pages.col]).toEqual([0, 1]);
    expect(layout.widths.left).toHaveLength(2);
  });

  it("puts palettes together as tabs of one frame, one in front", () => {
    const layout = defaultLayout();
    joinTab(layout, "script", "pages");
    let frame = frames(layout, "left", 0).find((f) => f.members.includes("pages"));
    expect(frame).toEqual({ lead: "pages", members: ["pages", "script"], front: "script" });
    expect(isOpen(layout, "script")).toBe(true);
    expect(isOpen(layout, "pages")).toBe(false);
    showTab(layout, "pages");
    expect(isOpen(layout, "pages")).toBe(true);
    // The frame's first taken out: the next one leads the others.
    joinTab(layout, "notes", "pages");
    movePalette(layout, "pages", "right", null);
    frame = frames(layout, "left", 0).find((f) => f.members.includes("script"));
    expect(frame?.lead).toBe("script");
    expect(frame?.members).toEqual(["script", "notes"]);
    expect(layout.palettes.pages.tab).toBeNull();
  });

  it("floats a palette over the pages and puts it back", () => {
    const layout = defaultLayout();
    floatPalette(layout, "toolprops", { x: 500, y: 200, w: 260, h: 300 });
    expect(floating(layout)).toEqual(["toolprops"]);
    expect(isOpen(layout, "toolprops")).toBe(true);
    expect(frames(layout, "left", 0).some((f) => f.members.includes("toolprops"))).toBe(false);
    // Kept and read back.
    const back = readLayout(JSON.stringify(layout));
    expect(back.palettes.toolprops.float).toEqual({ x: 500, y: 200, w: 260, h: 300 });
    dockPalette(back, "toolprops");
    expect(back.palettes.toolprops.float).toBeNull();
    expect(frames(back, "left", 0).some((f) => f.members.includes("toolprops"))).toBe(true);
  });

  it("keeps the sub tools as tall as they hold, the lists sharing the rest", () => {
    const layout = defaultLayout();
    expect([layout.palettes.subtools.fit, layout.palettes.toolprops.fit, layout.palettes.pages.fit]).toEqual([true, true, false]);
  });

  it("puts a hidden palette whose column shows nothing into the nearest column", () => {
    const layout = defaultLayout();
    placePalette(layout, "layers", { side: "left", col: 1, newColumn: true });
    layout.palettes.layers.shown = false;
    tidy(layout);
    expect(columnsOf(layout, "left")).toEqual([0]);
    expect(layout.palettes.layers.col).toBe(0);
    expect(column(layout, "left")).toContain("layers");
  });
});

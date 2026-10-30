import { describe, expect, it } from "vitest";
import {
  brushPicks,
  brushRef,
  DEFAULT_SIZE_PRESETS,
  handSizesFrom,
  presetsFrom,
  reorderBrushes,
  sizeInHand,
  sizeOfSlider,
  sliderOf,
  withHandSize,
  withoutPreset,
  withPreset,
} from "./brushpicks";
import { replaceSubtoolCommands, subtoolCommandId, type Command } from "./commands";
import type { Brush, BrushKind } from "./model";

const brush = (id: string, name: string, kind: BrushKind = "pen", sizeMm = 0.5, source = `CSP: ペン / ${name}`): Brush => ({
  id,
  name,
  kind,
  sizeMm,
  opacity: 1,
  hardness: 1,
  stabilization: 0,
  taperInMm: 0,
  taperOutMm: 0,
  thickness: 100,
  rotation: 0,
  source,
});

describe("サブツール: picking pens and erasers", () => {
  it("lists the plain one, the name's, then those of other names not already in it", () => {
    const g = brush("b1", "Gペン");
    const eraser = brush("b2", "硬め", "eraser");
    const library = [brush("x", "Gペン"), brush("y", "鉛筆"), brush("z", "練り消し", "eraser")];
    const pens = brushPicks({ brushes: [g, eraser] }, library, "pen");
    expect(pens.map((p) => [p.brush?.name ?? "plain", p.library])).toEqual([
      ["plain", false],
      ["Gペン", false],
      ["鉛筆", true],
    ]);
    expect(brushPicks({ brushes: [g, eraser] }, library, "eraser").map((p) => p.brush?.name ?? "plain")).toEqual(["plain", "硬め", "練り消し"]);
  });

  it("names a pen the same in every name (its keys and size go by it)", () => {
    expect(brushRef("pen", brush("b1", "Gペン"))).toBe(brushRef("pen", brush("b7", "Gペン")));
    expect(brushRef("pen", null)).toBe("pen:plain");
    expect(brushRef("pen", brush("b1", "Gペン"))).not.toBe(brushRef("pen", brush("b1", "Gペン", "pen", 0.5, "name-studio")));
    expect(subtoolCommandId("pen:plain")).toBe("subtool:pen:plain");
  });

  it("moves pens among pens, the erasers keeping their places", () => {
    const list = [brush("a", "A"), brush("e", "E", "eraser"), brush("b", "B"), brush("c", "C")];
    expect(reorderBrushes(list, "pen", 2, 2, 0).map((b) => b.id)).toEqual(["c", "e", "a", "b"]);
    expect(reorderBrushes(list, "pen", 0, 0, 3).map((b) => b.id)).toEqual(["b", "e", "c", "a"]);
    expect(reorderBrushes(list, "pen", 1, 1, 1).map((b) => b.id)).toEqual(["a", "e", "b", "c"]);
  });
});

describe("ブラシサイズ", () => {
  it("keeps the size each pen was last used at, until its own size is set anew", () => {
    const g = brush("b1", "Gペン", "pen", 0.6);
    let sizes = withHandSize({}, "pen", g, 1.5);
    expect(sizeInHand(sizes, "pen", g)).toBe(1.5);
    expect(sizeInHand(sizes, "pen", brush("b9", "Gペン", "pen", 0.6))).toBe(1.5);
    // Its own size changed (in its settings): that one.
    expect(sizeInHand(sizes, "pen", { ...g, sizeMm: 0.8 })).toBe(0.8);
    // Back to its own size: nothing to keep.
    sizes = withHandSize(sizes, "pen", g, 0.6);
    expect(sizes).toEqual({});
    expect(sizeInHand(withHandSize({}, "pen", null, 1), "pen", null)).toBe(1);
    expect(sizeInHand({}, "pen", null)).toBe(0.4);
    expect(handSizesFrom({ a: { mm: 1, base: 0.5 }, b: { mm: "x" }, c: null })).toEqual({ a: { mm: 1, base: 0.5 } });
    expect(handSizesFrom("broken")).toEqual({});
  });

  it("offers round sizes, kept in order, each once, within range", () => {
    expect(presetsFrom(null)).toEqual(DEFAULT_SIZE_PRESETS);
    expect(presetsFrom({ pen: [3, 0.25, 3, -1, "x", 99] }).pen).toEqual([0.25, 3, 20]);
    expect(presetsFrom({ pen: [1] }).eraser).toEqual(DEFAULT_SIZE_PRESETS.eraser);
    const added = withPreset(presetsFrom(null), "pen", 0.25);
    expect(added.pen).toContain(0.25);
    expect(added.pen).toEqual([...added.pen].sort((a, b) => a - b));
    expect(withoutPreset(added, "pen", 0.25).pen).toEqual(DEFAULT_SIZE_PRESETS.pen);
  });

  it("moves the slider by ratio, giving thin pens as much room as thick ones", () => {
    expect(sliderOf("pen", 0.05)).toBe(0);
    expect(sliderOf("pen", 20)).toBe(1000);
    expect(sizeOfSlider("pen", sliderOf("pen", 0.5))).toBe(0.5);
    expect(sizeOfSlider("pen", sliderOf("pen", 3))).toBe(3);
    expect(sizeOfSlider("eraser", 0)).toBe(0.2);
    // Halfway is the geometric middle (1 mm), not 10 mm.
    expect(sizeOfSlider("pen", 500)).toBe(1);
  });
});

describe("サブツールの命令", () => {
  const command = (id: string, label = id): Command => ({ id, label, group: "x", keys: [], run: () => true });

  it("puts the sub tools' commands in place of the ones before, keeping the list itself", () => {
    const list = [command("save"), command("subtool:pen:plain"), command("undo")];
    const same = list;
    expect(replaceSubtoolCommands(list, [command("subtool:pen:plain"), command("subtool:pen:a")])).toBe(true);
    expect(same.map((c) => c.id)).toEqual(["save", "undo", "subtool:pen:plain", "subtool:pen:a"]);
    const run = () => false;
    expect(replaceSubtoolCommands(list, [{ ...command("subtool:pen:plain"), run }, command("subtool:pen:a")])).toBe(false);
    expect(list[2].run).toBe(run);
  });
});

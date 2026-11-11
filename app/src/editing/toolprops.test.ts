import { describe, expect, it } from "vitest";
import {
  choicesFrom,
  hasOwnChoice,
  kindKey,
  matchingItems,
  movedItems,
  shownItems,
  toggledItem,
  withChoice,
  withChoiceForTool,
  type PropItem,
} from "./toolprops";

const items: PropItem[] = [
  { id: "BrushSize", label: "ブラシサイズ", group: "ブラシサイズ" },
  { id: "Opacity", label: "不透明度", group: "不透明度" },
  { id: "AntiAlias", label: "アンチエイリアス", group: "アンチエイリアス" },
  { id: "FlickerReduction", label: "手ブレ補正", group: "補正" },
];

describe("ツールプロパティに出す項目", () => {
  it("shows the sub tool's own choice, else its tool's, else the one out of the box", () => {
    const fallback = ["BrushSize", "Opacity"];
    expect(shownItems({}, "pen:/G", "pen", items, fallback)).toEqual(fallback);
    const tool = withChoice({}, kindKey("pen"), ["FlickerReduction"]);
    expect(shownItems(tool, "pen:/G", "pen", items, fallback)).toEqual(["FlickerReduction"]);
    const own = withChoice(tool, "pen:/G", ["AntiAlias", "BrushSize"]);
    expect(shownItems(own, "pen:/G", "pen", items, fallback)).toEqual(["AntiAlias", "BrushSize"]);
    expect(hasOwnChoice(own, "pen:/G")).toBe(true);
    expect(shownItems(own, "pen:/丸", "pen", items, fallback)).toEqual(["FlickerReduction"]);
    // Back to its tool's.
    expect(shownItems(withChoice(own, "pen:/G", null), "pen:/G", "pen", items, fallback)).toEqual(["FlickerReduction"]);
  });

  it("leaves out what cannot be shown for this sub tool", () => {
    expect(shownItems({ "pen:plain": ["Opacity", "BrushSize", "Gone"] }, "pen:plain", "pen", items.slice(0, 1), [])).toEqual(["BrushSize"]);
  });

  it("gives every sub tool of a tool the same items, its own choices going", () => {
    const choices = { "pen:/G": ["Opacity"], "eraser:/硬め": ["BrushSize"] };
    const next = withChoiceForTool(choices, "pen", ["AntiAlias"]);
    expect(next).toEqual({ "eraser:/硬め": ["BrushSize"], "pen:*": ["AntiAlias"] });
  });

  it("puts an item shown anew where it comes among those shown", () => {
    expect(toggledItem(["BrushSize", "FlickerReduction"], "Opacity", true, items)).toEqual(["BrushSize", "Opacity", "FlickerReduction"]);
    // After one moved out of order, it goes before the first that comes after it.
    expect(toggledItem(["FlickerReduction", "BrushSize"], "AntiAlias", true, items)).toEqual([
      "AntiAlias",
      "FlickerReduction",
      "BrushSize",
    ]);
    expect(toggledItem(["BrushSize", "Opacity"], "Opacity", false, items)).toEqual(["BrushSize"]);
  });

  it("moves items as a drag sorts them", () => {
    expect(movedItems(["a", "b", "c", "d"], 3, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(movedItems(["a", "b", "c", "d"], 0, 0, 4)).toEqual(["b", "c", "d", "a"]);
  });

  it("finds items by any of their words", () => {
    expect(matchingItems(items, "補正").map((i) => i.id)).toEqual(["FlickerReduction"]);
    expect(matchingItems(items, "").length).toBe(4);
    expect(matchingItems(items, "opa").map((i) => i.id)).toEqual(["Opacity"]);
  });

  it("reads back only what reads", () => {
    expect(choicesFrom({ a: ["x", 3, "x"], b: "no", c: null })).toEqual({ a: ["x"] });
    expect(choicesFrom("nope")).toEqual({});
    expect(choicesFrom([1])).toEqual({});
  });
});

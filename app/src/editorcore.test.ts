import { describe, expect, it } from "vitest";
import { framedAtOnce, toolHolds, type Selection, type Tool } from "./editorcore";

const KINDS: Selection["kind"][] = ["panel", "line", "stroke", "breakout", "group", "sticky", "fill"];
const TOOLS: Tool[] = ["select", "cut", "text", "pen", "eraser", "fill", "breakout", "sticky", "reference"];

describe("選択の決まり", () => {
  it("lets the select tool keep anything picked", () => {
    for (const kind of KINDS) expect(toolHolds("select", kind)).toBe(true);
  });

  it("lets the other tools keep only what they make", () => {
    const kept = Object.fromEntries(TOOLS.filter((tool) => tool !== "select").map((tool) => [tool, KINDS.filter((kind) => toolHolds(tool, kind))]));
    expect(kept).toEqual({
      cut: ["panel"],
      text: ["line"],
      pen: [],
      eraser: [],
      fill: [],
      breakout: ["breakout"],
      sticky: ["sticky"],
      reference: [],
    });
  });

  it("frames at once what has no handles of its own", () => {
    expect(KINDS.filter(framedAtOnce)).toEqual(["stroke", "breakout", "group", "fill"]);
  });
});

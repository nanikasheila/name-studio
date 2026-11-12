import { describe, expect, it } from "vitest";
import { editorCursor, penCursor } from "./cursors";
import { CURSOR_LABELS, drawsSize, parsePenSettings, type PenCursor } from "../editing/pen";

const looks = Object.keys(CURSOR_LABELS) as PenCursor[];

describe("the pen's cursor", () => {
  it("keeps each kind chosen, and the brush's size when the kind is unknown", () => {
    for (const look of looks) expect(parsePenSettings(JSON.stringify({ cursor: look })).cursor).toBe(look);
    expect(parsePenSettings(JSON.stringify({ cursor: "star" })).cursor).toBe("brush");
  });

  it("draws the pen's size on the pages (no system cursor) for the circles only", () => {
    expect(looks.filter(drawsSize)).toEqual(["brush", "circle", "circleCross"]);
    for (const look of ["brush", "circle", "circleCross"] as const) expect(penCursor(look, true)).toBe("none");
    expect(penCursor("cross", true)).toBe("crosshair");
    expect(penCursor("dot", true)).toMatch(/^url\(/);
    expect(penCursor("none", true)).toBe("none");
  });

  it("gives the 指示 tool (no brush to show) a cross for the circles, else the same", () => {
    for (const look of ["brush", "circle", "circleCross"] as const) expect(penCursor(look, false)).toBe("crosshair");
    expect(penCursor("none", false)).toBe("none");
    const state = { panning: false, erasing: false, lasso: false, hover: null };
    expect(editorCursor({ ...state, tool: "mark", penLook: "dot" })).toMatch(/^url\(/);
    expect(editorCursor({ ...state, tool: "pen", penLook: "circle" })).toBe("none");
    expect(editorCursor({ ...state, tool: "pen", penLook: "circle", panning: true })).toBe("grab");
  });
});

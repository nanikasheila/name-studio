import { describe, expect, it } from "vitest";
import { DrawColors, HISTORY_SIZE } from "./drawcolor";

const store = (start: unknown = null) => {
  let kept: unknown = start;
  const colors = new DrawColors(
    () => kept,
    (k) => {
      kept = JSON.parse(JSON.stringify(k));
    },
  );
  return { colors, kept: () => kept as { main: string; history: string[]; swatches: string[] } };
};

describe("描画色", () => {
  it("starts black on white, and reads back what was kept (bad values dropped)", () => {
    expect(store().colors.main).toBe("#000000");
    const { colors } = store({ main: "#E5383B", sub: "nope", history: ["#fff", 3, "#fff"], swatches: ["#123456"] });
    expect(colors.main).toBe("#e5383b");
    expect(colors.sub).toBe("#ffffff");
    expect(colors.history).toEqual(["#ffffff"]);
    expect(colors.swatches).toEqual(["#123456"]);
  });

  it("sets, swaps and keeps the colours used lately, newest first, without repeats", () => {
    const { colors, kept } = store();
    let calls = 0;
    colors.onChange(() => calls++);
    expect(colors.setMain("#3a7bd5")).toBe(true);
    expect(colors.setMain("#3A7BD5")).toBe(false);
    colors.swap();
    expect([colors.main, colors.sub]).toEqual(["#ffffff", "#3a7bd5"]);
    colors.used("#3a7bd5");
    colors.used("#e5383b");
    colors.used("#3a7bd5");
    expect(colors.history).toEqual(["#3a7bd5", "#e5383b"]);
    for (let i = 0; i < HISTORY_SIZE + 5; i++) colors.used(`#0000${(i + 16).toString(16)}`);
    expect(colors.history.length).toBe(HISTORY_SIZE);
    expect(kept().main).toBe("#ffffff");
    expect(calls).toBeGreaterThan(3);
  });

  it("keeps the person's own colour set", () => {
    const { colors } = store();
    expect(colors.addSwatch("#e5383b")).toBe(true);
    expect(colors.addSwatch("#E5383B")).toBe(false);
    colors.removeSwatch("#e5383b");
    expect(colors.swatches).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyNewNameDefaults, defaultsOf } from "./namedefaults";
import { NEW_NAME_KEY, newNameDefaults, saveNewNameDefaults } from "./prefs";
import { newProject } from "./project";
import { writeText } from "./settings";

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
  });
});
afterEach(() => {
  writeText(NEW_NAME_KEY, null);
  vi.unstubAllGlobals();
});

describe("新しいネームの既定", () => {
  it("passes a name's settings on to the names made after it", () => {
    const from = newProject("a", 4);
    from.gutters = { across: 3, down: 8 };
    from.fonts = { speech: "アンチック" };
    from.style = { fontPt: { speech: 15 }, panelLineMm: 0.5 };
    from.lineShapes = { thought: "cloud" };
    saveNewNameDefaults(from);
    const made = newProject("b", 8);
    expect(applyNewNameDefaults(made, newNameDefaults())).toBe(true);
    expect(made).toMatchObject({ gutters: { across: 3, down: 8 }, fonts: { speech: "アンチック" }, style: { fontPt: { speech: 15 }, panelLineMm: 0.5 }, lineShapes: { thought: "cloud" } });
    // Copies, not the same objects.
    made.style!.panelLineMm = 1;
    expect(newNameDefaults()?.style?.panelLineMm).toBe(0.5);
  });

  it("leaves a 縦スクロール name's gutters for the strip", () => {
    const strip = newProject("s", 4, "scroll");
    expect(defaultsOf(strip).gutters).toBeUndefined();
    const made = newProject("t", 4, "scroll");
    applyNewNameDefaults(made, { gutters: { across: 1, down: 1 }, style: { balloonLineMm: 0.4 } });
    expect(made.gutters).toEqual({ across: 3, down: 24 });
    expect(made.style).toEqual({ balloonLineMm: 0.4 });
  });

  it("starts plain when nothing (or nothing readable) is kept", () => {
    expect(applyNewNameDefaults(newProject("x", 1), newNameDefaults())).toBe(false);
    writeText(NEW_NAME_KEY, "{broken");
    expect(newNameDefaults()).toBeNull();
    writeText(NEW_NAME_KEY, JSON.stringify({ gutters: { across: "2" } }));
    expect(newNameDefaults()).toBeNull();
    saveNewNameDefaults(newProject("plain", 1));
    expect(newNameDefaults()).toBeNull();
  });
});

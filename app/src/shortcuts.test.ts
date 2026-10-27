import { describe, expect, it } from "vitest";
import { comboOf, Shortcuts, type ActionInfo } from "./shortcuts";

const ACTIONS: ActionInfo[] = [
  { id: "redo", label: "やり直す", group: "編集", keys: ["Ctrl+Y", "Ctrl+Shift+Z"] },
  { id: "tool.pen", label: "ペン", group: "道具", keys: ["P"] },
  { id: "view.edit", label: "物語の帯を元の高さに", group: "画面", keys: ["F1"] },
];

const key = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

function memory(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("ショートカット", () => {
  it("writes key presses the same way every time", () => {
    expect(comboOf(key("s", { ctrlKey: true }))).toBe("Ctrl+S");
    expect(comboOf(key("S", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+S");
    expect(comboOf(key("p"))).toBe("P");
    expect(comboOf(key("?", { shiftKey: true }))).toBe("?");
    expect(comboOf(key(" "))).toBe("Space");
    expect(comboOf(key("F2", { altKey: true }))).toBe("Alt+F2");
    expect(comboOf(key("Shift", { shiftKey: true }))).toBeNull();
  });

  it("finds actions by their keys, and moves a key that is given to another action", () => {
    const storage = memory();
    const shortcuts = new Shortcuts(storage, ACTIONS);
    expect(shortcuts.actionFor("P")).toBe("tool.pen");
    expect(shortcuts.actionFor("Ctrl+Shift+Z")).toBe("redo");
    expect(shortcuts.bind("tool.pen", "F5")).toBeNull();
    expect(shortcuts.actionFor("F5")).toBe("tool.pen");
    // F1 belongs to the edit view: giving it to the pen takes it from there.
    expect(shortcuts.bind("tool.pen", "F1")).toBe("view.edit");
    expect(shortcuts.keys("view.edit")).toEqual([]);
    expect(shortcuts.changed()).toBe(true);
    // Kept for the next start.
    const again = new Shortcuts(storage, ACTIONS);
    expect(again.keys("tool.pen")).toEqual(["P", "F5", "F1"]);
    again.unbind("tool.pen", "P");
    expect(again.actionFor("P")).toBeNull();
    again.reset();
    expect(again.keys("tool.pen")).toEqual(["P"]);
    expect(again.changed()).toBe(false);
  });

  it("tells whoever shows the keys when they change", () => {
    const shortcuts = new Shortcuts(memory(), ACTIONS);
    let told = 0;
    shortcuts.onChange(() => told++);
    shortcuts.bind("tool.pen", "F9");
    shortcuts.unbind("tool.pen", "F9");
    shortcuts.reset();
    expect(told).toBe(3);
  });
});

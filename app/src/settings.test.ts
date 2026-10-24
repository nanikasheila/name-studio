import { afterEach, describe, expect, it, vi } from "vitest";
import { readCount, readFlag, readJson, readNumber, readText, writeCount, writeFlag, writeJson, writeNumber, writeText } from "./settings";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("settings kept on this computer", () => {
  it("keeps flags, counts, text and JSON for the next start", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    writeFlag("f", false);
    writeCount("n", 3);
    writeText("t", "見本.clip");
    writeJson("j", { rows: 2 });
    expect([readFlag("f", true), readCount("n", 1), readText("t"), readJson("j", null)]).toEqual([false, 3, "見本.clip", { rows: 2 }]);
    writeText("t", null);
    expect(readText("t")).toBeNull();
  });

  it("keeps numbers with zero and fractions, within their range", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    writeNumber("gap", 0);
    expect(readNumber("gap", 12, 0, 100)).toBe(0);
    writeNumber("gap", 2.5);
    expect(readNumber("gap", 12, 0, 100)).toBe(2.5);
    writeNumber("gap", 500);
    expect(readNumber("gap", 12, 0, 100)).toBe(12);
    writeText("gap", "");
    expect(readNumber("gap", 12, 0, 100)).toBe(12);
    expect(readNumber("none", 7, 0, 100)).toBe(7);
  });

  it("gives the fallback for what is not there or does not read", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem("n", "-2");
    storage.setItem("j", "{broken");
    expect([readFlag("none", true), readCount("n", 4), readJson("j", [])]).toEqual([true, 4, []]);
  });

  it("carries on when there is no storage or it refuses", () => {
    const refusing = { ...memoryStorage(), getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    vi.stubGlobal("localStorage", refusing);
    expect(() => writeFlag("f", true)).not.toThrow();
    expect(readFlag("f", true)).toBe(true);
    vi.stubGlobal("localStorage", undefined);
    expect(readCount("n", 2)).toBe(2);
  });
});

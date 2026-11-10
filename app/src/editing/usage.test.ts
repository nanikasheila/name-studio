import { describe, expect, it } from "vitest";
import { countUse, dayOf, emptyUsage, topUses, totalUses, usageFrom, usageText, usedToday } from "./usage";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 10, 10, 9, 0).getTime();

describe("使われ方", () => {
  it("counts uses of each kind, and the days the app was used on", () => {
    const usage = emptyUsage(T0);
    countUse(usage, "command", "edit.undo", T0);
    countUse(usage, "command", "edit.undo", T0 + 1000);
    countUse(usage, "tool", "pen", T0 + 2000);
    expect(usage.counts.command["edit.undo"]).toEqual({ count: 2, lastMs: T0 + 1000 });
    expect(usage.days).toBe(1);
    expect(usedToday(usage, T0 + 3000)).toBe(false);
    expect(usedToday(usage, T0 + DAY)).toBe(true);
    expect(usage.days).toBe(2);
    expect(usage.lastDay).toBe(dayOf(T0 + DAY));
    expect(totalUses(usage, "command")).toBe(2);
  });

  it("counts nothing while off", () => {
    const usage = emptyUsage(T0, false);
    expect(countUse(usage, "command", "edit.undo", T0)).toBe(false);
    expect(usedToday(usage, T0)).toBe(false);
    expect(usage.counts.command).toEqual({});
    expect(usage.days).toBe(0);
  });

  it("lists the most used first, by name, then the latest among equals", () => {
    const usage = emptyUsage(T0);
    for (let i = 0; i < 3; i++) countUse(usage, "command", "a", T0 + i);
    countUse(usage, "command", "b", T0 + 10);
    countUse(usage, "command", "c", T0 + 20);
    const rows = topUses(usage, "command", (id) => (id === "a" ? "元に戻す" : undefined), 2);
    expect(rows.map((row) => [row.label, row.count])).toEqual([
      ["元に戻す", 3],
      ["c", 1],
    ]);
  });

  it("reads back what was kept, leaving out what does not read", () => {
    const usage = usageFrom(
      {
        on: false,
        sinceMs: T0,
        days: 3,
        lastDay: "2026-11-09",
        counts: { command: { x: { count: 2, lastMs: 5 }, y: { count: -1 } }, tool: "?" },
      },
      T0 + DAY,
    );
    expect(usage.on).toBe(false);
    expect(usage.days).toBe(3);
    expect(usage.counts.command).toEqual({ x: { count: 2, lastMs: 5 } });
    expect(usage.counts.tool).toEqual({});
    expect(usageFrom(null, T0)).toEqual(emptyUsage(T0));
  });

  it("can be copied as text", () => {
    const usage = emptyUsage(T0);
    countUse(usage, "export", "csp", T0);
    const text = usageText(usage, (kind, id) => (kind === "export" && id === "csp" ? "CSP" : undefined));
    expect(text).toContain(`${dayOf(T0)} から、使った日 1 日`);
    expect(text).toContain("書き出し（合わせて 1 回）\n  CSP: 1 回");
    expect(text).toContain("よく使う命令（合わせて 0 回）\n  まだありません");
  });
});

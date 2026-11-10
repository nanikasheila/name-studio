import { describe, expect, it } from "vitest";
import { forgotten, recentFrom, remembered, splitPath, whenLabel, type RecentName } from "./recent";

const entry = (path: string, timeMs = 0): RecentName => ({ path, title: path, pages: 16, timeMs });

describe("recent names", () => {
  it("puts the newest first and keeps one entry per file", () => {
    const list = remembered([entry("C:\\a.namestudio"), entry("C:\\b.namestudio")], entry("c:/A.namestudio", 5));
    expect(list.map((name) => name.path)).toEqual(["c:/A.namestudio", "C:\\b.namestudio"]);
  });

  it("keeps a few at most", () => {
    let list: RecentName[] = [];
    for (let i = 0; i < 20; i++) list = remembered(list, entry(`/n${i}.namestudio`), 5);
    expect(list.map((name) => name.path)).toEqual(["/n19.namestudio", "/n18.namestudio", "/n17.namestudio", "/n16.namestudio", "/n15.namestudio"]);
  });

  it("forgets a file", () => {
    expect(forgotten([entry("/a"), entry("/b")], "/A")).toEqual([entry("/b")]);
  });

  it("reads only what it can from a kept value", () => {
    expect(recentFrom("x")).toEqual([]);
    expect(recentFrom([entry("/a", 3), { path: "" }, null, { path: "/b", title: "b", pages: "2", timeMs: 1 }, { ...entry("/c"), extra: 1 }])).toEqual([
      entry("/a", 3),
      entry("/c"),
    ]);
  });

  it("splits the file's name from its folder", () => {
    expect(splitPath("C:\\ネーム\\第4話.namestudio")).toEqual({ name: "第4話.namestudio", folder: "C:\\ネーム" });
    expect(splitPath("x.namestudio")).toEqual({ name: "x.namestudio", folder: "" });
  });

  it("says when as a day", () => {
    const now = new Date(2026, 9, 26, 15, 0).getTime();
    expect(whenLabel(new Date(2026, 9, 26, 9, 5).getTime(), now)).toBe("今日 9:05");
    expect(whenLabel(new Date(2026, 9, 25, 23, 59).getTime(), now)).toBe("昨日 23:59");
    expect(whenLabel(new Date(2026, 9, 3).getTime(), now)).toBe("10月3日");
    expect(whenLabel(new Date(2025, 11, 1).getTime(), now)).toBe("2025年12月1日");
  });
});

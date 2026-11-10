import { describe, expect, it } from "vitest";
import { STICKY_FOLDED_ROWS, stickyBox, stickyFolds, stickyRows } from "./stickies";

describe("付箋をたたむ", () => {
  const long = { id: "s", text: "情報局長はザグレウスの心臓によって失った腕を取り戻せるとニイに約束し、協力を引き出していた。", at: [10, 10] as [number, number] };

  it("shows a long sticky's first rows, ending in …, and all of it open", () => {
    const rows = stickyRows(long.text);
    expect(rows).toHaveLength(STICKY_FOLDED_ROWS);
    expect(rows.at(-1)!.endsWith("…")).toBe(true);
    expect(stickyRows(long.text, true).length).toBeGreaterThan(STICKY_FOLDED_ROWS);
    expect(stickyFolds(long)).toBe(true);
    expect(stickyBox(long, true)[3]).toBeGreaterThan(stickyBox(long)[3]);
  });

  it("leaves a short sticky as it is", () => {
    const short = { ...long, text: "ここ直す" };
    expect(stickyRows(short.text)).toEqual(["ここ直す"]);
    expect(stickyFolds(short)).toBe(false);
    expect(stickyBox(short, true)).toEqual(stickyBox(short));
  });
});

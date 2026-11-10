import { describe, expect, it } from "vitest";
import { wrapText } from "./notedraw";

// Every letter 10 px wide.
const ctx = { font: "10px test", measureText: (text: string) => ({ width: [...text].length * 10 }) } as unknown as CanvasRenderingContext2D;

describe("wrapping a memo into rows", () => {
  it("keeps all of it when there is no limit to the rows", () => {
    const text = "あいうえおかきくけこさしすせそたちつてと";
    const rows = wrapText(ctx, text, 50, Infinity);
    expect(rows).toEqual(["あいうえお", "かきくけこ", "さしすせそ", "たちつてと"]);
    expect(rows.join("")).toBe(text);
  });

  it("cuts it off with … past the most rows", () => {
    expect(wrapText(ctx, "あいうえおかきくけこさしすせそ", 50, 2)).toEqual(["あいうえお", "かきくけ…"]);
  });

  it("does not begin a row with 。 or 、: the letter before it goes down with it", () => {
    expect(wrapText(ctx, "あいうえお。かきくけこ", 50, Infinity)).toEqual(["あいうえ", "お。かきく", "けこ"]);
    expect(wrapText(ctx, "あいうえ」、かき", 50, Infinity)).toEqual(["あいうえ」", "、かき"]);
  });
});

import { describe, expect, it } from "vitest";
import { matchesQuery } from "./settingsdialog";

describe("設定を探す", () => {
  it("finds a setting by every word typed, in any width or case", () => {
    expect(matchesQuery("枠線の太さ 通常 太枠", "太さ")).toBe(true);
    expect(matchesQuery("枠線の太さ 通常 太枠", "枠線 太さ")).toBe(true);
    expect(matchesQuery("枠線の太さ 通常 太枠", "枠線 フォント")).toBe(false);
    expect(matchesQuery("ページの間隔 mm", "ＭＭ")).toBe(true);
    expect(matchesQuery("Webtoon 縦スクロール", "webtoon")).toBe(true);
  });
});

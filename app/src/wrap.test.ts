import { describe, expect, it } from "vitest";
import { wrapDialogue } from "./wrap";

describe("wrapping dialogue", () => {
  it("leaves short lines and lines already broken alone", () => {
    expect(wrapDialogue("ありがとう")).toBe("ありがとう");
    expect(wrapDialogue("もう\n行くよ、ずっと前から決めていたんだ")).toBe("もう\n行くよ、ずっと前から決めていたんだ");
  });

  it("breaks after punctuation and particles, about the width asked", () => {
    const wrapped = wrapDialogue("数か月前、この街の空から星がひとつ消えた。");
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toBe("数か月前、");
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(11);
    expect(lines.join("")).toBe("数か月前、この街の空から星がひとつ消えた。");
  });

  it("never starts a line with small kana or closing punctuation, nor breaks a katakana word", () => {
    const text = "ストラちゃんはエレクトリックギターを持ってきたっていうの！？";
    const lines = wrapDialogue(text).split("\n");
    expect(lines.join("")).toBe(text);
    for (const line of lines.slice(1)) expect(/^[、。！？っゃゅょー」]/.test(line)).toBe(false);
    expect(lines.some((line) => line.includes("エレクトリックギター"))).toBe(true);
  });

  it("wraps narrower when asked", () => {
    const text = "わたしはずっとここで待っているからね、きっと帰ってきてね";
    const narrow = wrapDialogue(text, 5).split("\n");
    const wide = wrapDialogue(text, 12).split("\n");
    expect(narrow.length).toBeGreaterThan(wide.length);
    for (const line of narrow) expect([...line].length).toBeLessThanOrEqual(9);
  });
});

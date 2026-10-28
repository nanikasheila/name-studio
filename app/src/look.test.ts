/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { COLOR_TOKENS, cssNotes, cssTemplate, DEFAULT_LOOK, fontStack, hexOf, lookFrom, THEMES, UI_FONT_STACK } from "./look";
import { isResetKeys } from "./lookpane";
import styles from "./styles.css?raw";

describe("画面の見た目 kept on this computer", () => {
  it("reads back what was kept, and the default for what does not read", () => {
    expect(lookFrom(null)).toEqual(DEFAULT_LOOK);
    expect(lookFrom({ theme: "neon", font: "  ", sizePx: "big", css: 3, cssOn: true })).toEqual(DEFAULT_LOOK);
    expect(lookFrom({ theme: "sepia", font: " メイリオ ", sizePx: 16.4, css: "a{}", cssOn: true })).toEqual({ theme: "sepia", font: "メイリオ", sizePx: 16, css: "a{}", cssOn: true });
  });

  it("keeps the size between the smallest and the largest", () => {
    expect(lookFrom({ sizePx: 4 }).sizePx).toBe(11);
    expect(lookFrom({ sizePx: 99 }).sizePx).toBe(20);
  });

  it("does not count empty CSS as on", () => {
    expect(lookFrom({ css: "  \n", cssOn: true }).cssOn).toBe(false);
  });
});

describe("the screen's font", () => {
  it("is the one chosen, quoted, then the app's", () => {
    expect(fontStack(null)).toBe(UI_FONT_STACK);
    expect(fontStack("BIZ UDPゴシック")).toBe(`"BIZ UDPゴシック", ${UI_FONT_STACK}`);
  });

  it("stays one name whatever the name holds", () => {
    expect(fontStack('My "Font" \\ 2')).toBe(`"My \\"Font\\" \\\\ 2", ${UI_FONT_STACK}`);
  });
});

describe("the user's CSS", () => {
  it("says nothing of CSS that reads", () => {
    expect(cssNotes(":root { --accent: #d0457a; }\n@media (min-width: 1px) { button { color: red; } }")).toEqual([]);
  });

  it("says when braces do not pair, past comments and strings", () => {
    expect(cssNotes("button { color: red;")).toEqual(["閉じていない { が 1 個あります（その先が読まれません）"]);
    expect(cssNotes("button { color: red; } }")).toEqual(["開いていない } があります（その先が読まれないことがあります）"]);
    expect(cssNotes('/* { */ a::before { content: "}"; }')).toEqual([]);
  });

  it("says @import is not followed", () => {
    expect(cssNotes('@import url("theme.css");')).toEqual(["@import は読み込みません（中身をここに書いてください）"]);
  });

  it("starts from every colour token with its value and what it is for", () => {
    const values = Object.fromEntries(COLOR_TOKENS.map(([name], i) => [name, `#00000${i % 10}`]));
    const template = cssTemplate(values);
    expect(cssNotes(template)).toEqual([]);
    for (const [name, what] of COLOR_TOKENS) expect(template).toMatch(new RegExp(`${name}: ${values[name]};\\s+/\\* ${what.replace(/[()]/g, "\\$&")} \\*/`));
  });

  it("writes colours as the screen shows them", () => {
    expect(hexOf("rgb(47, 111, 219)")).toBe("#2f6fdb");
    expect(hexOf("rgba(0, 0, 0, 0.05)")).toBe("rgba(0, 0, 0, 0.05)");
    expect(hexOf("rgba(255, 255, 255, 1)")).toBe("#ffffff");
  });
});

describe("the keys that put the look back", () => {
  it("are Ctrl+Shift+Alt+R, by the key's place (any input method)", () => {
    const press = { ctrlKey: true, metaKey: false, shiftKey: true, altKey: true, code: "KeyR" };
    expect(isResetKeys(press)).toBe(true);
    expect(isResetKeys({ ...press, altKey: false })).toBe(false);
    expect(isResetKeys({ ...press, code: "KeyT" })).toBe(false);
  });
});

describe("styles.css and the themes", () => {
  const base = styles.slice(styles.indexOf(":root, [data-theme] {"), styles.indexOf("}", styles.indexOf(":root, [data-theme] {")));

  it("gives every colour token the template offers a value, light and dark", () => {
    for (const [name] of COLOR_TOKENS) expect(base, name).toMatch(new RegExp(`\\n  ${name}: `));
  });

  it("has a block for every theme of its own colours", () => {
    for (const theme of THEMES.filter((t) => t.id !== "system")) expect(styles, theme.id).toContain(`[data-theme="${theme.id}"] {`);
  });

  it("leaves light and dark to the theme, not to the system's setting", () => {
    expect(styles).not.toContain("prefers-color-scheme");
  });

  it("writes every size of words so that it grows with the size chosen", () => {
    expect(styles.match(/font(?:-size)?:\s*\d[\d.]*px/g) ?? []).toEqual([]);
  });
});

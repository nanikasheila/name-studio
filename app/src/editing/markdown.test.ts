import { describe, expect, it } from "vitest";
import { inlineText, type MdBlock, parseInline, parseMarkdown } from "./markdown";

describe("markdown as an AI writes it", () => {
  it("reads emphasis, code and links inside a line, even next to Japanese brackets", () => {
    expect(parseInline("**「一緒に行く」が日常になっている**")).toEqual([
      { t: "strong", c: [{ t: "text", v: "「一緒に行く」が日常になっている" }] },
    ]);
    expect(parseInline("A *b* `c*d` ~~e~~ [f](https://x.test)")).toEqual([
      { t: "text", v: "A " },
      { t: "em", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " " },
      { t: "code", v: "c*d" },
      { t: "text", v: " " },
      { t: "del", c: [{ t: "text", v: "e" }] },
      { t: "text", v: " " },
      { t: "link", c: [{ t: "text", v: "f" }], href: "https://x.test" },
    ]);
    expect(parseInline("2 * 3 = 6、a_b_c、\\*そのまま\\*")).toEqual([{ t: "text", v: "2 * 3 = 6、a_b_c、*そのまま*" }]);
    expect(parseInline("**太字の中の *斜体* も**")).toEqual([
      {
        t: "strong",
        c: [
          { t: "text", v: "太字の中の " },
          { t: "em", c: [{ t: "text", v: "斜体" }] },
          { t: "text", v: " も" },
        ],
      },
    ]);
    expect(parseInline("一行目\n二行目")).toEqual([{ t: "text", v: "一行目" }, { t: "br" }, { t: "text", v: "二行目" }]);
    expect(parseInline("**閉じない")).toEqual([{ t: "text", v: "**閉じない" }]);
  });

  it("reads headings, paragraphs, rules, quotes and code", () => {
    const read = parseMarkdown("## 案\n\n段落の一行目\n二行目\n\n---\n> 引用\n> 続き\n\n```ts\nconst a = 1;\n```\n");
    expect(read.map((block) => block.t)).toEqual(["h", "p", "hr", "quote", "code"]);
    expect(read[0]).toEqual({ t: "h", level: 2, c: [{ t: "text", v: "案" }] });
    expect(inlineText((read[1] as Extract<MdBlock, { t: "p" }>).c)).toBe("段落の一行目\n二行目");
    expect((read[3] as { blocks: MdBlock[] }).blocks).toEqual([
      { t: "p", c: [{ t: "text", v: "引用" }, { t: "br" }, { t: "text", v: "続き" }] },
    ]);
    expect(read[4]).toEqual({ t: "code", lang: "ts", v: "const a = 1;" });
  });

  it("reads lists, numbered and nested, with paragraphs inside an item", () => {
    const read = parseMarkdown("1. **一つ目**\n\n   放課後、エイコが…\n\n2. 二つ目\n   - 下の項目\n   - もう一つ\n3. 三つ目\n\n- 別の箇条");
    expect(read.map((block) => block.t)).toEqual(["list", "list"]);
    const list = read[0] as Extract<MdBlock, { t: "list" }>;
    expect(list.ordered).toBe(true);
    expect(list.items.length).toBe(3);
    expect(list.items[0].map((block) => block.t)).toEqual(["p", "p"]);
    expect(list.items[1].map((block) => block.t)).toEqual(["p", "list"]);
    expect((list.items[1][1] as Extract<MdBlock, { t: "list" }>).items.length).toBe(2);
    expect((read[1] as Extract<MdBlock, { t: "list" }>).ordered).toBe(false);
    const from3 = parseMarkdown("3. 三\n4. 四")[0] as Extract<MdBlock, { t: "list" }>;
    expect(from3.start).toBe(3);
  });

  it("reads a table with its alignment", () => {
    const [table] = parseMarkdown("| 案 | ページ |\n|:--|--:|\n| A | 1 |\n| B \\| C | 2 |\n");
    expect(table.t).toBe("table");
    const read = table as Extract<MdBlock, { t: "table" }>;
    expect(read.align).toEqual(["left", "right"]);
    expect(read.rows.map((row) => row.map(inlineText))).toEqual([
      ["A", "1"],
      ["B | C", "2"],
    ]);
  });

  it("keeps tags as text: nothing becomes HTML", () => {
    expect(parseMarkdown("<img src=x onerror=alert(1)>")).toEqual([{ t: "p", c: [{ t: "text", v: "<img src=x onerror=alert(1)>" }] }]);
  });
});

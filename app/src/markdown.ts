// A small Markdown reader for what an AI says in 相談: headings, paragraphs,
// lists, quotes, code, tables, rules, and bold / italic / code / struck /
// links inside a line. It makes a tree, never HTML: the screen builds it
// from text nodes, so nothing an AI writes can run or load anything.

export type MdInline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "br" }
  | { t: "strong" | "em" | "del"; c: MdInline[] }
  | { t: "link"; c: MdInline[]; href: string };

export type MdBlock =
  | { t: "h"; level: number; c: MdInline[] }
  | { t: "p"; c: MdInline[] }
  | { t: "list"; ordered: boolean; start: number; items: MdBlock[][] }
  | { t: "quote"; blocks: MdBlock[] }
  | { t: "code"; lang: string; v: string }
  | { t: "hr" }
  | { t: "table"; align: ("left" | "center" | "right" | "")[]; head: MdInline[][]; rows: MdInline[][][] };

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const QUOTE = /^\s{0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The blocks of a Markdown text. */
export function parseMarkdown(text: string): MdBlock[] {
  return blocks(text.replace(/\r\n?/g, "\n").split("\n"));
}

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(line, next);
}

function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes("|") && next?.includes("-") === true && TABLE_RULE.test(next);
}

function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (row[i] === "|") {
      out.push(cell.trim());
      cell = "";
    } else cell += row[i];
  }
  out.push(cell.trim());
  return out;
}

function blocks(lines: string[]): MdBlock[] {
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[2];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(mark)) body.push(lines[i++].replace(new RegExp(`^ {0,${fence[1].length}}`), ""));
      i++;
      out.push({ t: "code", lang: fence[3] ?? "", v: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: "h", level: heading[1].length, c: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) inner.push(lines[i++].replace(QUOTE, ""));
      out.push({ t: "quote", blocks: blocks(inner) });
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""));
      i += 2;
      const rows: MdInline[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const row = cells(lines[i++]);
        rows.push(head.map((_, k) => parseInline(row[k] ?? "")));
      }
      out.push({ t: "table", align: head.map((_, k) => align[k] ?? ""), head: head.map((cell) => parseInline(cell)), rows });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const [list, next] = readList(lines, i);
      out.push(list);
      i = next;
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    out.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return out;
}

/** A list from line `from`: its items (each its own blocks, so lists nest) and the line after it. */
function readList(lines: string[], from: number): [MdBlock, number] {
  const first = ITEM.exec(lines[from])!;
  const indent = first[1].length;
  const ordered = first[3] !== undefined;
  const items: MdBlock[][] = [];
  let i = from;
  while (i < lines.length) {
    const item = ITEM.exec(lines[i]);
    if (!item || item[1].length !== indent || (item[3] !== undefined) !== ordered) break;
    const body: string[] = [item[4]];
    const inside = indent + item[2].length + 1;
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // A blank line ends the item unless what follows is indented into it.
        const after = lines[i + 1];
        if (after?.trim() && leading(after) > indent) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      const sub = ITEM.exec(line);
      if (sub && sub[1].length <= indent) break;
      if (!sub && leading(line) <= indent && startsBlock(line, lines[i + 1])) break;
      body.push(line.slice(Math.min(leading(line), inside)));
      i++;
    }
    items.push(blocks(body));
    // Loose lists: blank lines between items.
    while (i < lines.length && !lines[i].trim() && lines[i + 1] !== undefined && ITEM.exec(lines[i + 1])?.[1].length === indent) i++;
  }
  return [{ t: "list", ordered, start: ordered ? Number(first[3]) : 1, items }, i];
}

function leading(line: string): number {
  return line.length - line.trimStart().length;
}

/** What is inside a line: emphasis, code, links, and line breaks. */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ t: "text", v: plain });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length && /[\\`*_~[\]()#>|!-]/.test(text[i + 1])) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(text.slice(i))![0];
      const end = text.indexOf(run, i + run.length);
      if (end > i) {
        flush();
        out.push({ t: "code", v: text.slice(i + run.length, end).replace(/^ (.+) $/, "$1") });
        i = end + run.length;
        continue;
      }
    }
    const pair = (mark: string, t: "strong" | "em" | "del"): boolean => {
      if (!text.startsWith(mark, i)) return false;
      const from = i + mark.length;
      if (from >= text.length || /\s/.test(text[from])) return false;
      let end = text.indexOf(mark, from);
      // A single * must not take the first of a ** pair as its end.
      while (end > 0 && mark.length === 1 && text[end + 1] === mark && text[end - 1] !== mark) end = text.indexOf(mark, end + 2);
      if (end <= from || /\s/.test(text[end - 1]) || text.slice(from, end).includes("\n\n")) return false;
      flush();
      out.push({ t, c: parseInline(text.slice(from, end)) });
      i = end + mark.length;
      return true;
    };
    if (c === "*" || c === "_" || c === "~") {
      if (pair("**", "strong") || pair("__", "strong") || pair("~~", "del") || pair("*", "em")) continue;
      // `_` alone is too common in names and paths to read as emphasis.
    }
    if (c === "[") {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(i));
      if (link) {
        flush();
        out.push({ t: "link", c: parseInline(link[1]), href: link[2] });
        i += link[0].length;
        continue;
      }
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}

/** The plain words of inline parts (for a title or a search). */
export function inlineText(parts: MdInline[]): string {
  return parts.map((part) => (part.t === "text" || part.t === "code" ? part.v : part.t === "br" ? "\n" : inlineText(part.c))).join("");
}

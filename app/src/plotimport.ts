// プロットの取り込み: a plot written in Markdown (not a script: prose by
// page, no dialogue) dealt out as page memos, scenes and 付箋.
//
// What is read:
//   # タイトル                                   the title
//   ### 3ページ 見出し / ### P3 / ### 5〜7ページ   a page (its heading and text become the memo)
//   | 1〜3 | 3 | 場面 |  (a table row)          a scene over pages 1–3; a 合計 row gives the aimed page count
//   ## 見出し with page headings under it        a scene, when no table gives scenes
//                                                 (headings naming ページ, like ページごとのプロット, are not scenes)
//   ## any other section                         its list items (or its text) become 付箋, on the page they name
//                                                 or else the page they are most about (the first page when none stands out)
import { spreads } from "./pages";
import { addSticky, insertPage, putScene, stickyBox, STICKY_WIDTH_MM, type Project } from "./project";

export interface PlotPage {
  /** 1-based page number (the first of a range). */
  number: number;
  last: number;
  heading: string;
  text: string[];
}

export interface PlotScene {
  first: number;
  last: number;
  title: string;
  summary: string;
}

export interface PlotNote {
  section: string;
  text: string;
  /** 1-based page the note names, if any. */
  page?: number;
  /** The page is not named but guessed from what the note is about. */
  guessed?: boolean;
}

export interface PlotDoc {
  title?: string;
  pages: PlotPage[];
  scenes: PlotScene[];
  notes: PlotNote[];
  total?: number;
}

const PAGE = /^(?:[pP]\.?\s*)?(\d+)\s*(?:[〜~～\-–]\s*(\d+))?\s*(?:ページ|頁|[pP])?(?:\s+|[:：]\s*|$)(.*)$/;
const RANGE = /^(\d+)\s*(?:[〜~～\-–]\s*(\d+))?\s*(?:ページ|頁|[pP])?$/;
const MENTION = /(\d+)\s*(?:[〜~～\-–]\s*\d+\s*)?ページ/;

function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
}

/** The text of a list item or paragraph, without its marker. */
function item(row: string): { text: string; listed: boolean } {
  const match = /^(?:[-*+・]|\d+[.)．、])\s+(.*)$/.exec(row);
  return match ? { text: plain(match[1]), listed: true } : { text: plain(row), listed: false };
}

/** The first sentence, short enough for a scene name. */
function shortTitle(text: string): string {
  const first = text.split(/[。．]/)[0].trim();
  return [...first].length > 24 ? `${[...first].slice(0, 23).join("")}…` : first;
}

/** Read a plot. */
export function parsePlot(source: string): PlotDoc {
  const doc: PlotDoc = { pages: [], scenes: [], notes: [] };
  const rows = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  interface Section {
    heading: string;
    pages: PlotPage[];
    rows: string[];
  }
  // Set inside the loop, so typed loosely for the checker.
  let section = null as Section | null;
  let page = null as PlotPage | null;
  const sections: Section[] = [];
  for (const raw of rows) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = plain(heading[2]);
      if (level === 1) {
        doc.title ??= text;
        continue;
      }
      if (level === 2) {
        section = { heading: text, pages: [], rows: [] };
        sections.push(section);
        page = null;
        continue;
      }
      const match = PAGE.exec(text);
      if (level === 3 && match) {
        const number = Number(match[1]);
        page = { number, last: Math.max(number, Number(match[2] ?? number)), heading: match[3].trim(), text: [] };
        doc.pages.push(page);
        section?.pages.push(page);
        continue;
      }
      // A deeper heading inside a page reads as text.
      if (page) page.text.push(text);
      else section?.rows.push(text);
      continue;
    }
    // Table rows: 1〜3 | 3 | 場面.
    if (line.startsWith("|")) {
      const cells = line.replace(/^\||\|$/g, "").split("|").map((cell) => plain(cell));
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell) || !cell)) continue;
      const range = RANGE.exec(cells[0] ?? "");
      if (range && cells.length >= 2) {
        const first = Number(range[1]);
        const description = cells.slice(1).find((cell) => cell && !/^\d+$/.test(cell)) ?? "";
        doc.scenes.push({ first, last: Math.max(first, Number(range[2] ?? first)), title: shortTitle(description) || `${first} ページ`, summary: description });
      } else if (/^(合計|計|total)$/i.test(cells[0] ?? "")) {
        const total = cells.slice(1).map((cell) => Number.parseInt(cell, 10)).find((n) => Number.isInteger(n) && n > 0);
        if (total) doc.total = total;
      }
      continue;
    }
    if (page) {
      if (line) page.text.push(item(line).text);
    } else section?.rows.push(line);
  }
  // Without a table, sections that hold pages are the scenes.
  if (!doc.scenes.length) {
    for (const s of sections) {
      if (!s.pages.length || /ページ|頁/.test(s.heading)) continue;
      const first = Math.min(...s.pages.map((p) => p.number));
      const last = Math.max(...s.pages.map((p) => p.last));
      doc.scenes.push({ first, last, title: s.heading, summary: s.rows.filter(Boolean).map((row) => item(row).text).join("\n") });
    }
  }
  // Other sections: their list items, or their paragraphs, as notes.
  for (const s of sections) {
    if (s.pages.length || /ページ配分|配分/.test(s.heading)) continue;
    const notes: string[] = [];
    let paragraph: string[] = [];
    const flush = () => {
      if (paragraph.length) notes.push(paragraph.join(""));
      paragraph = [];
    };
    for (const row of s.rows) {
      if (!row) {
        flush();
        continue;
      }
      const { text, listed } = item(row);
      if (listed) {
        flush();
        notes.push(text);
      } else paragraph.push(text);
    }
    flush();
    for (const text of notes) {
      const mention = MENTION.exec(text);
      const guess = mention || SUMMARY.test(s.heading) ? undefined : likelyPage(doc.pages, text);
      doc.notes.push({ section: s.heading, text, ...(mention ? { page: Number(mention[1]) } : guess ? { page: guess, guessed: true } : {}) });
    }
  }
  return doc;
}

/** Sections about the whole story, whose notes stay with the first page. */
const SUMMARY = /流れ|あらすじ|概要|全体|ログライン/;

/** Pairs of characters inside words (kanji, katakana, Latin): what a note and a page share when they are about the same thing. */
function wordPairs(text: string): Set<string> {
  const word = (c: string) => /[一-鿿々ァ-ヿA-Za-z0-9Ａ-Ｚａ-ｚ０-９]/.test(c);
  const chars = [...text.replace(/\s+/g, "")];
  const pairs = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) if (word(chars[i]) && word(chars[i + 1])) pairs.add(chars[i] + chars[i + 1]);
  return pairs;
}

/**
 * The page a note is most about, by the words it shares with each page's
 * heading (counted twice) and text, rarer words counting more; none when no
 * page stands out.
 */
export function likelyPage(pages: readonly PlotPage[], text: string): number | undefined {
  const sets = pages.map((page) => ({ head: wordPairs(page.heading), body: wordPairs(page.text.join("")) }));
  const spread = new Map<string, number>();
  for (const set of sets) for (const pair of new Set([...set.head, ...set.body])) spread.set(pair, (spread.get(pair) ?? 0) + 1);
  const note = wordPairs(text);
  const scores = sets.map((set) => {
    let score = 0;
    for (const pair of note) {
      const weight = 1 / (spread.get(pair) ?? 1);
      if (set.head.has(pair)) score += 2 * weight;
      else if (set.body.has(pair)) score += weight;
    }
    return score;
  });
  const order = scores.map((score, i) => [score, i] as const).sort((a, b) => b[0] - a[0]);
  const [best, second] = [order[0], order[1]];
  if (!best || best[0] < 1.5 || (second && best[0] < 1.4 * second[0])) return undefined;
  return pages[best[1]].number;
}

/** Whether text reads as a plot (prose by page) rather than a script (panels and dialogue). */
export function looksLikePlot(source: string, dialogueLines: number): boolean {
  if (/^####\s/m.test(source)) return false;
  const doc = parsePlot(source);
  return doc.pages.length > 0 && dialogueLines < doc.pages.length;
}

export interface PlotImportReport {
  memos: number;
  scenes: number;
  stickies: number;
  addedPages: number;
}

/**
 * Deal a plot out onto the name, page numbers as they are (1 = the first
 * page). Missing pages are added. Memos fill empty pages and are added
 * under what a page already has; scenes replace the scenes they overlap.
 */
export function applyPlot(project: Project, doc: PlotDoc, firstAlone = true): PlotImportReport {
  const report: PlotImportReport = { memos: 0, scenes: 0, stickies: 0, addedPages: 0 };
  if (doc.title && (!project.title || project.title === "新しいネーム")) project.title = doc.title;
  const needed = Math.max(0, ...doc.pages.map((p) => p.last), ...doc.scenes.map((s) => s.last));
  while (project.pages.length < needed) {
    insertPage(project, project.pages.length);
    report.addedPages++;
  }
  if (doc.total && !project.plan?.targetPages) project.plan = { ...(project.plan ?? {}), targetPages: doc.total };
  for (const plotPage of doc.pages) {
    const page = project.pages[plotPage.number - 1];
    if (!page) continue;
    const range = plotPage.last > plotPage.number ? `（${plotPage.number}〜${plotPage.last} ページ）` : "";
    const memo = [plotPage.heading + range, ...plotPage.text].filter(Boolean).join("\n");
    if (!memo || page.memo.includes(memo)) continue;
    page.memo = page.memo.trim() ? `${page.memo.trim()}\n\n${memo}` : memo;
    report.memos++;
  }
  for (const scene of doc.scenes) {
    const first = scene.first - 1;
    const last = Math.min(scene.last, project.pages.length) - 1;
    if (first < 0 || last < first) continue;
    putScene(project, first, last, scene.title, scene.summary);
    report.scenes++;
  }
  // 付箋 down the outer side of their page (page 1 when none), in columns
  // inwards: on a left-hand page of a spread the gutter side is hidden under
  // the facing page.
  const [pageW, pageH] = project.pageFormat.canvasMm;
  const next = new Map<number, [number, number]>();
  for (const note of doc.notes) {
    const index = Math.min(Math.max((note.page ?? 1) - 1, 0), project.pages.length - 1);
    const page = project.pages[index];
    if (!page) continue;
    const left = spreads(project.pages.length, firstAlone).some(([, l]) => l === index + 1);
    let [x, y] = next.get(index) ?? [left ? 6 : pageW - STICKY_WIDTH_MM - 6, 6];
    const text = `【${note.section}】${note.text}`;
    // Its height before it goes down, so it never slides up over the one above.
    const height = stickyBox({ id: "", text, at: [0, 0] })[3];
    if (y > 6 && y + height > pageH - 6) {
      x = left ? Math.min(pageW - STICKY_WIDTH_MM - 6, x + STICKY_WIDTH_MM + 4) : Math.max(6, x - STICKY_WIDTH_MM - 4);
      y = 6;
    }
    addSticky(project, page, [x, y], text);
    next.set(index, [x, y + height + 4]);
    report.stickies++;
  }
  return report;
}

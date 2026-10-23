// 台本の取り込み (R7): a script written in Markdown (or the text the app
// writes out) read into pages, panels and dialogue, then dealt out onto the
// name: lines go into their panels, and pages without panels can get some.
//
// What is read (all optional; anything else is a stage direction, ト書き):
//   # タイトル                    the title
//   ## シーン名 / ◆ シーン名        a scene
//   ### 1ページ / ### P1 / ■ 1 ページ / --- (when no page headings)   a page
//   #### コマ / [1] / ［1］ / 【コマ1】 / コマ1                         a panel
//   名前「セリフ」 名前『セリフ』 名前：セリフ   speech
//   名前（心の声）                  thought (モノローグ)
//   ナレーション：… / N：…          narration
//   SE：… / 擬音：… / 描き文字：…    sound effect (描き文字)
//   「セリフ」                      speech with no speaker
//   名前〔電話〕「…」 名前（叫び）「…」  the balloon: 電話・無線・テレビ → 電子音、叫び → トゲ、
//                                  小声・ささやき → 破線、独白・心の声 → モノローグ
//   「…！！」                       a shout (トゲ) unless a tag says otherwise
//   型：導入 / 型: opening           the page's コマ割りの型 (fitted to its panels)
// List markers (- * + 1.), quotes (>) and **bold** are ignored.
import { layOut, placingBox, wrapToFit } from "./arrange";
import { balloonExtent } from "./balloon";
import { PATTERNS, patternPanels } from "./koma";
import {
  addCharacter,
  addLine,
  addPanel,
  assignPanels,
  basicBox,
  DEFAULT_GUTTERS,
  fitLine,
  insertPage,
  moveLine,
  orderPanels,
  pageIndex,
  putScene,
  rectShape,
  setLineKind,
  sortLines,
  type BalloonShape,
  type BoxMm,
  type Line,
  type LineKind,
  type Page,
  type Panel,
  type Project,
} from "./project";

export interface ScriptLine {
  speaker?: string;
  kind: LineKind;
  text: string;
  /** フキダシの形 asked for by a tag (〔電話〕) or the text (！！). */
  shape?: BalloonShape;
}

export interface ScriptPanel {
  notes: string[];
  lines: ScriptLine[];
}

export interface ScriptPage {
  /** Notes before the first panel (become the page memo). */
  notes: string[];
  panels: ScriptPanel[];
  scene?: string;
  /** コマ割りの型 asked for (型：導入), by id. */
  pattern?: string;
  /** The page number its heading gives (### 5ページ), if any. */
  number?: number;
}

export interface ScriptDoc {
  title?: string;
  pages: ScriptPage[];
  warnings: string[];
}

const NARRATION = new Set(["n", "na", "nar", "ナレ", "ナレーション", "ナレーター", "語り", "地の文"]);
const SFX = new Set(["se", "sfx", "擬音", "効果音", "描き文字", "音", "書き文字"]);
const NOTES = new Set(["ト書き", "トガキ", "演出", "メモ", "note", "絵"]);

const PAGE_HEADING = /^(?:(\d+)\s*(?:ページ|頁|p|P)|[pP]\.?\s*(\d+)|(\d+))(?:\s|$|[:：）)])/;
/** The page number at the start of a page heading, with what follows it up to the subtitle. */
const PAGE_NUMBER = /^(?:\d+\s*(?:ページ目?|頁|p|P)|[pP]\.?\s*\d+|\d+)\s*[:：）)]?\s*/;

/** Tags after a speaker's name: what kind of line and balloon. */
const TAGS: [RegExp, { kind?: LineKind; shape?: BalloonShape }][] = [
  [/電話|通話|無線|通信|スマホ|携帯|テレビ|TV|ラジオ|スピーカー|放送|モニター|機械|インカム/i, { shape: "electric" }],
  [/叫び|叫ぶ|絶叫|怒鳴|大声|怒号/, { shape: "spike" }],
  [/小声|ささやき|囁|ひそひそ|つぶやき|呟/, { shape: "dashed" }],
  [/独白|心の声|モノローグ|内心|心中/, { kind: "thought" }],
  [/ナレ|語り/, { kind: "narration" }],
];

/** A speaker written with a tag, 叔母〔電話〕 / 叔母（電話）: the name and what the tag asks for. */
function tagged(name: string): { name: string; kind?: LineKind; shape?: BalloonShape } {
  const match = /^(.*?)\s*[〔［[<＜（(]([^〕］\]>＞）)]{1,10})[〕］\]>＞）)]$/.exec(name);
  if (!match) return { name };
  const found = TAGS.find(([pattern]) => pattern.test(match[2]));
  return { name: match[1].trim(), ...(found ? found[1] : {}) };
}

/** A shout written with doubled marks gets a spiky balloon. */
function shouted(text: string): boolean {
  return /[！!]{2,}|[！!][？?][！!]/.test(text);
}

function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
}

/** A line of dialogue, or null for anything else. */
export function readLine(raw: string): ScriptLine | null {
  const text = plain(raw);
  if (!text) return null;
  // 名前〔電話〕「…」 / 名前（叫び）「…」 / 名前「…」 / 名前『…』 / 「…」
  let match = /^((?:[^「『（(：:\s〔［]{0,20})(?:\s*[〔［[<＜（(][^〕］\]>＞）)「『]{1,10}[〕］\]>＞）)])?)\s*[「『]([\s\S]*?)[」』]?$/.exec(text);
  if (match) {
    const { name, kind, shape } = tagged(match[1].trim());
    const said = match[2].trim();
    const balloon = shape ?? (shouted(said) ? "spike" : undefined);
    return { ...(name ? { speaker: name } : {}), kind: kind ?? "speech", text: said, ...(balloon ? { shape: balloon } : {}) };
  }
  // 名前〔電話〕：… (before 名前（…）, which would take the tag for a thought).
  match = /^([^「『（(：:〔［\s]{1,20}\s*[〔［[<＜（(][^〕］\]>＞）)]{1,10}[〕］\]>＞）)])\s*[：:]\s*([\s\S]+)$/.exec(text);
  if (match) {
    const { name, kind, shape } = tagged(match[1].trim());
    const said = match[2].trim().replace(/^[「『](.*)[」』]$/, "$1");
    const balloon = shape ?? (shouted(said) ? "spike" : undefined);
    return { speaker: name, kind: kind ?? "speech", text: said, ...(balloon ? { shape: balloon } : {}) };
  }
  // 名前（…） : thought. A bare （…） is a stage direction.
  match = /^([^「『（(：:\s]{1,20})\s*[（(]([\s\S]*?)[）)]?$/.exec(text);
  if (match) return { speaker: match[1].trim(), kind: "thought", text: match[2].trim() };
  // 名前：…
  match = /^([^「『（(：:]{1,20}?)\s*[：:]\s*([\s\S]+)$/.exec(text);
  if (match) {
    const name = match[1].trim();
    const said = match[2].trim().replace(/^[「『](.*)[」』]$/, "$1");
    const key = name.toLowerCase();
    if (NOTES.has(name) || NOTES.has(key)) return null;
    if (NARRATION.has(key) || NARRATION.has(name)) return { kind: "narration", text: said };
    if (SFX.has(key) || SFX.has(name)) return { kind: "sfx", text: said };
    return { speaker: name, kind: "speech", text: said };
  }
  return null;
}

/** A pattern by id or name (導入, 大ゴマ＋はめ込み, 3段…): the first whose name starts with it, else contains it. */
export function findPattern(name: string): string | undefined {
  const key = name.replace(/[（(].*$/, "").trim();
  if (!key) return undefined;
  return (
    PATTERNS.find((p) => p.id === key)?.id ??
    PATTERNS.find((p) => p.label.startsWith(key))?.id ??
    PATTERNS.find((p) => p.label.includes(key))?.id
  );
}

/** Read a script. */
export function parseScript(source: string): ScriptDoc {
  const doc: ScriptDoc = { pages: [], warnings: [] };
  const rows = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const pageHeadings = rows.some((row) => /^###(?!#)/.test(row.trim()) || /^■/.test(row.trim()));
  let scene: string | undefined;
  // Set inside the helpers below, so typed loosely for the checker.
  let page = null as ScriptPage | null;
  let panel = null as ScriptPanel | null;
  let sceneStarted = false;
  const newPage = () => {
    page = { notes: [], panels: [], ...(scene && !sceneStarted ? { scene } : {}) };
    sceneStarted = true;
    panel = null;
    doc.pages.push(page);
    return page;
  };
  const currentPage = (): ScriptPage => page ?? newPage();
  const newPanel = (number?: number) => {
    // The page first: starting one clears the current panel.
    const target = currentPage();
    // A numbered panel past the next one (［1］ then ［3］, as the app writes a page whose 2 has no dialogue): empty ones between.
    while (number && target.panels.length < number - 1 && number <= 40) target.panels.push({ notes: [], lines: [] });
    panel = { notes: [], lines: [] };
    target.panels.push(panel);
    return panel;
  };
  for (const row of rows) {
    const line = row.trim();
    if (!line) continue;
    let heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = plain(heading[2]);
      if (level === 1) {
        doc.title ??= text;
      } else if (level === 2) {
        scene = text;
        sceneStarted = false;
        // Without page headings, each scene starts a page.
        if (!pageHeadings || page) page = null;
      } else if (level === 3) {
        newPage();
        const numbered = PAGE_HEADING.exec(text);
        if (numbered) page!.number = Number(numbered[1] ?? numbered[2] ?? numbered[3]);
        // ### 1ページ 心臓の説明: the subtitle goes into the page memo.
        const subtitle = numbered ? text.replace(PAGE_NUMBER, "").trim() : text;
        if (subtitle) page!.notes.push(subtitle);
      } else {
        newPanel(Number(/^(?:コマ|\[|［)?\s*(\d+)/.exec(text)?.[1] ?? 0));
        const note = text.replace(/^(?:コマ|\[|［)?\s*\d*\s*(?:コマ目?|\]|］)?\s*[:：]?\s*/, "").trim();
        if (note) panel!.notes.push(note);
      }
      continue;
    }
    // The app's own text: ◆ scene, ■ N ページ, ［N］ panel.
    if (line.startsWith("◆")) {
      scene = plain(line.slice(1)).replace(/[（(].*[）)]$/, "").trim();
      sceneStarted = false;
      page = null;
      continue;
    }
    if (line.startsWith("■")) {
      newPage();
      const number = /^\s*(\d+)\s*ページ/.exec(plain(line.slice(1)));
      if (number) page!.number = Number(number[1]);
      const rest = plain(line.slice(1)).replace(/^\d+\s*ページ/, "").trim();
      if (rest) page!.notes.push(rest);
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      if (!pageHeadings) newPage();
      continue;
    }
    const bare = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, "");
    const asked = /^(?:型|【型】|コマ割り)\s*[:：]?\s*(.+)$/.exec(plain(bare));
    if (asked && findPattern(asked[1]) && (page || !pageHeadings)) {
      currentPage().pattern = findPattern(asked[1]);
      continue;
    }
    const panelMark = /^(?:[［[]\s*(\d+)\s*[］\]]|【\s*コマ\s*(\d*)\s*】|コマ\s*(\d+)(?:\s|$|[:：]))\s*(.*)$/.exec(bare);
    if (panelMark) {
      newPanel(Number(panelMark[1] ?? panelMark[2] ?? panelMark[3] ?? 0));
      const rest = plain(panelMark[4] ?? "");
      if (rest) {
        const said = readLine(rest);
        if (said) panel!.lines.push(said);
        else panel!.notes.push(rest);
      }
      continue;
    }
    const said = readLine(bare);
    if (said) {
      (panel ?? newPanel()).lines.push(said);
      continue;
    }
    const note = plain(bare);
    if (!note) continue;
    if (panel) panel.notes.push(note);
    else if (page || !pageHeadings) currentPage().notes.push(note);
    // Before the first page: the title line of a plain script; other notes there are left out.
    else doc.title ??= note;
  }
  if (!doc.pages.length) doc.warnings.push("セリフが見つかりませんでした");
  else if (!pageHeadings && !rows.some((row) => /^(?:-{3,}|\*{3,}|_{3,})$/.test(row.trim()))) {
    doc.warnings.push("ページの区切り（### 1ページ、■、---）がないので、シーンごとに 1 ページにしました");
  }
  return doc;
}

export interface ScriptImportOptions {
  /** First page (0-based) the script goes onto; pages are added past the end. */
  startPage: number;
  /** Pages with no panels get one per script panel, in tiers over the basic frame. */
  makePanels: boolean;
  /** The コマ割りの型 for those pages (fitted to their panels) when the script names none; none: tiers. */
  pattern?: string;
  /**
   * 台本を直して取り込み直す: pages that already have dialogue get theirs
   * brought in line with the script (changed text in place, new lines added,
   * lines gone from the script removed) instead of a second copy.
   */
  update?: boolean;
}

export interface ScriptImportReport {
  pages: number;
  panels: number;
  lines: number;
  characters: string[];
  scenes: number;
  /** Scenes already on the name that the script's took the place of. */
  replacedScenes: number;
  /** With `update`: pages put in for script pages the name did not have. */
  insertedPages: number;
  /** With `update`: pages (1-based) with dialogue that no script page went to, left as they were. */
  leftPages: number[];
  /** With `update`: lines left as they were, changed, added and removed. */
  kept: number;
  changed: number;
  added: number;
  removed: number;
}

/** Panels for `count` script panels over the basic frame: tiers, two side by side past four. */
export function panelBoxes(box: BoxMm, count: number, gutters = DEFAULT_GUTTERS): BoxMm[] {
  const [x0, y0, x1, y1] = box;
  const rows = count <= 4 ? count : Math.ceil(count / 2);
  const height = (y1 - y0 - gutters.down * (rows - 1)) / rows;
  const boxes: BoxMm[] = [];
  let left = count;
  for (let row = 0; row < rows; row++) {
    const across = count <= 4 ? 1 : left > rows - row ? 2 : 1;
    left -= across;
    const top = y0 + row * (height + gutters.down);
    const width = (x1 - x0 - gutters.across * (across - 1)) / across;
    // Right binding reads right to left: the first panel of a row on the right.
    for (let col = across - 1; col >= 0; col--) {
      const x = x0 + col * (width + gutters.across);
      boxes.push([x, top, x + width, top + height]);
    }
  }
  return boxes;
}

/** Deal the lines of a panel out over its box: right to left, wrapping down, broken into short lines and kept in the panel. */
function placeLines(project: Project, page: Page, panel: Panel | undefined, lines: ScriptLine[], speakers: Map<string, string>): void {
  const placed = lines.map((said) => {
    const line = addLine(project, page, [0, 0], said.text || "…", said.kind);
    if (said.speaker) line.speaker = speakers.get(said.speaker);
    if (said.shape) line.balloonShape = said.shape;
    return line;
  });
  layOut(placed, placingBox(project, panel), panel?.shape);
}

/** How much a page's dialogue reads like a script page's: the mean, over the script's lines, of the most alike line on the page. */
function pageLikeness(page: Page, scriptPage: ScriptPage): number {
  const said = scriptPage.panels.flatMap((panel) => panel.lines);
  if (!said.length || !page.lines.length) return 0;
  return said.reduce((sum, s) => sum + Math.max(...page.lines.map((line) => likeness(line.text, s.text))), 0) / said.length;
}

/** A script page and a page below this are not the same page. */
const SAME_PAGE = 0.4;
/** An empty page where a new script page falls is taken for it (rather than a page put in beside it). */
const EMPTY_PAGE = 0.2;

/**
 * The page each script page goes to when taken in again, from `start` on,
 * in order: the pairing whose dialogue reads most alike; undefined where the
 * script has a page the name does not (a page to put in).
 */
export function matchPages(project: Project, doc: ScriptDoc, start: number): (Page | undefined)[] {
  const pages = project.pages.slice(start);
  const said = doc.pages;
  const score = (i: number, j: number) => {
    if (!pages[j].lines.length) return EMPTY_PAGE;
    const alike = pageLikeness(pages[j], said[i]);
    return alike >= SAME_PAGE ? alike : 0;
  };
  const scores = said.map((_, i) => pages.map((_, j) => score(i, j)));
  const best: number[][] = Array.from({ length: said.length + 1 }, () => new Array<number>(pages.length + 1).fill(0));
  for (let i = said.length - 1; i >= 0; i--) {
    for (let j = pages.length - 1; j >= 0; j--) {
      const pair = scores[i][j];
      best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], pair > 0 ? pair + best[i + 1][j + 1] : 0);
    }
  }
  const targets: (Page | undefined)[] = new Array(said.length).fill(undefined);
  for (let i = 0, j = 0; i < said.length && j < pages.length; ) {
    const pair = scores[i][j];
    if (pair > 0 && best[i][j] === pair + best[i + 1][j + 1]) targets[i++] = pages[j++];
    else if (best[i][j] === best[i + 1][j]) i++;
    else j++;
  }
  // A script page past the name's pages, with none after it matched: the next page, as when first taken in.
  let last = -1;
  targets.forEach((page, i) => {
    if (page) last = pages.indexOf(page);
    else if (!targets.slice(i + 1).some(Boolean) && last + 1 < pages.length && !pages[last + 1].lines.length) targets[i] = pages[++last];
  });
  return targets;
}

/** Text compared without its line breaks and spaces. */
const bare = (text: string) => text.replace(/\s+/g, "");

/** How alike two lines of dialogue read, 0–1 (shared pairs of characters). */
export function likeness(a: string, b: string): number {
  const [x, y] = [bare(a), bare(b)];
  if (x === y) return 1;
  const pairs = (text: string) => {
    const chars = [...text];
    const counts = new Map<string, number>();
    for (let i = 0; i + 1 < chars.length; i++) counts.set(chars[i] + chars[i + 1], (counts.get(chars[i] + chars[i + 1]) ?? 0) + 1);
    return counts;
  };
  const [px, py] = [pairs(x), pairs(y)];
  let shared = 0;
  for (const [pair, n] of px) shared += Math.min(n, py.get(pair) ?? 0);
  const total = [...x].length + [...y].length - 2;
  return total > 0 ? (2 * shared) / total : 0;
}

/** Below this, a changed line is taken as a different one (removed, and a new one added). */
const SAME_LINE = 0.3;

/**
 * Pair a panel's lines with the script's: the most alike first (a line and
 * the script line it most reads like), whatever order the balloons stand in
 * now; between equally alike ones, the nearest in order.
 */
function pairLines(old: readonly Line[], said: readonly ScriptLine[], speakerOf: (line: ScriptLine) => string | undefined): [number, number][] {
  const candidates: [number, number, number][] = [];
  old.forEach((line, i) =>
    said.forEach((s, j) => {
      const alike = likeness(line.text, s.text);
      if (alike >= SAME_LINE) candidates.push([alike + (line.speaker === speakerOf(s) ? 0.2 : 0) - 0.001 * Math.abs(i - j), i, j]);
    }),
  );
  candidates.sort((a, b) => b[0] - a[0]);
  const [usedOld, usedNew] = [new Set<number>(), new Set<number>()];
  const pairs: [number, number][] = [];
  for (const [, i, j] of candidates) {
    if (usedOld.has(i) || usedNew.has(j)) continue;
    usedOld.add(i);
    usedNew.add(j);
    pairs.push([i, j]);
  }
  return pairs;
}

/** New text for a line, broken again to fit its panel, its top right (where reading starts) kept where it was. */
function retext(project: Project, line: Line, text: string, panel: Panel | undefined): void {
  const [, top, right] = line.box;
  line.text = text;
  const box = placingBox(project, panel);
  wrapToFit(line, box[3] - box[1] - 6);
  fitLine(line);
  moveLine(line, right - line.box[2], top - line.box[1]);
}

/** Bring a page's dialogue in line with the script's panels (see `ScriptImportOptions.update`). */
function updatePage(project: Project, page: Page, used: ScriptPanel[], speakers: Map<string, string>, report: ScriptImportReport): void {
  sortLines(page);
  const panels = [...page.panels].sort((a, b) => a.order - b.order);
  // Script panels past the page's last panel go into its last one, as when first taken in.
  const wanted = new Map<Panel | undefined, ScriptLine[]>();
  used.forEach((scriptPanel, k) => {
    const panel = panels[Math.min(k, panels.length - 1)];
    if (panel && scriptPanel.notes.length) panel.note = scriptPanel.notes.join("\n");
    wanted.set(panel, [...(wanted.get(panel) ?? []), ...scriptPanel.lines]);
  });
  const speakerOf = (said: ScriptLine) => (said.speaker ? speakers.get(said.speaker) : undefined);
  const gone = new Set<Line>();
  for (const panel of panels.length ? panels : [undefined]) {
    const said = wanted.get(panel) ?? [];
    const old = page.lines.filter((line) => (panel ? line.panel === panel.id : !line.panel));
    const pairs = pairLines(old, said, speakerOf);
    const pairedOld = new Map(pairs.map(([i, j]) => [i, j]));
    const pairedNew = new Map(pairs.map(([i, j]) => [j, i]));
    old.forEach((line, i) => {
      const j = pairedOld.get(i);
      if (j === undefined) {
        gone.add(line);
        return;
      }
      const s = said[j];
      let changed = false;
      if (bare(line.text) !== bare(s.text)) {
        retext(project, line, s.text || "…", panel);
        changed = true;
      }
      const speaker = speakerOf(s);
      if ((line.speaker ?? undefined) !== speaker) {
        if (speaker) line.speaker = speaker;
        else delete line.speaker;
        changed = true;
      }
      if (line.kind !== s.kind) {
        setLineKind(project, line, s.kind);
        changed = true;
      }
      if (s.shape && line.balloonShape !== s.shape) {
        line.balloonShape = s.shape;
        fitLine(line);
        changed = true;
      }
      if (changed) report.changed++;
      else report.kept++;
    });
    // New lines: just after the line before them in the script (to its left, the next to be read), or at the panel's top right.
    let previous: Line | undefined;
    said.forEach((s, j) => {
      const i = pairedNew.get(j);
      if (i !== undefined) {
        previous = old[i];
        return;
      }
      const line = addLine(project, page, [0, 0], s.text || "…", s.kind);
      const speaker = speakerOf(s);
      if (speaker) line.speaker = speaker;
      if (s.shape) line.balloonShape = s.shape;
      const box = placingBox(project, panel);
      wrapToFit(line, box[3] - box[1] - 6);
      fitLine(line);
      const [right, top] = previous ? [balloonExtent(previous)[0] - 2, balloonExtent(previous)[1]] : [box[2] - 3, box[1] + 3];
      const [x0, y0, x1] = balloonExtent(line);
      moveLine(line, Math.max(box[0] + 3 - x0, right - x1), top - y0);
      if (panel) line.panel = panel.id;
      previous = line;
      report.added++;
    });
    report.lines += said.length;
  }
  if (gone.size) {
    page.lines = page.lines.filter((line) => !gone.has(line));
    for (const line of page.lines) if (line.linkTo && !page.lines.some((other) => other.id === line.linkTo)) delete line.linkTo;
    report.removed += gone.size;
  }
  assignPanels(page);
  sortLines(page);
}

/** Put a script onto the name. */
export function applyScript(project: Project, doc: ScriptDoc, options: ScriptImportOptions): ScriptImportReport {
  const report: ScriptImportReport = { pages: 0, panels: 0, lines: 0, characters: [], scenes: 0, replacedScenes: 0, insertedPages: 0, leftPages: [], kept: 0, changed: 0, added: 0, removed: 0 };
  if (doc.title && (!project.title || project.title === "新しいネーム")) project.title = doc.title;
  // Speakers by name; new names become characters.
  const speakers = new Map(project.characters.map((character) => [character.name, character.id]));
  for (const page of doc.pages) {
    for (const panel of page.panels) {
      for (const line of panel.lines) {
        if (line.speaker && !speakers.has(line.speaker)) {
          speakers.set(line.speaker, addCharacter(project, line.speaker).id);
          report.characters.push(line.speaker);
        }
      }
    }
  }
  const sceneStarts: { title: string; first: string; last: string }[] = [];
  // Taken in again: each script page goes to the page whose dialogue it reads like, so pages added or
  // taken out in the script (and pages after them) still find theirs; a new one is put in where it falls.
  const targets = options.update ? matchPages(project, doc, options.startPage) : null;
  let previous = options.startPage - 1;
  const reached = new Set<string>();
  doc.pages.forEach((scriptPage, i) => {
    let page: Page;
    if (targets) {
      const target = targets[i];
      page = target ?? insertPage(project, previous + 1);
      if (!target) report.insertedPages++;
      reached.add(page.id);
      previous = pageIndex(project, page.id);
    } else page = project.pages[options.startPage + i] ?? insertPage(project, project.pages.length);
    report.pages++;
    // Taken in again: notes already in the memo are not added twice.
    const fresh = scriptPage.notes.filter((note) => !page.memo.includes(note));
    if (fresh.length) page.memo = [page.memo, ...fresh].filter(Boolean).join("\n");
    // The script's panels up to the last with something in it (an empty one between keeps its place).
    const filled = scriptPage.panels.map((panel) => panel.lines.length > 0 || panel.notes.length > 0);
    const used = scriptPage.panels.slice(0, filled.lastIndexOf(true) + 1);
    if (options.update && page.lines.length) {
      updatePage(project, page, used, speakers, report);
      if (scriptPage.scene) sceneStarts.push({ title: scriptPage.scene, first: page.id, last: page.id });
      else if (sceneStarts.length) sceneStarts[sceneStarts.length - 1].last = page.id;
      return;
    }
    if (!page.panels.length && options.makePanels && used.length) {
      const pattern = scriptPage.pattern ?? options.pattern;
      if (pattern) {
        page.panels = patternPanels(project, pattern, DEFAULT_GUTTERS, used.length);
        orderPanels(page, project.binding);
      } else {
        for (const box of panelBoxes(basicBox(project.pageFormat), used.length)) addPanel(project, page, rectShape(box));
      }
      report.panels += page.panels.length;
    }
    const panels = [...page.panels].sort((a, b) => a.order - b.order);
    used.forEach((scriptPanel, k) => {
      // More script panels than panels: the rest go into the last panel.
      const panel = panels[Math.min(k, panels.length - 1)];
      if (panel && scriptPanel.notes.length) panel.note = [panel.note, ...scriptPanel.notes].filter(Boolean).join("\n");
      placeLines(project, page, panel, scriptPanel.lines, speakers);
      report.lines += scriptPanel.lines.length;
    });
    assignPanels(page);
    sortLines(page);
    if (scriptPage.scene) sceneStarts.push({ title: scriptPage.scene, first: page.id, last: page.id });
    else if (sceneStarts.length) sceneStarts[sceneStarts.length - 1].last = page.id;
  });
  // A scene takes the place of those it overlaps (a plot's, taken in before).
  if (targets) {
    // Pages between the first and last the script went to that it did not: left as they were, and said so.
    const indices = [...reached].map((id) => pageIndex(project, id));
    const [from, to] = [Math.min(...indices), Math.max(...indices)];
    project.pages.forEach((page, i) => {
      if (i > from && i < to && !reached.has(page.id) && page.lines.length) report.leftPages.push(i + 1);
    });
  }
  for (const scene of sceneStarts) {
    report.replacedScenes += putScene(project, pageIndex(project, scene.first), pageIndex(project, scene.last), scene.title).replaced;
  }
  report.scenes = sceneStarts.length;
  return report;
}

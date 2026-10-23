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
// List markers (- * + 1.), quotes (>) and **bold** are ignored.
import { balloonExtent } from "./balloon";
import {
  addCharacter,
  addLine,
  addPanel,
  addScene,
  assignPanels,
  basicBox,
  bounds,
  DEFAULT_GUTTERS,
  insertPage,
  moveLine,
  rectShape,
  sortLines,
  type BoxMm,
  type LineKind,
  type Page,
  type Project,
} from "./project";

export interface ScriptLine {
  speaker?: string;
  kind: LineKind;
  text: string;
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
  // 名前「…」 / 名前『…』 / 「…」
  let match = /^([^「『（(：:\s]{0,20})\s*[「『]([\s\S]*?)[」』]?$/.exec(text);
  if (match) {
    const name = match[1].trim();
    return { ...(name ? { speaker: name } : {}), kind: "speech", text: match[2].trim() };
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
  const newPanel = () => {
    // The page first: starting one clears the current panel.
    const target = currentPage();
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
        if (!PAGE_HEADING.test(text) && text) page!.notes.push(text);
      } else {
        newPanel();
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
      const rest = plain(line.slice(1)).replace(/^\d+\s*ページ/, "").trim();
      if (rest) page!.notes.push(rest);
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      if (!pageHeadings) newPage();
      continue;
    }
    const bare = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, "");
    const panelMark = /^(?:[［[]\s*(\d+)\s*[］\]]|【\s*コマ\s*\d*\s*】|コマ\s*\d+(?:\s|$|[:：]))\s*(.*)$/.exec(bare);
    if (panelMark) {
      newPanel();
      const rest = plain(panelMark[2] ?? "");
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
}

export interface ScriptImportReport {
  pages: number;
  panels: number;
  lines: number;
  characters: string[];
  scenes: number;
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

/** Deal the lines of a panel out over its box: right to left, wrapping down. */
function placeLines(project: Project, page: Page, box: BoxMm, lines: ScriptLine[], speakers: Map<string, string>): void {
  const margin = 3;
  const gap = 2;
  let right = box[2] - margin;
  let top = box[1] + margin;
  let rowHeight = 0;
  for (const said of lines) {
    const line = addLine(project, page, [0, 0], said.text || "…", said.kind);
    if (said.speaker) line.speaker = speakers.get(said.speaker);
    // Room for the balloon around the text, not just the text.
    const [lx0, ly0, lx1, ly1] = balloonExtent(line);
    const [w, h] = [lx1 - lx0, ly1 - ly0];
    if (right - w < box[0] + margin && rowHeight > 0) {
      right = box[2] - margin;
      top += rowHeight + gap;
      rowHeight = 0;
    }
    // A full panel: lines pile up at its bottom, still inside it.
    const y = Math.max(box[1], Math.min(top, box[3] - margin - h));
    moveLine(line, right - w - lx0, y - ly0);
    right -= w + gap;
    rowHeight = Math.max(rowHeight, h);
  }
}

/** Put a script onto the name. */
export function applyScript(project: Project, doc: ScriptDoc, options: ScriptImportOptions): ScriptImportReport {
  const report: ScriptImportReport = { pages: 0, panels: 0, lines: 0, characters: [], scenes: 0 };
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
  doc.pages.forEach((scriptPage, i) => {
    const index = options.startPage + i;
    const page = project.pages[index] ?? insertPage(project, project.pages.length);
    report.pages++;
    if (scriptPage.notes.length) page.memo = [page.memo, ...scriptPage.notes].filter(Boolean).join("\n");
    const used = scriptPage.panels.filter((panel) => panel.lines.length || panel.notes.length);
    if (!page.panels.length && options.makePanels && used.length) {
      for (const box of panelBoxes(basicBox(project.pageFormat), used.length)) addPanel(project, page, rectShape(box));
      report.panels += used.length;
    }
    const panels = [...page.panels].sort((a, b) => a.order - b.order);
    const frame = basicBox(project.pageFormat);
    used.forEach((scriptPanel, k) => {
      // More script panels than panels: the rest go into the last panel.
      const panel = panels[Math.min(k, panels.length - 1)];
      if (panel && scriptPanel.notes.length) panel.note = [panel.note, ...scriptPanel.notes].filter(Boolean).join("\n");
      const [px0, py0, px1, py1] = panel ? bounds(panel.shape) : frame;
      placeLines(project, page, [px0, py0, px1, py1], scriptPanel.lines, speakers);
      report.lines += scriptPanel.lines.length;
    });
    assignPanels(page);
    sortLines(page);
    if (scriptPage.scene) sceneStarts.push({ title: scriptPage.scene, first: page.id, last: page.id });
    else if (sceneStarts.length) sceneStarts[sceneStarts.length - 1].last = page.id;
  });
  for (const scene of sceneStarts) addScene(project, scene.first, scene.last, scene.title);
  report.scenes = sceneStarts.length;
  return report;
}

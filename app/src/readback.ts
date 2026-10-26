// Taking dialogue changed in CSP back into the name: once the pen work has
// started, the words are often fixed there (a typo, a line cut short, one
// added). What the last export wrote into each page tells CSP's changes from
// the name's, so only those go back; the name's own changes are left for
// セリフだけ反映 to bring into the pages.

import { addLine, fitLine, moveLine, setLineText } from "./dialogue";
import { boxCenter, insidePolygon } from "./geometry";
import type { BoxMm, Line, Page, Project } from "./model";
import { likeness } from "./scriptimport";

/** A dialogue text on a page as CSP has it now, its box in mm on its page. */
export interface ReadText {
  text: string;
  /** Index of the name's page it is on. */
  page: number;
  box: BoxMm | null;
}

/** One page file of the export, read back. */
export interface ReadUnit {
  /** Indexes of the name's pages in it (two for a 見開き page). */
  pages: number[];
  path: string;
  /** False when the file is not there. */
  found: boolean;
  /** What the last export or update wrote there; null when not recorded. */
  written: string[] | null;
  texts: ReadText[];
}

export interface TakeBack {
  /** Lines retyped in CSP: the name's line takes CSP's words. */
  retyped: { page: number; line: string; from: string; to: string }[];
  /** Texts added in CSP: new lines where CSP has them. */
  added: ReadText[];
  /** Texts deleted in CSP: the name's line goes too. */
  removed: { page: number; line: string; text: string }[];
  /** Changed in CSP and in the name since: the name's stands (CSP's is hidden as 「（旧）」 by the next セリフだけ反映). */
  conflicts: { page: number; csp: string }[];
  /** Page files with nothing recorded (written by an older version): left alone. */
  unrecorded: number[][];
  /** Page files not there. */
  missing: number[][];
  /** Page files read, to record as the name's once taken back. */
  paths: string[];
}

/** A text as compared, like the CSP side: line breaks as `\n`, no space around. */
export function textKey(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Remove one `key` from `keys`; whether it was there. */
function take(keys: string[], key: string): boolean {
  const index = keys.indexOf(key);
  if (index < 0) return false;
  keys.splice(index, 1);
  return true;
}

function overlap(a: BoxMm, b: BoxMm): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])) || 0;
}

/** Below this a text gone from CSP and one new there are taken as two lines, not one retyped. */
const SAME_LINE = 0.3;

/** What reading `units` back would change in the name (nothing is changed yet). */
export function planTakeBack(project: Project, units: readonly ReadUnit[]): TakeBack {
  const plan: TakeBack = { retyped: [], added: [], removed: [], conflicts: [], unrecorded: [], missing: [], paths: [] };
  for (const unit of units) {
    if (!unit.found) {
      plan.missing.push(unit.pages);
      continue;
    }
    if (!unit.written) {
      plan.unrecorded.push(unit.pages);
      continue;
    }
    plan.paths.push(unit.path);
    // CSP's changes: texts there now that were not written, and written ones gone.
    const gone = unit.written.map(textKey);
    const typed: ReadText[] = [];
    for (const text of unit.texts) if (!take(gone, textKey(text.text))) typed.push(text);
    if (!gone.length && !typed.length) continue;
    // The name's lines on these pages, and what of them is as written.
    const lines = unit.pages.flatMap((page) => project.pages[page].lines.filter((line) => line.text.trim()).map((line) => ({ page, line })));
    const asWritten = unit.written.map(textKey);
    const used = new Set<Line>();
    const lineFor = (key: string) => lines.find(({ line }) => !used.has(line) && textKey(line.text) === key);
    // Lines the name has that were not written (added or changed in the name since).
    const ownNew = lines.filter(({ line }) => !take(asWritten, textKey(line.text))).map(({ line }) => textKey(line.text));
    // A text gone and one typed, alike or in the same place: retyped.
    const pairs: { gone: number; typed: number; score: number }[] = [];
    gone.forEach((old, g) => {
      const where = lineFor(old)?.line.box;
      typed.forEach((text, t) => {
        const near = where && text.box ? overlap(where, text.box) : 0;
        const score = likeness(old, text.text) + (near > 0.3 ? 0.5 : 0);
        if (score >= SAME_LINE) pairs.push({ gone: g, typed: t, score });
      });
    });
    pairs.sort((a, b) => b.score - a.score);
    const [paired, pairedTyped] = [new Set<number>(), new Set<number>()];
    for (const pair of pairs) {
      if (paired.has(pair.gone) || pairedTyped.has(pair.typed)) continue;
      paired.add(pair.gone);
      pairedTyped.add(pair.typed);
      const [old, text] = [gone[pair.gone], typed[pair.typed]];
      // The name typed the same already: nothing to take back.
      if (take(ownNew, textKey(text.text))) continue;
      const found = lineFor(old);
      if (found) {
        used.add(found.line);
        plan.retyped.push({ page: found.page, line: found.line.id, from: found.line.text, to: textKey(text.text) });
      } else {
        plan.conflicts.push({ page: text.page, csp: textKey(text.text) });
      }
    }
    typed.forEach((text, t) => {
      if (pairedTyped.has(t) || take(ownNew, textKey(text.text))) return;
      plan.added.push({ ...text, text: textKey(text.text) });
    });
    gone.forEach((old, g) => {
      if (paired.has(g)) return;
      const found = lineFor(old);
      if (!found) return;
      used.add(found.line);
      plan.removed.push({ page: found.page, line: found.line.id, text: found.line.text });
    });
  }
  return plan;
}

/** Make the changes `plan` lists in the name. */
export function applyTakeBack(project: Project, plan: TakeBack): void {
  const find = (page: number, id: string) => project.pages[page].lines.find((line) => line.id === id);
  for (const { page, line: id, to } of plan.retyped) {
    const line = find(page, id);
    if (line) setLineText(line, to);
  }
  for (const { page, line: id } of plan.removed) {
    const at = project.pages[page];
    at.lines = at.lines.filter((line) => line.id !== id);
  }
  for (const text of plan.added) {
    const page: Page = project.pages[text.page];
    const box = text.box ?? [0, 0, 0, 0];
    const line = addLine(project, page, boxCenter(box), text.text);
    fitLine(line);
    // Its text's top right where CSP has it (vertical text reads from there).
    if (text.box) moveLine(line, box[2] - line.box[2], box[1] - line.box[1]);
    const panel = page.panels.find((p) => insidePolygon(p.shape, boxCenter(line.box)));
    if (panel) line.panel = panel.id;
  }
}

/** What taking back would do, in a few lines (nothing to do: an empty list). */
export function takeBackSummary(plan: TakeBack): string[] {
  const lines: string[] = [];
  const where = (pages: number[]) => pages.map((page) => page + 1).join("–");
  if (plan.retyped.length) lines.push(`CSP で直したセリフ ${plan.retyped.length}: ${plan.retyped.map((r) => `${r.page + 1}p「${short(r.from)}」→「${short(r.to)}」`).join("、")}`);
  if (plan.added.length) lines.push(`CSP で足したセリフ ${plan.added.length}: ${plan.added.map((a) => `${a.page + 1}p「${short(a.text)}」`).join("、")}`);
  if (plan.removed.length) lines.push(`CSP で消したセリフ ${plan.removed.length}: ${plan.removed.map((r) => `${r.page + 1}p「${short(r.text)}」`).join("、")}`);
  if (plan.conflicts.length) lines.push(`ネームでも変えていたので、ネームのままにするもの ${plan.conflicts.length}: ${plan.conflicts.map((c) => `${c.page + 1}p CSP「${short(c.csp)}」`).join("、")}`);
  if (plan.unrecorded.length) lines.push(`書き出したときの記録がないページ（前のバージョンで書き出したもの）は読み戻しません: ${plan.unrecorded.map(where).join("、")} ページ`);
  if (plan.missing.length) lines.push(`ページのファイルがありません: ${plan.missing.map(where).join("、")} ページ`);
  return lines;
}

function short(text: string): string {
  const flat = text.replace(/\n/g, "");
  return [...flat].length > 12 ? `${[...flat].slice(0, 12).join("")}…` : flat;
}

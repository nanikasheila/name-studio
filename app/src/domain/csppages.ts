// The pages of the work (.cmc) changed in CSP: pages added there (taken in
// as new pages of the name, with what was drawn on them), pages deleted
// there (the name's are put on hold, 保留, only when asked), and pages put
// in another order (the name's pages follow it).
//
// What the export (or the last take-back) recorded of the work tells CSP's
// changes from the name's own: pages the name moved since stay where the
// name has them, and nothing goes without being listed.

import type { CspWork, CspWorkPage } from "../generated/ipc";
import type { Project } from "../model/model";
import { holdPages } from "./pageops";
import type { ReadText } from "./readback";

/** A page added in CSP. Its content is planned on a page at the end of the name (`page`), moved to its place last. */
export interface PageAdd {
  ref: string;
  /** Its file in the work, and where it is. */
  file: string;
  path: string;
  /** The page it is while taken back: past the name's pages (see `applyCspPages`). */
  page: number;
  /** What stands for it in `CspPages.order` (and its page's id in the plan). */
  key: string;
  /** The name's page CSP has it after (null: first). */
  after: string | null;
  /** Its dialogue (on `page`), made the name's lines. */
  texts: ReadText[];
}

/** A page deleted in CSP: the name's pages of it go on hold. */
export interface PageHold {
  ref: string;
  file: string;
  pages: string[];
}

/** The pages in CSP's order (the name's pages, and the keys of pages added there). */
export interface PageOrder {
  ref: string;
  order: string[];
  /** The name's pages that move. */
  moved: string[];
}

export interface CspPages {
  added: PageAdd[];
  held: PageHold[];
  /** CSP's order of the pages, to put pages added there in place (and all of them, when `move` is taken). */
  order: string[];
  move: PageOrder | null;
  notes: string[];
}

export function noPages(): CspPages {
  return { added: [], held: [], order: [], move: null, notes: [] };
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Compare the work as CSP has it with what was recorded of it (refs made
 * by `ref`). Pages added are planned past the name's pages, in CSP's order.
 */
export function planCspPages(project: Project, work: CspWork, ref: () => string): CspPages {
  const plan = noPages();
  const inName = new Map(project.pages.map((page, index) => [page.id, index]));
  const ours = (page: CspWorkPage) => page.pageIds.length > 0 && page.pageIds.every((id) => inName.has(id));
  if (!work.recorded) {
    if (work.pages.length)
      plan.notes.push(
        "前のバージョンで書き出した作品なので、CSP でページを足したり消したり並べ替えたりしていても読み戻しません（ネームのページの並びのままです）",
      );
    return plan;
  }
  // Before the last take-back, when the name undid it (none of the pages it made are there).
  const taken = work.taken;
  const baseline = taken?.pageIds.length && !taken.pageIds.some((id) => inName.has(id)) ? taken.pages : work.recorded;
  const before = new Set(baseline.map((page) => page.file));
  const now = new Set(work.pages.map((page) => page.file));
  // A page CSP made a 見開き of (it deletes the first of the two, and makes the second twice as wide).
  const resized = work.pages.filter((page) => page.pageIds.length && page.spread !== page.pageIds.length > 1);
  for (const page of resized)
    plan.notes.push(`「${page.file}」: CSP で見開き・単ページを変えたページは読み戻しません（ネームで見開きにしてください）`);
  const unsure = new Set<string>();
  for (const page of resized) {
    const at = baseline.findIndex((other) => other.file === page.file);
    for (const near of [baseline[at - 1], baseline[at + 1]]) if (near) unsure.add(near.file);
  }
  // Added: in the work now, not before (and not the name's: its pages, if it has any, are gone from the name).
  let first = project.pages.length;
  for (const page of work.pages) {
    if (before.has(page.file) || page.pageIds.some((id) => inName.has(id))) continue;
    if (page.spread) {
      plan.notes.push(`「${page.file}」: CSP で足した見開きのページは読み戻しません`);
      continue;
    }
    plan.added.push({ ref: ref(), file: page.file, path: page.path, page: first++, key: `csp:${page.file}`, after: null, texts: [] });
  }
  // Deleted: recorded before, gone from the work, still in the name.
  for (const page of baseline) {
    if (now.has(page.file) || unsure.has(page.file) || !ours(page)) continue;
    plan.held.push({ ref: ref(), file: page.file, pages: page.pageIds });
  }
  // CSP's order: the name's pages and the ones added.
  const keyOf = new Map(plan.added.map((add) => [add.file, add.key]));
  plan.order = work.pages.flatMap((page) => (keyOf.has(page.file) ? [keyOf.get(page.file)!] : ours(page) ? page.pageIds : []));
  let last: string | null = null;
  for (const key of plan.order) {
    const add = plan.added.find((a) => a.key === key);
    if (add) add.after = last;
    else last = key;
  }
  // Moved: the pages both have, in CSP's order and the name's, and as recorded.
  const common = (list: readonly CspWorkPage[]) => list.filter((page) => ours(page) && before.has(page.file) && now.has(page.file));
  const inCsp = common(work.pages).flatMap((page) => page.pageIds);
  const recorded = common(baseline).flatMap((page) => page.pageIds);
  const inNameOrder = [...inCsp].sort((a, b) => inName.get(a)! - inName.get(b)!);
  if (!same(inCsp, inNameOrder)) {
    if (same(recorded, inNameOrder)) {
      const moved = inCsp.filter((id, index) => inNameOrder[index] !== id);
      plan.move = { ref: ref(), order: plan.order, moved };
    } else if (!same(inCsp, recorded)) {
      plan.notes.push("CSP でもネームでもページの並びを変えていたので、ネームの並びのままです");
    }
  }
  return plan;
}

/**
 * Make the page changes `pages` lists (picked), once the content of the
 * added pages is on the pages at the end of the name: the ones not taken go,
 * the others move to their place, the pages deleted in CSP go on hold, and
 * with `move` the pages take CSP's order. `ids`: each added page's key → its page's id.
 */
export function applyCspPages(
  project: Project,
  pages: CspPages,
  ids: ReadonlyMap<string, string>,
  placeholders: ReadonlySet<string>,
): void {
  project.pages = project.pages.filter((page) => !placeholders.has(page.id));
  const held = pages.held.flatMap((hold) => hold.pages).filter((id) => project.pages.some((page) => page.id === id));
  if (held.length) holdPages(project, held);
  const order = pages.order.map((key) => ids.get(key) ?? key).filter((id) => project.pages.some((page) => page.id === id));
  const added = new Set(pages.added.map((add) => ids.get(add.key)).filter((id): id is string => !!id));
  const byId = new Map(project.pages.map((page) => [page.id, page]));
  let result: string[];
  if (pages.move) {
    // CSP's order; the name's pages it does not have stay after the page they follow in the name.
    result = order.filter((id) => byId.has(id));
    const placed = new Set(result);
    project.pages.forEach((page, index) => {
      if (placed.has(page.id)) return;
      const before = project.pages
        .slice(0, index)
        .reverse()
        .find((other) => placed.has(other.id));
      result.splice(before ? result.indexOf(before.id) + 1 : 0, 0, page.id);
      placed.add(page.id);
    });
  } else {
    // The name's order; each page added in CSP after the page CSP has it after (or before the one it has it before).
    result = project.pages.map((page) => page.id).filter((id) => !added.has(id));
    for (const [index, id] of order.entries()) {
      if (!added.has(id)) continue;
      const prev = order
        .slice(0, index)
        .reverse()
        .find((other) => result.includes(other));
      const next = order.slice(index + 1).find((other) => result.includes(other) && !added.has(other));
      const at = prev ? result.indexOf(prev) + 1 : next ? result.indexOf(next) : result.length;
      result.splice(at, 0, id);
    }
  }
  project.pages = result.map((id) => byId.get(id)!);
}

/** What the page changes are, in a few words. */
export function cspPagesSummary(pages: CspPages): string[] {
  const parts = [
    ...(pages.added.length ? [`CSP で足したページ ${pages.added.length}`] : []),
    ...(pages.held.length ? [`CSP で消したページ ${pages.held.length}`] : []),
    ...(pages.move ? ["ページの並び"] : []),
  ];
  return parts.length ? [parts.join("・")] : [];
}

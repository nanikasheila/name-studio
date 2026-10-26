// 別案 (R6): other versions of a run of pages — a page, a 見開き or a scene —
// made from the pages in use, compared side by side and switched to. An option
// may have a different number of pages (another ページ配分).
import type { AlternativeOption, Alternatives, Page, Project } from "./model";
import { newId, pageIndex } from "./project";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The 別案 set that holds a page in use, if any. */
export function alternativesOf(project: Project, pageId: string): Alternatives | undefined {
  return project.alternatives?.find((set) => set.pageIds.includes(pageId));
}

/** The pages of an option: in the project for the one in use, kept in the option otherwise. */
export function optionPages(project: Project, set: Alternatives, option: AlternativeOption): Page[] {
  if (option.id !== set.active) return option.pages;
  return set.pageIds.map((id) => project.pages.find((page) => page.id === id)).filter((page): page is Page => !!page);
}

/** A copy of pages with new ids throughout (references between them follow). */
export function copyPages(project: Project, pages: Page[]): Page[] {
  const ids = new Map<string, string>();
  const fresh = (old: string, prefix: string) => {
    const id = newId(project, prefix);
    ids.set(old, id);
    return id;
  };
  const spreads = new Map<string, string>();
  const copies = pages.map((page) => {
    const copy = structuredClone(page);
    copy.id = fresh(page.id, "page");
    for (const panel of copy.panels) {
      panel.id = fresh(panel.id, "panel");
      if (panel.spread) {
        if (!spreads.has(panel.spread)) spreads.set(panel.spread, newId(project, "spread"));
        panel.spread = spreads.get(panel.spread);
      }
    }
    for (const line of copy.lines) line.id = fresh(line.id, "line");
    for (const stroke of copy.strokes) stroke.id = fresh(stroke.id, "stroke");
    for (const breakout of copy.breakouts) breakout.id = fresh(breakout.id, "breakout");
    for (const rough of copy.roughs) rough.id = fresh(rough.id, "rough");
    for (const reference of copy.references ?? []) reference.id = fresh(reference.id, "reference");
    for (const sticky of copy.stickies ?? []) sticky.id = fresh(sticky.id, "sticky");
    return copy;
  });
  for (const copy of copies) {
    for (const line of copy.lines) {
      if (line.panel) line.panel = ids.get(line.panel) ?? line.panel;
      if (line.linkTo) line.linkTo = ids.get(line.linkTo) ?? line.linkTo;
    }
  }
  return copies;
}

/**
 * Make another version of pages `first`..`last` (a copy to change) and switch
 * to it; the pages as they were stay as the first option. Pages already in a
 * set get one more option in that set.
 */
export function makeAlternative(project: Project, first: number, last: number): Alternatives | null {
  const pages = project.pages.slice(first, last + 1);
  if (!pages.length) return null;
  const sets = new Set(pages.map((page) => alternativesOf(project, page.id)));
  let set = sets.size === 1 ? [...sets][0] : undefined;
  // Only the same run of pages gets another option; a run that overlaps another set cannot have its own.
  if (set && set.pageIds.length !== pages.length) return null;
  if (!set && sets.size > 1) return null;
  if (!set) {
    set = { id: newId(project, "alt"), pageIds: pages.map((page) => page.id), active: "", options: [] };
    const original: AlternativeOption = { id: newId(project, "option"), name: "案A", pages: [] };
    set.options.push(original);
    set.active = original.id;
    (project.alternatives ??= []).push(set);
  }
  const current = set.options.find((option) => option.id === set!.active)!;
  const option: AlternativeOption = {
    id: newId(project, "option"),
    name: `案${LETTERS[set.options.length] ?? set.options.length + 1}`,
    pages: copyPages(project, optionPages(project, set, current)),
  };
  set.options.push(option);
  useAlternative(project, set.id, option.id);
  return set;
}

/**
 * Switch a set to another option: its pages take the place of the pages in
 * use, which are kept in their option. Scene ends and emotion values on the
 * pages follow by position.
 */
export function useAlternative(project: Project, setId: string, optionId: string): boolean {
  const set = project.alternatives?.find((s) => s.id === setId);
  const next = set?.options.find((option) => option.id === optionId);
  const current = set?.options.find((option) => option.id === set.active);
  if (!set || !next || !current || next === current || !next.pages.length) return false;
  const at = set.pageIds.map((id) => pageIndex(project, id)).filter((index) => index >= 0);
  if (!at.length) return false;
  const position = Math.min(...at);
  const leaving = optionPages(project, set, current);
  project.pages = project.pages.filter((page) => !set.pageIds.includes(page.id));
  const coming = next.pages;
  project.pages.splice(position, 0, ...coming);
  // What pointed at the pages that left now points at the page in the same place.
  const mapped = new Map(leaving.map((page, index) => [page.id, coming[Math.min(index, coming.length - 1)]?.id]));
  for (const scene of project.scenes) {
    scene.firstPage = mapped.get(scene.firstPage) ?? scene.firstPage;
    scene.lastPage = mapped.get(scene.lastPage) ?? scene.lastPage;
  }
  for (const point of project.emotions) point.page = mapped.get(point.page) ?? point.page;
  // Fewer pages: one value per character and page (the later one).
  const seen = new Set<string>();
  project.emotions = project.emotions.reverse().filter((point) => !seen.has(`${point.character} ${point.page}`) && !!seen.add(`${point.character} ${point.page}`)).reverse();
  current.pages = leaving;
  next.pages = [];
  set.pageIds = coming.map((page) => page.id);
  set.active = next.id;
  return true;
}

/** Drop an option that is not in use; a set left with one option goes. */
export function removeAlternative(project: Project, setId: string, optionId: string): boolean {
  const set = project.alternatives?.find((s) => s.id === setId);
  if (!set || set.active === optionId || !set.options.some((option) => option.id === optionId)) return false;
  set.options = set.options.filter((option) => option.id !== optionId);
  if (set.options.length < 2) {
    project.alternatives = project.alternatives!.filter((s) => s !== set);
    if (!project.alternatives.length) delete project.alternatives;
  }
  return true;
}

/** A page added next to a page of a set's option in use becomes part of that option. */
export function joinAlternative(project: Project, pageId: string, besideId: string, after: boolean): void {
  const set = alternativesOf(project, besideId);
  if (!set || set.pageIds.includes(pageId)) return;
  const at = set.pageIds.indexOf(besideId);
  set.pageIds.splice(after ? at + 1 : at, 0, pageId);
}

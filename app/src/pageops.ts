// ページ管理: inserting, duplicating, deleting, holding (保留) and copying
// pages, as the page list does them. Each keeps what refers to pages whole:
// 見開き (a page that joins the next, panels across the gutter), scenes, 別案,
// 保留コマ placed near a page, 保留のページ put back where they were, and the
// emotion values. Functions change the project in place (one undo step each,
// taken by the editor).

import { alternativesOf, copyPages, joinAlternative } from "./alternatives";
import type { Character, HeldPages, Page, Project, StoredImage } from "./model";
import { wantsSpread } from "./panels";
import { insertPage, newId, pageIndex, removePage } from "./project";
import { pageBlock } from "./reorder";

/** Page indexes widened to whole 見開き (a page with its facing page), sorted, each once. */
export function withPartners(project: Project, indexes: readonly number[]): number[] {
  const out = new Set<number>();
  for (const index of indexes) {
    if (index < 0 || index >= project.pages.length) continue;
    const [first, last] = pageBlock(project, index);
    for (let i = first; i <= last; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/** Runs of consecutive indexes (sorted input), as first and last. */
export function runsOf(indexes: readonly number[]): [number, number][] {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const index of sorted) {
    const run = runs[runs.length - 1];
    if (run && run[1] === index - 1) run[1] = index;
    else runs.push([index, index]);
  }
  return runs;
}

/** Where pages go in front of (`after` false) or behind page `index`, not between the halves of a 見開き. */
export function insertionPoint(project: Project, index: number, after: boolean): number {
  if (!project.pages.length) return 0;
  const [first, last] = pageBlock(project, Math.max(0, Math.min(index, project.pages.length - 1)));
  return after ? last + 1 : first;
}

/** A place in front of page `at` that is not between the halves of a 見開き (moved to before the pair). */
function notInSpread(project: Project, at: number): number {
  return at > 0 && at < project.pages.length && wantsSpread(project, at - 1) ? at - 1 : at;
}

/**
 * New pages put beside page `besideId` (in front of it or behind it) belong
 * where it does: to its scene when they land at the scene's end, and to its
 * 別案 when it is in one.
 */
function belongBeside(project: Project, besideId: string, added: readonly Page[], after: boolean): void {
  if (!added.length) return;
  for (const scene of project.scenes) {
    if (after && scene.lastPage === besideId) scene.lastPage = added[added.length - 1].id;
    if (!after && scene.firstPage === besideId) scene.firstPage = added[0].id;
  }
  if (alternativesOf(project, besideId)) {
    if (after) {
      let previous = besideId;
      for (const page of added) {
        joinAlternative(project, page.id, previous, true);
        previous = page.id;
      }
    } else for (const page of added) joinAlternative(project, page.id, besideId, false);
  }
}

/**
 * `count` blank pages in front of (`after` false) or behind page `index`;
 * a 見開き is not split, the pages go before or after the pair. Returns the
 * new pages.
 */
export function insertBlankPages(project: Project, index: number, after: boolean, count = 1): Page[] {
  const n = Math.max(1, Math.min(100, Math.round(count) || 1));
  const at = insertionPoint(project, index, after);
  const beside = project.pages[after ? at - 1 : at];
  const added: Page[] = [];
  for (let i = 0; i < n; i++) added.push(insertPage(project, at + i));
  if (beside) belongBeside(project, beside.id, added, after);
  return added;
}

/**
 * A copy of each page (and its 見開き partner) right behind it, a run of
 * pages copied as a run. The copies have their own ids throughout. Returns
 * the copies in page order.
 */
export function duplicatePages(project: Project, indexes: readonly number[]): Page[] {
  const runs = runsOf(withPartners(project, indexes));
  const all: Page[][] = [];
  // From the back, so that the indexes in front stay where they are.
  for (const [first, last] of [...runs].reverse()) {
    const source = project.pages.slice(first, last + 1);
    const copies = copyPages(project, source);
    // The run ends a 見開き block, so its last page joins nothing outside it.
    delete copies[copies.length - 1].joinNext;
    project.pages.splice(last + 1, 0, ...copies);
    belongBeside(project, source[source.length - 1].id, copies, true);
    all.unshift(copies);
  }
  return all.flat();
}

/** The page before the first index of `gone`, nearest, not in `gone`; none at the front. */
function pageBefore(project: Project, index: number, gone: ReadonlySet<string>): string | undefined {
  for (let i = index - 1; i >= 0; i--) if (!gone.has(project.pages[i].id)) return project.pages[i].id;
  return undefined;
}

function pageAfter(project: Project, index: number, gone: ReadonlySet<string>): string | undefined {
  for (let i = index + 1; i < project.pages.length; i++) if (!gone.has(project.pages[i].id)) return project.pages[i].id;
  return undefined;
}

/**
 * Before pages `gone` leave the name: what stays stops pointing at them. A
 * page that joined one of them as its 見開き joins nothing; a panel across
 * the gutter whose other half leaves becomes an ordinary panel (on either
 * side, unless both halves leave together); 保留コマ meant for them move to
 * the nearest page that stays; 保留のページ that came after one of them
 * come after the page before it.
 */
function letGo(project: Project, gone: ReadonlySet<string>): void {
  const pages = project.pages;
  pages.forEach((page, index) => {
    const next = pages[index + 1];
    if (page.joinNext && next && gone.has(next.id) !== gone.has(page.id)) delete page.joinNext;
    if (page.joinNext && !next) delete page.joinNext;
  });
  // 見開きのコマ: halves split by the change lose their pairing.
  const sides = new Map<string, { going: boolean; staying: boolean }>();
  for (const page of pages) {
    for (const panel of page.panels) {
      if (!panel.spread) continue;
      const side = sides.get(panel.spread) ?? { going: false, staying: false };
      if (gone.has(page.id)) side.going = true;
      else side.staying = true;
      sides.set(panel.spread, side);
    }
  }
  for (const page of pages) {
    for (const panel of page.panels) {
      const side = panel.spread ? sides.get(panel.spread) : undefined;
      if (side?.going && side.staying) delete panel.spread;
    }
  }
  const nearest = (id: string) => {
    const index = pageIndex(project, id);
    return pageBefore(project, index, gone) ?? pageAfter(project, index, gone);
  };
  for (const held of project.held ?? []) {
    if (held.near && gone.has(held.near)) {
      const near = nearest(held.near);
      if (near) held.near = near;
      else {
        delete held.near;
        delete held.at;
      }
    }
    if (held.from && gone.has(held.from)) delete held.from;
  }
  for (const held of project.heldPages ?? []) {
    if (held.after && gone.has(held.after)) {
      const before = pageBefore(project, pageIndex(project, held.after), gone);
      if (before) held.after = before;
      else delete held.after;
    }
  }
}

/** Why pages cannot be taken out, or null when they can. */
export function cannotRemove(project: Project, ids: readonly string[]): string | null {
  const gone = new Set(ids.filter((id) => pageIndex(project, id) >= 0));
  if (!gone.size) return "ページが選ばれていません";
  if (gone.size >= project.pages.length) return "ページは 1 枚は残します";
  return null;
}

/** Delete pages (with what refers only to them); false when they cannot go (see `cannotRemove`). */
export function deletePages(project: Project, ids: readonly string[]): boolean {
  if (cannotRemove(project, ids)) return false;
  const gone = new Set(ids);
  letGo(project, gone);
  for (const id of ids) removePage(project, id);
  return true;
}

/**
 * 保留にする: take pages out of the name, kept whole to put back later. A
 * run of pages is kept together (a 見開き stays a 見開き). Returns what was
 * held, or empty when the pages cannot go (see `cannotRemove`).
 */
export function holdPages(project: Project, ids: readonly string[]): HeldPages[] {
  if (cannotRemove(project, ids)) return [];
  const gone = new Set(ids);
  const indexes = ids.map((id) => pageIndex(project, id)).filter((i) => i >= 0);
  const made: HeldPages[] = runsOf(indexes).map(([first, last]) => {
    const pages = project.pages.slice(first, last + 1);
    const inRun = new Set(pages.map((page) => page.id));
    const emotions = project.emotions.filter((point) => inRun.has(point.page)).map((point) => ({ ...point }));
    const held: HeldPages = { id: newId(project, "heldpages"), pages };
    const after = pageBefore(project, first, gone);
    if (after) held.after = after;
    if (emotions.length) held.emotions = emotions;
    return held;
  });
  letGo(project, gone);
  for (const held of made) delete held.pages[held.pages.length - 1].joinNext;
  for (const id of ids) removePage(project, id);
  (project.heldPages ??= []).push(...made);
  return made;
}

/**
 * Put 保留のページ back in front of page `target` (an index; `pages.length`
 * is the end; a target between the halves of a 見開き goes before the pair),
 * or where they came from when `target` is "back". Returns the pages put back.
 */
export function restoreHeldPages(project: Project, heldId: string, target: number | "back"): Page[] {
  const list = project.heldPages ?? [];
  const held = list.find((h) => h.id === heldId);
  if (!held) return [];
  let at: number;
  if (target === "back") at = held.after ? pageIndex(project, held.after) + 1 : 0;
  else at = Math.max(0, Math.min(target, project.pages.length));
  at = notInSpread(project, at < 0 ? project.pages.length : at);
  project.pages.splice(at, 0, ...held.pages);
  const characters = new Set(project.characters.map((c) => c.id));
  for (const point of held.emotions ?? []) if (characters.has(point.character)) project.emotions.push(point);
  project.heldPages = list.filter((h) => h !== held);
  if (!project.heldPages.length) delete project.heldPages;
  return held.pages;
}

/** Throw 保留のページ away. */
export function dropHeldPages(project: Project, heldId: string): void {
  project.heldPages = (project.heldPages ?? []).filter((h) => h.id !== heldId);
  if (!project.heldPages.length) delete project.heldPages;
}

/** Pages copied (Ctrl+C in the page list), with what they need from their name to be pasted into another. */
export interface PageClip {
  pages: Page[];
  /** The pictures their 資料画像 show. */
  images: StoredImage[];
  /** Who speaks their lines. */
  characters: Character[];
}

/** Copy pages `indexes` (with their 見開き partners) to paste later, here or in another name. */
export function clipPages(project: Project, indexes: readonly number[]): PageClip {
  const pages = withPartners(project, indexes).map((index) => structuredClone(project.pages[index]));
  const imageIds = new Set(pages.flatMap((page) => (page.references ?? []).map((r) => r.image)));
  const speakerIds = new Set(pages.flatMap((page) => page.lines.map((line) => line.speaker).filter((s): s is string => !!s)));
  return {
    pages,
    images: (project.images ?? []).filter((image) => imageIds.has(image.id)).map((image) => ({ ...image })),
    characters: project.characters.filter((c) => speakerIds.has(c.id)).map((c) => ({ ...c })),
  };
}

/**
 * Paste copied pages in front of page `target` (`pages.length`: at the end;
 * not between the halves of a 見開き). Copied from another name, the pictures
 * come along (once), speakers become the character of the same name (or
 * none), and pens and layers this name lacks fall back to its own.
 */
export function pastePages(project: Project, clip: PageClip, target: number): Page[] {
  if (!clip.pages.length) return [];
  const at = notInSpread(project, Math.max(0, Math.min(target, project.pages.length)));
  const copies = copyPages(project, clip.pages);
  // Pictures: the same one already here is used; another gets its own id.
  const images = new Map<string, string>();
  for (const image of clip.images) {
    const same = (project.images ?? []).find((kept) => kept.dataBase64 === image.dataBase64);
    if (same) images.set(image.id, same.id);
    else {
      const id = newId(project, "image");
      project.images = [...(project.images ?? []), { ...image, id }];
      images.set(image.id, id);
    }
  }
  const characters = new Map(project.characters.map((c) => [c.id, c.id]));
  for (const character of clip.characters) {
    if (characters.has(character.id) && project.characters.find((c) => c.id === character.id)?.name === character.name) continue;
    const named = project.characters.find((c) => c.name === character.name);
    if (named) characters.set(character.id, named.id);
    else characters.delete(character.id);
  }
  const brushes = new Set(project.brushes.map((b) => b.id));
  const layers = new Set((project.roughLayers ?? []).map((l) => l.id));
  for (const page of copies) {
    for (const reference of page.references ?? []) reference.image = images.get(reference.image) ?? reference.image;
    if (page.references) {
      const known = new Set((project.images ?? []).map((image) => image.id));
      page.references = page.references.filter((reference) => known.has(reference.image));
      if (!page.references.length) delete page.references;
    }
    for (const line of page.lines) {
      if (!line.speaker) continue;
      const speaker = characters.get(line.speaker);
      if (speaker) line.speaker = speaker;
      else delete line.speaker;
    }
    for (const stroke of page.strokes) {
      if (stroke.brush && !brushes.has(stroke.brush)) delete stroke.brush;
      if (stroke.layer && !layers.has(stroke.layer)) delete stroke.layer;
    }
  }
  delete copies[copies.length - 1].joinNext;
  project.pages.splice(at, 0, ...copies);
  return copies;
}

/** 末尾の空のページ: ids of the pages at the end with nothing on them (but never every page). */
export function trailingEmptyIds(project: Project, isEmpty: (page: Page) => boolean): string[] {
  const ids: string[] = [];
  for (let i = project.pages.length - 1; i > 0 && isEmpty(project.pages[i]); i--) ids.unshift(project.pages[i].id);
  return ids;
}

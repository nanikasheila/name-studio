// 保留の管理: held panels and held pages copied, moved in the list, sent to
// another page and dropped, several at a time, as the page list does for
// pages. Holding and putting back are hold.ts and pageops.ts.
import { copyPages } from "./alternatives";
import { type MoveTo, moveIds } from "./listorder";
import type { HeldPanel, Page, Project } from "../model/model";
import { emptyPage, newId } from "./project";

/** A copy of each held panel (with its own ids throughout) right behind it. */
export function duplicateHeld(project: Project, ids: readonly string[]): HeldPanel[] {
  const held = project.held ?? [];
  const copies: HeldPanel[] = [];
  for (const source of held.filter((h) => ids.includes(h.id))) {
    // The panel with what it holds, copied as a page so every id is new and every link follows.
    const page: Page = {
      ...emptyPage("held"),
      ...structuredClone({ panels: [source.panel], lines: source.lines, strokes: source.strokes, fills: source.fills ?? [], stickies: source.stickies ?? [] }),
    };
    const [copy] = copyPages(project, [page]);
    const made: HeldPanel = { ...structuredClone(source), id: newId(project, "held"), panel: copy.panels[0], lines: copy.lines, strokes: copy.strokes };
    if (source.fills) made.fills = copy.fills;
    if (source.stickies) made.stickies = copy.stickies;
    // A copy is only in the list until it is put somewhere.
    delete made.at;
    copies.push(made);
    held.splice(held.indexOf(source) + 1, 0, made);
  }
  return copies;
}

export function removeHeld(project: Project, ids: readonly string[]): number {
  const before = project.held?.length ?? 0;
  if (project.held) project.held = project.held.filter((h) => !ids.includes(h.id));
  const pagesBefore = project.heldPages?.length ?? 0;
  if (project.heldPages) project.heldPages = project.heldPages.filter((h) => !ids.includes(h.id));
  const gone = before - (project.held?.length ?? 0) + pagesBefore - (project.heldPages?.length ?? 0);
  if (project.held && !project.held.length) delete project.held;
  if (project.heldPages && !project.heldPages.length) delete project.heldPages;
  return gone;
}

/** Held panels and held pages move within their own list. */
export function moveHeld(project: Project, ids: readonly string[], to: MoveTo): boolean {
  let moved = false;
  if (project.held) {
    const next = moveIds(project.held, (h) => h.id, ids, to);
    if (next) (project.held = next), (moved = true);
  }
  if (project.heldPages) {
    const next = moveIds(project.heldPages, (h) => h.id, ids, to);
    if (next) (project.heldPages = next), (moved = true);
  }
  return moved;
}

/** このあたり: the held panels `ids` are meant for page `pageId` (none: not decided); one laid in a 欄外 elsewhere comes back to the list. */
export function setHeldNear(project: Project, ids: readonly string[], pageId: string | undefined): number {
  let count = 0;
  for (const held of project.held ?? []) {
    if (!ids.includes(held.id) || held.near === pageId) continue;
    if (pageId) held.near = pageId;
    else delete held.near;
    delete held.at;
    count++;
  }
  return count;
}

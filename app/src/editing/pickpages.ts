// 範囲選択 over several pages: a 見開き's two pages (or, 連続, any pages on
// the canvas) picked together. The selection keeps one page as its own (the
// transform frame is in its terms); what lies on the others names its page.
// Here: what is picked page by page, how far each page lies from the
// selection's own on the canvas, and what is picked put back as a selection.
import type { Picked } from "../domain/removal";
import { baseBounds, type ItemRef, transformBase, withContents } from "../domain/transform";
import type { BoxMm, Page, Point, Project } from "../model/model";
import type { Slot } from "./layout";

/** What is picked on one page, and how far that page lies from the selection's own on the canvas (mm: a point here is at `p + offset` there). */
export interface PagePart {
  page: Page;
  slot?: Slot;
  items: ItemRef[];
  offset: Point;
}

/** The page a picked thing is on. */
export function pageOfItem(item: ItemRef, pageId: string): string {
  return item.pageId ?? pageId;
}

/** Each thing named with its page (to carry the picks over a change of the selection's own page). */
export function namedItems(items: readonly ItemRef[], pageId: string): ItemRef[] {
  return items.map((item) => ({ kind: item.kind, id: item.id, pageId: pageOfItem(item, pageId) }));
}

/** How far `slot`'s page lies from `own`'s on the canvas (mm). */
export function slotOffset(slot: Slot, own: Slot): Point {
  return [(slot.x - own.x) / own.scale, (slot.y - own.y) / own.scale];
}

/**
 * What is picked (`items`, on `pageId` unless named otherwise) page by page,
 * the selection's own first. A page not on the screen is left out (what is
 * picked is what is shown as picked), but for the selection's own; `contents`:
 * panels with what is drawn in them.
 */
export function pageParts(
  project: Project,
  pageId: string,
  items: readonly ItemRef[],
  slots: readonly Slot[],
  contents?: boolean,
): PagePart[] {
  const ownSlot = slots.find((slot) => slot.page.id === pageId);
  const order = [pageId, ...new Set(items.map((item) => pageOfItem(item, pageId)).filter((id) => id !== pageId))];
  const parts: PagePart[] = [];
  for (const id of order) {
    const page = project.pages.find((p) => p.id === id);
    const slot = slots.find((s) => s.page.id === id);
    if (!page || (id !== pageId && (!slot || !ownSlot))) continue;
    const own = items.filter((item) => pageOfItem(item, pageId) === id).map(({ kind, id }) => ({ kind, id }));
    if (!own.length && id !== pageId) continue;
    parts.push({
      page,
      ...(slot ? { slot } : {}),
      items: contents === undefined ? own : withContents(page, own, contents),
      offset: slot && ownSlot ? slotOffset(slot, ownSlot) : [0, 0],
    });
  }
  return parts;
}

/** The parts' things as one list, those of other pages named with their page. */
export function partItems(parts: readonly PagePart[], pageId: string): ItemRef[] {
  return parts.flatMap(({ page, items }) => (page.id === pageId ? items : items.map((item) => ({ ...item, pageId: page.id }))));
}

/** The box around the parts' things, in the selection's own page's terms (mm). */
export function partsBox(parts: readonly PagePart[]): BoxMm | null {
  let box: BoxMm | null = null;
  for (const { page, items, offset } of parts) {
    const one = baseBounds(transformBase(page, items));
    if (!one) continue;
    const [x0, y0, x1, y1] = [one[0] + offset[0], one[1] + offset[1], one[2] + offset[0], one[3] + offset[1]];
    box = box ? [Math.min(box[0], x0), Math.min(box[1], y0), Math.max(box[2], x1), Math.max(box[3], y1)] : [x0, y0, x1, y1];
  }
  return box;
}

/**
 * Things picked (each named with its page) as a selection: one thing on its
 * own, else a group on `prefer` when something of it lies there (else on the
 * page of the first), the others naming their page.
 */
export function pickedOf(items: readonly ItemRef[], prefer: string): Picked | null {
  if (!items.length) return null;
  const pageId = items.some((item) => pageOfItem(item, prefer) === prefer) ? prefer : pageOfItem(items[0], prefer);
  if (items.length === 1) return { kind: items[0].kind, pageId, id: items[0].id };
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    const key = `${pageOfItem(item, prefer)}:${item.kind}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 1) return { kind: unique[0].kind, pageId, id: unique[0].id };
  return {
    kind: "group",
    pageId,
    id: "group",
    items: unique.map((item) => {
      const on = pageOfItem(item, prefer);
      return on === pageId ? { kind: item.kind, id: item.id } : { kind: item.kind, id: item.id, pageId: on };
    }),
  };
}

/** Whether a selection's things lie on more than one page. */
export function overPages(s: { pageId: string; items?: readonly ItemRef[] }): boolean {
  return !!s.items?.some((item) => pageOfItem(item, s.pageId) !== s.pageId);
}

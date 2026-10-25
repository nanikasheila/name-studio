// Snapshots of a project for undo that share what did not change.
//
// A stroke's point list is never changed in place: every change makes a new
// list (moveStroke, transforms, the eraser). So a snapshot keeps the list
// itself, not a copy, and the points (most of a drawn name) cost nothing to
// remember. Pages are written one by one, and a page that is the same as in
// the snapshot before is that snapshot's page, so the text of unchanged pages
// is kept once too.

/** One piece written as JSON, its point lists (and picture data) taken out, by index. */
export interface Part {
  readonly json: string;
  readonly lists: readonly unknown[][];
}

export interface Snapshot {
  /** Everything but the pages. */
  readonly head: Part;
  readonly pages: readonly Part[];
}

/** In development (and tests) a shared list is frozen, so a change in place fails loudly; not when timing (e2e/perf.mjs). */
const freezing = import.meta.env.DEV && !import.meta.env.VITE_PERF;

function keep(list: unknown[]): void {
  if (!freezing || Object.isFrozen(list)) return;
  for (const item of list) if (Array.isArray(item)) Object.freeze(item);
  Object.freeze(list);
}

function part(value: unknown): Part {
  const lists: unknown[][] = [];
  const json = JSON.stringify(value, (key, v: unknown) => {
    if (key === "points" && Array.isArray(v)) {
      keep(v);
      lists.push(v);
      return lists.length - 1;
    }
    // A picture's data (資料画像) is a long string, never changed: kept by reference too.
    if (key === "dataBase64" && typeof v === "string") {
      lists.push(v as unknown as unknown[]);
      return lists.length - 1;
    }
    return v;
  });
  return { json, lists };
}

/**
 * A page as `part` writes it, much quicker: a page's point lists are only in
 * its strokes, so the strokes are copied with their lists numbered and the
 * rest is written without a replacer looking at every value.
 */
function pagePart(page: Paged["pages"][number]): Part {
  const { strokes } = page as { strokes?: unknown };
  if (!Array.isArray(strokes)) return part(page);
  const lists: unknown[][] = [];
  const numbered = strokes.map((stroke: { points?: unknown }) => {
    if (!Array.isArray(stroke.points)) return stroke;
    keep(stroke.points);
    lists.push(stroke.points);
    return { ...stroke, points: lists.length - 1 };
  });
  return { json: JSON.stringify({ ...(page as object), strokes: numbered }), lists };
}

/** A page back from `pagePart` (or `part`): its strokes get their lists again. */
function revivePage<T>(piece: Part): T {
  const page = JSON.parse(piece.json) as { strokes?: { points?: unknown }[] };
  if (!Array.isArray(page.strokes)) return revive<T>(piece);
  for (const stroke of page.strokes) if (typeof stroke.points === "number") stroke.points = piece.lists[stroke.points];
  return page as T;
}

function sameLists(a: readonly unknown[][], b: readonly unknown[][]): boolean {
  return a.length === b.length && a.every((list, i) => list === b[i]);
}

function samePart(a: Part, b: Part): boolean {
  return a === b || (a.json === b.json && sameLists(a.lists, b.lists));
}

function revive<T>(piece: Part): T {
  return JSON.parse(piece.json, (key, v: unknown) => ((key === "points" || key === "dataBase64") && typeof v === "number" ? piece.lists[v] : v)) as T;
}

interface Paged {
  pages: unknown[];
}

/** Takes snapshots, reusing the pages of the last one that did not change. */
export class Snapshotter<T extends Paged> {
  private last: Snapshot | null = null;

  take(value: T): Snapshot {
    const { pages, ...rest } = value;
    const before = this.last?.pages ?? [];
    const snapshot: Snapshot = {
      head: part(rest),
      pages: pages.map((page, i) => {
        const piece = pagePart(page);
        // Pages added or removed in front shift the rest: look a little to either side.
        for (const j of [i, i - 1, i + 1, i - 2, i + 2]) {
          const old = before[j];
          if (old && samePart(old, piece)) return old;
        }
        return piece;
      }),
    };
    this.last = snapshot;
    return snapshot;
  }

  restore(snapshot: Snapshot): T {
    const value = revive<Omit<T, "pages">>(snapshot.head) as T;
    value.pages = snapshot.pages.map((page) => revivePage(page));
    return value;
  }

  forget(): void {
    this.last = null;
  }
}

let nextListId = 1;
const listIds = new WeakMap<object, number>();

/** A number for a point list (lists are never changed in place, so it names its points). */
export function listId(points: object): number {
  let id = listIds.get(points);
  if (id === undefined) {
    id = nextListId++;
    listIds.set(points, id);
  }
  return id;
}

/** A text that is the same exactly when what `value` holds is (point lists by their number). */
export function fingerprint(value: unknown): string {
  // A page: its lists are only in its strokes (as in `pagePart`).
  const { strokes } = value as { strokes?: unknown };
  if (Array.isArray(strokes) && !("dataBase64" in (value as object))) {
    const numbered = strokes.map((stroke: { points?: unknown }) => (Array.isArray(stroke.points) ? { ...stroke, points: listId(stroke.points) } : stroke));
    return JSON.stringify({ ...(value as object), strokes: numbered });
  }
  return JSON.stringify(value, (key, v: unknown) => {
    if (key === "points" && Array.isArray(v)) return listId(v);
    if (key === "dataBase64" && typeof v === "string") return v.length;
    return v;
  });
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return samePart(a.head, b.head) && a.pages.length === b.pages.length && a.pages.every((page, i) => samePart(page, b.pages[i]));
}

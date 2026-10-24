// Snapshots of a project for undo that share what did not change.
//
// A stroke's point list is never changed in place: every change makes a new
// list (moveStroke, transforms, the eraser). So a snapshot keeps the list
// itself, not a copy, and the points (most of a drawn name) cost nothing to
// remember. Pages are written one by one, and a page that is the same as in
// the snapshot before is that snapshot's page, so the text of unchanged pages
// is kept once too.

/** One piece written as JSON, its point lists taken out (by index). */
export interface Part {
  readonly json: string;
  readonly lists: readonly unknown[][];
}

export interface Snapshot {
  /** Everything but the pages. */
  readonly head: Part;
  readonly pages: readonly Part[];
}

/** In development (and tests) a shared list is frozen, so a change in place fails loudly. */
const freezing = import.meta.env.DEV;

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
    return v;
  });
  return { json, lists };
}

function sameLists(a: readonly unknown[][], b: readonly unknown[][]): boolean {
  return a.length === b.length && a.every((list, i) => list === b[i]);
}

function samePart(a: Part, b: Part): boolean {
  return a === b || (a.json === b.json && sameLists(a.lists, b.lists));
}

function revive<T>(piece: Part): T {
  return JSON.parse(piece.json, (key, v: unknown) => (key === "points" && typeof v === "number" ? piece.lists[v] : v)) as T;
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
        const piece = part(page);
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
    value.pages = snapshot.pages.map((page) => revive(page));
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
  return JSON.stringify(value, (key, v: unknown) => (key === "points" && Array.isArray(v) ? listId(v) : v));
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return samePart(a.head, b.head) && a.pages.length === b.pages.length && a.pages.every((page, i) => samePart(page, b.pages[i]));
}

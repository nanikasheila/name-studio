// Moving picked items of a list (人物, 保留, …) one place earlier or later,
// or to the front or the end, as the page list moves pages: what is picked
// keeps its order among itself.

/** Where picked items go. */
export type MoveTo = -1 | 1 | "first" | "last";

/**
 * The list with the items whose id is in `ids` moved; null when nothing
 * moves (they are already there, or none is in the list). One step: each
 * picked item passes the unpicked item next to it.
 */
export function moveIds<T>(list: readonly T[], idOf: (item: T) => string, ids: Iterable<string>, to: MoveTo): T[] | null {
  const picked = new Set(ids);
  const isPicked = (item: T) => picked.has(idOf(item));
  if (!list.some(isPicked)) return null;
  let next: T[];
  if (to === "first" || to === "last") {
    const chosen = list.filter(isPicked);
    const rest = list.filter((item) => !isPicked(item));
    next = to === "first" ? [...chosen, ...rest] : [...rest, ...chosen];
  } else {
    next = [...list];
    const order = to < 0 ? next.map((_, i) => i) : next.map((_, i) => next.length - 1 - i);
    for (const i of order) {
      const j = i + to;
      if (j < 0 || j >= next.length) continue;
      // A picked item passes an unpicked neighbour; picked ones at the edge stay, and so do those behind them.
      if (isPicked(next[i]) && !isPicked(next[j])) [next[i], next[j]] = [next[j], next[i]];
    }
  }
  return next.every((item, i) => item === list[i]) ? null : next;
}

/** Whether moving the picked items `to` would change anything. */
export function canMove<T>(list: readonly T[], idOf: (item: T) => string, ids: Iterable<string>, to: MoveTo): boolean {
  return moveIds(list, idOf, ids, to) !== null;
}

/** A name not yet among `taken`: "名前", then "名前 2", "名前 3", … */
export function freeName(name: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(name)) return name;
  for (let n = 2; ; n++) if (!names.has(`${name} ${n}`)) return `${name} ${n}`;
}

/** Items `first`..`last` put before item `target` (`list.length`: at the end), as dragging does. */
export function moveRange<T>(list: readonly T[], first: number, last: number, target: number): T[] | null {
  if (first < 0 || last < first || last >= list.length || (target >= first && target <= last + 1)) return null;
  const next = [...list];
  const block = next.splice(first, last - first + 1);
  next.splice(target > last ? target - block.length : target, 0, ...block);
  return next;
}

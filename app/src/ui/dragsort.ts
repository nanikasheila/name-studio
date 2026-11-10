// Reordering by dragging (pages, scenes): pointer events, so a pen works the
// same as a mouse. A press that does not move stays a click.

export interface DragSortOptions {
  /** How the items run: down a list ("y") or along a wrapping row ("x"). */
  axis: "x" | "y";
  /** The items that move with item `index` (first and last, inclusive). */
  block?: (index: number) => [number, number];
  /** Where a drag starts inside an item (the whole item when absent). */
  handle?: (item: HTMLElement) => HTMLElement;
  /** Items `first`..`last` dropped before item `target` (`items.length`: after the last). */
  drop: (first: number, last: number, target: number) => void;
}

const START = 6;

export function dragSort(items: HTMLElement[], options: DragSortOptions): void {
  items.forEach((item, index) => {
    const handle = options.handle?.(item) ?? item;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const [first, last] = options.block?.(index) ?? [index, index];
      const start = { x: event.clientX, y: event.clientY };
      let mark: HTMLDivElement | null = null;
      let target = -1;
      const move = (e: PointerEvent) => {
        if (!mark) {
          if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < START) return;
          mark = document.createElement("div");
          mark.className = `drop-mark ${options.axis}`;
          document.body.append(mark);
          document.body.classList.add("sorting");
          for (let i = first; i <= last; i++) items[i].classList.add("dragging");
        }
        target = targetAt(items, e.clientX, e.clientY, options.axis);
        place(mark, items, target, options.axis);
      };
      const end = (e: PointerEvent) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        if (!mark) return;
        mark.remove();
        document.body.classList.remove("sorting");
        for (let i = first; i <= last; i++) items[i].classList.remove("dragging");
        // The click that follows the release is part of the drag.
        const swallow = (click: Event) => click.stopPropagation();
        item.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => item.removeEventListener("click", swallow, { capture: true }), 0);
        if (e.type === "pointerup" && target >= 0) options.drop(first, last, target);
      };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Without capture the drag still works while the pointer stays over the item.
      }
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });
  });
}

/** The gap the pointer is over: before item i, or `items.length` after the last. */
export function targetAt(items: HTMLElement[], x: number, y: number, axis: "x" | "y"): number {
  let best = items.length;
  let bestDistance = Infinity;
  items.forEach((item, index) => {
    const box = item.getBoundingClientRect();
    // Rows of a wrapping grid: only items on the pointer's row count.
    if (axis === "x" && (y < box.top || y > box.bottom)) return;
    const middle = axis === "y" ? (box.top + box.bottom) / 2 : (box.left + box.right) / 2;
    const at = axis === "y" ? y : x;
    const distance = Math.abs(at - middle);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = at < middle ? index : index + 1;
    }
  });
  if (bestDistance === Infinity && items.length) {
    // Off every row: above the first or below the last.
    const top = items[0].getBoundingClientRect().top;
    return y < top ? 0 : items.length;
  }
  return best;
}

function place(mark: HTMLDivElement, items: HTMLElement[], target: number, axis: "x" | "y"): void {
  const after = target >= items.length;
  const box = items[after ? items.length - 1 : target]?.getBoundingClientRect();
  if (!box) return;
  if (axis === "y") {
    Object.assign(mark.style, { left: `${box.left}px`, width: `${box.width}px`, top: `${(after ? box.bottom : box.top) - 1}px`, height: "" });
  } else {
    Object.assign(mark.style, { top: `${box.top}px`, height: `${box.height}px`, left: `${(after ? box.right : box.left) - 2}px`, width: "" });
  }
}

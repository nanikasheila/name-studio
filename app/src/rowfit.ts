// A row of switches that never scrolls sideways: as it gets narrower (or holds
// more), it steps through its narrower looks until all of it is in one row. The
// steps are its `data-fit` values, styled in styles.css (the names give way to
// icons, then the strip's buttons take a row of their own); past the last one,
// what is left wraps.

/** Keeps `row` in one row where it can; `steps` is how many narrower looks it has. */
export function fitRow(row: HTMLElement, steps: number): void {
  let queued = false;
  const fit = (): void => {
    queued = false;
    let step = 0;
    for (; step < steps; step++) {
      row.dataset.fit = String(step);
      if (oneRow(row)) break;
    }
    row.dataset.fit = String(step);
  };
  const later = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(fit);
  };
  new ResizeObserver(later).observe(row);
  // What it holds changes too: 連続's rows, the strip's buttons for the lanes shown, 指示.
  new MutationObserver(later).observe(row, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
  fit();
}

/** Whether the row's items share one line (each overlaps all the others from top to bottom). */
function oneRow(row: HTMLElement): boolean {
  const items = [...row.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.offsetParent !== null);
  const top = Math.max(...items.map((item) => item.offsetTop));
  return items.every((item) => item.offsetTop + item.offsetHeight > top);
}

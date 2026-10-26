// Reading order on a page: panels by rows from the binding side, each line of
// dialogue in the panel it is in, and the lines in the order they are read.

import { bounds, boxCenter, insidePolygon } from "./geometry";
import type { Binding, Line, Page, Panel } from "./model";

/**
 * Reading order of panels in a right-bound book (same rule as the Rust
 * import): rows top to bottom, a panel starts a new row when its top is below
 * the current row's middle; right to left inside a row.
 */
export function orderPanels(page: Page, binding: Binding = "right"): void {
  const sorted = [...page.panels].sort((a, b) => bounds(a.shape)[1] - bounds(b.shape)[1]);
  const rows = new Map<Panel, number>();
  let row = 0;
  let rowMiddle = -Infinity;
  sorted.forEach((panel, index) => {
    const [, y0, , y1] = bounds(panel.shape);
    if (index > 0 && y0 >= rowMiddle) row++;
    if (index === 0 || y0 >= rowMiddle) rowMiddle = (y0 + y1) / 2;
    rows.set(panel, row);
  });
  const side = (panel: Panel) => (binding === "right" ? -bounds(panel.shape)[2] : bounds(panel.shape)[0]);
  sorted.sort((a, b) => rows.get(a)! - rows.get(b)! || side(a) - side(b));
  sorted.forEach((panel, index) => (panel.order = index + 1));
  page.panels = sorted;
}

/** Give each line the panel its centre is in. */
export function assignPanels(page: Page): void {
  // A panel on top (an inset, はめ込み) before the one under it, then reading order.
  const panels = [...page.panels].sort((a, b) => (b.z ?? 0) - (a.z ?? 0) || a.order - b.order);
  for (const line of page.lines) {
    const center = boxCenter(line.box);
    const panel = panels.find((p) => insidePolygon(p.shape, center));
    if (panel) line.panel = panel.id;
    else delete line.panel;
  }
}

/**
 * Reading order: by panel, then from the top right towards the bottom left
 * (manga, right binding) or from the top left towards the bottom right (left binding).
 */
export function sortLines(page: Page, binding: Binding = "right"): void {
  const order = new Map(page.panels.map((panel) => [panel.id, panel.order]));
  const key = (line: Line) => {
    const [cx, cy] = boxCenter(line.box);
    return { panel: line.panel ? order.get(line.panel) ?? Infinity : Infinity, diagonal: binding === "right" ? cy - cx : cy + cx };
  };
  page.lines.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka.panel - kb.panel || ka.diagonal - kb.diagonal;
  });
}

// Small pictures that say at a glance what words would take a line to say:
// a page as the block diagram of its panels, for the page list.

import { trimBox, type Page, type Project } from "./project";

const SVG = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

/** Characters of dialogue in each panel of `page` (lines not in a panel are left out). */
export function textByPanel(page: Page): Map<string, number> {
  const amounts = new Map<string, number>();
  for (const line of page.lines) {
    if (!line.panel) continue;
    amounts.set(line.panel, (amounts.get(line.panel) ?? 0) + [...line.text.replace(/\s/g, "")].length);
  }
  return amounts;
}

/** How dark a panel is drawn for `chars` characters: none 0, a full panel (60 or more) 1. */
export function textShade(chars: number): number {
  return Math.min(1, chars / 60);
}

/**
 * The page's trim with its panels as blocks, darker the more is said in them;
 * stickies as yellow squares.
 */
export function pageGlyph(project: Project, page: Page, width = 34): SVGSVGElement {
  const [x0, y0, x1, y1] = trimBox(project.pageFormat);
  const height = Math.round((width * (y1 - y0)) / (x1 - x0));
  const root = svg("svg", { class: "page-glyph", viewBox: `${x0} ${y0} ${x1 - x0} ${y1 - y0}`, width, height, "aria-hidden": "true" });
  root.append(svg("rect", { class: "sheet", x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
  const amounts = textByPanel(page);
  for (const panel of page.panels) {
    const points = panel.shape.map(([x, y]) => `${x},${y}`).join(" ");
    const shade = textShade(amounts.get(panel.id) ?? 0);
    root.append(svg("polygon", { class: "block", points, "fill-opacity": (0.12 + shade * 0.6).toFixed(2) }));
  }
  for (const sticky of page.stickies ?? []) {
    const [x, y] = sticky.at;
    root.append(svg("rect", { class: "sticky", x: Math.min(Math.max(x, x0), x1 - 18), y: Math.min(Math.max(y, y0), y1 - 18), width: 18, height: 18 }));
  }
  return root;
}

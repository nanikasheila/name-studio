// 付箋: notes stuck on a page, alone or linked to a panel or a line of dialogue.

import { bounds } from "./geometry";
import type { BoxMm, Page, Point, Project, Sticky, StickyColor, StickyLink } from "./model";
import { newId } from "./project";

export const STICKY_COLORS: Record<StickyColor, { label: string; fill: string }> = {
  yellow: { label: "黄", fill: "#fff3a8" },
  pink: { label: "桃", fill: "#ffd3e0" },
  blue: { label: "青", fill: "#cfe6ff" },
  green: { label: "緑", fill: "#d4f2cf" },
};

/** Width of a sticky note and the size of its text, in mm on the page. */
export const STICKY_WIDTH_MM = 64;
export const STICKY_TEXT_MM = 6;

/** Rows a long sticky shows on the page; selected or under the pointer it opens to all of them. */
export const STICKY_FOLDED_ROWS = 4;

/** The rows a sticky's text takes (wrapped to its width): folded to the first few, ending in …, unless `open`. */
export function stickyRows(text: string, open = false): string[] {
  const perRow = Math.floor((STICKY_WIDTH_MM - 4) / STICKY_TEXT_MM);
  const rows: string[] = [];
  for (const paragraph of (text || "メモ").replace(/\r\n?/g, "\n").split("\n")) {
    const chars = [...paragraph];
    if (!chars.length) rows.push("");
    for (let i = 0; i < chars.length; i += perRow) rows.push(chars.slice(i, i + perRow).join(""));
  }
  if (open || rows.length <= STICKY_FOLDED_ROWS) return rows;
  const shown = rows.slice(0, STICKY_FOLDED_ROWS);
  shown[shown.length - 1] = `${[...shown[shown.length - 1]].slice(0, perRow - 1).join("")}…`;
  return shown;
}

/** Whether a sticky has more text than it shows folded. */
export function stickyFolds(sticky: Sticky): boolean {
  return stickyRows(sticky.text, true).length > STICKY_FOLDED_ROWS;
}

/** Where a sticky lies (mm): folded, or as tall as all its text when `open`. */
export function stickyBox(sticky: Sticky, open = false): BoxMm {
  const [x, y] = sticky.at;
  return [x, y, x + STICKY_WIDTH_MM, y + 4 + stickyRows(sticky.text, open).length * STICKY_TEXT_MM * 1.3];
}

export function addSticky(project: Project, page: Page, at: Point, text = ""): Sticky {
  const sticky: Sticky = { id: newId(project, "sticky"), text, at };
  settleSticky(project, sticky);
  (page.stickies ??= []).push(sticky);
  return sticky;
}

/**
 * A 付箋 lies on its page or in its 欄外, not across the edge: on the page
 * (kept clear of the facing page of a spread) when its middle is, else just
 * outside the edge it is nearest.
 */
export function settleSticky(project: Project, sticky: Sticky): void {
  const [width, height] = project.pageFormat.canvasMm;
  const [x0, y0, x1, y1] = stickyBox(sticky);
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  if (cx >= 0 && cx <= width && cy >= 0 && cy <= height) {
    const x = Math.min(Math.max(x0, 0), Math.max(0, width - (x1 - x0)));
    const y = Math.min(Math.max(y0, 0), Math.max(0, height - (y1 - y0)));
    sticky.at = [x, y];
    return;
  }
  if (x1 <= 0 || x0 >= width || y1 <= 0 || y0 >= height) return;
  // Pushed out the shortest way.
  const ways: Point[] = [
    [-x1, 0],
    [width - x0, 0],
    [0, -y1],
    [0, height - y0],
  ];
  const [dx, dy] = ways.reduce((best, way) => (Math.hypot(way[0], way[1]) < Math.hypot(best[0], best[1]) ? way : best));
  sticky.at = [x0 + dx, y0 + dy];
}

/** The box a link's point is measured from: the panel's bounds or the line's box. */
function linkBase(page: Page, kind: StickyLink["kind"], id: string): BoxMm | null {
  if (kind === "panel") {
    const panel = page.panels.find((p) => p.id === id);
    return panel ? bounds(panel.shape) : null;
  }
  return page.lines.find((l) => l.id === id)?.box ?? null;
}

/** Where on the page a 付箋 points (null: it is about nothing there). */
export function stickyAnchor(page: Page, sticky: Sticky): Point | null {
  const link = sticky.link;
  const base = link && linkBase(page, link.kind, link.id);
  return link && base ? [base[0] + link.at[0], base[1] + link.at[1]] : null;
}

/** Tie a 付箋 to a panel or a line, pointing at `point` on it; false when it is not on the page. */
export function linkSticky(page: Page, sticky: Sticky, kind: StickyLink["kind"], id: string, point: Point): boolean {
  const base = linkBase(page, kind, id);
  if (!base) return false;
  sticky.link = { kind, id, at: [point[0] - base[0], point[1] - base[1]] };
  return true;
}

/** Let go of links to panels and lines no longer on the page; how many were let go. */
export function dropLostLinks(page: Page): number {
  let lost = 0;
  for (const sticky of page.stickies ?? []) {
    if (sticky.link && !linkBase(page, sticky.link.kind, sticky.link.id)) {
      delete sticky.link;
      lost++;
    }
  }
  return lost;
}

/** What a 付箋 is about, in a few words (empty: nothing). */
export function linkLabel(page: Page, sticky: Sticky): string {
  const link = sticky.link;
  if (!link || !linkBase(page, link.kind, link.id)) return "";
  if (link.kind === "panel") return `コマ ${page.panels.find((p) => p.id === link.id)!.order}`;
  const text = page.lines.find((l) => l.id === link.id)!.text.replace(/\s+/g, "");
  return `セリフ「${[...text].length > 10 ? `${[...text].slice(0, 10).join("")}…` : text}」`;
}

export function removeSticky(page: Page, id: string): void {
  page.stickies = (page.stickies ?? []).filter((sticky) => sticky.id !== id);
  if (!page.stickies.length) delete page.stickies;
}

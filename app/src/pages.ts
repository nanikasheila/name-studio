// Page logic that does not touch the screen: spreads, visibility, dialogue.
import type { Binding } from "./model";
import type { LayerView, PageCell, SheetView, TextView } from "./types";

/**
 * Pair pages into spreads for a right-bound (manga) book. With
 * `firstAlone`, page 1 stands alone and then 2-3, 4-5, ... face each other.
 * Each spread lists [right page, left page]; a missing side is null.
 */
export function spreads(pageCount: number, firstAlone: boolean): [number | null, number | null][] {
  const result: [number | null, number | null][] = [];
  let page = 1;
  if (firstAlone && pageCount > 0) {
    // In a right-bound book the first page is a left-hand page.
    result.push([null, 1]);
    page = 2;
  }
  for (; page <= pageCount; page += 2) {
    result.push([page, page + 1 <= pageCount ? page + 1 : null]);
  }
  return result;
}

/**
 * Whether page `number` of a spread from {@link spreads} is the left-hand
 * page: the second of the pair in a manga (right binding), the first in a
 * left-bound book.
 */
export function onLeftHand(pair: [number | null, number | null], number: number, binding: Binding): boolean {
  return (pair[1] === number) === (binding === "right");
}

/** A layer is shown when it and all its folders are visible. */
export function effectiveVisibility(layers: LayerView[], hidden: Set<number>): Map<number, boolean> {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const result = new Map<number, boolean>();
  for (const layer of layers) {
    let visible = !hidden.has(layer.id);
    for (let parent = layer.parent; visible && parent !== null; parent = byId.get(parent)?.parent ?? null) {
      visible = !hidden.has(parent);
    }
    result.set(layer.id, visible);
  }
  return result;
}

/** Layers hidden in the file start hidden in the panel. */
export function initiallyHidden(layers: LayerView[]): Set<number> {
  return new Set(layers.filter((layer) => !layer.visible).map((layer) => layer.id));
}

export interface PageLine {
  layerName: string;
  text: string;
}

function inside(cell: PageCell, x: number, y: number): boolean {
  return cell.rect.x0 <= x && x <= cell.rect.x1 && cell.rect.y0 <= y && y <= cell.rect.y1;
}

/**
 * Dialogue per page, in an approximate manga reading order: text blocks are
 * grouped in bands of a sixth of the page height, then read right to left.
 * Panels are not known yet, so this is a first approximation.
 */
export function dialogueByPage(sheet: SheetView, visible: Map<number, boolean>): PageLine[][] {
  const pages: { line: PageLine; text: TextView }[][] = sheet.cells.map(() => []);
  for (const layer of sheet.layers) {
    if (!visible.get(layer.id) || layer.kind === "story_info") continue;
    for (const text of layer.texts) {
      if (!text.bbox || !text.text.trim()) continue;
      const cx = (text.bbox[0] + text.bbox[2]) / 2;
      const cy = (text.bbox[1] + text.bbox[3]) / 2;
      const page = sheet.cells.findIndex((cell) => inside(cell, cx, cy));
      if (page >= 0) pages[page].push({ line: { layerName: layer.name, text: text.text }, text });
    }
  }
  return pages.map((entries, index) => {
    const cell = sheet.cells[index];
    const band = (cell.rect.y1 - cell.rect.y0) / 6;
    const key = (text: TextView) => Math.floor((text.bbox![1] - cell.rect.y0) / band);
    return entries
      .sort((a, b) => key(a.text) - key(b.text) || b.text.bbox![2] - a.text.bbox![2])
      .map((entry) => entry.line);
  });
}

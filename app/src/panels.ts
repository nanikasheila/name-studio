// Panels (コマ): adding, cutting and removing them, what moves with a panel
// (its dialogue, rough lines, fills and notes), and panels across a spread.

import { bounds, boxCenter, centroid, inheritOpenEdges, insidePolygon } from "./geometry";
import type { Binding, BoxMm, Page, Panel, Point, Project, StrokePoint } from "./model";
import { gutters, newId } from "./project";
import { assignPanels, orderPanels, sortLines } from "./readingorder";
import { gutterFor, segmentTouches, splitShape } from "./pagebox";

export function addPanel(project: Project, page: Page, shape: Point[]): Panel {
  const panel: Panel = { id: newId(project, "panel"), shape, order: page.panels.length + 1 };
  page.panels.push(panel);
  orderPanels(page, project.binding);
  assignPanels(page);
  return panel;
}

/** Split every panel the cut `a`-`b` touches. Returns the ids of the new panels. */
export function cutPanels(project: Project, page: Page, a: Point, b: Point, gaps = gutters(project)): string[] {
  const gutter = gutterFor(a, b, gaps);
  const created: string[] = [];
  const panels: Panel[] = [];
  for (const panel of page.panels) {
    const halves = segmentTouches(panel.shape, a, b) ? splitShape(panel.shape, a, b, gutter) : null;
    if (!halves) {
      panels.push(panel);
      continue;
    }
    // Both halves keep the panel's look; edges cut from an open edge stay open.
    const [first, second] = halves.map((shape) => {
      const half: Panel = { ...panel, shape };
      const open = inheritOpenEdges(panel.shape, panel.openEdges, shape);
      if (open.length) half.openEdges = open;
      else delete half.openEdges;
      return half;
    });
    if (panel.spread) {
      // A 見開き has one half per page: it stays with the part at the gutter.
      const [w] = project.pageFormat.canvasMm;
      const atGutter = (half: Panel) => half.shape.some(([x]) => x <= 0.05 || x >= w - 0.05);
      if (atGutter(first)) delete second.spread;
      else delete first.spread;
    }
    panels.push(first);
    const id = newId(project, "panel");
    panels.push({ ...second, id, order: 0 });
    created.push(id);
  }
  if (!created.length) return created;
  page.panels = panels;
  orderPanels(page, project.binding);
  assignPanels(page);
  return created;
}

export function removePanel(page: Page, panelId: string, binding: Binding = "right"): void {
  page.panels = page.panels.filter((panel) => panel.id !== panelId);
  orderPanels(page, binding);
  assignPanels(page);
}

export function movePanel(panel: Panel, dx: number, dy: number): void {
  panel.shape = panel.shape.map(([x, y]) => [x + dx, y + dy]);
}

/** Whether page `index` and the next one should go to CSP as one 見開き page. */
export function wantsSpread(project: Project, index: number): boolean {
  // 縦スクロール: no spreads; each piece is a page of its own.
  if (project.scroll) return false;
  const page = project.pages[index];
  const next = project.pages[index + 1];
  if (!page || !next) return false;
  if (page.joinNext) return true;
  // A panel across the gutter can only be one panel on a spread page.
  const shared = new Set(next.panels.map((panel) => panel.spread).filter(Boolean));
  return page.panels.some((panel) => panel.spread && shared.has(panel.spread));
}

/** The panel that owns a point: the topmost one there (insets over their panel). */
function ownerAt(page: Page, point: Point): Panel | undefined {
  let owner: Panel | undefined;
  for (const panel of page.panels) {
    if (!insidePolygon(panel.shape, point)) continue;
    if (!owner || (panel.z ?? 0) > (owner.z ?? 0)) owner = panel;
  }
  return owner;
}

/** What a panel carries along: dialogue whose box centre and rough lines most of whose points are in it. */
export function panelContents(page: Page, panel: Panel): { strokes: string[]; lines: string[] } {
  const owns = (point: Point) => ownerAt(page, point)?.id === panel.id;
  const strokes = page.strokes
    .filter((stroke) => {
      const inside = stroke.points.filter(([x, y]) => owns([x, y])).length;
      return inside > 0 && inside >= stroke.points.length / 2;
    })
    .map((stroke) => stroke.id);
  const lines = page.lines.filter((line) => owns(boxCenter(line.box))).map((line) => line.id);
  return { strokes, lines };
}

/** The contents of a panel as they were, to follow the panel as it changes. */
export interface CarriedContents {
  box: BoxMm;
  fills?: { id: string; shape: Point[] }[];
  strokes: { id: string; points: StrokePoint[] }[];
  lines: { id: string; box: BoxMm; balloon?: Point[]; tails?: Point[] }[];
}

export function carryContents(page: Page, panel: Panel): CarriedContents {
  const { strokes, lines } = panelContents(page, panel);
  const owned = (page.fills ?? []).filter((fill) => ownerAt(page, centroid(fill.shape))?.id === panel.id);
  return {
    box: bounds(panel.shape),
    ...(owned.length ? { fills: owned.map((fill) => ({ id: fill.id, shape: fill.shape.map((p) => [...p] as Point) })) } : {}),
    strokes: page.strokes.filter((s) => strokes.includes(s.id)).map((s) => ({ id: s.id, points: s.points.map((p) => [...p] as StrokePoint) })),
    lines: page.lines
      .filter((l) => lines.includes(l.id))
      .map((l) => ({
        id: l.id,
        box: [...l.box] as BoxMm,
        ...(l.balloon ? { balloon: l.balloon.map((p) => [...p] as Point) } : {}),
        ...(l.tails ? { tails: l.tails.map((t) => [...t.tip] as Point) } : {}),
      })),
  };
}

/**
 * Put the carried contents where the panel now is: positions follow the
 * panel's box (moved, and stretched when a corner is dragged). Rough lines
 * keep their proportions, scaled by the smaller stretch; dialogue keeps its
 * size and moves with its centre.
 */
export function followPanel(page: Page, panel: Panel, carried: CarriedContents): void {
  const [ox0, oy0, ox1, oy1] = carried.box;
  const [nx0, ny0, nx1, ny1] = bounds(panel.shape);
  const sx = ox1 > ox0 ? (nx1 - nx0) / (ox1 - ox0) : 1;
  const sy = oy1 > oy0 ? (ny1 - ny0) / (oy1 - oy0) : 1;
  const map = ([x, y]: readonly number[]): Point => [nx0 + (x - ox0) * sx, ny0 + (y - oy0) * sy];
  const uniform = Math.min(sx, sy);
  for (const { id, shape } of carried.fills ?? []) {
    const fill = page.fills?.find((f) => f.id === id);
    if (!fill) continue;
    const [cx0, cy0, cx1, cy1] = bounds(shape);
    const centre: Point = [(cx0 + cx1) / 2, (cy0 + cy1) / 2];
    const [mx, my] = map(centre);
    fill.shape = shape.map(([x, y]) => [mx + (x - centre[0]) * uniform, my + (y - centre[1]) * uniform]);
  }
  for (const { id, points } of carried.strokes) {
    const stroke = page.strokes.find((s) => s.id === id);
    if (!stroke) continue;
    const [cx0, cy0, cx1, cy1] = bounds(points.map(([x, y]) => [x, y] as Point));
    const centre: Point = [(cx0 + cx1) / 2, (cy0 + cy1) / 2];
    const [mx, my] = map(centre);
    stroke.points = points.map(([x, y, ...rest]) => [mx + (x - centre[0]) * uniform, my + (y - centre[1]) * uniform, ...rest] as StrokePoint);
  }
  for (const { id, box, balloon, tails } of carried.lines) {
    const line = page.lines.find((l) => l.id === id);
    if (!line) continue;
    const [mx, my] = map(boxCenter(box));
    const [cx, cy] = boxCenter(box);
    const [dx, dy] = [mx - cx, my - cy];
    line.box = [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
    if (balloon) line.balloon = balloon.map(([x, y]) => [x + dx, y + dy]);
    if (tails && line.tails) line.tails.forEach((tail, i) => tails[i] && (tail.tip = map(tails[i])));
  }
}

/**
 * コマの入れ替え: the dialogue, rough lines, fills and 演出メモ of two panels
 * change places (the panels stay), fitted to their new panel as when a panel
 * is reshaped.
 * The panels may be on different pages.
 */
export function swapPanelContents(pageA: Page, panelA: Panel, pageB: Page, panelB: Panel, binding: Binding = "right"): void {
  if (panelA === panelB) return;
  const carriedA = carryContents(pageA, panelA);
  const carriedB = carryContents(pageB, panelB);
  if (pageA !== pageB) {
    const take = (from: Page, to: Page, carried: CarriedContents) => {
      const strokes = new Set(carried.strokes.map((s) => s.id));
      const lines = new Set(carried.lines.map((l) => l.id));
      const fills = new Set((carried.fills ?? []).map((f) => f.id));
      to.strokes.push(...from.strokes.filter((s) => strokes.has(s.id)));
      to.lines.push(...from.lines.filter((l) => lines.has(l.id)));
      from.strokes = from.strokes.filter((s) => !strokes.has(s.id));
      from.lines = from.lines.filter((l) => !lines.has(l.id));
      if (fills.size) {
        (to.fills ??= []).push(...(from.fills ?? []).filter((f) => fills.has(f.id)));
        from.fills = (from.fills ?? []).filter((f) => !fills.has(f.id));
        if (!from.fills.length) delete from.fills;
      }
    };
    take(pageA, pageB, carriedA);
    take(pageB, pageA, carriedB);
  }
  followPanel(pageB, panelB, carriedA);
  followPanel(pageA, panelA, carriedB);
  // The 演出メモ is about what is in the panel, so it goes along.
  const [noteA, noteB] = [panelA.note, panelB.note];
  if (noteB) panelA.note = noteB;
  else delete panelA.note;
  if (noteA) panelB.note = noteA;
  else delete panelB.note;
  for (const page of new Set([pageA, pageB])) {
    assignPanels(page);
    sortLines(page, binding);
  }
}

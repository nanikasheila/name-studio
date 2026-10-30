// 保留コマ: panels taken off their page while it is not yet decided where they
// go ("somewhere around page 5"), and panels moved from one page to another.
// A held panel keeps what is in it (dialogue, rough lines, fills, its 付箋)
// and comes back whole wherever it is put.

import { bounds } from "./geometry";
import type { HeldPanel, Page, Panel, Point, Project, Sticky } from "./model";
import { type CarriedContents, carryContents, followPanel, type PanelFit } from "./panels";
import { newId } from "./project";
import { assignPanels, orderPanels, sortLines } from "./readingorder";
import { fillShape } from "./strokes";

/** Take a panel and what is in it off its page, into the 保留 list; `near`: the page it is meant to go near. */
export function holdPanel(project: Project, page: Page, panel: Panel, near: string | undefined = page.id): HeldPanel {
  const carried = carryContents(page, panel);
  const lineIds = new Set(carried.lines.map((l) => l.id));
  const strokeIds = new Set(carried.strokes.map((s) => s.id));
  const fillIds = new Set((carried.fills ?? []).map((f) => f.id));
  const about = (sticky: Sticky) => !!sticky.link && (sticky.link.id === panel.id || lineIds.has(sticky.link.id));
  const held: HeldPanel = {
    id: newId(project, "held"),
    panel: { ...panel },
    lines: page.lines.filter((l) => lineIds.has(l.id)),
    strokes: page.strokes.filter((s) => strokeIds.has(s.id)),
    from: page.id,
  };
  // A half of a 見開き panel comes away as a panel of its own.
  delete held.panel.spread;
  const fills = (page.fills ?? []).filter((f) => fillIds.has(f.id));
  if (fills.length) held.fills = fills;
  const stickies = (page.stickies ?? []).filter(about);
  if (stickies.length) held.stickies = stickies;
  if (near) held.near = near;
  page.panels = page.panels.filter((p) => p !== panel);
  page.lines = page.lines.filter((l) => !lineIds.has(l.id));
  page.strokes = page.strokes.filter((s) => !strokeIds.has(s.id));
  if (page.fills) page.fills = page.fills.filter((f) => !fillIds.has(f.id));
  if (page.fills && !page.fills.length) delete page.fills;
  if (page.stickies) page.stickies = page.stickies.filter((s) => !about(s));
  if (page.stickies && !page.stickies.length) delete page.stickies;
  // Balloons joined to one that left come loose.
  for (const line of page.lines) if (line.linkTo && lineIds.has(line.linkTo)) delete line.linkTo;
  orderPanels(page, project.binding);
  assignPanels(page);
  (project.held ??= []).push(held);
  return held;
}

/**
 * Put a held panel on a page and out of the 保留 list. Into `into`: what it
 * holds is fitted into that panel as `fit` says (the panel stays as it is).
 * Otherwise the panel comes back with its shape, centred on `at` (where it
 * was when none).
 */
export function placeHeld(project: Project, page: Page, held: HeldPanel, at?: Point, into?: Panel, fit: PanelFit = "stretch"): Panel {
  project.held = (project.held ?? []).filter((h) => h.id !== held.id);
  if (!project.held.length) delete project.held;
  page.lines.push(...held.lines);
  page.strokes.push(...held.strokes);
  if (held.fills?.length) (page.fills ??= []).push(...held.fills);
  if (held.stickies?.length) (page.stickies ??= []).push(...held.stickies);
  // What came along, as it was, to follow the panel where it goes.
  const carried: CarriedContents = {
    box: bounds(held.panel.shape),
    strokes: held.strokes.map((s) => ({ id: s.id, points: s.points.map((p) => [...p] as typeof p) })),
    lines: held.lines.map((l) => ({
      id: l.id,
      box: [...l.box],
      ...(l.balloon ? { balloon: l.balloon.map((p) => [...p] as Point) } : {}),
      ...(l.tails ? { tails: l.tails.map((t) => [...t.tip] as Point) } : {}),
    })),
    ...(held.fills ? { fills: held.fills.map(fillShape) } : {}),
  };
  let target: Panel;
  if (into) {
    target = into;
    if (held.panel.note && !into.note) into.note = held.panel.note;
    for (const sticky of held.stickies ?? []) if (sticky.link?.id === held.panel.id) sticky.link.id = into.id;
  } else {
    const [x0, y0, x1, y1] = bounds(held.panel.shape);
    const [dx, dy] = at ? [at[0] - (x0 + x1) / 2, at[1] - (y0 + y1) / 2] : [0, 0];
    target = { ...held.panel, shape: held.panel.shape.map(([x, y]) => [x + dx, y + dy]) };
    page.panels.push(target);
  }
  // Stickies move with it as they were placed beside it.
  const [ox0, oy0] = carried.box;
  const [nx0, ny0] = bounds(target.shape);
  for (const sticky of held.stickies ?? []) sticky.at = [sticky.at[0] + nx0 - ox0, sticky.at[1] + ny0 - oy0];
  followPanel(page, target, carried, fit);
  orderPanels(page, project.binding);
  assignPanels(page);
  sortLines(page, project.binding);
  return target;
}

/** Move a panel with what is in it to another page, where it was on its own. */
export function movePanelToPage(project: Project, from: Page, panel: Panel, to: Page): Panel {
  const held = holdPanel(project, from, panel, to.id);
  return placeHeld(project, to, held);
}

/** The held panels meant to go near pages `first`..`last` (indexes). */
export function heldNear(project: Project, first: number, last: number): HeldPanel[] {
  return (project.held ?? []).filter((held) => {
    const index = project.pages.findIndex((p) => p.id === held.near);
    return index >= first && index <= last;
  });
}

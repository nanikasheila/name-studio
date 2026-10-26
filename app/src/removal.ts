// Taking things off a page: one panel, line, rough line, はみ出し, 付箋 or fill,
// or what was picked together. Pure: the screens say what is picked.
import { spreadTwin } from "./koma";
import type { Project } from "./model";
import { removePanel } from "./panels";
import { assignPanels, orderPanels } from "./readingorder";
import { removeSticky } from "./stickies";
import type { ItemRef } from "./transform";

/** What is picked on a page: one thing, or ("group") the things picked together. */
export interface Picked {
  kind: "panel" | "line" | "stroke" | "breakout" | "group" | "sticky" | "fill";
  pageId: string;
  id: string;
  items?: ItemRef[];
}

/** Whether what is picked is all still there (after an undo, it may not be). */
export function stillThere(project: Project | null, s: Picked): boolean {
  const page = project?.pages.find((p) => p.id === s.pageId);
  if (!page) return false;
  const lists = { panel: page.panels, line: page.lines, stroke: page.strokes, breakout: page.breakouts, sticky: page.stickies ?? [], fill: page.fills ?? [] };
  if (s.kind === "group") return !!s.items?.every((item) => lists[item.kind].some((x: { id: string }) => x.id === item.id));
  return lists[s.kind].some((item: { id: string }) => item.id === s.id);
}

/** Removes what is picked. What was drawn in a removed panel stays on the page; balloons joined to a removed one come loose. */
export function removePicked(project: Project, s: Picked): void {
  const page = project.pages.find((p) => p.id === s.pageId);
  if (!page) return;
  if (s.kind === "panel") {
    // The other half of a 見開き stays as a panel of its own page.
    const panel = page.panels.find((p) => p.id === s.id);
    const twin = panel && spreadTwin(project, page, panel);
    if (twin) delete twin.panel.spread;
    removePanel(page, s.id, project.binding);
  }
  if (s.kind === "line") page.lines = page.lines.filter((line) => line.id !== s.id);
  if (s.kind === "stroke") page.strokes = page.strokes.filter((stroke) => stroke.id !== s.id);
  if (s.kind === "breakout") page.breakouts = page.breakouts.filter((breakout) => breakout.id !== s.id);
  if (s.kind === "sticky") removeSticky(page, s.id);
  if (s.kind === "fill" && page.fills) page.fills = page.fills.filter((fill) => fill.id !== s.id);
  if (s.kind === "group") {
    const ids = (kind: string) => new Set(s.items?.filter((item) => item.kind === kind).map((item) => item.id));
    const [strokes, lines, panels, fills, breakouts] = ["stroke", "line", "panel", "fill", "breakout"].map(ids);
    page.strokes = page.strokes.filter((stroke) => !strokes.has(stroke.id));
    page.lines = page.lines.filter((line) => !lines.has(line.id));
    for (const line of page.lines) if (line.linkTo && lines.has(line.linkTo)) delete line.linkTo;
    page.breakouts = page.breakouts.filter((breakout) => !breakouts.has(breakout.id));
    if (page.fills) page.fills = page.fills.filter((fill) => !fills.has(fill.id));
    if (panels.size) {
      // What was drawn in the panels stays, as when one panel is removed.
      page.panels = page.panels.filter((panel) => !panels.has(panel.id));
      orderPanels(page, project.binding);
      assignPanels(page);
    }
  }
  if (s.kind === "line") {
    // Balloons joined to the removed one come loose.
    for (const line of page.lines) if (line.linkTo === s.id) delete line.linkTo;
  }
}

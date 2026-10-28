// Dialogue, rough lines and 付箋 dragged onto another page go to that page,
// keeping where they are on screen. The editor says which page lies under a
// point and how that page's mm sit against this one's; panels go with
// what is in them through hold.ts.
import { moveLine } from "./dialogue";
import { bounds } from "./geometry";
import type { BoxMm, Page, Point, Project, Sticky } from "./model";
import { sortLines } from "./readingorder";
import { settleSticky, stickyBox } from "./stickies";
import { moveStroke } from "./strokes";
import type { ItemRef } from "./transform";

/** Another page under a point (mm on the page things come from), and what to add to that page's mm to get there. */
export interface Destination {
  page: Page;
  offset: Point;
}

const centre = (box: BoxMm): Point => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];

/**
 * Lines and rough lines among `items` whose middle lies over another page go
 * there (a line lets go of the balloon it was joined to); panels, fills and
 * はみ出し stay. Returns what went, and to which pages.
 */
export function carryItems(project: Project, from: Page, items: readonly ItemRef[], under: (point: Point) => Destination | null): { moved: ItemRef[]; to: Set<Page> } {
  const moved: ItemRef[] = [];
  const to = new Set<Page>();
  for (const item of items) {
    if (item.kind === "line") {
      const line = from.lines.find((l) => l.id === item.id);
      const there = line && under(centre(line.box));
      if (!line || !there) continue;
      from.lines = from.lines.filter((l) => l !== line);
      moveLine(line, ...there.offset);
      delete line.linkTo;
      there.page.lines.push(line);
      sortLines(there.page, project.binding);
      to.add(there.page);
      moved.push(item);
    } else if (item.kind === "stroke") {
      const stroke = from.strokes.find((x) => x.id === item.id);
      const there = stroke && under(centre(bounds(stroke.points.map(([x, y]) => [x, y] as Point))));
      if (!stroke || !there) continue;
      from.strokes = from.strokes.filter((x) => x !== stroke);
      moveStroke(stroke, ...there.offset);
      there.page.strokes.push(stroke);
      to.add(there.page);
      moved.push(item);
    }
  }
  return { moved, to };
}

/**
 * A 付箋 whose middle lies over another page goes there, unless it is tied
 * to a panel or a line (it stays on their page). It is kept on its page's
 * canvas either way. Returns the page it went to.
 */
export function carrySticky(project: Project, from: Page, sticky: Sticky, under: (point: Point) => Destination | null): Page | null {
  const there = sticky.link ? null : under(centre(stickyBox(sticky)));
  if (there) {
    from.stickies = (from.stickies ?? []).filter((n) => n !== sticky);
    sticky.at = [sticky.at[0] + there.offset[0], sticky.at[1] + there.offset[1]];
    (there.page.stickies ??= []).push(sticky);
  }
  settleSticky(project, sticky);
  return there?.page ?? null;
}

// 欄外: the room around the pages, as around the pages of a name sheet, for
// what is not part of any page: thoughts on 付箋, quick sketches with the
// pen, 資料画像 to look at, and 保留コマ waiting for a place. Each belongs
// to the page it lies beside (in that page's millimetres, past its edges)
// and goes along with it on the canvas. None of it is written to CLIP
// STUDIO PAINT: a CSP page ends at its paper.
import { bounds } from "./geometry";
import type { BoxMm, HeldPanel, Page, PageFormat, Point, Project, Stroke } from "./model";
import { stickyBox } from "./stickies";

/** Room kept between the page and what is put beside it (mm). */
export const ASIDE_GAP_MM = 8;

/** How far the 欄外 reaches past the pages' edges (mm): top, right, bottom, left. */
export type Room = [number, number, number, number];

export const NO_ROOM: Room = [0, 0, 0, 0];

// A line's box, kept while its points stay the same (they are replaced, not changed, when it moves).
const strokeBoxes = new WeakMap<Stroke["points"], BoxMm>();

/** The box of a rough line's points (mm on its page). */
export function strokeBox(stroke: Stroke): BoxMm {
  let box = strokeBoxes.get(stroke.points);
  if (!box) {
    // Every line of every page is looked at as the view is drawn: no arrays made on the way.
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const point of stroke.points) {
      const [x, y] = point;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    box = [x0, y0, x1, y1];
    strokeBoxes.set(stroke.points, box);
  }
  return box;
}

/** Whether a box lies wholly off the page: in its 欄外. */
export function offPage([x0, y0, x1, y1]: BoxMm, format: PageFormat): boolean {
  const [w, h] = format.canvasMm;
  return x1 <= 0 || x0 >= w || y1 <= 0 || y0 >= h;
}

/** Whether a box reaches past the page's edges (some or all of it in the 欄外). */
export function reachesOff([x0, y0, x1, y1]: BoxMm, format: PageFormat): boolean {
  const [w, h] = format.canvasMm;
  return x0 < 0 || y0 < 0 || x1 > w || y1 > h;
}

/** Whether a point is off the page. */
export function pointOff([x, y]: Point, format: PageFormat): boolean {
  const [w, h] = format.canvasMm;
  return x < 0 || y < 0 || x > w || y > h;
}

/** The page as it goes to CSP: without what lies in its 欄外 (what only reaches into it stays). */
export function onPageOnly(page: Page, format: PageFormat): Page {
  const strokes = page.strokes.filter((stroke) => !offPage(strokeBox(stroke), format));
  const references = page.references?.filter((reference) => !offPage(reference.box, format));
  const stickies = page.stickies?.filter((sticky) => !offPage(stickyBox(sticky), format));
  if (strokes.length === page.strokes.length && references?.length === page.references?.length && stickies?.length === page.stickies?.length) return page;
  return {
    ...page,
    strokes,
    ...(references ? { references } : {}),
    ...(stickies ? { stickies } : {}),
  };
}

/** How many things lie in a page's 欄外 (held panels beside it included). */
export function asideCount(project: Project, page: Page): number {
  const format = project.pageFormat;
  return (
    page.strokes.filter((stroke) => offPage(strokeBox(stroke), format)).length +
    (page.references ?? []).filter((reference) => offPage(reference.box, format)).length +
    (page.stickies ?? []).filter((sticky) => offPage(stickyBox(sticky), format)).length +
    heldBeside(project, page).length
  );
}

/** Where a held panel lies in its page's 欄外 (mm on page `near`), or null when it is only in the 保留 list. */
export function heldBox(held: HeldPanel): BoxMm | null {
  if (!held.at || !held.near) return null;
  const [x0, y0, x1, y1] = bounds(held.panel.shape);
  const [x, y] = held.at;
  return [x, y, x + x1 - x0, y + y1 - y0];
}

/** The held panels laid in a page's 欄外. */
export function heldBeside(project: Project, page: Page): HeldPanel[] {
  return (project.held ?? []).filter((held) => held.near === page.id && held.at);
}

/** The boxes of what lies in or reaches into a page's 欄外 (mm), but `except`. */
export function asideBoxes(project: Project, page: Page, except?: HeldPanel): BoxMm[] {
  const format = project.pageFormat;
  const boxes: BoxMm[] = [];
  for (const stroke of page.strokes) {
    const box = strokeBox(stroke);
    if (reachesOff(box, format)) boxes.push(box);
  }
  for (const reference of page.references ?? []) if (reachesOff(reference.box, format)) boxes.push(reference.box);
  for (const sticky of page.stickies ?? []) {
    const box = stickyBox(sticky);
    if (reachesOff(box, format)) boxes.push(box);
  }
  for (const held of heldBeside(project, page)) {
    const box = held !== except && heldBox(held);
    if (box) boxes.push(box);
  }
  return boxes;
}

/**
 * How far what lies in the 欄外 of any page reaches past its edges (mm), at
 * most `most` on each side: the room 連続 keeps between the pages for it.
 */
export function asideRoom(project: Project, most: number): Room {
  const [w, h] = project.pageFormat.canvasMm;
  const room: Room = [0, 0, 0, 0];
  for (const page of project.pages) {
    for (const [x0, y0, x1, y1] of asideBoxes(project, page)) {
      room[0] = Math.max(room[0], -y0);
      room[1] = Math.max(room[1], x1 - w);
      room[2] = Math.max(room[2], y1 - h);
      room[3] = Math.max(room[3], -x0);
    }
  }
  // A little air beyond what is there, so it does not touch the next page.
  return room.map((side) => (side > 0 ? Math.min(side + ASIDE_GAP_MM / 2, most) : 0)) as Room;
}

/** Whether two boxes come closer than `gap`. */
function near(a: BoxMm, b: BoxMm, gap: number): boolean {
  return a[0] < b[2] + gap && b[0] < a[2] + gap && a[1] < b[3] + gap && b[1] < a[3] + gap;
}

/**
 * Lay a held panel in the 欄外 above `page`: across where it was, and higher
 * up while something else is there.
 */
export function layAside(project: Project, held: HeldPanel, page: Page): void {
  const [pageW] = project.pageFormat.canvasMm;
  const [x0, y0, x1, y1] = bounds(held.panel.shape);
  const [w, h] = [x1 - x0, y1 - y0];
  const taken = asideBoxes(project, page, held);
  const x = Math.min(Math.max(x0, 0), Math.max(0, pageW - w));
  let y = -ASIDE_GAP_MM - h;
  for (let tries = 0; tries < 100; tries++) {
    const box: BoxMm = [x, y, x + w, y + h];
    const under = taken.filter((other) => near(box, other, ASIDE_GAP_MM / 2));
    if (!under.length) break;
    y = Math.min(...under.map((other) => other[1])) - ASIDE_GAP_MM - h;
  }
  held.near = page.id;
  held.at = [x, y];
}

/** Take a held panel out of the 欄外 (it stays in the 保留 list). */
export function takeFromAside(held: HeldPanel): void {
  delete held.at;
}

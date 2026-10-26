// しっぽを付ける: tails for speech that has none, aimed at whoever is
// speaking. A panel's rough drawing is grouped into figures (strokes whose
// boxes touch); speakers take figures in reading order (the first to speak
// is the rightmost figure in a manga, the leftmost in a left-bound book), and a tail points at the top of its figure, the
// head. A speaker who already has a tail in the panel keeps that direction.
// With nothing drawn, the tail points down into the panel.
import { balloonExtent, defaultTailStyle, resolvedShape } from "./balloon";
import { bounds, boxCenter, centroid, insidePolygon } from "./geometry";
import type { Binding, BoxMm, Line, Page, Panel, Point } from "./model";
import { panelContents } from "./panels";

/** How far past the balloon a tail reaches (mm), at most. */
const REACH = 12;
/** Strokes this close (mm) belong to the same figure. */
const TOUCH = 4;

/** Speech that wants a tail: a balloon, no tail, not joined to another balloon. */
export function wantsTail(page: Page, line: Line): boolean {
  return (
    line.kind === "speech" &&
    resolvedShape(line) !== "none" &&
    !line.tails?.length &&
    !line.linkTo &&
    !page.lines.some((other) => other.linkTo === line.id)
  );
}

/** The figures drawn in a panel: boxes of strokes grouped where they touch, right to left. */
export function figures(page: Page, panel: Panel): BoxMm[] {
  const ids = new Set(panelContents(page, panel).strokes);
  const boxes = page.strokes.filter((stroke) => ids.has(stroke.id)).map((stroke) => bounds(stroke.points.map(([x, y]) => [x, y])));
  // Dialogue boxes are not figures; strokes under a balloon (its text drawn by hand) are left out.
  const balloons = page.lines.filter((line) => line.panel === panel.id).map(balloonExtent);
  const free = boxes.filter((box) => !balloons.some((b) => contains(b, box)));
  const groups: BoxMm[] = [];
  for (const box of free) {
    let merged = box;
    for (let i = groups.length - 1; i >= 0; i--) {
      if (touches(groups[i], merged)) {
        merged = union(groups[i], merged);
        groups.splice(i, 1);
      }
    }
    groups.push(merged);
  }
  // Merging can make new neighbours touch; once more until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (touches(groups[i], groups[j])) {
          groups[i] = union(groups[i], groups[j]);
          groups.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  // Specks (a stray dot, a speed line) are not figures.
  return groups.filter(([x0, y0, x1, y1]) => Math.max(x1 - x0, y1 - y0) >= 6).sort((a, b) => b[2] + b[0] - (a[2] + a[0]));
}

function touches(a: BoxMm, b: BoxMm): boolean {
  return a[0] - TOUCH <= b[2] && b[0] - TOUCH <= a[2] && a[1] - TOUCH <= b[3] && b[1] - TOUCH <= a[3];
}

function union(a: BoxMm, b: BoxMm): BoxMm {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function contains(outer: BoxMm, inner: BoxMm): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

/** Where a figure's head is: the middle of its top part. */
function head([x0, y0, x1, y1]: BoxMm): Point {
  return [(x0 + x1) / 2, y0 + Math.min(12, (y1 - y0) * 0.15)];
}

/** The tip of a tail from `line` towards `target`: out of the balloon, at most REACH past it, short of the target. */
function tipTowards(line: Line, target: Point): Point {
  const box = balloonExtent(line);
  const [cx, cy] = boxCenter(box);
  let [dx, dy] = [target[0] - cx, target[1] - cy];
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-6) [dx, dy] = [0, 1];
  else [dx, dy] = [dx / distance, dy / distance];
  // Where the ray leaves the balloon's box.
  const halfW = (box[2] - box[0]) / 2;
  const halfH = (box[3] - box[1]) / 2;
  const exit = Math.min(Math.abs(dx) > 1e-6 ? halfW / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? halfH / Math.abs(dy) : Infinity);
  // Stop a little short of the head, but always stick out a few mm.
  const reach = Math.max(4, Math.min(REACH, distance - exit - 3));
  return [cx + dx * (exit + reach), cy + dy * (exit + reach)];
}

/** Down into the panel from the balloon, leaning towards the panel's middle. */
function fallbackTarget(line: Line, panel: Panel | undefined): Point {
  const [cx, cy] = boxCenter(balloonExtent(line));
  if (!panel) return [cx - 4, cy + 40];
  const [mx] = centroid(panel.shape);
  const [, , , py1] = bounds(panel.shape);
  const target: Point = [cx + (mx - cx) * 0.4, Math.max(cy + 20, py1 - 4)];
  return insidePolygon(panel.shape, target) ? target : [cx + (mx - cx) * 0.4, cy + 20];
}

/**
 * Give every speech line on the page that has no tail one (see the top of
 * the file). Returns how many tails were added.
 */
export function addAutoTails(page: Page, binding: Binding = "right"): number {
  let added = 0;
  const panels = new Map(page.panels.map((panel) => [panel.id, panel]));
  // Panel by panel, lines in reading order.
  const byPanel = new Map<string, Line[]>();
  for (const line of page.lines) {
    const key = line.panel ?? "";
    byPanel.set(key, [...(byPanel.get(key) ?? []), line]);
  }
  for (const [panelId, lines] of byPanel) {
    const panel = panels.get(panelId);
    // Figures in reading order: right to left, or from the left in a left-bound book.
    const found = panel ? figures(page, panel) : [];
    if (binding === "left") found.reverse();
    // Speakers in the order they first speak; no speaker counts as its own.
    const order: (string | undefined)[] = [];
    for (const line of lines) if (line.kind === "speech" && !order.includes(line.speaker)) order.push(line.speaker);
    for (const line of lines) {
      if (!wantsTail(page, line)) continue;
      // The same speaker's tail in this panel, if there is one.
      const earlier = lines.find((other) => other !== line && other.speaker && other.speaker === line.speaker && other.tails?.length);
      let target: Point;
      if (earlier?.tails?.length) target = earlier.tails[0].tip;
      else if (found.length) target = head(found[order.indexOf(line.speaker) % found.length]);
      else target = fallbackTarget(line, panel);
      line.tails = [{ tip: tipTowards(line, target), style: defaultTailStyle(line) }];
      added++;
    }
  }
  return added;
}

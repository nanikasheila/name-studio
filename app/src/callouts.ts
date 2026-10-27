// Where the words of the help over the whole screen go: each beside the part
// it names (right of it, under it, over it) or inside a large one, pushed
// along until it covers no other words and no other part named, with the
// ends of the line from the part to its words.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type CalloutSide = "right" | "below" | "above" | "inside";

export interface CalloutRequest {
  /** The part named, on screen. */
  anchor: Box;
  side: CalloutSide;
  /** The words' size. */
  width: number;
  height: number;
}

export interface Callout {
  label: Box;
  /** The line from the part to its words (none inside a part). */
  line: [number, number, number, number] | null;
}

/** Room left between the words and anything else. */
const MARGIN = 4;
/** How far a step moves the words along. */
const STEP = 6;
/** How far the words may go: along the side they are on, and across it. */
const REACH = 600;
const ACROSS = 160;

/** The moves to try for words on that side, nearest (by how far they look moved) first. */
function moves(side: CalloutSide): [number, number][] {
  // Below a bar: down, and across either way; above: up; right of a column: out, and up or down; inside: anywhere.
  const along = side === "below" ? [1] : side === "above" ? [-1] : [1, -1];
  const across = side === "right" ? [1] : [1, -1];
  const out: [number, number, number][] = [];
  for (let a = 0; a <= REACH; a += STEP) {
    for (let c = 0; c <= ACROSS; c += STEP) {
      for (const sa of a ? along : [1]) {
        for (const sc of c ? across : [1]) {
          const [main, cross] = [a * sa, c * sc];
          out.push([cross, main, a + c * 0.6]);
        }
      }
    }
  }
  return out.sort((x, y) => x[2] - y[2]).map(([dx, dy]) => [dx, dy]);
}

const MOVES: Record<CalloutSide, [number, number][]> = { right: moves("right"), below: moves("below"), above: moves("above"), inside: moves("inside") };

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.left + b.width + MARGIN && b.left < a.left + a.width + MARGIN && a.top < b.top + b.height + MARGIN && b.top < a.top + a.height + MARGIN;
}

function within(box: Box, view: { width: number; height: number }): boolean {
  return box.left >= 0 && box.top >= 0 && box.left + box.width <= view.width && box.top + box.height <= view.height;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * Places the words of each request in turn (earlier ones keep their place),
 * clear of `blocked` (the header, say), of the words placed before and of the
 * parts beside which words go.
 */
export function placeCallouts(requests: readonly CalloutRequest[], view: { width: number; height: number }, blocked: readonly Box[] = [], gap = 26): Callout[] {
  const taken: Box[] = [...blocked, ...requests.filter((r) => r.side !== "inside").map((r) => r.anchor)];
  return requests.map((request) => {
    const { anchor, side, width, height } = request;
    const cx = anchor.left + anchor.width / 2;
    const cy = anchor.top + anchor.height / 2;
    const start: Box =
      side === "right"
        ? { left: anchor.left + anchor.width + gap, top: cy - height / 2, width, height }
        : side === "below"
          ? { left: cx - width / 2, top: anchor.top + anchor.height + gap, width, height }
          : side === "above"
            ? { left: cx - width / 2, top: anchor.top - gap - height, width, height }
            : { left: cx - width / 2, top: cy - height / 2, width, height };
    start.left = clamp(start.left, MARGIN, Math.max(MARGIN, view.width - width - MARGIN));
    start.top = clamp(start.top, MARGIN, Math.max(MARGIN, view.height - height - MARGIN));
    // Nearest first: across a little before further away (beside a part: only away from it).
    let label = start;
    for (const [dx, dy] of MOVES[side]) {
      const tried = { ...start, left: start.left + dx, top: start.top + dy };
      if (!within(tried, view)) continue;
      if (taken.some((box) => box !== anchor && overlaps(tried, box))) continue;
      label = tried;
      break;
    }
    taken.push(label);
    let line: Callout["line"] = null;
    if (side === "right") line = [anchor.left + anchor.width, cy, label.left, label.top + label.height / 2];
    else if (side === "below") line = [cx, anchor.top + anchor.height, clamp(cx, label.left + 8, label.left + label.width - 8), label.top];
    else if (side === "above") line = [cx, anchor.top, clamp(cx, label.left + 8, label.left + label.width - 8), label.top + label.height];
    return { label, line };
  });
}

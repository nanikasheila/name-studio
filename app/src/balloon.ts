// フキダシの形: outlines for each balloon shape, tails spliced into them and
// linked balloons (連結) merged into one outline. Every shape is built as a
// star around the text's centre (points in order of angle), which is what
// lets a tail or a link replace an arc of the outline.
import { clipClosed, clipOpen, maskShape } from "./mask";
import { boxCenter, type BalloonShape, type BoxMm, type Line, type LineKind, type Page, type Point, type Tail, type TailStyle } from "./project";

export type ResolvedShape = Exclude<BalloonShape, "auto">;

export const SHAPE_LABELS: Record<BalloonShape, string> = {
  auto: "種類に合わせる",
  ellipse: "楕円",
  rounded: "角丸",
  box: "四角（ナレーション）",
  polygon: "多角形（独白・回想）",
  cloud: "モコモコ（思考）",
  spike: "トゲ（叫び）",
  burst: "爆発",
  wavy: "ふるえ（恐れ・弱気）",
  flash: "ウニフラ（衝撃）",
  electric: "電子音（電話・機械）",
  dashed: "破線（ささやき）",
  none: "なし（文字だけ）",
  custom: "取り込んだ形",
};

export const TAIL_LABELS: Record<TailStyle, string> = {
  wedge: "三角",
  bubbles: "泡（思考）",
  line: "線（遠くの話者）",
  zigzag: "ギザギザ（電子音）",
};

/** Room between the text and the outline, in mm. */
const PAD = 3;

export function resolvedShape(line: Line): ResolvedShape {
  const shape = line.balloonShape ?? "auto";
  if (shape !== "auto") return shape;
  return autoShape(line.kind);
}

export function autoShape(kind: LineKind): ResolvedShape {
  switch (kind) {
    case "speech":
      return "ellipse";
    case "thought":
      return "cloud";
    case "narration":
      return "box";
    case "sfx":
    case "aside":
      return "none";
  }
}

/** The tail style a new tail gets: bubbles for thoughts, zigzag for electric voices. */
export function defaultTailStyle(line: Line): TailStyle {
  const shape = resolvedShape(line);
  if (shape === "cloud") return "bubbles";
  if (shape === "electric") return "zigzag";
  return "wedge";
}

interface Sample {
  angle: number;
  point: Point;
}

/** A balloon's outline as samples in increasing angle (-π..π) around `center`. */
export interface Star {
  center: Point;
  samples: Sample[];
}

/** Small deterministic noise so a burst keeps its shape between redraws. */
export function seeded(text: string): () => number {
  let h = 2166136261;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;

function wrap(angle: number): number {
  let a = angle % TAU;
  if (a <= -Math.PI) a += TAU;
  if (a > Math.PI) a -= TAU;
  return a;
}

/** Whether `angle` is within `half` of `center` (on the circle). */
function within(angle: number, center: number, half: number): boolean {
  return Math.abs(wrap(angle - center)) < half;
}

/** Distance from the centre to a convex polygon (centred at the origin) along a ray. */
function rayToPolygon(vertices: Point[], angle: number): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const [ax, ay] = vertices[i];
    const [bx, by] = vertices[(i + 1) % vertices.length];
    const ex = bx - ax;
    const ey = by - ay;
    const det = dx * -ey - dy * -ex;
    if (Math.abs(det) < 1e-12) continue;
    const t = (ax * -ey - ay * -ex) / det;
    const s = (dx * ay - dy * ax) / det;
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, t);
  }
  return Number.isFinite(best) ? best : 0;
}

/** The plain outline of a line's balloon (no tails, no links), or null for none. */
export function star(line: Line): Star | null {
  const shape = resolvedShape(line);
  if (shape === "none") return null;
  if (shape === "custom") return customStar(line.balloon);
  const [x0, y0, x1, y1] = line.box;
  const center = boxCenter(line.box);
  const hw = (x1 - x0) / 2;
  const hh = (y1 - y0) / 2;
  // An ellipse through the box corners, with some air (as before the shapes).
  const rx = hw * Math.SQRT2 + PAD;
  const ry = hh * Math.SQRT2 + PAD;
  const ellipse = (a: number) => 1 / Math.hypot(Math.cos(a) / rx, Math.sin(a) / ry);
  const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const random = seeded(line.id);
  let radius: (a: number, i: number) => number;
  let count = 64;
  const angles: number[] = [];
  switch (shape) {
    case "ellipse":
    case "dashed":
      radius = ellipse;
      break;
    case "box": {
      const bx = hw + PAD;
      const by = hh + PAD;
      const corners: Point[] = [
        [bx, by],
        [-bx, by],
        [-bx, -by],
        [bx, -by],
      ];
      for (const [cx, cy] of corners) angles.push(Math.atan2(cy, cx));
      radius = (a) => rayToPolygon(corners, a);
      break;
    }
    case "rounded": {
      const a = hw + PAD + 1;
      const b = hh + PAD + 1;
      const n = 5;
      radius = (t) => (Math.abs(Math.cos(t) / a) ** n + Math.abs(Math.sin(t) / b) ** n) ** (-1 / n);
      break;
    }
    case "polygon": {
      // Six corners, pointed at the top and bottom like the hand-drawn ones.
      const vertices: Point[] = [];
      for (let k = 0; k < 6; k++) {
        const a = -Math.PI / 2 + (k * TAU) / 6 + (random() - 0.5) * 0.12;
        vertices.push([Math.cos(a) * rx * 1.08, Math.sin(a) * ry * 1.08]);
      }
      for (const [vx, vy] of vertices) angles.push(Math.atan2(vy, vx));
      radius = (a) => rayToPolygon(vertices, a);
      break;
    }
    case "cloud": {
      const bumps = Math.max(7, Math.round(perimeter / 9));
      count = bumps * 8;
      radius = (a) => ellipse(a) * (0.93 + 0.13 * Math.abs(Math.sin((bumps * (a + Math.PI)) / 2)));
      break;
    }
    case "spike":
    case "flash":
    case "electric":
    case "burst": {
      const spacing = shape === "flash" ? 2.2 : shape === "burst" ? 9 : shape === "electric" ? 5 : 5.5;
      const spikes = Math.max(shape === "burst" ? 9 : 12, Math.round(perimeter / spacing));
      count = spikes * 2;
      const heights = Array.from({ length: spikes }, () => random());
      radius = (a, i) => {
        const base = ellipse(a);
        if (i % 2 === 0) return base * (shape === "burst" ? 0.92 : 1);
        const h = heights[(i - 1) / 2];
        if (shape === "spike") return base * (1.12 + 0.06 * h);
        if (shape === "flash") return base * (1.18 + 0.4 * h);
        if (shape === "electric") return base * 1.1;
        return base * (1.2 + 0.35 * h);
      };
      break;
    }
    case "wavy": {
      const waves = Math.max(16, Math.round(perimeter / 3.5));
      count = waves * 6;
      radius = (a) => ellipse(a) * (1 + 0.022 * Math.sin(waves * (a + Math.PI)));
      break;
    }
  }
  for (let i = 0; i < count; i++) angles.push(-Math.PI + (i * TAU) / count);
  // Electric voices step out and back at the same angle: square teeth.
  let samples: Sample[];
  if (shape === "electric") {
    samples = [];
    const teeth = count / 2;
    for (let k = 0; k < teeth; k++) {
      const a0 = -Math.PI + (k * TAU) / teeth;
      const a1 = a0 + TAU / teeth / 2;
      const inner = (a: number) => radius(a, 0);
      const outer = (a: number) => radius(a, 1);
      samples.push(at(center, a0, inner(a0)), at(center, a0 + 1e-6, outer(a0)), at(center, a1, outer(a1)), at(center, a1 + 1e-6, inner(a1)));
    }
  } else {
    // Corners (box, polygon) come first, then the even samples; spikes count by the latter.
    const corners = angles.length - count;
    samples = angles.map((angle, index) => at(center, angle, radius(angle, Math.max(index - corners, 0))));
  }
  return { center, samples: dedupeSamples(samples) };
}

function at(center: Point, angle: number, r: number): Sample {
  return { angle: wrap(angle), point: [center[0] + Math.cos(angle) * r, center[1] + Math.sin(angle) * r] };
}

function dedupeSamples(samples: Sample[]): Sample[] {
  const sorted = [...samples].sort((a, b) => a.angle - b.angle);
  return sorted.filter((s, i) => i === 0 || Math.hypot(s.point[0] - sorted[i - 1].point[0], s.point[1] - sorted[i - 1].point[1]) > 1e-6);
}

/** An imported outline, read as a star around its centroid. */
function customStar(points: Point[] | undefined): Star | null {
  if (!points || points.length < 3) return null;
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  const samples = points.map((point) => ({ angle: Math.atan2(point[1] - cy, point[0] - cx), point }));
  return { center: [cx, cy], samples: dedupeSamples(samples) };
}

/** Index of the sample at or just after `angle` going round. */
function nextIndex(samples: readonly Sample[], angle: number): number {
  let best = 0;
  let distance = Infinity;
  samples.forEach((sample, index) => {
    let d = wrap(sample.angle - angle);
    if (d < 0) d += TAU;
    if (d < distance) {
      distance = d;
      best = index;
    }
  });
  return best;
}

/** Index of the sample just before `angle` going round. */
function previousIndex(samples: readonly Sample[], angle: number): number {
  let best = 0;
  let distance = Infinity;
  samples.forEach((sample, index) => {
    let d = wrap(angle - sample.angle);
    if (d <= 0) d += TAU;
    if (d < distance) {
      distance = d;
      best = index;
    }
  });
  return best;
}

/** The outline's point in direction `angle`, between the two nearest samples. */
export function pointAt(s: Star, angle: number): Point {
  const a = wrap(angle);
  const list = s.samples;
  const p = list[previousIndex(list, a)];
  const q = list[nextIndex(list, a)];
  const span = wrap(q.angle - p.angle) || TAU;
  const t = span > 1e-9 ? wrap(a - p.angle) / span : 0;
  const rp = Math.hypot(p.point[0] - s.center[0], p.point[1] - s.center[1]);
  const rq = Math.hypot(q.point[0] - s.center[0], q.point[1] - s.center[1]);
  const r = rp + (rq - rp) * Math.min(Math.max(t, 0), 1);
  return [s.center[0] + Math.cos(a) * r, s.center[1] + Math.sin(a) * r];
}

function radiusAt(s: Star, angle: number): number {
  const p = pointAt(s, angle);
  return Math.hypot(p[0] - s.center[0], p[1] - s.center[1]);
}

/** A part drawn besides the outline: thought bubbles (closed) or a line tail (open). */
export interface Extra {
  points: Point[];
  closed: boolean;
}

/** Half the width of a tail where it leaves the balloon, in mm. */
function tailHalfWidth(line: Line): number {
  const [x0, y0, x1, y1] = line.box;
  return Math.min(Math.max(Math.min(x1 - x0, y1 - y0) * 0.18, 1.6), 4);
}

/** Whether a point is inside a line's balloon (its outline without tails). */
export function insideBalloon(line: Line, point: Point): boolean {
  const s = star(line);
  if (!s) return false;
  const angle = Math.atan2(point[1] - s.center[1], point[0] - s.center[0]);
  return Math.hypot(point[0] - s.center[0], point[1] - s.center[1]) <= radiusAt(s, angle);
}

/** Where a tail leaves the balloon and the middle of its curve (the handle that bends it). */
export function tailGeometry(line: Line, tail: Tail): { root: Point; middle: Point; normal: Point } | null {
  const s = star(line);
  if (!s) return null;
  const angle = Math.atan2(tail.tip[1] - s.center[1], tail.tip[0] - s.center[0]);
  const root = pointAt(s, angle);
  const [dx, dy] = [tail.tip[0] - root[0], tail.tip[1] - root[1]];
  const length = Math.hypot(dx, dy) || 1;
  const normal: Point = [-dy / length, dx / length];
  const bend = tail.bend ?? 0;
  return { root, middle: [(root[0] + tail.tip[0]) / 2 + normal[0] * bend, (root[1] + tail.tip[1]) / 2 + normal[1] * bend], normal };
}

/**
 * Points along a tail's side from `from` to the tip, bowed by the tail's
 * bend (its middle is `bend` mm off the straight line), without `from`.
 */
function bowed(from: Point, tip: Point, offset: Point, steps = 8): Point[] {
  // A quadratic whose middle is `offset` off the chord: control at twice it.
  const control: Point = [(from[0] + tip[0]) / 2 + offset[0] * 2, (from[1] + tip[1]) / 2 + offset[1] * 2];
  return Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    const u = 1 - t;
    return [u * u * from[0] + 2 * u * t * control[0] + t * t * tip[0], u * u * from[1] + 2 * u * t * control[1] + t * t * tip[1]] as Point;
  });
}

/** Splice wedge and zigzag tails into the outline; bubbles and lines become extras. */
export function withTails(s: Star, line: Line, tails: readonly Tail[] = line.tails ?? []): { star: Star; extras: Extra[] } {
  let samples = s.samples;
  const extras: Extra[] = [];
  for (const tail of tails) {
    const angle = Math.atan2(tail.tip[1] - s.center[1], tail.tip[0] - s.center[0]);
    const r = radiusAt(s, angle);
    const distance = Math.hypot(tail.tip[0] - s.center[0], tail.tip[1] - s.center[1]);
    if (distance <= r + 0.5) continue;
    const style = tail.style ?? "wedge";
    const root = pointAt(s, angle);
    // 曲がったしっぽ: the middle of the tail pushed `bend` mm to one side.
    const bend = tail.bend ?? 0;
    const along: Point = [tail.tip[0] - root[0], tail.tip[1] - root[1]];
    const length = Math.hypot(along[0], along[1]) || 1;
    const offset: Point = [(-along[1] / length) * bend, (along[0] / length) * bend];
    const curve = [root, ...bowed(root, tail.tip, offset, 16)];
    const alongCurve = (fraction: number): Point => curve[Math.min(curve.length - 1, Math.round(fraction * (curve.length - 1)))];
    if (style === "bubbles") {
      const sizes = [2.2, 1.5, 0.9];
      const fractions = [0.28, 0.6, 0.9];
      sizes.forEach((size, i) => extras.push({ points: circle(alongCurve(fractions[i]), size), closed: true }));
      continue;
    }
    if (style === "line") {
      extras.push({ points: bend ? curve : [root, tail.tip], closed: false });
      continue;
    }
    const half = Math.min(tailHalfWidth(line) / r, 0.6);
    const left = pointAt(s, angle - half);
    const right = pointAt(s, angle + half);
    const inserted: Sample[] = [{ angle: wrap(angle - half), point: left }];
    if (style === "zigzag") {
      // Two kinks between the root and the tip, like a lightning bolt.
      const mid: Point = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
      const dx = tail.tip[0] - mid[0];
      const dy = tail.tip[1] - mid[1];
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length;
      const ny = dx / length;
      const w = tailHalfWidth(line);
      const kink = (t: number, side: number): Point => [mid[0] + dx * t + nx * w * side, mid[1] + dy * t + ny * w * side];
      inserted.push({ angle: wrap(angle - half / 2), point: kink(0.35, 1.2) }, { angle: wrap(angle - half / 3), point: kink(0.55, -0.6) });
      inserted.push({ angle: wrap(angle), point: tail.tip });
      inserted.push({ angle: wrap(angle + half / 3), point: kink(0.6, -0.1) }, { angle: wrap(angle + half / 2), point: kink(0.4, 1.8) });
    } else if (bend) {
      // Both sides bow the same way; their points take angles in order across the tail.
      const out = bowed(left, tail.tip, offset);
      const back = [right, ...bowed(right, tail.tip, offset)].reverse().slice(1, -1);
      const points = [...out, ...back];
      points.forEach((point, i) => inserted.push({ angle: wrap(angle - half + (2 * half * (i + 1)) / (points.length + 1)), point }));
    } else {
      inserted.push({ angle: wrap(angle), point: tail.tip });
    }
    inserted.push({ angle: wrap(angle + half), point: right });
    samples = spliceArc(samples, angle, half, inserted);
  }
  return { star: { center: s.center, samples }, extras };
}

/** Replace the samples within `half` of `angle` by `inserted` (kept in their order). */
function spliceArc(samples: Sample[], angle: number, half: number, inserted: Sample[]): Sample[] {
  const kept = samples.filter((sample) => !within(sample.angle, angle, half));
  if (!kept.length) return inserted;
  // The arc goes before the first kept sample past it, going round.
  const index = nextIndex(kept, angle + half);
  return [...kept.slice(0, index), ...inserted, ...kept.slice(index)];
}

export function circle(center: Point, r: number, steps = 16): Point[] {
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * TAU;
    return [center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r] as Point;
  });
}

/** A balloon as drawn: one outline (several lines when linked) and its extras. */
export interface BalloonDrawing {
  /** The lines it carries, the first one deciding the look. */
  lines: Line[];
  shape: ResolvedShape;
  outline: Point[];
  extras: Extra[];
  inverted: boolean;
}

/**
 * All balloons of a page, with tails spliced in and linked balloons joined by
 * a neck into one outline. Lines without a balloon (描き文字, 小書き, なし)
 * give none.
 */
export function pageBalloons(page: Page): BalloonDrawing[] {
  const stars = new Map<string, { line: Line; star: Star; extras: Extra[] }>();
  for (const line of page.lines) {
    const s = star(line);
    if (!s) continue;
    const tailed = withTails(s, line);
    stars.set(line.id, { line, star: tailed.star, extras: tailed.extras });
  }
  // Groups of linked balloons (links in either direction).
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    while (parent.get(id) !== id) id = parent.get(id)!;
    return id;
  };
  for (const id of stars.keys()) parent.set(id, id);
  const links: [string, string][] = [];
  for (const { line } of stars.values()) {
    if (line.linkTo && stars.has(line.linkTo) && line.linkTo !== line.id) {
      links.push([line.linkTo, line.id]);
      parent.set(find(line.id), find(line.linkTo));
    }
  }
  const groups = new Map<string, string[]>();
  for (const line of page.lines) {
    if (!stars.has(line.id)) continue;
    const root = find(line.id);
    groups.set(root, [...(groups.get(root) ?? []), line.id]);
  }
  const result: BalloonDrawing[] = [];
  for (const ids of groups.values()) {
    const members = ids.map((id) => stars.get(id)!);
    const head = members[0].line;
    const groupLinks = links.filter(([a]) => ids.includes(a));
    let outline =
      members.length === 1
        ? members[0].star.samples.map((sample) => sample.point)
        : joinStars(new Map(members.map((m) => [m.line.id, m])), groupLinks);
    let extras = members.flatMap((m) => m.extras);
    // コマ枠でマスク: cut off at the panel's border.
    const panel = head.mask ? page.panels.find((p) => p.id === head.panel) : undefined;
    const clip = panel && maskShape(panel);
    if (clip) {
      outline = clipClosed(outline, clip);
      extras = extras.flatMap((extra) =>
        extra.closed
          ? [{ ...extra, points: clipClosed(extra.points, clip) }].filter((e) => e.points.length >= 3)
          : clipOpen(extra.points, clip).map((points) => ({ ...extra, points })),
      );
    }
    result.push({
      lines: members.map((m) => m.line),
      shape: resolvedShape(head),
      outline,
      extras,
      inverted: !!head.inverted,
    });
  }
  return result;
}

/** Half the width of the neck between linked balloons, in mm. */
const NECK = 2.2;

/**
 * Walk round the outlines of linked balloons as one: going round a balloon,
 * on reaching the arc that faces a linked one, cross the neck to it and go on
 * round that one, until back at the start.
 */
function joinStars(members: Map<string, { line: Line; star: Star }>, links: [string, string][]): Point[] {
  interface Portal {
    to: string;
    angle: number;
    half: number;
  }
  const portals = new Map<string, Portal[]>();
  for (const [a, b] of links) {
    const sa = members.get(a)!.star;
    const sb = members.get(b)!.star;
    const angle = Math.atan2(sb.center[1] - sa.center[1], sb.center[0] - sa.center[0]);
    const back = wrap(angle + Math.PI);
    const halfA = Math.min(NECK / Math.max(radiusAt(sa, angle), 1), 0.7);
    const halfB = Math.min(NECK / Math.max(radiusAt(sb, back), 1), 0.7);
    portals.set(a, [...(portals.get(a) ?? []), { to: b, angle, half: halfA }]);
    portals.set(b, [...(portals.get(b) ?? []), { to: a, angle: back, half: halfB }]);
  }
  // A sample right on each neck, so that the walk always meets it.
  for (const [id, list] of portals) {
    const member = members.get(id)!;
    const s = member.star;
    let samples = s.samples;
    for (const portal of list) {
      const index = nextIndex(samples, portal.angle);
      samples = [...samples.slice(0, index), { angle: wrap(portal.angle), point: pointAt(s, portal.angle) }, ...samples.slice(index)];
    }
    member.star = { center: s.center, samples };
  }
  const [startId] = members.keys();
  const out: Point[] = [];
  const startStar = members.get(startId)!.star;
  const free = (id: string, sample: Sample) => !(portals.get(id) ?? []).some((p) => within(sample.angle, p.angle, p.half));
  let current = startId;
  let index = startStar.samples.findIndex((sample) => free(startId, sample));
  if (index < 0) return startStar.samples.map((sample) => sample.point);
  const startIndex = index;
  const limit = [...members.values()].reduce((sum, m) => sum + m.star.samples.length, 0) * 2 + 8;
  for (let step = 0; step < limit; step++) {
    const s = members.get(current)!.star;
    const sample = s.samples[index];
    const portal = (portals.get(current) ?? []).find((p) => within(sample.angle, p.angle, p.half));
    if (portal) {
      // Cross the neck: from this side's edge of the arc to the matching edge over there.
      out.push(pointAt(s, portal.angle - portal.half));
      const other = members.get(portal.to)!.star;
      const back = (portals.get(portal.to) ?? []).find((p) => p.to === current)!;
      out.push(pointAt(other, back.angle + back.half));
      current = portal.to;
      // Continue after the arc facing where we came from.
      index = nextIndex(other.samples, back.angle + back.half);
      if (within(other.samples[index].angle, back.angle, back.half)) index = (index + 1) % other.samples.length;
      continue;
    }
    if (current === startId && index === startIndex && step > 0) break;
    out.push(sample.point);
    index = (index + 1) % s.samples.length;
  }
  return out;
}

/** The plain outline stored with the line (what readers without the styles get). */
export function storedOutline(line: Line): Point[] | undefined {
  const shape = resolvedShape(line);
  if (shape === "custom") return line.balloon;
  const s = star(line);
  return s ? s.samples.map((sample) => sample.point) : undefined;
}

/** The box a line takes on the page with its balloon (without tails). */
export function balloonExtent(line: Line): BoxMm {
  const s = star(line);
  if (!s || !s.samples.length) return line.box;
  const xs = s.samples.map((sample) => sample.point[0]);
  const ys = s.samples.map((sample) => sample.point[1]);
  return [Math.min(...xs, line.box[0]), Math.min(...ys, line.box[1]), Math.max(...xs, line.box[2]), Math.max(...ys, line.box[3])];
}

// 背景 on the page: a picture laid on it (資料, ネーム画像, a panel's
// background cut to the panel), and 背景の指示 over the panels — the eye level
// in green, the X・Y・Z lines and the lines to each vanishing point in red,
// blue and purple, the things named in orange. The screen, the flat pages (読む, PDF, ミニネーム), the CSP layers
// and the pictures sent with a request all draw them here.
import { bounds } from "../model/geometry";
import type { Page, Panel, ReferenceImage } from "../model/model";
import { backgroundClip, backgroundOf, boxCorners, horizonAcross, isBackground } from "../domain/background";
import { AXIS_COLORS, GUIDE_AXES, axisOf, horizonEnds, horizonReach, horizonTilt, rulerOf, type Ruler } from "../domain/bgruler";
import { tracePath, type MmToPx } from "./pagedraw";

export const GUIDE_GREEN = "#1f9d55";
export const GUIDE_ORANGE = "#d9730d";

/**
 * A picture where its reference lies, at `alpha`: a background only inside
 * its panel (and not at all when the panel is gone).
 */
export function drawPicture(
  ctx: CanvasRenderingContext2D,
  page: Page,
  reference: ReferenceImage,
  picture: CanvasImageSource,
  m: MmToPx,
  alpha: number,
): void {
  const clip = isBackground(reference) ? backgroundClip(page, reference) : null;
  if (isBackground(reference) && !clip) return;
  const [x0, y0, x1, y1] = reference.box;
  ctx.save();
  if (clip) {
    tracePath(ctx, clip, m, true);
    ctx.clip();
  }
  ctx.globalAlpha = alpha;
  ctx.drawImage(picture, m.x + x0 * m.scale, m.y + y0 * m.scale, (x1 - x0) * m.scale, (y1 - y0) * m.scale);
  ctx.restore();
}

/** Where a vanishing point beyond the panel lies, marked on the panel's edge: an arrow towards it and its name. */
function edgeMark(
  ctx: CanvasRenderingContext2D,
  [x0, y0, x1, y1]: [number, number, number, number],
  point: readonly number[],
  label: string,
  toPx: (p: readonly number[]) => [number, number],
  px: number,
): void {
  // The nearest point of the panel's box: a point beyond the side on the eye level stays on it.
  const [nx, ny] = [Math.min(x1, Math.max(x0, point[0])), Math.min(y1, Math.max(y0, point[1]))];
  const [ex, ey] = toPx([nx, ny]);
  const [dx, dy] = [point[0] - nx, point[1] - ny];
  const angle = Math.atan2(dy, dx);
  const size = 10 * px;
  const [tx, ty] = [ex - Math.cos(angle) * 3 * px, ey - Math.sin(angle) * 3 * px];
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - Math.cos(angle - 0.45) * size, ty - Math.sin(angle - 0.45) * size);
  ctx.lineTo(tx - Math.cos(angle + 0.45) * size, ty - Math.sin(angle + 0.45) * size);
  ctx.closePath();
  ctx.fill();
  const width = ctx.measureText(label).width;
  const lx = Math.cos(angle) > 0.3 ? tx - size - width - 2 * px : tx + (Math.cos(angle) < -0.3 ? size + 2 * px : -width / 2);
  const ly = Math.sin(angle) > 0.3 ? ty - size : ty + (Math.sin(angle) < -0.3 ? size + 12 * px : -2 * px);
  ctx.fillText(label, lx, ly);
}

/** Lines from each vanishing point across a panel: this many, spread over the panel's corners. */
const RAYS = 7;

/**
 * 背景の指示 of the panels on `page` (or only `only`): the eye level across
 * the panel, the X・Y・Z lines and faint lines to each vanishing point inside
 * it, the points (an arrow on the panel's edge for one beyond it), each
 * thing's outline and name. `px`: how big one screen pixel is in the target
 * (lines and words keep their size).
 */
/** The eye level beyond the panel (fainter, on to its points), its ends to turn it by, and its name with how far it leans. */
function drawHorizonBeyond(
  ctx: CanvasRenderingContext2D,
  panel: Panel,
  ruler: Ruler,
  toPx: (point: readonly number[]) => [number, number],
  px: number,
): void {
  const horizon = ruler.horizon!;
  const [a, b] = horizon;
  ctx.save();
  ctx.strokeStyle = GUIDE_GREEN;
  ctx.fillStyle = GUIDE_GREEN;
  if (Math.abs(b[0] - a[0]) > 1e-6) {
    const slope = (b[1] - a[1]) / (b[0] - a[0]);
    const [xa, xb] = horizonReach(panel, ruler);
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([10 * px, 5 * px]);
    ctx.beginPath();
    ctx.moveTo(...toPx([xa, a[1] + (xa - a[0]) * slope]));
    ctx.lineTo(...toPx([xb, a[1] + (xb - a[0]) * slope]));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Its ends at the panel's sides: dragged, they turn it.
  ctx.globalAlpha = 0.95;
  const ends = horizonEnds(panel, horizon).map(toPx);
  for (const [hx, hy] of ends) {
    ctx.beginPath();
    ctx.arc(hx, hy, 5 * px, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }
  // Under the line at the right end: a point beyond the panel's side is marked on it, above.
  const [lx, ly] = ends[1];
  const kind = ruler.vanishing.length ? `（${ruler.vanishing.length}点透視）` : "";
  const tilt = Math.round(horizonTilt(horizon));
  ctx.font = `bold ${12 * px}px sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "right";
  ctx.fillText(`アイレベル${kind}${tilt ? ` 傾き ${Math.abs(tilt)}°` : ""}`, lx - 10 * px, ly + 5 * px);
  ctx.restore();
}

export function drawBackgroundGuides(ctx: CanvasRenderingContext2D, page: Page, m: MmToPx, px = 1, only?: Panel): void {
  for (const panel of only ? [only] : page.panels) {
    const bg = backgroundOf(panel);
    const ruler = rulerOf(panel);
    if (!ruler.horizon && !bg.objects?.length) continue;
    const toPx = ([x, y]: readonly number[]): [number, number] => [m.x + x * m.scale, m.y + y * m.scale];
    ctx.save();
    ctx.lineCap = "round";
    ctx.font = `bold ${12 * px}px sans-serif`;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    // Lines to the vanishing points, the X・Y・Z lines and the eye level, inside the panel.
    ctx.save();
    tracePath(ctx, panel.shape, m, true);
    ctx.clip();
    const [x0, y0, x1, y1] = bounds(panel.shape);
    ruler.vanishing.forEach((point, index) => {
      ctx.strokeStyle = AXIS_COLORS[axisOf(index)];
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1 * px;
      ctx.beginPath();
      const [vx, vy] = toPx(point);
      for (let i = 0; i < RAYS; i++) {
        // Towards points along the panel's far sides, so the lines fan across it.
        const t = i / (RAYS - 1);
        const far: [number, number] =
          Math.abs(point[0] - (x0 + x1) / 2) > Math.abs(point[1] - (y0 + y1) / 2)
            ? [point[0] < x0 ? x1 : x0, y0 + (y1 - y0) * t]
            : [x0 + (x1 - x0) * t, point[1] < y0 ? y1 : y0];
        ctx.moveTo(vx, vy);
        ctx.lineTo(...toPx(far));
      }
      ctx.stroke();
    });
    ctx.globalAlpha = 0.9;
    if (ruler.horizon) {
      const [a, b] = horizonAcross(panel, ruler.horizon);
      ctx.strokeStyle = GUIDE_GREEN;
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([10 * px, 5 * px]);
      ctx.beginPath();
      ctx.moveTo(...toPx(a));
      ctx.lineTo(...toPx(b));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
    if (ruler.horizon) drawHorizonBeyond(ctx, panel, ruler, toPx, px);
    // The X・Y・Z lines, each with its ends to drag.
    ruler.guides.forEach((line, k) => {
      const axis = GUIDE_AXES[k];
      ctx.strokeStyle = AXIS_COLORS[axis];
      ctx.fillStyle = AXIS_COLORS[axis];
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 2.5 * px;
      const [a, b] = [toPx(line[0]), toPx(line[1])];
      ctx.beginPath();
      ctx.moveTo(...a);
      ctx.lineTo(...b);
      ctx.stroke();
      const r = 4 * px;
      for (const [hx, hy] of [a, b]) ctx.fillRect(hx - r, hy - r, r * 2, r * 2);
      ctx.fillText(axis, a[0] + 6 * px, a[1] - 4 * px);
    });
    // The vanishing points themselves (often beyond the panel).
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2 * px;
    ruler.vanishing.forEach((point, i) => {
      const color = AXIS_COLORS[axisOf(i)];
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      const [vx, vy] = toPx(point);
      const r = 6 * px;
      ctx.beginPath();
      ctx.arc(vx, vy, r, 0, Math.PI * 2);
      ctx.moveTo(vx - r * 1.8, vy);
      ctx.lineTo(vx + r * 1.8, vy);
      ctx.moveTo(vx, vy - r * 1.8);
      ctx.lineTo(vx, vy + r * 1.8);
      ctx.stroke();
      const label = `消失点${i + 1}（${axisOf(i)}）`;
      ctx.fillText(label, vx + r + 2 * px, vy - r);
      if (point[0] < x0 || point[0] > x1 || point[1] < y0 || point[1] > y1) edgeMark(ctx, [x0, y0, x1, y1], point, label, toPx, px);
    });
    // The things, each its outline and name.
    ctx.strokeStyle = GUIDE_ORANGE;
    ctx.fillStyle = GUIDE_ORANGE;
    for (const object of bg.objects ?? []) {
      ctx.setLineDash([6 * px, 3 * px]);
      tracePath(ctx, object.shape, m, true);
      ctx.stroke();
      ctx.setLineDash([]);
      // Its corners, to size it by.
      const r = 3 * px;
      for (const corner of boxCorners(object.shape)) {
        const [hx, hy] = toPx(corner);
        ctx.fillRect(hx - r, hy - r, r * 2, r * 2);
      }
      const [ox, oy] = toPx([bounds(object.shape)[0], bounds(object.shape)[1]]);
      ctx.fillText(object.label, ox + 3 * px, oy + 15 * px);
    }
    ctx.restore();
  }
}

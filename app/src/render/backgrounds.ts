// 背景 on the page: a picture laid on it (資料, ネーム画像, a panel's
// background cut to the panel), and 背景の指示 over the panels — the eye level
// and the lines to each vanishing point in green, the things named in
// orange. The screen, the flat pages (読む, PDF, ミニネーム), the CSP layers
// and the pictures sent with a request all draw them here.
import { bounds } from "../model/geometry";
import type { Page, Panel, ReferenceImage } from "../model/model";
import { backgroundClip, backgroundOf, horizonAcross, isBackground } from "../domain/background";
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

/** Lines from each vanishing point across a panel: this many, spread over the panel's corners. */
const RAYS = 7;

/**
 * 背景の指示 of the panels on `page` (or only `only`): the eye level across
 * the panel, lines to each vanishing point inside it, each thing's outline
 * and name. `px`: how big one screen pixel is in the target (lines and words keep their size).
 */
export function drawBackgroundGuides(ctx: CanvasRenderingContext2D, page: Page, m: MmToPx, px = 1, only?: Panel): void {
  for (const panel of only ? [only] : page.panels) {
    const bg = backgroundOf(panel);
    if (!bg.horizon && !bg.vanishing?.length && !bg.objects?.length) continue;
    const toPx = ([x, y]: readonly number[]): [number, number] => [m.x + x * m.scale, m.y + y * m.scale];
    ctx.save();
    ctx.lineCap = "round";
    ctx.font = `bold ${12 * px}px sans-serif`;
    ctx.textBaseline = "bottom";
    // Lines to the vanishing points, and the eye level, inside the panel.
    ctx.save();
    tracePath(ctx, panel.shape, m, true);
    ctx.clip();
    ctx.strokeStyle = GUIDE_GREEN;
    const [x0, y0, x1, y1] = bounds(panel.shape);
    for (const point of bg.vanishing ?? []) {
      ctx.globalAlpha = 0.45;
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
    }
    ctx.globalAlpha = 0.9;
    if (bg.horizon) {
      const [a, b] = horizonAcross(panel, bg.horizon);
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([10 * px, 5 * px]);
      ctx.beginPath();
      ctx.moveTo(...toPx(a));
      ctx.lineTo(...toPx(b));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = GUIDE_GREEN;
      const [lx, ly] = toPx(a);
      ctx.fillText("アイレベル", lx + 4 * px, ly - 2 * px);
    }
    ctx.restore();
    // The vanishing points themselves (often beyond the panel).
    ctx.strokeStyle = GUIDE_GREEN;
    ctx.fillStyle = GUIDE_GREEN;
    ctx.lineWidth = 2 * px;
    (bg.vanishing ?? []).forEach((point, i) => {
      const [vx, vy] = toPx(point);
      const r = 6 * px;
      ctx.beginPath();
      ctx.arc(vx, vy, r, 0, Math.PI * 2);
      ctx.moveTo(vx - r * 1.8, vy);
      ctx.lineTo(vx + r * 1.8, vy);
      ctx.moveTo(vx, vy - r * 1.8);
      ctx.lineTo(vx, vy + r * 1.8);
      ctx.stroke();
      ctx.fillText(`消失点${i + 1}`, vx + r + 2 * px, vy - r);
    });
    // The things, each its outline and name.
    ctx.strokeStyle = GUIDE_ORANGE;
    ctx.fillStyle = GUIDE_ORANGE;
    for (const object of bg.objects ?? []) {
      ctx.setLineDash([6 * px, 3 * px]);
      tracePath(ctx, object.shape, m, true);
      ctx.stroke();
      ctx.setLineDash([]);
      const [ox, oy] = toPx([bounds(object.shape)[0], bounds(object.shape)[1]]);
      ctx.fillText(object.label, ox + 3 * px, oy + 15 * px);
    }
    ctx.restore();
  }
}

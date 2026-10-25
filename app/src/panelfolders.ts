// マスク付きフォルダー: each panel as a CSP folder with a レイヤーマスク, so
// what is drawn in it shows only inside the panel and the はみ出し that reach
// into it. The mask hides rather than cuts: a rough line that runs past the
// border stays whole in its panel's folder, and a 飛び出し is made in CSP by
// painting the mask wider.
import { insidePolygon } from "./geometry";
import { bleedOutline, stacked } from "./koma";
import type { Page, PageFormat, Panel, Point, Stroke } from "./model";
import { tracePath, type MmToPx } from "./pagedraw";
import { segmentTouches } from "./project";

/** Folders are named コマ1, コマ2, … in reading order. */
export const PANEL_FOLDER_PREFIX = "コマ";

/** A page of an export unit and where it goes on the CSP page. */
export interface PlacedName {
  page: Page;
  m: MmToPx;
  right: boolean;
}

/** One panel on one page of the unit, with the rough strokes it holds. */
export interface PanelPart extends PlacedName {
  panel: Panel;
  strokes: Stroke[];
}

/** A panel written as a folder: one panel, or both halves of a 見開きコマ on a spread page. */
export interface PanelFolder {
  name: string;
  parts: PanelPart[];
}

/** Whether two polygons share any area (or touch). */
function overlaps(a: readonly Point[], b: readonly Point[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  if (insidePolygon(a, b[0]) || insidePolygon(b, a[0])) return true;
  return a.some((point, i) => segmentTouches(b, point, a[(i + 1) % a.length]));
}

/**
 * Where a panel's folder shows: the panel (its 裁ち切り edges past the
 * canvas) and the はみ出し that reach into it.
 */
export function panelArea(page: Page, panel: Panel, format: PageFormat): Point[][] {
  const breakouts = (page.breakouts ?? []).map((breakout) => breakout.shape).filter((shape) => overlaps(shape, panel.shape));
  return [bleedOutline(panel, format).outline, ...breakouts];
}

/** The panels stacked above `panel` over it (insets, はめ込み): its folder does not show under them. */
export function panelsAbove(page: Page, panel: Panel): Point[][] {
  return page.panels
    .filter((other) => other !== panel && (other.z ?? 0) > (panel.z ?? 0) && overlaps(other.shape, panel.shape))
    .map((other) => other.shape);
}

/**
 * The panel a rough stroke belongs in: the one whose area (see `panelArea`)
 * holds most of its points, an inset before the panel under it; none for a
 * stroke outside every panel, or one drawn over the borders (`over`).
 */
export function strokePanel(page: Page, stroke: Stroke, format: PageFormat): Panel | undefined {
  if (stroke.over) return undefined;
  let best: Panel | undefined;
  let most = 0;
  // Top first, so that on a tie the panel above wins.
  for (const panel of stacked(page.panels).reverse()) {
    if (panel.shape.length < 3) continue;
    const area = panelArea(page, panel, format);
    const count = stroke.points.filter(([x, y]) => area.some((shape) => insidePolygon(shape, [x, y]))).length;
    if (count > most) {
      best = panel;
      most = count;
    }
  }
  return best;
}

/**
 * The panels of an export unit's pages as folders in reading order, each
 * with the rough strokes it holds, and the strokes left in no panel (by
 * page). The two halves of a 見開きコマ on one spread page share a folder.
 */
export function panelFolders(placed: readonly PlacedName[], format: PageFormat): { folders: PanelFolder[]; loose: Stroke[][] } {
  const folders: PanelFolder[] = [];
  const bySpread = new Map<string, PanelFolder>();
  const loose: Stroke[][] = [];
  for (const place of placed) {
    const { page } = place;
    const strokes = new Map<string, Stroke[]>();
    const left: Stroke[] = [];
    for (const stroke of page.strokes) {
      const panel = strokePanel(page, stroke, format);
      if (panel) strokes.set(panel.id, [...(strokes.get(panel.id) ?? []), stroke]);
      else left.push(stroke);
    }
    loose.push(left);
    for (const panel of [...page.panels].sort((a, b) => a.order - b.order)) {
      if (panel.shape.length < 3) continue;
      const part: PanelPart = { ...place, panel, strokes: strokes.get(panel.id) ?? [] };
      const half = panel.spread && placed.length > 1 ? bySpread.get(panel.spread) : undefined;
      if (half) {
        half.parts.push(part);
        continue;
      }
      const folder: PanelFolder = { name: `${PANEL_FOLDER_PREFIX}${folders.length + 1}`, parts: [part] };
      folders.push(folder);
      if (panel.spread) bySpread.set(panel.spread, folder);
    }
  }
  return { folders, loose };
}

/**
 * Draw a folder's mask (opaque where it shows) on a clear canvas; `clip`
 * keeps each page's part to its own half of a spread page.
 */
export function drawPanelMask(
  ctx: CanvasRenderingContext2D,
  folder: PanelFolder,
  format: PageFormat,
  scale: (m: MmToPx) => MmToPx,
  clip: (right: boolean, draw: () => void) => void,
): void {
  for (const { page, m, right, panel } of folder.parts) {
    const at = scale(m);
    clip(right, () => {
      ctx.save();
      ctx.fillStyle = "#000";
      for (const shape of panelArea(page, panel, format)) {
        tracePath(ctx, shape, at, true);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "destination-out";
      for (const shape of panelsAbove(page, panel)) {
        tracePath(ctx, shape, at, true);
        ctx.fill();
      }
      ctx.restore();
    });
  }
}

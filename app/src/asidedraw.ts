// 欄外 on the editor's screen: what lies beside each page (aside.ts), drawn
// in the room around it. Rough lines and 資料画像 lie on the desk, under the
// pages (each page covers what reaches over it); held panels and 付箋 lie
// on top, as cut-outs and notes put down beside the sheet.
import { heldBeside, heldBox, reachesOff, strokeBox } from "./aside";
import { bounds } from "./geometry";
import type { HeldPanel, Page, Project } from "./model";
import type { Slot } from "./layout";
import { ACCENT, drawSticky } from "./notedraw";
import { drawBalloons, drawLineText, drawMarks, drawPageFills, drawPanelBorders, drawPanelFills, drawStrokes, INK, tracePath, type MmToPx } from "./pagedraw";
import { pictureOf } from "./pictures";
import { drawGoingTo } from "./screendraw";
import { imageOf, opacityOf } from "./references";
import { markColor, markLayersOf, opacityOfLayer, roughLayersOf, strokesOn, withoutMarks } from "./roughlayers";
import { stickyBox } from "./stickies";

/** What the 欄外 shows of the editor's state. */
export interface AsideMarks {
  /** The page as shown (without what the レイヤー list hides). */
  visible(page: Page): Page;
  selected(page: Page, kind: "stroke" | "sticky", id: string): boolean;
  /** The size of a sticky's link handle, when stickies can be linked (null: none). */
  stickyHandle: number | null;
  /** The held panel being dragged, and the page it goes onto when let go. */
  held: { heldId: string; to: Slot | null } | null;
  /** A picture finished loading: draw again. */
  redraw(): void;
  /** The 資料 tool: the pictures' outlines (and the chosen one's corners). */
  referenceFrames?(slot: Slot): void;
}

/** Colour of what is 保留. */
export const HELD_COLOR = "#c46a12";

/** Every page's 欄外, for the pages laid out in `slots`. */
export function drawAside(ctx: CanvasRenderingContext2D, project: Project, slots: readonly Slot[], marks: AsideMarks): void {
  const pageH = project.pageFormat.canvasMm[1];
  ctx.save();
  // The pages lie over the room around them.
  ctx.beginPath();
  ctx.rect(-1e5, -1e5, 2e5, 2e5);
  for (const slot of slots) ctx.rect(slot.x + slot.shown[0] * slot.scale, slot.y, (slot.shown[1] - slot.shown[0]) * slot.scale, pageH * slot.scale);
  ctx.clip("evenodd");
  for (const slot of slots) drawUnder(ctx, project, slot, marks.visible(slot.page), marks);
  ctx.restore();
  for (const slot of slots) {
    if (marks.referenceFrames && slot.page.references?.some((reference) => reachesOff(reference.box, project.pageFormat))) marks.referenceFrames(slot);
    for (const held of heldBeside(project, slot.page)) drawHeld(ctx, project, slot, held, marks.held?.heldId === held.id);
    const page = marks.visible(slot.page);
    for (const sticky of page.stickies ?? []) {
      if (reachesOff(stickyBox(sticky), project.pageFormat)) drawSticky(ctx, slot, sticky, marks.selected(page, "sticky", sticky.id), marks.stickyHandle);
    }
  }
  const to = marks.held?.to;
  if (to) drawGoingTo(ctx, project, to, `${to.index + 1} ページへ置く`);
}

/** 資料画像 and rough lines reaching past the page's edges. */
function drawUnder(ctx: CanvasRenderingContext2D, project: Project, slot: Slot, page: Page, marks: AsideMarks): void {
  const format = project.pageFormat;
  const m: MmToPx = { scale: slot.scale, x: slot.x, y: slot.y };
  for (const reference of page.references ?? []) {
    if (!reachesOff(reference.box, format)) continue;
    const stored = imageOf(project, reference);
    const picture = stored && pictureOf(stored, marks.redraw);
    if (!picture) continue;
    const [x0, y0, x1, y1] = reference.box;
    ctx.globalAlpha = opacityOf(reference);
    ctx.drawImage(picture, m.x + x0 * m.scale, m.y + y0 * m.scale, (x1 - x0) * m.scale, (y1 - y0) * m.scale);
  }
  ctx.globalAlpha = 1;
  const out = page.strokes.filter((stroke) => reachesOff(strokeBox(stroke), format));
  if (!out.length) return;
  const color = (stroke: { id: string }) => (marks.selected(page, "stroke", stroke.id) ? ACCENT : "#3a3834");
  // The rough's lines, then the 指示 (in their colours) over them.
  for (const layer of [...roughLayersOf(project), ...markLayersOf(project)]) {
    const strokes = strokesOn(project, out, layer);
    if (!strokes.length) continue;
    ctx.globalAlpha = opacityOfLayer(layer);
    const ink = layer.marks ? (stroke: { id: string }) => (marks.selected(page, "stroke", stroke.id) ? ACCENT : markColor(layer)) : color;
    for (const over of [false, true]) drawStrokes(ctx, { ...page, strokes }, m, over, ink, 0.7, project.brushes ?? []);
  }
  ctx.globalAlpha = 1;
}

/** A held panel laid beside its page: the panel and what is in it, cut out, with a 保留 tag. */
function drawHeld(ctx: CanvasRenderingContext2D, project: Project, slot: Slot, held: HeldPanel, dragging: boolean): void {
  const box = heldBox(held);
  if (!box) return;
  const [ox, oy] = bounds(held.panel.shape);
  const m: MmToPx = { scale: slot.scale, x: slot.x + (box[0] - ox) * slot.scale, y: slot.y + (box[1] - oy) * slot.scale };
  const page = heldPage(held);
  const brushes = project.brushes ?? [];
  ctx.save();
  tracePath(ctx, held.panel.shape, m, true);
  ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
  ctx.shadowBlur = dragging ? 10 : 4;
  ctx.shadowOffsetY = dragging ? 3 : 1;
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
  ctx.save();
  tracePath(ctx, held.panel.shape, m, true);
  ctx.clip();
  const rough = { ...page, strokes: withoutMarks(project, page.strokes) };
  drawPageFills(ctx, page, m, undefined, true);
  drawStrokes(ctx, rough, m, false, () => "#3a3834", 0.7, brushes);
  drawPanelFills(ctx, page, m);
  drawPageFills(ctx, page, m);
  ctx.restore();
  drawPanelBorders(ctx, page, m, () => INK);
  drawStrokes(ctx, rough, m, true, () => "#3a3834", 0.7, brushes);
  drawBalloons(ctx, page, m);
  for (const line of page.lines) drawLineText(ctx, line, m);
  drawMarks(ctx, project, page, m, 0.7);
  // Marked as not on any page yet.
  const [x0, y0, x1, y1] = box.map((v, i) => (i % 2 ? slot.y : slot.x) + v * slot.scale);
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = dragging ? ACCENT : HELD_COLOR;
  ctx.lineWidth = dragging ? 2 : 1.5;
  ctx.strokeRect(x0 - 4, y0 - 4, x1 - x0 + 8, y1 - y0 + 8);
  ctx.setLineDash([]);
  // Seen from afar, the tag says only what it is.
  const memo = x1 - x0 >= 120 ? held.panel.note?.split("\n")[0] : "";
  const label = memo ? `保留 ${memo}` : "保留";
  ctx.font = "12px system-ui, sans-serif";
  const most = Math.max(2, Math.floor((x1 - x0) / 12));
  const text = label.length > most ? `${label.slice(0, most)}…` : label;
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = dragging ? ACCENT : HELD_COLOR;
  ctx.fillRect(x0 - 4, y0 - 22, w, 18);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x0 + 1, y0 - 13);
  ctx.restore();
}

/** A held panel's contents as a page of their own, to draw with the page's drawing. */
export function heldPage(held: HeldPanel): Page {
  return {
    id: held.id,
    memo: "",
    panels: [held.panel],
    lines: held.lines,
    strokes: held.strokes,
    roughs: [],
    breakouts: [],
    ...(held.fills ? { fills: held.fills } : {}),
  };
}

/** The held panel laid beside a page whose box (with its tag) is under a screen point, topmost first. */
export function heldAt(project: Project, slots: readonly Slot[], sx: number, sy: number): { slot: Slot; held: HeldPanel } | null {
  for (const slot of [...slots].reverse()) {
    for (const held of [...heldBeside(project, slot.page)].reverse()) {
      const box = heldBox(held);
      if (!box) continue;
      const [x0, y0, x1, y1] = box.map((v, i) => (i % 2 ? slot.y : slot.x) + v * slot.scale);
      if (sx >= x0 - 4 && sx <= x1 + 4 && sy >= y0 - 22 && sy <= y1 + 4) return { slot, held };
    }
  }
  return null;
}

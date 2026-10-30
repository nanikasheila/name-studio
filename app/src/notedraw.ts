// What the page editor draws over the pages for the person only, never in an
// export: a panel's memo on a pale tag in its corner, 付箋, and the leader
// lines that tie them to what they are about. Screen px; `slot` maps a page's
// millimetres to the screen.
import { balloonExtent } from "./balloon";
import { bounds } from "./geometry";
import type { Slot } from "./layout";
import type { BoxMm, PageFormat, Panel, Point, Sticky } from "./model";
import { trimBox } from "./pagebox";
import { STICKY_COLORS, STICKY_TEXT_MM, stickyAnchor, stickyBox, stickyRows } from "./stickies";

/** The editor's colour for what is selected or in hand. */
export const ACCENT = "#2f6fdb";
export const NOTE_FONT = '12px "Yu Gothic UI", "Yu Gothic", "Hiragino Sans", "Noto Sans JP", sans-serif';
export const NOTE_ROW = 16;

export interface NoteBox {
  x: number;
  y: number;
  w: number;
  h: number;
  rows: string[];
}

/** What does not begin a row (行頭禁則): a mark that closes or ends what is before it. */
const NOT_FIRST = new Set([..."、。，．,.・：；:;！？!?）)」』】〕］]｝}〉》ー～ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ…‥"]);

/** Each letter's width in a font (px), measured once: a row is as wide as its letters, so wrapping a long memo stays quick. */
const letterWidths = new Map<string, Map<string, number>>();

function letterWidth(ctx: CanvasRenderingContext2D, char: string): number {
  let widths = letterWidths.get(ctx.font);
  if (!widths) letterWidths.set(ctx.font, (widths = new Map()));
  let width = widths.get(char);
  if (width === undefined) widths.set(char, (width = ctx.measureText(char).width));
  return width;
}

/** Break `text` into rows no wider than `width` px, at most `max` rows (the last ends in …). */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const rows: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let row: string[] = [];
    let rowWidth = 0;
    for (const char of paragraph) {
      const charWidth = letterWidth(ctx, char);
      if (row.length && rowWidth + charWidth > width) {
        // A row does not begin with 。 and the like: the last letter before it goes down with it (追い出し).
        const carried = NOT_FIRST.has(char) && row.length > 1 && !NOT_FIRST.has(row[row.length - 1]) ? [row.pop()!] : [];
        rows.push(row.join(""));
        row = carried;
        rowWidth = carried.reduce((sum, c) => sum + letterWidth(ctx, c), 0);
      }
      row.push(char);
      rowWidth += charWidth;
    }
    rows.push(row.join(""));
  }
  if (rows.length <= max) return rows;
  const kept = rows.slice(0, max);
  kept[max - 1] = `${kept[max - 1].slice(0, -1)}…`;
  return kept;
}

/** Where a panel's memo sits on screen: inside its top-left corner, as wide as the panel allows. */
export function noteBox(ctx: CanvasRenderingContext2D, slot: Slot, panel: Panel, format: PageFormat | undefined): NoteBox {
  // On the paper: a 裁ち切り panel's tag sits inside the trim, not out in the bleed.
  const [tx0, ty0, tx1, ty1] = format ? trimBox(format) : [-Infinity, 0, Infinity, Infinity];
  const [x0, y0, x1, y1] = bounds(panel.shape);
  const left = Math.max(x0, slot.shown[0], tx0);
  const right = Math.min(x1, slot.shown[1], tx1);
  const top = Math.max(y0, 0, ty0);
  const bottom = Math.min(y1, ty1);
  // Leave room for the panel's number at the top right.
  const room = Math.max(60, Math.min((right - left) * slot.scale - 8 - 2 * Math.max(4 * slot.scale, 7) - 6, 280));
  ctx.font = NOTE_FONT;
  const rows = panel.note ? wrapText(ctx, panel.note, room - 10, 4) : [];
  const w = rows.length ? Math.min(room, Math.max(...rows.map((row) => ctx.measureText(row).width)) + 10) : 52;
  const h = Math.max(rows.length, 1) * NOTE_ROW + 4;
  // The top left corner, or another one when dialogue is there (balloons start at the top right).
  const [sl, sr, st, sb] = [slot.x + left * slot.scale + 4, slot.x + right * slot.scale - 4 - w, slot.y + top * slot.scale + 4, slot.y + bottom * slot.scale - 4 - h];
  const corners: [number, number][] = [
    [sl, st],
    [sl, sb],
    [sr, sb],
  ];
  const balloons = slot.page.lines
    .filter((line) => line.panel === panel.id)
    .map((line) => {
      const [bx0, by0, bx1, by1] = balloonExtent(line);
      return [slot.x + bx0 * slot.scale, slot.y + by0 * slot.scale, slot.x + bx1 * slot.scale, slot.y + by1 * slot.scale];
    });
  const clear = ([x, y]: [number, number]) => balloons.every(([bx0, by0, bx1, by1]) => x + w < bx0 || x > bx1 || y + h < by0 || y > by1);
  // Moved by hand: where it was put, wherever the panel goes.
  if (panel.noteAt) return { x: slot.x + (x0 + panel.noteAt[0]) * slot.scale, y: slot.y + (y0 + panel.noteAt[1]) * slot.scale, w, h, rows };
  const [x, y] = corners.find(clear) ?? corners[0];
  return { x, y, w, h, rows };
}

/** A panel's memo, on a pale tag in its corner (screen only). */
export function drawNote(ctx: CanvasRenderingContext2D, slot: Slot, panel: Panel, format: PageFormat | undefined): void {
  const { x, y, w, h, rows } = noteBox(ctx, slot, panel, format);
  ctx.save();
  if (panel.noteAt) {
    // Moved away from its panel: a line back to it, as a comment points at its cell.
    const [x0, y0, x1, y1] = bounds(panel.shape);
    const inset = 3;
    const ax = Math.min(Math.max(x + w / 2, slot.x + (x0 + inset) * slot.scale), slot.x + (x1 - inset) * slot.scale);
    const ay = Math.min(Math.max(y + h / 2, slot.y + (y0 + inset) * slot.scale), slot.y + (y1 - inset) * slot.scale);
    drawLeader(ctx, ax, ay, [x, y, x + w, y + h], "rgba(170, 140, 40, 0.85)");
  }
  ctx.fillStyle = "rgba(255, 246, 194, 0.92)";
  ctx.strokeStyle = "rgba(170, 140, 40, 0.6)";
  ctx.lineWidth = 1;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = "#4a3f12";
  ctx.font = NOTE_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  rows.forEach((row, i) => ctx.fillText(row, x + 5, y + 4 + i * NOTE_ROW));
  ctx.restore();
}

/**
 * 付箋: a coloured note with its text; only here, never in exports. Selected,
 * it is outlined, and `handle` (a radius) draws the handle that ties it to a
 * panel or a line.
 */
export function drawSticky(ctx: CanvasRenderingContext2D, slot: Slot, sticky: Sticky, selected: boolean, handle: number | null, open = selected): void {
  const [x0, y0, x1, y1] = stickyBox(sticky, open);
  const sx = slot.x + x0 * slot.scale;
  const sy = slot.y + y0 * slot.scale;
  const w = (x1 - x0) * slot.scale;
  const h = (y1 - y0) * slot.scale;
  const anchor = stickyAnchor(slot.page, sticky);
  if (anchor)
    drawLeader(
      ctx,
      slot.x + anchor[0] * slot.scale,
      slot.y + anchor[1] * slot.scale,
      [sx, sy, sx + w, sy + h],
      "rgba(120, 96, 20, 0.9)",
      STICKY_COLORS[sticky.color ?? "yellow"].fill,
    );
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = STICKY_COLORS[sticky.color ?? "yellow"].fill;
  ctx.fillRect(sx, sy, w, h);
  ctx.restore();
  if (selected) {
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx - 1, sy - 1, w + 2, h + 2);
  }
  const size = STICKY_TEXT_MM * slot.scale;
  ctx.fillStyle = sticky.text ? "#3a3420" : "rgba(58, 52, 32, 0.45)";
  ctx.font = `${size}px sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  stickyRows(sticky.text, open).forEach((row, i) => ctx.fillText(row, sx + 2 * slot.scale, sy + 2 * slot.scale + i * size * 1.3));
  if (selected && handle !== null) {
    // The handle to tie it to a panel or a line: drag it there.
    const [hx, hy] = stickyHandle(slot, sticky);
    ctx.beginPath();
    ctx.arc(hx, hy, handle, 0, Math.PI * 2);
    ctx.fillStyle = anchor ? ACCENT : "#ffffff";
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/** A line from a point on the page to the nearest edge of a box (screen px), with a dot at the point. */
export function drawLeader(ctx: CanvasRenderingContext2D, ax: number, ay: number, [x0, y0, x1, y1]: BoxMm, color: string, dot = "#fff6c2"): void {
  const nx = Math.min(Math.max(ax, x0), x1);
  const ny = Math.min(Math.max(ay, y0), y1);
  ctx.save();
  if (Math.hypot(nx - ax, ny - ay) > 2) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(nx, ny);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(ax, ay, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = dot;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}

/** Where a 付箋's link handle is on screen: the point it is tied to, else its bottom left corner. */
export function stickyHandle(slot: Slot, sticky: Sticky): Point {
  const anchor = stickyAnchor(slot.page, sticky);
  if (anchor) return [slot.x + anchor[0] * slot.scale, slot.y + anchor[1] * slot.scale];
  const [x0, , , y1] = stickyBox(sticky);
  return [slot.x + x0 * slot.scale, slot.y + y1 * slot.scale];
}

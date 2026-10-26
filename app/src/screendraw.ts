// The page editor's own drawing: a page as it is worked on (with what is
// selected, the panel numbers, はみ出し outlines, the memos and stickies),
// what is dragged over the other pages, and the marks over the pages while
// something is done (cuts, outlines, lassos, guides, the transform frame, the
// pen and eraser cursors). Plain drawing from what it is given: the editor
// decides what is selected, dragged or hovered.
import type { Line, Page, Panel, Point, Project, RoughImage, Stroke } from "./model";
import { basicBox, trimBox } from "./pagebox";
import { type Slot } from "./layout";
import { maskShape } from "./mask";
import { stacked } from "./koma";
import { ACCENT, drawNote, drawSticky, wrapText } from "./notedraw";
import { INK, drawBalloons, drawLineText, drawPageFills, drawPanelBorders, drawPanelFills, drawStrokes, tracePath } from "./pagedraw";
import { pictureOf } from "./pictures";
import { imageOf, opacityOf } from "./references";
import { opacityOfLayer, roughLayersOf, strokesOn } from "./roughlayers";
import type { StrokeCache } from "./strokecache";

/** Half the size of a corner to drag, px. */
export const HANDLE = 5;

/** What a page shows of the editor's state: what is selected, dragged onto, and how close it is seen. */
export interface PageMarks {
  /** Seen from afar (連続): the drawing without the marks and memos over it. */
  small: boolean;
  showNotes: boolean;
  selected(kind: "stroke" | "fill" | "panel" | "breakout" | "sticky", id: string): boolean;
  /** A panel selected on its own (not being transformed) shows its corners. */
  panelCorners: boolean;
  /** The panel a swap would put the dragged panel's contents in. */
  swapInto: string | null;
  /** The size of a sticky's link handle, when stickies can be linked (null: none). */
  stickyHandle: number | null;
  /** A rough picture from the name sheet, when loaded. */
  rough(rough: RoughImage): CanvasImageSource | null;
  /** A picture finished loading: draw again. */
  redraw(): void;
  strokes: StrokeCache;
  /** Where a panel's number goes, px. */
  badge(panel: Panel): { x: number; y: number; radius: number };
  /** Under the drawing: the outlines of the 資料 pictures (the 資料 tool). */
  referenceFrames?(): void;
  /** A line of dialogue with its marks (speaker, selection, tail handles). */
  line(line: Line): void;
}

const at = (slot: Slot) => ({ scale: slot.scale, x: slot.x, y: slot.y });

/** A page on the editor's canvas: the paper, its frames, the drawing and the marks over it. */
export function drawScreenPage(ctx: CanvasRenderingContext2D, project: Project, slot: Slot, page: Page, marks: PageMarks): void {
  const { scale } = slot;
  const { small } = marks;
  const [pageW, pageH] = project.pageFormat.canvasMm;
  const sx = (x: number) => slot.x + x * scale;
  const sy = (y: number) => slot.y + y * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(sx(slot.shown[0]), sy(0), (slot.shown[1] - slot.shown[0]) * scale, pageH * scale);
  ctx.clip();
  ctx.fillStyle = "#eeede9";
  ctx.fillRect(sx(0), sy(0), pageW * scale, pageH * scale);
  const trim = trimBox(project.pageFormat);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(sx(trim[0]), sy(trim[1]), (trim[2] - trim[0]) * scale, (trim[3] - trim[1]) * scale);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
  ctx.lineWidth = 1;
  ctx.strokeRect(sx(trim[0]), sy(trim[1]), (trim[2] - trim[0]) * scale, (trim[3] - trim[1]) * scale);
  const basic = basicBox(project.pageFormat);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(47, 111, 219, 0.45)";
  ctx.strokeRect(sx(basic[0]), sy(basic[1]), (basic[2] - basic[0]) * scale, (basic[3] - basic[1]) * scale);
  ctx.setLineDash([]);

  // Roughs from the source sheet, faded so the name reads on top.
  ctx.globalAlpha = 0.45;
  for (const rough of page.roughs) {
    const image = marks.rough(rough);
    if (!image) continue;
    const [x0, y0, x1, y1] = rough.box;
    ctx.drawImage(image, sx(x0), sy(y0), (x1 - x0) * scale, (y1 - y0) * scale);
  }
  // 資料画像, faint under the drawing.
  for (const reference of page.references ?? []) {
    const stored = imageOf(project, reference);
    const picture = stored && pictureOf(stored, marks.redraw);
    if (!picture) continue;
    const [x0, y0, x1, y1] = reference.box;
    ctx.globalAlpha = opacityOf(reference);
    ctx.drawImage(picture, sx(x0), sy(y0), (x1 - x0) * scale, (y1 - y0) * scale);
  }
  ctx.globalAlpha = 1;
  marks.referenceFrames?.();

  const m = at(slot);
  const brushes = project.brushes ?? [];
  const strokeColor = (stroke: Stroke) => (marks.selected("stroke", stroke.id) ? ACCENT : "#3a3834");
  const style = { color: strokeColor, minWidthPx: 0.7, brushes };
  const roughs = roughLayersOf(project);
  // Each ラフ線のレイヤー at its own opacity (hidden ones are not in `page`).
  const drawRoughs = (over: boolean) => {
    for (const layer of roughs) {
      const strokes = strokesOn(project, page.strokes, layer);
      if (!strokes.length) continue;
      ctx.globalAlpha = opacityOfLayer(layer);
      marks.strokes.draw(ctx, page, project.pageFormat.canvasMm, m, over, style, roughs.length > 1 ? layer.id : "", strokes);
    }
    ctx.globalAlpha = 1;
  };
  drawRoughs(false);
  drawPanelFills(ctx, page, m);
  drawPageFills(ctx, page, m, (id) => (marks.selected("fill", id) ? ACCENT : null));
  const selectedPanels = page.panels.filter((panel) => marks.selected("panel", panel.id));
  for (const panel of selectedPanels) {
    tracePath(ctx, panel.shape, m, true);
    ctx.fillStyle = "rgba(47, 111, 219, 0.08)";
    ctx.fill();
  }
  drawPanelBorders(ctx, page, m, (panel) => (selectedPanels.includes(panel) ? ACCENT : INK));
  drawRoughs(true);

  // はみ出し: shown by a dashed outline (only here, not in exports).
  for (const breakout of page.breakouts) {
    const selected = marks.selected("breakout", breakout.id);
    tracePath(ctx, breakout.shape, m, true);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = selected ? ACCENT : "rgba(214, 120, 40, 0.8)";
    ctx.lineWidth = selected ? 2 : 1.2;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const panel of stacked(page.panels)) {
    const selected = selectedPanels.includes(panel);
    // Panels with no border at all still show where they are.
    if ((panel.border ?? "solid") === "none" && !selected) {
      tracePath(ctx, panel.shape, m, true);
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = "rgba(47, 111, 219, 0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const { x: nx, y: ny, radius } = marks.badge(panel);
    if (marks.swapInto === panel.id) {
      tracePath(ctx, panel.shape, m, true);
      ctx.fillStyle = "rgba(47, 111, 219, 0.18)";
      ctx.fill();
    }
    // Pages seen from afar (連続) show the drawing, not the marks over it.
    if (!small || selected) {
      ctx.fillStyle = selected ? ACCENT : "rgba(47, 111, 219, 0.75)";
      ctx.beginPath();
      ctx.arc(nx, ny, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${Math.round(radius * 1.2)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(panel.order), nx, ny);
    }
    // Corners to drag, for a panel selected on its own.
    if (selected && marks.panelCorners) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      for (const [x, y] of panel.shape) {
        ctx.fillRect(sx(x) - HANDLE, sy(y) - HANDLE, HANDLE * 2, HANDLE * 2);
        ctx.strokeRect(sx(x) - HANDLE, sy(y) - HANDLE, HANDLE * 2, HANDLE * 2);
      }
    }
  }

  drawBalloons(ctx, page, m);
  for (const line of page.lines) {
    // コマ枠でマスク: the words go no further than the balloon does.
    const panel = line.mask ? page.panels.find((p) => p.id === line.panel) : undefined;
    const clip = panel && maskShape(panel);
    if (!clip) {
      marks.line(line);
      continue;
    }
    ctx.save();
    tracePath(ctx, clip, m, true);
    ctx.clip();
    marks.line(line);
    ctx.restore();
  }
  if (marks.showNotes && !small) for (const panel of page.panels) if (panel.note) drawNote(ctx, slot, panel, project.pageFormat);
  for (const sticky of page.stickies ?? []) drawSticky(ctx, slot, sticky, marks.selected("sticky", sticky.id), marks.stickyHandle);
  ctx.restore();

  ctx.fillStyle = "#f4f3f0";
  ctx.font = "13px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  if (project.scroll) {
    // 縦スクロール: the pieces touch; the number goes left of the strip, at the top of its piece.
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(String(slot.index + 1), sx(0) - 8, sy(0) + 4);
    return;
  }
  // The page number and its memo, wrapped to the page's width so the two pages of a spread do not run into each other.
  const [trimX0, , trimX1] = trimBox(project.pageFormat);
  const memo = page.memo && !small ? `  ${page.memo.replace(/\s*\n\s*/g, " ")}` : "";
  const rows = wrapText(ctx, `${slot.index + 1}${memo}`, Math.max(small ? 0 : 80, (trimX1 - trimX0) * scale - 8), 2);
  rows.forEach((row, i) => ctx.fillText(row, sx((trimX0 + trimX1) / 2), sy(pageH) + 18 + i * 16));
}

/** Everywhere but `slot`'s own page (where things are drawn already): clip to it. */
function clipOutside(ctx: CanvasRenderingContext2D, left: number, top: number, width: number, height: number): void {
  ctx.beginPath();
  ctx.rect(-1e5, -1e5, 2e5, 2e5);
  ctx.rect(left, top, width, height);
  ctx.clip("evenodd");
}

/**
 * What is dragged (`lifted`, the part of `slot`'s page that moves), drawn
 * over the other pages and the room between them too: its own page cuts it
 * off at its edge.
 */
export function drawLifted(ctx: CanvasRenderingContext2D, project: Project, slot: Slot, lifted: Page): void {
  const [, pageH] = project.pageFormat.canvasMm;
  const m = at(slot);
  ctx.save();
  clipOutside(ctx, slot.x + slot.shown[0] * slot.scale, slot.y, (slot.shown[1] - slot.shown[0]) * slot.scale, pageH * slot.scale);
  ctx.globalAlpha = 0.9;
  for (const panel of lifted.panels) {
    // Lifted off the paper: the pages under it show through a little.
    tracePath(ctx, panel.shape, m, true);
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.fill();
  }
  const brushes = project.brushes ?? [];
  drawStrokes(ctx, lifted, m, false, () => ACCENT, 0.7, brushes);
  drawPanelFills(ctx, lifted, m);
  drawPageFills(ctx, lifted, m);
  drawPanelBorders(ctx, lifted, m, () => ACCENT);
  drawStrokes(ctx, lifted, m, true, () => ACCENT, 0.7, brushes);
  drawBalloons(ctx, lifted, m);
  for (const line of lifted.lines) drawLineText(ctx, line, m);
  ctx.restore();
}

/** The page something goes to when let go: framed, with `label` over it. */
export function drawGoingTo(ctx: CanvasRenderingContext2D, project: Project, to: Slot, label: string): void {
  const [tx0, ty0, tx1, ty1] = trimBox(project.pageFormat);
  const left = to.x + Math.max(tx0, to.shown[0]) * to.scale;
  const right = to.x + Math.min(tx1, to.shown[1]) * to.scale;
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 5]);
  ctx.strokeRect(left - 3, to.y + ty0 * to.scale - 3, right - left + 6, (ty1 - ty0) * to.scale + 6);
  ctx.setLineDash([]);
  ctx.font = "bold 13px system-ui, sans-serif";
  const w = ctx.measureText(label).width + 16;
  const lx = (left + right) / 2 - w / 2;
  const ly = to.y + ty0 * to.scale - 30;
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.roundRect(lx, ly, w, 22, 11);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, lx + w / 2, ly + 11);
  ctx.restore();
}

/**
 * Panels of `slot`'s page where they run past its edge on screen (over the
 * facing page and the room between pages), the one with `corners` with its
 * corners to drag.
 */
export function drawOverflowPanels(ctx: CanvasRenderingContext2D, project: Project, slot: Slot, panels: Panel[], corners: string | null): void {
  const [, pageH] = project.pageFormat.canvasMm;
  const left = slot.x + slot.shown[0] * slot.scale;
  const right = slot.x + slot.shown[1] * slot.scale;
  const outside = panels.filter((panel) =>
    panel.shape.some(([x, y]) => {
      const sx = slot.x + x * slot.scale;
      return sx < left - 0.5 || sx > right + 0.5 || y < 0 || y > pageH;
    }),
  );
  if (!outside.length) return;
  const m = at(slot);
  ctx.save();
  clipOutside(ctx, left, slot.y, right - left, pageH * slot.scale);
  for (const panel of outside) {
    tracePath(ctx, panel.shape, m, true);
    ctx.fillStyle = "rgba(47, 111, 219, 0.12)";
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (panel.id !== corners) continue;
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    for (const [x, y] of panel.shape) {
      const [hx, hy] = [slot.x + x * slot.scale, slot.y + y * slot.scale];
      ctx.fillRect(hx - HANDLE, hy - HANDLE, HANDLE * 2, HANDLE * 2);
      ctx.strokeRect(hx - HANDLE, hy - HANDLE, HANDLE * 2, HANDLE * 2);
    }
  }
  ctx.restore();
}

// --- marks over the pages ------------------------------------------------------------

/** The border under the pointer (or being moved): its edges, thick. */
export function drawSeam(ctx: CanvasRenderingContext2D, slot: Slot, lines: [Point, Point][]): void {
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (const [a, b] of lines) {
    ctx.beginPath();
    ctx.moveTo(slot.x + a[0] * slot.scale, slot.y + a[1] * slot.scale);
    ctx.lineTo(slot.x + b[0] * slot.scale, slot.y + b[1] * slot.scale);
    ctx.stroke();
  }
  ctx.restore();
}

/** A cut being drawn (a line) or a panel being framed (a box), dashed. */
export function drawCutOrFrame(ctx: CanvasRenderingContext2D, slot: Slot, a: Point, b: Point, cut: boolean): void {
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  if (cut) {
    ctx.beginPath();
    ctx.moveTo(slot.x + a[0] * slot.scale, slot.y + a[1] * slot.scale);
    ctx.lineTo(slot.x + b[0] * slot.scale, slot.y + b[1] * slot.scale);
    ctx.stroke();
  } else {
    const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
    const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    ctx.strokeRect(slot.x + x0 * slot.scale, slot.y + y0 * slot.scale, (x1 - x0) * slot.scale, (y1 - y0) * slot.scale);
  }
  ctx.setLineDash([]);
}

/** The area as it will be filled (`color`), while it is drawn round. */
export function drawFillArea(ctx: CanvasRenderingContext2D, slot: Slot, points: Point[], color: string): void {
  tracePath(ctx, points, at(slot), true);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** A lasso being drawn round, dashed in `color`. */
export function drawLasso(ctx: CanvasRenderingContext2D, slot: Slot, points: Point[], color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  tracePath(ctx, points, at(slot), true);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** A few words by the pointer, saying what letting go does. */
export function drawPointerNote(ctx: CanvasRenderingContext2D, [px, py]: Point, text: string): void {
  ctx.fillStyle = ACCENT;
  ctx.font = "12px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(text, px + 10, py - 6);
}

/** A dashed arrow from `from` to the pointer (a panel's contents on their way). */
export function drawDashedLine(ctx: CanvasRenderingContext2D, from: Point, to: Point): void {
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** The pen's size where it will draw (a cross in it when it is small). */
export function drawPenCursor(ctx: CanvasRenderingContext2D, [px, py]: Point, radius: number): void {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.beginPath();
  ctx.arc(px, py, radius + 1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(30, 30, 30, 0.85)";
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  if (radius < 5) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(px + dx * (radius + 2), py + dy * (radius + 2));
      ctx.lineTo(px + dx * (radius + 6), py + dy * (radius + 6));
    }
  }
  ctx.stroke();
  ctx.restore();
}

/** The eraser's reach around the pointer. */
export function drawRing(ctx: CanvasRenderingContext2D, [px, py]: Point, radius: number): void {
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.stroke();
}

/** The lines snapped to (mm across `slot`'s page), in `color`. */
export function drawGuideLines(ctx: CanvasRenderingContext2D, project: Project, slot: Slot, xs: readonly number[], ys: readonly number[], color: string): void {
  const [pageW, pageH] = project.pageFormat.canvasMm;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  for (const x of xs) {
    ctx.moveTo(slot.x + x * slot.scale, slot.y);
    ctx.lineTo(slot.x + x * slot.scale, slot.y + pageH * slot.scale);
  }
  for (const y of ys) {
    ctx.moveTo(slot.x + slot.shown[0] * slot.scale, slot.y + y * slot.scale);
    ctx.lineTo(slot.x + Math.min(slot.shown[1], pageW) * slot.scale, slot.y + y * slot.scale);
  }
  ctx.stroke();
  ctx.restore();
}

/** The snapping grid of `gridMm` from the basic frame's corner, on each of `slots`. */
export function drawSnapGrid(ctx: CanvasRenderingContext2D, project: Project, slots: Slot[], gridMm: number): void {
  const [pageW, pageH] = project.pageFormat.canvasMm;
  const [bx, by] = basicBox(project.pageFormat);
  ctx.save();
  ctx.strokeStyle = "rgba(47, 111, 219, 0.14)";
  ctx.lineWidth = 1;
  for (const slot of slots) {
    const [x0, x1] = slot.shown;
    ctx.beginPath();
    for (let x = bx - Math.floor((bx - x0) / gridMm) * gridMm; x <= x1; x += gridMm) {
      ctx.moveTo(slot.x + x * slot.scale, slot.y);
      ctx.lineTo(slot.x + x * slot.scale, slot.y + pageH * slot.scale);
    }
    for (let y = by - Math.floor(by / gridMm) * gridMm; y <= pageH; y += gridMm) {
      ctx.moveTo(slot.x + x0 * slot.scale, slot.y + y * slot.scale);
      ctx.lineTo(slot.x + Math.min(x1, pageW) * slot.scale, slot.y + y * slot.scale);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** 多角形: the corners placed (`placed`), the outline so far (`points`) and, `closing`, the first corner grown. */
export function drawCorners(ctx: CanvasRenderingContext2D, slot: Slot, placed: Point[], points: Point[], closing: boolean): void {
  ctx.save();
  if (points.length >= 3) {
    tracePath(ctx, points, at(slot), true);
    ctx.fillStyle = "rgba(47, 111, 219, 0.08)";
    ctx.fill();
  }
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  tracePath(ctx, points, at(slot), closing);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  placed.forEach(([x, y], i) => {
    const r = i === 0 && closing ? HANDLE + 2 : HANDLE - 1;
    ctx.beginPath();
    ctx.arc(slot.x + x * slot.scale, slot.y + y * slot.scale, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

function squareHandle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillRect(x - HANDLE + 1, y - HANDLE + 1, 2 * HANDLE - 2, 2 * HANDLE - 2);
  ctx.strokeRect(x - HANDLE + 1, y - HANDLE + 1, 2 * HANDLE - 2, 2 * HANDLE - 2);
}

/** 自由変形: the four corners (mm on `slot`'s page) as they are being pulled. */
export function drawWarpCorners(ctx: CanvasRenderingContext2D, slot: Slot, corners: Point[]): void {
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  tracePath(ctx, corners, at(slot), true);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  for (const [x, y] of corners) squareHandle(ctx, slot.x + x * slot.scale, slot.y + y * slot.scale);
  ctx.restore();
}

/** 変形: the frame with its eight handles (px: corners first, then sides) and the one to turn it. */
export function drawTransformFrame(ctx: CanvasRenderingContext2D, handles: Point[], rotate: Point): void {
  const [tl, tr, , bl] = handles;
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(tl[0], tl[1], tr[0] - tl[0], bl[1] - tl[1]);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo((tl[0] + tr[0]) / 2, tl[1]);
  ctx.lineTo(...rotate);
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  for (const [x, y] of handles) squareHandle(ctx, x, y);
  ctx.beginPath();
  ctx.arc(rotate[0], rotate[1], HANDLE, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

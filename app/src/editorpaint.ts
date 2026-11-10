// Drawing the page editor's screen: the pages as they lie (a picture of them
// is kept, so that what only lies over them — the hover marks, the eraser's
// ring, a line being drawn — costs no drawing of the pages), and over them
// what is picked, dragged and snapped to. It looks at the editor's state
// (PaintScene) and changes none of it.
import { drawAside } from "./asidedraw";
import type { Drag, DragOf, EditorEraseMode, EditorHost, Guides, Hover, Tool } from "./editorcore";
import type { EditorPicks } from "./editorpicks";
import type { EditorStage } from "./editorstage";
import type { FillSettings } from "./fillsettings";
import { bounds } from "./geometry";
import { panelBadge } from "./hittest";
import { seamLines } from "./komaedit";
import { toPage, type Slot } from "./layout";
import type { Brush, Line, Page, Panel, Point, Project } from "./model";
import { ACCENT, drawSticky, NOTE_FONT, NOTE_ROW, noteBox, type NoteBox } from "./notedraw";
import { snapCut } from "./pagebox";
import { drawLineText, drawStroke, LiveLine, tracePath } from "./pagedraw";
import { perfMeter } from "./perfmeter";
import { penPreferences } from "./prefs";
import { drawCorners, drawCutOrFrame, drawDashedLine, drawFillDrag, drawGoingTo, drawGuideLines, drawLasso, drawLifted, drawOverflowPanels, drawPenCursor, drawPointerNote, drawReferenceFrames, drawSpreadMarks, drawRing, drawScreenPage, drawSeam, drawSketch, drawSnapGrid, drawStickyLink, drawTransformFrame, drawTailHandles, drawWarpCorners } from "./screendraw";
import type { SnapSettings } from "./snapping";
import { stickyFolds } from "./stickies";
import { StrokeCache } from "./strokecache";
import { LINK_HANDLE } from "./toolsticky";
import type { ItemRef } from "./transform";

/** Lines snapped to. */
const GUIDE = "#e0398a";

/** What the drawing looks at in the editor around it. */
export interface PaintScene {
  readonly tool: Tool;
  /** The drag under way, the pointer and what it is over. */
  readonly drag: Drag | null;
  readonly hover: Hover | null;
  readonly pointer: Point | null;
  readonly spaceHeld: boolean;
  /** 多角形: the corners placed so far, the page they are on and where the next one would go. */
  readonly polygon: { pageId: string; points: Point[] } | null;
  polygonSlot(): Slot | null;
  nextCorner(slot: Slot, point: Point, free: boolean): Point;
  readonly guides: Guides | null;
  readonly snapping: SnapSettings;
  readonly reference: { pageId: string; id: string } | null;
  readonly fill: FillSettings;
  readonly penWidthMm: number;
  readonly eraseMode: EditorEraseMode;
  erasing(): boolean;
  eraserRadiusPx(): number;
  brush(kind: "pen" | "eraser"): Brush | undefined;
  /** The pages were laid out anew: what lies over them in the page (a text being written, the action bar) goes where they are. */
  laidOut(): void;
}

export class EditorPainter {
  /**
   * A pen line being drawn: painted a little each frame onto the picture of
   * the pages (the cache, which nothing else draws meanwhile); the screen is
   * that picture and what lies over it.
   */
  private live: LiveLine | null = null;

  /** 低遅延: the same line painted straight onto the screen as the input comes (pointerrawupdate), between frames. */
  private onScreen: LiveLine | null = null;

  /** The cache holds a line no longer being drawn: the pages are drawn again before it is used. */
  private cacheStale = false;

  private frame = 0;

  /** The pages as last drawn, for redrawing only what is over them (hover, eraser ring). */
  private cache: HTMLCanvasElement | null = null;

  /** Each page's rough lines as a picture, while they do not change. */
  private readonly strokeCache = new StrokeCache(() => this.requestDraw());

  private overlayFrame = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly host: EditorHost,
    private readonly stage: EditorStage,
    private readonly picks: EditorPicks,
    private readonly scene: PaintScene,
  ) {}

  /**
   * While something is dragged: what is dragged, drawn over the other pages
   * and the room between them too (its own page cuts it off at its edge), and
   * the page it goes to when let go, framed.
   */
  private drawDragged(project: Project): void {
    const drag = this.scene.drag;
    const s = this.picks.selection;
    if (drag?.kind !== "move" || !drag.moved || !s) return;
    const slot = this.stage.slots.find((x) => x.index === drag.slot.index);
    if (!slot) return;
    const page = slot.page;
    const ids = (kind: ItemRef["kind"]) => new Set((drag.items ?? []).filter((item) => item.kind === kind).map((item) => item.id));
    const panels = ids("panel");
    const lines = ids("line");
    const strokes = ids("stroke");
    const fills = ids("fill");
    const breakouts = ids("breakout");
    if (!drag.items) {
      const own = { panel: panels, line: lines, stroke: strokes, fill: fills, breakout: breakouts } as Record<string, Set<string>>;
      own[s.kind]?.add(s.id);
      for (const line of drag.carried?.lines ?? []) lines.add(line.id);
      for (const stroke of drag.carried?.strokes ?? []) strokes.add(stroke.id);
      for (const fill of drag.carried?.fills ?? []) fills.add(fill.id);
    }
    const dragged: Page = {
      ...page,
      panels: page.panels.filter((x) => panels.has(x.id)),
      lines: page.lines.filter((x) => lines.has(x.id)),
      strokes: page.strokes.filter((x) => strokes.has(x.id)),
      breakouts: page.breakouts.filter((x) => breakouts.has(x.id)),
      fills: (page.fills ?? []).filter((x) => fills.has(x.id)),
      stickies: [],
    };
    drawLifted(this.ctx, project, slot, dragged);

    // Where it goes: a panel on its own (not half of a 見開き panel), dialogue and rough lines.
    const panel = s.kind === "panel" && !drag.items ? dragged.panels[0] : undefined;
    const going = panel
      ? panel.spread
        ? []
        : [bounds(panel.shape)]
      : [...dragged.lines.map((line) => line.box), ...dragged.strokes.map((stroke) => bounds(stroke.points.map(([x, y]) => [x, y] as Point)))];
    if (!going.length) return;
    const box = bounds(going.flatMap(([x0, y0, x1, y1]) => [[x0, y0], [x1, y1]] as Point[]));
    const to = this.stage.otherPageUnder(project, slot, [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
    if (to) drawGoingTo(this.ctx, project, to, `${to.index + 1} ページへ${panel ? "（中身ごと）" : ""}`);
  }

  /**
   * The panels being reshaped, and the panel selected, where they run past
   * their page's edge on screen (over the facing page and the room between
   * pages): drawn there too, the selected one with its corners, so a side
   * pulled over the gutter stays in sight and can be taken again.
   */
  private drawOverflow(project: Project): void {
    const drag = this.scene.drag;
    const s = this.picks.selection;
    const pageId = drag && "slot" in drag && drag.slot ? drag.slot.page.id : s?.pageId;
    const slot = pageId ? this.stage.slots.find((x) => x.page.id === pageId) : undefined;
    if (!slot) return;
    const ids = new Set<string>();
    if (drag?.kind === "vertex") ids.add(drag.panelId);
    else if (drag?.kind === "seam") for (const edge of drag.seam.edges) ids.add(edge.panelId);
    else if (drag && (drag.kind === "scale" || drag.kind === "rotate" || drag.kind === "warp")) for (const panel of drag.base.panels ?? []) ids.add(panel.id);
    const corners = this.scene.tool === "select" && !this.picks.isTransforming && s?.kind === "panel" && s.pageId === slot.page.id ? s.id : null;
    if (corners) ids.add(corners);
    const panels = slot.page.panels.filter((panel) => ids.has(panel.id) && !panel.spread);
    drawOverflowPanels(this.ctx, project, slot, panels, corners);
  }

  /** Draw on the next frame: pointer events can come many times a frame. */
  requestDraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw(): void {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    if (this.overlayFrame) {
      cancelAnimationFrame(this.overlayFrame);
      this.overlayFrame = 0;
    }
    // A hidden editor (a file loading before the editor shows) has no pixels to draw.
    if (!this.canvas.width || !this.canvas.height) return;
    const ctx = this.ctx;
    const started = performance.now();
    if (this.scene.drag?.kind === "pen" && this.live && this.cache) {
      // While a line is drawn nothing else changes: the pages as they were with the line painted on so far, then what lies over them.
      this.paintLive(this.scene.drag);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.cache, 0, 0);
      ctx.restore();
      this.drawOverlay();
      perfMeter.drawn(started, true);
      return;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // A turned view leaves the corners outside the pages: the stage colour there.
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    const project = this.host.project();
    if (!project) return;
    if (!this.scene.drag) this.stage.keepRoom(project);
    this.stage.arrange(project);
    this.strokeCache.startFrame();
    const drawn = new Set<string>();
    for (const slot of this.stage.slots) {
      if (!this.stage.onCanvas(project, slot)) continue;
      this.drawPage(project, slot);
      drawn.add(slot.page.id);
    }
    this.strokeCache.forget(drawn);
    drawAside(this.ctx, project, this.stage.slots, {
      visible: (page) => this.stage.visiblePage(page),
      selected: (page, kind, id) => this.picks.isSelected(page, kind, id),
      stickyHandle: this.scene.tool === "select" || this.scene.tool === "sticky" ? LINK_HANDLE : null,
      held: this.scene.drag?.kind === "held" ? this.scene.drag : null,
      redraw: () => this.requestDraw(),
      referenceFrames: this.scene.tool === "reference" ? (slot) => this.drawReferenceFrames(slot) : undefined,
    });
    this.drawSpreadMarks(project);
    this.drawDragged(project);
    this.drawOverflow(project);
    this.keepCache();
    this.scene.laidOut();
    this.drawOverlay();
    if (this.scene.drag) perfMeter.drawn(started, false);
  }

  /** What the editor keeps to draw quickly (device pixels): the pictures of the pages' lines, and the screen's own copy. */
  get kept(): { linePictures: number; linePixels: number; screenPixels: number } {
    const lines = this.strokeCache.kept;
    return { linePictures: lines.pictures, linePixels: lines.pixels, screenPixels: (this.cache?.width ?? 0) * (this.cache?.height ?? 0) };
  }

  /** Paint what the pen added onto the picture of the pages (all of the line again when the view moved). */
  private paintLive(drag: DragOf<"pen">): void {
    const cache = this.cache!.getContext("2d")!;
    cache.setTransform(this.ctx.getTransform());
    const { slot } = drag;
    const m = { scale: slot.scale, x: slot.x, y: slot.y };
    const [width, color, brush] = this.liveInk(drag);
    if (!this.live!.paint(drag.points, width, m, color, brush)) {
      // The view moved under the line: the pages anew, then the whole line.
      this.live = null;
      this.cacheStale = true;
      this.draw();
      this.captureBase();
      // (captureBase made a new one.)
      (this.live as LiveLine | null)?.paint(drag.points, width, m, color, brush);
    }
  }

  /** A line being drawn: its width (mm), colour and brush. */
  private liveInk(drag: DragOf<"pen">): [number, string, Brush | undefined] {
    return [drag.mark?.widthMm ?? this.scene.penWidthMm, drag.mark?.color ?? "#3a3834", drag.mark ? undefined : this.scene.brush("pen")];
  }

  private keepCache(): void {
    const cache = this.cache ?? document.createElement("canvas");
    if (cache.width !== this.canvas.width || cache.height !== this.canvas.height) {
      cache.width = this.canvas.width;
      cache.height = this.canvas.height;
    }
    const ctx = cache.getContext("2d")!;
    // A line drawn on it last left the view's transform.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cache.width, cache.height);
    ctx.drawImage(this.canvas, 0, 0);
    this.cache = cache;
    this.cacheStale = false;
  }

  /** Redraw only what lies over the pages (hover marks, the eraser ring) on the next frame. */
  requestOverlay(): void {
    if (this.frame || this.overlayFrame) return;
    this.overlayFrame = requestAnimationFrame(() => {
      this.overlayFrame = 0;
      if (!this.cache || this.scene.drag || this.cacheStale) {
        this.draw();
        return;
      }
      const ctx = this.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.cache, 0, 0);
      ctx.restore();
      this.drawOverlay();
    });
  }

  /**
   * 見開きページ: a mark under the gutter when the two pages go to CSP as one.
   * 連続: the spread worked on (what the side panels are about) is framed.
   */
  private drawSpreadMarks(project: Project): void {
    const current = this.stage.continuous ? this.stage.spreadIndex : null;
    drawSpreadMarks(this.ctx, project, this.stage.slots, this.stage.spreadList(), current, (slot) => this.stage.onCanvas(project, slot), (slots) => this.stage.extent(slots));
  }

  private drawPage(project: Project, slot: Slot): void {
    const page = this.stage.visiblePage(slot.page);
    const small = this.stage.small(project, slot);
    const [pageW] = project.pageFormat.canvasMm;
    const swap = this.scene.drag?.kind === "swap" && this.scene.drag.to?.slot.page === slot.page ? this.scene.drag.to.panelId : null;
    drawScreenPage(this.ctx, project, slot, page, {
      small,
      showNotes: this.stage.showNotes,
      selected: (kind, id) => this.picks.isSelected(slot.page, kind, id),
      panelCorners: this.scene.tool === "select" && !this.picks.isTransforming && this.picks.selection?.kind === "panel",
      swapInto: swap ?? null,
      stickyHandle: this.scene.tool === "select" || this.scene.tool === "sticky" ? LINK_HANDLE : null,
      rough: (rough) => this.host.rough(rough),
      redraw: () => this.requestDraw(),
      strokes: this.strokeCache,
      badge: (panel) => panelBadge(slot, panel, project.pageFormat, pageW),
      referenceFrames: this.scene.tool === "reference" ? () => this.drawReferenceFrames(slot) : undefined,
      line: (line) => this.drawLine(project, slot, line),
    });
  }

  /** 資料: every picture's outline, the chosen one with corners to drag. */
  private drawReferenceFrames(slot: Slot): void {
    drawReferenceFrames(this.ctx, slot, this.scene.reference?.pageId === slot.page.id ? this.scene.reference.id : null);
  }

  /** Where a panel's memo sits on screen (notedraw.ts). */
  noteBox(slot: Slot, panel: Panel): NoteBox {
    return noteBox(this.ctx, slot, panel, this.host.project()?.pageFormat);
  }

  private drawLine(project: Project, slot: Slot, line: Line): void {
    const ctx = this.ctx;
    const { scale } = slot;
    const sx = (x: number) => slot.x + x * scale;
    const sy = (y: number) => slot.y + y * scale;
    const selected = this.picks.isSelected(slot.page, "line", line.id);
    const m = { scale, x: slot.x, y: slot.y };
    drawLineText(ctx, line, m);
    const speaker = project.characters.find((character) => character.id === line.speaker);
    const [x0, y0, x1, y1] = line.box;
    if (speaker && !this.stage.small(project, slot)) {
      ctx.fillStyle = speaker.color ?? ACCENT;
      ctx.beginPath();
      ctx.arc(sx(x1) + 4, sy(y0) - 4, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (selected) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(sx(x0) - 3, sy(y0) - 3, (x1 - x0) * scale + 6, (y1 - y0) * scale + 6);
      ctx.setLineDash([]);
      // しっぽの先 (drag to point at the speaker) and its middle (drag to bend it): handles are the select tool's.
      if (this.scene.tool === "select") this.drawTailHandles(slot, line, true);
    }
  }

  private drawOverlay(): void {
    const ctx = this.ctx;
    const drag = this.scene.drag;
    // Slots are laid out again on every draw: the hover's page as it is now placed.
    const hoverSlot = this.scene.hover && this.stage.slots.find((s) => s.page.id === this.scene.hover!.slot.page.id);
    const seam = drag?.kind === "seam" ? drag : this.scene.hover?.kind === "seam" && hoverSlot ? { slot: hoverSlot, seam: this.scene.hover.seam } : null;
    if (seam) drawSeam(ctx, seam.slot, seamLines(seam.slot.page, seam.seam));
    if (!drag && this.scene.hover?.kind === "item" && hoverSlot) {
      const { target } = this.scene.hover;
      const slot = hoverSlot;
      const m = { scale: slot.scale, x: slot.x, y: slot.y };
      ctx.save();
      ctx.strokeStyle = "rgba(47, 111, 219, 0.55)";
      ctx.lineWidth = 2;
      if (target.kind === "panel") {
        const panel = slot.page.panels.find((p) => p.id === target.id);
        if (panel) {
          tracePath(ctx, panel.shape, m, true);
          ctx.stroke();
          if (!panel.note || !this.stage.showNotes) {
            // An invitation to write the panel's memo right here.
            const { x, y } = this.noteBox(slot, panel);
            ctx.fillStyle = "rgba(255, 246, 194, 0.85)";
            ctx.fillRect(x, y, 52, NOTE_ROW + 4);
            ctx.fillStyle = "#7a6a2a";
            ctx.font = NOTE_FONT;
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.fillText("＋ メモ", x + 6, y + 4);
          }
        }
      } else if (target.kind === "sticky") {
        // A long 付箋 opens to all its text while the pointer is on it.
        const sticky = slot.page.stickies?.find((n) => n.id === target.id);
        if (sticky && stickyFolds(sticky) && !this.picks.isSelected(slot.page, "sticky", sticky.id)) drawSticky(ctx, slot, sticky, false, null, true);
      } else if (target.kind === "line") {
        const line = slot.page.lines.find((l) => l.id === target.id);
        if (line) {
          const [x0, y0, x1, y1] = line.box;
          ctx.strokeRect(slot.x + x0 * slot.scale - 3, slot.y + y0 * slot.scale - 3, (x1 - x0) * slot.scale + 6, (y1 - y0) * slot.scale + 6);
          if (!this.picks.isSelected(slot.page, "line", line.id)) this.drawTailHandles(slot, line, false);
        }
      }
      ctx.restore();
    }
    if (!drag && this.scene.hover?.kind === "tail" && hoverSlot) {
      const { lineId } = this.scene.hover.hit;
      const line = hoverSlot.page.lines.find((l) => l.id === lineId);
      if (line && !this.picks.isSelected(hoverSlot.page, "line", line.id)) this.drawTailHandles(hoverSlot, line, true);
    }
    this.drawGrid(this.host.project()!);
    // The outline being placed snaps its next corner: the guides after it.
    this.drawPolygon();
    this.drawGuides();
    if (drag && (drag.kind === "cut" || drag.kind === "frame")) {
      const b = drag.kind === "cut" && !drag.free ? snapCut(drag.a, drag.b) : drag.b;
      drawCutOrFrame(ctx, drag.slot, drag.a, b, drag.kind === "cut");
    }
    if (drag?.kind === "fill") drawFillDrag(ctx, drag.slot, drag.points, drag.way, this.scene.fill);
    if ((drag?.kind === "lasso" || drag?.kind === "pick" || drag?.kind === "eraseLasso") && drag.points.length > 1) {
      drawLasso(ctx, drag.slot, drag.points, drag.kind === "lasso" ? "rgba(214, 120, 40, 0.9)" : drag.kind === "pick" ? ACCENT : "rgba(192, 57, 43, 0.9)");
    }
    if (drag?.kind === "stickyLink" && this.scene.pointer) drawStickyLink(ctx, drag.slot, drag.stickyId, drag.to, this.scene.pointer);
    if (drag?.kind === "sketch") drawSketch(ctx, drag.slot, drag.points);
    if (drag?.kind === "swap" && this.scene.pointer) {
      // An arrow from the panel's number to where its contents go.
      drawDashedLine(ctx, drag.at, this.scene.pointer);
      drawPointerNote(ctx, this.scene.pointer, drag.to ? "ここに入れ替え" : "入れ替えるコマへ");
    }
    if (drag?.kind === "pen") {
      const { slot, points } = drag;
      const m = { scale: slot.scale, x: slot.x, y: slot.y };
      const [width, color, brush] = this.liveInk(drag);
      if (this.live) {
        // Where the pen is about to be (先読み): shown this frame only.
        this.live.ahead(ctx, points, drag.ahead ?? [], width, m, color, brush);
      } else {
        // 抜き (the taper at the end) comes when the pen lifts, as in CSP.
        drawStroke(ctx, { id: "", points, widthMm: width, closed: false, brush: brush?.id, cut: [false, true] }, m, color, 0.7, brush);
      }
    }
    this.drawFrame();
    if (this.scene.tool === "pen" && !this.scene.erasing() && !this.scene.spaceHeld && this.scene.pointer && penPreferences.settings.cursor === "brush") {
      // The pen's size where it will draw.
      drawPenCursor(ctx, this.scene.pointer, Math.max((this.scene.penWidthMm / 2) * (this.stage.slots[0]?.scale ?? 1), 2));
    }
    if (this.scene.erasing() && this.scene.eraseMode !== "lasso" && this.scene.pointer) drawRing(ctx, this.scene.pointer, this.scene.eraserRadiusPx());
  }

  /** The lines snapped to, across the page they are on. */
  private drawGuides(): void {
    const guides = this.scene.guides;
    const slot = guides && this.stage.slots.find((s) => s.page.id === guides.pageId);
    if (!guides || !slot || (!guides.xs.length && !guides.ys.length)) return;
    drawGuideLines(this.ctx, this.host.project()!, slot, guides.xs, guides.ys, GUIDE);
  }

  /** The grid (when panels snap to it) on the pages, while panels are cut, drawn or changed. */
  private drawGrid(project: Project): void {
    const { grid, gridMm } = this.scene.snapping;
    const panelDrag = this.scene.drag && ["frame", "vertex", "seam", "scale"].includes(this.scene.drag.kind);
    const moving = this.scene.drag?.kind === "move" && !!this.scene.drag.snap;
    if (!grid || !(this.scene.tool === "cut" || panelDrag || moving)) return;
    // Too fine to see: no grid.
    drawSnapGrid(this.ctx, project, this.stage.slots.filter((slot) => gridMm * slot.scale >= 4 && !this.stage.small(project, slot)), gridMm);
  }

  /** 多角形: the corners placed, and the side to where the pointer is. */
  private drawPolygon(): void {
    const polygon = this.scene.polygon;
    const slot = this.scene.polygonSlot();
    if (!polygon || !slot) return;
    const points = [...polygon.points];
    let closing = false;
    if (this.scene.pointer && !this.scene.drag) {
      const pointer = toPage(slot, ...this.scene.pointer);
      const first = polygon.points[0];
      closing = polygon.points.length >= 3 && Math.hypot(first[0] - pointer[0], first[1] - pointer[1]) * slot.scale <= 8;
      if (!closing) points.push(this.scene.nextCorner(slot, pointer, false));
    }
    drawCorners(this.ctx, slot, polygon.points, points, closing);
  }

  private drawFrame(): void {
    const drag = this.scene.drag;
    // 自由変形: the four corners as they are being pulled.
    if (drag?.kind === "warp") return drawWarpCorners(this.ctx, drag.slot, drag.corners);
    if (drag && drag.kind !== "scale" && drag.kind !== "rotate") return;
    const frame = this.picks.frameGeometry();
    if (frame) drawTransformFrame(this.ctx, frame.handles, frame.rotate);
  }

  private drawTailHandles(slot: Slot, line: Line, strong: boolean): void {
    const s = this.picks.selection;
    drawTailHandles(this.ctx, slot, line, strong, s?.kind === "line" && s.id === line.id && s.pageId === slot.page.id ? s.tail : undefined);
  }

  /** Keep the pages as drawn now (without the overlay) for the pen line to go over. */
  captureBase(): void {
    this.live = null;
    // The screen already shows the pages unless a frame is still to be drawn
    // (drawing them again would delay the start of the line).
    if (this.frame || this.cacheStale || !this.cache) this.draw();
    // The picture of the pages (without what lies over them, such as the pen's cursor) takes the line.
    if (this.cache) this.live = new LiveLine(this.cache.getContext("2d")!);
  }

  /** A drag ended. A line drawn is no longer: the picture of the pages holds it, so the pages are drawn again before it shows. */
  endLive(): void {
    perfMeter.dragEnded();
    this.onScreen = null;
    if (!this.live) return;
    this.live = null;
    this.cacheStale = true;
  }

  /** 低遅延: whether the pen line being drawn can take its input as it comes (the pages are kept for it to go over). */
  get takesRaw(): boolean {
    return this.live !== null && this.cache !== null;
  }

  /** Whether the line being drawn went onto the screen as its input came (the frame after it only looks ahead). */
  get paintedRaw(): boolean {
    return this.onScreen !== null;
  }

  /** 低遅延: the pen's line so far straight onto the screen; the picture of the pages takes it once a frame (draw). */
  paintRaw(drag: DragOf<"pen">): void {
    this.onScreen ??= new LiveLine(this.ctx);
    const [width, color, brush] = this.liveInk(drag);
    this.onScreen.paint(drag.points, width, { scale: drag.slot.scale, x: drag.slot.x, y: drag.slot.y }, color, brush);
    perfMeter.shown();
    this.requestDraw();
  }

  /** A brush's tip finished loading: the lines drawn with it are drawn anew. */
  tipsChanged(): void {
    this.strokeCache.tipsChanged();
    this.draw();
  }

}

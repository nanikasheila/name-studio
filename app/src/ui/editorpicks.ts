// What is picked on the pages, and what is done with it as a whole: the
// selection and its bar of actions, the transform frame (変形), copy and
// paste, moving it (onto another page too), and what a press would pick.
// Each tool's own drags are in its module (toolselect.ts, ...); the drawing
// is in editorpaint.ts.
import { carryItems, carrySticky, type Destination } from "../domain/carry";
import { offPage } from "../domain/aside";
import { FRAME_HANDLES, framedAtOnce, toolHolds, type Drag, type EditorHost, type Hover, type Selection, type TailHit, type Tool } from "./editorcore";
import type { EditorStage } from "./editorstage";
import { bounds, insideBox, insidePolygon } from "../model/geometry";
import { cornerAt, HANDLE, pickAt, tailAt } from "../editing/hittest";
import { holdPanel, placeHeld } from "../domain/hold";
import { nearestSlot, toPage, type Slot } from "../editing/layout";
import type { Binding, BoxMm, Page, Point, Project } from "../model/model";
import { type CarriedContents, carryContents, followPanel, panelContents } from "../domain/panels";
import { assignPanels, orderPanels, sortLines } from "../domain/readingorder";
import { strokeEditable } from "../domain/roughlayers";
import { settleSticky } from "../domain/stickies";
import { strokeHit } from "../domain/strokes";
import { pickedSummary } from "./toolselect";
import { baseBounds, copySelection, moveItems, pasteClip, rotation, scaling, selectionBox, transformBase, transformItems, withContents, type Clip, type ItemRef } from "../domain/transform";

/** How far above the transform frame its turning handle is (px). */
const ROTATE_GAP = 22;

/** What the selection needs from the editor around it. */
export interface PicksScene {
  readonly tool: Tool;
  /** The drag under way, the pointer and what it is over. */
  readonly drag: Drag | null;
  readonly hover: Hover | null;
  readonly pointer: Point | null;
  /** A text is being written on the page. */
  readonly writing: boolean;
  /** コマに中身が付いてくる. */
  readonly panelCarries: boolean;
  binding(): Binding;
  /** 付箋 are hidden and one is to be picked: show them. */
  showStickies(): void;
  draw(): void;
}

export class EditorPicks {
  selection: Selection | null = null;

  /** 変形 (Ctrl+T): the transform frame on a panel, a balloon, a fill or a はみ出し. */
  private transforming = false;

  /** What was copied last (Ctrl+C), and how often it was pasted onto its own page. */
  private clip: Clip | null = null;

  private pastes = 0;

  /** The small bar of actions beside the selection. */
  private readonly bar: HTMLDivElement;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly host: EditorHost,
    private readonly stage: EditorStage,
    private readonly scene: PicksScene,
  ) {
    this.bar = document.createElement("div");
    this.bar.className = "action-bar";
    this.bar.hidden = true;
    // Presses on the bar are not presses on the page.
    this.bar.addEventListener("pointerdown", (event) => event.stopPropagation());
    canvas.parentElement?.append(this.bar);
  }

  /** A tool was taken up: 変形 ends, and what the tool does not keep is let go (Delete and the arrows never act on what is not shown as picked). */
  toolTaken(tool: Tool): void {
    this.transforming = false;
    if (this.selection && !toolHolds(tool, this.selection.kind)) {
      this.selection = null;
      this.host.selectionChanged(null);
    }
  }

  /** `quiet`: another part of the screen took the selection, and says so itself. */
  select(selection: Selection | null, quiet = false): void {
    // What the tool in hand does not keep is picked with the select tool (from a list, a paste, Ctrl+A).
    if (selection && !toolHolds(this.scene.tool, selection.kind)) this.host.useTool("select");
    if (selection?.kind === "sticky" && !this.stage.showStickies) this.scene.showStickies();
    const same = selection && this.selection && selection.kind === this.selection.kind && selection.id === this.selection.id && selection.pageId === this.selection.pageId;
    if (!same) this.transforming = false;
    this.selection = selection;
    if (!quiet) this.host.selectionChanged(selection);
    this.renderBar();
    this.scene.draw();
  }

  /** Fill the action bar for the selection (or hide it). */
  renderBar(): void {
    const s = this.selection;
    this.bar.replaceChildren(...(s && this.scene.tool === "select" ? this.host.actions(s) : []));
    this.placeBar();
  }

  /** The selection's box on screen (px), when its page is shown. */
  private selectionScreenBox(): BoxMm | null {
    const s = this.selection;
    const slot = s && this.stage.slots.find((x) => x.page.id === s.pageId);
    if (!s || !slot) return null;
    const box = selectionBox(slot.page, s.kind, s.id, this.pickedItems());
    if (!box) return null;
    const corners = [
      [box[0], box[1]],
      [box[2], box[1]],
      [box[2], box[3]],
      [box[0], box[3]],
    ].map(([x, y]) => this.stage.view.onScreen([slot.x + x * slot.scale, slot.y + y * slot.scale]));
    return bounds(corners);
  }

  /** Put the bar above the selection (below it when there is no room), inside the stage. */
  placeBar(): void {
    const box = this.scene.drag || this.scene.writing || !this.bar.childElementCount ? null : this.selectionScreenBox();
    this.bar.hidden = !box;
    if (!box) return;
    const { width, height } = this.stage.stageSize();
    const w = this.bar.offsetWidth;
    const h = this.bar.offsetHeight;
    // Clear of the turning handle above a transform frame.
    let y = box[1] - h - ROTATE_GAP - 14;
    if (y < 6) y = Math.min(box[3] + 14, height - h - 6);
    const x = Math.min(Math.max((box[0] + box[2]) / 2 - w / 2, 6), width - w - 6);
    this.bar.style.left = `${x}px`;
    this.bar.style.top = `${Math.max(y, 6)}px`;
  }

  /** The page the selection is on, else the page of the spread last clicked or picked, else its first page. */
  focusPage(): Page | null {
    const project = this.host.project();
    if (!project) return null;
    if (this.selection) {
      const page = project.pages.find((p) => p.id === this.selection!.pageId);
      if (page) return page;
    }
    const shown = this.stage.currentPages().map((number) => project.pages[number - 1]).filter(Boolean);
    return shown.find((page) => page.id === this.stage.focusedPageId) ?? shown[0] ?? null;
  }

  /** The page settings follow the page worked on; 連続: its spread is the one worked on. */
  focusOn(slot: Slot): void {
    const moved = this.stage.focusOn(slot);
    this.host.selectionChanged(this.selection);
    if (moved) this.host.spreadChanged?.();
  }

  /**
   * What was dragged onto another page goes to that page: dialogue and rough
   * lines past the gutter, or (連続) onto any page on the canvas, and a panel
   * with what is in it.
   */
  carryToPageUnder(project: Project, slot: Slot): void {
    const s = this.selection;
    if (!s || s.pageId !== slot.page.id) return;
    // Over another page, or off every page: the page whose 欄外 it now lies in.
    const nearest = ([x, y]: Point) => nearestSlot(this.stage.slots, project.pageFormat, [slot.x + x * slot.scale, slot.y + y * slot.scale]);
    const slotUnder = (point: Point) => this.stage.otherPageUnder(project, slot, point) ?? (offPage([...point, ...point], project.pageFormat) && nearest(point) !== slot ? nearest(point) : null);
    const under = (point: Point): Destination | null => {
      const to = slotUnder(point);
      return to && { page: to.page, offset: [(slot.x - to.x) / slot.scale, (slot.y - to.y) / slot.scale] };
    };
    const slotOf = (page: Page) => this.stage.slots.find((x) => x.page === page)!;
    if (s.kind === "sticky") {
      const sticky = slot.page.stickies?.find((n) => n.id === s.id);
      const to = sticky && carrySticky(project, slot.page, sticky, under);
      if (to) {
        this.selection = { ...s, pageId: to.id };
        this.focusOn(slotOf(to));
      }
      return;
    }
    if (s.kind === "panel") {
      const panel = slot.page.panels.find((p) => p.id === s.id);
      // Half of a 見開き panel stays: it is one panel with the facing page's half.
      if (!panel || panel.spread) return;
      const box = bounds(panel.shape);
      const centre: Point = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      const to = slotUnder(centre);
      if (!to) return;
      const at = toPage(to, slot.x + centre[0] * slot.scale, slot.y + centre[1] * slot.scale);
      const moved = placeHeld(project, to.page, holdPanel(project, slot.page, panel, to.page.id), at);
      this.selection = { kind: "panel", pageId: to.page.id, id: moved.id };
      this.focusOn(to);
      this.host.status(`コマを中身ごと ${to.index + 1} ページへ移しました（コマ ${moved.order}）`);
      return;
    }
    const all: ItemRef[] = s.kind === "group" ? (s.items ?? []) : s.kind === "line" || s.kind === "stroke" ? [{ kind: s.kind, id: s.id }] : [];
    const { moved, to } = carryItems(project, slot.page, all, under);
    if (!moved.length) return;
    const targets = [...to].map(slotOf);
    // The selection follows when everything went to one page.
    if (moved.length === all.length && targets.length === 1) this.selection = { ...s, pageId: targets[0].page.id };
    else if (s.kind === "group") this.selection = { ...s, items: all.filter((item) => !moved.includes(item)) };
    else this.selection = null;
    if (this.selection?.pageId === targets[0].page.id) this.focusOn(targets[0]);
    else this.host.selectionChanged(this.selection);
    const pages = targets.map((t) => t.index + 1).sort((a, b) => a - b).join("・");
    this.host.status(`${moved.length} 個を ${pages} ページへ移しました`);
  }

  /** What is picked, as things to move or turn: a panel (and a group's panels) with what is drawn in it (コマ枠フォルダ). */
  private pickedItems(): ItemRef[] {
    const s = this.selection;
    const page = s && this.host.project()?.pages.find((p) => p.id === s.pageId);
    if (!s || !page || s.kind === "sticky") return [];
    return withContents(page, s.kind === "group" ? (s.items ?? []) : [{ kind: s.kind, id: s.id }], this.scene.panelCarries);
  }

  /** What the transform frame works on: with the select tool, what has no handles of its own, or anything with 変形 on. */
  selectedItems(): ItemRef[] {
    const s = this.selection;
    if (!s || this.scene.tool !== "select") return [];
    return framedAtOnce(s.kind) || this.transforming ? this.pickedItems() : [];
  }

  get isTransforming(): boolean {
    return this.transforming;
  }

  /** 変形 on or off for the selection (Ctrl+T); false when it cannot be transformed. */
  toggleTransform(on = !this.transforming): boolean {
    const s = this.selection;
    if (on) {
      if (!s || !["panel", "line", "fill", "breakout", "stroke", "group"].includes(s.kind)) return false;
      const page = this.host.project()?.pages.find((p) => p.id === s.pageId);
      if (s.kind === "panel" && page?.panels.find((p) => p.id === s.id)?.spread) {
        this.host.status("見開きのコマは変形できません。頂点や間白で形を変えてください");
        return false;
      }
      if (this.scene.tool !== "select") this.host.useTool("select");
    }
    this.transforming = on;
    this.renderBar();
    this.scene.draw();
    this.host.status(
      on
        ? "変形: 四角をドラッグで拡大縮小（Shift で縦横別々、Alt で中心から）、丸で回転、Ctrl + 角で自由変形。Enter で終わる"
        : "",
    );
    return true;
  }

  /** The transform frame on screen: its box (mm), slot and handle positions (px). */
  frameGeometry(): { slot: Slot; box: BoxMm; handles: Point[]; rotate: Point } | null {
    if (this.scene.tool !== "select" || !this.selection) return null;
    const items = this.selectedItems();
    const slot = this.stage.slots.find((s) => s.page.id === this.selection!.pageId);
    if (!items.length || !slot) return null;
    // A panel's frame is the panel's own box; what is in it just goes along.
    const own = this.selection.kind === "group" ? (this.selection.items ?? []) : items[0].kind === "panel" ? items.slice(0, 1) : items;
    const box = baseBounds(transformBase(slot.page, own));
    if (!box) return null;
    const pad = 3 / slot.scale;
    const [x0, y0, x1, y1] = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
    const sx = (x: number) => slot.x + x * slot.scale;
    const sy = (y: number) => slot.y + y * slot.scale;
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const handles: Point[] = [
      [sx(x0), sy(y0)],
      [sx(x1), sy(y0)],
      [sx(x1), sy(y1)],
      [sx(x0), sy(y1)],
      [sx(cx), sy(y0)],
      [sx(x1), sy(cy)],
      [sx(cx), sy(y1)],
      [sx(x0), sy(cy)],
    ];
    return { slot, box: [x0, y0, x1, y1], handles, rotate: [sx(cx), sy(y0) - ROTATE_GAP] };
  }

  /** The frame handle at a screen point: 0..7, 8 for turning, or -1. */
  frameHandleAt(sx: number, sy: number): number {
    const frame = this.frameGeometry();
    if (!frame) return -1;
    if (Math.hypot(frame.rotate[0] - sx, frame.rotate[1] - sy) <= HANDLE + 3) return FRAME_HANDLES;
    return frame.handles.findIndex(([x, y]) => Math.abs(x - sx) <= HANDLE + 2 && Math.abs(y - sy) <= HANDLE + 2);
  }

  /** 左右反転 / 上下反転 / 90° turns of what is selected. */
  transformSelection(how: "flipH" | "flipV" | "left" | "right"): boolean {
    const page = this.focusPage();
    const s = this.selection;
    if (s?.kind === "panel" && page?.panels.find((p) => p.id === s.id)?.spread) {
      this.host.status("見開きのコマは反転・回転できません。頂点や間白で形を変えてください");
      return false;
    }
    // Whatever is picked, 変形 on or not; a panel with what is drawn in it.
    const items = this.pickedItems();
    if (!page || !items.length) return false;
    const base = transformBase(page, items);
    const box = baseBounds(base);
    if (!box) return false;
    const centre: Point = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    const m =
      how === "flipH" ? scaling(-1, 1, centre) : how === "flipV" ? scaling(1, -1, centre) : rotation(((how === "right" ? 1 : -1) * Math.PI) / 2, centre);
    this.host.begin();
    transformItems(page, base, m);
    assignPanels(page);
    sortLines(page, this.scene.binding());
    this.host.commit();
    this.scene.draw();
    return true;
  }

  /** Copy what is selected; with `cut`, take it away too (the caller deletes). */
  copy(): boolean {
    const page = this.focusPage();
    const s = this.selection;
    if (!page || !s) return false;
    const panel = s.kind === "panel" ? page.panels.find((p) => p.id === s.id) : undefined;
    const source = s.kind === "group" ? { ...s, items: withContents(page, s.items ?? [], this.scene.panelCarries) } : s;
    const clip = copySelection(page, source, panel ? panelContents(page, panel) : undefined);
    if (!clip) return false;
    this.clip = clip;
    this.pastes = 0;
    const count = clip.panels.length + clip.strokes.length + clip.lines.length + clip.breakouts.length + clip.stickies.length + (clip.fills?.length ?? 0);
    this.host.status(`${clip.panels.length ? "コマと中身" : `${count} 個`}をコピーしました。Ctrl+V で、ポインターのあるページに貼り付けます`);
    return true;
  }

  get canPaste(): boolean {
    return this.clip !== null;
  }

  /**
   * Paste onto the page under the pointer (or the selection's page, or the
   * right page of the spread): where it was on its page, a little lower
   * right each time it goes onto its own page again.
   */
  /** Where something pasted goes: the page under the pointer (and the point there), else the page worked on. */
  pasteTarget(): { page: Page; point?: Point } | null {
    const project = this.host.project();
    if (!project) return null;
    const under = this.scene.pointer && (this.stage.slotAt(this.scene.pointer[0], this.scene.pointer[1], project) ?? nearestSlot(this.stage.slots, project.pageFormat, this.scene.pointer));
    if (under) return { page: under.page, point: toPage(under, this.scene.pointer![0], this.scene.pointer![1]) };
    const page = this.focusPage();
    return page ? { page } : null;
  }

  paste(): boolean {
    const project = this.host.project();
    if (!project || !this.clip) return false;
    const under = this.scene.pointer && this.stage.slotAt(this.scene.pointer[0], this.scene.pointer[1], project);
    const selected = this.selection && this.stage.slots.find((slot) => slot.page.id === this.selection!.pageId);
    const focused = this.focusPage();
    const slot = under || selected || this.stage.slots.find((s) => s.page === focused) || [...this.stage.slots].sort((a, b) => b.x - a.x)[0];
    if (!slot) return false;
    const page = slot.page;
    if (page.id === this.clip.pageId) this.pastes += 1;
    const shift = page.id === this.clip.pageId ? this.pastes * 5 : 0;
    this.host.begin();
    const pasted = pasteClip(project, page, this.clip, [shift, shift]);
    this.host.commit();
    const items: ItemRef[] = [
      ...pasted.strokes.map((id) => ({ kind: "stroke" as const, id })),
      ...pasted.lines.map((id) => ({ kind: "line" as const, id })),
      ...pasted.panels.map((id) => ({ kind: "panel" as const, id })),
      ...pasted.fills.map((id) => ({ kind: "fill" as const, id })),
      ...pasted.breakouts.map((id) => ({ kind: "breakout" as const, id })),
    ];
    // One panel goes on with what is in it; more things are picked together.
    if (pasted.panels.length === 1 && !pasted.fills.length && !pasted.breakouts.length) this.select({ kind: "panel", pageId: page.id, id: pasted.panels[0] });
    else if (items.length > 1) this.select({ kind: "group", pageId: page.id, id: "group", items });
    else if (items.length) this.select({ kind: items[0].kind, pageId: page.id, id: items[0].id });
    else if (pasted.stickies.length) this.select({ kind: "sticky", pageId: page.id, id: pasted.stickies[0] });
    this.host.status(`${slot.index + 1} ページに貼り付けました`);
    return true;
  }

  /** Ctrl+A: everything on the page (but halves of 見開き panels), to move or transform the page's whole drawing. */
  selectAll(): boolean {
    const page = this.focusPage();
    if (!page) return false;
    const items: ItemRef[] = [
      ...page.panels.filter((panel) => !panel.spread).map((p) => ({ kind: "panel" as const, id: p.id })),
      ...page.strokes.map((s) => ({ kind: "stroke" as const, id: s.id })),
      ...page.lines.map((l) => ({ kind: "line" as const, id: l.id })),
      ...(page.fills ?? []).map((f) => ({ kind: "fill" as const, id: f.id })),
      ...page.breakouts.map((b) => ({ kind: "breakout" as const, id: b.id })),
    ];
    if (!items.length) return false;
    this.select(items.length === 1 ? { kind: items[0].kind, pageId: page.id, id: items[0].id } : { kind: "group", pageId: page.id, id: "group", items });
    this.host.status(`${pickedSummary(items)}を選びました。枠の四角で大きさ、丸で向き、Ctrl + 角で自由変形`);
    return true;
  }

  isSelected(page: Page, kind: Selection["kind"], id: string): boolean {
    const s = this.selection;
    if (!s || s.pageId !== page.id) return false;
    if (s.kind === "group") return !!s.items?.some((item) => item.kind === kind && item.id === id);
    return s.kind === kind && s.id === id;
  }

  /** Whether `point` is on one of the picked lines, inside a picked text, or inside a picked panel, fill or はみ出し. */
  groupHit(page: Page, point: Point, tolerance: number): boolean {
    for (const item of this.selection?.items ?? []) {
      if (item.kind === "stroke") {
        const stroke = page.strokes.find((x) => x.id === item.id);
        if (stroke && strokeHit(stroke, point, tolerance + stroke.widthMm)) return true;
      } else if (item.kind === "line") {
        const line = page.lines.find((l) => l.id === item.id);
        if (line && insideBox(line.box, point)) return true;
      } else {
        const list = item.kind === "panel" ? page.panels : item.kind === "fill" ? (page.fills ?? []) : page.breakouts;
        const shape = list.find((x) => x.id === item.id)?.shape;
        if (shape && insidePolygon(shape, point)) return true;
      }
    }
    return false;
  }

  /** What a click at `point` picks on the page as shown (what is hidden cannot be picked). */
  hit(slot: Slot, point: Point): Selection | null {
    const page = this.stage.visiblePage(slot.page);
    const project = this.host.project();
    const found = pickAt(page, point, slot.scale, {
      open: (sticky) => this.isSelected(page, "sticky", sticky.id) || (this.scene.hover?.kind === "item" && this.scene.hover.target.id === sticky.id),
      selectedLine: this.selection?.kind === "line" && this.selection.pageId === page.id ? this.selection.id : null,
      editable: (stroke) => !project || strokeEditable(project, stroke),
    });
    return found && { ...found, pageId: page.id };
  }

  vertexAt(slot: Slot, sx: number, sy: number): number {
    const s = this.selection;
    if (s?.kind !== "panel" || s.pageId !== slot.page.id || this.transforming) return -1;
    const panel = slot.page.panels.find((p) => p.id === s.id);
    return panel ? cornerAt(slot, panel, sx, sy) : -1;
  }

  /** The tail under the pointer; the selected or hovered line's handles too. Any line's tails can be taken without picking the line first. */
  tailAt(slot: Slot, sx: number, sy: number): TailHit | null {
    const s = this.selection;
    const shown = new Set<string>();
    if (s?.kind === "line" && s.pageId === slot.page.id) shown.add(s.id);
    if (this.scene.hover?.kind === "item" && this.scene.hover.target.kind === "line") shown.add(this.scene.hover.target.id);
    if (this.scene.hover?.kind === "tail") shown.add(this.scene.hover.hit.lineId);
    return tailAt(slot, sx, sy, shown);
  }

  /** Move what is selected; `items`: a 範囲選択 with what its panels hold, as taken when the drag began. */
  moveSelection(page: Page, dx: number, dy: number, items?: ItemRef[]): void {
    const s = this.selection;
    if (s?.kind === "sticky") {
      const sticky = page.stickies?.find((n) => n.id === s.id);
      // On its page or in its 欄外 once let go (carryToPageUnder).
      if (sticky) sticky.at = [sticky.at[0] + dx, sticky.at[1] + dy];
    } else if (s) moveItems(page, s.kind === "group" ? (items ?? this.pickedItems()) : [{ kind: s.kind, id: s.id }], dx, dy);
  }

  /** Contents carried by the selected panel follow it. */
  follow(page: Page, carried: CarriedContents | undefined): void {
    const s = this.selection;
    const panel = carried && s?.kind === "panel" ? page.panels.find((p) => p.id === s.id) : undefined;
    if (panel && carried) followPanel(page, panel, carried);
  }

  /** Nudge the selection with the arrow keys (mm), as a drag moves it (a panel with what is drawn in it). */
  nudge(dx: number, dy: number): boolean {
    const page = this.focusPage();
    if (!page || !this.selection) return false;
    const s = this.selection;
    const panel = s.kind === "panel" ? page.panels.find((p) => p.id === s.id) : undefined;
    const carried = panel && this.scene.panelCarries ? carryContents(page, panel) : undefined;
    this.host.begin();
    this.moveSelection(page, dx, dy);
    this.follow(page, carried);
    const sticky = this.selection.kind === "sticky" ? page.stickies?.find((n) => n.id === this.selection!.id) : undefined;
    if (sticky) settleSticky(this.host.project()!, sticky);
    if (this.selection.kind === "panel" || this.selection.items?.some((item) => item.kind === "panel")) orderPanels(page, this.host.project()!.binding);
    assignPanels(page);
    sortLines(page, this.scene.binding());
    this.host.commit();
    this.scene.draw();
    return true;
  }

}

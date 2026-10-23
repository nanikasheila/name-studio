// 全体: the story shape, scenes, story time, emotion curves and the pages
// with their panels, on one page axis. Everything is changed where it is
// shown: drag the parts of the shape, the ends of a scene, a scene up or down
// in story time, the emotion curve, a page to another place, or a panel onto
// another panel (on any page) to swap what they hold.
import { drawBalloons, drawLineText, drawPageFills, drawPanelBorders, drawPanelFills, drawStrokes, type MmToPx } from "./pagedraw";
import {
  addCharacter,
  addScene,
  fitLine,
  moveScene,
  pageBlock,
  pageIndex,
  removeCharacter,
  setEmotion,
  swapPanelContents,
  textAmount,
  type Panel,
  type Project,
  type StoryShape,
} from "./project";
import {
  addBeat,
  adoptShape,
  beatPage,
  currentShape,
  editableShape,
  forgetShape,
  isBuiltinShape,
  keepShape,
  libraryShapes,
  makeShape,
  moveBoundary,
  partColor,
  removeBeat,
  removePart,
  removeShape,
  setBeat,
  shapeSpans,
  splitPart,
  storyShapes,
} from "./shapes";
import { emotionSeries, HEAVY_TEXT, moveSceneEdge, sceneAtPage, sceneSpans, setStoryRank, timeline, uncoveredRunAt, type SceneSpan } from "./story";
import type { OverviewHost } from "./overview";

const SVG = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}

function html<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

export type BoardSelection =
  | { kind: "page"; pageId: string }
  | { kind: "scene"; sceneId: string }
  | { kind: "panel"; pageId: string; panelId: string }
  | { kind: "shape" };

export interface BoardTip {
  show(event: MouseEvent, lines: string[]): void;
  hide(): void;
}

/** Lane heights (px). */
const RULER = 22;
const SHAPE = 50;
const SCENE = 42;
const ROW = 20;
const EMOTION = 150;
const TEXT = 40;
const LABEL_WIDTH = 78;
export const MIN_COLUMN = 24;
export const MAX_COLUMN = 240;

/** Follow a press until it is let go; `moved` turns true past a few pixels. */
function track(
  down: PointerEvent,
  target: Element,
  handlers: { move?: (event: PointerEvent, moved: boolean) => void; end: (event: PointerEvent, moved: boolean) => void },
): void {
  const [sx, sy] = [down.clientX, down.clientY];
  let moved = false;
  try {
    target.setPointerCapture(down.pointerId);
  } catch {
    // Synthetic events have no pointer to capture.
  }
  const move = (event: Event) => {
    const e = event as PointerEvent;
    if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) > 4) moved = true;
    handlers.move?.(e, moved);
  };
  const end = (event: Event) => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    handlers.end(event as PointerEvent, moved && event.type === "pointerup");
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
}

export class Board {
  /** Width of one page column, px. */
  private column = 0;
  private selection: BoardSelection | null = null;
  /** Character whose emotion values the curve lane changes. */
  private character: string | null = null;
  private scroll = { left: 0, top: 0 };
  /** A press is being followed: renders wait until it ends. */
  private busy = false;
  private renderLater = false;
  private canvas: HTMLDivElement | null = null;
  private scroller: HTMLDivElement | null = null;
  private inspector: HTMLElement | null = null;
  private marks: HTMLDivElement | null = null;
  private project: Project | null = null;

  constructor(
    private readonly host: OverviewHost,
    private readonly tip: BoardTip,
    private readonly rerender: () => void,
  ) {}

  /** The board for `project`, or null to keep what is shown (a drag is under way). */
  render(project: Project, width: number): HTMLElement | null {
    if (this.busy) {
      this.renderLater = true;
      return null;
    }
    this.project = project;
    this.tip.hide();
    this.checkSelection(project);
    const count = project.pages.length;
    if (!this.column) this.column = Math.round(Math.max(56, Math.min(120, (width - LABEL_WIDTH - 340) / Math.max(count, 1))));
    const top = this.toolbar(project);
    const body = html("div", { className: "board-body" });
    const lanes = this.lanes(project);
    this.inspector = html("aside", { className: "board-inspector" });
    body.append(lanes, this.inspector);
    this.renderInspector();
    return html("div", { className: "board" }, top, body);
  }

  /** After the board is in the page: scroll back to where it was. */
  mounted(): void {
    if (!this.scroller) return;
    this.scroller.scrollLeft = this.scroll.left;
    this.scroller.scrollTop = this.scroll.top;
    this.paintSelection();
  }

  private edit(change: (project: Project) => void): void {
    this.host.edit(change);
  }

  private hold(): void {
    this.busy = true;
  }

  private release(): void {
    this.busy = false;
    if (this.renderLater) {
      this.renderLater = false;
      this.rerender();
    }
  }

  private checkSelection(project: Project): void {
    const s = this.selection;
    if (!s) return;
    const ok =
      s.kind === "shape"
        ? !!currentShape(project)
        : s.kind === "scene"
          ? project.scenes.some((scene) => scene.id === s.sceneId)
          : s.kind === "page"
            ? project.pages.some((page) => page.id === s.pageId)
            : !!project.pages.find((page) => page.id === s.pageId)?.panels.some((panel) => panel.id === s.panelId);
    if (!ok) this.selection = null;
  }

  select(selection: BoardSelection | null): void {
    this.selection = selection;
    this.paintSelection();
    this.renderInspector();
  }

  // --- top bar -------------------------------------------------------------------

  private toolbar(project: Project): HTMLElement {
    const shapes = html("select", { title: "ページ配分の目安にする話の型" });
    shapes.append(html("option", { value: "", textContent: "話の型なし" }));
    const current = project.plan?.structure ?? "";
    const own = project.plan?.shapes ?? [];
    const builtIn = html("optgroup", { label: "決まった型" } as Partial<HTMLOptGroupElement>);
    const mine = html("optgroup", { label: "このネームの型" } as Partial<HTMLOptGroupElement>);
    const kept = html("optgroup", { label: "この PC の型" } as Partial<HTMLOptGroupElement>);
    for (const shape of storyShapes(project)) {
      (isBuiltinShape(shape.id) ? builtIn : mine).append(html("option", { value: shape.id, textContent: shape.label, selected: shape.id === current }));
    }
    for (const shape of libraryShapes()) {
      if (own.some((s) => s.id === shape.id)) continue;
      kept.append(html("option", { value: `library:${shape.id}`, textContent: shape.label }));
    }
    shapes.append(builtIn);
    if (mine.childElementCount) shapes.append(mine);
    if (kept.childElementCount) shapes.append(kept);
    shapes.append(html("option", { value: "new", textContent: "＋ 自分の型を作る…" }));
    shapes.addEventListener("change", () => {
      const value = shapes.value;
      this.edit((p) => {
        if (value === "new") {
          keepShape(makeShape(p));
          this.selection = { kind: "shape" };
          return;
        }
        if (value.startsWith("library:")) {
          const shape = libraryShapes().find((s) => s.id === value.slice(8));
          if (shape) adoptShape(p, shape);
          return;
        }
        const plan = { ...(p.plan ?? {}) };
        if (value) plan.structure = value;
        else delete plan.structure;
        if (Object.keys(plan).length) p.plan = plan;
        else delete p.plan;
      });
    });
    const editShape = html("button", { textContent: "型を直す", title: "区切りやビートの名前・配分を直す", disabled: !currentShape(project) });
    editShape.addEventListener("click", () => this.select({ kind: "shape" }));
    const target = html("input", { type: "number", min: "1", value: project.plan?.targetPages ? String(project.plan.targetPages) : "", placeholder: String(project.pages.length), title: "目標ページ数" });
    target.addEventListener("change", () =>
      this.edit((p) => {
        const value = Number.parseInt(target.value, 10);
        const plan = { ...(p.plan ?? {}) };
        if (Number.isInteger(value) && value > 0) plan.targetPages = value;
        else delete plan.targetPages;
        if (Object.keys(plan).length) p.plan = plan;
        else delete p.plan;
      }),
    );

    // Whose feelings the curve lane draws on.
    if (!this.character || !project.characters.some((c) => c.id === this.character)) this.character = project.characters[0]?.id ?? null;
    const cast = html("div", { className: "board-cast", title: "感情曲線をなぞる人物" });
    for (const character of project.characters) {
      const chip = html("button", { className: `chip${character.id === this.character ? " active" : ""}` }, html("span", { className: "swatch" }), character.name);
      (chip.firstChild as HTMLElement).style.background = character.color ?? "#2a78d6";
      chip.addEventListener("click", () => {
        this.character = character.id;
        this.rerender();
      });
      cast.append(chip);
    }
    const addCast = html("button", { className: "chip", textContent: "＋人物", title: "登場人物を足す（名前は右の欄で）" });
    addCast.addEventListener("click", () =>
      this.edit((p) => {
        this.character = addCharacter(p, `人物${p.characters.length + 1}`).id;
        this.selection = null;
      }),
    );
    cast.append(addCast);

    const zoom = html("input", { type: "range", min: String(MIN_COLUMN), max: String(MAX_COLUMN), value: String(this.column), title: "ページの幅（Ctrl＋ホイールでも）" });
    zoom.addEventListener("input", () => this.zoomTo(Number(zoom.value)));
    const fit = html("button", { textContent: "全体を表示", title: "全ページが横に収まる幅にする" });
    fit.addEventListener("click", () => {
      const width = (this.scroller?.clientWidth ?? 800) - 8;
      this.zoomTo(Math.floor(width / Math.max(project.pages.length, 1)));
    });
    return html(
      "div",
      { className: "board-top" },
      html("h2", { textContent: "全体" }),
      html("label", {}, "話の型 ", shapes),
      editShape,
      html("label", {}, "目標 ", target, " ページ"),
      html("span", { className: "board-sep" }),
      html("span", { className: "board-caption", textContent: "感情:" }),
      cast,
      html("div", { className: "spacer" }),
      html("label", { className: "board-zoom" }, "幅 ", zoom),
      fit,
    );
  }

  private zoomTo(column: number, anchorX?: number): void {
    const next = Math.max(MIN_COLUMN, Math.min(MAX_COLUMN, Math.round(column)));
    if (next === this.column) return;
    const scroller = this.scroller;
    if (scroller) {
      // Keep the page under the pointer (or the middle) where it is.
      const x = anchorX ?? scroller.clientWidth / 2;
      const at = (scroller.scrollLeft + x) / this.column;
      this.scroll.left = Math.max(0, at * next - x);
      this.scroll.top = scroller.scrollTop;
    }
    this.column = next;
    this.rerender();
  }

  // --- lanes ------------------------------------------------------------------------

  private lanes(project: Project): HTMLElement {
    const count = project.pages.length;
    const width = Math.max(count, 1) * this.column;
    const rows = timeline(project);
    const timeHeight = Math.max(3, rows.length) * ROW + 14;
    const [pageW, pageH] = project.pageFormat.canvasMm;
    const thumbWidth = Math.max(16, this.column - 8);
    const thumbHeight = Math.round((thumbWidth * pageH) / pageW);
    const showMemo = this.column >= 88;
    const pagesHeight = 20 + thumbHeight + (showMemo ? 34 : 6);

    const lanes = [
      { label: "", height: RULER },
      { label: "話の型", height: SHAPE, hint: "区切りの線をドラッグで配分を変える（決まった型は自分の型に写してから）。◆はビート" },
      { label: "シーン", height: SCENE, hint: "両端のドラッグでページの範囲、真ん中のドラッグでシーンごと移動。空いた所をダブルクリックでシーンを足す" },
      { label: "時系列", height: timeHeight, hint: "上ほど物語の中で早い出来事。上下にドラッグで順を変える（回想など）" },
      { label: "感情", height: EMOTION, hint: "上の人物を選んで、なぞると値が入る。右クリック（Alt＋クリック）で消す" },
      { label: "字数", height: TEXT, hint: "ページごとのセリフの字数" },
      { label: "ページ・コマ", height: pagesHeight, hint: "ページ番号の帯をドラッグでページを移動。コマを別のコマ（ほかのページでも）にドラッグで中身を入れ替え。ダブルクリックで編集画面へ" },
    ];
    const labels = html("div", { className: "board-labels" });
    for (const lane of lanes) {
      const label = html("div", { className: "board-label", textContent: lane.label, title: lane.hint ?? "" });
      label.style.height = `${lane.height}px`;
      labels.append(label);
    }

    const canvas = html("div", { className: "board-canvas" });
    canvas.style.width = `${width}px`;
    this.canvas = canvas;
    const chartHeight = lanes.slice(0, 6).reduce((sum, lane) => sum + lane.height, 0);
    const chart = svg("svg", { width, height: chartHeight, class: "board-chart" });
    let y = 0;
    chart.append(this.ruler(project, y));
    y += RULER;
    chart.append(this.shapeLane(project, y));
    y += SHAPE;
    chart.append(this.sceneLane(project, y));
    y += SCENE;
    chart.append(this.timeLane(project, y, timeHeight));
    y += timeHeight;
    chart.append(this.emotionLane(project, y));
    y += EMOTION;
    chart.append(this.textLane(project, y));
    const pages = this.pageLane(project, thumbWidth, thumbHeight, showMemo);
    pages.style.height = `${pagesHeight}px`;
    this.marks = html("div", { className: "board-marks" });
    canvas.append(chart, pages, this.marks);

    const scroller = html("div", { className: "board-scroll" }, canvas);
    this.scroller = scroller;
    scroller.addEventListener("scroll", () => {
      this.scroll = { left: scroller.scrollLeft, top: scroller.scrollTop };
      labels.scrollTop = scroller.scrollTop;
    });
    scroller.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        const box = scroller.getBoundingClientRect();
        this.zoomTo(this.column * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX - box.left);
      },
      { passive: false },
    );
    return html("div", { className: "board-lanes" }, labels, scroller);
  }

  /** x of the left edge of page `index`. */
  private x(index: number): number {
    return index * this.column;
  }

  /** Page column under a pointer (clamped), and the nearest page boundary. */
  private at(event: MouseEvent): { index: number; boundary: number; x: number } {
    const box = this.canvas!.getBoundingClientRect();
    const x = event.clientX - box.left;
    const count = this.project?.pages.length ?? 1;
    return {
      x,
      index: Math.max(0, Math.min(count - 1, Math.floor(x / this.column))),
      boundary: Math.max(0, Math.min(count, Math.round(x / this.column))),
    };
  }

  /** First or last page of a scene whose edge is dragged to the boundary nearest the pointer. */
  private edgeIndex(event: MouseEvent, edge: "first" | "last"): number {
    const { boundary } = this.at(event);
    return edge === "first" ? boundary : boundary - 1;
  }

  private ruler(project: Project, top: number): SVGGElement {
    const group = svg("g", { class: "lane ruler" });
    const every = this.column >= 30 ? 1 : this.column >= 14 ? 5 : 10;
    project.pages.forEach((page, index) => {
      const x = this.x(index);
      const cell = svg("rect", { x, y: top, width: this.column, height: RULER, class: "ruler-cell" });
      cell.addEventListener("click", () => this.select({ kind: "page", pageId: page.id }));
      cell.addEventListener("dblclick", () => this.host.openPage(index + 1));
      group.append(cell);
      if (index % every === 0 || every === 1) group.append(svg("text", { x: x + this.column / 2, y: top + 15, class: "ruler-number", "text-anchor": "middle" }, String(index + 1)));
      if (page.joinNext) group.append(svg("line", { x1: x + this.column, x2: x + this.column, y1: top + 4, y2: top + RULER - 4, class: "spread-mark" }));
    });
    return group;
  }

  // 話の型 --------------------------------------------------------------------------

  private shapeLane(project: Project, top: number): SVGGElement {
    const group = svg("g", { class: "lane shape-lane" });
    const count = project.pages.length;
    const shape = currentShape(project);
    group.append(svg("rect", { x: 0, y: top, width: this.x(count), height: SHAPE, class: "lane-bg" }));
    if (!shape || !count) {
      const hint = svg("text", { x: 8, y: top + 28, class: "lane-hint" }, "上の「話の型」で起承転結や Save the Cat、自分の型を選ぶと、ページの区切りがここに出ます");
      group.append(hint);
      return group;
    }
    const spans = shapeSpans(shape, count);
    if (!spans.length) {
      group.append(svg("text", { x: 8, y: top + 28, class: "lane-hint" }, `ページが ${shape.parts.length} より少ないので区切れません`));
      return group;
    }
    for (const span of spans) {
      const x = this.x(span.first);
      const w = this.x(span.last + 1) - x;
      const part = svg("rect", { x: x + 1, y: top + 5, width: Math.max(1, w - 2), height: 24, rx: 5, class: "part", fill: span.color });
      part.addEventListener("click", () => this.select({ kind: "shape" }));
      part.addEventListener("mousemove", (event) => this.tip.show(event, [span.name, `${span.first + 1}〜${span.last + 1} ページ（${span.last - span.first + 1} ページ）`, "クリックで型を直す"]));
      part.addEventListener("mouseleave", () => this.tip.hide());
      group.append(part, svg("text", { x: x + 7, y: top + 21, class: "part-label" }, clip(span.name, Math.floor((w - 10) / 12))));
    }
    // Boundaries between parts: drag to change how many pages each gets.
    spans.slice(0, -1).forEach((span) => {
      const bx = this.x(span.last + 1);
      const guide = svg("line", { x1: bx, x2: bx, y1: top + 2, y2: top + 32, class: "part-edge" });
      const handle = svg("rect", { x: bx - 5, y: top + 2, width: 10, height: 30, class: "part-handle" });
      handle.addEventListener("pointerdown", (down) => {
        if (down.button !== 0) return;
        down.preventDefault();
        this.hold();
        track(down, handle, {
          move: (event) => {
            const { boundary } = this.at(event);
            const gx = this.x(Math.max(1, Math.min(count - 1, boundary)));
            guide.setAttribute("x1", String(gx));
            guide.setAttribute("x2", String(gx));
            guide.classList.add("dragging");
            this.tip.show(event, [`${span.name} を ${Math.max(1, boundary)} ページ目まで`]);
          },
          end: (event, moved) => {
            this.tip.hide();
            this.release();
            if (!moved) return;
            const boundary = Math.max(1, Math.min(count - 1, this.at(event).boundary));
            this.edit((p) => {
              const own = editableShape(p);
              if (!own) return;
              moveBoundary(own, span.index, boundary / count);
              keepShape(own);
            });
          },
        });
      });
      group.append(guide, handle);
    });
    // Beats: markers to drag along the pages.
    (shape.beats ?? []).forEach((beat, index) => {
      const page = beatPage(beat.at, count);
      const cx = this.x(page) + this.column / 2;
      const marker = svg("path", { d: diamond(cx, top + 40, 6), class: "beat" });
      const label = this.column >= 60 || (shape.beats?.length ?? 0) <= count / 3 ? svg("text", { x: cx + 9, y: top + 44, class: "beat-label" }, clip(beat.name, Math.max(2, Math.floor((this.column * 2.2) / 11)))) : null;
      marker.addEventListener("mousemove", (event) => this.tip.show(event, [beat.name, `${page + 1} ページあたり`, "ドラッグで動かす"]));
      marker.addEventListener("mouseleave", () => this.tip.hide());
      marker.addEventListener("pointerdown", (down) => {
        if (down.button !== 0) return;
        down.preventDefault();
        this.hold();
        track(down, marker, {
          move: (event) => {
            const { index: at } = this.at(event);
            marker.setAttribute("d", diamond(this.x(at) + this.column / 2, top + 40, 7));
            this.tip.show(event, [beat.name, `${at + 1} ページへ`]);
          },
          end: (event, moved) => {
            this.tip.hide();
            this.release();
            if (!moved) {
              this.select({ kind: "shape" });
              return;
            }
            const at = this.at(event).index;
            this.edit((p) => {
              const own = editableShape(p);
              if (!own) return;
              setBeat(own, index, (at + 0.5) / count);
              keepShape(own);
            });
          },
        });
      });
      group.append(marker);
      if (label) group.append(label);
    });
    return group;
  }

  // シーン ---------------------------------------------------------------------------

  private sceneLane(project: Project, top: number): SVGGElement {
    const group = svg("g", { class: "lane scene-lane" });
    const count = project.pages.length;
    const bg = svg("rect", { x: 0, y: top, width: this.x(count), height: SCENE, class: "lane-bg empty-scene" });
    bg.addEventListener("dblclick", (event) => {
      const { index } = this.at(event);
      const run = uncoveredRunAt(project, index);
      if (!run) return;
      this.edit((p) => {
        const scene = addScene(p, p.pages[run[0]].id, p.pages[run[1]].id, `シーン${p.scenes.length + 1}`);
        this.selection = { kind: "scene", sceneId: scene.id };
      });
    });
    bg.addEventListener("mousemove", (event) => {
      const { index } = this.at(event);
      this.tip.show(event, [`${index + 1} ページ`, uncoveredRunAt(project, index) ? "ダブルクリックでここにシーンを足す" : ""].filter(Boolean));
    });
    bg.addEventListener("mouseleave", () => this.tip.hide());
    group.append(bg);
    const spans = sceneSpans(project);
    spans.forEach((span, i) => {
      const x = this.x(span.first);
      const w = this.x(span.last + 1) - x;
      const bar = svg("rect", { x: x + 1, y: top + 6, width: Math.max(2, w - 2), height: SCENE - 12, rx: 6, class: `scene ${i % 2 ? "odd" : ""}`, "data-scene": span.scene.id });
      const text = svg("text", { x: x + 8, y: top + SCENE / 2 + 4, class: "scene-label" }, clip(span.scene.title, Math.floor((w - 12) / 12)));
      group.append(bar, text);
      bar.addEventListener("mousemove", (event) =>
        this.tip.show(event, [
          span.scene.title,
          span.first === span.last ? `${span.first + 1} ページ` : `${span.first + 1}〜${span.last + 1} ページ`,
          ...(span.scene.storyTime ? [span.scene.storyTime] : []),
          ...(span.scene.summary ? [span.scene.summary.split("\n")[0]] : []),
        ]),
      );
      bar.addEventListener("mouseleave", () => this.tip.hide());
      bar.addEventListener("dblclick", () => {
        this.select({ kind: "scene", sceneId: span.scene.id });
        this.inspector?.querySelector<HTMLInputElement>("input.scene-title")?.focus();
      });
      // The middle moves the scene's pages; the ends change its range.
      bar.addEventListener("pointerdown", (down) => {
        if (down.button !== 0) return;
        down.preventDefault();
        this.hold();
        const marker = this.mark("insert");
        track(down, bar, {
          move: (event, moved) => {
            if (!moved) return;
            const { boundary } = this.at(event);
            this.placeMark(marker, this.x(boundary));
            bar.classList.add("dragging");
            this.tip.show(event, [`「${span.scene.title}」を ${boundary + 1 > count ? "最後" : `${boundary + 1} ページの前`}へ`]);
          },
          end: (event, moved) => {
            marker.remove();
            this.tip.hide();
            this.release();
            if (!moved) {
              this.select({ kind: "scene", sceneId: span.scene.id });
              return;
            }
            const { boundary } = this.at(event);
            this.edit((p) => moveScene(p, span.scene.id, boundary));
          },
        });
      });
      for (const edge of ["first", "last"] as const) {
        const ex = edge === "first" ? x : x + w;
        const handle = svg("rect", { x: ex - 5, y: top + 6, width: 10, height: SCENE - 12, class: "scene-handle" });
        handle.addEventListener("pointerdown", (down) => {
          if (down.button !== 0) return;
          down.preventDefault();
          down.stopPropagation();
          this.hold();
          track(down, handle, {
            move: (event) => {
              // The edge goes to the page boundary nearest the pointer.
              const index = this.edgeIndex(event, edge);
              const a = edge === "first" ? Math.min(index, span.last) : span.first;
              const b = edge === "last" ? Math.max(index, span.first) : span.last;
              bar.setAttribute("x", String(this.x(a) + 1));
              bar.setAttribute("width", String(Math.max(2, this.x(b + 1) - this.x(a) - 2)));
              this.tip.show(event, [span.scene.title, `${a + 1}〜${b + 1} ページ`]);
            },
            end: (event, moved) => {
              this.tip.hide();
              this.release();
              if (!moved) return;
              const index = this.edgeIndex(event, edge);
              this.edit((p) => moveSceneEdge(p, span.scene.id, edge, index));
            },
          });
        });
        group.append(handle);
      }
    });
    return group;
  }

  // 時系列 ---------------------------------------------------------------------------

  private timeLane(project: Project, top: number, height: number): SVGGElement {
    const group = svg("g", { class: "lane time-lane" });
    const count = project.pages.length;
    group.append(svg("rect", { x: 0, y: top, width: this.x(count), height, class: "lane-bg" }));
    const rows = timeline(project);
    if (!rows.length) {
      group.append(svg("text", { x: 8, y: top + 26, class: "lane-hint" }, "シーンを足すと、ページの順と物語の中の時間の流れがここに並びます"));
      return group;
    }
    const rowY = (rank: number) => top + 7 + rank * ROW + ROW / 2;
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1], rows[i]];
      group.append(svg("path", { d: `M${this.x(a.last + 1)},${rowY(a.storyRank)} L${this.x(b.first)},${rowY(b.storyRank)}`, class: "reading-path" }));
    }
    for (const row of rows) {
      const x = this.x(row.first);
      const w = Math.max(4, this.x(row.last + 1) - x - 2);
      const cy = rowY(row.storyRank);
      const bar = svg("rect", { x: x + 1, y: cy - 7, width: w, height: 14, rx: 4, class: `time-bar${row.flashback ? " flashback" : ""}`, "data-scene": row.scene.id });
      const label = `${row.scene.title}${row.scene.storyTime ? `（${row.scene.storyTime}）` : ""}`;
      const text = svg("text", { x: x + 6, y: cy + 4, class: "time-label" }, clip(label, Math.floor((w - 8) / 11)));
      bar.addEventListener("mousemove", (event) =>
        this.tip.show(event, [label, `物語の中で ${row.storyRank + 1} 番目`, ...(row.flashback ? ["それより後の出来事を見せたあとに出てくる（回想など）"] : []), "上下にドラッグで順を変える"]),
      );
      bar.addEventListener("mouseleave", () => this.tip.hide());
      bar.addEventListener("pointerdown", (down) => {
        if (down.button !== 0) return;
        down.preventDefault();
        this.hold();
        const box = this.canvas!.getBoundingClientRect();
        const rankAt = (event: PointerEvent) => Math.max(0, Math.min(rows.length - 1, Math.floor((event.clientY - box.top - top - 7) / ROW)));
        track(down, bar, {
          move: (event, moved) => {
            if (!moved) return;
            const rank = rankAt(event);
            bar.setAttribute("y", String(rowY(rank) - 7));
            text.setAttribute("y", String(rowY(rank) + 4));
            bar.classList.add("dragging");
            this.tip.show(event, [row.scene.title, `物語の中で ${rank + 1} 番目へ`]);
          },
          end: (event, moved) => {
            this.tip.hide();
            this.release();
            if (!moved) {
              this.select({ kind: "scene", sceneId: row.scene.id });
              return;
            }
            const rank = rankAt(event);
            this.edit((p) => setStoryRank(p, row.scene.id, rank));
          },
        });
      });
      group.append(bar, text);
      if (row.flashback && this.column * (row.last - row.first + 1) > 60) group.append(svg("text", { x: x + w + 4, y: cy + 4, class: "lane-hint small" }, "回想"));
    }
    return group;
  }

  // 感情 ------------------------------------------------------------------------------

  private emotionLane(project: Project, top: number): SVGGElement {
    const group = svg("g", { class: "lane emotion-lane" });
    const count = project.pages.length;
    const width = this.x(count);
    const pad = 12;
    const plot = EMOTION - pad * 2;
    const y = (value: number) => top + pad + plot * (1 - (value + 1) / 2);
    const valueAt = (py: number) => Math.round(Math.max(-1, Math.min(1, 1 - ((py - top - pad) / plot) * 2)) * 10) / 10;
    const bg = svg("rect", { x: 0, y: top, width, height: EMOTION, class: "lane-bg emotion-bg" });
    group.append(bg);
    for (const value of [1, 0.5, 0, -0.5, -1]) group.append(svg("line", { x1: 0, x2: width, y1: y(value), y2: y(value), class: value === 0 ? "axis" : "grid" }));
    group.append(svg("text", { x: 4, y: y(1) + 12, class: "lane-hint small" }, "前向き"), svg("text", { x: 4, y: y(-1) - 4, class: "lane-hint small" }, "後ろ向き"));
    if (!project.characters.length) {
      group.append(svg("text", { x: 8, y: y(0) - 6, class: "lane-hint" }, "上の「＋人物」で登場人物を足すと、ここをなぞって感情の移り変わりを描けます"));
      return group;
    }
    const center = (index: number) => this.x(index) + this.column / 2;
    const series = project.characters.map((character) => ({ character, samples: emotionSeries(project, character.id) }));
    series.sort((a, b) => Number(a.character.id === this.character) - Number(b.character.id === this.character));
    for (const { character, samples } of series) {
      const color = character.color ?? "#2a78d6";
      const editing = character.id === this.character;
      if (samples.length > 1) group.append(svg("polyline", { points: samples.map((s) => `${center(s.index)},${y(s.value)}`).join(" "), class: `curve${editing ? " editing" : ""}`, stroke: color }));
      for (const sample of samples) group.append(svg("circle", { cx: center(sample.index), cy: y(sample.value), r: editing ? 4 : 3, class: "curve-point", fill: color }));
      const last = samples[samples.length - 1];
      if (last && project.characters.length <= 5) group.append(svg("text", { x: center(last.index) + 7, y: y(last.value) + 4, class: "curve-label" }, character.name));
    }
    const preview = svg("g", { class: "curve-preview" });
    group.append(preview);
    const crosshair = svg("line", { y1: top, y2: top + EMOTION, class: "crosshair", visibility: "hidden" });
    group.append(crosshair);
    const hit = svg("rect", { x: 0, y: top, width, height: EMOTION, class: "emotion-hit" });
    const box = () => this.canvas!.getBoundingClientRect();
    hit.addEventListener("mousemove", (event) => {
      if (this.busy) return;
      const { index } = this.at(event);
      crosshair.setAttribute("x1", String(center(index)));
      crosshair.setAttribute("x2", String(center(index)));
      crosshair.setAttribute("visibility", "visible");
      const page = project.pages[index];
      const lines = project.characters.map((character) => {
        const point = project.emotions.find((p) => p.character === character.id && p.page === page.id);
        return `${character.name}: ${point ? formatValue(point.value) : "—"}${point?.note ? `（${point.note}）` : ""}`;
      });
      const who = project.characters.find((c) => c.id === this.character)?.name ?? "";
      this.tip.show(event, [`${index + 1} ページ`, ...lines, `クリックで ${who} を ${formatValue(valueAt(event.clientY - box().top))}`]);
    });
    hit.addEventListener("mouseleave", () => {
      crosshair.setAttribute("visibility", "hidden");
      this.tip.hide();
    });
    hit.addEventListener("contextmenu", (event) => event.preventDefault());
    hit.addEventListener("pointerdown", (down) => {
      const characterId = this.character;
      if (!characterId) return;
      const { index } = this.at(down);
      if (down.button === 2 || down.altKey) {
        down.preventDefault();
        this.edit((p) => setEmotion(p, characterId, p.pages[index].id, null));
        return;
      }
      if (down.button !== 0) return;
      down.preventDefault();
      this.hold();
      // Values drawn while dragging, page index → value; written on release as one step.
      const drawn = new Map<number, number>();
      const color = project.characters.find((c) => c.id === characterId)?.color ?? "#2a78d6";
      const put = (event: PointerEvent) => {
        const { index: at } = this.at(event);
        drawn.set(at, valueAt(event.clientY - box().top));
        const points = [...drawn.entries()].sort((a, b) => a[0] - b[0]);
        preview.replaceChildren(
          svg("polyline", { points: points.map(([i, v]) => `${center(i)},${y(v)}`).join(" "), class: "curve editing", stroke: color }),
          ...points.map(([i, v]) => svg("circle", { cx: center(i), cy: y(v), r: 4, class: "curve-point", fill: color })),
        );
        this.tip.show(event, [`${at + 1} ページ: ${formatValue(drawn.get(at)!)}`]);
      };
      put(down);
      track(down, hit, {
        move: (event) => put(event),
        end: () => {
          this.tip.hide();
          this.release();
          this.edit((p) => {
            for (const [at, value] of drawn) {
              const old = p.emotions.find((point) => point.character === characterId && point.page === p.pages[at].id);
              setEmotion(p, characterId, p.pages[at].id, value, old?.note);
            }
          });
        },
      });
    });
    group.append(hit);
    return group;
  }

  // 字数 ------------------------------------------------------------------------------

  private textLane(project: Project, top: number): SVGGElement {
    const group = svg("g", { class: "lane text-lane" });
    const count = project.pages.length;
    group.append(svg("rect", { x: 0, y: top, width: this.x(count), height: TEXT, class: "lane-bg" }));
    const amounts = project.pages.map(textAmount);
    const max = Math.max(HEAVY_TEXT, ...amounts);
    const barWidth = Math.max(2, Math.min(24, this.column - 6));
    amounts.forEach((amount, index) => {
      if (!amount) return;
      const h = ((TEXT - 8) * amount) / max;
      const bar = svg("rect", { x: this.x(index) + (this.column - barWidth) / 2, y: top + TEXT - 4 - h, width: barWidth, height: h, rx: 2, class: `amount${amount > HEAVY_TEXT ? " heavy" : ""}` });
      bar.addEventListener("mousemove", (event) => this.tip.show(event, [`${index + 1} ページ`, `${amount} 字${amount > HEAVY_TEXT ? "（多め）" : ""}`]));
      bar.addEventListener("mouseleave", () => this.tip.hide());
      group.append(bar);
    });
    const heavy = top + TEXT - 4 - ((TEXT - 8) * HEAVY_TEXT) / max;
    group.append(svg("line", { x1: 0, x2: this.x(count), y1: heavy, y2: heavy, class: "heavy-line" }));
    return group;
  }

  // ページ・コマ ------------------------------------------------------------------------

  private pageLane(project: Project, thumbWidth: number, thumbHeight: number, showMemo: boolean): HTMLElement {
    const row = html("div", { className: "board-pages" });
    const [pageW, pageH] = project.pageFormat.canvasMm;
    const parts = currentShape(project) ? shapeSpans(currentShape(project)!, project.pages.length) : [];
    const partOf = (index: number) => parts.find((part) => part.first <= index && index <= part.last);
    const spans = sceneSpans(project);
    const ratio = window.devicePixelRatio || 1;
    project.pages.forEach((page, index) => {
      const card = html("div", { className: "board-page" });
      card.dataset.page = page.id;
      card.style.left = `${this.x(index) + 4}px`;
      card.style.width = `${thumbWidth}px`;
      const part = partOf(index);
      const scene = spans.find((span) => span.first === index);
      const head = html("div", { className: "board-page-head", title: "ドラッグでページを移動（見開きは 2 ページ一緒に）" }, html("span", { textContent: String(index + 1) }));
      if (part) {
        head.style.background = part.color;
        head.classList.add("tinted");
        head.title = `${part.name}・${head.title}`;
      }
      if (page.joinNext) head.append(html("span", { className: "spread-tag", textContent: "見開き" }));
      if (scene && thumbWidth >= 60) head.append(html("span", { className: "head-scene", textContent: scene.scene.title }));
      const canvas = html("canvas", { width: Math.round(thumbWidth * ratio), height: Math.round(thumbHeight * ratio) });
      canvas.style.width = `${thumbWidth}px`;
      canvas.style.height = `${thumbHeight}px`;
      const scale = (thumbWidth / pageW) * ratio;
      const ctx = canvas.getContext("2d");
      if (ctx) drawThumb(ctx, project, page, { scale, x: 0, y: 0 }, thumbWidth >= 110);
      const overlay = svg("svg", { class: "board-panels", viewBox: `0 0 ${pageW} ${pageH}`, width: thumbWidth, height: thumbHeight });
      for (const panel of page.panels) overlay.append(this.panelShape(project, index, panel));
      const sheet = html("div", { className: "board-sheet" }, canvas, overlay);
      sheet.addEventListener("click", (event) => {
        if ((event.target as Element).closest("[data-panel]")) return;
        this.select({ kind: "page", pageId: page.id });
      });
      sheet.addEventListener("dblclick", () => this.host.openPage(index + 1));
      card.append(head, sheet);
      if (showMemo) card.append(html("div", { className: "board-memo", textContent: page.memo.split("\n")[0] || "", title: page.memo }));
      this.pageDrag(project, index, head);
      row.append(card);
    });
    return row;
  }

  private panelShape(project: Project, index: number, panel: Panel): SVGGElement {
    const page = project.pages[index];
    const points = panel.shape.map(([x, y]) => `${x},${y}`).join(" ");
    const shape = svg("polygon", { points, class: "board-panel" });
    const [x0, y0] = panel.shape.reduce(([ax, ay], [x, y]) => [Math.min(ax, x), Math.min(ay, y)], [Infinity, Infinity]);
    const group = svg("g", { "data-panel": panel.id, "data-page": page.id }, shape);
    if (this.column >= 70) group.append(svg("text", { x: x0 + 4, y: y0 + 14, class: "panel-number" }, String(panel.order)));
    if (panel.note) group.append(svg("circle", { cx: x0 + (this.column >= 70 ? 22 : 6), cy: y0 + 9, r: 4, class: "panel-has-note" }));
    group.addEventListener("mousemove", (event) => {
      if (this.busy) return;
      const lines = page.lines.filter((line) => line.panel === panel.id).map((line) => line.text.replace(/\s+/g, " "));
      this.tip.show(event, [`${index + 1} ページ コマ ${panel.order}`, ...(panel.note ? [`メモ: ${panel.note}`] : []), ...lines.slice(0, 3), "ドラッグで別のコマと中身を入れ替え"]);
    });
    group.addEventListener("mouseleave", () => this.tip.hide());
    group.addEventListener("dblclick", () => this.host.openPage(index + 1));
    group.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      this.hold();
      const ghost = html("div", { className: "board-ghost", textContent: `${index + 1}p コマ ${panel.order}` });
      let over: SVGGElement | null = null;
      const targetAt = (event: PointerEvent) => {
        const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<SVGGElement>("[data-panel]") ?? null;
        return hit && hit !== group ? hit : null;
      };
      track(down, group, {
        move: (event, moved) => {
          if (!moved) return;
          this.tip.hide();
          group.classList.add("dragging");
          if (!ghost.isConnected) document.body.append(ghost);
          ghost.style.left = `${event.clientX + 12}px`;
          ghost.style.top = `${event.clientY + 12}px`;
          const target = targetAt(event);
          if (target !== over) {
            over?.classList.remove("drop-target");
            target?.classList.add("drop-target");
            over = target;
          }
          if (over) {
            const at = pageIndex(project, over.dataset.page!);
            const other = project.pages[at]?.panels.find((p) => p.id === over!.dataset.panel);
            ghost.textContent = `${index + 1}p コマ ${panel.order} ⇄ ${at + 1}p コマ ${other?.order ?? ""}`;
          } else ghost.textContent = `${index + 1}p コマ ${panel.order}`;
        },
        end: (_event, moved) => {
          ghost.remove();
          group.classList.remove("dragging");
          over?.classList.remove("drop-target");
          this.release();
          if (!moved) {
            this.select({ kind: "panel", pageId: page.id, panelId: panel.id });
            return;
          }
          if (!over) return;
          const [toPage, toPanel] = [over.dataset.page!, over.dataset.panel!];
          let message = "";
          this.edit((p) => {
            const a = p.pages.find((pg) => pg.id === page.id);
            const b = p.pages.find((pg) => pg.id === toPage);
            const pa = a?.panels.find((pn) => pn.id === panel.id);
            const pb = b?.panels.find((pn) => pn.id === toPanel);
            if (!a || !b || !pa || !pb) return;
            swapPanelContents(a, pa, b, pb);
            message = `${pageIndex(p, a.id) + 1} ページのコマ ${pa.order} と ${pageIndex(p, b.id) + 1} ページのコマ ${pb.order} の中身を入れ替えました（元に戻すは Ctrl+Z）`;
          });
          this.selection = { kind: "panel", pageId: toPage, panelId: toPanel };
          if (message) this.host.status?.(message);
          this.paintSelection();
          this.renderInspector();
        },
      });
    });
    return group;
  }

  /** Drag a page by its number strip to another place (a 見開き goes as a pair). */
  private pageDrag(project: Project, index: number, head: HTMLElement): void {
    head.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      this.hold();
      const [first, last] = pageBlock(project, index);
      const marker = this.mark("insert tall");
      track(down, head, {
        move: (event, moved) => {
          if (!moved) return;
          const { boundary } = this.at(event);
          this.placeMark(marker, this.x(boundary));
          head.parentElement?.classList.add("dragging");
          this.tip.show(event, [`${first === last ? `${first + 1} ページ` : `${first + 1}–${last + 1} ページ`}を ${boundary >= project.pages.length ? "最後" : `${boundary + 1} ページの前`}へ`]);
        },
        end: (event, moved) => {
          marker.remove();
          head.parentElement?.classList.remove("dragging");
          this.tip.hide();
          this.release();
          if (!moved) {
            this.select({ kind: "page", pageId: project.pages[index].id });
            return;
          }
          this.host.movePages(first, last, this.at(event).boundary);
        },
      });
    });
  }

  /** A vertical marker over all lanes (where a drag would put things). */
  private mark(kind: string): HTMLDivElement {
    const marker = html("div", { className: `board-mark ${kind}` });
    marker.hidden = true;
    this.canvas?.append(marker);
    return marker;
  }

  private placeMark(marker: HTMLDivElement, x: number): void {
    marker.hidden = false;
    marker.style.left = `${x - 1}px`;
  }

  // --- selection ----------------------------------------------------------------------

  /** Shade the pages of what is selected across all lanes, and outline it. */
  private paintSelection(): void {
    const project = this.project;
    const marks = this.marks;
    if (!project || !marks || !this.canvas) return;
    marks.replaceChildren();
    for (const node of this.canvas.querySelectorAll(".selected")) node.classList.remove("selected");
    const s = this.selection;
    if (!s) return;
    let range: [number, number] | null = null;
    if (s.kind === "page" || s.kind === "panel") {
      const index = pageIndex(project, s.pageId);
      if (index >= 0) range = [index, index];
      this.canvas.querySelector(`.board-page[data-page="${s.pageId}"]`)?.classList.add("selected");
      if (s.kind === "panel") this.canvas.querySelector(`[data-panel="${s.panelId}"][data-page="${s.pageId}"]`)?.classList.add("selected");
    } else if (s.kind === "scene") {
      const span = sceneSpans(project).find((sp) => sp.scene.id === s.sceneId);
      if (span) range = [span.first, span.last];
      for (const node of this.canvas.querySelectorAll(`[data-scene="${s.sceneId}"]`)) node.classList.add("selected");
    } else if (s.kind === "shape") {
      this.canvas.querySelector(".shape-lane")?.classList.add("selected");
    }
    if (range) {
      const shade = html("div", { className: "board-shade" });
      shade.style.left = `${this.x(range[0])}px`;
      shade.style.width = `${this.x(range[1] + 1) - this.x(range[0])}px`;
      marks.append(shade);
    }
  }

  // --- inspector ----------------------------------------------------------------------

  private renderInspector(): void {
    const project = this.project;
    const root = this.inspector;
    if (!project || !root) return;
    const s = this.selection;
    const content =
      s?.kind === "scene"
        ? this.sceneInspector(project, s.sceneId)
        : s?.kind === "page"
          ? this.pageInspector(project, s.pageId)
          : s?.kind === "panel"
            ? this.panelInspector(project, s.pageId, s.panelId)
            : s?.kind === "shape"
              ? this.shapeInspector(project)
              : this.overviewInspector(project);
    root.replaceChildren(...content);
  }

  private overviewInspector(project: Project): HTMLElement[] {
    const spans = sceneSpans(project);
    const panels = project.pages.reduce((sum, page) => sum + page.panels.length, 0);
    const characters = project.pages.reduce((sum, page) => sum + textAmount(page), 0);
    const shape = currentShape(project);
    const cast = project.characters.map((character) => {
      const name = html("input", { type: "text", value: character.name });
      name.addEventListener("change", () => this.edit(() => (character.name = name.value.trim() || character.name)));
      const color = html("input", { type: "color", value: character.color ?? "#2a78d6" });
      color.addEventListener("change", () => this.edit(() => (character.color = color.value)));
      const remove = html("button", { className: "danger small", textContent: "✕", title: "この人物を消す（感情の値も）" });
      remove.addEventListener("click", () => this.edit((p) => removeCharacter(p, character.id)));
      return html("div", { className: "insp-row" }, color, name, remove);
    });
    return [
      html("h3", { textContent: "全体" }),
      html("p", { className: "insp-summary", textContent: `${project.pages.length} ページ・シーン ${spans.length}・コマ ${panels}・${characters} 字${shape ? `・型 ${shape.label}` : ""}` }),
      html("h4", { textContent: "登場人物" }),
      ...(cast.length ? cast : [html("p", { className: "hint", textContent: "まだいません。上の「＋人物」で足せます。" })]),
      html("h4", { textContent: "できること" }),
      html(
        "ul",
        { className: "insp-help" },
        ...[
          "ページやシーン、コマをクリックすると、ここで中身を直せます",
          "コマを別のコマへドラッグ: 中身（絵・セリフ・塗り・メモ）を入れ替え。ページをまたいでも",
          "ページ番号の帯をドラッグ: ページを移動",
          "シーンの両端をドラッグ: ページの範囲。真ん中: シーンごと移動",
          "時系列の棒を上下にドラッグ: 物語の中の順（回想など）",
          "感情の欄をなぞる: 選んだ人物の値。右クリックで消す",
          "話の型の区切りをドラッグ: 配分を変える",
          "ダブルクリック: そのページを編集画面で開く",
        ].map((text) => html("li", { textContent: text })),
      ),
    ];
  }

  private sceneInspector(project: Project, sceneId: string): HTMLElement[] {
    const span = sceneSpans(project).find((sp) => sp.scene.id === sceneId);
    if (!span) return [];
    const { scene } = span;
    const title = html("input", { type: "text", value: scene.title, className: "scene-title" });
    title.addEventListener("change", () => this.edit(() => (scene.title = title.value.trim() || scene.title)));
    const time = html("input", { type: "text", value: scene.storyTime ?? "", placeholder: "例: 1日目 朝" });
    time.addEventListener("change", () =>
      this.edit(() => {
        if (time.value.trim()) scene.storyTime = time.value.trim();
        else delete scene.storyTime;
      }),
    );
    const summary = html("textarea", { value: scene.summary, placeholder: "このシーンで起きること", rows: 5 });
    summary.addEventListener("change", () => this.edit(() => (scene.summary = summary.value)));
    const rank = timeline(project).find((row) => row.scene.id === sceneId);
    const option = html("button", { textContent: "別案を作る", title: "このシーンのページを写した案を作り、ページ配分やコマ割りを試す" });
    option.addEventListener("click", () => this.host.makeOption(span.first, span.last));
    const open = html("button", { textContent: "編集画面で開く" });
    open.addEventListener("click", () => this.host.openPage(span.first + 1));
    const remove = html("button", { className: "danger", textContent: "シーンを消す", title: "ページはそのまま残ります" });
    remove.addEventListener("click", () =>
      this.edit((p) => {
        p.scenes = p.scenes.filter((s) => s.id !== sceneId);
        this.selection = null;
      }),
    );
    const emotions = this.emotionsIn(project, span);
    return [
      html("h3", { textContent: "シーン" }),
      html("label", {}, "名前", title),
      html("p", { className: "insp-summary", textContent: `${span.first + 1}〜${span.last + 1} ページ（${span.last - span.first + 1} ページ）・物語の中で ${(rank?.storyRank ?? 0) + 1} 番目${rank?.flashback ? "（回想）" : ""}` }),
      html("label", {}, "物語の中の時", time),
      html("label", {}, "あらすじ", summary),
      ...emotions,
      html("div", { className: "insp-buttons" }, open, option, remove),
    ];
  }

  /** How each character moves through a scene, as a line of values. */
  private emotionsIn(project: Project, span: SceneSpan): HTMLElement[] {
    const rows = project.characters
      .map((character) => {
        const values = emotionSeries(project, character.id).filter((s) => s.index >= span.first && s.index <= span.last);
        return values.length ? html("div", { className: "insp-emotion", textContent: `${character.name}: ${values.map((v) => formatValue(v.value)).join(" → ")}` }) : null;
      })
      .filter((row): row is HTMLDivElement => !!row);
    return rows.length ? [html("h4", { textContent: "感情" }), ...rows] : [];
  }

  private pageInspector(project: Project, pageId: string): HTMLElement[] {
    const index = pageIndex(project, pageId);
    const page = project.pages[index];
    if (!page) return [];
    const memo = html("textarea", { value: page.memo, placeholder: "このページで見せること", rows: 4 });
    memo.addEventListener("change", () => this.edit(() => (page.memo = memo.value)));
    const scene = sceneAtPage(project, index);
    const shape = currentShape(project);
    const part = shape ? shapeSpans(shape, project.pages.length).find((p) => p.first <= index && index <= p.last) : undefined;
    const emotions = project.characters.map((character) => {
      const point = project.emotions.find((p) => p.character === character.id && p.page === pageId);
      const value = html("input", { type: "number", min: "-1", max: "1", step: "0.1", value: point ? String(point.value) : "", placeholder: "—" });
      value.addEventListener("change", () =>
        this.edit((p) => {
          const parsed = Number.parseFloat(value.value);
          setEmotion(p, character.id, pageId, Number.isFinite(parsed) ? parsed : null, point?.note);
        }),
      );
      const note = html("input", { type: "text", value: point?.note ?? "", placeholder: point ? "なぜそう感じるか" : "値を入れるとメモも", disabled: !point });
      note.addEventListener("change", () => this.edit((p) => setEmotion(p, character.id, pageId, point!.value, note.value)));
      const swatch = html("span", { className: "swatch" });
      swatch.style.background = character.color ?? "#2a78d6";
      return html("div", { className: "insp-row emotion" }, swatch, html("span", { className: "who", textContent: character.name }), value, note);
    });
    const open = html("button", { className: "primary", textContent: "編集画面で開く" });
    open.addEventListener("click", () => this.host.openPage(index + 1));
    const option = html("button", { textContent: "別案を作る" });
    option.addEventListener("click", () => this.host.makeOption(...pageBlock(project, index)));
    const preview = html("canvas");
    const [pageW, pageH] = project.pageFormat.canvasMm;
    const width = 260;
    const ratio = window.devicePixelRatio || 1;
    preview.width = width * ratio;
    preview.height = Math.round((width * pageH * ratio) / pageW);
    preview.style.width = `${width}px`;
    preview.className = "insp-preview";
    const ctx = preview.getContext("2d");
    if (ctx) drawThumb(ctx, project, page, { scale: (width / pageW) * ratio, x: 0, y: 0 }, true);
    preview.addEventListener("dblclick", () => this.host.openPage(index + 1));
    return [
      html("h3", { textContent: `${index + 1} ページ` }),
      html("p", { className: "insp-summary", textContent: [scene ? `シーン「${scene.scene.title}」` : "シーンなし", part ? `${part.name}` : "", `コマ ${page.panels.length}・${textAmount(page)} 字`].filter(Boolean).join("・") }),
      preview,
      html("label", {}, "ページのメモ", memo),
      ...(emotions.length ? [html("h4", { textContent: "感情（-1〜1）" }), ...emotions] : []),
      html("div", { className: "insp-buttons" }, open, option),
    ];
  }

  private panelInspector(project: Project, pageId: string, panelId: string): HTMLElement[] {
    const index = pageIndex(project, pageId);
    const page = project.pages[index];
    const panel = page?.panels.find((p) => p.id === panelId);
    if (!page || !panel) return [];
    const note = html("textarea", { value: panel.note ?? "", placeholder: "カメラ、間、このコマで見せること", rows: 3 });
    note.addEventListener("change", () =>
      this.edit(() => {
        if (note.value.trim()) panel.note = note.value;
        else delete panel.note;
      }),
    );
    const names = new Map(project.characters.map((c) => [c.id, c.name]));
    const lines = page.lines
      .filter((line) => line.panel === panel.id)
      .map((line) => {
        const text = html("textarea", { value: line.text, rows: Math.min(4, line.text.split("\n").length + 1) });
        text.addEventListener("change", () =>
          this.edit(() => {
            line.text = text.value;
            fitLine(line);
          }),
        );
        const who = line.kind === "narration" ? "ナレーション" : line.kind === "sfx" ? "描き文字" : names.get(line.speaker ?? "") ?? "（話者なし）";
        return html("label", {}, who, text);
      });
    const open = html("button", { className: "primary", textContent: "編集画面で開く" });
    open.addEventListener("click", () => this.host.openPage(index + 1));
    return [
      html("h3", { textContent: `${index + 1} ページ コマ ${panel.order}` }),
      html("p", { className: "hint", textContent: "ほかのコマへドラッグすると中身（絵・セリフ・塗り・メモ）を入れ替えます。ページをまたいでもできます。" }),
      html("label", {}, "コマのメモ", note),
      ...(lines.length ? [html("h4", { textContent: "セリフ" }), ...lines] : [html("p", { className: "hint", textContent: "このコマにセリフはありません" })]),
      html("div", { className: "insp-buttons" }, open),
    ];
  }

  private shapeInspector(project: Project): HTMLElement[] {
    const shape = currentShape(project);
    if (!shape) return [];
    const count = project.pages.length;
    const builtIn = isBuiltinShape(shape.id);
    const spans = shapeSpans(shape, count);
    /** Change the shape (a built-in one is copied into an own shape first) and keep it on this computer. */
    const change = (apply: (own: StoryShape) => void) =>
      this.edit((p) => {
        const own = editableShape(p);
        if (!own) return;
        apply(own);
        keepShape(own);
      });
    const label = html("input", { type: "text", value: shape.label, disabled: builtIn });
    label.addEventListener("change", () => change((own) => (own.label = label.value.trim() || own.label)));
    const parts = shape.parts.map((part, i) => {
      const name = html("input", { type: "text", value: part.name });
      name.addEventListener("change", () => change((own) => (own.parts[i].name = name.value.trim() || own.parts[i].name)));
      const color = html("input", { type: "color", value: partColor(shape, i) });
      color.addEventListener("change", () => change((own) => (own.parts[i].color = color.value)));
      const span = spans[i];
      const pages = html("span", { className: "pages", textContent: span ? `${span.first + 1}〜${span.last + 1}` : "—" });
      const split = html("button", { className: "small", textContent: "分割", title: "この区切りを二つに分ける" });
      split.addEventListener("click", () => change((own) => splitPart(own, i)));
      const remove = html("button", { className: "danger small", textContent: "✕", title: "この区切りを消す（ページは前の区切りへ）", disabled: shape.parts.length <= 1 });
      remove.addEventListener("click", () => change((own) => removePart(own, i)));
      return html("div", { className: "insp-row part" }, color, name, pages, split, remove);
    });
    const beats = (shape.beats ?? []).map((beat, i) => {
      const name = html("input", { type: "text", value: beat.name });
      name.addEventListener("change", () => change((own) => own.beats && (own.beats[i].name = name.value.trim() || own.beats[i].name)));
      const page = html("input", { type: "number", min: "1", max: String(count), value: String(beatPage(beat.at, count) + 1), title: "ページ" });
      page.addEventListener("change", () => {
        const value = Number.parseInt(page.value, 10);
        if (Number.isInteger(value)) change((own) => setBeat(own, i, (Math.max(1, Math.min(count, value)) - 0.5) / count));
      });
      const remove = html("button", { className: "danger small", textContent: "✕" });
      remove.addEventListener("click", () => change((own) => removeBeat(own, i)));
      return html("div", { className: "insp-row beat" }, html("span", { className: "diamond", textContent: "◆" }), name, page, remove);
    });
    const addBeatButton = html("button", { textContent: "ビートを足す" });
    addBeatButton.addEventListener("click", () => change((own) => addBeat(own, "ビート", 0.5)));
    const copy = html("button", { textContent: builtIn ? "写して自分の型にする" : "写しを作る" });
    copy.addEventListener("click", () =>
      this.edit((p) => {
        const from = currentShape(p);
        if (from) keepShape(makeShape(p, from, builtIn ? undefined : `${from.label}の写し`));
      }),
    );
    const remove = html("button", { className: "danger", textContent: "この型を消す", title: "このネームとこの PC から消す" });
    remove.addEventListener("click", () =>
      this.edit((p) => {
        removeShape(p, shape.id);
        forgetShape(shape.id);
        this.selection = null;
      }),
    );
    return [
      html("h3", { textContent: "話の型" }),
      builtIn
        ? html("p", { className: "hint", textContent: "決まった型です。直すと「（自分用）」の写しができ、このネームとこの PC に保存されます（ほかのネームでも選べます）。" })
        : html("p", { className: "hint", textContent: "自分の型です。このネームとこの PC に保存され、ほかのネームでも選べます。" }),
      html("label", {}, "名前", label),
      html("h4", { textContent: `区切り（${count} ページに当てると）` }),
      ...parts,
      html("h4", { textContent: "ビート（話の転換点）" }),
      ...(beats.length ? beats : [html("p", { className: "hint", textContent: "なし" })]),
      html("div", { className: "insp-buttons" }, addBeatButton, copy, ...(builtIn ? [] : [remove])),
    ];
  }
}

/** A small picture of a page: the same drawing as the editor, without brush tips. */
export function drawThumb(ctx: CanvasRenderingContext2D, project: Project, page: Project["pages"][number], m: MmToPx, text: boolean): void {
  const [pageW, pageH] = project.pageFormat.canvasMm;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pageW * m.scale, pageH * m.scale);
  const ink = () => "#55524c";
  drawStrokes(ctx, page, m, false, ink, 0.5);
  drawPanelFills(ctx, page, m, 0.4);
  drawPageFills(ctx, page, m);
  drawPanelBorders(ctx, page, m, undefined, 0.8);
  drawStrokes(ctx, page, m, true, ink, 0.5);
  drawBalloons(ctx, page, m, 0.6);
  if (text) for (const line of page.lines) drawLineText(ctx, line, m);
  else {
    ctx.fillStyle = "rgba(27, 26, 24, 0.3)";
    for (const line of page.lines) {
      const [x0, y0, x1, y1] = line.box;
      ctx.fillRect(x0 * m.scale + m.x, y0 * m.scale + m.y, (x1 - x0) * m.scale, (y1 - y0) * m.scale);
    }
  }
}

function diamond(cx: number, cy: number, r: number): string {
  return `M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z`;
}

function clip(text: string, length: number): string {
  if (length <= 1) return "";
  return [...text].length > length ? `${[...text].slice(0, length - 1).join("")}…` : text;
}

function formatValue(value: number): string {
  return value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
}

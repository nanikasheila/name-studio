// 物語の帯: the story shape, scenes, story time, emotion curves and the
// pages with their panels, on one page axis under the page being drawn.
// Everything is changed where it is shown: drag the parts of the shape, the
// ends of a scene, a scene up or down in story time, the emotion curve, a
// page to another place, or a panel onto another panel (on any page) to swap
// what they hold. A click on a page or panel shows it on the canvas; the
// pages on the canvas are framed here.
import { element as html, svg } from "./dom";
import type { Project } from "./model";
import { readJson, writeJson } from "./settings";
import { DockHeight, type Mode } from "./boarddock";
import { emotionSeries, markSpeakingPages, sceneSpans, speakingPages, timeline } from "./story";
import { emotionLane, textLane } from "./boardemotion";
import { pageLane } from "./boardpages";
import { pageStory, sceneInspector, sceneLane, timeLane } from "./boardscene";
import { shapeInspector, shapeLane } from "./boardshape";
import { type BoardSelection, type BoardTip, icon, type LaneId, type LaneView, ROW, RULER, SCENE, SHAPE, type StoryHost, TEXT } from "./boardview";

export type { BoardSelection, BoardTip, LaneId, StoryHost } from "./boardview";

const LANES: { id: LaneId; label: string; hint: string }[] = [
  { id: "shape", label: "型", hint: "話の型: 区切りの線をドラッグで配分を変える（決まった型は自分の型に写してから）。◆はビート。クリックで型を選ぶ・直す" },
  { id: "scene", label: "シーン", hint: "シーン: 両端のドラッグでページの範囲、真ん中のドラッグでシーンごと移動。空いた所をダブルクリックでシーンを足す" },
  { id: "time", label: "時系列", hint: "時系列: 上ほど物語の中で早い出来事。上下にドラッグで順を変える（回想など）" },
  { id: "emotion", label: "感情", hint: "感情: 下の帯で人物を選んで、なぞると値が入る。右クリック（Alt＋クリック）で消す" },
  { id: "text", label: "字数", hint: "字数: ページごとのセリフの字数（多いページは色を変える）" },
];

// The strip under the pages starts with the scenes alone (描く配置: the pages get the height);
// F2–F4 or its buttons add lanes, 大きく (F6) shows them all. v2: the strip's first lanes changed.
const DEFAULT_LANES: Record<Mode, LaneId[]> = { strip: ["scene"], wide: ["shape", "scene", "time", "emotion", "text"] };
const LANES_KEY = "namestudio.storyLanes.v2";

const LABEL_WIDTH = 66;
export const MIN_COLUMN = 24;
export const MAX_COLUMN = 240;

/** A saved setting over its defaults. */
function readSaved<T>(key: string, fallback: T): T {
  const saved = readJson(key, null);
  return saved && typeof saved === "object" ? { ...fallback, ...saved } : fallback;
}

export class Board {
  /** Width of one page column, px; 0 fits all pages in the width. */
  private columns: Record<Mode, number> = { strip: 0, wide: 0 };
  private column = 0;
  private mode: Mode = "strip";
  private shown: Record<Mode, LaneId[]> = readSaved(LANES_KEY, DEFAULT_LANES);
  private selection: BoardSelection | null = null;
  /** Character whose emotion values the curve lane changes. */
  private character: string | null = null;
  private scroll = { left: 0, top: 0 };
  /** A press is being followed: renders wait until it ends. */
  private busy = false;
  private renderLater = false;
  private canvas: HTMLDivElement | null = null;
  private scroller: HTMLDivElement | null = null;
  private marks: HTMLDivElement | null = null;
  private current: HTMLDivElement | null = null;
  private project: Project | null = null;
  /** The revision drawn last: the same one only moves the frame of the pages shown. */
  private revision = -1;
  private framed = "";
  private queued = false;
  /** Height of the lanes drawn last, px. */
  private contentHeight = 240;
  /** Page pictures by page id, with what they were drawn from. */
  private readonly thumbs = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  private readonly tip: BoardTip;
  private readonly tipNode: HTMLDivElement;
  /** The strip's own row of buttons, above its lanes. */
  private readonly controls: HTMLDivElement;
  private readonly root: HTMLDivElement;
  /** What the lanes see of the strip. */
  private readonly view: LaneView;
  private readonly height: DockHeight;

  constructor(
    dock: HTMLElement,
    handle: HTMLElement,
    /** The row under the pages: the strip's buttons go at its end (one row less over the strip). */
    bar: HTMLElement,
    private readonly host: StoryHost,
  ) {
    this.controls = html("div", { className: "story-controls" });
    this.root = html("div", { className: "story-lanes" });
    bar.append(this.controls);
    dock.append(this.root);
    this.tipNode = html("div", { className: "chart-tip" });
    this.tipNode.hidden = true;
    this.tip = { show: (event, lines) => this.showTip(event, lines), hide: () => (this.tipNode.hidden = true) };
    this.view = this.laneView();
    this.height = new DockHeight({
      dock,
      handle,
      lanes: this.root,
      mode: () => this.mode,
      contentHeight: () => this.contentHeight,
      changed: () => this.render(),
    });
    // Fitted to the width: a narrower or wider strip fits the pages again.
    let width = 0;
    let queued = false;
    new ResizeObserver(() => {
      const now = this.root.clientWidth;
      if (now === width || this.columns[this.mode] || queued) return;
      width = now;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (this.project) this.render();
      });
    }).observe(this.root);
  }

  private laneView(): LaneView {
    const board = this;
    return {
      host: this.host,
      tip: this.tip,
      thumbs: this.thumbs,
      get column() {
        return board.column;
      },
      get busy() {
        return board.busy;
      },
      get character() {
        return board.character;
      },
      canvas: () => this.canvas,
      emotionHeight: () => this.emotionHeight(),
      x: (index) => this.x(index),
      at: (event) => this.at(event),
      edgeIndex: (event, edge) => this.edgeIndex(event, edge),
      edit: (change) => this.edit(change),
      hold: () => this.hold(),
      release: () => this.release(),
      select: (selection) => this.select(selection),
      selectScene: (span) => this.selectScene(span),
      setSelection: (selection) => (this.selection = selection),
      mark: (kind) => this.mark(kind),
      placeMark: (marker, x) => this.placeMark(marker, x),
    };
  }

  get expanded(): boolean {
    return this.mode === "wide";
  }

  get selected(): BoardSelection | null {
    return this.selection;
  }

  /**
   * Draw the strip for the project, on the next frame (several changes in a
   * row draw once); when nothing changed since, only move the frame of the
   * shown pages.
   */
  update(revision: number): void {
    const project = this.host.project();
    if (!project) return;
    if (project === this.project && revision === this.revision && !this.busy) {
      this.paintCurrent();
      return;
    }
    this.revision = revision;
    if (!this.project) return this.render();
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  private render(): void {
    const project = this.host.project();
    if (!project) return;
    if (this.busy) {
      this.renderLater = true;
      return;
    }
    if (this.scroller) this.scroll = { left: this.scroller.scrollLeft, top: this.scroller.scrollTop };
    this.project = project;
    this.tip.hide();
    this.checkSelection(project);
    this.column = this.columns[this.mode] || this.fitColumn(project);
    this.controls.replaceChildren(...this.controlBar(project));
    this.root.replaceChildren(this.lanes(project), this.tipNode);
    this.height.apply();
    this.scroller!.scrollLeft = this.scroll.left;
    this.scroller!.scrollTop = this.scroll.top;
    this.paintSelection();
    this.framed = "";
    this.paintCurrent();
  }

  private fitColumn(project: Project): number {
    const width = Math.max(200, this.root.clientWidth - LABEL_WIDTH - 4);
    const fit = Math.floor(width / Math.max(project.pages.length, 1));
    return Math.max(this.mode === "wide" ? 56 : 32, Math.min(this.mode === "wide" ? MAX_COLUMN : 120, fit));
  }

  private showTip(event: MouseEvent, lines: string[]): void {
    const tip = this.tipNode;
    tip.replaceChildren(...lines.map((line, i) => html(i === 0 ? "strong" : "div", { textContent: line })));
    tip.hidden = false;
    const box = this.root.getBoundingClientRect();
    const x = event.clientX - box.left + 14;
    const y = event.clientY - box.top + 14;
    tip.style.left = `${Math.min(x, this.root.clientWidth - 230)}px`;
    // Near the bottom the tip goes above the pointer.
    tip.style.top = y > this.root.clientHeight - 90 ? "" : `${y}px`;
    tip.style.bottom = y > this.root.clientHeight - 90 ? `${this.root.clientHeight - y + 28}px` : "";
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
      this.render();
    }
  }

  private checkSelection(project: Project): void {
    const s = this.selection;
    if (!s) return;
    const ok = s.kind === "shape" ? true : project.scenes.some((scene) => scene.id === s.sceneId);
    if (!ok) this.selection = null;
  }

  select(selection: BoardSelection | null): void {
    this.selection = selection;
    this.paintSelection();
    this.host.inspect();
  }

  /** Delete: the scene picked goes (its pages stay); false when no scene is picked. */
  removeSelectedScene(): boolean {
    const s = this.selection;
    if (s?.kind !== "scene") return false;
    this.host.edit((p) => (p.scenes = p.scenes.filter((scene) => scene.id !== s.sceneId)));
    this.select(null);
    return true;
  }

  /** The canvas took the selection: the strip lets go of its own. */
  deselect(): void {
    if (!this.selection) return;
    this.selection = null;
    this.paintSelection();
  }

  // --- size and mode ---------------------------------------------------------------

  /** 物語の帯 ⇄ 大きく (F6): the strip takes most of the height, with every lane. */
  toggleWide(wide = !this.expanded): void {
    if (this.scroller) this.scroll = { left: this.scroller.scrollLeft, top: 0 };
    // 大きく is never folded; back to the strip, it folds again if it was.
    this.mode = wide ? "wide" : "strip";
    this.render();
  }

  get isFolded(): boolean {
    return this.height.isFolded;
  }

  /** たたむ ⇄ 広げる (Shift+F6, a double click on the top edge): the strip down to its row of buttons. */
  toggleFold(fold = !this.isFolded): void {
    if (fold && this.mode === "wide") this.mode = "strip";
    if (this.height.fold(fold) || fold) this.render();
  }

  /** Show or hide a lane (in the current mode); `on` forces it. */
  toggleLane(id: LaneId, on?: boolean): void {
    const lanes = this.shown[this.mode];
    const show = on ?? !lanes.includes(id);
    this.shown = { ...this.shown, [this.mode]: show ? LANES.map((l) => l.id).filter((l) => l === id || lanes.includes(l)) : lanes.filter((l) => l !== id) };
    writeJson(LANES_KEY, this.shown);
    this.render();
  }

  // --- the strip's own bar ---------------------------------------------------------

  private controlBar(project: Project): HTMLElement[] {
    const lanes = this.shown[this.mode];
    const toggles = html("div", { className: "segmented lane-toggles", title: "帯に出すもの" } as Partial<HTMLDivElement>);
    for (const lane of LANES) {
      const button = html("button", { className: lanes.includes(lane.id) ? "active" : "", title: `${lane.label}を${lanes.includes(lane.id) ? "隠す" : "出す"}` }, icon(lane.id));
      button.setAttribute("aria-pressed", String(lanes.includes(lane.id)));
      button.setAttribute("aria-label", lane.label);
      button.addEventListener("click", () => this.toggleLane(lane.id));
      toggles.append(button);
    }
    const out: HTMLElement[] = [toggles];

    // Whose feelings the curve lane draws on.
    if (!this.character || !project.characters.some((c) => c.id === this.character)) this.character = project.characters[0]?.id ?? null;
    if (lanes.includes("emotion") && project.characters.length) {
      const cast = html("div", { className: "board-cast", title: "感情曲線をなぞる人物" }, icon("emotion"));
      for (const character of project.characters) {
        const chip = html("button", { className: `cast-dot${character.id === this.character ? " active" : ""}`, title: `${character.name} の感情をなぞる`, textContent: [...character.name][0] ?? "？" });
        chip.style.setProperty("--who", character.color ?? "#2a78d6");
        chip.addEventListener("click", () => {
          this.character = character.id;
          this.render();
        });
        cast.append(chip);
      }
      const who = project.characters.find((c) => c.id === this.character);
      if (who) {
        const speaking = speakingPages(project, who.id);
        const known = new Set(emotionSeries(project, who.id).map((sample) => sample.index));
        const missing = speaking.filter((index) => !known.has(index)).length;
        if (missing) {
          const mark = html("button", {
            className: "chip speaks-mark",
            textContent: `話す所に点 ${missing}`,
            title: `${who.name} が話すページで、まだ値のない ${missing} ページに点を打つ（前後の値の間をとる）。曲線の下の小さな印が話すページ`,
          });
          mark.addEventListener("click", () => {
            let added = 0;
            this.edit((p) => (added = markSpeakingPages(p, who.id)));
            this.host.status?.(`${who.name} が話す ${added} ページに点を打ちました。なぞって直せます（元に戻すは Ctrl+Z）`);
          });
          cast.append(mark);
        }
      }
      out.push(cast);
    }
    const fit = html("button", { className: "icon-button", title: "全ページが横に収まる幅にする（Ctrl＋ホイールで拡大縮小）" }, icon("fit"));
    fit.addEventListener("click", () => {
      this.columns = { ...this.columns, [this.mode]: 0 };
      this.scroll.left = 0;
      this.render();
    });
    const wide = html(
      "button",
      { className: `icon-button${this.expanded ? " active" : ""}`, title: this.expanded ? "帯を元の高さに戻す（F6）" : "帯を大きくして全体を見る（F6）。上端のドラッグでも高さを変えられます" },
      icon(this.expanded ? "narrow" : "wide"),
    );
    wide.addEventListener("click", () => this.toggleWide());
    const fold = html(
      "button",
      { className: `icon-button${this.isFolded ? " active" : ""}`, title: this.isFolded ? "帯を広げる（Shift+F6・上端のダブルクリック）" : "帯をたたんでページを広くする（Shift+F6・上端のダブルクリック）" },
      icon(this.isFolded ? "unfold" : "fold"),
    );
    fold.setAttribute("aria-pressed", String(this.isFolded));
    fold.addEventListener("click", () => this.toggleFold());
    const help = html("button", { className: "icon-button", title: this.helpText() }, icon("help"));
    help.addEventListener("click", () => this.select({ kind: "shape" }));
    out.push(html("div", { className: "spacer" }), fit, wide, fold, help);
    return out;
  }

  private helpText(): string {
    return [
      "物語の帯",
      "・ページやコマをクリック: そのページを上に開く（枠がいま開いているページ）",
      "・コマを別のコマへドラッグ: 中身（絵・セリフ・塗り・メモ）を入れ替え。ページをまたいでも",
      "・ページ番号の帯をドラッグ: ページを移動",
      "・シーンの両端をドラッグ: ページの範囲。真ん中: シーンごと移動。クリックで右の欄に",
      "・時系列の棒を上下にドラッグ: 物語の中の順（回想など）",
      "・感情の欄をなぞる: 選んだ人物の値。右クリックで消す",
      "・話の型の区切りをドラッグ: 配分を変える",
      "・上端をドラッグ: 帯の高さ。ダブルクリックか F6 で大きく",
    ].join("\n");
  }

  private zoomTo(column: number, anchorX?: number): void {
    const next = Math.max(MIN_COLUMN, Math.min(MAX_COLUMN, Math.round(column)));
    if (next === this.column) return;
    const scroller = this.scroller;
    if (scroller) {
      // Keep the page under the pointer (or the middle) where it is.
      const x = anchorX ?? scroller.clientWidth / 2;
      const at = (scroller.scrollLeft + x) / this.column;
      scroller.scrollLeft = Math.max(0, at * next - x);
    }
    this.columns = { ...this.columns, [this.mode]: next };
    this.render();
  }

  // --- lanes ------------------------------------------------------------------------

  private emotionHeight(): number {
    // No characters yet: one line on how to start.
    if (!this.project?.characters.length) return 28;
    return this.mode === "wide" ? 150 : 64;
  }

  private lanes(project: Project): HTMLElement {
    const count = project.pages.length;
    const width = Math.max(count, 1) * this.column;
    const shown = this.shown[this.mode];
    const rows = timeline(project);
    const timeHeight = Math.max(3, rows.length) * ROW + 14;
    const [pageW, pageH] = project.pageFormat.canvasMm;
    const thumbWidth = Math.max(16, this.column - 8);
    const thumbHeight = Math.round((thumbWidth * pageH) / pageW);
    const showMemo = this.column >= 88;
    const pagesHeight = 20 + thumbHeight + (showMemo ? 34 : 6);
    const heights: Record<LaneId, number> = { shape: SHAPE, scene: SCENE, time: timeHeight, emotion: this.emotionHeight(), text: TEXT };
    const draw: Record<LaneId, (top: number) => SVGGElement> = {
      shape: (top) => shapeLane(this.view, project, top),
      scene: (top) => sceneLane(this.view, project, top),
      time: (top) => timeLane(this.view, project, top, timeHeight),
      emotion: (top) => emotionLane(this.view, project, top),
      text: (top) => textLane(this.view, project, top),
    };
    const labels = html("div", { className: "board-labels" });
    const label = (text: string, height: number, hint: string, name?: LaneId) => {
      const node = html("div", { className: `board-label${name ? "" : text ? " pages-label" : ""}`, title: hint }, ...(name ? [icon(name)] : []), html("span", { textContent: text }));
      node.style.height = `${height}px`;
      if (name === "shape") node.addEventListener("click", () => this.select({ kind: "shape" }));
      labels.append(node);
    };
    label("", RULER, "");

    const canvas = html("div", { className: "board-canvas" });
    canvas.style.width = `${width}px`;
    this.canvas = canvas;
    const lanes = LANES.filter((lane) => shown.includes(lane.id));
    const chartHeight = RULER + lanes.reduce((sum, lane) => sum + heights[lane.id], 0);
    const chart = svg("svg", { width, height: chartHeight, class: "board-chart" });
    chart.append(this.ruler(project, 0));
    let y = RULER;
    for (const lane of lanes) {
      label(lane.label, heights[lane.id], lane.hint, lane.id);
      chart.append(draw[lane.id](y));
      y += heights[lane.id];
    }
    label("ページ", pagesHeight, "ページ・コマ: クリックでそのページを上に開く。ページ番号の帯をドラッグでページを移動。コマを別のコマ（ほかのページでも）にドラッグで中身を入れ替え");
    const pages = pageLane(this.view, project, thumbWidth, thumbHeight, showMemo);
    pages.style.height = `${pagesHeight}px`;
    this.contentHeight = chartHeight + pagesHeight;
    this.marks = html("div", { className: "board-marks" });
    this.current = html("div", { className: "board-current" });
    this.current.hidden = true;
    canvas.append(chart, pages, this.marks, this.current);

    const scroller = html("div", { className: "board-scroll" }, canvas);
    this.scroller = scroller;
    scroller.addEventListener("scroll", () => {
      this.scroll = { left: scroller.scrollLeft, top: scroller.scrollTop };
      labels.scrollTop = scroller.scrollTop;
    });
    scroller.addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey) {
          event.preventDefault();
          const box = scroller.getBoundingClientRect();
          this.zoomTo(this.column * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX - box.left);
          return;
        }
        // A plain wheel runs along the pages when there is nothing to scroll down.
        if (!event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX) && scroller.scrollHeight <= scroller.clientHeight + 1) {
          event.preventDefault();
          scroller.scrollLeft += event.deltaY;
        }
      },
      { passive: false },
    );
    return html("div", { className: "board-lanes" }, labels, scroller);
  }


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
      cell.addEventListener("click", () => this.host.openPage(index + 1));
      group.append(cell);
      if (index % every === 0 || every === 1) group.append(svg("text", { x: x + this.column / 2, y: top + 14, class: "ruler-number", "text-anchor": "middle" }, String(index + 1)));
      if (page.joinNext) group.append(svg("line", { x1: x + this.column, x2: x + this.column, y1: top + 4, y2: top + RULER - 4, class: "spread-mark" }));
    });
    return group;
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

  /** A scene picked in the strip: its first page comes up unless the canvas is already in it. */
  private selectScene(span: { scene: { id: string }; first: number; last: number }): void {
    const shown = this.host.currentPages();
    if (!shown.some((number) => number - 1 >= span.first && number - 1 <= span.last)) this.host.openPage(span.first + 1);
    this.select({ kind: "scene", sceneId: span.scene.id });
  }

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
    if (s.kind === "scene") {
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

  /** Frame the pages that are on the canvas, and bring them into view when they change. */
  private paintCurrent(): void {
    const frame = this.current;
    const project = this.project;
    if (!frame || !project || !this.canvas) return;
    const pages = this.host.currentPages().sort((a, b) => a - b);
    for (const node of this.canvas.querySelectorAll(".board-page.current")) node.classList.remove("current");
    if (!pages.length) {
      frame.hidden = true;
      return;
    }
    const [first, last] = [pages[0] - 1, pages[pages.length - 1] - 1];
    for (const number of pages) {
      const id = project.pages[number - 1]?.id;
      if (id) this.canvas.querySelector(`.board-page[data-page="${id}"]`)?.classList.add("current");
    }
    frame.hidden = false;
    frame.style.left = `${this.x(first)}px`;
    frame.style.width = `${this.x(last + 1) - this.x(first)}px`;
    const key = `${first}-${last}-${this.column}`;
    if (key === this.framed) return;
    this.framed = key;
    const scroller = this.scroller;
    if (!scroller) return;
    const [left, right] = [this.x(first), this.x(last + 1)];
    const view = [scroller.scrollLeft, scroller.scrollLeft + scroller.clientWidth];
    if (left < view[0] + 8 || right > view[1] - 8) {
      scroller.scrollLeft = Math.max(0, (left + right) / 2 - scroller.clientWidth / 2);
    }
  }

  // --- inspector (shown in the right column) ---------------------------------------

  /** What the right column shows for the strip's selection, or null when the canvas has it. */
  inspector(): HTMLElement[] | null {
    const project = this.host.project();
    const s = this.selection;
    if (!project || !s) return null;
    return s.kind === "scene" ? sceneInspector(this.view, project, s.sceneId) : shapeInspector(this.view, project);
  }

  /**
   * The story around a page, for the page's inspector: its part of the shape,
   * its scene (a click selects it) and each character's value there.
   */
  pageStory(project: Project, pageId: string): HTMLElement[] {
    return pageStory(this.view, project, pageId);
  }


}

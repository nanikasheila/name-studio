// 物語の帯: the story shape, scenes, story time, emotion curves and the
// pages with their panels, on one page axis under the page being drawn.
// Everything is changed where it is shown: drag the parts of the shape, the
// ends of a scene, a scene up or down in story time, the emotion curve, a
// page to another place, or a panel onto another panel (on any page) to swap
// what they hold. A click on a page or panel shows it on the canvas; the
// pages on the canvas are framed here.
import { drawBalloons, drawPageTexts, drawPageFills, drawPanelBorders, drawPanelFills, drawStrokes, type MmToPx } from "./pagedraw";
import { fingerprint } from "./snapshot";
import {
  addScene,
  moveScene,
  pageBlock,
  pageIndex,
  setEmotion,
  swapPanelContents,
  textAmount,
  type Panel,
  type Project,
  type StoryShape,
} from "./project";
import { addBeat, adoptShape, beatPage, currentShape, editableShape, isBuiltinShape, makeShape, moveBoundary, partColor, removeBeat, removePart, removeShape, setBeat, shapeSpans, splitPart, storyShapes } from "./shapes";
import { forgetShape, keepShape, libraryShapes } from "./prefs";
import {
  emotionRuns,
  emotionSeries,
  HEAVY_TEXT,
  markSpeakingPages,
  moveSceneEdge,
  planAdvice,
  sceneAtPage,
  sceneSpans,
  setStoryRank,
  speakingPages,
  timeline,
  uncoveredRunAt,
  type SceneSpan,
} from "./story";
import { element as html, svg } from "./dom";
import { readJson, writeJson } from "./settings";

export interface StoryHost {
  project(): Project | null;
  /** Run `change` as one undoable step. */
  edit(change: (project: Project) => void): void;
  /** Show a page (1-based) on the canvas. */
  openPage(pageNumber: number): void;
  /** Select a panel on the canvas (its page comes into view). */
  selectPanel(pageId: string, panelId: string): void;
  /** Pages `first`..`last` dragged to before page `target`. */
  movePages(first: number, last: number, target: number): void;
  /** 別案 of pages `first`..`last` (0-based), to edit. */
  makeOption(first: number, last: number): void;
  /** Pages (1-based) on the canvas now. */
  currentPages(): number[];
  /** The strip's selection changed: the inspector shows it. */
  inspect(): void;
  /** Say what was done in the status bar. */
  status?(message: string): void;
}

/** What the strip itself selects; pages and panels are selected on the canvas. */
export type BoardSelection = { kind: "scene"; sceneId: string } | { kind: "shape" };

export interface BoardTip {
  show(event: MouseEvent, lines: string[]): void;
  hide(): void;
}

export type LaneId = "shape" | "scene" | "time" | "emotion" | "text";
type Mode = "strip" | "wide";

const ICONS: Record<LaneId | "fit" | "wide" | "narrow" | "help", string> = {
  shape: '<rect x="2" y="6.5" width="5" height="7" rx="1.2" class="fill"/><rect x="8" y="6.5" width="4" height="7" rx="1.2"/><rect x="13" y="6.5" width="5" height="7" rx="1.2" class="fill"/>',
  scene: '<rect x="2" y="6" width="7.5" height="8" rx="2.5"/><rect x="11" y="6" width="7" height="8" rx="2.5"/>',
  time: '<path d="M2.5 4.5h6M7 10h6M11.5 15.5h6"/><path d="M8.5 4.5L7 10M13 10l-1.5 5.5" stroke-dasharray="1.5 1.5"/>',
  emotion: '<path d="M2.5 14c3 0 3-9 6-9s3 10 6 10 2-6 3-6"/>',
  text: '<rect x="3" y="11" width="3" height="6"/><rect x="8.5" y="6" width="3" height="11"/><rect x="14" y="3" width="3" height="14"/>',
  fit: '<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/>',
  wide: '<path d="M10 16V4M5 9l5-5 5 5"/>',
  narrow: '<path d="M10 4v12M5 11l5 5 5-5"/>',
  help: '<circle cx="10" cy="10" r="7.5"/><path d="M7.8 7.8a2.3 2.3 0 1 1 3.2 2.1c-.7.3-1 .8-1 1.5v.6"/><circle cx="10" cy="14.6" r=".6" class="fill"/>',
};

const LANES: { id: LaneId; label: string; hint: string }[] = [
  { id: "shape", label: "型", hint: "話の型: 区切りの線をドラッグで配分を変える（決まった型は自分の型に写してから）。◆はビート。クリックで型を選ぶ・直す" },
  { id: "scene", label: "シーン", hint: "シーン: 両端のドラッグでページの範囲、真ん中のドラッグでシーンごと移動。空いた所をダブルクリックでシーンを足す" },
  { id: "time", label: "時系列", hint: "時系列: 上ほど物語の中で早い出来事。上下にドラッグで順を変える（回想など）" },
  { id: "emotion", label: "感情", hint: "感情: 下の帯で人物を選んで、なぞると値が入る。右クリック（Alt＋クリック）で消す" },
  { id: "text", label: "字数", hint: "字数: ページごとのセリフの字数（多いページは色を変える）" },
];

const DEFAULT_LANES: Record<Mode, LaneId[]> = { strip: ["shape", "scene", "emotion", "text"], wide: ["shape", "scene", "time", "emotion", "text"] };
/** 0: as tall as the lanes need (the strip) or most of the height (大きく). */
const DEFAULT_HEIGHT: Record<Mode, number> = { strip: 0, wide: 0 };
const LANES_KEY = "namestudio.storyLanes";
const HEIGHT_KEY = "namestudio.storyHeight";

/** Lane heights (px). */
const RULER = 20;
const SHAPE = 40;
const SCENE = 32;
const ROW = 18;
const TEXT = 32;
const LABEL_WIDTH = 66;
/** The strip's own row of buttons, and room for a scroll bar. */
const CHROME = 32 + 14;
const MIN_HEIGHT = 96;
export const MIN_COLUMN = 24;
export const MAX_COLUMN = 240;

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const node = svg("svg", { viewBox: "0 0 20 20", class: "icon", "aria-hidden": "true" });
  node.innerHTML = ICONS[name];
  return node;
}

/** A saved setting over its defaults. */
function readSaved<T>(key: string, fallback: T): T {
  const saved = readJson(key, null);
  return saved && typeof saved === "object" ? { ...fallback, ...saved } : fallback;
}

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
  /** Width of one page column, px; 0 fits all pages in the width. */
  private columns: Record<Mode, number> = { strip: 0, wide: 0 };
  private column = 0;
  private mode: Mode = "strip";
  private shown: Record<Mode, LaneId[]> = readSaved(LANES_KEY, DEFAULT_LANES);
  private heights: Record<Mode, number> = readSaved(HEIGHT_KEY, DEFAULT_HEIGHT);
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

  constructor(
    private readonly dock: HTMLElement,
    private readonly handle: HTMLElement,
    private readonly host: StoryHost,
  ) {
    this.controls = html("div", { className: "story-controls" });
    this.root = html("div", { className: "story-lanes" });
    dock.append(this.controls, this.root);
    this.tipNode = html("div", { className: "chart-tip" });
    this.tipNode.hidden = true;
    this.tip = { show: (event, lines) => this.showTip(event, lines), hide: () => (this.tipNode.hidden = true) };
    this.bindHandle();
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
    this.applyHeight();
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
    this.mode = wide ? "wide" : "strip";
    this.render();
  }

  /** Show or hide a lane (in the current mode); `on` forces it. */
  toggleLane(id: LaneId, on?: boolean): void {
    const lanes = this.shown[this.mode];
    const show = on ?? !lanes.includes(id);
    this.shown = { ...this.shown, [this.mode]: show ? LANES.map((l) => l.id).filter((l) => l === id || lanes.includes(l)) : lanes.filter((l) => l !== id) };
    writeJson(LANES_KEY, this.shown);
    this.render();
  }

  private applyHeight(): void {
    const room = this.dock.parentElement?.clientHeight || window.innerHeight;
    const wanted = this.heights[this.mode] || (this.mode === "wide" ? Math.round(room * 0.62) : Math.min(this.contentHeight + CHROME, Math.round(room * 0.38)));
    // The page above keeps at least some room.
    const max = Math.max(MIN_HEIGHT, room - 160);
    const height = `${Math.max(MIN_HEIGHT, Math.min(max, wanted))}px`;
    this.dock.style.height = height;
    this.dock.classList.toggle("wide", this.mode === "wide");
  }

  /** Drag the top edge of the strip to give it more or less of the height. */
  private bindHandle(): void {
    this.handle.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      const start = this.dock.getBoundingClientRect().height;
      const room = this.dock.parentElement?.clientHeight || window.innerHeight;
      this.handle.classList.add("dragging");
      track(down, this.handle, {
        move: (event) => {
          const height = Math.round(Math.max(MIN_HEIGHT, Math.min(room - 160, start + down.clientY - event.clientY)));
          this.dock.style.height = `${height}px`;
        },
        end: () => {
          this.handle.classList.remove("dragging");
          this.heights = { ...this.heights, [this.mode]: Math.round(this.dock.getBoundingClientRect().height) };
          writeJson(HEIGHT_KEY, this.heights);
          this.render();
        },
      });
    });
    this.handle.addEventListener("dblclick", () => {
      // Back to the height the lanes need, then 大きく and back.
      if (this.heights[this.mode]) {
        this.heights = { ...this.heights, [this.mode]: 0 };
        writeJson(HEIGHT_KEY, this.heights);
        this.render();
      } else this.toggleWide();
    });
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
    const help = html("button", { className: "icon-button", title: this.helpText() }, icon("help"));
    help.addEventListener("click", () => this.select({ kind: "shape" }));
    out.push(html("div", { className: "spacer" }), fit, wide, help);
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
      shape: (top) => this.shapeLane(project, top),
      scene: (top) => this.sceneLane(project, top),
      time: (top) => this.timeLane(project, top, timeHeight),
      emotion: (top) => this.emotionLane(project, top),
      text: (top) => this.textLane(project, top),
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
    const pages = this.pageLane(project, thumbWidth, thumbHeight, showMemo);
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

  // 話の型 --------------------------------------------------------------------------

  private shapeLane(project: Project, top: number): SVGGElement {
    const group = svg("g", { class: "lane shape-lane" });
    const count = project.pages.length;
    const shape = currentShape(project);
    group.append(svg("rect", { x: 0, y: top, width: this.x(count), height: SHAPE, class: "lane-bg" }));
    if (!shape || !count) {
      const hint = svg("text", { x: 8, y: top + 24, class: "lane-hint" }, "クリックで話の型（起承転結・Save the Cat・自分の型）を選ぶと、ページの区切りがここに出ます");
      group.addEventListener("click", () => this.select({ kind: "shape" }));
      group.classList.add("pick");
      group.append(hint);
      return group;
    }
    const spans = shapeSpans(shape, count);
    if (!spans.length) {
      group.append(svg("text", { x: 8, y: top + 24, class: "lane-hint" }, `ページが ${shape.parts.length} より少ないので区切れません`));
      return group;
    }
    for (const span of spans) {
      const x = this.x(span.first);
      const w = this.x(span.last + 1) - x;
      const part = svg("rect", { x: x + 1, y: top + 3, width: Math.max(1, w - 2), height: 20, rx: 5, class: "part", fill: span.color });
      part.addEventListener("click", () => this.select({ kind: "shape" }));
      part.addEventListener("mousemove", (event) => this.tip.show(event, [span.name, `${span.first + 1}〜${span.last + 1} ページ（${span.last - span.first + 1} ページ）`, "クリックで型を直す"]));
      part.addEventListener("mouseleave", () => this.tip.hide());
      group.append(part, svg("text", { x: x + 7, y: top + 17, class: "part-label" }, clip(span.name, Math.floor((w - 10) / 12))));
    }
    // Boundaries between parts: drag to change how many pages each gets.
    spans.slice(0, -1).forEach((span) => {
      const bx = this.x(span.last + 1);
      const guide = svg("line", { x1: bx, x2: bx, y1: top + 1, y2: top + 25, class: "part-edge" });
      const handle = svg("rect", { x: bx - 5, y: top + 1, width: 10, height: 24, class: "part-handle" });
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
      const marker = svg("path", { d: diamond(cx, top + 32, 6), class: "beat" });
      const label = this.column >= 60 || (shape.beats?.length ?? 0) <= count / 3 ? svg("text", { x: cx + 9, y: top + 36, class: "beat-label" }, clip(beat.name, Math.max(2, Math.floor((this.column * 2.2) / 11)))) : null;
      marker.addEventListener("mousemove", (event) => this.tip.show(event, [beat.name, `${page + 1} ページあたり`, "ドラッグで動かす"]));
      marker.addEventListener("mouseleave", () => this.tip.hide());
      marker.addEventListener("pointerdown", (down) => {
        if (down.button !== 0) return;
        down.preventDefault();
        this.hold();
        track(down, marker, {
          move: (event) => {
            const { index: at } = this.at(event);
            marker.setAttribute("d", diamond(this.x(at) + this.column / 2, top + 32, 7));
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
      const bar = svg("rect", { x: x + 1, y: top + 4, width: Math.max(2, w - 2), height: SCENE - 8, rx: 6, class: `scene ${i % 2 ? "odd" : ""}`, "data-scene": span.scene.id });
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
        this.selectScene(span);
        document.querySelector<HTMLInputElement>("#inspector input.scene-title")?.focus();
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
              this.selectScene(span);
              return;
            }
            const { boundary } = this.at(event);
            this.edit((p) => moveScene(p, span.scene.id, boundary));
          },
        });
      });
      for (const edge of ["first", "last"] as const) {
        const ex = edge === "first" ? x : x + w;
        const handle = svg("rect", { x: ex - 5, y: top + 4, width: 10, height: SCENE - 8, class: "scene-handle" });
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
              this.selectScene(row);
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
    const EMOTION = this.emotionHeight();
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
      group.append(svg("text", { x: 8, y: y(0) - 6, class: "lane-hint" }, "左の「人物」で登場人物を足すと、ここをなぞって感情の移り変わりを描けます"));
      return group;
    }
    const center = (index: number) => this.x(index) + this.column / 2;
    const series = project.characters.map((character) => ({ character, samples: emotionSeries(project, character.id) }));
    series.sort((a, b) => Number(a.character.id === this.character) - Number(b.character.id === this.character));
    for (const { character, samples } of series) {
      const color = character.color ?? "#2a78d6";
      const editing = character.id === this.character;
      // Solid over pages next to each other; dotted across pages with no value.
      const runs = emotionRuns(samples);
      runs.forEach((run, i) => {
        if (run.length > 1) group.append(svg("polyline", { points: run.map((s) => `${center(s.index)},${y(s.value)}`).join(" "), class: `curve${editing ? " editing" : ""}`, stroke: color }));
        const next = runs[i + 1]?.[0];
        const end = run[run.length - 1];
        if (next) group.append(svg("line", { x1: center(end.index), y1: y(end.value), x2: center(next.index), y2: y(next.value), class: `curve gap${editing ? " editing" : ""}`, stroke: color }));
      });
      // Where the character speaks: ticks along the bottom.
      if (editing) {
        for (const index of speakingPages(project, character.id)) {
          group.append(svg("rect", { x: center(index) - 1.5, y: top + EMOTION - 7, width: 3, height: 5, rx: 1, class: "speaks", fill: color }));
        }
      }
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

  /** A page's picture, drawn again only when the page (or its size) changed: drawing every line of every page on each change is slow. */
  private thumb(project: Project, page: Project["pages"][number], thumbWidth: number, thumbHeight: number, ratio: number): HTMLCanvasElement {
    const key = `${thumbWidth}|${thumbHeight}|${ratio}|${fingerprint(project.pageFormat)}|${fingerprint(page)}`;
    const kept = this.thumbs.get(page.id);
    if (kept?.key === key) return kept.canvas;
    const canvas = html("canvas", { width: Math.round(thumbWidth * ratio), height: Math.round(thumbHeight * ratio) });
    canvas.style.width = `${thumbWidth}px`;
    canvas.style.height = `${thumbHeight}px`;
    const scale = (thumbWidth / project.pageFormat.canvasMm[0]) * ratio;
    const ctx = canvas.getContext("2d");
    if (ctx) drawThumb(ctx, project, page, { scale, x: 0, y: 0 }, thumbWidth >= 110);
    this.thumbs.set(page.id, { key, canvas });
    return canvas;
  }

  private pageLane(project: Project, thumbWidth: number, thumbHeight: number, showMemo: boolean): HTMLElement {
    // Pages no longer in the name drop their pictures.
    const ids = new Set(project.pages.map((page) => page.id));
    for (const id of this.thumbs.keys()) if (!ids.has(id)) this.thumbs.delete(id);
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
      const canvas = this.thumb(project, page, thumbWidth, thumbHeight, ratio);
      const overlay = svg("svg", { class: "board-panels", viewBox: `0 0 ${pageW} ${pageH}`, width: thumbWidth, height: thumbHeight });
      for (const panel of page.panels) overlay.append(this.panelShape(project, index, panel));
      const sheet = html("div", { className: "board-sheet" }, canvas, overlay);
      sheet.addEventListener("click", (event) => {
        if ((event.target as Element).closest("[data-panel]")) return;
        this.host.openPage(index + 1);
      });
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
      this.tip.show(event, [`${index + 1} ページ コマ ${panel.order}`, ...(panel.note ? [`メモ: ${panel.note}`] : []), ...lines.slice(0, 3), "クリックで上に開く・ドラッグで別のコマと中身を入れ替え"]);
    });
    group.addEventListener("mouseleave", () => this.tip.hide());
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
            this.host.selectPanel(page.id, panel.id);
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
            swapPanelContents(a, pa, b, pb, p.binding);
            message = `${pageIndex(p, a.id) + 1} ページのコマ ${pa.order} と ${pageIndex(p, b.id) + 1} ページのコマ ${pb.order} の中身を入れ替えました（元に戻すは Ctrl+Z）`;
          });
          if (message) this.host.status?.(message);
          this.host.selectPanel(toPage, toPanel);
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
            this.host.openPage(index + 1);
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
    return s.kind === "scene" ? this.sceneInspector(project, s.sceneId) : this.shapeInspector(project);
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
    const remove = html("button", { className: "danger", textContent: "シーンを消す", title: "ページはそのまま残ります" });
    remove.addEventListener("click", () =>
      this.edit((p) => {
        p.scenes = p.scenes.filter((s) => s.id !== sceneId);
        this.selection = null;
      }),
    );
    const pages = html("div", { className: "insp-pages" });
    for (let index = span.first; index <= span.last; index++) {
      const go = html("button", { className: "chip", textContent: String(index + 1), title: `${index + 1} ページを開く` });
      go.addEventListener("click", () => this.host.openPage(index + 1));
      pages.append(go);
    }
    return [
      html("h2", { className: "story-title" }, icon("scene"), html("span", { textContent: "シーン" })),
      html("label", {}, "名前", title),
      html("p", { className: "insp-summary", textContent: `${span.last - span.first + 1} ページ・物語の中で ${(rank?.storyRank ?? 0) + 1} 番目${rank?.flashback ? "（回想）" : ""}` }),
      pages,
      html("label", {}, "物語の中の時", time),
      html("label", {}, "あらすじ", summary),
      ...this.emotionsIn(project, span),
      html("div", { className: "row" }, option, remove),
      html("p", { className: "hint", textContent: "帯でシーンの両端をドラッグするとページの範囲、真ん中のドラッグで場所、時系列の棒の上下で物語の中の順が変わります。" }),
    ];
  }

  /** How each character moves through a scene, as a small line of dots. */
  private emotionsIn(project: Project, span: SceneSpan): HTMLElement[] {
    const rows = project.characters
      .map((character) => {
        const values = emotionSeries(project, character.id).filter((s) => s.index >= span.first && s.index <= span.last);
        if (!values.length) return null;
        const row = html("div", { className: "insp-emotion", title: values.map((v) => `${v.index + 1}p ${formatValue(v.value)}`).join("  ") });
        const swatch = html("span", { className: "swatch" });
        swatch.style.background = character.color ?? "#2a78d6";
        row.append(swatch, html("span", { className: "who", textContent: character.name }), sparkline(values.map((v) => v.value), character.color ?? "#2a78d6"));
        return row;
      })
      .filter((row): row is HTMLDivElement => !!row);
    return rows.length ? [html("h3", { textContent: "感情" }), ...rows] : [];
  }

  /**
   * The story around a page, for the page's inspector: its part of the shape,
   * its scene (a click selects it) and each character's value there.
   */
  pageStory(project: Project, pageId: string): HTMLElement[] {
    const index = pageIndex(project, pageId);
    if (index < 0) return [];
    const scene = sceneAtPage(project, index);
    const shape = currentShape(project);
    const part = shape ? shapeSpans(shape, project.pages.length).find((p) => p.first <= index && index <= p.last) : undefined;
    const tags = html("div", { className: "story-tags" });
    if (part) {
      const tag = html("button", { className: "story-tag part", textContent: part.name, title: "話の型（クリックで直す）" });
      tag.style.setProperty("--part", part.color);
      tag.addEventListener("click", () => this.select({ kind: "shape" }));
      tags.append(tag);
    }
    if (scene) {
      const tag = html("button", { className: "story-tag scene" }, icon("scene"), html("span", { textContent: scene.scene.title }));
      tag.title = "シーン（クリックで名前・あらすじを直す）";
      tag.addEventListener("click", () => this.select({ kind: "scene", sceneId: scene.scene.id }));
      tags.append(tag);
    }
    const emotions = project.characters.map((character) => {
      const point = project.emotions.find((p) => p.character === character.id && p.page === pageId);
      const value = html("input", { type: "number", min: "-1", max: "1", step: "0.1", value: point ? String(point.value) : "", placeholder: "—", title: "-1（後ろ向き）〜 1（前向き）" });
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
    return [
      ...(tags.childElementCount ? [tags] : []),
      ...(emotions.length ? [html("details", { className: "emotion-fold", open: project.emotions.some((p) => p.page === pageId) }, html("summary", { textContent: "感情（-1〜1）" }), ...emotions)] : []),
    ];
  }

  /** 話の型 and the page plan: which shape, how many pages, and what falls where. */
  private shapeInspector(project: Project): HTMLElement[] {
    const shape = currentShape(project);
    const count = project.pages.length;
    const picker = this.shapePicker(project);
    const target = html("input", { type: "number", min: "1", value: project.plan?.targetPages ? String(project.plan.targetPages) : "", placeholder: String(count), title: "目標ページ数" });
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
    const panels = project.pages.reduce((sum, page) => sum + page.panels.length, 0);
    const characters = project.pages.reduce((sum, page) => sum + textAmount(page), 0);
    const head = [
      html("h2", { className: "story-title" }, icon("shape"), html("span", { textContent: "話の型とページ配分" })),
      html("p", { className: "insp-summary", textContent: `${count} ページ・シーン ${sceneSpans(project).length}・コマ ${panels}・${characters} 字` }),
      html("label", {}, "話の型", picker),
      html("label", { className: "inline" }, "目標", target, "ページ"),
      ...planAdvice(project)
        .filter((advice) => advice.level === "warn")
        .map((advice) => html("p", { className: "insp-warn", textContent: advice.text })),
    ];
    if (!shape) return [...head, html("p", { className: "hint", textContent: "型を選ぶと、帯の「型」に区切りの色が出て、ページ一覧も色分けされます。" })];

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
    const scenes = sceneSpans(project);
    const parts = shape.parts.map((part, i) => {
      const name = html("input", { type: "text", value: part.name });
      name.addEventListener("change", () => change((own) => (own.parts[i].name = name.value.trim() || own.parts[i].name)));
      const color = html("input", { type: "color", value: partColor(shape, i) });
      color.addEventListener("change", () => change((own) => (own.parts[i].color = color.value)));
      const span = spans[i];
      const inside = span ? scenes.filter((s) => (s.first + s.last) / 2 >= span.first && (s.first + s.last) / 2 <= span.last + 0.5).map((s) => s.scene.title) : [];
      const pages = html("span", { className: "pages", textContent: span ? `${span.first + 1}〜${span.last + 1}` : "—", title: inside.length ? `シーン: ${inside.join("・")}` : "ここに当たるシーンはありません" });
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
      }),
    );
    return [
      ...head,
      html("h3", { textContent: `区切り（${count} ページに当てると）` }),
      ...parts,
      html("h3", { textContent: "ビート（話の転換点）" }),
      ...(beats.length ? beats : [html("p", { className: "hint", textContent: "なし" })]),
      html("div", { className: "row" }, addBeatButton, copy, ...(builtIn ? [] : [remove])),
      ...(builtIn ? [] : [html("label", {}, "型の名前", label)]),
      html("p", {
        className: "hint",
        textContent: builtIn
          ? "決まった型です。直すと「（自分用）」の写しができ、このネームとこの PC に保存されます（ほかのネームでも選べます）。"
          : "自分の型です。このネームとこの PC に保存され、ほかのネームでも選べます。",
      }),
    ];
  }

  private shapePicker(project: Project): HTMLSelectElement {
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
    return shapes;
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
  if (text) drawPageTexts(ctx, page, m);
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

/** A small line of values from -1 to 1. */
function sparkline(values: number[], color: string): SVGSVGElement {
  const [w, h] = [120, 22];
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const y = (value: number) => 2 + (h - 4) * (1 - (value + 1) / 2);
  const line = svg("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}`, class: "sparkline" });
  line.append(svg("line", { x1: 0, x2: w, y1: y(0), y2: y(0), class: "axis" }));
  if (values.length > 1) line.append(svg("polyline", { points: values.map((v, i) => `${i * step},${y(v)}`).join(" "), fill: "none", stroke: color, "stroke-width": 2 }));
  values.forEach((v, i) => line.append(svg("circle", { cx: values.length > 1 ? i * step : w / 2, cy: y(v), r: 2.5, fill: color })));
  return line;
}

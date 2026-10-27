// 読む表示: the name read through as the book, spread by spread on the whole
// window, with nothing of the work over it (no memos, stickies, panel
// numbers, selection or frames): what a reader or an editor will see. The
// keys, a click or tap on a side, a swipe or the wheel turn the pages; Esc
// goes back to the editor at the spread read last.
import type { Project, RoughImage } from "./model";
import type { Pair } from "./layout";
import { spreads } from "./pages";
import { LAYER_ORDER, drawPart, mapBox } from "./nameexport";
import { onPageOnly } from "./aside";
import { shownStrokes, withoutMarks } from "./roughlayers";
import { trimBox } from "./pagebox";
import { drawMarks, loadTips } from "./pagedraw";
import { useFonts } from "./fonts";
import { useStyle } from "./style";

export interface ReaderHost {
  project(): Project | null;
  /** 見開きの組み方: the first page on its own. */
  firstAlone(): boolean;
  /** The page (1-based) to start reading at. */
  page(): number;
  rough(rough: RoughImage): Promise<CanvasImageSource | null>;
  /** Reading ended at `pageNumber` (1-based): back to the editor there. */
  closed(pageNumber: number): void;
}

/** Room around the spread and under it for the page numbers (px). */
const PAD = 24;
const CAPTION = 28;
/** Wheel travel that turns one page (px), and how long a turn holds off the next. */
const WHEEL_STEP = 60;
const WHEEL_HOLD_MS = 250;
/** A drag this far across is a swipe; less is a tap (px). */
const SWIPE = 40;

/** The spreads of a name as read: as bound, a 縦スクロール strip piece by piece. */
export function readingSpreads(project: Pick<Project, "pages" | "scroll">, firstAlone: boolean): Pair[] {
  const count = project.pages.length;
  if (project.scroll) return Array.from({ length: count }, (_, i): Pair => [i + 1, null]);
  return spreads(count, firstAlone);
}

/**
 * Which way a turn goes: +1 to the next spread, -1 back. Right binding reads
 * right to left, so its next spread is to the left (as the editor's ←).
 */
export function turnOf(key: string, rightToLeft: boolean): 1 | -1 | 0 {
  switch (key) {
    case "ArrowLeft":
      return rightToLeft ? 1 : -1;
    case "ArrowRight":
      return rightToLeft ? -1 : 1;
    case "ArrowDown":
    case "PageDown":
    case " ":
    case "Enter":
      return 1;
    case "ArrowUp":
    case "PageUp":
    case "Backspace":
      return -1;
    default:
      return 0;
  }
}

/** A tap at `x` of a window `width` wide: the side read toward turns on (right binding: the left). */
export function tapTurn(x: number, width: number, rightToLeft: boolean): 1 | -1 {
  const left = x < width / 2;
  return left === rightToLeft ? 1 : -1;
}

/** A swipe `dx` across: pulling the page toward where it was read from turns on. */
export function swipeTurn(dx: number, rightToLeft: boolean): 1 | -1 | 0 {
  if (Math.abs(dx) < SWIPE) return 0;
  return dx > 0 === rightToLeft ? 1 : -1;
}

/** A page's place in the window: its trim box's left and top (px) and px per mm. */
interface Placed {
  index: number;
  left: number;
  top: number;
  scale: number;
}

/** Where the pages of `pair` go in a window `width` x `height`: the trims meet at the gutter, as in the book. */
export function placeSpread(project: Pick<Project, "pageFormat" | "binding" | "scroll">, pair: Pair, width: number, height: number): Placed[] {
  const [x0, y0, x1, y1] = trimBox(project.pageFormat);
  const pageW = x1 - x0;
  const pageH = y1 - y0;
  const single = !!project.scroll;
  const across = single ? pageW : pageW * 2;
  const scale = Math.max(0.01, Math.min((width - 2 * PAD) / across, (height - 2 * PAD - CAPTION) / pageH));
  const left = (width - across * scale) / 2;
  const top = (height - CAPTION - pageH * scale) / 2;
  if (single) return pair[0] === null ? [] : [{ index: pair[0] - 1, left, top, scale }];
  const [rightPage, leftPage] = project.binding === "right" ? pair : [pair[1], pair[0]];
  const placed: Placed[] = [];
  if (leftPage !== null) placed.push({ index: leftPage - 1, left, top, scale });
  if (rightPage !== null) placed.push({ index: rightPage - 1, left: left + pageW * scale, top, scale });
  return placed;
}

export class Reader {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly caption: HTMLElement;
  private readonly hint: HTMLElement;
  private list: Pair[] = [];
  private index = 0;
  /** Counts the draws, so a slow one (pictures loading) leaves a later one alone. */
  private drawn = 0;
  private wheelTravel = 0;
  private wheelHeld = 0;
  private down: { x: number; y: number; id: number } | null = null;
  private hintTimer = 0;

  constructor(private readonly host: ReaderHost) {
    this.root = document.createElement("div");
    this.root.className = "reader";
    this.root.id = "reader";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "読む表示");
    this.canvas = document.createElement("canvas");
    this.caption = document.createElement("div");
    this.caption.className = "reader-caption";
    this.hint = document.createElement("div");
    this.hint.className = "reader-hint";
    const close = document.createElement("button");
    close.className = "icon-button reader-close";
    close.title = "編集に戻る（Esc）";
    close.setAttribute("aria-label", "編集に戻る");
    close.innerHTML = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>';
    close.addEventListener("click", () => this.close());
    this.root.append(this.canvas, this.caption, this.hint, close);
    document.body.append(this.root);

    // Before the app's own keys: while reading, the keys turn pages and nothing else.
    window.addEventListener(
      "keydown",
      (event) => {
        if (!this.isOpen) return;
        event.stopImmediatePropagation();
        if (event.isComposing) return;
        event.preventDefault();
        if (event.key === "Escape" || event.key === "F5") this.close();
        else if (event.key === "Home") this.go(0);
        else if (event.key === "End") this.go(this.list.length - 1);
        else {
          const step = turnOf(event.key, this.rightToLeft);
          if (step) this.go(this.index + (event.shiftKey && event.key === " " ? -step : step));
        }
      },
      { capture: true },
    );
    window.addEventListener("resize", () => this.isOpen && this.draw());
    this.canvas.addEventListener("pointerdown", (event) => {
      this.down = { x: event.clientX, y: event.clientY, id: event.pointerId };
    });
    this.canvas.addEventListener("pointerup", (event) => {
      const down = this.down;
      this.down = null;
      if (!down || down.id !== event.pointerId) return;
      const dx = event.clientX - down.x;
      const dy = event.clientY - down.y;
      if (Math.hypot(dx, dy) < SWIPE) this.go(this.index + tapTurn(event.clientX, window.innerWidth, this.rightToLeft));
      else if (Math.abs(dx) > Math.abs(dy)) {
        const step = swipeTurn(dx, this.rightToLeft);
        if (step) this.go(this.index + step);
      } else this.go(this.index + (dy < 0 ? 1 : -1));
    });
    this.canvas.addEventListener("pointercancel", () => (this.down = null));
    this.root.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const now = performance.now();
        if (now < this.wheelHeld) return;
        this.wheelTravel += event.deltaY + event.deltaX;
        if (Math.abs(this.wheelTravel) < WHEEL_STEP) return;
        this.go(this.index + Math.sign(this.wheelTravel));
        this.wheelTravel = 0;
        this.wheelHeld = now + WHEEL_HOLD_MS;
      },
      { passive: false },
    );
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  private get rightToLeft(): boolean {
    return this.host.project()?.binding === "right";
  }

  /** Read the open name from the spread with the editor's page on it. */
  async open(): Promise<boolean> {
    const project = this.host.project();
    if (!project || !project.pages.length) return false;
    this.list = readingSpreads(project, this.host.firstAlone());
    const page = this.host.page();
    this.index = Math.max(0, this.list.findIndex((pair) => pair.includes(page)));
    this.root.hidden = false;
    document.body.classList.add("reading");
    this.hint.textContent = `${this.rightToLeft ? "← 次・→ 前" : "→ 次・← 前"}／クリックやスワイプでもめくる　Esc で戻る`;
    this.hint.classList.remove("faded");
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hint.classList.add("faded"), 2500);
    useFonts(project.fonts);
    useStyle(project.style);
    await loadTips(project.brushes ?? []);
    this.draw();
    return true;
  }

  /** Back to the editor, at the spread read last. */
  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    document.body.classList.remove("reading");
    const pair = this.list[this.index];
    const page = pair?.[0] ?? pair?.[1];
    if (page) this.host.closed(page);
  }

  /** The spread shown (0-based), for tests and the editor. */
  get spread(): number {
    return this.index;
  }

  private go(index: number): void {
    const next = Math.min(Math.max(index, 0), this.list.length - 1);
    if (next === this.index) return;
    this.index = next;
    this.draw();
  }

  private async draw(): Promise<void> {
    const project = this.host.project();
    const pair = this.list[this.index];
    if (!project || !pair) return;
    const ticket = ++this.drawn;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const placed = placeSpread(project, pair, width, height);
    // The pictures of the name sheet first, so the spread is drawn at once.
    const roughs = new Map<RoughImage, CanvasImageSource | null>();
    for (const { index } of placed) for (const rough of project.pages[index]?.roughs ?? []) roughs.set(rough, await this.host.rough(rough));
    if (ticket !== this.drawn || !this.isOpen) return;

    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const [x0, y0, x1, y1] = trimBox(project.pageFormat);
    for (const { index, left, top, scale } of placed) {
      const source = project.pages[index];
      if (!source) continue;
      const shown = { ...onPageOnly(source, project.pageFormat), strokes: shownStrokes(project, source.strokes) };
      const page = { ...shown, strokes: withoutMarks(project, shown.strokes) };
      const m = { scale, x: left - x0 * scale, y: top - y0 * scale };
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, (x1 - x0) * scale, (y1 - y0) * scale);
      ctx.clip();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(left, top, (x1 - x0) * scale, (y1 - y0) * scale);
      ctx.globalAlpha = 0.45;
      for (const rough of page.roughs) {
        const image = roughs.get(rough);
        if (!image) continue;
        const [bx0, by0, bx1, by1] = mapBox(rough.box, m);
        ctx.drawImage(image, bx0, by0, bx1 - bx0, by1 - by0);
      }
      ctx.globalAlpha = 1;
      for (const kind of LAYER_ORDER) drawPart(ctx, page, kind, m, project.brushes);
      // 指示 as on the editor's pages: shown or hidden with them.
      drawMarks(ctx, project, shown, m);
      ctx.restore();
    }
    // The gutter, faintly, where two pages meet.
    if (placed.length === 2) {
      const gutter = placed[1].left;
      ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
      ctx.fillRect(gutter - 1, placed[0].top, 2, (y1 - y0) * placed[0].scale);
    }
    const numbers = pair.filter((n): n is number => n !== null).sort((a, b) => a - b);
    this.caption.textContent = `${numbers.join("–")} / ${project.pages.length}`;
  }
}

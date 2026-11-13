// サブビュー (画面分割): the spread worked on, whole, in a palette beside the
// main view — what the main view shows framed in red. Pressing a panel brings
// the main view to it, fitted (one panel at a time there, the whole page
// here); pressing or dragging elsewhere moves the main view to that point.
// 前のコマ・次のコマ step through the panels in reading order, on to the next
// spread. Mirrored on its own (サブビューだけ反転), as CSP's サブビュー can be.

import { panelAt } from "../editing/hittest";
import type { Slot } from "../editing/layout";
import { bounds } from "../model/geometry";
import type { Page, Panel, Point, Project } from "../model/model";
import { element } from "../platform/dom";
import { SUBVIEW_FLIP_KEY } from "../platform/prefs";
import { readFlag, writeFlag } from "../platform/settings";
import { drawThumb } from "../render/pagethumb";
import type { PageEditor } from "./editor";
import { PALETTE_RESIZED } from "./popout";

export interface SubViewHost {
  project(): Project | null;
  editor(): PageEditor;
  status(message: string): void;
}

/** Room round the spread in the sub view (px). */
const PAD = 8;
const SHOWN = "#e0464b";
const FOCUS = "#2f6fd6";

/** Where the spread lies in the sub view: upright layout px → sub view px (before mirroring). */
interface Fit {
  slots: Slot[];
  k: number;
  dx: number;
  dy: number;
  width: number;
}

/** A panel of the name, where it is in reading order. */
export interface PanelStop {
  pageId: string;
  panel: Panel;
}

/** Every panel of the name in reading order: page by page, by each page's コマ順. */
export function panelStops(project: Project): PanelStop[] {
  return project.pages.flatMap((page) => [...page.panels].sort((a, b) => a.order - b.order).map((panel) => ({ pageId: page.id, panel })));
}

export class SubView {
  private canvas: HTMLCanvasElement | null = null;
  private flipBox: HTMLInputElement | null = null;
  private frame = 0;
  private flipped = readFlag(SUBVIEW_FLIP_KEY, false);
  /** The panel the main view was last brought to (前・次 go on from it). */
  private focus: { pageId: string; panelId: string } | null = null;
  private fit: Fit | null = null;
  private dragging = false;
  /** The pages as last drawn (redrawn when the name changes or they lie otherwise), and what they were drawn for. */
  private pages: HTMLCanvasElement | null = null;
  private pagesFor = "";

  constructor(private readonly host: SubViewHost) {}

  /** The palette's body: built once, then drawn as the main view moves. */
  render(box: HTMLElement): void {
    if (!this.canvas || !box.contains(this.canvas)) this.build(box);
    this.pagesFor = "";
    this.redraw();
  }

  private build(box: HTMLElement): void {
    const button = (text: string, title: string, run: () => void) => {
      const b = element("button", { className: "small", textContent: text, title, type: "button" });
      b.addEventListener("click", run);
      return b;
    };
    this.flipBox = element("input", { type: "checkbox", checked: this.flipped });
    this.flipBox.addEventListener("change", () => this.setFlipped(!!this.flipBox?.checked));
    this.canvas = element("canvas", { className: "subview-canvas" });
    this.canvas.setAttribute("aria-label", "サブビュー: 見開きの全体。赤い枠が画面に出ている所。コマを押すとそのコマに寄る");
    this.canvas.addEventListener("pointerdown", (event) => this.press(event));
    this.canvas.addEventListener("pointermove", (event) => this.dragging && this.moveTo(event));
    const stop = () => (this.dragging = false);
    this.canvas.addEventListener("pointerup", stop);
    this.canvas.addEventListener("pointercancel", stop);
    new ResizeObserver(() => this.redraw()).observe(this.canvas);
    box.addEventListener(PALETTE_RESIZED, () => this.redraw());
    box.replaceChildren(
      element(
        "div",
        { className: "subview-bar" },
        button("◀ 前のコマ", "前のコマに寄る（読む順。PageUp）", () => this.step(-1)),
        button("次のコマ ▶", "次のコマに寄る（読む順。PageDown）", () => this.step(1)),
        button("全体", "見開き全体を表示（Ctrl+0）", () => this.host.editor().fitView()),
        element("label", { className: "inline", title: "サブビューだけ左右反転（画面と書き出しはそのまま）" }, this.flipBox, "反転"),
      ),
      this.canvas,
    );
    this.host.editor().afterDraw = () => this.redraw();
  }

  setFlipped(flipped: boolean): void {
    this.flipped = flipped;
    writeFlag(SUBVIEW_FLIP_KEY, flipped);
    if (this.flipBox) this.flipBox.checked = flipped;
    this.redraw();
  }

  /** Drawn on the next frame, when it shows. */
  redraw(): void {
    if (this.frame || !this.canvas?.isConnected || !this.canvas.clientWidth) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** The panel the main view is on now: the one picked, else the one it was brought to. */
  private current(project: Project): PanelStop | null {
    const selection = this.host.editor().selection;
    const stops = panelStops(project);
    if (selection?.kind === "panel") {
      const picked = stops.find((stop) => stop.pageId === selection.pageId && stop.panel.id === selection.id);
      if (picked) return picked;
    }
    return stops.find((stop) => stop.pageId === this.focus?.pageId && stop.panel.id === this.focus.panelId) ?? null;
  }

  /** 前のコマ・次のコマ: the main view fitted to the panel before or after (from the spread on screen when there is none yet). */
  step(delta: 1 | -1): void {
    const project = this.host.project();
    if (!project) return;
    const stops = panelStops(project);
    if (!stops.length) {
      this.host.status("コマがありません");
      return;
    }
    const now = this.current(project);
    let at = now ? stops.findIndex((stop) => stop.pageId === now.pageId && stop.panel.id === now.panel.id) + delta : -1;
    if (!now) {
      // From the spread on screen: its first panel (or its last, going back).
      const shown = new Set(
        this.host
          .editor()
          .currentPages()
          .map((n) => project.pages[n - 1]?.id),
      );
      const here = stops.filter((stop) => shown.has(stop.pageId));
      at = here.length ? stops.indexOf(delta > 0 ? here[0] : here[here.length - 1]) : delta > 0 ? 0 : stops.length - 1;
    }
    if (at < 0 || at >= stops.length) {
      this.host.status(delta > 0 ? "最後のコマです" : "最初のコマです");
      return;
    }
    this.goTo(project, stops[at]);
  }

  private goTo(project: Project, stop: PanelStop): void {
    this.focus = { pageId: stop.pageId, panelId: stop.panel.id };
    const editor = this.host.editor();
    // A panel picked moves on with the view (its handles would stay on the one left).
    if (editor.selection?.kind === "panel") editor.select({ kind: "panel", pageId: stop.pageId, id: stop.panel.id });
    editor.lookAt(stop.pageId, bounds(stop.panel.shape), true);
    const page = project.pages.findIndex((p) => p.id === stop.pageId) + 1;
    this.host.status(`${page} ページ ${stop.panel.order} コマ目に寄りました（PageDown で次・PageUp で前・Ctrl+0 で全体）`);
    this.redraw();
  }

  /** The page and its point (mm) under a point of the sub view. */
  private hit(event: PointerEvent): { page: Page; point: Point } | null {
    const fit = this.fit;
    if (!fit || !this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    let sx = event.clientX - rect.left;
    if (this.flipped) sx = fit.width - sx;
    const sy = event.clientY - rect.top;
    const [ux, uy] = [(sx - fit.dx) / fit.k, (sy - fit.dy) / fit.k];
    const at = (slot: Slot): Point => [(ux - slot.x) / slot.scale, (uy - slot.y) / slot.scale];
    const height = this.host.project()?.pageFormat.canvasMm[1] ?? 0;
    const inside = (slot: Slot) => {
      const [x, y] = at(slot);
      return x >= slot.shown[0] && x <= slot.shown[1] && y >= 0 && y <= height;
    };
    // Off the pages: the nearest one, so a drag can take the view past their edge.
    const slot =
      fit.slots.find(inside) ??
      [...fit.slots].sort(
        (a, b) => Math.abs(at(a)[0] - (a.shown[0] + a.shown[1]) / 2) - Math.abs(at(b)[0] - (b.shown[0] + b.shown[1]) / 2),
      )[0];
    return slot ? { page: slot.page, point: at(slot) } : null;
  }

  private press(event: PointerEvent): void {
    if (event.button !== 0) return;
    const project = this.host.project();
    const hit = this.hit(event);
    if (!project || !hit) return;
    const panel = panelAt(hit.page, hit.point);
    if (panel) {
      this.goTo(project, { pageId: hit.page.id, panel });
      return;
    }
    this.dragging = true;
    this.canvas?.setPointerCapture(event.pointerId);
    this.moveTo(event);
  }

  /** The main view's middle to the point under the pointer (its zoom kept). */
  private moveTo(event: PointerEvent): void {
    const hit = this.hit(event);
    if (!hit) return;
    const [x, y] = hit.point;
    this.host.editor().lookAt(hit.page.id, [x, y, x, y], false);
  }

  private draw(): void {
    const canvas = this.canvas;
    const project = this.host.project();
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!project) return;
    const editor = this.host.editor();
    const numbers = new Set(editor.currentPages());
    const slots = editor.stage.slots.filter((slot) => numbers.has(slot.index + 1));
    if (!slots.length) return;
    const pageH = project.pageFormat.canvasMm[1];
    const x0 = Math.min(...slots.map((s) => s.x + s.shown[0] * s.scale));
    const x1 = Math.max(...slots.map((s) => s.x + s.shown[1] * s.scale));
    const y0 = Math.min(...slots.map((s) => s.y));
    const y1 = Math.max(...slots.map((s) => s.y + pageH * s.scale));
    const k = Math.min((width - 2 * PAD) / Math.max(x1 - x0, 1), (height - 2 * PAD) / Math.max(y1 - y0, 1));
    if (!(k > 0)) return;
    const fit: Fit = {
      slots,
      k,
      dx: (width - (x1 - x0) * k) / 2 - x0 * k,
      dy: (height - (y1 - y0) * k) / 2 - y0 * k,
      width,
    };
    this.fit = fit;
    const mirror = this.flipped ? -1 : 1;
    const base = (on: CanvasRenderingContext2D): void => on.setTransform(ratio * mirror, 0, 0, ratio, this.flipped ? width * ratio : 0, 0);
    const key = [
      canvas.width,
      canvas.height,
      this.flipped,
      ...slots.map((s) => `${s.page.id}:${((s.x - x0) / (x1 - x0)).toFixed(4)}:${s.shown}`),
    ].join("|");
    if (key !== this.pagesFor || !this.pages) {
      this.pages ??= document.createElement("canvas");
      this.pages.width = canvas.width;
      this.pages.height = canvas.height;
      const paper = this.pages.getContext("2d");
      if (!paper) return;
      for (const slot of slots) {
        const scale = slot.scale * k;
        base(paper);
        paper.translate(fit.dx + slot.x * k, fit.dy + slot.y * k);
        paper.save();
        paper.beginPath();
        paper.rect(slot.shown[0] * scale, 0, (slot.shown[1] - slot.shown[0]) * scale, pageH * scale);
        paper.clip();
        // The words only where they can be read.
        drawThumb(paper, project, slot.page, { scale, x: 0, y: 0 }, scale > 0.9);
        paper.restore();
        paper.strokeStyle = "rgba(27, 26, 24, 0.35)";
        paper.lineWidth = 1;
        paper.strokeRect(slot.shown[0] * scale, 0, (slot.shown[1] - slot.shown[0]) * scale, pageH * scale);
      }
      this.pagesFor = key;
    }
    ctx.drawImage(this.pages, 0, 0);
    const current = this.current(project);
    const slot = current && slots.find((s) => s.page.id === current.pageId);
    if (current && slot) {
      const scale = slot.scale * k;
      base(ctx);
      ctx.translate(fit.dx + slot.x * k, fit.dy + slot.y * k);
      ctx.beginPath();
      current.panel.shape.forEach(([x, y], i) => (i ? ctx.lineTo(x * scale, y * scale) : ctx.moveTo(x * scale, y * scale)));
      ctx.closePath();
      ctx.strokeStyle = FOCUS;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // What the main view shows (turned as it is).
    base(ctx);
    const shown = editor.stage.shownArea().map(([x, y]) => [fit.dx + x * k, fit.dy + y * k]);
    ctx.beginPath();
    shown.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = "rgba(224, 70, 75, 0.08)";
    ctx.fill();
    ctx.strokeStyle = SHOWN;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

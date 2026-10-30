// レイヤー: the pages shown, as CSP's コマ枠フォルダ — each panel with what is
// drawn in it (dialogue, rough lines, fills), then what lies outside the
// panels. Rows pick things on the page, the eye hides them (on screen only),
// and dragging a row onto a panel moves it into that panel.
import { stacked } from "./koma";
import { bounds, centroid } from "./geometry";
import type { Page, Panel, Point } from "./model";
import { carryContents } from "./panels";
import { mapFill } from "./strokes";

/** Something a row stands for. Rough lines are listed together, per panel. */
export type LayerRef =
  | { kind: "panel" | "line" | "fill" | "breakout" | "sticky"; pageId: string; id: string }
  | { kind: "strokes"; pageId: string; ids: string[] };

export interface PanelLayers {
  panel: Panel;
  lines: string[];
  strokes: string[];
  fills: string[];
}

export interface PageLayers {
  page: Page;
  panels: PanelLayers[];
  /** What no panel holds. */
  outside: { lines: string[]; strokes: string[]; fills: string[] };
}

/** Which panel holds what: the same rule moving a panel uses (more than half of a line inside). */
export function pageLayers(page: Page): PageLayers {
  const taken = new Set<string>();
  // Insets (はめ込み) first: they sit over their panel and hold what is on them.
  const panels = [...stacked(page.panels)].reverse().map((panel) => {
    const carried = carryContents(page, panel);
    const free = (ids: string[]) => ids.filter((id) => !taken.has(id) && (taken.add(id), true));
    return {
      panel,
      lines: free(carried.lines.map((l) => l.id)),
      strokes: free(carried.strokes.map((s) => s.id)),
      fills: free((carried.fills ?? []).map((f) => f.id)),
    };
  });
  panels.sort((a, b) => a.panel.order - b.panel.order);
  return {
    page,
    panels,
    outside: {
      lines: page.lines.filter((l) => !taken.has(l.id)).map((l) => l.id),
      strokes: page.strokes.filter((s) => !taken.has(s.id)).map((s) => s.id),
      fills: (page.fills ?? []).filter((f) => !taken.has(f.id)).map((f) => f.id),
    },
  };
}

/** The keys a row hides: a panel hides what is in it too. */
export function hiddenKeys(layers: PageLayers, ref: LayerRef): string[] {
  if (ref.kind === "strokes") return ref.ids.map((id) => `stroke:${id}`);
  if (ref.kind !== "panel") return [`${ref.kind}:${ref.id}`];
  const held = layers.panels.find((p) => p.panel.id === ref.id);
  return [
    `panel:${ref.id}`,
    ...(held?.lines ?? []).map((id) => `line:${id}`),
    ...(held?.strokes ?? []).map((id) => `stroke:${id}`),
    ...(held?.fills ?? []).map((id) => `fill:${id}`),
  ];
}

/** The middle of what a row stands for on its page. */
function middleOf(page: Page, ref: LayerRef): Point | null {
  const points: Point[] = [];
  if (ref.kind === "strokes") {
    for (const stroke of page.strokes) if (ref.ids.includes(stroke.id)) for (const [x, y] of stroke.points) points.push([x, y]);
  } else if (ref.kind === "line") {
    const line = page.lines.find((l) => l.id === ref.id);
    if (line) points.push([line.box[0], line.box[1]], [line.box[2], line.box[3]]);
  } else if (ref.kind === "fill") {
    const fill = page.fills?.find((f) => f.id === ref.id);
    if (fill) return centroid(fill.shape);
  }
  if (!points.length) return null;
  const [x0, y0, x1, y1] = bounds(points);
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/**
 * Move dialogue, rough lines or a fill into a panel (on the same page or
 * the facing one): it keeps where it sat in its old panel, measured from
 * the panel's middle, and lands inside the new one. Returns false when
 * there is nothing to move.
 */
export function moveIntoPanel(from: Page, ref: LayerRef, to: Page, panel: Panel): boolean {
  if (ref.kind !== "line" && ref.kind !== "strokes" && ref.kind !== "fill") return false;
  const middle = middleOf(from, ref);
  if (!middle) return false;
  const source = pageLayers(from).panels.find((held) =>
    ref.kind === "strokes" ? ref.ids.every((id) => held.strokes.includes(id)) : (ref.kind === "line" ? held.lines : held.fills).includes(ref.id),
  );
  const target = bounds(panel.shape);
  const targetMiddle: Point = [(target[0] + target[2]) / 2, (target[1] + target[3]) / 2];
  // From the old panel's middle (or, from outside the panels, the thing's own middle).
  let anchor = middle;
  if (source) {
    const [x0, y0, x1, y1] = bounds(source.panel.shape);
    anchor = [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  let [dx, dy] = [targetMiddle[0] - anchor[0], targetMiddle[1] - anchor[1]];
  // Keep its middle inside the new panel.
  const [mx, my] = [middle[0] + dx, middle[1] + dy];
  const inset = 2;
  dx += Math.min(Math.max(mx, target[0] + inset), target[2] - inset) - mx;
  dy += Math.min(Math.max(my, target[1] + inset), target[3] - inset) - my;
  const shift = ([x, y, ...rest]: readonly number[]) => [x + dx, y + dy, ...rest];
  if (ref.kind === "line") {
    const line = from.lines.find((l) => l.id === ref.id);
    if (!line) return false;
    line.box = [line.box[0] + dx, line.box[1] + dy, line.box[2] + dx, line.box[3] + dy];
    if (line.balloon) line.balloon = line.balloon.map((p) => shift(p) as Point);
    for (const tail of line.tails ?? []) tail.tip = shift(tail.tip) as Point;
    if (from !== to) {
      from.lines = from.lines.filter((l) => l !== line);
      delete line.linkTo;
      to.lines.push(line);
    }
  } else if (ref.kind === "strokes") {
    const strokes = from.strokes.filter((s) => ref.ids.includes(s.id));
    for (const stroke of strokes) stroke.points = stroke.points.map((p) => shift(p) as typeof p);
    if (from !== to) {
      from.strokes = from.strokes.filter((s) => !strokes.includes(s));
      to.strokes.push(...strokes);
    }
  } else {
    const fill = from.fills?.find((f) => f.id === ref.id);
    if (!fill) return false;
    mapFill(fill, (p) => shift(p) as Point);
    if (from !== to) {
      from.fills = (from.fills ?? []).filter((f) => f !== fill);
      to.fills = [...(to.fills ?? []), fill];
    }
  }
  return true;
}

// --- the list -----------------------------------------------------------------

export interface LayerViewHost {
  /** Whether a row is what is selected now. */
  selected(ref: LayerRef): boolean;
  select(ref: LayerRef): void;
  /** Keys hidden on screen (`kind:id`). */
  hidden(): ReadonlySet<string>;
  setHidden(keys: string[], hide: boolean): void;
  /** A row dropped on a panel: move it there (or, for a panel, swap what the two hold). */
  drop(ref: LayerRef, to: { pageId: string; panelId: string }): void;
  /** Words for a line of dialogue. */
  lineLabel(page: Page, id: string): string;
  /** Whether a line is a 指示 (listed apart from the rough lines). */
  isMark(page: Page, strokeId: string): boolean;
}

const TONE_NAMES: Record<string, string> = { black: "黒", gray: "グレー", white: "白" };
const DRAG_START = 6;

export class LayerView {
  /** Panels folded shut (their contents not listed). */
  private readonly folded = new Set<string>();

  constructor(private readonly host: LayerViewHost) {}

  /** List the pages given (with their page numbers, 1-based). */
  render(container: HTMLElement, pages: { page: Page; number: number }[]): void {
    const rows: HTMLElement[] = [];
    for (const { page, number } of pages) {
      const layers = pageLayers(page);
      rows.push(Object.assign(document.createElement("div"), { className: "layer-page", textContent: `${number} ページ` }));
      for (const held of layers.panels) {
        const ref: LayerRef = { kind: "panel", pageId: page.id, id: held.panel.id };
        const count = held.lines.length + (held.strokes.length ? 1 : 0) + held.fills.length;
        const open = !this.folded.has(held.panel.id);
        const fold = Object.assign(document.createElement("button"), {
          type: "button",
          className: "layer-fold",
          textContent: count ? (open ? "▾" : "▸") : "",
          title: open ? "たたむ" : "ひらく",
          disabled: !count,
        });
        fold.addEventListener("click", (event) => {
          event.stopPropagation();
          if (open) this.folded.add(held.panel.id);
          else this.folded.delete(held.panel.id);
          this.render(container, pages);
        });
        const note = held.panel.note ? held.panel.note.split("\n")[0] : "";
        const inset = (held.panel.z ?? 0) > 0 ? "（はめ込み）" : "";
        rows.push(this.row(layers, ref, 0, `🗀 コマ ${held.panel.order}${inset}`, note, fold, page.id, held.panel.id));
        if (!open) continue;
        rows.push(...this.contents(layers, page, held, 1));
      }
      const outside = layers.outside;
      if (outside.lines.length || outside.strokes.length || outside.fills.length) {
        rows.push(Object.assign(document.createElement("div"), { className: "layer-group", textContent: "コマの外" }));
        rows.push(...this.contents(layers, page, outside, 1));
      }
      for (const breakout of page.breakouts) {
        rows.push(this.row(layers, { kind: "breakout", pageId: page.id, id: breakout.id }, 0, "はみ出し", breakout.note ?? ""));
      }
      for (const sticky of page.stickies ?? []) {
        rows.push(this.row(layers, { kind: "sticky", pageId: page.id, id: sticky.id }, 0, "付箋", sticky.text.split("\n")[0]));
      }
      if (!page.panels.length && !page.lines.length && !page.strokes.length) {
        rows.push(Object.assign(document.createElement("div"), { className: "layer-empty", textContent: "まだ何もありません" }));
      }
    }
    rows.push(
      Object.assign(document.createElement("p"), {
        className: "hint layer-hint",
        textContent: "行を押すと選び、目で画面から隠します（書き出しには入ります）。セリフ・ラフ線・塗りの行をコマの行へドラッグするとそのコマへ移し、コマをコマへドラッグすると中身を入れ替えます。",
      }),
    );
    container.replaceChildren(...rows);
  }

  private contents(layers: PageLayers, page: Page, held: { lines: string[]; strokes: string[]; fills: string[] }, depth: number): HTMLElement[] {
    const rows: HTMLElement[] = [];
    for (const id of held.lines) rows.push(this.row(layers, { kind: "line", pageId: page.id, id }, depth, "セリフ", this.host.lineLabel(page, id)));
    const marks = held.strokes.filter((id) => this.host.isMark(page, id));
    const rough = held.strokes.filter((id) => !marks.includes(id));
    if (rough.length) rows.push(this.row(layers, { kind: "strokes", pageId: page.id, ids: rough }, depth, "ラフ線", `${rough.length} 本`));
    if (marks.length) rows.push(this.row(layers, { kind: "strokes", pageId: page.id, ids: marks }, depth, "指示", `${marks.length} 本`));
    for (const id of held.fills) {
      const tone = page.fills?.find((f) => f.id === id)?.tone ?? "black";
      rows.push(this.row(layers, { kind: "fill", pageId: page.id, id }, depth, "塗り", TONE_NAMES[tone] ?? tone));
    }
    return rows;
  }

  private row(layers: PageLayers, ref: LayerRef, depth: number, label: string, detail: string, lead?: HTMLElement, pageId?: string, panelId?: string): HTMLElement {
    const keys = hiddenKeys(layers, ref);
    const hidden = keys.length > 0 && keys.every((key) => this.host.hidden().has(key));
    const row = document.createElement("div");
    row.className = `layer-row depth-${depth}${this.host.selected(ref) ? " selected" : ""}${hidden ? " hidden-layer" : ""}`;
    if (panelId) {
      row.dataset.page = pageId;
      row.dataset.panel = panelId;
    }
    const eye = Object.assign(document.createElement("button"), {
      type: "button",
      className: "layer-eye",
      textContent: hidden ? "－" : "👁",
      title: hidden ? "画面に出す" : "画面から隠す（書き出しには入ります）",
    });
    eye.addEventListener("click", (event) => {
      event.stopPropagation();
      this.host.setHidden(keys, !hidden);
    });
    eye.addEventListener("pointerdown", (event) => event.stopPropagation());
    const name = Object.assign(document.createElement("span"), { className: "layer-name", textContent: label });
    const more = Object.assign(document.createElement("span"), { className: "layer-detail", textContent: detail });
    row.append(eye, ...(lead ? [lead] : [Object.assign(document.createElement("span"), { className: "layer-fold" })]), name, more);
    row.addEventListener("click", () => this.host.select(ref));
    this.draggable(row, ref);
    return row;
  }

  /** Drag a row onto a panel's row. */
  private draggable(row: HTMLElement, ref: LayerRef): void {
    row.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const start = { x: event.clientX, y: event.clientY };
      let dragging = false;
      let target: HTMLElement | null = null;
      const move = (e: PointerEvent) => {
        if (!dragging) {
          if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_START) return;
          dragging = true;
          row.classList.add("dragging");
          document.body.classList.add("sorting");
        }
        const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".layer-row[data-panel]") ?? null;
        const valid = under && under !== row ? under : null;
        if (valid !== target) {
          target?.classList.remove("drop-target");
          valid?.classList.add("drop-target");
          target = valid;
        }
      };
      const end = (e: PointerEvent) => {
        row.removeEventListener("pointermove", move);
        row.removeEventListener("pointerup", end);
        row.removeEventListener("pointercancel", end);
        if (row.hasPointerCapture(e.pointerId)) row.releasePointerCapture(e.pointerId);
        if (!dragging) return;
        row.classList.remove("dragging");
        document.body.classList.remove("sorting");
        target?.classList.remove("drop-target");
        // The click that follows the release is part of the drag.
        const swallow = (click: Event) => click.stopPropagation();
        row.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => row.removeEventListener("click", swallow, { capture: true }), 0);
        if (e.type === "pointerup" && target?.dataset.panel && target.dataset.page) {
          this.host.drop(ref, { pageId: target.dataset.page, panelId: target.dataset.panel });
        }
      };
      try {
        row.setPointerCapture(event.pointerId);
      } catch {
        // Without capture the drag still works while the pointer stays over the list.
      }
      row.addEventListener("pointermove", move);
      row.addEventListener("pointerup", end);
      row.addEventListener("pointercancel", end);
    });
  }
}

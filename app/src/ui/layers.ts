// レイヤー: the pages shown, as CSP's コマ枠フォルダ — each panel with what is
// drawn in it (dialogue, rough lines, fills), then what lies outside the
// panels. Rows pick things on the page, the eye hides them (on screen only),
// and dragging a row onto a panel moves it into that panel.
import { stacked } from "../domain/koma";
import { bounds, centroid } from "../model/geometry";
import type { BoxMm, Page, Panel, Point, Project } from "../model/model";
import { ListPicker } from "./listops";
import { drawPartThumb } from "../render/pagethumb";
import { readChoice, writeText } from "../platform/settings";
import { carryContents } from "../domain/panels";
import { shownStrokes } from "../domain/roughlayers";
import { mapFill } from "../domain/strokes";

/** Something a row stands for. Rough lines are listed together, per panel. */
export type LayerRef =
  | { kind: "panel" | "line" | "fill" | "breakout" | "sticky"; pageId: string; id: string }
  | { kind: "strokes"; pageId: string; ids: string[] };

/** What a ミニビュー can be of: a row, or a whole page (its folder). */
type ThumbRef = LayerRef | { kind: "page"; pageId: string };

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

/**
 * The page as shown: without what the rows' eyes hide (keys of hiddenKeys),
 * the lines on a hidden ラフ線のレイヤー of `project`, nor its 付箋 when they
 * are all hidden (`stickies` false).
 */
export function withoutHidden(page: Page, hidden: ReadonlySet<string>, stickies = true, project?: Pick<Project, "roughLayers">): Page {
  const strokes = project ? shownStrokes(project, page.strokes) : page.strokes;
  if (strokes !== page.strokes) page = { ...page, strokes };
  if (!stickies && page.stickies?.length) page = { ...page, stickies: [] };
  if (!hidden.size) return page;
  const shown = <T extends { id: string }>(kind: string, list: T[]) => list.filter((item) => !hidden.has(`${kind}:${item.id}`));
  return {
    ...page,
    panels: shown("panel", page.panels),
    lines: shown("line", page.lines),
    strokes: shown("stroke", page.strokes),
    breakouts: shown("breakout", page.breakouts),
    ...(page.fills ? { fills: shown("fill", page.fills) } : {}),
    ...(page.stickies ? { stickies: shown("sticky", page.stickies) } : {}),
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
    ref.kind === "strokes"
      ? ref.ids.every((id) => held.strokes.includes(id))
      : (ref.kind === "line" ? held.lines : held.fills).includes(ref.id),
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
  /** The name shown (for the ミニビュー). */
  project(): Project | null;
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
  /** Several rows picked (Ctrl / Shift): what is on one page of them selected together. */
  selectMany(refs: LayerRef[]): void;
  /** What is selected: deleted, copied, … as the page's own keys do. */
  act(what: LayerAct): void;
  canPaste(): boolean;
}

export type LayerAct = "delete" | "duplicate" | "copy" | "cut" | "paste" | "hold";

/** A row's id in the list. */
function refKey(ref: LayerRef): string {
  return ref.kind === "strokes" ? `strokes:${ref.pageId}:${ref.ids.join(",")}` : `${ref.kind}:${ref.pageId}:${ref.id}`;
}

const TONE_NAMES: Record<string, string> = { black: "黒", gray: "グレー", white: "白" };
const DRAG_START = 6;

/** ミニビュー: none, or how big each row's small picture is (as CSP's サムネイルの大きさ). */
export type ThumbSize = "none" | "small" | "large";
export const THUMB_SIZES: ThumbSize[] = ["none", "small", "large"];
export const THUMB_LABELS: Record<ThumbSize, string> = { none: "なし", small: "小", large: "大" };
export const LAYER_THUMBS_KEY = "namestudio.layerThumbs";
const THUMB_PX: Record<Exclude<ThumbSize, "none">, [number, number]> = { small: [34, 24], large: [60, 42] };

/** What a ミニビュー shows: the page holding only what the row stands for, and the box to fit. */
export interface ThumbPart {
  page: Page;
  box: BoxMm;
  /** A 付箋's colour, or 指示 in their own colour. */
  ink?: string;
}

const empty = (page: Page): Page => ({ ...page, panels: [], lines: [], strokes: [], fills: [], breakouts: [], stickies: [], roughs: [] });

/** Grown by `mm` all round (a small part is not blown up to fill its picture). */
function padded([x0, y0, x1, y1]: BoxMm, mm: number): BoxMm {
  const grow = Math.max(mm, (12 - Math.min(x1 - x0, y1 - y0)) / 2);
  return [x0 - grow, y0 - grow, x1 + grow, y1 + grow];
}

/** The ミニビュー of a row: what it stands for alone on its page; null when there is nothing to draw. */
export function thumbPart(layers: PageLayers, ref: ThumbRef, pageFormat?: Project["pageFormat"]): ThumbPart | null {
  const page = layers.page;
  if (ref.kind === "panel") {
    const held = layers.panels.find((p) => p.panel.id === ref.id);
    if (!held) return null;
    return {
      page: {
        ...empty(page),
        panels: [held.panel],
        lines: page.lines.filter((l) => held.lines.includes(l.id)),
        strokes: page.strokes.filter((s) => held.strokes.includes(s.id)),
        fills: (page.fills ?? []).filter((f) => held.fills.includes(f.id)),
      },
      box: padded(bounds(held.panel.shape), 1),
    };
  }
  if (ref.kind === "line") {
    const line = page.lines.find((l) => l.id === ref.id);
    if (!line) return null;
    const points: Point[] = [[line.box[0], line.box[1]], [line.box[2], line.box[3]], ...(line.balloon ?? [])];
    return { page: { ...empty(page), lines: [line] }, box: padded(bounds(points), 1) };
  }
  if (ref.kind === "strokes") {
    const strokes = page.strokes.filter((s) => ref.ids.includes(s.id));
    const points = strokes.flatMap((s) => s.points);
    if (!points.length) return null;
    return { page: { ...empty(page), strokes: strokes.map((s) => (s.over ? { ...s, over: false } : s)) }, box: padded(bounds(points), 1) };
  }
  if (ref.kind === "fill") {
    const fill = page.fills?.find((f) => f.id === ref.id);
    if (!fill) return null;
    return { page: { ...empty(page), fills: [fill] }, box: padded(bounds(fill.shape), 1) };
  }
  if (ref.kind === "breakout") {
    const breakout = page.breakouts.find((b) => b.id === ref.id);
    if (!breakout) return null;
    // はみ出し: its outline, as a panel border.
    return {
      page: { ...empty(page), panels: [{ id: breakout.id, shape: breakout.shape, order: 0, border: "dashed" }] },
      box: padded(bounds(breakout.shape), 1),
    };
  }
  if (ref.kind === "page" && pageFormat) {
    const [w, h] = pageFormat.canvasMm;
    return { page, box: [0, 0, w, h] };
  }
  return null;
}

/** Read and kept: the ミニビュー's size. */
export function thumbSize(): ThumbSize {
  return readChoice(LAYER_THUMBS_KEY, THUMB_SIZES, "small");
}

export class LayerView {
  /** Folders shut (their contents not listed): panels by id, pages as `page:<id>`, outside as `outside:<id>`. */
  private readonly folded = new Set<string>();
  /** The rows listed now, by id, in order. */
  private refs = new Map<string, LayerRef>();
  /** The pages listed now (the keys to hide). */
  private listed: PageLayers[] = [];
  private picker: ListPicker | null = null;
  /** ミニビュー drawn, by row, with what they were drawn from (drawn again only when that changes). */
  private thumbs = new Map<string, { sign: string; canvas: HTMLCanvasElement }>();
  /** ミニビュー to draw once the rows are on screen. */
  private pending: { canvas: HTMLCanvasElement; part: ThumbPart }[] = [];
  private size: ThumbSize = thumbSize();
  private last: { container: HTMLElement; pages: { page: Page; number: number }[] } | null = null;

  constructor(private readonly host: LayerViewHost) {}

  /** The ミニビュー's size (なし・小・大), kept for the next start. */
  setThumbSize(size: ThumbSize): void {
    this.size = size;
    writeText(LAYER_THUMBS_KEY, size);
    this.thumbs.clear();
    this.again();
  }

  /** Every folder opened (or shut) on the pages listed. */
  foldAll(shut: boolean): void {
    this.folded.clear();
    if (shut) for (const layers of this.listed) for (const held of layers.panels) this.folded.add(held.panel.id);
    this.again();
  }

  private again(): void {
    if (this.last) this.render(this.last.container, this.last.pages);
  }

  private bind(container: HTMLElement): ListPicker {
    const refs = (ids: string[]) => ids.map((id) => this.refs.get(id)).filter((ref): ref is LayerRef => !!ref);
    const keysOf = (list: LayerRef[]) =>
      list.flatMap((ref) => this.listed.flatMap((layers) => (layers.page.id === ref.pageId ? hiddenKeys(layers, ref) : [])));
    return new ListPicker(container, {
      noun: "レイヤー",
      ids: () => [...this.refs.keys()],
      open: (id) => {
        const ref = this.refs.get(id);
        if (ref) this.host.select(ref);
      },
      duplicate: () => this.host.act("duplicate"),
      remove: () => this.host.act("delete"),
      copy: () => this.host.act("copy"),
      cut: () => this.host.act("cut"),
      paste: () => this.host.act("paste"),
      canPaste: () => this.host.canPaste(),
      extra: (ids) => {
        const picked = refs(ids);
        const keys = keysOf(picked);
        const hidden = keys.length > 0 && keys.every((key) => this.host.hidden().has(key));
        const page = picked[0]?.pageId;
        const others = this.listed
          .filter((layers) => layers.page.id === page)
          .flatMap((layers) =>
            [...this.refs.values()]
              .filter((ref) => ref.pageId === page && !ids.includes(refKey(ref)))
              .flatMap((ref) => hiddenKeys(layers, ref)),
          )
          .filter((key) => !keys.includes(key));
        const panel = picked.length === 1 && picked[0].kind === "panel";
        return [
          { label: hidden ? "画面に出す" : "画面から隠す（書き出しには入ります）", run: () => this.host.setHidden(keys, !hidden) },
          {
            label: "ほかを隠す",
            title: "このページの、選んだもののほかを画面から隠す",
            disabled: !others.length,
            run: () => {
              this.host.setHidden(keys, false);
              this.host.setHidden(others, true);
            },
          },
          { label: "すべて出す", disabled: !this.host.hidden().size, run: () => this.host.setHidden([...this.host.hidden()], false) },
          ...(panel ? [{ label: "コマを中身ごと保留にする", run: () => this.host.act("hold") }] : []),
        ];
      },
      empty: () => [
        { label: "貼り付け", keys: "Ctrl+V", disabled: !this.host.canPaste(), run: () => this.host.act("paste") },
        { label: "すべて出す", disabled: !this.host.hidden().size, run: () => this.host.setHidden([...this.host.hidden()], false) },
      ],
      changed: () => {
        const picked = refs(this.picker?.targets() ?? []);
        if (picked.length > 1) this.host.selectMany(picked);
      },
    });
  }

  /** List the pages given (with their page numbers, 1-based). */
  render(container: HTMLElement, pages: { page: Page; number: number }[]): void {
    this.picker ??= this.bind(container);
    this.last = { container, pages };
    this.refs = new Map();
    this.listed = [];
    this.pending = [];
    const rows: HTMLElement[] = [this.toolbar()];
    const pageFormat = this.host.project()?.pageFormat;
    for (const { page, number } of pages) {
      const layers = pageLayers(page);
      this.listed.push(layers);
      const pageOpen = !this.folded.has(`page:${page.id}`);
      const pageHead = document.createElement("div");
      pageHead.className = "layer-page layer-folder";
      pageHead.append(
        this.foldButton(`page:${page.id}`, pageOpen, true),
        this.thumb(`page:${page.id}`, layers, { kind: "page", pageId: page.id }, pageFormat),
        Object.assign(document.createElement("span"), { className: "layer-name", textContent: `🗀 ${number} ページ` }),
        Object.assign(document.createElement("span"), {
          className: "layer-detail",
          textContent: `コマ ${layers.panels.length}・セリフ ${page.lines.length}`,
        }),
      );
      pageHead.addEventListener("click", () => this.toggle(`page:${page.id}`));
      rows.push(pageHead);
      if (!pageOpen) continue;
      for (const held of layers.panels) {
        const ref: LayerRef = { kind: "panel", pageId: page.id, id: held.panel.id };
        const count = held.lines.length + (held.strokes.length ? 1 : 0) + held.fills.length;
        const open = !this.folded.has(held.panel.id);
        const note = held.panel.note ? held.panel.note.split("\n")[0] : "";
        const inset = (held.panel.z ?? 0) > 0 ? "（はめ込み）" : "";
        rows.push(
          this.row(
            layers,
            ref,
            1,
            `🗀 コマ ${held.panel.order}${inset}`,
            note,
            this.foldButton(held.panel.id, open, count > 0),
            page.id,
            held.panel.id,
          ),
        );
        if (!open) continue;
        rows.push(...this.contents(layers, page, held, 2));
      }
      const outside = layers.outside;
      if (outside.lines.length || outside.strokes.length || outside.fills.length) {
        const key = `outside:${page.id}`;
        const open = !this.folded.has(key);
        const group = document.createElement("div");
        group.className = "layer-group layer-folder depth-1";
        group.append(
          this.foldButton(key, open, true),
          Object.assign(document.createElement("span"), { className: "layer-name", textContent: "🗀 コマの外" }),
        );
        group.addEventListener("click", () => this.toggle(key));
        rows.push(group);
        if (open) rows.push(...this.contents(layers, page, outside, 2));
      }
      for (const breakout of page.breakouts) {
        rows.push(this.row(layers, { kind: "breakout", pageId: page.id, id: breakout.id }, 1, "はみ出し", breakout.note ?? ""));
      }
      for (const sticky of page.stickies ?? []) {
        rows.push(this.row(layers, { kind: "sticky", pageId: page.id, id: sticky.id }, 1, "付箋", sticky.text.split("\n")[0]));
      }
      if (!page.panels.length && !page.lines.length && !page.strokes.length) {
        rows.push(Object.assign(document.createElement("div"), { className: "layer-empty", textContent: "まだ何もありません" }));
      }
    }
    rows.push(
      Object.assign(document.createElement("p"), {
        className: "hint layer-hint",
        textContent:
          "行を押すと選び（Ctrl・Shift で複数）、目で画面から隠します（書き出しには入ります）。▾ でページ・コマのフォルダーを開け閉め。右クリックで複製・コピー・ほかを隠す・削除。セリフ・ラフ線・塗りの行をコマの行へドラッグするとそのコマへ移し、コマをコマへドラッグすると中身を入れ替えます。",
      }),
    );
    container.classList.toggle("layer-thumbs-none", this.size === "none");
    container.classList.toggle("layer-thumbs-large", this.size === "large");
    container.replaceChildren(...rows);
    // The rows picked are what is selected on the page.
    const selected = [...this.refs.entries()].filter(([, ref]) => this.host.selected(ref)).map(([id]) => id);
    this.picker.pick(selected, false);
    for (const row of container.querySelectorAll<HTMLElement>("[data-list-id]"))
      row.classList.toggle("picked", selected.includes(row.dataset.listId ?? ""));
    // The pictures once the rows have their size (drawn only where something changed).
    const pending = this.pending;
    this.pending = [];
    if (pending.length)
      requestAnimationFrame(() => {
        for (const { canvas, part } of pending)
          if (canvas.isConnected) drawPartThumb(canvas, part.page, part.box, this.size === "large", part.ink);
      });
  }

  /** The buttons over the list: open or shut every folder, and the ミニビュー's size. */
  private toolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "layer-toolbar";
    const button = (text: string, title: string, run: () => void) => {
      const node = Object.assign(document.createElement("button"), { type: "button", textContent: text, title });
      node.addEventListener("click", run);
      return node;
    };
    const sizes = document.createElement("span");
    sizes.className = "segmented layer-thumb-size";
    sizes.title = "ミニビュー（行ごとの小さな絵）の大きさ";
    sizes.append(Object.assign(document.createElement("span"), { className: "layer-toolbar-label", textContent: "ミニビュー" }));
    for (const size of THUMB_SIZES) {
      const node = button(THUMB_LABELS[size], `ミニビュー: ${THUMB_LABELS[size]}`, () => this.setThumbSize(size));
      node.classList.toggle("active", size === this.size);
      node.setAttribute("aria-pressed", String(size === this.size));
      node.dataset.size = size;
      sizes.append(node);
    }
    bar.append(
      button("▾ すべて開く", "ページとコマのフォルダーを全部開く", () => this.foldAll(false)),
      button("▸ すべてたたむ", "コマのフォルダーを全部たたむ", () => this.foldAll(true)),
      sizes,
    );
    return bar;
  }

  private toggle(key: string): void {
    if (this.folded.has(key)) this.folded.delete(key);
    else this.folded.add(key);
    this.again();
  }

  private foldButton(key: string, open: boolean, enabled: boolean): HTMLElement {
    const fold = Object.assign(document.createElement("button"), {
      type: "button",
      className: "layer-fold",
      textContent: enabled ? (open ? "▾" : "▸") : "",
      title: open ? "たたむ" : "ひらく",
      disabled: !enabled,
    });
    fold.setAttribute("aria-expanded", String(open));
    fold.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggle(key);
    });
    fold.addEventListener("pointerdown", (event) => event.stopPropagation());
    return fold;
  }

  /** A row's ミニビュー (an empty slot when there is nothing to draw); drawn after the rows are in. */
  private thumb(key: string, layers: PageLayers, ref: ThumbRef, pageFormat?: Project["pageFormat"], ink?: string): HTMLElement {
    if (this.size === "none") return document.createElement("span");
    const part = ref.kind === "sticky" ? null : thumbPart(layers, ref, pageFormat);
    if (!part) {
      const slot = document.createElement("span");
      slot.className = "layer-thumb empty";
      if (ref.kind === "sticky") {
        const color = layers.page.stickies?.find((s) => s.id === ref.id)?.color ?? "yellow";
        slot.classList.add(`sticky-${color}`);
      }
      return slot;
    }
    if (ink) part.ink = ink;
    const sign = partSign(part, this.size);
    const kept = this.thumbs.get(key);
    if (kept && kept.sign === sign) return kept.canvas;
    const canvas = document.createElement("canvas");
    canvas.className = "layer-thumb";
    const [w, h] = THUMB_PX[this.size];
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    this.thumbs.set(key, { sign, canvas });
    this.pending.push({ canvas, part });
    return canvas;
  }

  private contents(
    layers: PageLayers,
    page: Page,
    held: { lines: string[]; strokes: string[]; fills: string[] },
    depth: number,
  ): HTMLElement[] {
    const rows: HTMLElement[] = [];
    for (const id of held.lines)
      rows.push(this.row(layers, { kind: "line", pageId: page.id, id }, depth, "セリフ", this.host.lineLabel(page, id)));
    const marks = held.strokes.filter((id) => this.host.isMark(page, id));
    const rough = held.strokes.filter((id) => !marks.includes(id));
    if (rough.length) rows.push(this.row(layers, { kind: "strokes", pageId: page.id, ids: rough }, depth, "ラフ線", `${rough.length} 本`));
    if (marks.length)
      rows.push(
        this.row(
          layers,
          { kind: "strokes", pageId: page.id, ids: marks },
          depth,
          "指示",
          `${marks.length} 本`,
          undefined,
          undefined,
          undefined,
          "#d23c3c",
        ),
      );
    for (const id of held.fills) {
      const tone = page.fills?.find((f) => f.id === id)?.tone ?? "black";
      rows.push(this.row(layers, { kind: "fill", pageId: page.id, id }, depth, "塗り", TONE_NAMES[tone] ?? tone));
    }
    return rows;
  }

  private row(
    layers: PageLayers,
    ref: LayerRef,
    depth: number,
    label: string,
    detail: string,
    lead?: HTMLElement,
    pageId?: string,
    panelId?: string,
    ink?: string,
  ): HTMLElement {
    const keys = hiddenKeys(layers, ref);
    const hidden = keys.length > 0 && keys.every((key) => this.host.hidden().has(key));
    const row = document.createElement("div");
    row.className = `layer-row depth-${depth}${this.host.selected(ref) ? " selected" : ""}${hidden ? " hidden-layer" : ""}${ref.kind === "panel" ? " layer-folder" : ""}`;
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
    const id = refKey(ref);
    const picture = this.thumb(id, layers, ref, undefined, ink);
    row.append(eye, ...(lead ? [lead] : [Object.assign(document.createElement("span"), { className: "layer-fold" })]), picture, name, more);
    this.refs.set(id, ref);
    this.picker?.row(row, id);
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

/** What a ミニビュー was drawn from, cheaply: drawn again only when this changes. */
function partSign(part: ThumbPart, size: ThumbSize): string {
  const { page } = part;
  const strokes = page.strokes.map((s) => {
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    return `${s.id}:${s.points.length}:${first?.[0]},${first?.[1]}:${last?.[0]},${last?.[1]}:${s.widthMm}:${s.brush ?? ""}`;
  });
  return JSON.stringify([size, part.box, part.ink, page.panels, page.lines, page.fills, page.breakouts, strokes]);
}

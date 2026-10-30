// 欄（パレット）: the lists beside the pages (サブツール・ページ・台本・人物・付箋・保留・レイヤー)
// and the inspector, as CSP's palettes: each can sit in the left or the right
// column, several open at once one above another, in any order, folded to
// their title or hidden to their icon. Their header is dragged to another
// place or column, the line between two drags their heights and a column's
// inner edge its width. The arrangement is kept for the next start.
import { localStore } from "./settings";

export type PaletteId = "subtools" | "pages" | "script" | "cast" | "notes" | "held" | "layers" | "series" | "inspector";
export type Side = "left" | "right";

export interface PaletteState {
  side: Side;
  /** In its column (else only its icon is). */
  shown: boolean;
  /** Only its title bar. */
  folded: boolean;
  /** Its share of the column's height among the open ones. */
  weight: number;
}

export interface DockLayout {
  /** Top to bottom, the two columns mixed. */
  order: PaletteId[];
  palettes: Record<PaletteId, PaletteState>;
  width: Record<Side, number>;
  /** The column folded to its icons. */
  collapsed: Record<Side, boolean>;
}

export interface PaletteDef {
  id: PaletteId;
  title: string;
  tip: string;
  /** SVG markup of its icon. */
  icon: string;
  /** What it shows (kept: it is moved into the palette). */
  body: HTMLElement;
  /** The id of its icon button (for the keyboard and the tests). */
  tabId: string;
}

export const DOCK_KEY = "namestudio.docks";
export const MIN_WIDTH = 200;
export const MAX_WIDTH = 640;

const PALETTE_IDS: PaletteId[] = ["subtools", "pages", "script", "cast", "notes", "held", "layers", "series", "inspector"];

export function defaultLayout(leftCollapsed = false): DockLayout {
  const left = (shown: boolean): PaletteState => ({ side: "left", shown, folded: false, weight: 1 });
  return {
    order: [...PALETTE_IDS],
    palettes: {
      subtools: left(true),
      pages: left(true),
      script: left(false),
      cast: left(false),
      notes: left(false),
      held: left(false),
      layers: left(false),
      series: left(false),
      inspector: { side: "right", shown: true, folded: false, weight: 1 },
    },
    width: { left: 280, right: 300 },
    collapsed: { left: leftCollapsed, right: false },
  };
}

/** The kept arrangement, with palettes added since then in their default place. */
export function readLayout(text: string | null, leftCollapsed = false): DockLayout {
  const base = defaultLayout(leftCollapsed);
  if (!text) return base;
  try {
    const saved = JSON.parse(text) as Partial<DockLayout>;
    const order = (saved.order ?? []).filter((id): id is PaletteId => PALETTE_IDS.includes(id as PaletteId));
    // One added since: before the one it comes before by default (サブツール above ページ).
    PALETTE_IDS.forEach((id, index) => {
      if (order.includes(id)) return;
      const next = PALETTE_IDS.slice(index + 1).find((other) => order.includes(other));
      order.splice(next ? order.indexOf(next) : order.length, 0, id);
    });
    const palettes = { ...base.palettes };
    for (const id of PALETTE_IDS) {
      const p = saved.palettes?.[id];
      if (!p) continue;
      palettes[id] = {
        side: p.side === "right" ? "right" : "left",
        shown: !!p.shown,
        folded: !!p.folded,
        weight: Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1,
      };
    }
    const width = (side: Side) => clampWidth(saved.width?.[side] ?? base.width[side]);
    return {
      order,
      palettes,
      width: { left: width("left"), right: width("right") },
      collapsed: { left: !!saved.collapsed?.left, right: !!saved.collapsed?.right },
    };
  } catch {
    return base;
  }
}

export function clampWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), MIN_WIDTH), MAX_WIDTH);
}

/** The palettes of a column, top to bottom. */
export function column(layout: DockLayout, side: Side): PaletteId[] {
  return layout.order.filter((id) => layout.palettes[id].side === side);
}

/** Put a palette in a column, before `before` (else at the bottom), shown and open. */
export function movePalette(layout: DockLayout, id: PaletteId, side: Side, before: PaletteId | null): void {
  if (before === id) return;
  layout.order = layout.order.filter((x) => x !== id);
  const at = before && layout.palettes[before].side === side ? layout.order.indexOf(before) : -1;
  if (at >= 0) layout.order.splice(at, 0, id);
  else {
    // At the bottom of the column: after its last palette.
    const last = [...layout.order].reverse().find((x) => layout.palettes[x].side === side);
    layout.order.splice(last ? layout.order.indexOf(last) + 1 : layout.order.length, 0, id);
  }
  Object.assign(layout.palettes[id], { side, shown: true, folded: false });
  layout.collapsed[side] = false;
}

/** Whether a palette's contents are on screen. */
export function isOpen(layout: DockLayout, id: PaletteId): boolean {
  const p = layout.palettes[id];
  return p.shown && !p.folded && !layout.collapsed[p.side];
}

const PALETTE_TYPE = "application/x-namestudio-palette";

const svg = (inner: string) => `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true">${inner}</svg>`;
const FOLD_ICON = svg('<path d="M5 8l5 5 5-5"/>');
const HIDE_ICON = svg('<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>');
const TO_LEFT_ICON = svg('<path d="M9 5l-5 5 5 5M4 10h12"/>');
const TO_RIGHT_ICON = svg('<path d="M11 5l5 5-5 5M16 10H4"/>');
const COLLAPSE_ICON = svg('<path d="M12.5 4l-6 6 6 6"/>');

export class Docks {
  layout: DockLayout;
  private readonly defs = new Map<PaletteId, PaletteDef>();
  private dragging: PaletteId | null = null;

  constructor(
    private readonly columns: Record<Side, HTMLElement>,
    defs: PaletteDef[],
    /** The palettes on screen changed: show what they hold. */
    private readonly changed: () => void,
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = localStore(),
    leftCollapsed = false,
  ) {
    for (const def of defs) this.defs.set(def.id, def);
    this.layout = readLayout(this.storage?.getItem(DOCK_KEY) ?? null, leftCollapsed);
    for (const side of ["left", "right"] as const) this.listen(side);
    this.render();
  }

  isOpen(id: PaletteId): boolean {
    return isOpen(this.layout, id);
  }

  /** Bring a palette into sight (its column open, it unfolded) and scroll to it. */
  open(id: PaletteId): void {
    const p = this.layout.palettes[id];
    Object.assign(p, { shown: true, folded: false });
    this.layout.collapsed[p.side] = false;
    this.commit();
    this.defs.get(id)?.body.closest(".palette")?.scrollIntoView({ block: "nearest" });
  }

  /** Its icon: show it, or (shown) hide it; in a folded column, open the column with it. */
  toggle(id: PaletteId): void {
    const p = this.layout.palettes[id];
    if (this.layout.collapsed[p.side]) {
      this.layout.collapsed[p.side] = false;
      Object.assign(p, { shown: true, folded: false });
    } else if (p.shown && p.folded) p.folded = false;
    else p.shown = !p.shown;
    this.commit();
  }

  collapse(side: Side, collapsed = !this.layout.collapsed[side]): void {
    this.layout.collapsed[side] = collapsed;
    this.commit();
  }

  private commit(): void {
    try {
      this.storage?.setItem(DOCK_KEY, JSON.stringify(this.layout));
    } catch {
      // Not kept for the next start; the arrangement still holds now.
    }
    this.render();
    this.changed();
  }

  render(): void {
    for (const side of ["left", "right"] as const) this.renderColumn(side);
  }

  private renderColumn(side: Side): void {
    const dock = this.columns[side];
    const ids = column(this.layout, side);
    const shown = ids.filter((id) => this.layout.palettes[id].shown);
    const narrow = this.layout.collapsed[side] || !shown.length;
    dock.classList.toggle("narrow", narrow);
    dock.style.width = narrow ? "" : `${this.layout.width[side]}px`;

    const rail = document.createElement("div");
    rail.className = "dock-rail";
    rail.setAttribute("role", "toolbar");
    for (const id of ids) {
      const def = this.defs.get(id);
      if (!def) continue;
      const button = document.createElement("button");
      button.id = def.tabId;
      button.title = `${def.tip}（もう一度で隠す。見出しをドラッグで左右・上下へ）`;
      button.innerHTML = `${def.icon}<span>${def.title}</span>`;
      button.classList.toggle("active", !narrow && this.layout.palettes[id].shown);
      button.addEventListener("click", () => this.toggle(id));
      rail.append(button);
    }
    const fold = document.createElement("button");
    fold.className = "dock-collapse";
    fold.id = side === "left" ? "side-collapse" : "dock-collapse-right";
    fold.title = this.layout.collapsed[side] ? "この欄を広げる" : "この欄をたたむ（アイコンだけに）";
    fold.innerHTML = COLLAPSE_ICON;
    fold.addEventListener("click", () => this.collapse(side, !narrow));
    if (shown.length || this.layout.collapsed[side]) rail.append(fold);

    const stack = document.createElement("div");
    stack.className = "dock-stack";
    if (!narrow) {
      shown.forEach((id, i) => {
        const def = this.defs.get(id);
        if (!def) return;
        const prev = shown[i - 1];
        if (prev && !this.layout.palettes[prev].folded && !this.layout.palettes[id].folded) stack.append(this.splitter(prev, id));
        stack.append(this.palette(def, side));
      });
    }
    // Bodies of palettes not on screen wait here, so that they stay in the page.
    const parked = document.createElement("div");
    parked.hidden = true;
    for (const id of ids) {
      const def = this.defs.get(id);
      if (def && (narrow || !this.layout.palettes[id].shown)) parked.append(def.body);
    }
    const resize = document.createElement("div");
    resize.className = "dock-resize";
    resize.title = "ドラッグで欄の幅を変える";
    resize.hidden = narrow;
    this.resizer(resize, side);
    dock.replaceChildren(rail, stack, parked, resize);
  }

  private palette(def: PaletteDef, side: Side): HTMLElement {
    const state = this.layout.palettes[def.id];
    const section = document.createElement("section");
    section.className = "palette";
    section.dataset.palette = def.id;
    section.classList.toggle("folded", state.folded);
    section.style.flex = state.folded ? "0 0 auto" : `${state.weight} 1 0`;
    const head = document.createElement("header");
    head.draggable = true;
    head.title = "ドラッグで別の場所・反対側の欄へ。ダブルクリックでたたむ";
    head.innerHTML = `${def.icon}<span class="palette-title">${def.title}</span>`;
    const button = (icon: string, title: string, action: () => void) => {
      const b = document.createElement("button");
      b.className = "icon-button";
      b.innerHTML = icon;
      b.title = title;
      b.addEventListener("click", (event) => {
        event.stopPropagation();
        action();
      });
      return b;
    };
    const other: Side = side === "left" ? "right" : "left";
    const fold = button(FOLD_ICON, state.folded ? "広げる" : "たたむ（見出しだけに）", () => {
      state.folded = !state.folded;
      this.commit();
    });
    fold.classList.add("palette-fold");
    head.append(
      fold,
      button(side === "left" ? TO_RIGHT_ICON : TO_LEFT_ICON, `${other === "left" ? "左" : "右"}の欄へ移す`, () => {
        movePalette(this.layout, def.id, other, null);
        this.commit();
      }),
      button(HIDE_ICON, "隠す（欄の上のアイコンでまた出す）", () => {
        state.shown = false;
        this.commit();
      }),
    );
    head.addEventListener("dblclick", () => {
      state.folded = !state.folded;
      this.commit();
    });
    head.addEventListener("dragstart", (event) => {
      this.dragging = def.id;
      event.dataTransfer?.setData(PALETTE_TYPE, def.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      for (const dock of Object.values(this.columns)) dock.classList.add("palette-dragging");
    });
    head.addEventListener("dragend", () => this.endDrag());
    const body = document.createElement("div");
    body.className = "palette-body";
    body.hidden = state.folded;
    body.append(def.body);
    section.append(head, body);
    return section;
  }

  /** The line between two open palettes: drag to share the height differently. */
  private splitter(above: PaletteId, below: PaletteId): HTMLElement {
    const line = document.createElement("div");
    line.className = "dock-splitter";
    line.title = "ドラッグで高さを分け直す";
    line.addEventListener("pointerdown", (event) => {
      const a = line.previousElementSibling as HTMLElement | null;
      const b = line.nextElementSibling as HTMLElement | null;
      if (!a || !b) return;
      event.preventDefault();
      line.setPointerCapture(event.pointerId);
      const [ha, hb] = [a.getBoundingClientRect().height, b.getBoundingClientRect().height];
      const pa = this.layout.palettes[above];
      const pb = this.layout.palettes[below];
      const total = pa.weight + pb.weight;
      const start = event.clientY;
      const move = (e: PointerEvent) => {
        const d = Math.min(Math.max(e.clientY - start, 60 - ha), hb - 60);
        pa.weight = (total * (ha + d)) / (ha + hb);
        pb.weight = total - pa.weight;
        a.style.flex = `${pa.weight} 1 0`;
        b.style.flex = `${pb.weight} 1 0`;
      };
      const up = () => {
        line.removeEventListener("pointermove", move);
        line.removeEventListener("pointerup", up);
        line.removeEventListener("pointercancel", up);
        this.commit();
      };
      line.addEventListener("pointermove", move);
      line.addEventListener("pointerup", up);
      line.addEventListener("pointercancel", up);
    });
    return line;
  }

  /** The column's inner edge: drag to make it wider or narrower. */
  private resizer(handle: HTMLElement, side: Side): void {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const start = event.clientX;
      const width = this.layout.width[side];
      const dock = this.columns[side];
      const move = (e: PointerEvent) => {
        const d = side === "left" ? e.clientX - start : start - e.clientX;
        this.layout.width[side] = clampWidth(width + d);
        dock.style.width = `${this.layout.width[side]}px`;
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        this.commit();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  /** A palette's header dragged over a column: where it would go, marked; dropped, it goes there. */
  private listen(side: Side): void {
    const dock = this.columns[side];
    const target = (event: DragEvent): PaletteId | null => {
      const sections = [...dock.querySelectorAll<HTMLElement>(".dock-stack > .palette")];
      const next = sections.find((section) => {
        const box = section.getBoundingClientRect();
        return event.clientY < box.top + box.height / 2;
      });
      return (next?.dataset.palette as PaletteId | undefined) ?? null;
    };
    const mark = (before: PaletteId | null) => {
      dock.classList.add("drop-target");
      for (const section of dock.querySelectorAll<HTMLElement>(".palette")) section.classList.toggle("drop-before", section.dataset.palette === before);
      dock.querySelector(".dock-stack")?.classList.toggle("drop-end", before === null);
    };
    dock.addEventListener("dragover", (event) => {
      if (!this.dragging && !event.dataTransfer?.types.includes(PALETTE_TYPE)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      mark(target(event));
    });
    dock.addEventListener("dragleave", (event) => {
      if (!dock.contains(event.relatedTarget as Node | null)) this.clearMarks(dock);
    });
    dock.addEventListener("drop", (event) => {
      const id = (event.dataTransfer?.getData(PALETTE_TYPE) || this.dragging) as PaletteId | null;
      if (!id || !this.defs.has(id)) return;
      event.preventDefault();
      const before = target(event);
      this.endDrag();
      movePalette(this.layout, id, side, before);
      this.commit();
    });
  }

  private clearMarks(dock: HTMLElement): void {
    dock.classList.remove("drop-target");
    for (const section of dock.querySelectorAll(".drop-before")) section.classList.remove("drop-before");
    dock.querySelector(".dock-stack")?.classList.remove("drop-end");
  }

  private endDrag(): void {
    this.dragging = null;
    for (const dock of Object.values(this.columns)) {
      dock.classList.remove("palette-dragging");
      this.clearMarks(dock);
    }
  }
}

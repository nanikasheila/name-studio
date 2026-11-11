// 欄（パレット）: the lists beside the pages (サブツール・ツールプロパティ・ページ・
// 台本・人物・付箋・保留・レイヤー…) and the inspector, as CSP's palettes. Each
// side has up to three columns; in a column the palettes stand one above
// another, or several share a frame as tabs; one can float over the pages.
// A palette's header (or its tab) is dragged: onto a column (there), onto a
// column's edge (a new column), onto another palette's header (a tab of it)
// or onto the pages (floating there). Its ≡ menu does the same by name. The
// line between two drags their heights, a column's inner edge its width;
// a palette can instead be as tall as what it holds. The icons by the window's
// edge show and hide them. The arrangement is kept for the next start.
import { localStore } from "../platform/settings";
import {
  canAddColumn,
  clampWidth,
  column,
  columnsOf,
  defaultLayout,
  detach,
  dockPalette,
  floatPalette,
  floating,
  frameKey,
  frames,
  isOpen,
  joinTab,
  MAX_COLUMNS,
  movePalette,
  placePalette,
  readLayout,
  showTab,
  tidy,
  widthOf,
  type DockLayout,
  type FloatRect,
  type Frame,
  type PaletteId,
  type Place,
  type Side,
} from "../editing/docklayout";
import { openMenu, SEPARATOR, type MenuItem } from "./popupmenu";

export { clampWidth, column, defaultLayout, isOpen, movePalette, readLayout, MAX_COLUMNS };
export type { DockLayout, PaletteId, Side };

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

const PALETTE_TYPE = "application/x-namestudio-palette";
/** How near a column's edge a drop makes a new column (px). */
const EDGE = 18;
/** A floating palette's size when it first floats. */
const FLOAT_SIZE = { w: 280, h: 360 };

const svg = (inner: string) => `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true">${inner}</svg>`;
const FOLD_ICON = svg('<path d="M5 8l5 5 5-5"/>');
const HIDE_ICON = svg('<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>');
const MENU_ICON = svg('<path d="M4 6h12M4 10h12M4 14h12"/>');
const COLLAPSE_ICON = svg('<path d="M12.5 4l-6 6 6 6"/>');

/** Where a drag would put the palette. */
type Drop = { kind: "place"; place: Place } | { kind: "tab"; with: PaletteId } | { kind: "float"; rect: FloatRect };

export class Docks {
  layout: DockLayout;
  private readonly defs = new Map<PaletteId, PaletteDef>();
  private dragging: PaletteId | null = null;
  private readonly floats: HTMLElement;
  private saveSoon = 0;

  constructor(
    private readonly sides: Record<Side, HTMLElement>,
    defs: PaletteDef[],
    /** The palettes on screen changed: show what they hold. */
    private readonly changed: () => void,
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = localStore(),
    leftCollapsed = false,
    /** Where a palette dropped floats (the pages); none: palettes do not float. */
    private readonly floatArea: HTMLElement | null = null,
  ) {
    for (const def of defs) this.defs.set(def.id, def);
    this.layout = readLayout(this.storage?.getItem(DOCK_KEY) ?? null, leftCollapsed);
    this.floats = document.createElement("div");
    this.floats.className = "dock-floats";
    this.floats.id = "dock-floats";
    (sides.left.parentElement ?? document.body).append(this.floats);
    for (const side of ["left", "right"] as const) this.listen(sides[side], side);
    if (floatArea) this.listenFloat(floatArea);
    this.render();
  }

  isOpen(id: PaletteId): boolean {
    return isOpen(this.layout, id);
  }

  /** Bring a palette into sight (its side open, it unfolded and in front) and scroll to it. */
  open(id: PaletteId): void {
    const p = this.layout.palettes[id];
    p.shown = true;
    this.layout.palettes[frameKey(this.layout, id)].folded = false;
    showTab(this.layout, id);
    if (!p.float) this.layout.collapsed[p.side] = false;
    this.commit();
    this.sectionOf(id)?.scrollIntoView({ block: "nearest" });
  }

  /** Its icon: show it, or (shown) hide it; in a folded side, open the side with it. */
  toggle(id: PaletteId): void {
    const p = this.layout.palettes[id];
    const lead = this.layout.palettes[frameKey(this.layout, id)];
    if (!p.float && this.layout.collapsed[p.side]) {
      this.layout.collapsed[p.side] = false;
      p.shown = true;
      lead.folded = false;
      showTab(this.layout, id);
    } else if (p.shown && (lead.folded || !this.isOpen(id))) {
      // Folded, or a tab behind another: to the front.
      lead.folded = false;
      showTab(this.layout, id);
    } else p.shown = !p.shown;
    this.commit();
  }

  /** Put every palette as `layout` has them (作業の配置). */
  apply(layout: DockLayout): void {
    this.layout = readLayout(JSON.stringify(layout));
    this.commit();
  }

  collapse(side: Side, collapsed = !this.layout.collapsed[side]): void {
    this.layout.collapsed[side] = collapsed;
    this.commit();
  }

  private commit(): void {
    tidy(this.layout);
    this.save();
    this.render();
    this.changed();
  }

  private save(): void {
    try {
      this.storage?.setItem(DOCK_KEY, JSON.stringify(this.layout));
    } catch {
      // Not kept for the next start; the arrangement still holds now.
    }
  }

  private sectionOf(id: PaletteId): HTMLElement | null {
    return this.defs.get(id)?.body.closest<HTMLElement>(".palette") ?? null;
  }

  render(): void {
    this.placed.clear();
    this.renderFloats();
    for (const side of ["left", "right"] as const) this.renderSide(side);
  }

  private renderSide(side: Side): void {
    const dock = this.sides[side];
    const ids = column(this.layout, side);
    const cols = columnsOf(this.layout, side);
    const narrow = this.layout.collapsed[side] || !cols.length;
    dock.classList.toggle("narrow", narrow);
    dock.dataset.columns = String(narrow ? 0 : cols.length);

    const rail = document.createElement("div");
    rail.className = "dock-rail";
    rail.setAttribute("role", "toolbar");
    rail.setAttribute("aria-label", side === "left" ? "左の欄のアイコン" : "右の欄のアイコン");
    for (const id of ids) {
      const def = this.defs.get(id);
      if (!def) continue;
      const p = this.layout.palettes[id];
      const button = document.createElement("button");
      button.id = def.tabId;
      button.title = `${def.title}: ${def.tip}（もう一度で隠す。見出しをドラッグで別の列・タブ・紙面の上へ）`;
      button.setAttribute("aria-label", def.title);
      button.innerHTML = `${def.icon}<span>${def.title}</span>`;
      button.classList.toggle("active", p.shown && (!!p.float || !narrow));
      button.classList.toggle("floating", !!p.float);
      button.addEventListener("click", () => this.toggle(id));
      rail.append(button);
    }
    const fold = document.createElement("button");
    fold.className = "dock-collapse";
    fold.id = side === "left" ? "side-collapse" : "dock-collapse-right";
    fold.title = this.layout.collapsed[side] ? "この欄を広げる" : "この欄をたたむ（アイコンだけに）";
    fold.innerHTML = COLLAPSE_ICON;
    fold.addEventListener("click", () => this.collapse(side, !narrow));
    if (cols.length || this.layout.collapsed[side]) rail.append(fold);

    const columns = document.createElement("div");
    columns.className = "dock-cols";
    if (!narrow) {
      for (const col of cols) columns.append(this.renderColumn(side, col));
    }
    // Bodies of palettes not on screen wait here, so that they stay in the page.
    const parked = document.createElement("div");
    parked.hidden = true;
    dock.replaceChildren(rail, columns, parked);
    for (const id of ids) {
      const def = this.defs.get(id);
      if (def && !this.placed.has(id)) parked.append(def.body);
    }
  }

  /** Bodies put in a frame in this render (the others are parked). */
  private placed = new Set<PaletteId>();

  private renderColumn(side: Side, col: number): HTMLElement {
    const box = document.createElement("div");
    box.className = "dock-col";
    box.dataset.col = String(col);
    box.style.width = `${widthOf(this.layout, side, col)}px`;
    const stack = document.createElement("div");
    stack.className = "dock-stack";
    const list = frames(this.layout, side, col);
    list.forEach((frame, i) => {
      const prev = list[i - 1];
      if (prev && !this.layout.palettes[prev.lead].folded && !this.layout.palettes[frame.lead].folded)
        stack.append(this.splitter(prev.lead, frame.lead));
      stack.append(this.frame(frame));
    });
    const resize = document.createElement("div");
    resize.className = "dock-resize";
    resize.title = "ドラッグで列の幅を変える";
    this.resizer(resize, side, col, box);
    box.append(stack, resize);
    return box;
  }

  private renderFloats(): void {
    const sections: HTMLElement[] = [];
    for (const id of floating(this.layout)) {
      const p = this.layout.palettes[id];
      const def = this.defs.get(id);
      if (!def || !p.float) continue;
      const section = this.frame({ lead: id, members: [id], front: id }, true);
      const r = this.clampRect(p.float);
      Object.assign(section.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: p.folded ? "" : `${r.h}px` });
      sections.push(section);
    }
    this.floats.replaceChildren(...sections);
  }

  /** Inside the window (a floating palette's header stays in reach). */
  private clampRect(r: FloatRect): FloatRect {
    const w = Math.min(r.w, window.innerWidth - 16);
    const h = Math.min(r.h, window.innerHeight - 40);
    return {
      x: Math.max(0, Math.min(r.x, window.innerWidth - Math.min(w, 120))),
      y: Math.max(0, Math.min(r.y, window.innerHeight - 32)),
      w,
      h,
    };
  }

  private button(icon: string, title: string, action: (event: MouseEvent) => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "icon-button";
    b.innerHTML = icon;
    b.title = title;
    b.setAttribute("aria-label", title.replace(/（.*$/, ""));
    b.addEventListener("pointerdown", (event) => event.stopPropagation());
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      action(event);
    });
    return b;
  }

  /** A frame: its header (title, or tabs), its buttons, and the body of the tab in front. */
  private frame(frame: Frame, floats = false): HTMLElement {
    const lead = this.layout.palettes[frame.lead];
    const front = this.defs.get(frame.front);
    const section = document.createElement("section");
    section.className = "palette";
    section.dataset.palette = frame.front;
    section.dataset.lead = frame.lead;
    section.classList.toggle("folded", lead.folded);
    section.classList.toggle("fit", lead.fit && !lead.folded);
    section.classList.toggle("tabbed", frame.members.length > 1);
    section.classList.toggle("floating", floats);
    if (!floats) section.style.flex = lead.folded ? "0 0 auto" : lead.fit ? "0 1 auto" : `${lead.weight} 1 0`;
    const head = document.createElement("header");
    head.title = floats
      ? "ドラッグで動かす（欄の上で離すとそこへ）。ダブルクリックでたたむ"
      : "ドラッグで別の場所・別の列・ほかの欄のタブ・紙面の上へ。ダブルクリックでたたむ";
    const titles = document.createElement("div");
    titles.className = "palette-tabs";
    titles.setAttribute("role", frame.members.length > 1 ? "tablist" : "presentation");
    for (const id of frame.members) {
      const def = this.defs.get(id);
      if (!def) continue;
      const tab = document.createElement(frame.members.length > 1 ? "button" : "span");
      tab.className = `palette-tab${id === frame.front ? " front" : ""}`;
      tab.dataset.palette = id;
      tab.innerHTML = `${def.icon}<span class="palette-title">${def.title}</span>`;
      if (tab instanceof HTMLButtonElement) {
        tab.type = "button";
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(id === frame.front));
        tab.title = `${def.title}（ドラッグで外す・別の場所へ）`;
        tab.addEventListener("click", () => {
          showTab(this.layout, id);
          if (lead.folded) lead.folded = false;
          this.commit();
        });
      }
      if (!floats) this.dragSource(tab, id);
      titles.append(tab);
    }
    if (!floats) this.dragSource(head, frame.front);
    else this.floatMover(head, frame.front, section);
    const fold = this.button(FOLD_ICON, lead.folded ? "広げる" : "たたむ（見出しだけに）", () => {
      lead.folded = !lead.folded;
      this.commit();
    });
    fold.classList.add("palette-fold");
    const menu = this.button(MENU_ICON, "この欄のメニュー（たたむ・高さ・列・タブ・浮かせる・隠す）", (event) =>
      this.menu(frame.front, event.clientX, event.clientY),
    );
    menu.classList.add("palette-menu");
    const hide = this.button(HIDE_ICON, "隠す（欄の端のアイコンでまた出す）", () => {
      this.layout.palettes[frame.front].shown = false;
      this.commit();
    });
    head.append(titles, fold, menu, hide);
    head.addEventListener("dblclick", (event) => {
      if ((event.target as HTMLElement).closest("button.icon-button")) return;
      lead.folded = !lead.folded;
      this.commit();
    });
    head.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const tab = (event.target as HTMLElement).closest<HTMLElement>(".palette-tab");
      this.menu((tab?.dataset.palette as PaletteId | undefined) ?? frame.front, event.clientX, event.clientY);
    });
    const body = document.createElement("div");
    body.className = "palette-body";
    body.hidden = lead.folded;
    if (front) {
      body.append(front.body);
      this.placed.add(frame.front);
    }
    section.append(head, body);
    if (floats && !lead.folded) this.watchSize(section, frame.front);
    return section;
  }

  /** The ≡ menu (and a right click on the header): the same moves as the drags, by name. */
  private menu(id: PaletteId, x: number, y: number): void {
    const p = this.layout.palettes[id];
    const lead = this.layout.palettes[frameKey(this.layout, id)];
    const other: Side = p.side === "left" ? "right" : "left";
    const sideName = (side: Side) => (side === "left" ? "左" : "右");
    const inTabs = !!p.tab || this.layout.order.some((x) => this.layout.palettes[x].tab === id && this.layout.palettes[x].shown);
    const cols = columnsOf(this.layout, p.side);
    const items: (MenuItem | typeof SEPARATOR)[] = [
      { label: lead.folded ? "広げる" : "たたむ", run: () => ((lead.folded = !lead.folded), this.commit()) },
      {
        label: lead.fit ? "高さを列に合わせて分ける" : "高さを中身に合わせる",
        title: lead.fit ? "列の高さをほかの欄と分け合う（間の線のドラッグで変えられる）" : "中身の高さだけ取る（列が足りなければ縮む）",
        disabled: !!p.float,
        run: () => ((lead.fit = !lead.fit), this.commit()),
      },
      SEPARATOR,
      {
        label: `${sideName(p.side)}に新しい列を作って移す`,
        title: `この欄だけの列を${sideName(p.side)}側の内側に足す（最大 ${MAX_COLUMNS} 列）`,
        disabled: !canAddColumn(this.layout, p.side) || (!p.float && !p.tab && frames(this.layout, p.side, p.col).length <= 1),
        run: () => this.place(id, { side: p.side, col: cols.length, newColumn: true }),
      },
      { label: `${sideName(other)}の欄へ移す`, run: () => (movePalette(this.layout, id, other, null), this.commit()) },
      ...(inTabs ? [{ label: "タブから外す", run: () => this.place(id, { side: p.side, col: p.col, before: null }) }] : []),
      p.float
        ? { label: "欄に戻す", run: () => (dockPalette(this.layout, id), this.commit()) }
        : {
            label: "浮かせる（紙面の上に）",
            disabled: !this.floatArea,
            run: () => {
              const box = this.sectionOf(id)?.getBoundingClientRect();
              const area = this.floatArea?.getBoundingClientRect();
              const x = area ? area.left + 24 : (box?.left ?? 100);
              const yy = area ? area.top + 24 : (box?.top ?? 100);
              floatPalette(this.layout, id, { x, y: yy, w: FLOAT_SIZE.w, h: Math.round(box?.height ?? FLOAT_SIZE.h) || FLOAT_SIZE.h });
              this.commit();
            },
          },
      SEPARATOR,
      { label: "隠す", run: () => ((p.shown = false), this.commit()) },
    ];
    openMenu(items, x, y, `${this.defs.get(id)?.title ?? ""}の欄のメニュー`);
  }

  private place(id: PaletteId, place: Place): void {
    placePalette(this.layout, id, place);
    this.commit();
  }

  /** A header or tab dragged: where it can go is marked while it moves. */
  private dragSource(node: HTMLElement, id: PaletteId): void {
    node.draggable = true;
    node.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      this.dragging = id;
      event.dataTransfer?.setData(PALETTE_TYPE, id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      document.body.classList.add("palette-dragging");
    });
    node.addEventListener("dragend", () => this.endDrag());
  }

  /** Where a palette dragged to (x, y) over a side goes. */
  private dropAt(side: Side, x: number, y: number, target: EventTarget | null, id: PaletteId): Drop | null {
    const dock = this.sides[side];
    // Over another frame's header: a tab of it.
    const head = (target instanceof Element ? target : null)?.closest<HTMLElement>(".palette > header");
    const section = head?.parentElement;
    if (head && section && dock.contains(head)) {
      const lead = section.dataset.lead as PaletteId;
      if (frameKey(this.layout, id) !== lead || this.layout.palettes[id].tab) return { kind: "tab", with: lead };
    }
    const cols = [...dock.querySelectorAll<HTMLElement>(".dock-col")];
    if (!cols.length) return { kind: "place", place: { side, col: 0, newColumn: true } };
    // The column under the pointer (beyond the last: the innermost; by the rail: the outermost).
    const boxes = cols.map((c) => c.getBoundingClientRect());
    let index = boxes.findIndex((b) => x >= b.left && x <= b.right);
    if (index < 0) {
      const inner = side === "left" ? x > boxes[boxes.length - 1].right : x < boxes[boxes.length - 1].left;
      index = inner ? cols.length - 1 : 0;
    }
    const box = boxes[index];
    const col = Number(cols[index].dataset.col);
    const outerEdge = side === "left" ? x - box.left : box.right - x;
    const innerEdge = side === "left" ? box.right - x : x - box.left;
    if (canAddColumn(this.layout, side)) {
      if (outerEdge >= 0 && outerEdge < EDGE) return { kind: "place", place: { side, col, newColumn: true } };
      if (innerEdge >= 0 && innerEdge < EDGE) return { kind: "place", place: { side, col: col + 1, newColumn: true } };
    }
    const sections = [...cols[index].querySelectorAll<HTMLElement>(".dock-stack > .palette")];
    const next = sections.find((s) => {
      const b = s.getBoundingClientRect();
      return y < b.top + b.height / 2;
    });
    return { kind: "place", place: { side, col, before: (next?.dataset.lead as PaletteId | undefined) ?? null } };
  }

  /** The mark of where the drop goes. */
  private mark(drop: Drop | null): void {
    this.clearMarks();
    if (!drop) return;
    if (drop.kind === "tab") {
      document.querySelector(`.palette[data-lead="${drop.with}"]`)?.classList.add("drop-tab");
      return;
    }
    if (drop.kind === "float") {
      this.floatArea?.classList.add("palette-float-target");
      return;
    }
    const { side, col, newColumn, before } = drop.place;
    const dock = this.sides[side];
    dock.classList.add("drop-target");
    const cols = [...dock.querySelectorAll<HTMLElement>(".dock-col")];
    if (newColumn) {
      const at = cols[Math.min(col, cols.length - 1)];
      if (!at) return;
      at.classList.add(col >= cols.length ? "drop-col-inner" : "drop-col-outer");
      return;
    }
    const box = cols.find((c) => Number(c.dataset.col) === col);
    if (before) box?.querySelector(`.palette[data-lead="${before}"]`)?.classList.add("drop-before");
    else box?.querySelector(".dock-stack")?.classList.add("drop-end");
  }

  private clearMarks(): void {
    for (const node of document.querySelectorAll(
      ".drop-target, .drop-before, .drop-end, .drop-tab, .drop-col-inner, .drop-col-outer, .palette-float-target",
    ))
      node.classList.remove(
        "drop-target",
        "drop-before",
        "drop-end",
        "drop-tab",
        "drop-col-inner",
        "drop-col-outer",
        "palette-float-target",
      );
  }

  private applyDrop(drop: Drop, id: PaletteId): void {
    if (drop.kind === "tab") joinTab(this.layout, id, drop.with);
    else if (drop.kind === "float") floatPalette(this.layout, id, drop.rect);
    else placePalette(this.layout, id, drop.place);
    this.commit();
  }

  /** A palette's header dragged over a side: where it would go, marked; dropped, it goes there. */
  private listen(dock: HTMLElement, side: Side): void {
    dock.addEventListener("dragover", (event) => {
      const id = this.dragging;
      if (!id && !event.dataTransfer?.types.includes(PALETTE_TYPE)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      if (id) this.mark(this.dropAt(side, event.clientX, event.clientY, event.target, id));
    });
    dock.addEventListener("dragleave", (event) => {
      if (!dock.contains(event.relatedTarget as Node | null)) this.clearMarks();
    });
    dock.addEventListener("drop", (event) => {
      const id = (event.dataTransfer?.getData(PALETTE_TYPE) || this.dragging) as PaletteId | null;
      if (!id || !this.defs.has(id)) return;
      event.preventDefault();
      const drop = this.dropAt(side, event.clientX, event.clientY, event.target, id);
      this.endDrag();
      if (drop) this.applyDrop(drop, id);
    });
  }

  /** Over the pages: the palette floats where it is dropped. */
  private listenFloat(area: HTMLElement): void {
    const rect = (event: DragEvent): FloatRect => ({ x: event.clientX - 60, y: event.clientY - 14, ...FLOAT_SIZE });
    area.addEventListener("dragover", (event) => {
      if (!this.dragging) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      this.mark({ kind: "float", rect: rect(event) });
    });
    area.addEventListener("dragleave", (event) => {
      if (!area.contains(event.relatedTarget as Node | null)) this.clearMarks();
    });
    area.addEventListener("drop", (event) => {
      const id = this.dragging;
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      this.endDrag();
      this.applyDrop({ kind: "float", rect: rect(event) }, id);
    });
  }

  /** A floating palette's header: dragged, it moves; let go over a side, it goes into it there. */
  private floatMover(head: HTMLElement, id: PaletteId, section: HTMLElement): void {
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      head.setPointerCapture(event.pointerId);
      const box = section.getBoundingClientRect();
      const dx = event.clientX - box.left;
      const dy = event.clientY - box.top;
      let moved = false;
      const over = (e: PointerEvent): Drop | null => {
        const below = document.elementsFromPoint(e.clientX, e.clientY).find((node) => !section.contains(node)) ?? null;
        for (const side of ["left", "right"] as const)
          if (below && this.sides[side].contains(below)) return this.dropAt(side, e.clientX, e.clientY, below, id);
        return null;
      };
      const move = (e: PointerEvent) => {
        moved = true;
        section.style.left = `${e.clientX - dx}px`;
        section.style.top = `${e.clientY - dy}px`;
        this.mark(over(e));
      };
      const up = (e: PointerEvent) => {
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", up);
        head.removeEventListener("pointercancel", up);
        const drop = moved ? over(e) : null;
        this.clearMarks();
        if (!moved) return;
        if (drop) {
          this.applyDrop(drop, id);
          return;
        }
        const p = this.layout.palettes[id];
        if (p.float) {
          p.float = { ...p.float, x: Math.round(e.clientX - dx), y: Math.round(e.clientY - dy) };
          // On top of the others.
          this.layout.order = [...this.layout.order.filter((x) => x !== id), id];
          this.commit();
        }
      };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", up);
      head.addEventListener("pointercancel", up);
    });
  }

  /** A floating palette's size, kept as it is resized by its corner. */
  private watchSize(section: HTMLElement, id: PaletteId): void {
    if (typeof ResizeObserver === "undefined") return;
    let first = true;
    const observer = new ResizeObserver(() => {
      // The first call is its size as drawn.
      if (first) {
        first = false;
        return;
      }
      if (!section.isConnected) {
        observer.disconnect();
        return;
      }
      const p = this.layout.palettes[id];
      if (!p.float) return;
      p.float = { ...p.float, w: Math.round(section.offsetWidth), h: Math.round(section.offsetHeight) };
      clearTimeout(this.saveSoon);
      this.saveSoon = window.setTimeout(() => this.save(), 300);
    });
    observer.observe(section);
  }

  /** The line between two frames: drag to share the height differently (one as tall as it holds starts to share). */
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
      // Pixels a weight is worth now (from another frame that shares), so that the others keep their height.
      const stack = line.parentElement;
      const sharing = [...(stack?.querySelectorAll<HTMLElement>(":scope > .palette:not(.fit):not(.folded)") ?? [])].find(
        (s) => s !== a && s !== b,
      );
      const unit = sharing ? sharing.getBoundingClientRect().height / this.layout.palettes[sharing.dataset.lead as PaletteId].weight : 100;
      for (const [p, h] of [
        [pa, ha],
        [pb, hb],
      ] as const) {
        if (p.fit) Object.assign(p, { fit: false, weight: Math.max(0.05, h / unit) });
      }
      a.classList.remove("fit");
      b.classList.remove("fit");
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
    line.addEventListener("dblclick", () => {
      // Back to as tall as it holds.
      this.layout.palettes[above].fit = true;
      this.commit();
    });
    return line;
  }

  /** A column's inner edge: drag to make it wider or narrower. */
  private resizer(handle: HTMLElement, side: Side, col: number, box: HTMLElement): void {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const start = event.clientX;
      const width = widthOf(this.layout, side, col);
      const move = (e: PointerEvent) => {
        const d = side === "left" ? e.clientX - start : start - e.clientX;
        this.layout.widths[side][col] = clampWidth(width + d);
        box.style.width = `${this.layout.widths[side][col]}px`;
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

  private endDrag(): void {
    this.dragging = null;
    document.body.classList.remove("palette-dragging");
    this.clearMarks();
  }
}

export { detach };

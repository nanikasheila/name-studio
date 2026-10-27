// 使い方の案内: the first time the editor (and the start screen) is shown, a
// few stops, each lighting up one part of the screen with a card saying what
// it is for, its keys as set now. The screen can be used while it is open;
// → / Enter go on, ← back, Esc closes it. Seen once, it starts again only
// when asked for (the help's 使い方の案内, the command palette).
import { fillKeys, START_STOPS, TOUR_STOPS, type TourStop } from "./helptopics";
import { TOUR_SEEN_KEY } from "./prefs";
import { readJson, writeJson } from "./settings";

export type TourName = "editor" | "start";

export interface TourHost {
  keysOf(command: string): string[];
}

const STOPS: Record<TourName, TourStop[]> = { editor: TOUR_STOPS, start: START_STOPS };

/** Room between the lit part and its card, and around the lit part. */
const GAP = 14;
const PAD = 6;

function seen(): Partial<Record<TourName, boolean>> {
  const value = readJson(TOUR_SEEN_KEY, {});
  return value && typeof value === "object" ? (value as Partial<Record<TourName, boolean>>) : {};
}

/** Whether that guide was seen (or closed) on this computer. */
export function tourSeen(name: TourName): boolean {
  return seen()[name] === true;
}

export function markTourSeen(name: TourName): void {
  writeJson(TOUR_SEEN_KEY, { ...seen(), [name]: true });
}

export class Tour {
  private readonly root: HTMLDivElement;
  private readonly spot: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private stops: TourStop[] = [];
  private name: TourName = "editor";
  private index = 0;

  constructor(private readonly host: TourHost) {
    this.root = Object.assign(document.createElement("div"), { id: "tour", className: "tour", hidden: true });
    this.spot = Object.assign(document.createElement("div"), { className: "tour-spot" });
    this.card = Object.assign(document.createElement("div"), { className: "tour-card" });
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-live", "polite");
    this.root.append(this.spot, this.card);
    document.body.append(this.root);
    window.addEventListener(
      "keydown",
      (event) => {
        if (this.root.hidden || event.ctrlKey || event.altKey || event.metaKey) return;
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) && !this.card.contains(target)) return;
        const step = event.key === "ArrowRight" || event.key === "Enter" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (event.key === "Escape") this.close();
        else if (step) this.go(this.index + step);
        else return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true },
    );
    window.addEventListener("resize", () => {
      if (!this.root.hidden) this.place();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** The guide, the first time only. */
  offer(name: TourName): void {
    if (!tourSeen(name) && !this.isOpen) this.start(name);
  }

  start(name: TourName): void {
    this.name = name;
    // Stops whose part is not on screen now are left out.
    this.stops = STOPS[name].filter((stop) => !stop.target || this.targetBox(stop) !== null);
    if (!this.stops.length) return;
    this.root.hidden = false;
    this.go(0);
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    markTourSeen(this.name);
  }

  private targetBox(stop: TourStop): DOMRect | null {
    const node = stop.target ? document.querySelector<HTMLElement>(stop.target) : null;
    if (!node || node.closest("[hidden]")) return null;
    const box = node.getBoundingClientRect();
    return box.width > 1 && box.height > 1 ? box : null;
  }

  private go(index: number): void {
    if (index >= this.stops.length) return this.close();
    this.index = Math.max(0, index);
    const stop = this.stops[this.index];
    const last = this.index === this.stops.length - 1;
    const keys = (id: string) => this.host.keysOf(id);
    const button = (text: string, className: string, run: () => void) => {
      const node = Object.assign(document.createElement("button"), { type: "button", textContent: text, className });
      node.addEventListener("click", run);
      return node;
    };
    const actions = Object.assign(document.createElement("div"), { className: "tour-actions" });
    actions.append(
      button("案内を閉じる", "tour-skip", () => this.close()),
      Object.assign(document.createElement("span"), { className: "spacer" }),
      ...(this.index > 0 ? [button("戻る", "tour-back", () => this.go(this.index - 1))] : []),
      button(last ? (this.name === "start" ? "わかった" : "はじめる") : "次へ", "primary tour-next", () => this.go(this.index + 1)),
    );
    this.card.replaceChildren(
      Object.assign(document.createElement("div"), { className: "tour-count", textContent: `${this.index + 1} / ${this.stops.length}` }),
      Object.assign(document.createElement("h3"), { textContent: stop.title }),
      ...stop.text.map((text) => Object.assign(document.createElement("p"), { textContent: fillKeys(text, keys) })),
      actions,
    );
    this.place();
    this.card.querySelector<HTMLButtonElement>(".tour-next")?.focus({ preventScroll: true });
  }

  /** The lit part and the card beside it (under, over, right or left of it, where it fits). */
  private place(): void {
    const stop = this.stops[this.index];
    const box = stop && this.targetBox(stop);
    const [w, h] = [innerWidth, innerHeight];
    const card = { width: this.card.offsetWidth, height: this.card.offsetHeight };
    if (!box) {
      Object.assign(this.spot.style, { left: `${w / 2}px`, top: `${h / 2}px`, width: "0px", height: "0px" });
      Object.assign(this.card.style, { left: `${(w - card.width) / 2}px`, top: `${(h - card.height) / 2}px` });
      return;
    }
    // A part larger than the window is lit only where it shows.
    const left = Math.max(0, box.left - PAD);
    const top = Math.max(0, box.top - PAD);
    const right = Math.min(w, box.right + PAD);
    const bottom = Math.min(h, box.bottom + PAD);
    Object.assign(this.spot.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    const centreX = (left + right) / 2 - card.width / 2;
    const centreY = (top + bottom) / 2 - card.height / 2;
    const tries: [number, number][] = [
      [centreX, bottom + GAP],
      [centreX, top - GAP - card.height],
      [right + GAP, centreY],
      [left - GAP - card.width, centreY],
    ];
    const fits = ([x, y]: [number, number]) => x >= 8 && y >= 8 && x + card.width <= w - 8 && y + card.height <= h - 8;
    const clampX = (x: number) => Math.max(8, Math.min(w - card.width - 8, x));
    const clampY = (y: number) => Math.max(8, Math.min(h - card.height - 8, y));
    // Clamped along the side it is on, the card still keeps clear of the part.
    const placed =
      tries.map(([x, y], i) => (i < 2 ? ([clampX(x), y] as [number, number]) : ([x, clampY(y)] as [number, number]))).find(fits) ?? [clampX(centreX), clampY(bottom - card.height - GAP)];
    Object.assign(this.card.style, { left: `${placed[0]}px`, top: `${placed[1]}px` });
  }
}

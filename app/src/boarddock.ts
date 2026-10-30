// The height of 物語の帯: as tall as its lanes need, dragged to a height by
// its top edge, or folded away (its buttons stay in the row under the
// pages) so the pages get the room. Kept per mode (the strip, 大きく) and for the next time. Sizing
// itself, the strip leaves the pages most of the height (描く配置): where
// that leaves too little for its lanes, it starts folded.
import { readJson, writeJson } from "./settings";
import { track } from "./boardview";

export type Mode = "strip" | "wide";

/** 0: as tall as the lanes need (the strip) or most of the height (大きく). */
const DEFAULT_HEIGHT: Record<Mode, number> = { strip: 0, wide: 0 };
const HEIGHT_KEY = "namestudio.storyHeight";
const FOLDED_KEY = "namestudio.storyFolded";
/** Room for a scroll bar under the lanes. */
const CHROME = 14;
const MIN_HEIGHT = 96;
/** Sizing itself, the strip leaves the pages (the stage) at least this share of the column's height. */
export const STAGE_SHARE = 0.72;
/** The least height (px) worth opening the strip for, sizing itself: the ruler, the scenes and the pages. */
const ROOMY = 160;

/** What the height follows. */
export interface DockParts {
  dock: HTMLElement;
  /** The top edge, dragged. */
  handle: HTMLElement;
  /** The lanes, hidden when folded. */
  lanes: HTMLElement;
  mode(): Mode;
  /** Height the lanes drew at, px. */
  contentHeight(): number;
  /** The height or the fold changed: draw the strip again. */
  changed(): void;
}

export class DockHeight {
  private heights: Record<Mode, number>;
  /** たたんだ (true) or open (false) as the person left it; null: as the window's height allows (roomy). */
  private chosen: boolean | null;
  private wasRoomy: boolean | null = null;

  constructor(private readonly parts: DockParts) {
    const saved = readJson(HEIGHT_KEY, null);
    this.heights = saved && typeof saved === "object" ? { ...DEFAULT_HEIGHT, ...saved } : DEFAULT_HEIGHT;
    const folded = readJson(FOLDED_KEY, null);
    this.chosen = typeof folded === "boolean" ? folded : null;
    this.bindHandle();
    // Folded by the window's height: the window made taller or lower opens or folds it.
    window.addEventListener("resize", () => {
      if (this.chosen !== null || this.parts.mode() === "wide") return;
      if (this.roomy() !== this.wasRoomy) this.parts.changed();
    });
  }

  /** たたんだ: the lanes are hidden (the buttons stay in the row under the pages). 大きく is never folded. */
  get isFolded(): boolean {
    if (this.parts.mode() === "wide") return false;
    return this.chosen ?? !this.roomy();
  }

  /**
   * Fold or open, kept for the next time; false when it already was (chosen
   * all the same: it then stays so whatever the window's height). Folding
   * takes the room at once.
   */
  fold(fold: boolean): boolean {
    const changed = fold !== this.isFolded;
    this.chosen = fold;
    writeJson(FOLDED_KEY, fold);
    if (fold && changed) this.apply();
    return changed;
  }

  apply(): void {
    const { dock, lanes } = this.parts;
    const mode = this.parts.mode();
    const folded = this.isFolded;
    this.wasRoomy = this.roomy();
    dock.classList.toggle("folded", folded);
    dock.classList.toggle("wide", mode === "wide");
    lanes.hidden = folded;
    if (folded) {
      dock.style.height = "0px";
      return;
    }
    const room = this.room();
    const wanted = this.heights[mode] || (mode === "wide" ? Math.round(room * 0.62) : Math.min(this.parts.contentHeight() + CHROME, this.ownShare()));
    // The page above keeps at least some room.
    const max = Math.max(MIN_HEIGHT, room - 160);
    dock.style.height = `${Math.max(MIN_HEIGHT, Math.min(max, wanted))}px`;
  }

  /** The column's height (px). */
  private room(): number {
    return this.parts.dock.parentElement?.clientHeight || window.innerHeight;
  }

  /** The most the strip takes sizing itself: what the pages (STAGE_SHARE) and the column's other rows leave. */
  private ownShare(): number {
    const { dock } = this.parts;
    const column = dock.parentElement;
    let rows = 0;
    for (const child of column ? Array.from(column.children) : []) {
      if (child !== dock && !child.classList.contains("stage") && child instanceof HTMLElement) rows += child.offsetHeight;
    }
    return Math.round(this.room() * (1 - STAGE_SHARE)) - rows;
  }

  /** Whether the window is tall enough for the lanes beside the pages (else, not chosen otherwise, the strip folds). */
  private roomy(): boolean {
    return this.ownShare() >= ROOMY;
  }

  private keep(height: number): void {
    this.heights = { ...this.heights, [this.parts.mode()]: height };
    writeJson(HEIGHT_KEY, this.heights);
    this.parts.changed();
  }

  /** Drag the top edge of the strip to give it more or less of the height. */
  private bindHandle(): void {
    const { dock, handle, lanes } = this.parts;
    handle.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      const start = dock.getBoundingClientRect().height;
      const room = dock.parentElement?.clientHeight || window.innerHeight;
      handle.classList.add("dragging");
      track(down, handle, {
        move: (event) => {
          // Dragging a folded strip opens it from nothing (a click alone does not).
          if (this.isFolded) {
            this.chosen = false;
            writeJson(FOLDED_KEY, false);
            lanes.hidden = false;
            dock.classList.remove("folded");
          }
          const height = Math.round(Math.max(MIN_HEIGHT, Math.min(room - 160, start + down.clientY - event.clientY)));
          dock.style.height = `${height}px`;
        },
        end: (_event, moved) => {
          handle.classList.remove("dragging");
          // A click (half of a double click) keeps the height as it was.
          if (moved) this.keep(Math.round(dock.getBoundingClientRect().height));
        },
      });
    });
    handle.addEventListener("dblclick", () => {
      // Folded: open again. Open at a height dragged to: back to the height the lanes need, then folded.
      if (this.isFolded) {
        if (this.fold(false)) this.parts.changed();
      } else if (this.heights[this.parts.mode()]) this.keep(0);
      else if (this.fold(true)) this.parts.changed();
    });
  }
}

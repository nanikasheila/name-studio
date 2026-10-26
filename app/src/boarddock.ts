// The height of 物語の帯: as tall as its lanes need, dragged to a height by
// its top edge, or folded down to its row of buttons so the pages get the
// room. Kept per mode (the strip, 大きく) and for the next time.
import { readJson, writeJson } from "./settings";
import { track } from "./boardview";

export type Mode = "strip" | "wide";

/** 0: as tall as the lanes need (the strip) or most of the height (大きく). */
const DEFAULT_HEIGHT: Record<Mode, number> = { strip: 0, wide: 0 };
const HEIGHT_KEY = "namestudio.storyHeight";
const FOLDED_KEY = "namestudio.storyFolded";
/** The strip's own row of buttons, and room for a scroll bar. */
const CHROME = 32 + 14;
const MIN_HEIGHT = 96;
/** A window this low (px) starts with the strip folded, the pages first. */
const LOW_WINDOW = 760;

/** What the height follows. */
export interface DockParts {
  dock: HTMLElement;
  /** The top edge, dragged. */
  handle: HTMLElement;
  /** The row of buttons, the height left when folded. */
  controls: HTMLElement;
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
  /** たたんだ: only the strip's row of buttons shows; the pages get the room (at first, in a low window). */
  private folded = (readJson(FOLDED_KEY, null) ?? window.innerHeight < LOW_WINDOW) === true;

  constructor(private readonly parts: DockParts) {
    const saved = readJson(HEIGHT_KEY, null);
    this.heights = saved && typeof saved === "object" ? { ...DEFAULT_HEIGHT, ...saved } : DEFAULT_HEIGHT;
    this.bindHandle();
  }

  get isFolded(): boolean {
    return this.folded;
  }

  /** Fold or open; false when it already was. Folding takes the room at once. */
  fold(fold: boolean): boolean {
    if (fold === this.folded) return false;
    this.folded = fold;
    writeJson(FOLDED_KEY, fold);
    if (fold) this.apply();
    return true;
  }

  apply(): void {
    const { dock, controls, lanes } = this.parts;
    const mode = this.parts.mode();
    dock.classList.toggle("folded", this.folded);
    lanes.hidden = this.folded;
    if (this.folded) {
      dock.style.height = `${controls.offsetHeight || 33}px`;
      return;
    }
    const room = dock.parentElement?.clientHeight || window.innerHeight;
    const wanted = this.heights[mode] || (mode === "wide" ? Math.round(room * 0.62) : Math.min(this.parts.contentHeight() + CHROME, Math.round(room * 0.38)));
    // The page above keeps at least some room.
    const max = Math.max(MIN_HEIGHT, room - 160);
    dock.style.height = `${Math.max(MIN_HEIGHT, Math.min(max, wanted))}px`;
    dock.classList.toggle("wide", mode === "wide");
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
          // Dragging a folded strip opens it from its row of buttons (a click alone does not).
          if (this.folded) {
            this.folded = false;
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
      if (this.folded) {
        if (this.fold(false)) this.parts.changed();
      } else if (this.heights[this.parts.mode()]) this.keep(0);
      else if (this.fold(true)) this.parts.changed();
    });
  }
}

// スポイト: the colour of the page under a click becomes the 描画色 (or goes to
// whoever armed it, the colour palette). The rough's own soft black and the
// borders' inks read as black, the colour a stroke takes when it has none.
import { toHex } from "../domain/color";
import { drawColors } from "../platform/drawcolor";
import { INK, PENCIL, ROUGH_INK } from "../render/pagedraw";

export class Dropper {
  private pending: ((color: string | null) => void) | null = null;

  /** Waiting for a click on the page. */
  get armed(): boolean {
    return this.pending !== null;
  }

  /** The next click gives its colour to `done` (one armed before gets null). */
  arm(done: (color: string | null) => void): void {
    this.pending?.(null);
    this.pending = done;
  }

  /** Esc: give up (true when one was armed). */
  cancel(): boolean {
    const done = this.pending;
    this.pending = null;
    done?.(null);
    return done !== null;
  }

  /** A click on `pixel`: to the one armed, or the 描画色. Returns what to say. */
  take(pixel: readonly [number, number, number] | null): string {
    const color = pixel ? pickedColor(pixel) : null;
    const done = this.pending;
    this.pending = null;
    if (done) {
      done(color);
      return "";
    }
    return color && drawColors.setMain(color) ? `スポイト: 描画色を ${color} にしました` : "";
  }
}

/** The colour picked from a pixel: the inks the app draws in for "no colour" give black. */
export function pickedColor(pixel: readonly [number, number, number]): string {
  const hex = toHex([pixel[0], pixel[1], pixel[2]]);
  return [ROUGH_INK, INK, PENCIL].includes(hex) ? "#000000" : hex;
}

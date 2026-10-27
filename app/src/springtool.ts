// 一時切り替え: as in CSP, a tool's key held down lends that tool for as long
// as it is held, and letting go gives back the tool from before; a short
// press changes the tool as before. Used on the page while held (a line
// erased with E held) counts as held, however short. Let go in the middle of
// a stroke, the tool comes back when the stroke ends.

/** How long a press lasts before it lends the tool rather than changing it (ms). */
export const HOLD_MS = 500;

export class SpringTool<T> {
  private held: { code: string; from: T; at: number; used: boolean } | null = null;
  /** Let go during a stroke: the tool to give back when it ends. */
  private waiting: T | null = null;
  private down = false;

  constructor(private readonly holdMs = HOLD_MS) {}

  /** The key `code` changed the tool from `from`. */
  press(code: string, from: T, now: number): void {
    this.held = { code, from, at: now, used: this.down };
    this.waiting = null;
  }

  /** Whether `code` is the key lending a tool now (its repeats change nothing). */
  holds(code: string): boolean {
    return this.held?.code === code;
  }

  pointerDown(): void {
    this.down = true;
    if (this.held) this.held.used = true;
  }

  /** The stroke ended: the tool to give back, if the key was let go during it. */
  pointerUp(): T | null {
    this.down = false;
    const back = this.waiting;
    this.waiting = null;
    return back;
  }

  /** The key `code` let go: the tool to give back now, or null to keep the one in hand. */
  release(code: string, now: number): T | null {
    const held = this.held;
    if (!held || held.code !== code) return null;
    this.held = null;
    if (!held.used && now - held.at < this.holdMs) return null;
    if (this.down) {
      this.waiting = held.from;
      return null;
    }
    return held.from;
  }

  /** The window lost the keys (another window came up): nothing is held. */
  reset(): void {
    this.held = null;
  }
}

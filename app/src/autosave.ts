// Autosave: a short while after the last change, write the project (or a
// copy kept for after a crash). Kept apart from the workbench so the timing
// can be tested without the app.

/** Seconds of quiet after a change before autosave writes. */
export const AUTOSAVE_DELAY_MS = 3000;
/** Autosave writes at least this often while changes keep coming. */
export const AUTOSAVE_MAX_WAIT_MS = 30000;

const SETTING_KEY = "namestudio.autosaveToFile";

export interface AutosaveTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const browserTimers: AutosaveTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Calls `write` once changes stop for `delay` ms, or after `maxWait` ms of
 * changes. `busy()` holds a write back (a stroke being drawn); a write that
 * fails is tried again on the next change.
 */
export class Autosaver {
  private timer: unknown = null;
  private firstChange: number | null = null;
  private running: Promise<void> | null = null;
  /** Changes noted since the last write began. */
  private changes = 0;

  constructor(
    private readonly write: () => Promise<void>,
    private readonly busy: () => boolean = () => false,
    private readonly timers: AutosaveTimers = browserTimers,
    private readonly delay = AUTOSAVE_DELAY_MS,
    private readonly maxWait = AUTOSAVE_MAX_WAIT_MS,
  ) {}

  /** Something changed. */
  notify(): void {
    this.changes += 1;
    const now = this.timers.now();
    this.firstChange ??= now;
    if (this.timer !== null) this.timers.clear(this.timer);
    const wait = Math.max(0, Math.min(this.delay, this.firstChange + this.maxWait - now));
    this.timer = this.timers.set(() => void this.fire(), wait);
  }

  /** True while there are changes autosave has not written yet. */
  get pending(): boolean {
    return this.changes > 0;
  }

  /** Forget changes (the project was saved or replaced). */
  reset(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.firstChange = null;
    this.changes = 0;
  }

  /** Write now if anything is waiting, and wait for it. */
  async flush(): Promise<void> {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    if (this.running) await this.running;
    if (this.changes > 0) await this.fire(true);
  }

  private async fire(force = false): Promise<void> {
    this.timer = null;
    if (!force && this.busy()) {
      this.timer = this.timers.set(() => void this.fire(), this.delay);
      return;
    }
    if (this.running) {
      // Write again after the one under way, with what changed meanwhile.
      await this.running;
      if (this.changes === 0) return;
    }
    const written = this.changes;
    this.firstChange = null;
    this.running = this.write().then(
      () => {
        this.changes = Math.max(0, this.changes - written);
      },
      () => {
        // Kept as pending; the next change (or flush) tries again.
      },
    );
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }
}

/** Whether autosave writes the project file itself (on unless turned off). */
export function autosaveToFile(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAutosaveToFile(on: boolean): void {
  try {
    localStorage.setItem(SETTING_KEY, on ? "on" : "off");
  } catch {
    // Not remembered; the default applies next time.
  }
}

/** "10/23 09:05" style local time for a version list. */
export function formatTime(timeMs: number, now = Date.now()): string {
  const date = new Date(timeMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  if (sameDay) return `今日 ${clock}`;
  const year = date.getFullYear() === today.getFullYear() ? "" : `${date.getFullYear()}/`;
  return `${year}${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

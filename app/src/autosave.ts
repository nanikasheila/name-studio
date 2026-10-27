// Autosave: a short while after the last change, write the project (or a
// copy kept for after a crash). Kept apart from the workbench so the timing
// can be tested without the app.
import { readNumber, readText, writeNumber, writeText } from "./settings";
import { type Snapshot, sameSnapshot } from "./snapshot";

/** Quiet after a change before autosave writes, unless set (設定の「保存」). */
export const AUTOSAVE_DELAY_MS = 3000;
/** Autosave writes at least this often while changes keep coming, unless set. */
export const AUTOSAVE_MAX_WAIT_MS = 30000;
/** The seconds the two can be set to. */
export const AUTOSAVE_DELAY_RANGE = { min: 1, max: 600 } as const;
export const AUTOSAVE_MAX_WAIT_RANGE = { min: 5, max: 3600 } as const;

const SETTING_KEY = "namestudio.autosaveToFile";
const DELAY_KEY = "namestudio.autosaveDelaySec";
const MAX_WAIT_KEY = "namestudio.autosaveMaxWaitSec";

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
    private delay = AUTOSAVE_DELAY_MS,
    private maxWait = AUTOSAVE_MAX_WAIT_MS,
  ) {}

  /** Something changed. */
  notify(): void {
    this.changes += 1;
    this.firstChange ??= this.timers.now();
    this.schedule();
  }

  /** Wait `delay` ms of quiet, `maxWait` ms at most; a write already waiting goes by the new times. */
  setTiming(delay: number, maxWait: number): void {
    this.delay = delay;
    this.maxWait = maxWait;
    if (this.timer !== null) this.schedule();
  }

  /** Go by the times set on this PC (設定の「保存」). */
  followSettings(): this {
    const timing = autosaveTiming();
    this.setTiming(timing.delay * 1000, timing.maxWait * 1000);
    return this;
  }

  private schedule(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    const wait = Math.max(0, Math.min(this.delay, (this.firstChange ?? this.timers.now()) + this.maxWait - this.timers.now()));
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

/** What an autosave has to write, against what was written last. */
export type AutosaveNeed =
  /** The file holds it already (a change undone): nothing to write, and nothing is unsaved. */
  | "clean"
  /** The recovery copy holds it already: nothing to write. */
  | "none"
  | "file"
  | "copy";

interface Held {
  /** Which opened name (`Session.id`). */
  id: number;
  path: string | null;
  snapshot: Snapshot;
}

/**
 * What the name's file and its recovery copy hold, as snapshots, so autosave
 * writes only when there is something new: a step that changed nothing, or
 * changes taken back again, leave the file (and its versions) alone.
 */
export class Written {
  private file: Held | null = null;
  private copy: Held | null = null;

  /** Another name was opened: nothing of it is known yet. */
  forget(): void {
    this.file = null;
    this.copy = null;
  }

  /** The file at `path` holds `snapshot` (opened from it, saved or autosaved to it); a copy is done with. */
  toFile(id: number, path: string, snapshot: Snapshot | null): void {
    this.file = snapshot ? { id, path, snapshot } : null;
    this.copy = null;
  }

  /** The recovery copy holds `snapshot`. */
  toCopy(id: number, path: string | null, snapshot: Snapshot | null): void {
    this.copy = snapshot ? { id, path, snapshot } : null;
  }

  /** What to write of `snapshot` (name `id` at `path`), to its file if `toFile`, else to the copy. */
  need(id: number, path: string | null, toFile: boolean, snapshot: Snapshot | null): AutosaveNeed {
    const holds = (held: Held | null) => snapshot !== null && held !== null && held.id === id && held.path === path && sameSnapshot(held.snapshot, snapshot);
    if (path !== null && holds(this.file)) return "clean";
    if (toFile && path !== null) return "file";
    return holds(this.copy) ? "none" : "copy";
  }
}

/** Whether autosave writes the project file itself (on unless turned off). */
export function autosaveToFile(): boolean {
  return readText(SETTING_KEY) !== "off";
}

export function setAutosaveToFile(on: boolean): void {
  writeText(SETTING_KEY, on ? "on" : "off");
}

/** When autosave writes, in seconds: after `delay` of quiet, and at least every `maxWait` while changes keep coming. */
export interface AutosaveTiming {
  delay: number;
  maxWait: number;
}

/** The autosave times set on this PC (the defaults when none are). */
export function autosaveTiming(): AutosaveTiming {
  const delay = readNumber(DELAY_KEY, AUTOSAVE_DELAY_MS / 1000, AUTOSAVE_DELAY_RANGE.min, AUTOSAVE_DELAY_RANGE.max);
  const maxWait = readNumber(MAX_WAIT_KEY, AUTOSAVE_MAX_WAIT_MS / 1000, AUTOSAVE_MAX_WAIT_RANGE.min, AUTOSAVE_MAX_WAIT_RANGE.max);
  // Never sooner than the quiet asked for: a longest wait below it would cut the quiet short.
  return { delay, maxWait: Math.max(delay, maxWait) };
}

/** Keep the autosave times, each within its range; returns what was kept. */
export function setAutosaveTiming(timing: AutosaveTiming): AutosaveTiming {
  const clamp = (value: number, range: { min: number; max: number }, fallback: number) =>
    Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, Math.round(value))) : fallback;
  const delay = clamp(timing.delay, AUTOSAVE_DELAY_RANGE, AUTOSAVE_DELAY_MS / 1000);
  const maxWait = Math.max(delay, clamp(timing.maxWait, AUTOSAVE_MAX_WAIT_RANGE, AUTOSAVE_MAX_WAIT_MS / 1000));
  writeNumber(DELAY_KEY, delay);
  writeNumber(MAX_WAIT_KEY, maxWait);
  return { delay, maxWait };
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

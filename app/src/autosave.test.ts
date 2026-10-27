import { afterEach, describe, expect, it, vi } from "vitest";
import { Autosaver, Written, autosaveTiming, formatTime, setAutosaveTiming, type AutosaveTimers } from "./autosave";
import { Snapshotter } from "./snapshot";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

afterEach(() => vi.unstubAllGlobals());

/** Timers run by hand: `advance` fires what is due. */
class FakeTimers implements AutosaveTimers {
  time = 0;
  private next = 1;
  private readonly due = new Map<number, { at: number; run: () => void }>();

  set(run: () => void, ms: number): unknown {
    const id = this.next++;
    this.due.set(id, { at: this.time + ms, run });
    return id;
  }

  clear(handle: unknown): void {
    this.due.delete(handle as number);
  }

  now(): number {
    return this.time;
  }

  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const [id, timer] = [...this.due.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined || timer!.at > end) break;
      this.due.delete(id);
      this.time = timer!.at;
      timer!.run();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.time = end;
  }
}

describe("Autosaver", () => {
  it("writes once changes stop", async () => {
    const timers = new FakeTimers();
    let writes = 0;
    const saver = new Autosaver(async () => void writes++, () => false, timers, 1000, 10000);
    saver.notify();
    await timers.advance(500);
    saver.notify();
    await timers.advance(900);
    expect(writes).toBe(0);
    await timers.advance(200);
    expect(writes).toBe(1);
    expect(saver.pending).toBe(false);
  });

  it("writes while changes keep coming", async () => {
    const timers = new FakeTimers();
    let writes = 0;
    const saver = new Autosaver(async () => void writes++, () => false, timers, 1000, 3000);
    for (let i = 0; i < 10; i++) {
      saver.notify();
      await timers.advance(500);
    }
    expect(writes).toBeGreaterThanOrEqual(1);
  });

  it("waits while busy", async () => {
    const timers = new FakeTimers();
    let writes = 0;
    let busy = true;
    const saver = new Autosaver(async () => void writes++, () => busy, timers, 1000, 3000);
    saver.notify();
    await timers.advance(5000);
    expect(writes).toBe(0);
    busy = false;
    await timers.advance(1000);
    expect(writes).toBe(1);
  });

  it("keeps changes after a failed write and flushes them", async () => {
    const timers = new FakeTimers();
    let fail = true;
    let writes = 0;
    const saver = new Autosaver(
      async () => {
        if (fail) throw new Error("disk");
        writes++;
      },
      () => false,
      timers,
      1000,
      3000,
    );
    saver.notify();
    await timers.advance(1000);
    expect(saver.pending).toBe(true);
    fail = false;
    await saver.flush();
    expect(writes).toBe(1);
    expect(saver.pending).toBe(false);
  });

  it("does nothing on flush or after reset when nothing changed", async () => {
    const timers = new FakeTimers();
    let writes = 0;
    const saver = new Autosaver(async () => void writes++, () => false, timers);
    await saver.flush();
    saver.notify();
    saver.reset();
    await timers.advance(60000);
    expect(writes).toBe(0);
  });
});

describe("自動保存の間隔", () => {
  it("goes by times set later, also for a write already waiting", async () => {
    const timers = new FakeTimers();
    let writes = 0;
    const saver = new Autosaver(async () => void writes++, () => false, timers, 1000, 10000);
    saver.notify();
    saver.setTiming(5000, 60000);
    await timers.advance(4000);
    expect(writes).toBe(0);
    await timers.advance(1000);
    expect(writes).toBe(1);
    // Changes that keep coming are written by the longest wait.
    saver.setTiming(2000, 6000);
    for (let i = 0; i < 7; i++) {
      saver.notify();
      await timers.advance(1000);
    }
    expect(writes).toBe(2);
  });

  it("is 3 and 30 seconds until set, kept within range, and never writes before the quiet", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(autosaveTiming()).toEqual({ delay: 3, maxWait: 30 });
    expect(setAutosaveTiming({ delay: 10, maxWait: 120 })).toEqual({ delay: 10, maxWait: 120 });
    expect(autosaveTiming()).toEqual({ delay: 10, maxWait: 120 });
    expect(setAutosaveTiming({ delay: 0, maxWait: 99999 })).toEqual({ delay: 1, maxWait: 3600 });
    expect(setAutosaveTiming({ delay: 90, maxWait: 30 })).toEqual({ delay: 90, maxWait: 90 });
    expect(setAutosaveTiming({ delay: Number.NaN, maxWait: Number.NaN })).toEqual({ delay: 3, maxWait: 30 });
    localStorage.setItem("namestudio.autosaveDelaySec", "abc");
    expect(autosaveTiming().delay).toBe(3);
  });
});

describe("変更がないときは書かない", () => {
  interface Doc {
    title: string;
    pages: { strokes: { points: number[][] }[] }[];
  }
  const snapshots = new Snapshotter<Doc>();
  const doc = (): Doc => ({ title: "第4話", pages: [{ strokes: [{ points: [[1, 2]] }] }] });

  it("writes only what the file or the copy does not hold yet", () => {
    const written = new Written();
    const opened = doc();
    // Nothing known: the file is written (or the copy, when there is no file or writing to it is off).
    expect(written.need(1, "a.namestudio", true, snapshots.take(opened))).toBe("file");
    expect(written.need(1, null, true, snapshots.take(opened))).toBe("copy");
    written.toFile(1, "a.namestudio", snapshots.take(opened));
    // A step that changed nothing, or a change taken back: the file holds it.
    expect(written.need(1, "a.namestudio", true, snapshots.take(opened))).toBe("clean");
    expect(written.need(1, "a.namestudio", false, snapshots.take(opened))).toBe("clean");
    const changed = { ...opened, title: "第5話" };
    expect(written.need(1, "a.namestudio", true, snapshots.take(changed))).toBe("file");
    expect(written.need(1, "a.namestudio", false, snapshots.take(changed))).toBe("copy");
    written.toCopy(1, "a.namestudio", snapshots.take(changed));
    expect(written.need(1, "a.namestudio", false, snapshots.take(changed))).toBe("none");
    // Writing the file is turned on: the file does not hold it yet.
    expect(written.need(1, "a.namestudio", true, snapshots.take(changed))).toBe("file");
    // Saved to the file: the copy is done with.
    written.toFile(1, "a.namestudio", snapshots.take(changed));
    expect(written.need(1, "a.namestudio", false, snapshots.take(opened))).toBe("copy");
  });

  it("knows nothing of another name, another file or after forgetting", () => {
    const written = new Written();
    const opened = doc();
    written.toFile(1, "a.namestudio", snapshots.take(opened));
    expect(written.need(2, "a.namestudio", true, snapshots.take(opened))).toBe("file");
    expect(written.need(1, "b.namestudio", true, snapshots.take(opened))).toBe("file");
    // The same points again, drawn anew, are a change.
    const redrawn = { ...opened, pages: [{ strokes: [{ points: [[1, 2]] }] }] };
    expect(written.need(1, "a.namestudio", true, snapshots.take(redrawn))).toBe("file");
    written.forget();
    expect(written.need(1, "a.namestudio", true, snapshots.take(opened))).toBe("file");
    expect(written.need(1, "a.namestudio", true, null)).toBe("file");
  });
});

describe("formatTime", () => {
  it("shows today and other days", () => {
    const now = new Date(2026, 9, 23, 12, 0, 0).getTime();
    expect(formatTime(new Date(2026, 9, 23, 9, 5, 7).getTime(), now)).toBe("今日 09:05:07");
    expect(formatTime(new Date(2026, 9, 22, 23, 0, 0).getTime(), now)).toBe("10/22 23:00:00");
    expect(formatTime(new Date(2025, 0, 2, 3, 4, 5).getTime(), now)).toBe("2025/1/2 03:04:05");
  });
});

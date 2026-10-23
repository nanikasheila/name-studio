import { describe, expect, it } from "vitest";
import { Autosaver, formatTime, type AutosaveTimers } from "./autosave";

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

describe("formatTime", () => {
  it("shows today and other days", () => {
    const now = new Date(2026, 9, 23, 12, 0, 0).getTime();
    expect(formatTime(new Date(2026, 9, 23, 9, 5, 7).getTime(), now)).toBe("今日 09:05:07");
    expect(formatTime(new Date(2026, 9, 22, 23, 0, 0).getTime(), now)).toBe("10/22 23:00:00");
    expect(formatTime(new Date(2025, 0, 2, 3, 4, 5).getTime(), now)).toBe("2025/1/2 03:04:05");
  });
});

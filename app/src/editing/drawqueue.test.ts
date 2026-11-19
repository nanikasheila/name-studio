import { describe, expect, it } from "vitest";
import { DrawQueue } from "./drawqueue";

const ask = (queue: DrawQueue, ...panels: string[]) =>
  queue.add({ title: panels.join("・"), targets: panels.map((panel) => ({ panel })), note: "" }, 0);

describe("作画の依頼の列", () => {
  it("draws one after another with one lane, in the order asked", () => {
    const queue = new DrawQueue();
    const a = ask(queue, "p1");
    const b = ask(queue, "p2");
    expect(queue.next(1, 1)).toEqual([a]);
    expect(a).toMatchObject({ state: "running", lane: 0, started: 1 });
    expect(queue.next(1, 2)).toEqual([]);
    expect(b.state).toBe("waiting");
    queue.end(a, "done", 3);
    expect(queue.next(1, 4)).toEqual([b]);
    expect(b.lane).toBe(0);
  });

  it("draws side by side up to the lanes, the same panel in turn", () => {
    const queue = new DrawQueue();
    const a = ask(queue, "p1", "p2");
    const b = ask(queue, "p2");
    const c = ask(queue, "p3");
    const d = ask(queue, "p4");
    // b waits for a (p2); c and d go side by side with a, up to 3 lanes.
    expect(queue.next(3, 1)).toEqual([a, c, d]);
    expect([a.lane, c.lane, d.lane]).toEqual([0, 1, 2]);
    expect(b.state).toBe("waiting");
    queue.end(c, "done", 2);
    // Lane 1 is free, but b's panel is still being drawn by a.
    expect(queue.next(3, 3)).toEqual([]);
    queue.end(a, "done", 4);
    // b goes on in a's lane, which drew p2 before.
    expect(queue.next(3, 5)).toEqual([b]);
    expect(b.lane).toBe(0);
  });

  it("keeps a later request for a panel behind an earlier one still waiting", () => {
    const queue = new DrawQueue();
    const a = ask(queue, "p1");
    const b = ask(queue, "p1", "p2");
    const c = ask(queue, "p2");
    expect(queue.next(4, 1)).toEqual([a]);
    expect([b.state, c.state]).toEqual(["waiting", "waiting"]);
  });

  it("says words in their own lane once it is free", () => {
    const queue = new DrawQueue();
    const a = ask(queue, "p1");
    queue.next(2, 1);
    const words = queue.add({ title: "伝える", targets: [], note: "", words: "もっと引きで", lane: 0 }, 2);
    const other = ask(queue, "p2");
    expect(queue.next(2, 3)).toEqual([other]);
    expect(other.lane).toBe(1);
    queue.end(a, "done", 4);
    expect(queue.next(2, 5)).toEqual([words]);
    expect(words.lane).toBe(0);
  });

  it("stops: one waiting leaves the line, one running ends as stopped", () => {
    const queue = new DrawQueue();
    const a = ask(queue, "p1");
    const b = ask(queue, "p2");
    queue.next(1, 1);
    expect(queue.stop(b, 2)).toBe(true);
    expect(b.state).toBe("stopped");
    expect(queue.stop(a, 3)).toBe(false);
    queue.end(a, "failed", 4, "killed\nmore");
    expect(a.state).toBe("stopped");
    expect(a.error).toBeUndefined();
    expect(queue.next(1, 5)).toEqual([]);
    const c = ask(queue, "p3");
    queue.next(1, 6);
    queue.end(c, "failed", 7, "落ちました\n詳しく");
    expect(c.error).toBe("落ちました");
    queue.clearDone();
    expect(queue.jobs).toEqual([]);
  });

  it("tells what each panel waits for or is having drawn", () => {
    const queue = new DrawQueue();
    const a = ask(queue, "p1");
    const b = ask(queue, "p1", "p2");
    queue.next(1, 1);
    const states = queue.panelStates();
    expect(states.get("p1")).toBe(a);
    expect(states.get("p2")).toBe(b);
    expect(queue.byRun(5)).toBeUndefined();
    a.run = 5;
    expect(queue.byRun(5)).toBe(a);
  });

  it("keeps only the newest of the requests ended", () => {
    const queue = new DrawQueue();
    for (let i = 0; i < 20; i++) {
      const job = ask(queue, `p${i}`);
      queue.next(1, i);
      queue.end(job, "done", i);
    }
    expect(queue.jobs).toHaveLength(12);
    expect(queue.jobs[0].title).toBe("p8");
  });
});

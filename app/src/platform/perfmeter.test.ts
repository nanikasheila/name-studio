import { describe, expect, it } from "vitest";
import { PerfMeter } from "./perfmeter";

/** A meter on a clock the test moves. */
function meter() {
  let now = 1000;
  const m = new PerfMeter(() => now);
  return { m, at: (time: number) => (now = time) };
}

describe("動作の記録", () => {
  it("times the oldest input of a frame to the end of its drawing", () => {
    const { m, at } = meter();
    m.input(1000, true, 4);
    m.input(1004, true, 4);
    at(1010);
    const start = 1010;
    at(1013);
    m.drawn(start, true);
    const report = m.report();
    expect(report.penLatency).toMatchObject({ count: 1, median: 13 });
    expect(report.penFrame).toMatchObject({ count: 1, median: 3 });
    expect(report.dragLatency).toBeNull();
  });

  it("does not count input left when a drag ended against the next one", () => {
    const { m, at } = meter();
    m.input(1000, false);
    m.dragEnded();
    at(5000);
    m.input(4990, true);
    at(5002);
    m.drawn(5000, true);
    expect(m.report().penLatency).toMatchObject({ count: 1, median: 12 });
    expect(m.report().dragLatency).toBeNull();
  });

  it("counts the pen's events a second over the lines drawn, not the pauses between them", () => {
    const { m } = meter();
    for (let t = 0; t <= 500; t += 5) m.input(10_000 + t, true, 1);
    m.dragEnded();
    for (let t = 0; t <= 500; t += 5) m.input(60_000 + t, true, 1);
    m.dragEnded();
    expect(m.report().penRate).toBe(202);
  });

  it("keeps the frame interval while a line is drawn, and starts again after it", () => {
    const { m, at } = meter();
    for (const start of [100, 117, 133, 150]) {
      at(start + 1);
      m.drawn(start, true);
    }
    m.dragEnded();
    at(1001);
    m.drawn(1000, true);
    expect(m.report().penInterval).toMatchObject({ count: 3, max: 17 });
  });

  it("reports the start from the process and from the page", () => {
    const { m } = meter();
    m.ready(performance.timeOrigin - 500, 300);
    expect(m.report().startup).toEqual({ process: 800, page: 300 });
    m.ready(null, 300);
    expect(m.report().startup).toEqual({ process: null, page: 300 });
  });

  it("starts counting again, the start kept", () => {
    const { m, at } = meter();
    m.ready(null, 250);
    m.input(990, true);
    at(1002);
    m.drawn(1000, true);
    m.reset();
    expect(m.report().penLatency).toBeNull();
    expect(m.report().startup?.page).toBe(250);
  });
});

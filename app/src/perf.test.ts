// A drawn name of 32 pages must stay quick to change, undo and save: the work
// done per change grows with what changed, not with all that was drawn.
import { describe, expect, it } from "vitest";
import type { Project, StrokePoint } from "./model";
import { newProject } from "./project";
import { projectJson } from "./projectjson";
import { Snapshotter } from "./snapshot";

function heavyName(): Project {
  const project = newProject("重いネーム", 32);
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let id = 0;
  for (const page of project.pages) {
    for (let s = 0; s < 200; s++) {
      let [x, y, a] = [20 + random() * 200, 20 + random() * 300, random() * 6.28];
      const points: StrokePoint[] = [];
      for (let i = 0; i < 50; i++) {
        a += (random() - 0.5) * 0.5;
        x += Math.cos(a) * 0.4;
        y += Math.sin(a) * 0.4;
        points.push([x, y, 0.3 + 0.6 * Math.sin((Math.PI * i) / 50)]);
      }
      page.strokes.push({ id: `stroke${id++}`, points, widthMm: 0.5, closed: false });
    }
  }
  return project;
}

function timed(run: () => void, times = 3): number {
  run();
  let best = Infinity;
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("a heavy name", () => {
  const project = heavyName();
  const plain = timed(() => JSON.stringify(project));

  it("takes undo snapshots in a fraction of writing it all out", () => {
    const snapshots = new Snapshotter<Project>();
    const take = timed(() => snapshots.take(project));
    expect(take).toBeLessThan(plain * 0.5);
  });

  it("saves again in a fraction of writing it all out, and smaller", () => {
    const text = projectJson(project);
    const save = timed(() => projectJson(project));
    expect(save).toBeLessThan(plain * 0.5);
    expect(text.length).toBeLessThan(JSON.stringify(project).length * 0.5);
  });

  it("keeps one copy of the pages a change did not touch", () => {
    const snapshots = new Snapshotter<Project>();
    const before = snapshots.take(project);
    const page = project.pages[7];
    page.strokes = page.strokes.slice(1);
    const after = snapshots.take(project);
    const shared = after.pages.filter((part, i) => part === before.pages[i]).length;
    expect(shared).toBe(31);
  });
});

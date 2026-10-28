import { describe, expect, it } from "vitest";
import { History } from "./history";
import type { Project } from "./model";
import { newProject } from "./project";
import { addStroke, moveStroke } from "./strokes";
import { addLine, moveLine, setLineText } from "./dialogue";
import { projectBody, projectJson } from "./projectjson";
import { sameSnapshot, Snapshotter } from "./snapshot";

function drawn(pages = 3): Project {
  const project = newProject("試し", pages);
  for (const page of project.pages) {
    for (let s = 0; s < 5; s++) {
      addStroke(project, page, [[10 + s, 10, 0.5], [20 + s, 15, 0.7], [30 + s, 12.345678901, 0.333333]], 0.5);
    }
  }
  return project;
}

describe("Snapshotter", () => {
  it("brings back what was taken, sharing the point lists", () => {
    const project = drawn();
    const snapshots = new Snapshotter<Project>();
    const back = snapshots.restore(snapshots.take(project));
    expect(back).toEqual(project);
    expect(back.pages[1].strokes[2].points).toBe(project.pages[1].strokes[2].points);
  });

  it("brings back held panels and other options with their lists too", () => {
    const project = drawn(2);
    project.held = [{ id: "held1", panel: { id: "p", shape: [], order: 1 } as never, lines: [], strokes: [project.pages[0].strokes[0]] }];
    const snapshots = new Snapshotter<Project>();
    const back = snapshots.restore(snapshots.take(project));
    expect(back).toEqual(project);
    expect(back.held![0].strokes[0].points).toBe(project.pages[0].strokes[0].points);
  });

  it("keeps unchanged pages once", () => {
    const project = drawn();
    const snapshots = new Snapshotter<Project>();
    const first = snapshots.take(project);
    moveStroke(project.pages[1].strokes[0], 5, 0);
    const second = snapshots.take(project);
    expect(second.pages[0]).toBe(first.pages[0]);
    expect(second.pages[2]).toBe(first.pages[2]);
    expect(second.pages[1]).not.toBe(first.pages[1]);
    expect(sameSnapshot(first, second)).toBe(false);
    expect(sameSnapshot(second, snapshots.take(project))).toBe(true);
  });

  it("notices a page added in front", () => {
    const project = drawn();
    const snapshots = new Snapshotter<Project>();
    const first = snapshots.take(project);
    project.pages.unshift({ ...project.pages[0], id: "new", strokes: [] });
    const second = snapshots.take(project);
    expect(second.pages[1]).toBe(first.pages[0]);
    expect(snapshots.restore(second).pages[0].id).toBe("new");
  });

  it("shares balloon outlines too, and brings them back as they were", () => {
    const project = drawn(2);
    const line = addLine(project, project.pages[1], [50, 70]);
    setLineText(line, "セリフ");
    expect(line.balloon?.length).toBeGreaterThan(4);
    const snapshots = new Snapshotter<Project>();
    const taken = snapshots.take(project);
    const back = snapshots.restore(taken);
    expect(back).toEqual(project);
    expect(back.pages[1].lines[0].balloon).toBe(line.balloon);
    // The page's text holds only a number for the outline.
    expect(taken.pages[1].json).not.toContain(String(line.balloon![1][0]));
    // A balloon moved has a new outline: the page is taken anew.
    moveLine(line, 3, 0);
    expect(snapshots.take(project).pages[1]).not.toBe(taken.pages[1]);
  });

  it("freezes the shared lists in development, so a change in place fails", () => {
    const project = drawn(1);
    new Snapshotter<Project>().take(project);
    const points = project.pages[0].strokes[0].points;
    expect(Object.isFrozen(points)).toBe(true);
    expect(() => points.push([0, 0, 0])).toThrow();
    expect(() => (points[0][0] = 1)).toThrow();
  });

  it("undoes and redoes a drawn name through History", () => {
    let project = drawn();
    const history = new History<Project, ReturnType<Snapshotter<Project>["take"]>>(new Snapshotter<Project>());
    const before = structuredClone(project);
    history.record(project);
    moveStroke(project.pages[0].strokes[0], 1, 1);
    project.pages[2].strokes.pop();
    const after = structuredClone(project);
    project = history.undo(project)!;
    expect(project).toEqual(before);
    project = history.redo(project)!;
    expect(project).toEqual(after);
  });
});

describe("projectJson", () => {
  it("writes the same project as JSON, points to 0.01 mm", () => {
    const project = drawn(2);
    project.title = 'a "quoted" \u0001 title';
    const text = projectJson(project);
    const back = JSON.parse(text) as Project;
    expect(back.title).toBe(project.title);
    expect(back.pages[0].strokes[0].points[2]).toEqual([30, 12.35, 0.333]);
    const { pages, ...rest } = back;
    const { pages: _, ...expected } = project;
    expect(rest).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(pages.map((p) => p.strokes.length)).toEqual([5, 5]);
  });

  it("reuses the text of unchanged lists and writes changed ones anew", () => {
    const project = drawn(1);
    const first = projectJson(project);
    expect(projectJson(project)).toBe(first);
    moveStroke(project.pages[0].strokes[0], 1, 0);
    const moved = JSON.parse(projectJson(project)) as Project;
    expect(moved.pages[0].strokes[0].points[0]).toEqual([11, 10, 0.5]);
  });

  it("writes pages, held panels and other options as one replacer over everything would", () => {
    const project = drawn(2);
    project.held = [{ id: "held1", panel: { id: "p", shape: [[0, 0], [1, 0], [1, 1]], order: 1 } as never, lines: [], strokes: [project.pages[0].strokes[0]] }];
    project.alternatives = [{ id: "alt", from: 0, to: 0, active: "a", options: [{ id: "b", name: "案2", pages: [JSON.parse(JSON.stringify(project.pages[1]))] }] } as never];
    // Every point list, wherever it is, written as the saved text writes it.
    const round = (points: number[][]) => points.map((point) => point.map((v, i) => Math.round(v * (i < 2 ? 100 : 1000)) / (i < 2 ? 100 : 1000)));
    const plain = JSON.stringify(project, (key, value: unknown) => (key === "points" && Array.isArray(value) ? round(value as number[][]) : value));
    expect(projectJson(project)).toBe(plain);
  });

  it("writes balloon outlines to 0.001 mm, once for each outline", () => {
    const project = drawn(1);
    const line = addLine(project, project.pages[0], [50, 70]);
    setLineText(line, "セリフ");
    line.balloon = [[1.23456789, 2.000049], [3.1, 4.9999999], [5, 6]];
    const back = JSON.parse(projectJson(project)) as Project;
    expect(back.pages[0].lines[0].balloon).toEqual([[1.235, 2], [3.1, 5], [5, 6]]);
    const { balloon: _, ...rest } = back.pages[0].lines[0];
    const { balloon: __, ...expected } = line;
    expect(rest).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(projectJson(project)).toBe(projectJson(project));
  });

  it("writes numbers JSON cannot hold as 0", () => {
    const project = newProject("x", 1);
    project.pages[0].strokes.push({ id: "s", points: [[NaN, 1, Infinity]], widthMm: 1, closed: false });
    expect(JSON.parse(projectJson(project)).pages[0].strokes[0].points).toEqual([[0, 1, 0]]);
  });

  it("packs a request body as length, meta and the project text", () => {
    const project = drawn(1);
    const body = projectBody({ path: "a.namestudio" }, project);
    const length = new DataView(body.buffer).getUint32(0, true);
    const decoder = new TextDecoder();
    expect(JSON.parse(decoder.decode(body.slice(4, 4 + length)))).toEqual({ path: "a.namestudio" });
    expect(decoder.decode(body.slice(4 + length))).toBe(projectJson(project));
  });
});

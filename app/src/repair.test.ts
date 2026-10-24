import { describe, expect, it } from "vitest";
import { addCharacter, addLine, addPanel, addScene, newProject, rectShape } from "./project";
import { repair } from "./repair";

describe("repair", () => {
  it("leaves a sound project as it is", () => {
    const project = newProject("a", 2);
    const before = structuredClone(project);
    expect(repair(project)).toEqual([]);
    expect(project).toEqual(before);
  });

  it("mends loose ends the save check would refuse", () => {
    const project = newProject("a", 3);
    const [p1, p2] = project.pages;
    const panel = addPanel(project, p1, rectShape([10, 10, 50, 50]));
    const line = addLine(project, p1, [20, 20]);
    const twin = addLine(project, p1, [30, 30]);
    line.speaker = "gone";
    line.panel = "nowhere";
    line.linkTo = line.id;
    twin.id = line.id;
    p2.panels.push({ ...panel, id: "", shape: [[0, 0], [1, 1]] });
    const scene = addScene(project, p2.id, p1.id, "逆");
    project.emotions.push({ character: "gone", page: p1.id, value: 0.5, note: "" });
    const hero = addCharacter(project, "主人公");
    project.emotions.push({ character: hero.id, page: p1.id, value: 3, note: "" });
    p1.strokes.push({ id: "stroke999", points: [[0, 0, 1], [1, 1, 1]], widthMm: 1, closed: false });
    const mended = repair(project);
    expect(mended.length).toBeGreaterThanOrEqual(8);
    expect(line.speaker).toBeUndefined();
    expect(line.panel).toBeUndefined();
    expect(twin.id).not.toBe(line.id);
    // The first holder (in reading order) keeps the id; a link to it from the other stays.
    expect(p1.lines.every((l) => l.linkTo !== l.id)).toBe(true);
    expect(p2.panels).toHaveLength(0);
    expect(project.scenes[0].firstPage).toBe(p1.id);
    expect(scene.lastPage).toBe(p2.id);
    expect(project.emotions).toEqual([{ character: hero.id, page: p1.id, value: 1, note: "" }]);
    expect(project.nextId).toBeGreaterThan(999);
    expect(repair(project)).toEqual([]);
  });

  it("turns a spread panel that lost its other half into a plain one", () => {
    const project = newProject("a", 4);
    const a = addPanel(project, project.pages[0], rectShape([10, 10, 50, 50]));
    const b = addPanel(project, project.pages[2], rectShape([10, 10, 50, 50]));
    a.spread = b.spread = "s1";
    repair(project);
    expect(a.spread).toBeUndefined();
    expect(b.spread).toBeUndefined();
  });
});

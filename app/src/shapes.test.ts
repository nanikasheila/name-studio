import { beforeEach, describe, expect, it } from "vitest";
import { addScene, newProject, STRUCTURES } from "./project";
import {
  addBeat,
  adoptShape,
  beatPage,
  currentShape,
  editableShape,
  keepShape,
  libraryShapes,
  makeShape,
  MIN_SHARE,
  moveBoundary,
  pageParts,
  removePart,
  removeShape,
  setBeat,
  shapeSpans,
  splitPart,
  storyShapes,
} from "./shapes";
import { moveSceneEdge, planAdvice, sceneSpans, setStoryRank, timeline } from "./story";

const range = (spans: { first: number; last: number }[]) => spans.map((s) => `${s.first + 1}-${s.last + 1}`);

describe("話の型", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.assign(globalThis, {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    });
  });

  it("lays Save the Cat over a 32-page name, its beats on pages", () => {
    const shape = STRUCTURES.saveTheCat;
    expect(range(shapeSpans(shape, 32))).toEqual(["1-3", "4-7", "8-16", "17-22", "23-25", "26-32"]);
    const beats = Object.fromEntries((shape.beats ?? []).map((beat) => [beat.name, beatPage(beat.at, 32) + 1]));
    expect(beats["オープニング・イメージ"]).toBe(1);
    expect(beats["ミッドポイント"]).toBe(17);
    expect(beats["ファイナル・イメージ"]).toBe(32);
  });

  it("gives every part a page and ends on the last page", () => {
    const shape = { id: "x", label: "x", parts: [{ name: "a", share: 0.98 }, { name: "b", share: 0.01 }, { name: "c", share: 0.01 }] };
    expect(range(shapeSpans(shape, 5))).toEqual(["1-3", "4-4", "5-5"]);
    expect(shapeSpans(shape, 2)).toEqual([]);
  });

  it("colours pages by the part they fall in", () => {
    const project = newProject("t", 8);
    expect(pageParts(project).every((part) => part === undefined)).toBe(true);
    project.plan = { structure: "kishotenketsu" };
    const parts = pageParts(project).map((part) => part?.name);
    expect(parts).toEqual(["起", "起", "承", "承", "転", "転", "結", "結"]);
    expect(new Set(pageParts(project).map((part) => part?.color)).size).toBe(4);
  });

  it("copies a built-in shape before changing it, and keeps it on this computer", () => {
    const project = newProject("t", 20);
    project.plan = { structure: "threeAct" };
    const own = editableShape(project)!;
    expect(own.id).not.toBe("threeAct");
    expect(own.label).toBe("三幕構成（自分用）");
    expect(project.plan.structure).toBe(own.id);
    expect(STRUCTURES.threeAct.parts[0].share).toBe(0.25);
    // Already own: changed in place.
    expect(editableShape(project)).toBe(own);
    moveBoundary(own, 0, 0.1);
    expect(range(shapeSpans(own, 20))).toEqual(["1-2", "3-15", "16-20"]);
    expect(STRUCTURES.threeAct.parts[0].share).toBe(0.25);
    keepShape(own);
    // Another name takes it from this computer.
    const other = newProject("u", 10);
    const [kept] = libraryShapes();
    expect(kept.label).toBe("三幕構成（自分用）");
    adoptShape(other, kept);
    adoptShape(other, kept);
    expect(other.plan?.shapes).toHaveLength(1);
    expect(currentShape(other)?.parts[0].share).toBeCloseTo(0.1);
    expect(storyShapes(other).map((s) => s.label)).toContain("三幕構成（自分用）");
  });

  it("moves a boundary, keeping both parts", () => {
    const shape = makeShape(newProject("t", 1));
    moveBoundary(shape, 0, -1);
    expect(shape.parts[0].share).toBe(MIN_SHARE);
    moveBoundary(shape, 1, 0.5);
    const total = shape.parts.reduce((sum, part) => sum + part.share, 0);
    expect(total).toBeCloseTo(1, 3);
    expect(shape.parts[0].share + shape.parts[1].share).toBeCloseTo(0.5, 3);
  });

  it("splits and removes parts, adds and moves beats, removes own shapes", () => {
    const project = newProject("t", 12);
    const shape = makeShape(project);
    splitPart(shape, 0, "前半");
    expect(shape.parts.map((p) => p.name)).toEqual(["はじまり", "前半", "なか", "おわり"]);
    removePart(shape, 1);
    expect(shape.parts.map((p) => p.share)).toEqual([1, 1, 1]);
    addBeat(shape, "転機", 0.8);
    addBeat(shape, "事件", 0.2);
    expect(shape.beats?.map((b) => b.name)).toEqual(["事件", "転機"]);
    setBeat(shape, 1, 0.1);
    expect(shape.beats?.map((b) => b.name)).toEqual(["転機", "事件"]);
    expect(planAdvice(project).some((a) => a.text === "転機: 2 ページあたり")).toBe(true);
    removeShape(project, shape.id);
    expect(project.plan).toBeUndefined();
  });
});

describe("全体ボードでの直し", () => {
  const titles = (project: ReturnType<typeof newProject>) => sceneSpans(project).map((s) => `${s.scene.title}:${s.first + 1}-${s.last + 1}`);

  it("moves a scene end, and the scene next to it follows", () => {
    const project = newProject("t", 10);
    const id = (i: number) => project.pages[i].id;
    const a = addScene(project, id(0), id(3), "A");
    addScene(project, id(4), id(6), "B");
    expect(moveSceneEdge(project, a.id, "last", 5)).toBe(true);
    expect(titles(project)).toEqual(["A:1-6", "B:7-7"]);
    // B keeps one page.
    moveSceneEdge(project, a.id, "last", 9);
    expect(titles(project)).toEqual(["A:1-6", "B:7-7"]);
    // Into the gap after B, up to the end.
    const b = project.scenes.find((s) => s.title === "B")!;
    moveSceneEdge(project, b.id, "last", 20);
    expect(titles(project)).toEqual(["A:1-6", "B:7-10"]);
    expect(moveSceneEdge(project, a.id, "first", 0)).toBe(false);
  });

  it("puts a scene earlier in story time and drops orders that match the pages", () => {
    const project = newProject("t", 6);
    const id = (i: number) => project.pages[i].id;
    const a = addScene(project, id(0), id(1), "A");
    const b = addScene(project, id(2), id(3), "B");
    const c = addScene(project, id(4), id(5), "C");
    expect(setStoryRank(project, c.id, 0)).toBe(true);
    expect([a.storyOrder, b.storyOrder, c.storyOrder]).toEqual([2, 3, 1]);
    expect(timeline(project).map((row) => row.flashback)).toEqual([false, false, true]);
    setStoryRank(project, c.id, 2);
    expect([a.storyOrder, b.storyOrder, c.storyOrder]).toEqual([undefined, undefined, undefined]);
  });
});

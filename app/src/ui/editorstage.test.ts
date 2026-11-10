// The pages on screen, on their own: no tools, no selection, no drawing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorStage } from "./editorstage";
import { toPage } from "../editing/layout";
import type { Project } from "../model/model";
import { newProject } from "../domain/project";

const STAGE = { width: 1200, height: 800, left: 10, top: 20 };

function stage(project: Project | null) {
  const calls = { draw: 0, requestDraw: 0, status: [] as string[] };
  const canvas = { width: 0, height: 0, getBoundingClientRect: () => STAGE } as unknown as HTMLCanvasElement;
  const ctx = {
    font: "",
    measureText: (text: string) => ({ width: text.length * 7 }),
    setTransform: () => {},
    save: () => {},
    restore: () => {},
  } as unknown as CanvasRenderingContext2D;
  const made = new EditorStage(canvas, ctx, {
    project: () => project,
    status: (message) => void calls.status.push(message),
    draw: () => {
      calls.draw += 1;
      if (project) made.arrange(project);
    },
    requestDraw: () => void (calls.requestDraw += 1),
  });
  if (project) made.arrange(project);
  return { stage: made, calls };
}

const wheel = (change: Partial<WheelEvent>): WheelEvent =>
  ({ deltaX: 0, deltaY: 0, offsetX: 600, offsetY: 400, ctrlKey: false, metaKey: false, shiftKey: false, ...change }) as WheelEvent;

describe("the pages on screen (EditorStage)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    // No sliding: the pages are where they go at once.
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows spreads, the first page on its own; one page at a time with 単独", () => {
    const { stage: s } = stage(newProject("t", 5));
    expect(s.spreadList()).toEqual([
      [null, 1],
      [2, 3],
      [4, 5],
    ]);
    s.firstAlone = false;
    expect(s.spreadList()[0]).toEqual([1, 2]);
    s.single = true;
    expect(s.spreadList()).toEqual([1, 2, 3, 4, 5].map((page) => [page, null]));
  });

  it("goes to the spread of a page and draws it", () => {
    const project = newProject("t", 6);
    const { stage: s, calls } = stage(project);
    s.showPage(4);
    expect(s.spreadIndex).toBe(2);
    expect(s.currentPages()).toEqual([4, 5]);
    expect(s.focusedPageId).toBe(project.pages[3].id);
    expect(calls.draw).toBe(1);
    expect(s.slots.map((slot) => slot.index).sort()).toEqual([3, 4]);
    s.flip(-5);
    expect(s.spreadIndex).toBe(0);
  });

  it("連続: has every page on the canvas, and the spread worked on follows the page touched", () => {
    const project = newProject("t", 6);
    const { stage: s } = stage(project);
    s.continuous = true;
    s.arrange(project);
    expect(s.slots).toHaveLength(6);
    const fifth = s.slots.find((slot) => slot.index === 4)!;
    expect(s.focusOn(fifth)).toBe(true);
    expect(s.spreadIndex).toBe(2);
    expect(s.focusedPageId).toBe(project.pages[4].id);
    // The same spread again: nothing to tell.
    expect(s.focusOn(s.slots.find((slot) => slot.index === 3)!)).toBe(false);
  });

  it("zooms with the wheel about the pointer: the page point under it stays under it", () => {
    const project = newProject("t", 4);
    const { stage: s, calls } = stage(project);
    s.showPage(2);
    const slot = s.slots[0];
    const at: [number, number] = [slot.x + 40 * slot.scale, slot.y + 60 * slot.scale];
    const before = toPage(slot, ...at);
    s.wheel(wheel({ deltaY: -400, offsetX: at[0], offsetY: at[1] }), project);
    expect(s.view.zoom).toBeGreaterThan(1.5);
    const after = s.slots.find((x) => x.index === slot.index)!;
    expect(after.scale).toBeGreaterThan(slot.scale);
    const now = toPage(after, ...at);
    expect(now[0]).toBeCloseTo(before[0], 3);
    expect(now[1]).toBeCloseTo(before[1], 3);
    expect(calls.draw).toBe(2);
  });

  it("goes along the row with Shift+ホイール, onward in reading order", () => {
    const right = newProject("t", 4);
    const { stage: a } = stage(right);
    a.wheel(wheel({ deltaY: 50, shiftKey: true }), right);
    expect(a.view.pan[0]).toBe(50);
    const left = newProject("t", 4);
    left.binding = "left";
    const { stage: b } = stage(left);
    b.wheel(wheel({ deltaY: 50, shiftKey: true }), left);
    expect(b.view.pan[0]).toBe(-50);
  });

  it("tells where a page point is in the window, and back", () => {
    const project = newProject("t", 4);
    const { stage: s } = stage(project);
    s.showPage(3);
    const page = project.pages[2];
    const client = s.clientOf(page.id, [30, 45])!;
    const found = s.pageAtClient(client[0], client[1])!;
    expect(found.page.id).toBe(page.id);
    expect(found.point[0]).toBeCloseTo(30);
    expect(found.point[1]).toBeCloseTo(45);
    // A page not shown is nowhere.
    expect(s.clientOf(project.pages[0].id, [0, 0])).toBeNull();
  });

  it("leaves out what is hidden on screen: the 付箋 all together, or one thing from the レイヤー list", () => {
    const project = newProject("t", 2);
    const page = project.pages[0];
    page.stickies = [{ id: "s1", at: [10, 10], text: "あとで" }];
    page.strokes.push({
      id: "k1",
      points: [
        [1, 1, 1],
        [5, 5, 1],
      ],
      widthMm: 0.4,
      closed: false,
    });
    const { stage: s } = stage(project);
    expect(s.visiblePage(page).stickies).toHaveLength(1);
    s.showStickies = false;
    expect(s.visiblePage(page).stickies ?? []).toHaveLength(0);
    s.hidden.add("stroke:k1");
    expect(s.visiblePage(page).strokes).toHaveLength(0);
    expect(page.strokes).toHaveLength(1);
  });
});

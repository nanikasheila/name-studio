import { describe, expect, it } from "vitest";
import type { Panel, Project } from "../model/model";
import {
  GROUND,
  MATERIALS,
  WALLS,
  lookInstruction,
  lookOf,
  lookWords,
  setLook,
  setMaterial,
  setWindow,
  shareLook,
  windowOf,
} from "./bglook";
import { applyAnswers } from "./bgreview";
import { backgroundOf } from "./background";
import { newProject } from "./project";

const square = (y: number): [number, number][] => [
  [20, y],
  [120, y],
  [120, y + 50],
  [20, y + 50],
];

function panel(id: string, y: number): Panel {
  return { id, order: 1, shape: square(y) };
}

describe("見た目（光と材質）", () => {
  it("is set, put in words and taken out when emptied", () => {
    const one = panel("a", 20);
    one.background = { objects: [{ id: "o1", label: "ソファ", shape: square(30) }] };
    setLook(one, { develop: true, timeOfDay: "evening", setting: "indoor", light: "window" });
    setMaterial(one, "o1", "布");
    setMaterial(one, GROUND, "木");
    expect(lookWords(one)).toBe("作画まで・夕方・屋内・窓から・ソファ=布・床=木");
    expect(lookInstruction(one)).toEqual({
      stage: "develop",
      look: {
        timeOfDay: "evening",
        setting: "indoor",
        light: { key: "window" },
        materials: [
          { target: "o1", material: "布" },
          { target: GROUND, material: "木" },
        ],
      },
    });
    // Outdoors a window is no light: it is dropped.
    setLook(one, { setting: "outdoor" });
    expect(lookOf(one).light).toBeUndefined();
    setMaterial(one, "o1", undefined);
    expect(lookOf(one).materials).toEqual([{ target: GROUND, material: "木" }]);
    setLook(one, { develop: false, timeOfDay: undefined, setting: undefined, materials: [] });
    expect(one.background?.look).toBeUndefined();
    expect(lookInstruction(one)).toEqual({ stage: "blockout" });
  });

  it("names only materials name-blockout has", () => {
    expect(MATERIALS.map((one) => one.name)).toEqual([
      "白壁",
      "コンクリート",
      "木",
      "金属",
      "トタン",
      "ガラス",
      "瓦",
      "アスファルト",
      "土",
      "草",
      "布",
      "黒い塗装",
      "水",
    ]);
  });

  it("is shared with the rest of the scene (time, weather, indoors, light; not the materials)", () => {
    const project: Project = newProject("試し", 3);
    const [p1, p2, p3] = project.pages;
    p1.panels.push(panel("a", 20), panel("b", 80));
    p2.panels.push(panel("c", 20));
    p3.panels.push(panel("d", 20));
    p2.panels[0].background = { none: true };
    project.scenes = [{ id: "s1", title: "夕方の部屋", summary: "", firstPage: p1.id, lastPage: p2.id }];
    const a = p1.panels[0];
    setLook(a, { develop: true, timeOfDay: "evening", weather: "rain", setting: "indoor", light: "interior" });
    setMaterial(a, GROUND, "木");
    expect(shareLook(project, "a")).toBe(1);
    expect(lookOf(p1.panels[1])).toEqual({ timeOfDay: "evening", weather: "rain", setting: "indoor", light: "interior" });
    expect(p2.panels[0].background).toEqual({ none: true });
    expect(p3.panels[0].background).toBeUndefined();
  });
});

describe("the room indoors", () => {
  it("keeps the window as name-blockout's room.windows, and the walls' material", () => {
    const one = panel("a", 0);
    setLook(one, { setting: "indoor", develop: true });
    expect(windowOf(one)).toBeUndefined();
    setWindow(one, "right");
    expect(windowOf(one)).toBe("right");
    setMaterial(one, WALLS, "コンクリート");
    expect(lookWords(one)).toBe("作画まで・屋内・窓は右・壁=コンクリート");
    expect(lookInstruction(one).look?.materials).toEqual([{ target: WALLS, material: "コンクリート" }]);
    const shot: Record<string, unknown> = {};
    applyAnswers(shot, backgroundOf(one).answers);
    expect(shot.room).toEqual({ windows: [{ wall: "right" }] });
    setWindow(one, "none");
    expect(windowOf(one)).toBe("none");
    expect(lookWords(one)).toContain("窓なし");
    setWindow(one, undefined);
    expect(windowOf(one)).toBeUndefined();
    expect(backgroundOf(one).answers ?? []).toEqual([]);
  });
});

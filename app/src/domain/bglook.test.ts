import { describe, expect, it } from "vitest";
import type { Panel, Project } from "../model/model";
import { GROUND, MATERIALS, lookInstruction, lookOf, lookWords, setLook, setMaterial, shareLook } from "./bglook";
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

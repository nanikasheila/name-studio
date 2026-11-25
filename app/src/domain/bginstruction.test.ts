import { describe, expect, it } from "vitest";
import type { Project } from "../model/model";
import { requestInstruction, INSTRUCTION_FORMAT, INSTRUCTION_VERSION } from "./bginstruction";
import { newProject } from "./project";

function project(): Project {
  const p = newProject("試し", 1);
  p.pages[0].panels.push({
    id: "panel1",
    order: 1,
    shape: [
      [20, 20],
      [220, 20],
      [220, 120],
      [20, 120],
    ],
    note: "見上げ",
    background: {
      brief: "街角\n夕方",
      perspective: 2,
      horizon: [
        [20, 70],
        [220, 70],
      ],
      vanishing: [
        [-60, 70],
        [330, 70],
      ],
      place: "教室",
      objects: [
        {
          id: "object1",
          label: "倉庫",
          shape: [
            [40, 40],
            [100, 40],
            [100, 110],
            [40, 110],
          ],
        },
      ],
    },
  });
  p.pages[0].panels.push({
    id: "panel2",
    order: 2,
    shape: [
      [20, 130],
      [220, 130],
      [220, 200],
      [20, 200],
    ],
  });
  return p;
}

interface Shot {
  id: string;
  label: string;
  frame: { boxMm: number[]; sizePx: number[] };
  intent?: unknown;
  ruler?: { points: number; horizonMm: number[][] };
  camera?: { hint: { mode: string; lensFromPoints: boolean } };
  place?: unknown;
  objects: unknown[];
  output: unknown;
}

const request = {
  stamp: "20261126-010000",
  targets: [{ panel: "panel1" }, { panel: "panel2" }, { panel: "gone" }],
  note: "今回は箱で",
  dpi: 600,
  folder: "C:/w/試し_背景",
  blender: null,
};

describe("指示.json for name-blockout", () => {
  it("writes the request as the name-blockout instruction (v1): the picture, the ruler in mm, the camera as a hint", () => {
    const data = requestInstruction(project(), request, [{ panel: "panel1", take: "2", files: { 完成: "案/panel1/2/完成.png" } }], {
      version: "0.2.170",
    });
    expect(data.format).toBe(INSTRUCTION_FORMAT);
    expect(data.formatVersion).toBe(INSTRUCTION_VERSION);
    expect(data.request).toEqual({ id: "20261126-010000", note: "今回は箱で" });
    const shots = data.shots as Shot[];
    expect(shots.map((s) => s.id)).toEqual(["panel1", "panel2"]);
    const [one, two] = shots;
    expect(one.label).toBe("p1 コマ1");
    expect(one.frame.boxMm).toEqual([17, 17, 223, 123]);
    expect(one.frame.sizePx).toEqual([4866, 2504]);
    expect(one.intent).toEqual({ brief: "街角 / 夕方", memo: "見上げ" });
    expect(one.ruler?.points).toBe(2);
    expect(one.ruler?.horizonMm).toEqual([
      [20, 70],
      [220, 70],
    ]);
    expect(one.camera?.hint.mode).toBe("level");
    expect(one.camera?.hint.lensFromPoints).toBe(true);
    expect(one.place).toEqual({ asset: "教室" });
    expect(one.objects[0]).toEqual({
      id: "object1",
      label: "倉庫",
      shapeMm: [
        [40, 40],
        [100, 40],
        [100, 110],
        [40, 110],
      ],
    });
    expect(one.output).toEqual({ take: "3" });
    // A panel without instructions: its picture only (name-blockout asks what is missing).
    expect(two.ruler).toBeUndefined();
    expect(two.camera).toBeUndefined();
    expect(two.output).toEqual({ take: "1" });
  });
});

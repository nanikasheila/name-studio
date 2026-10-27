import { describe, expect, it } from "vitest";
import { dropPlan } from "./drophint";
import { bounds, rectShape } from "./geometry";
import { holdPanel } from "./hold";
import { addPanel } from "./panels";
import { newProject } from "./project";

describe("where a held panel would go", () => {
  const project = newProject("t", 2);
  const [one, two] = project.pages;
  const panel = addPanel(project, one, rectShape([20, 20, 80, 60]));
  const held = holdPanel(project, one, panel);
  const target = addPanel(project, two, rectShape([100, 100, 160, 160]));

  it("fills the panel it is dropped on", () => {
    const plan = dropPlan(project, held, { page: two, point: [120, 120], panel: target });
    expect(plan.kind).toBe("into");
    expect(plan.shape).toEqual(target.shape);
    expect(plan.text).toBe(`2 ページのコマ ${target.order} に中身を入れる`);
  });

  it("is put where it is dropped, centred there", () => {
    const plan = dropPlan(project, held, { page: two, point: [60, 200] });
    expect(plan.kind).toBe("place");
    expect(bounds(plan.shape)).toEqual([30, 180, 90, 220]);
  });

  it("goes in the 欄外 when dropped off the page", () => {
    const plan = dropPlan(project, held, { page: one, point: [-30, 100] });
    expect(plan.kind).toBe("aside");
    expect(plan.text).toBe("1 ページの欄外に置く");
  });
});

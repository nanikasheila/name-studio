import { describe, expect, it } from "vitest";
import { addCharacter, addLine, addScene, newProject, setEmotion } from "./project";
import { emotionSeries, pageStats, sceneSpans, timeline, uncoveredRuns } from "./story";

function sample() {
  const project = newProject("test", 6);
  const ids = project.pages.map((page) => page.id);
  const present = addScene(project, ids[0], ids[1], "今");
  const past = addScene(project, ids[2], ids[3], "昔");
  const after = addScene(project, ids[5], ids[5], "その後");
  present.storyOrder = 2;
  past.storyOrder = 1;
  after.storyOrder = 3;
  return { project, ids };
}

describe("story", () => {
  it("finds scenes and the pages between them", () => {
    const { project } = sample();
    expect(sceneSpans(project).map((span) => [span.first, span.last])).toEqual([[0, 1], [2, 3], [5, 5]]);
    expect(uncoveredRuns(project)).toEqual([[4, 4]]);
  });

  it("marks scenes told after later events as flashbacks", () => {
    const { project } = sample();
    const rows = timeline(project);
    expect(rows.map((row) => row.scene.title)).toEqual(["今", "昔", "その後"]);
    expect(rows.map((row) => row.storyRank)).toEqual([1, 0, 2]);
    expect(rows.map((row) => row.flashback)).toEqual([false, true, false]);
  });

  it("keeps page order when no story order is set", () => {
    const { project } = sample();
    for (const scene of project.scenes) delete scene.storyOrder;
    expect(timeline(project).map((row) => row.storyRank)).toEqual([0, 1, 2]);
    expect(timeline(project).some((row) => row.flashback)).toBe(false);
  });

  it("orders emotion values by page and counts text", () => {
    const { project, ids } = sample();
    const hero = addCharacter(project, "主人公");
    setEmotion(project, hero.id, ids[3], -0.5);
    setEmotion(project, hero.id, ids[0], 0.25, "期待");
    expect(emotionSeries(project, hero.id)).toEqual([
      { index: 0, value: 0.25, note: "期待" },
      { index: 3, value: -0.5, note: "" },
    ]);
    addLine(project, project.pages[1], [100, 100], "あい う");
    expect(pageStats(project)[1].characters).toBe(3);
  });
});

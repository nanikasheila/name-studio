import { describe, expect, it } from "vitest";
import { sampleName } from "./samplename";

describe("the sample name", () => {
  it("has eight pages with panels, dialogue, rough lines and a story", () => {
    const project = sampleName();
    expect(project.pages).toHaveLength(8);
    for (const page of project.pages) {
      expect(page.panels.length).toBeGreaterThanOrEqual(3);
      expect(page.lines.length).toBeGreaterThanOrEqual(2);
    }
    expect(project.pages.filter((page) => page.strokes.length > 0).length).toBeGreaterThanOrEqual(6);
    expect(project.characters.map((c) => c.name)).toEqual(["ミオ", "レイ", "ナツ"]);
    expect(project.scenes).toHaveLength(3);
    expect(project.pages.some((page) => (page.stickies?.length ?? 0) > 0)).toBe(true);
  });

  it("is the same every time", () => {
    expect(JSON.stringify(sampleName())).toBe(JSON.stringify(sampleName()));
  });

  it("has every line said by one of its characters (or by no one: the narration)", () => {
    const project = sampleName();
    const ids = project.characters.map((c) => c.id);
    for (const line of project.pages.flatMap((page) => page.lines)) {
      if (line.kind === "narration") expect(line.speaker).toBeUndefined();
      else expect(ids).toContain(line.speaker);
    }
  });
});

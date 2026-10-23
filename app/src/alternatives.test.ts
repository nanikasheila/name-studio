import { describe, expect, it } from "vitest";
import { alternativesOf, makeAlternative, optionPages, removeAlternative, useAlternative } from "./alternatives";
import { addCharacter, addLine, addPanel, addScene, insertPage, newProject, rectShape, removePage, setEmotion } from "./project";

describe("別案", () => {
  const setup = () => {
    const project = newProject("t", 4);
    const page = project.pages[1];
    const panel = addPanel(project, page, rectShape([10, 10, 110, 110]));
    const line = addLine(project, page, [50, 50], "元のセリフ");
    return { project, page, panel, line };
  };

  it("makes a copy to change and keeps the pages as they were", () => {
    const { project, page, panel, line } = setup();
    const set = makeAlternative(project, 1, 1)!;
    expect(set.options.map((option) => option.name)).toEqual(["案A", "案B"]);
    const copy = project.pages[1];
    expect(copy.id).not.toBe(page.id);
    expect(copy.lines[0].text).toBe("元のセリフ");
    expect(copy.lines[0].id).not.toBe(line.id);
    expect(copy.lines[0].panel).toBe(copy.panels[0].id);
    expect(copy.panels[0].id).not.toBe(panel.id);
    expect(set.options[0].pages).toEqual([page]);
    expect(alternativesOf(project, copy.id)).toBe(set);
    // Changing the copy leaves the original alone.
    copy.lines[0].text = "直したセリフ";
    expect(page.lines[0].text).toBe("元のセリフ");
  });

  it("switches between options, with scenes and emotions following", () => {
    const { project, page } = setup();
    const [p1, , p3] = project.pages.map((p) => p.id);
    const scene = addScene(project, page.id, p3, "S");
    const hero = addCharacter(project, "主人公");
    setEmotion(project, hero.id, page.id, 2, "");
    const set = makeAlternative(project, 1, 1)!;
    const copy = project.pages[1];
    expect(scene.firstPage).toBe(copy.id);
    expect(project.emotions[0].page).toBe(copy.id);
    // A longer version: one more page in the option (another ページ配分).
    const added = insertPage(project, 2);
    set.pageIds.push(added.id);
    expect(useAlternative(project, set.id, set.options[0].id)).toBe(true);
    expect(project.pages.map((p) => p.id)).toEqual([p1, page.id, p3, project.pages[3].id]);
    expect(project.pages.length).toBe(4);
    expect(optionPages(project, set, set.options[1]).map((p) => p.id)).toEqual([copy.id, added.id]);
    expect(scene.firstPage).toBe(page.id);
    expect(project.emotions[0].page).toBe(page.id);
    expect(useAlternative(project, set.id, set.options[1].id)).toBe(true);
    expect(project.pages.length).toBe(5);
    expect(project.pages[2].id).toBe(added.id);
  });

  it("adds options to a set and removes ones not in use", () => {
    const { project } = setup();
    const set = makeAlternative(project, 1, 1)!;
    makeAlternative(project, 1, 1);
    expect(set.options.map((option) => option.name)).toEqual(["案A", "案B", "案C"]);
    expect(set.active).toBe(set.options[2].id);
    expect(removeAlternative(project, set.id, set.active)).toBe(false);
    expect(removeAlternative(project, set.id, set.options[0].id)).toBe(true);
    expect(removeAlternative(project, set.id, set.options[0].id)).toBe(true);
    expect(project.alternatives).toBeUndefined();
  });

  it("goes with its page when the page is removed", () => {
    const { project } = setup();
    makeAlternative(project, 1, 1);
    removePage(project, project.pages[1].id);
    expect(project.alternatives).toBeUndefined();
  });
});

describe("別案の範囲", () => {
  it("does not make a set that overlaps another", () => {
    const project = newProject("t", 4);
    makeAlternative(project, 1, 1);
    expect(makeAlternative(project, 0, 1)).toBeNull();
    expect(makeAlternative(project, 2, 3)).not.toBeNull();
    expect(project.alternatives?.length).toBe(2);
  });
});

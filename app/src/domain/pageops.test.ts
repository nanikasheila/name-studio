import { describe, expect, it } from "vitest";
import { makeAlternative } from "./alternatives";
import { addCharacter, addScene, setEmotion } from "./cast";
import { rectShape } from "../model/geometry";
import { holdPanel } from "./hold";
import type { Project } from "../model/model";
import {
  cannotRemove,
  clipPages,
  deletePages,
  duplicatePages,
  holdPages,
  insertBlankPages,
  pastePages,
  restoreHeldPages,
  runsOf,
  trailingEmptyIds,
  withPartners,
} from "./pageops";
import { addPanel } from "./panels";
import { newProject, pageIsEmpty } from "./project";
import { repair } from "./repair";

const ids = (project: Project) => project.pages.map((page) => page.id);

/** Pages 1..n, the second and third a 見開き with a panel across the gutter. */
function withSpread(n = 5): Project {
  const project = newProject("t", n);
  const [, a, b] = project.pages;
  const left = addPanel(project, a, rectShape([10, 10, 100, 100]));
  const right = addPanel(project, b, rectShape([10, 10, 100, 100]));
  left.spread = right.spread = "spread1";
  return project;
}

describe("runsOf / withPartners", () => {
  it("groups consecutive indexes", () => {
    expect(runsOf([5, 1, 2, 7, 6])).toEqual([
      [1, 2],
      [5, 7],
    ]);
  });

  it("takes a 見開き page's partner along", () => {
    const project = withSpread();
    expect(withPartners(project, [1])).toEqual([1, 2]);
    expect(withPartners(project, [2, 4])).toEqual([1, 2, 4]);
  });
});

describe("insertBlankPages", () => {
  it("puts blank pages in front of or behind a page", () => {
    const project = newProject("t", 3);
    const [p1, p2, p3] = ids(project);
    const added = insertBlankPages(project, 1, true, 2);
    expect(ids(project)).toEqual([p1, p2, added[0].id, added[1].id, p3]);
    const front = insertBlankPages(project, 0, false);
    expect(ids(project)[0]).toBe(front[0].id);
    expect(project.pages.every(pageIsEmpty)).toBe(true);
  });

  it("never splits a 見開き", () => {
    const project = withSpread();
    const [, a, b] = ids(project);
    // Behind the first half: behind the pair; in front of the second half: in front of the pair.
    const behind = insertBlankPages(project, 1, true);
    expect(ids(project).slice(1, 4)).toEqual([a, b, behind[0].id]);
    const before = insertBlankPages(project, 2, false);
    expect(ids(project).slice(1, 4)).toEqual([before[0].id, a, b]);
  });

  it("joins the scene of the page it is put beside", () => {
    const project = newProject("t", 4);
    const [p1, p2, p3, p4] = ids(project);
    const first = addScene(project, p1, p2, "前半");
    const second = addScene(project, p3, p4, "後半");
    const [behind] = insertBlankPages(project, 1, true);
    expect(first.lastPage).toBe(behind.id);
    const [front] = insertBlankPages(project, 3, false);
    expect(second.firstPage).toBe(front.id);
  });

  it("belongs to the 別案 of the page beside it", () => {
    const project = newProject("t", 3);
    const set = makeAlternative(project, 1, 1)!;
    const [added] = insertBlankPages(project, 1, true);
    expect(set.pageIds).toContain(added.id);
  });
});

describe("duplicatePages", () => {
  it("copies a page right behind it with new ids throughout", () => {
    const project = newProject("t", 2);
    const page = project.pages[0];
    const panel = addPanel(project, page, rectShape([10, 10, 100, 100]));
    page.memo = "メモ";
    page.lines.push({ id: "line1", text: "あ", kind: "speech", panel: panel.id, box: [10, 10, 20, 40], fontSizePt: 12, vertical: true });
    page.stickies = [{ id: "sticky1", text: "?", at: [0, 0], link: { kind: "panel", id: panel.id, at: [1, 1] } }];
    const [copy] = duplicatePages(project, [0]);
    expect(project.pages[1]).toBe(copy);
    expect(copy.memo).toBe("メモ");
    expect(copy.panels[0].id).not.toBe(panel.id);
    expect(copy.lines[0].panel).toBe(copy.panels[0].id);
    expect(copy.stickies?.[0].link?.id).toBe(copy.panels[0].id);
    expect(repair(project)).toEqual([]);
  });

  it("copies a 見開き as a pair, its panel across the gutter its own", () => {
    const project = withSpread();
    const copies = duplicatePages(project, [2]);
    expect(copies).toHaveLength(2);
    expect(ids(project).slice(3, 5)).toEqual(copies.map((p) => p.id));
    const spread = copies[0].panels[0].spread;
    expect(spread).toBeTruthy();
    expect(spread).not.toBe("spread1");
    expect(copies[1].panels[0].spread).toBe(spread);
    expect(repair(project)).toEqual([]);
  });

  it("copies separate pages each behind itself, from the back", () => {
    const project = newProject("t", 4);
    const [p1, p2, p3, p4] = ids(project);
    const copies = duplicatePages(project, [0, 2]);
    expect(ids(project)).toEqual([p1, copies[0].id, p2, p3, copies[1].id, p4]);
  });
});

describe("deletePages", () => {
  it("keeps one page", () => {
    const project = newProject("t", 2);
    expect(cannotRemove(project, ids(project))).toBeTruthy();
    expect(deletePages(project, ids(project))).toBe(false);
    expect(project.pages).toHaveLength(2);
  });

  it("makes the other half of a panel across the gutter an ordinary panel", () => {
    const project = withSpread();
    const [, a, b] = project.pages;
    expect(deletePages(project, [b.id])).toBe(true);
    expect(a.panels[0].spread).toBeUndefined();
    expect(repair(project)).toEqual([]);
  });

  it("lets the page before stop joining a deleted page", () => {
    const project = newProject("t", 4);
    project.pages[0].joinNext = true;
    deletePages(project, [project.pages[1].id]);
    expect(project.pages[0].joinNext).toBeUndefined();
  });

  it("moves 保留コマ meant for a deleted page to the page before it", () => {
    const project = newProject("t", 3);
    const [p1, p2] = project.pages;
    const panel = addPanel(project, p2, rectShape([10, 10, 100, 100]));
    const held = holdPanel(project, p2, panel);
    expect(held.near).toBe(p2.id);
    deletePages(project, [p2.id]);
    expect(held.near).toBe(p1.id);
    expect(held.from).toBeUndefined();
  });

  it("takes the pages' emotion values and scene ends along", () => {
    const project = newProject("t", 3);
    const [p1, p2, p3] = ids(project);
    const who = addCharacter(project, "A");
    setEmotion(project, who.id, p2, 0.5);
    const scene = addScene(project, p2, p3, "S");
    deletePages(project, [p2]);
    expect(project.emotions).toEqual([]);
    expect(scene.firstPage).toBe(p3);
    expect(ids(project)).toEqual([p1, p3]);
  });
});

describe("holdPages / restoreHeldPages", () => {
  it("takes pages out whole and puts them back where they were", () => {
    const project = newProject("t", 4);
    const [p1, p2, p3, p4] = ids(project);
    const who = addCharacter(project, "A");
    setEmotion(project, who.id, p3, -0.5);
    project.pages[2].memo = "保留するページ";
    const [held] = holdPages(project, [p2, p3]);
    expect(ids(project)).toEqual([p1, p4]);
    expect(held.pages.map((p) => p.id)).toEqual([p2, p3]);
    expect(held.after).toBe(p1);
    expect(project.emotions).toEqual([]);
    expect(held.emotions).toHaveLength(1);
    expect(repair(project)).toEqual([]);
    restoreHeldPages(project, held.id, "back");
    expect(ids(project)).toEqual([p1, p2, p3, p4]);
    expect(project.emotions).toHaveLength(1);
    expect(project.heldPages).toBeUndefined();
  });

  it("keeps separate runs apart and a 見開き together", () => {
    const project = withSpread(6);
    const [, a, b, , e] = ids(project);
    const made = holdPages(project, [a, b, e]);
    expect(made.map((h) => h.pages.length)).toEqual([2, 1]);
    expect(made[0].pages[0].panels[0].spread).toBe("spread1");
    // Put back elsewhere: at the end.
    restoreHeldPages(project, made[0].id, project.pages.length);
    expect(ids(project).slice(-2)).toEqual([a, b]);
    expect(repair(project)).toEqual([]);
  });

  it("goes back to the front when it was the first page, and after the page before when that is held too", () => {
    const project = newProject("t", 4);
    const [p1, p2, p3, p4] = ids(project);
    const [first] = holdPages(project, [p1]);
    expect(first.after).toBeUndefined();
    const [second] = holdPages(project, [p3]);
    expect(second.after).toBe(p2);
    // p2 deleted: p3 comes after the page before it (none: the front).
    deletePages(project, [p2]);
    expect(second.after).toBeUndefined();
    restoreHeldPages(project, second.id, "back");
    restoreHeldPages(project, first.id, "back");
    expect(ids(project)).toEqual([p1, p3, p4]);
  });
});

describe("clipPages / pastePages", () => {
  it("pastes a copy in front of a page", () => {
    const project = newProject("t", 3);
    const [p1, p2, p3] = ids(project);
    project.pages[0].memo = "一";
    const clip = clipPages(project, [0]);
    const [pasted] = pastePages(project, clip, 2);
    expect(ids(project)).toEqual([p1, p2, pasted.id, p3]);
    expect(pasted.memo).toBe("一");
  });

  it("brings pictures and finds speakers by name when pasted into another name", () => {
    const from = newProject("a", 1);
    const hero = addCharacter(from, "主人公");
    const other = addCharacter(from, "脇役");
    from.images = [{ id: "image1", name: "駅.jpg", mime: "image/jpeg", dataBase64: "AAAA", widthPx: 4, heightPx: 3 }];
    const page = from.pages[0];
    page.references = [{ id: "reference1", image: "image1", box: [0, 0, 10, 10] }];
    page.lines.push({ id: "l1", text: "a", kind: "speech", speaker: hero.id, box: [0, 0, 10, 10], fontSizePt: 12, vertical: true });
    page.lines.push({ id: "l2", text: "b", kind: "speech", speaker: other.id, box: [0, 0, 10, 10], fontSizePt: 12, vertical: true });
    page.strokes.push({ id: "s1", points: [[0, 0, 1]], widthMm: 1, closed: false, brush: "brushX", layer: "layerX" });
    const clip = clipPages(from, [0]);

    const to = newProject("b", 1);
    addCharacter(to, "モブ");
    const named = addCharacter(to, "主人公");
    const [pasted] = pastePages(to, clip, 1);
    expect(pasted.lines[0].speaker).toBe(named.id);
    expect(pasted.lines[1].speaker).toBeUndefined();
    expect(to.images).toHaveLength(1);
    expect(pasted.references?.[0].image).toBe(to.images![0].id);
    expect(pasted.strokes[0].brush).toBeUndefined();
    expect(pasted.strokes[0].layer).toBeUndefined();
    // The same picture again is kept once.
    pastePages(to, clip, 0);
    expect(to.images).toHaveLength(1);
    expect(repair(to)).toEqual([]);
  });
});

describe("trailingEmptyIds", () => {
  it("lists the empty pages at the end but never all of them", () => {
    const project = newProject("t", 4);
    project.pages[1].memo = "x";
    expect(trailingEmptyIds(project, pageIsEmpty)).toEqual(ids(project).slice(2));
    const blank = newProject("t", 3);
    expect(trailingEmptyIds(blank, pageIsEmpty)).toHaveLength(2);
  });
});

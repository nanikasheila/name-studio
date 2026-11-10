// The managing lists' changes (人物・保留・シーン・ラフ線のレイヤー): the same
// operations as the page list's, on what each list holds.
import { describe, expect, it } from "vitest";
import { addCharacter, addScene, setEmotion } from "./cast";
import { addLine } from "./dialogue";
import {
  clipCharacters,
  duplicateCharacters,
  insertCharacter,
  linesOf,
  mergeCharacters,
  moveCharacters,
  pasteCharacters,
  removeCharacters,
} from "./castops";
import { rectShape } from "../model/geometry";
import { holdPanel } from "./hold";
import { duplicateHeld, moveHeld, removeHeld, setHeldNear } from "./heldops";
import { canMove, freeName, moveIds, moveRange } from "./listorder";
import type { Project } from "../model/model";
import { linesText } from "./scripttext";
import { holdPages } from "./pageops";
import { addPanel } from "./panels";
import { newProject } from "./project";
import { addRoughLayer, duplicateRoughLayer, layerStrokeCount } from "./roughlayers";
import { canSplitAt, duplicateScene, joinScene, moveSceneTo, sceneTarget, splitScene } from "./sceneops";
import { sceneSpans } from "./story";

const name = (list: { id: string }[]) => list.map((item) => item.id).join(",");

describe("moveIds", () => {
  const list = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const id = (item: { id: string }) => item.id;
  it("moves picked items one step past the unpicked next to them", () => {
    expect(name(moveIds(list, id, ["c"], -1)!)).toBe("a,c,b,d,e");
    expect(name(moveIds(list, id, ["b", "d"], 1)!)).toBe("a,c,b,e,d");
    expect(name(moveIds(list, id, ["b", "c"], -1)!)).toBe("b,c,a,d,e");
  });
  it("keeps items at the edge where they are, and says when nothing moves", () => {
    expect(moveIds(list, id, ["a"], -1)).toBeNull();
    expect(moveIds(list, id, ["a", "b"], -1)).toBeNull();
    expect(name(moveIds(list, id, ["a", "c"], -1)!)).toBe("a,c,b,d,e");
    expect(canMove(list, id, ["e"], 1)).toBe(false);
    expect(moveIds(list, id, ["x"], 1)).toBeNull();
  });
  it("gathers the picked at the front or the end in their order", () => {
    expect(name(moveIds(list, id, ["d", "b"], "first")!)).toBe("b,d,a,c,e");
    expect(name(moveIds(list, id, ["a", "c"], "last")!)).toBe("b,d,e,a,c");
  });
  it("moves a dragged range", () => {
    expect(moveRange(["a", "b", "c", "d"], 0, 0, 3)?.join("")).toBe("bcad");
    expect(moveRange(["a", "b", "c", "d"], 2, 3, 0)?.join("")).toBe("cdab");
    expect(moveRange(["a", "b", "c"], 1, 1, 2)).toBeNull();
  });
  it("names apart", () => {
    expect(freeName("A", ["A", "A 2"])).toBe("A 3");
    expect(freeName("B", ["A"])).toBe("B");
  });
});

function cast(): Project {
  const project = newProject("t", 3);
  const [a, b, c] = ["ユメ", "ノスト", "ラ"].map((n) => addCharacter(project, n));
  const page = project.pages[0];
  page.lines.push(
    { id: "l1", kind: "speech", text: "一", speaker: a.id, at: [10, 10] } as never,
    { id: "l2", kind: "speech", text: "二", speaker: b.id, at: [20, 10] } as never,
    { id: "l3", kind: "speech", text: "三", speaker: c.id, at: [30, 10] } as never,
  );
  setEmotion(project, a.id, project.pages[0].id, 0.5);
  setEmotion(project, b.id, project.pages[0].id, -0.5);
  setEmotion(project, b.id, project.pages[1].id, -1);
  b.tone = "ですます";
  return project;
}

describe("人物の管理", () => {
  it("puts a character in at a place, named and coloured apart", () => {
    const project = cast();
    const made = insertCharacter(project, 1, "ユメ");
    expect(project.characters[1]).toBe(made);
    expect(made.name).toBe("ユメ 2");
    expect(new Set(project.characters.map((c) => c.color)).size).toBe(4);
  });
  it("copies characters behind the last picked, leaving their lines", () => {
    const project = cast();
    const [a, b] = project.characters;
    const copies = duplicateCharacters(project, [a.id, b.id]);
    expect(project.characters.map((c) => c.name)).toEqual(["ユメ", "ノスト", "ユメのコピー", "ノストのコピー", "ラ"]);
    expect(copies[1].tone).toBe("ですます");
    expect(
      linesOf(
        project,
        copies.map((c) => c.id),
      ),
    ).toBe(0);
  });
  it("moves and removes several", () => {
    const project = cast();
    const [a, , c] = project.characters;
    expect(moveCharacters(project, [c.id], "first")).toBe(true);
    expect(project.characters[0]).toBe(c);
    expect(removeCharacters(project, [a.id, c.id])).toBe(2);
    expect(project.characters.map((x) => x.name)).toEqual(["ノスト"]);
    expect(project.pages[0].lines.filter((l) => l.speaker).length).toBe(1);
  });
  it("merges characters into one: their lines, the feelings it lacks, the 口調", () => {
    const project = cast();
    const [a, b, c] = project.characters;
    expect(mergeCharacters(project, a.id, [a.id, b.id, c.id])).toBe(2);
    expect(project.characters.map((x) => x.id)).toEqual([a.id]);
    expect(project.pages[0].lines.every((l) => l.speaker === a.id)).toBe(true);
    // a's own feeling on page 1 stays; b's on page 2 becomes a's.
    expect(project.emotions.map((p) => [p.character, p.value])).toEqual([
      [a.id, 0.5],
      [a.id, -1],
    ]);
    expect(a.tone).toBe("ですます");
  });
  it("pastes copied characters into another name, not the ones it already has", () => {
    const from = cast();
    const clip = clipCharacters(
      from,
      from.characters.map((c) => c.id),
    );
    const to = newProject("u", 1);
    addCharacter(to, "ノスト");
    const { added, skipped } = pasteCharacters(to, clip, 0);
    expect(skipped).toBe(1);
    expect(to.characters.map((c) => c.name)).toEqual(["ユメ", "ラ", "ノスト"]);
    expect(new Set(to.characters.map((c) => c.id)).size).toBe(3);
    expect(added.every((c) => !from.characters.some((f) => f === c))).toBe(true);
  });
});

function held(): Project {
  const project = newProject("t", 4);
  const page = project.pages[1];
  for (const x of [10, 80]) {
    const panel = addPanel(project, page, rectShape([x, 10, x + 60, 60]));
    addLine(project, page, [x + 30, 35]);
    holdPanel(project, page, panel);
  }
  holdPages(project, [project.pages[3].id]);
  return project;
}

describe("保留の管理", () => {
  it("copies a held panel with ids of its own, right behind it", () => {
    const project = held();
    const [first, second] = project.held!;
    first.at = [0, -50];
    const [copy] = duplicateHeld(project, [first.id]);
    expect(name(project.held!)).toBe(`${first.id},${copy.id},${second.id}`);
    expect(copy.panel.id).not.toBe(first.panel.id);
    expect(copy.lines[0].id).not.toBe(first.lines[0].id);
    expect(copy.lines[0].panel).toBe(copy.panel.id);
    expect(copy.at).toBeUndefined();
  });
  it("moves, sends near a page and drops panels and pages together", () => {
    const project = held();
    const [first, second] = project.held!;
    expect(moveHeld(project, [second.id], -1)).toBe(true);
    expect(name(project.held!)).toBe(`${second.id},${first.id}`);
    expect(setHeldNear(project, [first.id, second.id], project.pages[2].id)).toBe(2);
    expect(project.held!.every((h) => h.near === project.pages[2].id)).toBe(true);
    expect(removeHeld(project, [first.id, project.heldPages![0].id])).toBe(2);
    expect(project.heldPages).toBeUndefined();
    expect(name(project.held!)).toBe(second.id);
  });
});

function scenes(): Project {
  const project = newProject("t", 8);
  const id = (i: number) => project.pages[i].id;
  addScene(project, id(0), id(2), "朝");
  addScene(project, id(3), id(4), "昼");
  addScene(project, id(5), id(7), "夜");
  project.pages.forEach((page, i) => (page.memo = `p${i + 1}`));
  return project;
}

const spans = (project: Project) => sceneSpans(project).map((s) => `${s.scene.title}:${s.first + 1}-${s.last + 1}`);

describe("シーンの管理", () => {
  it("splits a scene at a page", () => {
    const project = scenes();
    const morning = project.scenes[0];
    expect(canSplitAt(project, morning.id, 0)).toBe(false);
    expect(canSplitAt(project, morning.id, 2)).toBe(true);
    expect(splitScene(project, morning.id, 1)?.title).toBe("朝（続き）");
    expect(spans(project)).toEqual(["朝:1-1", "朝（続き）:2-3", "昼:4-5", "夜:6-8"]);
  });
  it("joins a scene with the next or the one before", () => {
    const project = scenes();
    const [morning, noon, night] = project.scenes;
    morning.summary = "起きる";
    noon.summary = "働く";
    expect(joinScene(project, noon.id, false)).toBe(morning);
    expect(spans(project)).toEqual(["朝:1-5", "夜:6-8"]);
    expect(morning.summary).toBe("起きる\n働く");
    expect(joinScene(project, night.id, true)).toBeNull();
  });
  it("copies a scene with its pages behind it, as a scene of its own", () => {
    const project = scenes();
    const noon = project.scenes[1];
    const made = duplicateScene(project, noon.id);
    expect(made?.pages.length).toBe(2);
    expect(project.pages.map((p) => p.memo).join(",")).toBe("p1,p2,p3,p4,p5,p4,p5,p6,p7,p8");
    expect(spans(project)).toEqual(["朝:1-3", "昼:4-5", "昼のコピー:6-7", "夜:8-10"]);
  });
  it("moves a scene past the scene next to it, or to the front or the end", () => {
    const project = scenes();
    const [morning, noon, night] = project.scenes;
    expect(sceneTarget(project, morning.id, -1)).toBeNull();
    expect(moveSceneTo(project, noon.id, -1)).toBe(true);
    expect(project.pages.map((p) => p.memo).join(",")).toBe("p4,p5,p1,p2,p3,p6,p7,p8");
    expect(moveSceneTo(project, noon.id, "last")).toBe(true);
    expect(spans(project)).toEqual(["朝:1-3", "夜:4-6", "昼:7-8"]);
    expect(sceneTarget(project, noon.id, 1)).toBeNull();
    expect(night.title).toBe("夜");
  });
});

describe("ラフ線のレイヤーを複製", () => {
  it("copies a layer with every line on it, above it", () => {
    const project = newProject("t", 2);
    let n = 0;
    const fresh = () => `x${++n}`;
    const layer = addRoughLayer(project, "下描き", fresh);
    project.pages[0].strokes.push(
      { id: "s1", points: [], widthMm: 1, closed: false, layer: layer.id },
      { id: "s2", points: [], widthMm: 1, closed: false },
    );
    project.pages[1].strokes.push({ id: "s3", points: [], widthMm: 1, closed: false, layer: layer.id });
    const copy = duplicateRoughLayer(project, layer.id, fresh, fresh)!;
    expect(copy.name).toBe("下描きのコピー");
    expect(project.roughLayers!.map((l) => l.name)).toEqual(["ラフ線", "下描き", "下描きのコピー"]);
    expect(layerStrokeCount(project, copy.id)).toBe(2);
    expect(layerStrokeCount(project, layer.id)).toBe(2);
    expect(new Set(project.pages.flatMap((p) => p.strokes.map((s) => s.id))).size).toBe(5);
  });
});

describe("台本のコピー", () => {
  it("writes the picked lines under their page", () => {
    const project = cast();
    project.pages[1].lines.push({ id: "l4", kind: "narration", text: "そして", at: [0, 0] } as never);
    expect(linesText(project, ["l1", "l3", "l4"])).toBe("■ 1 ページ\nユメ「一」\nラ「三」\n\n■ 2 ページ\nナレーション：そして");
  });
});

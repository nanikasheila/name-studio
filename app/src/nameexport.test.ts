import { describe, expect, it } from "vitest";
import { mapBox, packBody, projectToTemplate, scriptText } from "./nameexport";
import { addCharacter, addLine, addScene, basicBox, newProject, rectShape } from "./project";

describe("projectToTemplate", () => {
  it("puts the basic frame on the template's basic frame", () => {
    const project = newProject("t", 1);
    // A3 at 600 dpi with a 180 x 270 mm basic frame, centred.
    const px = 600 / 25.4;
    const canvas = {
      widthPx: Math.round(297 * px),
      heightPx: Math.round(420 * px),
      resolution: 600,
      trimPx: null,
      basicPx: [((297 - 180) / 2) * px, ((420 - 270) / 2) * px, ((297 + 180) / 2) * px, ((420 + 270) / 2) * px] as [number, number, number, number],
    };
    const m = projectToTemplate(project, canvas);
    expect(m.scale).toBeCloseTo(px);
    const mapped = mapBox(basicBox(project.pageFormat), m);
    mapped.forEach((value, i) => expect(value).toBeCloseTo(canvas.basicPx[i]));
  });

  it("fits canvas to canvas without a basic frame", () => {
    const project = newProject("t", 1);
    const m = projectToTemplate(project, { widthPx: 297, heightPx: 840, resolution: 25.4, trimPx: null, basicPx: null });
    expect(m.scale).toBeCloseTo(1);
    expect(m.y).toBeCloseTo(210);
  });
});

describe("packBody", () => {
  it("puts the JSON length first, then the JSON and the parts", () => {
    const body = packBody({ a: "あ" }, [new Uint8Array([1, 2]), new Uint8Array([3])]);
    const length = new DataView(body.buffer).getUint32(0, true);
    expect(JSON.parse(new TextDecoder().decode(body.slice(4, 4 + length)))).toEqual({ a: "あ" });
    expect([...body.slice(4 + length)]).toEqual([1, 2, 3]);
  });
});

describe("scriptText", () => {
  it("lists dialogue by page and panel with speakers", () => {
    const project = newProject("恋の話", 2);
    project.storyIndex = 3;
    const page = project.pages[0];
    page.panels = [{ id: "p1", shape: rectShape([0, 0, 100, 100]), order: 1 }];
    const hero = addCharacter(project, "ハル");
    addScene(project, page.id, page.id, "出会い");
    const line = addLine(project, page, [50, 50], "はじめ\nまして");
    line.speaker = hero.id;
    addLine(project, page, [150, 150], "春の朝", "narration");
    expect(scriptText(project).split("\n")).toEqual([
      "恋の話 第3話",
      "",
      "◆ 出会い",
      "",
      "■ 1 ページ",
      "  ［1］",
      "    ハル「はじめ　まして」",
      "    ナレーション：春の朝",
      "",
      "■ 2 ページ",
      "",
    ]);
  });
});

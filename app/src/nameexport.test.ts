import { describe, expect, it } from "vitest";
import { LAYER_ORDER, canBeVector, mapBox, packBody, partCount, projectToTemplate, scriptText, textLayers, vectorLines } from "./nameexport";
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

describe("editable layers", () => {
  // 10 px per mm, page origin at (100, 50).
  const m = { scale: 10, x: 100, y: 50 };

  it("maps panels, balloons and strokes to vector lines in template px", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    page.panels = [{ id: "p1", shape: rectShape([0, 0, 10, 20]), order: 1 }];
    page.strokes = [{ id: "s1", points: [[1, 2, 0], [3, 4, 1]], widthMm: 0.5, closed: false }];
    const line = addLine(project, page, [5, 5], "やあ");
    line.balloon = [[0, 0], [4, 0], [4, 4]];
    line.balloonShape = "custom";
    const [panel] = vectorLines(page, "panels", m);
    expect(panel.closed).toBe(true);
    expect(panel.points).toEqual([[100, 50, 1], [200, 50, 1], [200, 250, 1], [100, 250, 1]]);
    expect(panel.widthPx).toBeCloseTo(6);
    const [balloon] = vectorLines(page, "balloons", m);
    expect(balloon.points[1]).toEqual([140, 50, 1]);
    expect(balloon.widthPx).toBeCloseTo(3);
    const [stroke] = vectorLines(page, "strokes", m);
    expect(stroke.closed).toBe(false);
    expect(stroke.points.map((point) => point[2])).toEqual([0.35, 1]);
    expect(stroke.widthPx).toBeCloseTo(5);
  });

  it("leaves open edges out and splits strokes over the borders into their own layer", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    page.panels = [{ id: "p1", shape: rectShape([0, 0, 10, 20]), order: 1, openEdges: [0], fill: "black" }];
    page.strokes = [
      { id: "s1", points: [[1, 2, 1], [3, 4, 1]], widthMm: 0.5, closed: false },
      { id: "s2", points: [[1, 2, 1], [3, 4, 1]], widthMm: 0.5, closed: false, over: true },
    ];
    page.breakouts = [{ id: "b1", shape: rectShape([20, 20, 30, 30]) }];
    const [panel] = vectorLines(page, "panels", m);
    expect(panel.closed).toBe(false);
    expect(panel.points).toEqual([[200, 50, 1], [200, 250, 1], [100, 250, 1], [100, 50, 1]]);
    expect(vectorLines(page, "strokes", m)).toHaveLength(1);
    expect(vectorLines(page, "overStrokes", m)).toHaveLength(1);
    expect(partCount(page, "fills")).toBe(2);
    addLine(project, page, [50, 50], "白");
    expect(partCount(page, "balloonFills")).toBe(1);
    expect(LAYER_ORDER.indexOf("balloonFills")).toBe(LAYER_ORDER.indexOf("balloons") - 1);
    expect(LAYER_ORDER.filter((kind) => !canBeVector(kind))).toEqual(["fills", "balloonFills", "text"]);
  });

  it("makes a text layer per line, sized in pt of the template resolution", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const said = addLine(project, page, [5, 5], "はじめ\nまして");
    said.box = [10, 10, 20, 40];
    said.fontSizePt = 9;
    addLine(project, page, [50, 50], "  ");
    const across = addLine(project, page, [80, 80], "横");
    across.vertical = false;
    across.box = [60, 60, 80, 70];
    const layers = textLayers(page, m, 254);
    expect(layers).toHaveLength(2);
    const vertical = layers.find((layer) => layer.kind === "text" && layer.vertical)!;
    // Room to run on downwards for vertical text, rightwards for horizontal.
    expect(vertical).toMatchObject({ kind: "text", text: "はじめ\nまして", frame: [200, 150, 300, 525] });
    // 9 pt on the name at 10 px/mm is 31.75 px: 9 pt at 254 dpi.
    expect(vertical.kind === "text" && vertical.fontSizePt).toBeCloseTo(9);
    expect(vertical).not.toHaveProperty("color");
    across.inverted = true;
    expect(textLayers(page, m, 254).find((layer) => layer.kind === "text" && !layer.vertical)).toMatchObject({ color: [255, 255, 255] });
    const horizontal = layers.find((layer) => layer.kind === "text" && !layer.vertical)!;
    expect(horizontal).toMatchObject({ frame: [700, 650, 950, 750] });
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

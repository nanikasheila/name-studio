import { describe, expect, it } from "vitest";
import { LAYER_ORDER, canBeVector, checkSummary, clipLines, exportUnits, mapBox, packBody, partCount, projectToTemplate, scriptText, textLayers, vectorLines, type LayerMeta } from "./nameexport";
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
    const across = addLine(project, page, [80, 80], "一\n二\n三\n四\n五");
    across.vertical = false;
    across.box = [60, 60, 80, 70];
    across.fontSizePt = 9;
    const layers = textLayers(page, m, 254);
    expect(layers).toHaveLength(2);
    const vertical = layers.find((layer) => layer.kind === "text" && layer.vertical)!;
    expect(vertical).toMatchObject({ kind: "text", text: "はじめ\nまして" });
    // 9 pt on the name at 10 px/mm is 31.75 px: 9 pt at 254 dpi.
    expect(vertical.kind === "text" && vertical.fontSizePt).toBeCloseTo(9);
    // Two columns at CSP's pitch need more than the 100 px box: the frame
    // grows to the left, keeping the right edge where vertical text starts.
    const frame = (layer: LayerMeta) => (layer.kind === "text" ? layer.frame : []);
    const [vx0, vy0, vx1, vy1] = frame(vertical);
    expect([vy0, vx1, vy1]).toEqual([150, 300, 450]);
    expect(vx0).toBeCloseTo(300 - 2 * 31.75 * 1.8);
    expect(vertical).not.toHaveProperty("color");
    across.inverted = true;
    expect(textLayers(page, m, 254).find((layer) => layer.kind === "text" && !layer.vertical)).toMatchObject({ color: [255, 255, 255] });
    // Five lines of horizontal text run past the 100 px box: it grows downwards.
    const horizontal = layers.find((layer) => layer.kind === "text" && !layer.vertical)!;
    const [hx0, hy0, hx1, hy1] = frame(horizontal);
    expect([hx0, hy0, hx1]).toEqual([700, 650, 900]);
    expect(hy1).toBeCloseTo(650 + 5 * 31.75 * 1.8);
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

describe("checkSummary", () => {
  const check = (problems: string[] = [], vectorLines = 2, texts = 1) => ({ path: "p.clip", problems, layers: 5, vectorLines, texts });
  it("says all is well with what was read back", () => {
    const summary = checkSummary({ checks: [check(), check()], workCheck: check([], 0, 0) });
    expect(summary.ok).toBe(true);
    expect(summary.lines[0]).toContain("2 ページ");
    expect(summary.lines[0]).toContain("ベクター線 4 本");
    expect(summary.lines[0]).toContain("作品");
  });
  it("lists problems by page", () => {
    const summary = checkSummary({ checks: [check(), check(["レイヤー「コマ枠」の線が 0 本"])], workCheck: check(["ない"]) });
    expect(summary.ok).toBe(false);
    expect(summary.lines).toEqual(["自己確認で 2 件の問題が見つかりました:", "2 ページ: レイヤー「コマ枠」の線が 0 本", "作品: ない"]);
  });
});

describe("見開きページの書き出し", () => {
  const project = () => newProject("見開き", 6);

  it("pairs a joined page with the next when it starts a spread on the template's side", () => {
    const p = project();
    p.pages[1].joinNext = true; // pages 2-3: page 2 is a right page (page 1 is left)
    p.pages[2].joinNext = true; // already in the spread
    expect(exportUnits(p, true)).toEqual({ units: [[0], [1, 2], [3], [4], [5]], warnings: [] });
  });

  it("writes pages that cannot be a CSP spread separately, saying why", () => {
    const p = project();
    p.pages[2].joinNext = true; // pages 3-4: page 3 is a left page
    const { units, warnings } = exportUnits(p, true);
    expect(units).toEqual([[0], [1], [2], [3], [4], [5]]);
    expect(warnings).toEqual(["3–4 ページは CSP では見開きにならない並びです（3 ページが左ページ）。別々のページにしました"]);
    p.pages[2].joinNext = false;
    p.pages[1].joinNext = true;
    expect(exportUnits(p, true, "ひな形に仕上がり枠がありません").warnings[0]).toContain("2–3 ページを見開きにできませんでした");
  });

  it("makes pages sharing a panel across the gutter a spread", () => {
    const p = project();
    p.pages[3].panels.push({ id: "a", shape: rectShape([0, 0, 10, 10]), order: 1, spread: "s1" });
    p.pages[4].panels.push({ id: "b", shape: rectShape([0, 0, 10, 10]), order: 1, spread: "s1" });
    expect(exportUnits(p, true).units).toEqual([[0], [1], [2], [3, 4], [5]]);
  });

  it("cuts vector lines at the gutter, keeping each page's side", () => {
    const line = { points: [[90, 0, 1], [110, 0, 1]] as [number, number, number][], closed: false, widthPx: 2 };
    expect(clipLines([line], 100, false)[0].points).toEqual([[90, 0, 1], [100, 0, 1]]);
    expect(clipLines([line], 100, true)[0].points).toEqual([[100, 0, 1], [110, 0, 1]]);
    const box = { points: [[90, 0, 1], [110, 0, 1], [110, 10, 1], [90, 10, 1]] as [number, number, number][], closed: true, widthPx: 2 };
    const left = clipLines([box], 100, false);
    expect(left.every((part) => !part.closed && part.points.every(([x]) => x <= 100))).toBe(true);
    expect(clipLines([line], 200, false)).toEqual([line]);
  });
});

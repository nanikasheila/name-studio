import { describe, expect, it } from "vitest";
import {
  bleedPanels,
  choiceKey,
  fitBalloons,
  pickedThings,
  setLinesFlag,
  setLinesFont,
  setLinesShape,
  setLinesSize,
  setLinesSpeaker,
  setLinesType,
  setPanelsField,
  setPanelsLineMm,
  setStrokesColor,
  setStrokesOver,
  setStrokesWidth,
  setTailsStyle,
  shared,
  stackPanels,
  strokeLayerId,
  strokeSort,
  strokesToLayer,
} from "./bulk";
import { addCharacter } from "./cast";
import { addLine } from "./dialogue";
import { isBled } from "./koma";
import { addLineType } from "./linelook";
import { basicBox } from "./pagebox";
import { addPanel } from "./panels";
import { newProject } from "./project";
import { ROUGH_BASE } from "./roughlayers";
import { rectShape } from "../model/geometry";
import type { Stroke } from "../model/model";

const stroke = (id: string, extra: Partial<Stroke> = {}): Stroke => ({
  id,
  points: [
    [10, 10, 1],
    [20, 20, 1],
  ],
  widthMm: 0.4,
  closed: false,
  ...extra,
});

function sample() {
  const project = newProject("まとめて", 4);
  const [, right, left] = project.pages;
  const a = addLine(project, right, [60, 80], "うわ");
  const b = addLine(project, right, [100, 120], "あなたは誰");
  const c = addLine(project, left, [120, 100], "そうなの");
  return { project, right, left, a, b, c };
}

describe("まとめて設定: what is picked", () => {
  it("finds things on the selection's page and on the pages they name, once each", () => {
    const { project, right, left, a, b, c } = sample();
    right.strokes.push(stroke("s1"));
    const found = pickedThings(project, right.id, [
      { kind: "line", id: a.id },
      { kind: "line", id: b.id },
      { kind: "line", id: a.id },
      { kind: "line", id: c.id, pageId: left.id },
      { kind: "stroke", id: "s1" },
      { kind: "panel", id: "gone" },
    ]);
    expect(found.lines.map(({ item }) => item.id)).toEqual([a.id, b.id, c.id]);
    expect(found.lines[2].page).toBe(left);
    expect(found.strokes.map(({ item }) => item.id)).toEqual(["s1"]);
    expect(found.panels).toEqual([]);
  });

  it("says what all have, or that they differ", () => {
    expect(shared([1, 1, 1])).toEqual({ value: 1 });
    expect(shared([1, 2])).toBeNull();
    expect(shared([])).toBeNull();
    expect(shared([undefined, undefined])).toEqual({ value: undefined });
  });
});

describe("まとめて設定: セリフ", () => {
  it("sets size, font, shape and flags for every line, the balloons fitted", () => {
    const { project, a, b, c } = sample();
    const lines = [a, b, c];
    const before = b.box[2] - b.box[0];
    setLinesSize(lines, 20);
    expect(lines.map((l) => l.fontSizePt)).toEqual([20, 20, 20]);
    expect(b.box[2] - b.box[0]).toBeGreaterThan(before);
    setLinesFont(lines, "メイリオ");
    expect(lines.every((l) => l.font === "メイリオ")).toBe(true);
    setLinesFont(lines, "");
    expect(lines.some((l) => "font" in l)).toBe(false);
    setLinesShape(lines, "cloud");
    expect(lines.every((l) => l.balloonShape === "cloud")).toBe(true);
    setLinesShape(lines, "auto");
    expect(lines.some((l) => "balloonShape" in l)).toBe(false);
    a.edge = true;
    expect(setLinesFlag(lines, "edge", true)).toBe(2);
    expect(setLinesFlag(lines, "edge", false)).toBe(3);
    expect(lines.some((l) => "edge" in l)).toBe(false);
    const wasVertical = a.vertical;
    setLinesFlag(lines, "vertical", !wasVertical);
    expect(lines.every((l) => l.vertical === !wasVertical)).toBe(true);
    expect(project.pages.length).toBe(4);
  });

  it("masks only lines in a panel", () => {
    const { project, right, a, b } = sample();
    const panel = addPanel(project, right, rectShape(basicBox(project.pageFormat)));
    a.panel = panel.id;
    delete b.panel;
    expect(setLinesFlag([a, b], "mask", true)).toBe(1);
    expect(a.mask).toBe(true);
    expect(b.mask).toBeUndefined();
  });

  it("sets 話者 and 種類 for all, and every tail's style", () => {
    const { project, a, b } = sample();
    const who = addCharacter(project, "ストラ");
    setLinesSpeaker(project, [a, b], who.id);
    expect([a.speaker, b.speaker]).toEqual([who.id, who.id]);
    setLinesSpeaker(project, [a, b], undefined);
    expect("speaker" in a || "speaker" in b).toBe(false);
    const type = addLineType(project, "thought", "心の声");
    setLinesType(project, [a, b], { type: type.id });
    expect([choiceKey(a), choiceKey(b)]).toEqual([`type:${type.id}`, `type:${type.id}`]);
    expect(a.kind).toBe("thought");
    setLinesType(project, [a, b], { kind: "narration" });
    expect([choiceKey(a), choiceKey(b)]).toEqual(["kind:narration", "kind:narration"]);
    a.tails = [{ tip: [0, 0] }, { tip: [1, 1], style: "line" }];
    b.tails = [{ tip: [2, 2] }];
    expect(setTailsStyle([a, b], "bubbles")).toBe(3);
    expect([...a.tails, ...b.tails].every((t) => t.style === "bubbles")).toBe(true);
  });

  it("fits back only balloons resized alone", () => {
    const { a, b } = sample();
    a.balloonScale = [1.5, 1];
    expect(fitBalloons([a, b])).toBe(1);
    expect(a.balloonScale).toBeUndefined();
  });
});

describe("まとめて設定: コマ", () => {
  it("sets the look of each panel, leaving the usual values out", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const [x0, y0, x1, y1] = basicBox(project.pageFormat);
    const top = addPanel(project, page, rectShape([x0, y0, x1, y0 + 60]));
    const bottom = addPanel(project, page, rectShape([x0, y0 + 70, x1, y1]));
    const panels = [top, bottom];
    setPanelsField(panels, "border", "dashed", "solid");
    expect(panels.every((p) => p.border === "dashed")).toBe(true);
    setPanelsField(panels, "border", "solid", "solid");
    expect(panels.some((p) => "border" in p)).toBe(false);
    setPanelsField(panels, "draft", true, false);
    expect(panels.every((p) => p.draft)).toBe(true);
    setPanelsLineMm(project, panels, 1.2);
    expect(panels.every((p) => p.lineMm === 1.2)).toBe(true);
    setPanelsLineMm(project, panels, null);
    expect(panels.some((p) => "lineMm" in p)).toBe(false);
    stackPanels(panels, 1);
    expect(panels.every((p) => p.z === 1)).toBe(true);
    stackPanels(panels, -1);
    expect(panels.some((p) => "z" in p)).toBe(false);
  });

  it("bleeds only the panels not bled yet on that side", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const [x0, y0, x1, y1] = basicBox(project.pageFormat);
    const a = addPanel(project, page, rectShape([x0, y0, (x0 + x1) / 2 - 2, y1]));
    const b = addPanel(project, page, rectShape([(x0 + x1) / 2 + 2, y0, x1, y1]));
    expect(bleedPanels(project, [a], "top", true)).toBe(1);
    expect(bleedPanels(project, [a, b], "top", true)).toBe(1);
    expect([a, b].every((p) => isBled(p, "top", project.pageFormat))).toBe(true);
    expect(bleedPanels(project, [a, b], "top", false)).toBe(2);
    expect([a, b].some((p) => isBled(p, "top", project.pageFormat))).toBe(false);
  });
});

describe("まとめて設定: 線", () => {
  it("sets width, colour and はみ出し, the 指示 keeping their layer's colour", () => {
    const project = newProject("t", 2);
    project.roughLayers = [
      { id: ROUGH_BASE, name: "ラフ線" },
      { id: "faces", name: "顔" },
      { id: "marks", name: "指示", marks: true },
    ];
    const [one, two] = project.pages;
    const r1 = stroke("r1");
    const r2 = stroke("r2", { layer: "faces", color: "#ff0000" });
    const m1 = stroke("m1", { layer: "marks" });
    one.strokes.push(r1, m1);
    two.strokes.push(r2);
    const all = [r1, r2, m1];
    expect(strokeSort(project, [r1, r2])).toBe("rough");
    expect(strokeSort(project, [m1])).toBe("marks");
    expect(strokeSort(project, all)).toBe("both");
    setStrokesWidth(all, 1.5);
    expect(all.every((s) => s.widthMm === 1.5)).toBe(true);
    expect(setStrokesColor(project, all, "#0000ff")).toBe(2);
    expect([r1.color, r2.color, m1.color]).toEqual(["#0000ff", "#0000ff", undefined]);
    setStrokesColor(project, all, undefined);
    expect(all.some((s) => "color" in s)).toBe(false);
    setStrokesOver(all, true);
    expect(all.every((s) => s.over)).toBe(true);
    setStrokesOver(all, false);
    expect(all.some((s) => "over" in s)).toBe(false);
  });

  it("moves the lines of several pages onto one layer", () => {
    const project = newProject("t", 2);
    project.roughLayers = [
      { id: ROUGH_BASE, name: "ラフ線" },
      { id: "faces", name: "顔" },
    ];
    const [one, two] = project.pages;
    one.strokes.push(stroke("a"));
    two.strokes.push(stroke("b", { layer: "faces" }));
    const picked = [
      { page: one, item: one.strokes[0] },
      { page: two, item: two.strokes[0] },
    ];
    expect(strokesToLayer(project, picked, "faces")).toBe(1);
    expect(strokeLayerId(project, one.strokes[0])).toBe("faces");
    expect(strokesToLayer(project, picked, ROUGH_BASE)).toBe(2);
    expect(one.strokes[0].layer).toBeUndefined();
    expect(two.strokes[0].layer).toBeUndefined();
  });
});

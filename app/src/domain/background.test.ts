import { describe, expect, it } from "vitest";
import type { Panel, Project, StoredImage } from "../model/model";
import {
  addObject,
  addVanishing,
  adoptBackground,
  backgroundBox,
  backgroundClip,
  backgroundFor,
  boxPixels,
  folderPath,
  hasInstructions,
  moveObject,
  nextTake,
  objectAt,
  panelLabel,
  readManifest,
  readManifests,
  requestManifest,
  readSource,
  removeBackground,
  removeInstructionAt,
  renameObject,
  setBackground,
  setHorizon,
  sizeObject,
  sourceOf,
  takesFor,
  variantOf,
} from "./background";
import {
  instructionWords,
  placeFrom,
  requestBrief,
  requestPrompt,
  requestStamp,
  requestSummary,
  type BackgroundRequest,
} from "./bgrequest";
import { newProject } from "./project";
import { savedForm } from "./references";

const picture: StoredImage = { id: "x", name: "完成.png", mime: "image/png", dataBase64: "AAAA", widthPx: 40, heightPx: 30 };

function withPanels(): Project {
  const project = newProject("背景", 2);
  const page = project.pages[1];
  const panel = (id: string, order: number, x0: number, y0: number, x1: number, y1: number): Panel => ({
    id,
    order,
    shape: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
  });
  page.panels = [panel("a", 2, 60, 80, 140, 160), panel("b", 1, 150, 80, 230, 160)];
  page.lines.push({ id: "l1", text: "行こう", kind: "speech", box: [70, 90, 80, 110], fontSizePt: 9, vertical: true, panel: "a" });
  return project;
}

describe("背景の指示", () => {
  it("is taken out when nothing is left", () => {
    const panel = withPanels().pages[1].panels[0];
    setBackground(panel, { brief: "居間", camera: "low" });
    expect(hasInstructions(panel)).toBe(true);
    setBackground(panel, { brief: "", camera: undefined });
    expect(panel.background).toBeUndefined();
    setBackground(panel, { none: true });
    expect(panel.background).toEqual({ none: true });
    expect(hasInstructions(panel)).toBe(false);
  });

  it("draws the eye level across the panel from a click, and keeps three vanishing points", () => {
    const project = withPanels();
    const panel = project.pages[1].panels[0];
    setHorizon(panel, [100, 120], [100.5, 120]);
    expect(panel.background?.horizon).toEqual([
      [60, 120],
      [140, 120],
    ]);
    for (const x of [0, 10, 20, 30]) addVanishing(panel, [x, 100]);
    expect(panel.background?.vanishing).toEqual([
      [10, 100],
      [20, 100],
      [30, 100],
    ]);
    const object = addObject(project, panel, " バン ", [
      [70, 130],
      [100, 130],
      [100, 150],
      [70, 150],
    ]);
    expect(object.label).toBe("バン");
    expect(addObject(project, panel, "", object.shape).label).toBe("物");
  });

  it("takes away the nearest instruction", () => {
    const project = withPanels();
    const panel = project.pages[1].panels[0];
    setHorizon(panel, [60, 120], [140, 110]);
    addVanishing(panel, [200, 100]);
    addObject(project, panel, "机", [
      [70, 130],
      [90, 130],
      [90, 150],
      [70, 150],
    ]);
    expect(removeInstructionAt(panel, [201, 101], 3)).toBe("vanishing");
    expect(removeInstructionAt(panel, [80, 140], 3)).toBe("object");
    expect(removeInstructionAt(panel, [100, 115.5], 3)).toBe("horizon");
    expect(removeInstructionAt(panel, [100, 100], 3)).toBeNull();
    expect(panel.background).toBeUndefined();
  });

  it("is said in words for the request, places beyond the panel too", () => {
    const project = withPanels();
    const panel = project.pages[1].panels[0];
    setBackground(panel, { brief: "車寄せ\nバンが停まっている", camera: "high" });
    setHorizon(panel, [60, 100], [140, 100]);
    addVanishing(panel, [180, 100]);
    expect(placeFrom(panel, [180, 70])).toBe("コマの外（上へ 10mm・右へ 40mm）");
    expect(placeFrom(panel, [80, 100])).toBe("コマの中（左から 25%・上から 25%）");
    expect(instructionWords(panel)).toEqual([
      "背景の指示: 車寄せ / バンが停まっている",
      // With a ruler the camera comes from its points, not the words.
      "透視: 1点透視（カメラは消失点 1 の方向を正面に向く。奥へ向かう水平の線がそこに集まる）",
      "アイレベル（地平線・カメラの高さ）: y = 100mm（コマの上から 25%）",
      "消失点 1: (180, 100)mm、コマの外（右へ 40mm）",
    ]);
    setBackground(panel, { vanishing: undefined });
    expect(instructionWords(panel)).toContain("カメラ: 俯瞰");
  });
});

describe("物 placed", () => {
  it("is found by a corner (to size) or inside (to move), moved, sized from the opposite corner and named anew", () => {
    const project = withPanels();
    const panel = project.pages[1].panels[0];
    const van = addObject(project, panel, "バン", [
      [70, 120],
      [100, 120],
      [100, 140],
      [70, 140],
    ]);
    expect(objectAt(panel, [100.5, 140.5], 2)).toEqual({ object: van, corner: 2 });
    expect(objectAt(panel, [85, 130], 2)).toEqual({ object: van, corner: -1 });
    expect(objectAt(panel, [60, 100], 2)).toBeNull();
    const start = van.shape.map(([x, y]) => [x, y] as [number, number]);
    moveObject(van, start, 5, -10);
    expect(van.shape[0]).toEqual([75, 110]);
    sizeObject(van, start, 2, [120, 150]);
    expect(van.shape).toEqual([
      [70, 120],
      [120, 120],
      [120, 150],
      [70, 150],
    ]);
    // Past the opposite corner: the box turns over and stays a box.
    sizeObject(van, start, 2, [60, 110]);
    expect(van.shape[0]).toEqual([60, 110]);
    expect(renameObject(panel, van.id, " バン 横向き ")).toBe(true);
    expect(van.label).toBe("バン 横向き");
    renameObject(panel, van.id, "");
    expect(van.label).toBe("物");
  });
});

describe("採用した背景", () => {
  it("lies over the panel's bounds and bleed, kept on the paper", () => {
    const project = withPanels();
    const [panel] = project.pages[1].panels;
    expect(backgroundBox(project.pageFormat, panel)).toEqual([57, 77, 143, 163]);
    panel.shape = panel.shape.map(([x, y]) => [x - 59, y]);
    expect(backgroundBox(project.pageFormat, panel)[0]).toBe(0);
    expect(boxPixels([0, 0, 25.4, 50.8], 600)).toEqual([600, 1200]);
  });

  it("replaces the one before, sits under the other pictures, and is cut to its panel", () => {
    const project = withPanels();
    const page = project.pages[1];
    const [a, b] = page.panels;
    page.references = [{ id: "r0", image: "y", box: [0, 0, 10, 10] }];
    project.images = [{ ...picture, id: "y" }];
    adoptBackground(project, page, a, picture, [57, 77, 143, 163], sourceOf({ panel: "a", take: "1" }, "完成"));
    const second = adoptBackground(project, page, a, picture, [57, 77, 143, 163], sourceOf({ panel: "a", take: "2" }, "線画"));
    adoptBackground(project, page, b, picture, [147, 77, 233, 163], "b/1/完成");
    expect(page.references.map((r) => r.id)).toEqual([expect.any(String), second.id, "r0"]);
    expect(backgroundFor(page, "a")).toBe(second);
    expect(readSource(second.source)).toEqual({ panel: "a", take: "2", variant: "線画" });
    expect(backgroundClip(page, second)).toBe(a.shape);
    // The picture the first take was is not saved.
    expect(savedForm(project).images).toHaveLength(3);
    expect(removeBackground(page, "a")).toBe(true);
    expect(removeBackground(page, "a")).toBe(false);
    page.panels = page.panels.filter((panel) => panel.id !== "b");
    expect(backgroundClip(page, backgroundFor(page, "b")!)).toBeNull();
  });
});

describe("背景.json", () => {
  it("reads the takes, leaving out what leads out of the folder", () => {
    const { takes, problems } = readManifest(
      JSON.stringify({
        takes: [
          { panel: "a", take: 1, box: [1, 2, 3, 4], files: { 完成: "案/a/1/完成.png", 線画: "案\\a\\1\\線画.png" }, note: " 居間 " },
          { panel: "a", files: { 完成: "../外.png" } },
          { panel: "a", files: { 完成: "案/a/2/完成.png", トーン: "C:/x.png" }, box: [5, 5, 1, 1] },
          { panel: "b", take: "1", files: { 線画: "./案/b/1/線画.png" } },
          { panel: "a", take: 1, files: { 完成: "案/a/1/完成2.png" } },
        ],
      }),
    );
    expect(takes).toEqual([
      { panel: "a", take: "2", files: { 完成: "案/a/2/完成.png" } },
      { panel: "b", take: "1", files: { 線画: "案/b/1/線画.png" } },
      { panel: "a", take: "1", files: { 完成: "案/a/1/完成2.png" } },
    ]);
    expect(problems).toHaveLength(3);
    expect(takesFor(takes, "a").map((t) => t.take)).toEqual(["1", "2"]);
    expect(nextTake(takes, "a")).toBe(3);
    expect(nextTake(takes, "c")).toBe(1);
    expect(variantOf(takes[1])).toBe("線画");
    expect(readManifest("{").problems).toHaveLength(1);
    expect(readManifest("[]").takes).toEqual([]);
    expect(folderPath("案//a")).toBeNull();
  });

  it("reads every request's list of takes with the folder's, the later standing", () => {
    const one = (panel: string, take: string, note: string) => ({ panel, take, files: { 完成: `案/${panel}/${take}/完成.png` }, note });
    const { takes, problems } = readManifests([
      { path: "背景.json", text: JSON.stringify({ takes: [one("a", "1", "古い")] }) },
      { path: requestManifest("20261119-100000"), text: JSON.stringify({ takes: [one("a", "2", "二つ目"), one("b", "1", "べつ")] }) },
      { path: requestManifest("20261119-110000"), text: JSON.stringify({ takes: [one("a", "1", "描き直し")] }) },
      { path: requestManifest("20261119-120000"), text: "{" },
    ]);
    expect(takes.map((take) => `${take.panel}/${take.take} ${take.note}`)).toEqual(["a/2 二つ目", "b/1 べつ", "a/1 描き直し"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^依頼\/20261119-120000\/背景\.json: /);
  });
});

describe("背景の依頼", () => {
  it("tells each panel's place, size, words and instructions, and where to write", () => {
    const project = withPanels();
    project.backgrounds = { brief: "ライト建築風の家" };
    const [a, b] = project.pages[1].panels;
    a.note = "走り出す";
    setBackground(a, { camera: "low" });
    const request: BackgroundRequest = {
      stamp: requestStamp(new Date(2026, 10, 17, 5, 3, 9)),
      targets: [{ panel: "b" }, { panel: "a", revise: { take: "1", words: "もっと引きで" } }],
      note: "夕方",
      dpi: 600,
      folder: "C:\\ネーム\\第4話_背景",
      blender: null,
    };
    expect(request.stamp).toBe("20261117-050309");
    const takes = [{ panel: "a", take: "1", files: { 完成: "案/a/1/完成.png" }, note: "居間" }];
    const brief = requestBrief(project, request, takes);
    expect(brief).toContain("p2 コマ1・p2 コマ2（案1を修正） の背景");
    expect(brief).toContain("## 世界の設定\n\nライト建築風の家");
    expect(brief).toContain("## 今回の注文\n\n夕方");
    expect(brief).toContain("### p2 コマ2（id: a）");
    expect(brief).toContain("- 紙面の範囲 box: [57, 77, 143, 163]mm、画像 2031×2031px（600 dpi）");
    expect(brief).toContain("- 書く場所: `案/a/2/`");
    expect(brief).toContain("- 書く場所: `案/b/1/`");
    expect(brief).toContain("- 演出メモ: 走り出す");
    expect(brief).toContain("- セリフ: 「行こう」");
    expect(brief).toContain("- カメラ: あおり");
    expect(brief).toContain("**案1を直す**: もっと引きで");
    expect(brief).toContain("見つかりませんでした");
    expect(requestPrompt(project, request)).toContain("依頼/20261117-050309/依頼.md");
    expect(requestSummary(project, [{ panel: "a", fresh: true }, { panel: "gone" }])).toBe("p2 コマ2（頼み直し） の背景");
    expect(panelLabel(project, project.pages[1], b)).toBe("p2 コマ1");
  });
});

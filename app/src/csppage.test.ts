import { describe, expect, it } from "vitest";
import { compactStory, cspPageOf, joinedPage, pageFromFormat, pageSetup, piecesPerPage, pixelSize, presetOf, setupProblem, withPreset } from "./csppage";
import { newProject, scrollPageFormat } from "./project";

describe("CSP のページ設定", () => {
  it("starts from the name's own page at 600 dpi, with the bleed the canvas has room for", () => {
    const project = newProject("ネーム", 4);
    const page = cspPageOf(project);
    expect(page).toEqual({
      canvasMm: [297, 420],
      trimMm: [257, 364],
      bleedMm: 5,
      basicMm: [180, 270],
      basicOffsetMm: [0, 0],
      resolution: 600,
    });
    expect(pixelSize(page)).toEqual([7016, 9921]);
    // A 縦スクロール piece is its own trim: no room for a bleed.
    expect(pageFromFormat(scrollPageFormat()).bleedMm).toBe(0);
    // The name's own settings win, and are copied.
    project.cspPage = { ...page, resolution: 350 };
    const own = cspPageOf(project);
    own.canvasMm[0] = 1;
    expect(project.cspPage.canvasMm[0]).toBe(297);
  });

  it("knows the presets and keeps the rest when one is chosen", () => {
    const page = { ...pageFromFormat(newProject("n", 1).pageFormat), resolution: 350 };
    expect(presetOf(page)).toBe("b4");
    const b5 = withPreset(page, "b5");
    expect(b5).toMatchObject({ canvasMm: [188, 263], trimMm: [182, 257], bleedMm: 3, basicMm: [150, 220], resolution: 350 });
    expect(presetOf(b5)).toBe("b5");
    expect(presetOf({ ...b5, basicOffsetMm: [1, 0] })).toBeNull();
  });

  it("gives Rust the binding, first page side, story info and font", () => {
    const project = newProject("題名", 2);
    const page = cspPageOf(project);
    const setup = pageSetup(project, page, { title: " ", storyIndex: 3, author: " 作者 " }, (font) => (font === "メイリオ" ? "Meiryo" : undefined));
    expect(setup).toMatchObject({ rightBinding: true, firstPageLeft: true, title: "題名", storyIndex: 3, author: "作者", nombreStart: 1, font: null });
    project.binding = "left";
    const left = pageSetup(project, { ...page, font: "メイリオ", nombreStart: 5 }, { title: "作品", storyIndex: null, author: "" }, (font) => (font === "メイリオ" ? "Meiryo" : undefined));
    expect(left).toMatchObject({ rightBinding: false, firstPageLeft: false, title: "作品", nombreStart: 5, font: { name: "メイリオ", postscript: "Meiryo" } });
    expect(pageSetup(project, { ...page, firstPageLeft: true }, { title: "x", storyIndex: null, author: "" }).firstPageLeft).toBe(true);
    expect(pageSetup({ ...project, scroll: true }, page, { title: "x", storyIndex: null, author: "" }).rightBinding).toBe(false);
  });

  it("says why CSP cannot make a page", () => {
    const project = newProject("題名", 2);
    const setup = pageSetup(project, cspPageOf(project), { title: "", storyIndex: null, author: "" });
    expect(setupProblem(setup)).toBeNull();
    expect(setupProblem({ ...setup, trimMm: [300, 364] })).toContain("仕上がり");
    expect(setupProblem({ ...setup, resolution: 2400 })).toContain("解像度");
    expect(setupProblem({ ...setup, basicOffsetMm: [70, 0] })).toContain("基本枠");
    expect(setupProblem({ ...setup, canvasMm: [2000, 2000] })).toContain("大きすぎ");
    expect(setupProblem({ ...setup, bleedMm: -1 })).toContain("裁ち落とし");
  });

  it("joins the pieces of a 縦スクロール into pages as tall as CSP allows", () => {
    const project = newProject("縦", 12, "scroll");
    const piece = { ...cspPageOf(project), joinPieces: true };
    // 240 mm at 600 dpi is 5,669 px: five of them stay under 30,000 px.
    expect(piecesPerPage(project, piece)).toBe(5);
    expect(piecesPerPage(project, { ...piece, resolution: 350 })).toBe(9);
    expect(piecesPerPage(project, { ...piece, joinPieces: undefined })).toBe(1);
    expect(piecesPerPage({ ...project, scroll: undefined }, piece)).toBe(1);
    // Never more than the name has.
    expect(piecesPerPage(newProject("縦", 2, "scroll"), piece)).toBe(2);
    const tall = pageSetup(project, piece, { title: "x", storyIndex: null, author: "" });
    expect(tall.canvasMm[1]).toBeCloseTo(piece.canvasMm[1] * 5);
    expect(tall.trimMm[1]).toBeCloseTo(piece.trimMm[1] + 4 * piece.canvasMm[1]);
    expect(pixelSize(joinedPage(piece, 5))[1]).toBeLessThanOrEqual(30000);
    expect(setupProblem(tall)).toBeNull();
  });
  it("keeps only the 作品情報・ノンブル settings that differ from CSP's, and passes them on", () => {
    expect(compactStory({ subtitle: " ", titlePosition: "left", authorPosition: "center" })).toBeUndefined();
    const story = compactStory({
      subtitle: " サブ ",
      titlePosition: "right",
      authorPosition: "center",
      pageNumber: { start: 7, position: "right" },
      nombre: { place: "top-inner", white: false, edgeMm: 0.5, prefix: "p.", suffix: "", offsetMm: [0, 5], sizePt: 9 },
    });
    expect(story).toEqual({ subtitle: "サブ", titlePosition: "right", pageNumber: { start: 7 }, nombre: { place: "top-inner", edgeMm: 0.5, prefix: "p." } });
    const project = newProject("ネーム", 2);
    const setup = pageSetup(project, { ...cspPageOf(project), story }, { title: "作品", storyIndex: 1, author: "" });
    expect(setup.story).toEqual(story);
    expect(setupProblem({ ...setup, story: { nombre: { place: "top", sizePt: 100 } } })).toContain("ノンブルの大きさ");
    expect(pageSetup(project, cspPageOf(project), { title: "作品", storyIndex: 1, author: "" })).not.toHaveProperty("story");
  });
});

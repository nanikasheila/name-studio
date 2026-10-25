import { describe, expect, it } from "vitest";
import { cspPageOf, pageFromFormat, pageSetup, pixelSize, presetOf, setupProblem, withPreset } from "./csppage";
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
});

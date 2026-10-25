import { describe, expect, it } from "vitest";
import { addLine, newProject, setDefaultLineSize } from "./project";
import { APP_FONT_PT, balloonLineMm, defaultFontPt, panelLineMm, setDefaultFontPt, setPanelLineMm, setStyleLine, styleLineMm, useStyle } from "./style";

describe("作品の既定", () => {
  it("gives new lines the size set for their kind, else the app's", () => {
    const project = newProject("t", 1);
    expect(addLine(project, project.pages[0], [50, 50]).fontSizePt).toBe(13);
    expect(addLine(project, project.pages[0], [50, 50], "…", "narration").fontSizePt).toBe(12);
    setDefaultFontPt(project, "speech", 16.3);
    expect(project.style).toEqual({ fontPt: { speech: 16.5 } });
    expect(addLine(project, project.pages[0], [50, 50]).fontSizePt).toBe(16.5);
    setDefaultFontPt(project, "speech", APP_FONT_PT.speech);
    expect(project.style).toBeUndefined();
    setDefaultFontPt(project, "sfx", 200);
    expect(defaultFontPt("sfx", project.style)).toBe(72);
  });

  it("changes the lines still at the old default size, and only those", () => {
    const project = newProject("t", 1);
    const page = project.pages[0];
    const usual = addLine(project, page, [50, 50]);
    const own = addLine(project, page, [80, 50]);
    own.fontSizePt = 20;
    const other = addLine(project, page, [80, 80], "…", "thought");
    expect(setDefaultLineSize(project, "speech", 15)).toBe(1);
    expect([usual.fontSizePt, own.fontSizePt, other.fontSizePt]).toEqual([15, 20, 13]);
    expect(setDefaultLineSize(project, "speech", null)).toBe(1);
    expect(usual.fontSizePt).toBe(13);
  });

  it("draws borders in the panel's own width, else the name's for its border", () => {
    const style = { panelLineMm: 0.5, thickLineMm: 1.6 };
    expect(panelLineMm({ border: "solid" }, style)).toBe(0.5);
    expect(panelLineMm({ border: "dashed" }, style)).toBe(0.5);
    expect(panelLineMm({ border: "thick" }, style)).toBe(1.6);
    expect(panelLineMm({ border: "thick", lineMm: 0.9 }, style)).toBe(0.9);
    expect(panelLineMm({}, undefined)).toBe(0.6);
    expect(styleLineMm(true, undefined)).toBe(1.2);
    useStyle({ balloonLineMm: 0.4 });
    expect(balloonLineMm()).toBe(0.4);
    useStyle(undefined);
    expect(balloonLineMm()).toBe(0.3);
  });

  it("keeps only the widths that differ from the default", () => {
    const project = newProject("t", 1);
    setStyleLine(project, "thickLineMm", 1.234);
    expect(project.style).toEqual({ thickLineMm: 1.23 });
    setStyleLine(project, "thickLineMm", 1.2);
    expect(project.style).toBeUndefined();
    const panel = { id: "p", shape: [], order: 1, border: "thick" as const };
    setPanelLineMm(panel, 0.8, undefined);
    expect(panel).toMatchObject({ lineMm: 0.8 });
    setPanelLineMm(panel, 1.2, undefined);
    expect("lineMm" in panel).toBe(false);
    setPanelLineMm(panel, 0.01, undefined);
    expect(panel).toMatchObject({ lineMm: 0.05 });
  });
});

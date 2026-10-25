import { afterEach, describe, expect, it } from "vitest";
import { canvasFont, cspFont, fontChoices, lineBold, lineFont, roleFont, setInstalledFonts, setRoleFont, COMMON_FONTS } from "./fonts";
import { newProject, type Line } from "./project";

const line = (extra: Partial<Line> = {}): Line => ({ id: "line1", text: "やあ", kind: "speech", box: [0, 0, 10, 10], fontSizePt: 13, vertical: true, ...extra });

const ANTIQUE = { name: "I-OTFアンチックStd B", families: ["I-OTFアンチックStd B", "I-OTFAntiqueStd B"], postscript: "IwaAntStd-Bd", weight: 400, italic: false, japanese: true };
const GOTHIC_BOLD = { name: "游ゴシック Bold", families: ["游ゴシック", "Yu Gothic"], postscript: "YuGothic-Bold", weight: 700, italic: false, japanese: true };

afterEach(() => setInstalledFonts([]));

describe("用途ごとのフォント", () => {
  it("sets a line in its own font, else 強調's, else its kind's, else セリフ's", () => {
    const fonts = { speech: "アンチック", thought: "明朝", emphasis: "ゴシック太" };
    expect(lineFont(line(), fonts)).toBe("アンチック");
    expect(lineFont(line({ kind: "thought" }), fonts)).toBe("明朝");
    expect(lineFont(line({ kind: "narration" }), fonts)).toBe("アンチック");
    expect(lineFont(line({ kind: "thought", emphasis: true }), fonts)).toBe("ゴシック太");
    expect(lineFont(line({ emphasis: true, font: "丸ゴ" }), fonts)).toBe("丸ゴ");
    expect(lineFont(line(), undefined)).toBeNull();
    expect(roleFont({ thought: "明朝" }, "narration")).toBeNull();
  });

  it("draws 強調 bold only when no font is chosen for it", () => {
    expect(lineBold(line({ emphasis: true }), {})).toBe(true);
    expect(lineBold(line({ emphasis: true }), { emphasis: "ゴシック太" })).toBe(false);
    expect(lineBold(line(), {})).toBe(false);
  });

  it("keeps only the roles that are set", () => {
    const project = newProject("t", 1);
    setRoleFont(project, "thought", " 明朝 ");
    expect(project.fonts).toEqual({ thought: "明朝" });
    setRoleFont(project, "thought", "");
    expect(project.fonts).toBeUndefined();
  });

  it("draws a font on this computer by its families and weight, any other by its name", () => {
    setInstalledFonts([GOTHIC_BOLD]);
    expect(canvasFont("游ゴシック Bold", 12)).toBe('700 12px "游ゴシック", "Yu Gothic", "游ゴシック Bold", "Yu Gothic", "Hiragino Sans", "Noto Sans JP", sans-serif');
    expect(canvasFont("どこかの書体", 12, true)).toMatch(/^bold 12px "どこかの書体", "Yu Gothic"/);
    expect(canvasFont(null, 12)).toMatch(/^normal 12px "Yu Gothic"/);
  });

  it("writes a font to CSP with its PostScript name, when this computer has it", () => {
    setInstalledFonts([ANTIQUE]);
    expect(cspFont(line(), { speech: ANTIQUE.name })).toEqual({ name: ANTIQUE.name, postscript: "IwaAntStd-Bd" });
    expect(cspFont(line(), { speech: "ない書体" })).toBeNull();
    expect(cspFont(line(), {})).toBeNull();
  });

  it("offers this computer's fonts, else the usual ones", () => {
    expect(fontChoices()).toBe(COMMON_FONTS);
    setInstalledFonts([ANTIQUE, GOTHIC_BOLD]);
    expect(fontChoices()).toEqual([ANTIQUE.name, GOTHIC_BOLD.name]);
  });
});

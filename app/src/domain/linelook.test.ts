import { describe, expect, it } from "vitest";
import { addCharacter } from "./cast";
import { addLine } from "./dialogue";
import { addLineType, changeLooks, followsSpeaker, removeLineType, setLineSpeaker, setLineType, usualLook } from "./linelook";
import { newProject } from "./project";
import { defaultFontPt } from "./style";

function setup() {
  const project = newProject("t", 1);
  const page = project.pages[0];
  const hero = addCharacter(project, "主人公");
  hero.look = { shape: "rounded", fontSizePt: 11, edge: true };
  const shout = addLineType(project, "speech", "叫び");
  Object.assign(shout, { shape: "spike", inverted: true });
  return { project, page, hero, shout };
}

describe("セリフ種類 × キャラのフキダシ設定", () => {
  it("layers 作品の既定, the type and the speaker", () => {
    const { project, page, hero, shout } = setup();
    const line = addLine(project, page, [50, 50], "やあ");
    expect(usualLook(project, line)).toMatchObject({ shape: "auto", inverted: false, edge: false });
    setLineSpeaker(project, line, hero.id);
    expect(line).toMatchObject({ balloonShape: "rounded", fontSizePt: 11, edge: true });
    expect(line.inverted).toBeUndefined();
    // The type gives its own, the speaker's goes over it.
    setLineType(project, line, { type: shout.id });
    expect(line).toMatchObject({ type: shout.id, kind: "speech", balloonShape: "rounded", inverted: true, edge: true });
    // A type that keeps its look whoever says it.
    project.lineTypes![0].ownLook = true;
    changeLooks(project, () => {});
    const other = addLine(project, page, [80, 80], "うおお");
    setLineType(project, other, { type: shout.id });
    setLineSpeaker(project, other, hero.id);
    expect(other).toMatchObject({ balloonShape: "spike", inverted: true });
    expect(other.edge).toBeUndefined();
  });

  it("keeps what was set on the line by hand", () => {
    const { project, page, hero } = setup();
    const line = addLine(project, page, [50, 50], "やあ");
    line.balloonShape = "box";
    setLineSpeaker(project, line, hero.id);
    expect(line.balloonShape).toBe("box");
    expect(line.fontSizePt).toBe(11);
    // Taken away again, the line goes back to the usual size but keeps its own shape.
    setLineSpeaker(project, line, undefined);
    expect(line.fontSizePt).toBe(defaultFontPt("speech", project.style));
    expect(line.balloonShape).toBe("box");
    expect(line.edge).toBeUndefined();
  });

  it("narration and the like do not follow the speaker", () => {
    const { project, page, hero } = setup();
    const line = addLine(project, page, [50, 50], "そのころ", "narration");
    expect(followsSpeaker(project, line)).toBe(false);
    setLineSpeaker(project, line, hero.id);
    expect(line.edge).toBeUndefined();
    expect(addLineType(project, "sfx", "擬音").ownLook).toBe(true);
  });

  it("a type or a character changed: its lines follow; a type removed: back to the base kind", () => {
    const { project, page, hero, shout } = setup();
    const a = addLine(project, page, [50, 50], "あ");
    const b = addLine(project, page, [90, 90], "い");
    setLineSpeaker(project, a, hero.id);
    setLineType(project, b, { type: shout.id });
    expect(changeLooks(project, () => (hero.look = { ...hero.look, fontSizePt: 13 }))).toBe(1);
    expect(a.fontSizePt).toBe(13);
    expect(changeLooks(project, () => (shout.edge = true))).toBe(1);
    expect(b.edge).toBe(true);
    expect(removeLineType(project, shout.id)).toBe(1);
    expect(b.type).toBeUndefined();
    expect(b.kind).toBe("speech");
    expect(b.inverted).toBeUndefined();
    expect(b.edge).toBeUndefined();
    expect(project.lineTypes).toBeUndefined();
  });
});

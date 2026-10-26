import { describe, expect, it } from "vitest";
import { buildCommands, type CommandHost } from "./actions";

/** The actions of the first key settings: their ids are kept with people's own keys, so they stay. */
const KEPT_IDS = [
  "save", "saveAs", "undo", "redo", "view.edit", "view.board", "view.structure", "view.emotion", "view.timeline", "view.focus", "view.fit",
  "view.rotateLeft", "view.rotateRight", "view.continuous", "view.fewerRows", "view.moreRows", "view.all", "tool.select", "tool.cut",
  "tool.text", "tool.pen", "tool.eraser", "tool.fill", "tool.breakout", "tool.sticky", "tool.reference", "eraser.next", "brush.bigger",
  "brush.smaller", "delete", "copy", "cut", "paste", "selectAll", "flip.horizontal", "flip.vertical", "transform", "deselect", "page.next",
  "page.previous", "option.make",
];

const host = new Proxy({}, { get: () => () => false }) as unknown as CommandHost;

describe("命令の一覧", () => {
  const commands = buildCommands(host);

  it("names each command once", () => {
    const ids = commands.map((c) => c.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it("keeps the ids people's own keys are kept under", () => {
    const ids = new Set(commands.map((c) => c.id));
    expect(KEPT_IDS.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("gives a key to one command only", () => {
    const keys = commands.flatMap((c) => c.keys);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
  });

  it("opens the command palette with Ctrl+K", () => {
    expect(commands.find((c) => c.keys.includes("Ctrl+K"))?.id).toBe("palette.commands");
  });
});

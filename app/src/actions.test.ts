import { describe, expect, it } from "vitest";
import { buildCommands, type CommandHost } from "./actions";
import { TOOL_IDS, TOOLS } from "./tooldefs";
import { AREA_TOPICS, HOVER_TOPICS, OVERLAY_SPOTS, TOOL_TOPICS, TOUR_STOPS } from "./helptopics";

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

  it("has a command for every tool, with its keys, that picks it", () => {
    for (const id of TOOL_IDS) {
      const command = commands.find((c) => c.id === `tool.${id}`);
      expect(command?.keys, id).toEqual(TOOLS[id].keys);
      expect(command?.keys.length, id).toBeGreaterThan(0);
      const picked: string[] = [];
      const picking = new Proxy({}, { get: (_, name) => (name === "setTool" ? (to: string) => picked.push(to) : () => false) }) as unknown as CommandHost;
      buildCommands(picking).find((c) => c.id === `tool.${id}`)!.run();
      expect(picked, id).toEqual([id]);
    }
  });

  it("gives a key to one command only", () => {
    const keys = commands.flatMap((c) => c.keys);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
  });

  it("opens the command palette with Ctrl+K", () => {
    expect(commands.find((c) => c.keys.includes("Ctrl+K"))?.id).toBe("palette.commands");
  });

  it("has every command the help names", () => {
    const ids = new Set(commands.map((c) => c.id));
    const named = [
      ...[...Object.values(TOOL_TOPICS), ...Object.values(HOVER_TOPICS), ...Object.values(AREA_TOPICS)].flatMap((t) => (t.steps ?? []).map((s) => s.command)),
      ...OVERLAY_SPOTS.map((s) => s.command),
      ...TOUR_STOPS.flatMap((s) => s.text.join("").match(/\{([\w.-]+)\}/g) ?? []).map((m) => m.slice(1, -1)),
    ].filter((id): id is string => !!id);
    expect(named.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("opens the help with ?", () => {
    expect(commands.find((c) => c.keys.includes("?"))?.id).toBe("help.overlay");
  });
});

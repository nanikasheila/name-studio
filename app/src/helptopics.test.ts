import { describe, expect, it } from "vitest";
import { AREA_TOPICS, fillKeys, heldFrom, HOVER_TOPICS, keyLabel, OVERLAY_SPOTS, shownSteps, TOOL_TOPICS, topicFromWords, TOUR_STOPS } from "./helptopics";

const keys: Record<string, string[]> = { transform: ["Ctrl+T"], delete: ["Delete", "Backspace"], "tool.pen": ["P"], "page.next": ["ArrowLeft"] };
const keysOf = (id: string) => keys[id] ?? [];

describe("ヘルプの帯の中身", () => {
  it("names a command's keys as set, and leaves out a command with none", () => {
    const shown = shownSteps({ name: "x", steps: [{ input: "ドラッグ", does: "動かす" }, { command: "transform", does: "変形" }, { command: "copy", does: "コピー" }, { command: "delete", does: "消す" }] }, keysOf);
    expect(shown.map((s) => `${s.input} ${s.does}`)).toEqual(["ドラッグ 動かす", "Ctrl+T 変形", "Delete / Backspace 消す"]);
  });

  it("says a key held, and arrows as arrows", () => {
    expect(shownSteps({ name: "x", steps: [{ command: "tool.pen", hold: true, does: "借りる" }] }, keysOf)[0].input).toBe("P を押したまま");
    expect(keyLabel("Alt+ArrowUp")).toBe("Alt+↑");
    expect(keyLabel("Escape")).toBe("Esc");
    expect(fillKeys("{page.next} で次へ、{nothing} は", keysOf)).toBe("← で次へ、（キー未設定） は");
  });

  it("puts the steps of the modifiers held first", () => {
    const topic = { name: "x", steps: [{ input: "ドラッグ", does: "a" }, { input: "Shift+クリック", does: "b" }, { input: "Alt+ドラッグ", does: "c" }, { input: "Shift+Space+ドラッグ", does: "d" }] };
    const held = shownSteps(topic, keysOf, heldFrom({ shiftKey: false, altKey: true, ctrlKey: false, metaKey: false }, false));
    expect(held.map((s) => [s.does, s.held])).toEqual([["c", true], ["a", false], ["b", false], ["d", false]]);
    // Shift alone: Shift+Space+ドラッグ needs Space too.
    const shift = shownSteps(topic, keysOf, heldFrom({ shiftKey: true, altKey: false, ctrlKey: false, metaKey: false }, false));
    expect(shift.filter((s) => s.held).map((s) => s.does)).toEqual(["b"]);
  });

  it("reads a part's tooltip: its name, its sentence and its ・ lines as steps", () => {
    expect(topicFromWords("シーン: 両端のドラッグでページの範囲", "シーン")).toEqual({ name: "シーン", what: "両端のドラッグでページの範囲", steps: [] });
    const board = topicFromWords("物語の帯\n・ページやコマをクリック: そのページを上に開く\n・上端をドラッグ: 帯の高さ", "");
    expect(board.name).toBe("物語の帯");
    expect(board.steps).toEqual([{ input: "ページやコマをクリック", does: "そのページを上に開く" }, { input: "上端をドラッグ", does: "帯の高さ" }]);
    const button = topicFromWords("保存。編集中は自動でも保存します", "保存", "save");
    expect(button).toEqual({ name: "保存", what: "保存。編集中は自動でも保存します", steps: [{ command: "save", does: "でも同じ" }] });
    expect(topicFromWords("全ページを画面に収める", "").name).toBe("全ページを画面に収める");
  });

  it("has a topic for every tool and everything the select tool can grab", () => {
    for (const tool of ["select", "cut", "cut.sketch", "cut.rect", "cut.polygon", "text", "pen", "eraser", "fill", "breakout", "sticky", "reference"]) expect(TOOL_TOPICS[tool], tool).toBeDefined();
    for (const kind of ["panel", "line", "stroke", "breakout", "group", "sticky", "fill"]) expect(HOVER_TOPICS[`item.${kind}`], kind).toBeDefined();
    for (const part of ["tip", "body", "bend", "root"]) expect(HOVER_TOPICS[`tail.${part}`], part).toBeDefined();
    expect(HOVER_TOPICS.seam && HOVER_TOPICS.handle).toBeDefined();
  });

  it("keeps the parts' words short enough for the bar and the overlay", () => {
    for (const topic of [...Object.values(TOOL_TOPICS), ...Object.values(HOVER_TOPICS), ...Object.values(AREA_TOPICS)]) {
      expect(topic.name.length, topic.name).toBeLessThanOrEqual(14);
      expect((topic.what ?? "").length, topic.name).toBeLessThanOrEqual(48);
    }
    for (const spot of OVERLAY_SPOTS) expect(spot.text.length, spot.name).toBeLessThanOrEqual(64);
    for (const stop of TOUR_STOPS) expect(stop.text.join("").length, stop.title).toBeLessThanOrEqual(140);
  });
});

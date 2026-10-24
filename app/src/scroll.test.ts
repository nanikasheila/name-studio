import { describe, expect, it } from "vitest";
import { facingPage } from "./koma";
import { STRIP_SIDE, layoutPages, slotAt, type Arrangement, type Pair } from "./layout";
import { addLine, addPanel, gutters, nameKind, newProject, rectShape, SCROLL_GUTTERS, textSize, wantsSpread, wrapTypedLine } from "./project";
import { wrapDialogue } from "./wrap";

const view = (change: Partial<Arrangement> = {}): Arrangement => ({ single: false, continuous: true, rows: 1, zoom: 1, pan: [0, 0], width: 1200, height: 800, ...change });
const alone = (count: number): Pair[] => Array.from({ length: count }, (_, i): Pair => [i + 1, null]);

describe("縦スクロール", () => {
  it("makes a strip of pieces read left to right, with no spreads", () => {
    const project = newProject("t", 4, "scroll");
    expect(project.scroll).toBe(true);
    expect(project.binding).toBe("left");
    expect(nameKind(project)).toBe("scroll");
    const [w, h] = project.pageFormat.canvasMm;
    expect(h).toBe(w * 2);
    expect(project.pageFormat.trimMm).toEqual(project.pageFormat.canvasMm);
    expect(gutters(project)).toEqual(SCROLL_GUTTERS);
    project.pages[1].joinNext = true;
    expect(wantsSpread(project, 1)).toBe(false);
    expect(facingPage(project, project.pages[1], true)).toBeNull();
    // New dialogue is written across.
    expect(addLine(project, project.pages[0], [60, 60]).vertical).toBe(false);
  });

  it("stacks the pieces with nothing between them, in columns when asked", () => {
    const project = newProject("t", 5, "scroll");
    const [, pageH] = project.pageFormat.canvasMm;
    const slots = layoutPages(project, alone(5), 0, view());
    expect(slots.map((slot) => slot.index)).toEqual([0, 1, 2, 3, 4]);
    for (let i = 1; i < 5; i++) {
      expect(slots[i].x).toBeCloseTo(slots[0].x);
      expect(slots[i].y).toBeCloseTo(slots[i - 1].y + pageH * slots[0].scale);
    }
    // A piece fills the height at zoom 1, with room on the left for its number.
    expect(slots[0].scale * pageH).toBeCloseTo(800 - 2 * 28);
    expect(slots[0].x).toBeGreaterThanOrEqual(STRIP_SIDE);
    const columns = layoutPages(project, alone(5), 0, view({ rows: 2 }));
    // 3 then 2: the second column to the right, starting at the top.
    expect(columns[3].x).toBeGreaterThan(columns[2].x + 120 * columns[0].scale);
    expect(columns[3].y).toBeCloseTo(columns[0].y);
  });

  it("shows a piece on its own outside 連続", () => {
    const project = newProject("t", 3, "scroll");
    const slots = layoutPages(project, alone(3), 1, view({ continuous: false }));
    expect(slots.map((slot) => slot.index)).toEqual([1]);
  });

  it("finds the piece a point is on where the pieces touch", () => {
    const project = newProject("t", 2, "scroll");
    const slots = layoutPages(project, alone(2), 0, view());
    const second = slots[1];
    // Just inside the top of the second piece: that piece, not the room under the first.
    const hit = slotAt(slots, second.x + 10, second.y + 2, project.pageFormat);
    expect(hit?.index).toBe(1);
  });

  it("panels are numbered top to bottom", () => {
    const project = newProject("t", 1, "scroll");
    const page = project.pages[0];
    const lower = addPanel(project, page, rectShape([6, 120, 114, 200]));
    const upper = addPanel(project, page, rectShape([6, 10, 114, 90]));
    expect(upper.order).toBe(1);
    expect(lower.order).toBe(2);
  });
});

describe("横書きのセリフ", () => {
  it("counts Latin letters as narrow across, but whole cells down a column", () => {
    const [across] = textSize("Hello", 10, false);
    const [kana] = textSize("こんにちは", 10, false);
    expect(across).toBeLessThan(kana * 0.7);
    expect(textSize("Hello", 10, true)[1]).toBeCloseTo(textSize("こんにちは", 10, true)[1]);
  });

  it("breaks English between words, dropping the space", () => {
    const text = wrapDialogue("I looked everywhere for it last night and could not find it", 20);
    for (const row of text.split("\n")) {
      expect(row).toBe(row.trim());
      expect(row.length).toBeLessThanOrEqual(24);
    }
    expect(text.replace(/\n/g, " ")).toBe("I looked everywhere for it last night and could not find it");
    // Not a short word left alone at the end.
    expect(wrapDialogue("Where did the star go?", 20)).toBe("Where did the star go?");
  });

  it("wraps a typed line across longer than a column", () => {
    const project = newProject("t", 1, "left");
    const line = addLine(project, project.pages[0], [100, 100], "Where did the star go? I looked everywhere for it.");
    wrapTypedLine(line);
    expect(line.text).toBe("Where did the star go?\nI looked everywhere\nfor it.");
  });
});

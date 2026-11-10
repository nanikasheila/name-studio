import { describe, expect, it } from "vitest";
import { addLine } from "../domain/dialogue";
import { newProject } from "../domain/project";
import type { Slot } from "./layout";
import { namedItems, overPages, pageParts, partItems, partsBox, pickedOf, slotOffset } from "./pickpages";

function spread() {
  const project = newProject("t", 3);
  const [, right, left] = project.pages;
  const a = addLine(project, right, [50, 50], "右");
  const b = addLine(project, left, [150, 50], "左");
  // The left page laid out 200 px left of the right one, 1 px a mm.
  const slots: Slot[] = [
    { page: right, index: 1, x: 300, y: 10, scale: 1, shown: [0, 182] },
    { page: left, index: 2, x: 100, y: 10, scale: 1, shown: [0, 182] },
  ];
  return { project, right, left, a, b, slots };
}

describe("a 範囲選択 over a 見開き", () => {
  it("puts things of several pages as one selection, the facing page's named", () => {
    const { right, left, a, b } = spread();
    const picked = pickedOf(
      [
        { kind: "line", id: a.id, pageId: right.id },
        { kind: "line", id: b.id, pageId: left.id },
      ],
      right.id,
    );
    expect(picked).toEqual({
      kind: "group",
      pageId: right.id,
      id: "group",
      items: [
        { kind: "line", id: a.id },
        { kind: "line", id: b.id, pageId: left.id },
      ],
    });
    expect(overPages(picked!)).toBe(true);
    // Nothing on the page asked for: the first thing's page; one thing: on its own.
    expect(pickedOf([{ kind: "line", id: b.id, pageId: left.id }], right.id)).toEqual({ kind: "line", pageId: left.id, id: b.id });
    expect(pickedOf([], right.id)).toBeNull();
  });

  it("splits it page by page, each page with how far it lies from the selection's own", () => {
    const { project, right, left, a, b, slots } = spread();
    const items = [
      { kind: "line" as const, id: a.id },
      { kind: "line" as const, id: b.id, pageId: left.id },
    ];
    expect(slotOffset(slots[1], slots[0])).toEqual([-200, 0]);
    const parts = pageParts(project, right.id, items, slots);
    expect(parts.map((part) => [part.page.id, part.items, part.offset])).toEqual([
      [right.id, [{ kind: "line", id: a.id }], [0, 0]],
      [left.id, [{ kind: "line", id: b.id }], [-200, 0]],
    ]);
    expect(partItems(parts, right.id)).toEqual(items);
    // The box in the right page's terms: the left page's line 200 mm to the left.
    const box = partsBox(parts)!;
    expect(box[0]).toBeLessThan(-40);
    expect(box[2]).toBeGreaterThan(50);
    // A page not on the screen is left out.
    expect(pageParts(project, right.id, items, slots.slice(0, 1)).map((part) => part.page.id)).toEqual([right.id]);
    expect(namedItems(items, right.id).every((item) => item.pageId)).toBe(true);
  });
});

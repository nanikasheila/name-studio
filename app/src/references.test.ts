import { describe, expect, it } from "vitest";
import { History } from "./history";
import type { StoredImage } from "./model";
import { trimBox } from "./pagebox";
import { newProject } from "./project";
import { projectJson } from "./projectjson";
import { addReference, corners, referenceAt, removeReference, resizeBox, savedForm, usedImages } from "./references";
import { repair } from "./repair";
import { Snapshotter } from "./snapshot";

const picture = (id: string, widthPx = 400, heightPx = 300): StoredImage => ({
  id,
  name: `${id}.jpg`,
  mime: "image/jpeg",
  dataBase64: "A".repeat(1000) + id,
  widthPx,
  heightPx,
});

describe("資料画像", () => {
  it("lies centred on the page, its shape kept, inside the trim", () => {
    const project = newProject("a", 2);
    const page = project.pages[0];
    const reference = addReference(project, page, picture("image1"));
    const [tx0, ty0, tx1, ty1] = trimBox(project.pageFormat);
    const [x0, y0, x1, y1] = reference.box;
    expect((x0 + x1) / 2).toBeCloseTo((tx0 + tx1) / 2);
    expect((y0 + y1) / 2).toBeCloseTo((ty0 + ty1) / 2);
    expect((y1 - y0) / (x1 - x0)).toBeCloseTo(0.75);
    expect(x1 - x0).toBeLessThanOrEqual(tx1 - tx0);
    expect(project.images).toHaveLength(1);
    // A tall picture is fitted to the height.
    const tall = addReference(project, page, picture("image2", 100, 1000), [50, 60]);
    expect(tall.box[3] - tall.box[1]).toBeCloseTo((ty1 - ty0) * 0.8);
    expect((tall.box[0] + tall.box[2]) / 2).toBeCloseTo(50);
    // The same picture twice is kept once.
    addReference(project, project.pages[1], project.images![0]);
    expect(project.images).toHaveLength(2);
    expect(referenceAt(page, [50, 60])?.id).toBe(tall.id);
    expect(referenceAt(page, [-100, -100])).toBeUndefined();
  });

  it("resizes from a corner, the opposite one staying put", () => {
    const box: [number, number, number, number] = [10, 10, 50, 40];
    const bigger = resizeBox(box, 2, [90, 40]);
    expect(bigger).toEqual([10, 10, 90, 70]);
    // Dragged past the opposite corner, it turns over rather than going negative.
    const turned = resizeBox(box, 2, [0, 0]);
    expect(turned[2] - turned[0]).toBeGreaterThanOrEqual(5);
    expect(turned[2]).toBe(10);
    const smallest = resizeBox(box, 0, [50, 40]);
    expect(smallest[2] - smallest[0]).toBe(5);
    expect(corners(box)[2]).toEqual([50, 40]);
  });

  it("saves only the pictures some page shows", () => {
    const project = newProject("a", 1);
    const page = project.pages[0];
    const kept = addReference(project, page, picture("image1"));
    const gone = addReference(project, page, picture("image2"));
    removeReference(page, gone.id);
    expect(usedImages(project).map((i) => i.id)).toEqual([kept.image]);
    const saved = savedForm(project);
    expect(saved.images).toHaveLength(1);
    expect(project.images).toHaveLength(2);
    removeReference(page, kept.id);
    expect(page.references).toBeUndefined();
    expect(savedForm(project).images).toBeUndefined();
    expect(JSON.parse(projectJson(savedForm(project))).images).toBeUndefined();
  });

  it("is shared, not copied, by undo", () => {
    const project = newProject("a", 1);
    const history = new History(new Snapshotter<typeof project>());
    const image = picture("image1");
    const before = history.snapshot(project);
    addReference(project, project.pages[0], image);
    history.recordSnapshot(before);
    const after = history.snapshot(project);
    expect(after.head.json).not.toContain(image.dataBase64);
    expect(after.head.lists).toContain(image.dataBase64);
    const undone = history.undo(project)!;
    expect(undone.images ?? []).toHaveLength(0);
    const redone = history.redo(undone)!;
    expect(redone.images![0].dataBase64).toBe(image.dataBase64);
    expect(redone.pages[0].references).toHaveLength(1);
  });

  it("drops a reference whose picture is gone when mending", () => {
    const project = newProject("a", 1);
    const reference = addReference(project, project.pages[0], picture("image1"));
    project.images = [];
    const mended = repair(project);
    expect(mended.some((m) => m.includes(reference.id))).toBe(true);
    expect(project.pages[0].references).toBeUndefined();
  });
});

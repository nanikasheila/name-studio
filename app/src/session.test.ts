import { describe, expect, it } from "vitest";
import { newProject } from "./project";
import { Session } from "./session";

describe("an editing session", () => {
  it("opens a name with nothing to undo and nothing unsaved", () => {
    const session = new Session();
    const project = session.open(newProject("テスト", 2), "a.namestudio");
    expect(session.project).toBe(project);
    expect([session.path, session.dirty, session.canUndo, session.inStep]).toEqual(["a.namestudio", false, false, false]);
  });

  it("makes a begun and committed change one undo step", () => {
    let told = 0;
    const session = new Session(() => told++);
    session.open(newProject("テスト", 2), null);
    session.begin();
    expect(session.inStep).toBe(true);
    session.project!.title = "変えた";
    expect(session.commit()).toBe(true);
    expect([session.dirty, session.canUndo, told]).toEqual([true, true, 1]);
    expect(session.undo()).toBe(true);
    expect(session.project!.title).toBe("テスト");
    expect(session.redo()).toBe(true);
    expect(session.project!.title).toBe("変えた");
    expect(session.commit()).toBe(false);
  });

  it("rolls back a step under way", () => {
    const session = new Session();
    session.open(newProject("テスト", 2), null);
    session.begin();
    session.project!.pages.splice(0, 1);
    expect(session.rollBack()).toBe(true);
    expect(session.project!.pages).toHaveLength(2);
    expect([session.inStep, session.canUndo, session.rollBack()]).toEqual([false, false, false]);
  });

  it("stays unsaved when a change came while saving", () => {
    const session = new Session();
    session.open(newProject("テスト", 1), null);
    session.markDirty();
    const revision = session.revision;
    session.markDirty();
    session.saved("b.namestudio", revision);
    expect([session.path, session.dirty]).toEqual(["b.namestudio", true]);
    session.autosaved(session.revision);
    expect(session.dirty).toBe(false);
  });

  it("records many small edits as one step, only when they changed something", () => {
    const session = new Session();
    session.open(newProject("テスト", 1), null);
    let before = session.snapshot();
    before = session.recordSince(before);
    expect(session.canUndo).toBe(false);
    session.project!.title = "テ";
    session.project!.title = "テス";
    session.recordSince(before);
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(session.project!.title).toBe("テスト");
  });

  it("puts an earlier version in as a step that can be undone", () => {
    const session = new Session();
    session.open(newProject("今", 1), null);
    session.replace(newProject("前", 3));
    expect([session.project!.title, session.project!.pages.length, session.dirty]).toEqual(["前", 3, true]);
    session.undo();
    expect(session.project!.title).toBe("今");
  });
});

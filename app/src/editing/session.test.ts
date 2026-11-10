import { describe, expect, it } from "vitest";
import { newProject } from "../domain/project";
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

  it("records no step for a change that changed nothing, and keeps what can be redone", () => {
    let told = 0;
    const session = new Session(() => told++);
    session.open(newProject("テスト", 2), null);
    session.begin();
    session.project!.title = "変えた";
    session.commit();
    expect(session.undo()).toBe(true);
    told = 0;
    // A click that moved nothing: no step, nothing unsaved, the redo still there.
    session.begin();
    expect(session.commit()).toBe(true);
    expect([session.historyDepth, told]).toEqual([{ undo: 0, redo: 1 }, 0]);
    expect(session.redo()).toBe(true);
    expect(session.project!.title).toBe("変えた");
    // A change said to be one (a line drawn) is recorded without comparing.
    session.begin();
    expect(session.commit(true)).toBe(true);
    expect(session.historyDepth.undo).toBe(2);
  });

  it("makes undo and redo of page operations exact", () => {
    const session = new Session();
    session.open(newProject("テスト", 3), null);
    const ids = session.project!.pages.map((p) => p.id);
    session.begin();
    session.project!.pages.splice(1, 1);
    session.commit();
    session.begin();
    session.project!.pages.reverse();
    session.commit();
    session.undo();
    session.undo();
    expect(session.project!.pages.map((p) => p.id)).toEqual(ids);
    session.redo();
    session.redo();
    expect(session.project!.pages.map((p) => p.id)).toEqual([ids[2], ids[0]]);
    expect(session.canRedo).toBe(false);
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

  it("leaves a name opened since alone when an older save ends", () => {
    const session = new Session();
    session.open(newProject("A", 1), "a.namestudio");
    const a = session.id;
    session.markDirty();
    const revision = session.revision;
    session.open(newProject("B", 1), "b.namestudio");
    session.markDirty();
    expect(session.saved("a.namestudio", revision, a)).toBe(false);
    expect(session.autosaved(revision, a)).toBe(false);
    expect([session.path, session.dirty]).toEqual(["b.namestudio", true]);
    // Save As keeps the same name.
    const b = session.id;
    expect(session.saved("c.namestudio", session.revision, b)).toBe(true);
    expect([session.id, session.path, session.dirty]).toEqual([b, "c.namestudio", false]);
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

// The open name as one editing session: the project, where it is saved,
// whether it has changes not yet saved, and the undo steps. Nothing here
// draws or stores: the workbench draws after a change and saves; this keeps
// the steps and the unsaved state straight.
import { History } from "./history";
import type { Project } from "./model";
import { normalize } from "./project";
import { type Snapshot, Snapshotter, sameSnapshot } from "./snapshot";

export class Session {
  private readonly history = new History<Project, Snapshot>(new Snapshotter<Project>());
  private current: Project | null = null;
  private file: string | null = null;
  private unsaved = false;
  /** Counts changes, so a save knows whether more came while it ran. */
  private count = 0;
  /** Counts the names opened, so a save that ends after another was opened leaves it alone. */
  private opened = 0;
  /** Snapshot taken by `begin`, recorded by `commit`. */
  private pending: Snapshot | null = null;

  /** `changed` is told of every change (autosave listens). */
  constructor(private readonly changed: () => void = () => undefined) {}

  get project(): Project | null {
    return this.current;
  }

  get path(): string | null {
    return this.file;
  }

  get dirty(): boolean {
    return this.unsaved;
  }

  get revision(): number {
    return this.count;
  }

  /** Which opened name this is: a new one for each `open`, kept through Save As. */
  get id(): number {
    return this.opened;
  }

  /** A step is under way (begun, not yet committed). */
  get inStep(): boolean {
    return this.pending !== null;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /** How many steps can be undone and redone. */
  get historyDepth(): { undo: number; redo: number } {
    return this.history.depth;
  }

  /** Start on `project` (saved at `path`, if anywhere) with nothing to undo. */
  open(project: Project, path: string | null): Project {
    this.current = normalize(project);
    this.file = path;
    this.unsaved = false;
    this.pending = null;
    this.opened += 1;
    this.history.clear();
    return this.current;
  }

  /** Note a change: it is unsaved now. */
  markDirty(): void {
    this.unsaved = true;
    this.count += 1;
    this.changed();
  }

  /**
   * Saved at `path` as it was at `revision`: unsaved only if more came since.
   * False, changing nothing, when another name was opened since (`id` is the
   * one that was saved).
   */
  saved(path: string, revision: number, id = this.opened): boolean {
    if (id !== this.opened) return false;
    this.file = path;
    if (this.count === revision) this.unsaved = false;
    return true;
  }

  /** Written to its own file by autosave, as it was at `revision` (see `saved`). */
  autosaved(revision: number, id = this.opened): boolean {
    if (id !== this.opened) return false;
    if (this.count === revision) this.unsaved = false;
    return true;
  }

  /** Remember the project as it is before a step changes it. */
  begin(): void {
    if (this.current) this.pending = this.history.snapshot(this.current);
  }

  /** The step is done: one undo brings back what `begin` saw. False when none was begun. */
  commit(): boolean {
    if (this.pending === null) return false;
    this.history.recordSnapshot(this.pending);
    this.pending = null;
    this.markDirty();
    return true;
  }

  /** Forget the step under way, keeping what it changed out of the undo list. */
  cancel(): void {
    this.pending = null;
  }

  /** Undo the step under way, so the name is never left half changed. False when none was. */
  rollBack(): boolean {
    const pending = this.pending;
    if (pending === null) return false;
    this.pending = null;
    this.current = this.history.revert(pending);
    return true;
  }

  undo(): boolean {
    return this.current !== null && this.step(this.history.undo(this.current));
  }

  redo(): boolean {
    return this.current !== null && this.step(this.history.redo(this.current));
  }

  /** Put `project` in place of the open one as one step that can be undone (an earlier version). */
  replace(project: Project): void {
    if (this.current) this.history.record(this.current);
    this.current = normalize(project);
    this.markDirty();
  }

  /** A snapshot now, for a change made in many small edits (a text field typed in). */
  snapshot(): Snapshot | null {
    return this.current ? this.history.snapshot(this.current) : null;
  }

  /**
   * The small edits since `before` become one undo step (when they changed
   * anything). Returns the snapshot now, to go on from.
   */
  recordSince(before: Snapshot | null): Snapshot | null {
    const now = this.snapshot();
    if (before !== null && now !== null && !sameSnapshot(before, now)) this.history.recordSnapshot(before);
    return now;
  }

  private step(project: Project | null): boolean {
    if (!project) return false;
    this.current = project;
    this.markDirty();
    return true;
  }
}

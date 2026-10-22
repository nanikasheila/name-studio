// Undo and redo by whole-project snapshots. A project is small (text and
// coordinates; pixels stay in the source sheet), so copies are cheap.

export class History<T> {
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  constructor(private readonly limit = 200) {}

  /** Remember `current` before it changes. */
  record(current: T): void {
    this.recordSnapshot(JSON.stringify(current));
  }

  /** Remember a snapshot taken earlier (for a text field edited live). */
  recordSnapshot(snapshot: string): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Forget the last record, for a change that turned out to change nothing. */
  drop(): void {
    this.undoStack.pop();
  }

  undo(current: T): T | null {
    const previous = this.undoStack.pop();
    if (previous === undefined) return null;
    this.redoStack.push(JSON.stringify(current));
    return JSON.parse(previous) as T;
  }

  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(JSON.stringify(current));
    return JSON.parse(next) as T;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}

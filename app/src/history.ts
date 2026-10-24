// Undo and redo by snapshots of the whole project. Snapshots share what did
// not change (snapshot.ts), so a long history of a drawn name stays small.

/** How a value becomes a snapshot and back. */
export interface Codec<T, S> {
  take(value: T): S;
  restore(snapshot: S): T;
  forget?(): void;
}

const jsonCodec: Codec<unknown, string> = {
  take: (value) => JSON.stringify(value),
  restore: (snapshot) => JSON.parse(snapshot),
};

export class History<T, S = string> {
  private undoStack: S[] = [];
  private redoStack: S[] = [];

  constructor(
    private readonly codec: Codec<T, S> = jsonCodec as Codec<T, S>,
    private readonly limit = 200,
  ) {}

  /** A snapshot of `current`, to record later (a change in several steps). */
  snapshot(current: T): S {
    return this.codec.take(current);
  }

  /** Remember `current` before it changes. */
  record(current: T): void {
    this.recordSnapshot(this.codec.take(current));
  }

  /** Remember a snapshot taken earlier (for a text field edited live). */
  recordSnapshot(snapshot: S): void {
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
    this.redoStack.push(this.codec.take(current));
    return this.codec.restore(previous);
  }

  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(this.codec.take(current));
    return this.codec.restore(next);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.codec.forget?.();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}

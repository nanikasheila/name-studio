// Fields in the palettes that show on the page as they change: a text field
// is one undo step from focus to change, a number one step a moment after the
// last turn of the wheel or the arrows.
import type { Session } from "./session";

/** What live fields need from the editor around them. */
export interface LiveFieldsHost {
  readonly session: Session;
  /** A change showed: the page is drawn again and the title says it is unsaved. */
  changed(): void;
  /** An undo step was recorded. */
  recorded(): void;
  /** A text field's edit is done: the lists beside the pages catch up. */
  settled(): void;
}

export class LiveFields {
  constructor(private readonly host: LiveFieldsHost) {}

  /** A text field edited live; the whole edit becomes one undo step. */
  text(field: HTMLInputElement | HTMLTextAreaElement, apply: (value: string) => void): void {
    const session = this.host.session;
    let snapshot: ReturnType<Session["snapshot"]> = null;
    field.addEventListener("focus", () => (snapshot = session.snapshot()));
    field.addEventListener("input", () => {
      apply(field.value);
      session.markDirty();
      this.host.changed();
    });
    field.addEventListener("change", () => {
      snapshot = session.recordSince(snapshot);
      this.host.settled();
      this.host.recorded();
    });
  }

  /**
   * A number edited live: typing, the arrows and the mouse wheel (over the
   * field, focused or not) show at once on the page; a moment after the last
   * change it becomes one undo step. The field stays where it is, so the
   * wheel can go on turning.
   */
  number(field: HTMLInputElement, apply: (value: number) => void): void {
    const session = this.host.session;
    let snapshot: ReturnType<Session["snapshot"]> = null;
    let timer: number | undefined;
    const record = () => {
      window.clearTimeout(timer);
      timer = undefined;
      session.recordSince(snapshot);
      snapshot = null;
      this.host.recorded();
    };
    const set = (value: number) => {
      if (!Number.isFinite(value) || value <= 0) return;
      snapshot ??= session.snapshot();
      apply(value);
      session.markDirty();
      this.host.changed();
      window.clearTimeout(timer);
      timer = window.setTimeout(record, 700);
    };
    field.addEventListener("input", () => set(Number(field.value)));
    field.addEventListener("change", (event) => event.stopPropagation());
    field.addEventListener("blur", record);
    field.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const step = Number(field.step) || 1;
        const [min, max] = [Number(field.min || -Infinity), Number(field.max || Infinity)];
        const next = Math.min(max, Math.max(min, Math.round((Number(field.value) + (event.deltaY < 0 ? step : -step)) / step) * step));
        if (next === Number(field.value)) return;
        field.value = String(next);
        set(next);
      },
      { passive: false },
    );
  }
}

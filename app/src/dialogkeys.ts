// Enter in a text field of a dialog. A dialog's form (method="dialog") takes
// Enter in a field as a press of its first button, and that button is 閉じる
// or やめる: a title typed for a new name and Enter threw the name away, and
// Enter in the settings' search closed the settings. Here Enter presses the
// dialog's main button when it has one that closes the dialog (作る), and
// otherwise only settles the field as leaving it does; the dialog stays open.

/** The kinds of field Enter is typed in (not a checkbox, a slider or a file). */
const TEXT_TYPES: ReadonlySet<string> = new Set(["text", "search", "number", "url", "email", "tel", "password"]);

/** What of a key press matters here. */
export interface EnterPress {
  key: string;
  isComposing: boolean;
  keyCode?: number;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

/**
 * Enter alone, not taken by the field itself and not the Enter that ends a
 * word being composed (かな漢字変換 settles with Enter: keyCode 229).
 */
export function isPlainEnter(event: EnterPress): boolean {
  if (event.key !== "Enter" || event.defaultPrevented) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  return !(event.ctrlKey || event.altKey || event.metaKey || event.shiftKey);
}

/** Whether Enter in a field of this type is ours to answer. */
export function isTextField(type: string): boolean {
  return TEXT_TYPES.has(type);
}

/** The dialog's main button that closes it with an answer (作る), if it has one to press now. */
function mainButton(form: HTMLFormElement): HTMLButtonElement | null {
  for (const button of form.querySelectorAll<HTMLButtonElement>("button.primary")) {
    if (button.type === "submit" && !button.disabled && button.value !== "cancel" && !button.hidden) return button;
  }
  return null;
}

/** Answer Enter in the text fields of every dialog of `root`. */
export function installDialogEnter(root: Document = document): void {
  root.addEventListener("keydown", (event) => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || !isTextField(field.type) || !isPlainEnter(event)) return;
    const form = field.form;
    if (form?.method !== "dialog") return;
    event.preventDefault();
    const main = mainButton(form);
    if (main) {
      main.click();
      return;
    }
    // Settle what was typed (a change, as when the field is left) and stay in the field.
    field.blur();
    field.focus();
  });
}

// Problems the person must see: a save that did not happen, an operation
// undone after an error. The status line is easy to miss for these.

const shown = new Map<string, HTMLElement>();

/** A button on an alert that deals with it: the next step (try again, save elsewhere, open the folder). */
export interface AlertAction {
  label: string;
  run: () => void;
}

/**
 * Show `message` at the top of the window until closed (or, when `seconds`
 * is given, for that long). A message with the same `key` replaces the last.
 */
export function showAlert(
  key: string,
  message: string,
  kind: "error" | "warning" | "info" = "error",
  seconds?: number,
  action?: AlertAction | readonly AlertAction[],
): void {
  const host = document.getElementById("alerts");
  if (!host) return;
  clearAlert(key);
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.title = "閉じる";
  close.addEventListener("click", () => clearAlert(key));
  const text = document.createElement("p");
  text.textContent = message;
  const alert = document.createElement("div");
  alert.className = `alert ${kind}`;
  alert.setAttribute("role", "alert");
  alert.append(text);
  const steps = action ? (Array.isArray(action) ? action : [action as AlertAction]) : [];
  const actions = document.createElement("div");
  actions.className = "alert-actions";
  for (const step of steps) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "alert-action";
    button.textContent = step.label;
    button.addEventListener("click", () => {
      clearAlert(key);
      step.run();
    });
    actions.append(button);
  }
  if (steps.length) alert.append(actions);
  alert.append(close);
  host.append(alert);
  shown.set(key, alert);
  if (seconds) window.setTimeout(() => shown.get(key) === alert && clearAlert(key), seconds * 1000);
}

export function clearAlert(key: string): void {
  shown.get(key)?.remove();
  shown.delete(key);
}

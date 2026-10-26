// Problems the person must see: a save that did not happen, an operation
// undone after an error. The status line is easy to miss for these.

const shown = new Map<string, HTMLElement>();

/** A button on an alert that deals with it (try again). */
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
  kind: "error" | "warning" = "error",
  seconds?: number,
  action?: AlertAction,
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
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "alert-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      clearAlert(key);
      action.run();
    });
    alert.append(button);
  }
  alert.append(close);
  host.append(alert);
  shown.set(key, alert);
  if (seconds) window.setTimeout(() => shown.get(key) === alert && clearAlert(key), seconds * 1000);
}

export function clearAlert(key: string): void {
  shown.get(key)?.remove();
  shown.delete(key);
}

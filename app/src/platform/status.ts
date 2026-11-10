// The line at the bottom right that says what just happened. A failure looks
// like one (its colour, a mark, announced at once to a screen reader), says
// what to do in words (errortext.ts), stays until the next message, and opens
// on a click to show all of it with the error as it came. It is also shown
// over the page for a few seconds, as the corner is easy to miss.
import { showAlert } from "./alerts";
import { $ } from "./dom";
import { logError } from "./errorlog";
import { explain, rawText } from "./errortext";

export type StatusKind = "info" | "error";

/** A failure as the line shows it, and what a click on it shows: the message and the error as it came. */
let short = "";
let whole = "";
const MORE = "（クリックで詳しく）";

function close(status: HTMLElement): void {
  status.classList.remove("open");
  status.setAttribute("aria-expanded", "false");
}

/** Say `message` in the status line. `more`: the rest of a failure, shown when it is opened. */
export function showStatus(message: string, kind: StatusKind = "info", more = ""): void {
  const status = $("status");
  const failed = kind === "error";
  close(status);
  short = failed && more ? `${message}${MORE}` : message;
  status.textContent = short;
  status.classList.toggle("error", failed);
  status.setAttribute("role", failed ? "alert" : "status");
  if (failed) {
    whole = more ? `${message}\n\n${more}` : message;
    status.tabIndex = 0;
    status.title = "クリックで全部を表示";
  } else {
    whole = "";
    status.removeAttribute("tabindex");
    status.removeAttribute("aria-expanded");
    status.title = "";
  }
}

/** How long a failure stays over the page (it stays in the status line until the next message). */
const ALERT_SECONDS = 8;

/**
 * `what` did not work ("保存できませんでした"), because of `error`: said in the
 * status line as a failure and over the page for a few seconds, and noted in
 * the error log as it came. `quiet`: the status line only (the caller shows
 * an alert of its own). Returns the message shown.
 */
export function fail(what: string, error: unknown, quiet = false): string {
  const { text, detail } = explain(error);
  const message = `${what}: ${text}`;
  showStatus(message, "error", detail ?? "");
  if (!quiet) showAlert("status-failure", message, "error", ALERT_SECONDS);
  void logError(`${what}: ${rawText(error)}`);
  return message;
}

/** Open and close a failure in the status line with a click or Enter (once, at start). */
export function installStatus(): void {
  const status = $("status");
  const toggle = (): void => {
    if (!whole) return;
    const open = !status.classList.contains("open");
    status.classList.toggle("open", open);
    status.setAttribute("aria-expanded", String(open));
    status.textContent = open ? whole : short;
  };
  // A click opens it; once open, clicks inside select its text (outside, Escape and Enter close it).
  status.addEventListener("click", () => {
    if (!status.classList.contains("open")) toggle();
  });
  status.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    } else if (event.key === "Escape" && status.classList.contains("open")) {
      event.stopPropagation();
      toggle();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (status.classList.contains("open") && event.target !== status) toggle();
  });
}

// 欄を巡る: the keyboard goes from one part of the screen to the next (F8,
// Shift+F8 back), as F6 does in other apps. Tab is 「ページだけ」 here and
// most keys are tools, so without this the 欄 could only be reached with the
// pointer. Inside a part, Tab and the arrow keys work as the browser has them.

interface Pane {
  name: string;
  /** The part's element, when it is on screen. */
  root: () => HTMLElement | null;
  /** The part is one thing to put the keyboard on (the page), not a holder of buttons. */
  whole?: boolean;
}

const PANES: readonly Pane[] = [
  { name: "上の帯", root: () => document.querySelector<HTMLElement>("header.toolbar") },
  { name: "左の欄", root: () => document.getElementById("dock-left") },
  { name: "道具", root: () => document.getElementById("editor-tools") },
  { name: "道具の設定", root: () => document.getElementById("tool-options") },
  { name: "ページ", root: () => document.getElementById("editor-canvas"), whole: true },
  { name: "ページの送りと見せ方", root: () => document.getElementById("page-nav") },
  { name: "物語の帯", root: () => document.getElementById("story") },
  { name: "右の欄", root: () => document.getElementById("dock-right") },
];

const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

function shown(element: HTMLElement): boolean {
  if (element.closest("[hidden]") || element.getClientRects().length === 0) return false;
  return getComputedStyle(element).visibility !== "hidden";
}

/** What the keyboard lands on in a part: the part itself, or the first thing in it that can be pressed. */
function landing(pane: Pane): HTMLElement | null {
  const root = pane.root();
  if (!root || !shown(root)) return null;
  if (pane.whole) return root;
  for (const element of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (shown(element) && !(element as HTMLButtonElement).disabled) return element;
  }
  return null;
}

/** The part the keyboard is in now (the page when it is nowhere in particular). */
function current(active: Element | null): number {
  const at = PANES.findIndex((pane) => {
    const root = pane.root();
    return !!root && !!active && (root === active || root.contains(active));
  });
  return at >= 0 ? at : PANES.findIndex((pane) => pane.whole);
}

/**
 * Put the keyboard on the next part of the screen that has something to
 * press (`step` -1: the one before), going round. Returns the part's name,
 * or null when there is nowhere else to go.
 */
export function movePane(step: 1 | -1): string | null {
  const from = current(document.activeElement);
  for (let i = 1; i < PANES.length; i++) {
    const pane = PANES[(from + step * i + PANES.length * i) % PANES.length];
    const target = landing(pane);
    if (!target) continue;
    // The page takes the keyboard without being a stop for Tab.
    if (pane.whole && !target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    if (document.activeElement !== target) continue;
    mark(pane.root() ?? target);
    return pane.name;
  }
  return null;
}

/** Show for a moment which part the keyboard went to. */
function mark(root: HTMLElement): void {
  for (const old of document.querySelectorAll(".pane-arrived")) old.classList.remove("pane-arrived");
  root.classList.add("pane-arrived");
  window.setTimeout(() => root.classList.remove("pane-arrived"), 900);
}

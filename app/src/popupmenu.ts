// A menu that opens where the pointer is (right click) or under an element:
// the page list's and the story band's page menus. Arrow keys move, Enter
// runs, Escape or a press elsewhere closes it.
import { element } from "./dom";

export interface MenuItem {
  label: string;
  /** Its key as shown on the right (Ctrl+D). */
  keys?: string;
  /** What it does in a word or two more, on hover. */
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

/** A line between groups of items. */
export const SEPARATOR = "-" as const;

let open: { menu: HTMLElement; close: () => void } | null = null;

/** Close the menu that is open, if any. */
export function closeMenu(): void {
  open?.close();
}

export function isMenuOpen(): boolean {
  return open !== null;
}

/** Open a menu at (x, y) in the window, kept inside it. */
export function openMenu(items: readonly (MenuItem | typeof SEPARATOR)[], x: number, y: number, label = "メニュー"): HTMLElement {
  closeMenu();
  const menu = element("div", { className: "popup-menu" });
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === SEPARATOR) {
      menu.append(element("div", { className: "popup-separator" }));
      continue;
    }
    const button = element(
      "button",
      { type: "button", disabled: !!item.disabled, className: item.danger ? "danger" : "", title: item.title ?? "" },
      element("span", { className: "popup-label", textContent: item.label }),
      element("span", { className: "popup-keys", textContent: item.keys ?? "" }),
    );
    button.setAttribute("role", "menuitem");
    button.addEventListener("click", () => {
      close();
      item.run();
    });
    menu.append(button);
    buttons.push(button);
  }
  const usable = () => buttons.filter((b) => !b.disabled);
  const focusStep = (step: number) => {
    const list = usable();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(at + step + list.length) % list.length].focus();
  };
  menu.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "ArrowDown") focusStep(1);
    else if (event.key === "ArrowUp") focusStep(-1);
    else if (event.key === "Home") usable()[0]?.focus();
    else if (event.key === "End") usable().at(-1)?.focus();
    else if (event.key === "Escape" || event.key === "Tab") close();
    else return;
    event.preventDefault();
  });
  const outside = (event: Event) => {
    if (!menu.contains(event.target as Node)) close();
  };
  const previous = document.activeElement as HTMLElement | null;
  function close(): void {
    if (open?.menu !== menu) return;
    open = null;
    menu.remove();
    window.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }
  open = { menu, close };
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.append(menu);
  const box = menu.getBoundingClientRect();
  if (box.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - box.width - 4)}px`;
  if (box.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - box.height - 4)}px`;
  window.addEventListener("pointerdown", outside, true);
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
  usable()[0]?.focus({ preventScroll: true });
  return menu;
}

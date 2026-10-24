// Small helpers for building the app's HTML from code.

/** The element with this id (the app's page always has it). */
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** A new element with these properties and children. */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/** A drop-down of labelled values. */
export function choice<T extends string>(labels: Record<T, string>, value: T, change: (value: T) => void, skip: T[] = []): HTMLSelectElement {
  const select = element("select");
  for (const [key, label] of Object.entries(labels) as [T, string][]) {
    if (!skip.includes(key) || key === value) select.append(element("option", { value: key, textContent: label }));
  }
  select.value = value;
  select.addEventListener("change", () => change(select.value as T));
  return select;
}

/** A button that runs `action` when clicked. */
export function plainButton(label: string, action: () => void): HTMLButtonElement {
  const b = element("button", { textContent: label });
  b.addEventListener("click", action);
  return b;
}

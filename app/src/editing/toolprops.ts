// ツールプロパティに出す項目 (as CSP's ツールプロパティ and the wrench under
// it): for each sub tool, which of its settings the palette shows and in what
// order. A choice is kept by the sub tool's ref (the same in every name),
// or for all of a tool's sub tools at once ("pen:*"); what has no choice
// shows what its source offers out of the box.

/** One setting the palette can show. */
export interface PropItem {
  /** Stays the same (kept in the choices): a CSP column ("Opacity") or "ns:…" for the app's own. */
  id: string;
  label: string;
  /** Its heading among the others (CSP's groups for pens). */
  group: string;
  /** What it does, on hover. */
  hint?: string;
}

/** Sub tool ref (or "<tool>:*") → the item ids shown, top to bottom. */
export type ToolPropChoices = Record<string, string[]>;

/** The key of a choice made for every sub tool of a tool. */
export function kindKey(tool: string): string {
  return `${tool}:*`;
}

/** The kept choices (anything unreadable left out). */
export function choicesFrom(value: unknown): ToolPropChoices {
  const choices: ToolPropChoices = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return choices;
  for (const [key, items] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(items)) continue;
    const ids = items.filter((id): id is string => typeof id === "string");
    choices[key] = [...new Set(ids)];
  }
  return choices;
}

/** Whether the sub tool shows a choice of its own (not its tool's, nor the one out of the box). */
export function hasOwnChoice(choices: ToolPropChoices, ref: string): boolean {
  return Array.isArray(choices[ref]);
}

/**
 * The items a sub tool shows: its own choice, else its tool's, else those out
 * of the box, each only when it can be shown for this sub tool now.
 */
export function shownItems(
  choices: ToolPropChoices,
  ref: string,
  tool: string,
  available: readonly PropItem[],
  fallback: readonly string[],
): string[] {
  const ids = new Set(available.map((item) => item.id));
  const chosen = choices[ref] ?? choices[kindKey(tool)] ?? fallback;
  return chosen.filter((id) => ids.has(id));
}

/** The choices with `key` set to `items` (null: back to what comes next, its tool's or out of the box). */
export function withChoice(choices: ToolPropChoices, key: string, items: readonly string[] | null): ToolPropChoices {
  const next = { ...choices };
  if (items) next[key] = [...new Set(items)];
  else delete next[key];
  return next;
}

/** Every sub tool of the tool shows `items`: its own choices go, the tool's is set. */
export function withChoiceForTool(choices: ToolPropChoices, tool: string, items: readonly string[]): ToolPropChoices {
  const next: ToolPropChoices = {};
  for (const [key, value] of Object.entries(choices)) if (!key.startsWith(`${tool}:`)) next[key] = value;
  next[kindKey(tool)] = [...new Set(items)];
  return next;
}

/**
 * `shown` with `id` shown or not. One shown anew goes where it comes among
 * those shown, by the order of `available` (as CSP keeps its own order).
 */
export function toggledItem(shown: readonly string[], id: string, on: boolean, available: readonly PropItem[]): string[] {
  const rest = shown.filter((x) => x !== id);
  if (!on) return rest;
  const order = available.map((item) => item.id);
  const at = order.indexOf(id);
  const before = rest.findIndex((x) => {
    const other = order.indexOf(x);
    return other > at;
  });
  if (at < 0 || before < 0) return [...rest, id];
  rest.splice(before, 0, id);
  return rest;
}

/** `shown` with `first`..`last` put before the one at `target` (as the lists' drag sort gives them). */
export function movedItems(shown: readonly string[], first: number, last: number, target: number): string[] {
  const moved = shown.slice(first, last + 1);
  const rest = shown.filter((_, i) => i < first || i > last);
  const at = target <= first ? target : target - moved.length;
  rest.splice(Math.max(0, Math.min(rest.length, at)), 0, ...moved);
  return rest;
}

/** Items whose label, group or id has every word of `query` (any case). */
export function matchingItems(available: readonly PropItem[], query: string): PropItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...available];
  return available.filter((item) => {
    const text = `${item.label} ${item.group} ${item.id} ${item.hint ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

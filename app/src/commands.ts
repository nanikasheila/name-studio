// Commands: everything that can be done by name, each with what it is called,
// where it belongs, its keys out of the box and what it does, written in one
// place. The keyboard, the key settings and the command palette (Ctrl+K) all
// read the same list, so a new action is added once.
import type { ActionInfo } from "./shortcuts";

export interface Command extends ActionInfo {
  /** More words to find it by (other names, readings). */
  words?: string;
  /** False when it would do nothing now (nothing selected, no page); the palette shows it greyed. */
  available?: () => boolean;
  /** Does it; false when it did not apply. */
  run: () => boolean;
}

/** How many commands the palette remembers as recently used. */
export const RECENT_COMMANDS = 8;

/**
 * Text as compared when searching: full-width letters and digits made plain,
 * lower case, katakana as hiragana, and no spaces, so that 「ぺん」 finds
 * 「ペン」 and 「ｐｄｆ」 finds 「PDF」.
 */
export function searchText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, "");
}

/**
 * Whether the characters of `query` appear in `text` in order and close
 * together (「せり並べ」 → 「セリフを並べ直す」), not scattered over a long label.
 */
function inOrder(text: string, query: string): boolean {
  if (query.length < 2) return false;
  for (let start = text.indexOf(query[0]); start >= 0; start = text.indexOf(query[0], start + 1)) {
    let at = start + 1;
    let found = true;
    for (const c of query.slice(1)) {
      at = text.indexOf(c, at);
      if (at < 0 || at - start >= query.length * 3) {
        found = false;
        break;
      }
      at += 1;
    }
    if (found) return true;
  }
  return false;
}

/**
 * The commands that match `query`, best first: the label beginning with it,
 * then containing it, then the group, other words or keys containing it, then
 * the label holding its characters in order. Each word of the query must
 * match. Recently used commands come first among equals; with no query, the
 * recent ones lead and the rest follow in their own order.
 */
export function findCommands(query: string, commands: readonly Command[], recent: readonly string[] = []): Command[] {
  const recency = (command: Command) => {
    const index = recent.indexOf(command.id);
    return index < 0 ? recent.length : index;
  };
  const words = query.split(/\s+/).map(searchText).filter(Boolean);
  const scored: { command: Command; score: number; order: number }[] = [];
  commands.forEach((command, order) => {
    if (!words.length) {
      scored.push({ command, score: 0, order });
      return;
    }
    const label = searchText(command.label);
    const rest = searchText(`${command.group} ${command.words ?? ""} ${command.keys.join(" ")}`);
    let score = 0;
    for (const word of words) {
      const own = label.startsWith(word) ? 0 : label.includes(word) ? 1 : rest.includes(word) ? 2 : inOrder(label, word) ? 3 : -1;
      if (own < 0) return;
      score = Math.max(score, own);
    }
    scored.push({ command, score, order });
  });
  return scored.sort((a, b) => a.score - b.score || recency(a.command) - recency(b.command) || a.order - b.order).map(({ command }) => command);
}

/** The recent list with `id` used just now. */
export function usedNow(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((other) => other !== id)].slice(0, RECENT_COMMANDS);
}

/** サブツール: picking one is a command too ("subtool:pen:CSP: ペン / Gペン"), so it can have keys. */
export const SUBTOOL_COMMAND = "subtool:";

export function subtoolCommandId(ref: string): string {
  return `${SUBTOOL_COMMAND}${ref}`;
}

/**
 * Put the sub tools' commands as they are now in place of the ones before
 * (the list is the one the keys and the palette read). False when nothing changed.
 */
export function replaceSubtoolCommands(commands: Command[], fresh: readonly Command[]): boolean {
  const old = commands.filter((command) => command.id.startsWith(SUBTOOL_COMMAND));
  const same = old.length === fresh.length && old.every((command, i) => command.id === fresh[i].id && command.label === fresh[i].label);
  if (same) {
    // The same commands: what they do may hold newer objects.
    old.forEach((command, i) => Object.assign(command, fresh[i]));
    return false;
  }
  const kept = commands.filter((command) => !command.id.startsWith(SUBTOOL_COMMAND));
  commands.splice(0, commands.length, ...kept, ...fresh);
  return true;
}

// Keyboard shortcuts (R16): which keys run which action, changeable and kept
// on this computer. A left-hand device or macro pad is set up to send the
// keys given here.

/** A command's name in the key settings ("tool.pen"); kept with the keys, so it does not change. */
export type ActionId = string;

export interface ActionInfo {
  id: ActionId;
  label: string;
  group: string;
  keys: string[];
}

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"]);

/** A key press as written in the settings ("Ctrl+Shift+S"), or null for a modifier alone. */
export function comboOf(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | null {
  if (MODIFIERS.has(event.key)) return null;
  let key = event.key === " " ? "Space" : event.key;
  if (key.length === 1) key = key.toUpperCase();
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  // Shift is part of a symbol ("?", "!"), but counts for letters and named keys.
  if (event.shiftKey && (key.length > 1 || /[A-Z]/.test(key))) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

const STORAGE_KEY = "namestudio.shortcuts";

/** Keys per action: the defaults with this computer's changes on top. */
export class Shortcuts {
  private custom: Partial<Record<ActionId, string[]>>;
  private readonly listeners: (() => void)[] = [];

  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null,
    /** Every action, with its keys out of the box. */
    readonly actions: readonly ActionInfo[],
  ) {
    this.custom = {};
    try {
      const saved = this.storage?.getItem(STORAGE_KEY);
      if (saved) this.custom = JSON.parse(saved);
    } catch {
      this.custom = {};
    }
  }

  keys(id: ActionId): string[] {
    return this.custom[id] ?? this.actions.find((action) => action.id === id)?.keys ?? [];
  }

  /** The action a key press runs. */
  actionFor(combo: string): ActionId | null {
    for (const action of this.actions) if (this.keys(action.id).includes(combo)) return action.id;
    return null;
  }

  /** Give `combo` to an action; another action that had it loses it. Returns that action. */
  bind(id: ActionId, combo: string): ActionId | null {
    const previous = this.actionFor(combo);
    if (previous === id) return null;
    if (previous) this.set(previous, this.keys(previous).filter((key) => key !== combo));
    // A pen not in this name keeps its keys here: one given away now does not come back with it.
    for (const [other, keys] of Object.entries(this.custom)) {
      if (other !== id && keys?.includes(combo)) this.custom[other] = keys.filter((key) => key !== combo);
    }
    this.set(id, [...this.keys(id), combo]);
    return previous;
  }

  unbind(id: ActionId, combo: string): void {
    this.set(id, this.keys(id).filter((key) => key !== combo));
  }

  reset(): void {
    this.custom = {};
    this.save();
  }

  /** Whether any key differs from the defaults. */
  changed(): boolean {
    return Object.keys(this.custom).length > 0;
  }

  private set(id: ActionId, keys: string[]): void {
    const defaults = this.actions.find((action) => action.id === id)?.keys ?? [];
    if (keys.length === defaults.length && keys.every((key, i) => key === defaults[i])) delete this.custom[id];
    else this.custom[id] = keys;
    this.save();
  }

  /** Run `listener` whenever the keys change. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private save(): void {
    for (const listener of this.listeners) listener();
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.custom));
    } catch {
      // Not kept for the next start; the keys still work now.
    }
  }
}

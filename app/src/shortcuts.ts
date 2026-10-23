// Keyboard shortcuts (R16): which keys run which action, changeable and kept
// on this computer. A left-hand device or macro pad is set up to send the
// keys given here.

export type ActionId =
  | "save"
  | "saveAs"
  | "undo"
  | "redo"
  | "view.edit"
  | "view.structure"
  | "view.emotion"
  | "view.timeline"
  | "view.focus"
  | "view.fit"
  | "view.rotateLeft"
  | "view.rotateRight"
  | "tool.select"
  | "tool.cut"
  | "tool.text"
  | "tool.pen"
  | "tool.eraser"
  | "tool.fill"
  | "tool.breakout"
  | "tool.sticky"
  | "eraser.next"
  | "brush.bigger"
  | "brush.smaller"
  | "delete"
  | "copy"
  | "cut"
  | "paste"
  | "selectAll"
  | "flip.horizontal"
  | "flip.vertical"
  | "deselect"
  | "page.next"
  | "page.previous"
  | "option.make";

export interface ActionInfo {
  id: ActionId;
  label: string;
  group: string;
  keys: string[];
}

/** Every action with its keys out of the box. */
export const ACTIONS: readonly ActionInfo[] = [
  { id: "save", label: "保存", group: "ファイル", keys: ["Ctrl+S"] },
  { id: "saveAs", label: "名前を付けて保存", group: "ファイル", keys: ["Ctrl+Shift+S"] },
  { id: "undo", label: "元に戻す", group: "編集", keys: ["Ctrl+Z"] },
  { id: "redo", label: "やり直す", group: "編集", keys: ["Ctrl+Y", "Ctrl+Shift+Z"] },
  { id: "delete", label: "選んだものを消す", group: "編集", keys: ["Delete", "Backspace"] },
  { id: "copy", label: "コピー", group: "編集", keys: ["Ctrl+C"] },
  { id: "cut", label: "切り取り", group: "編集", keys: ["Ctrl+X"] },
  { id: "paste", label: "貼り付け（ポインターのあるページへ）", group: "編集", keys: ["Ctrl+V"] },
  { id: "selectAll", label: "ページの線とセリフを全部選ぶ", group: "編集", keys: ["Ctrl+A"] },
  { id: "flip.horizontal", label: "選んだ線とセリフを左右反転", group: "編集", keys: [] },
  { id: "flip.vertical", label: "選んだ線とセリフを上下反転", group: "編集", keys: [] },
  { id: "deselect", label: "選択を外す", group: "編集", keys: ["Escape"] },
  { id: "tool.select", label: "選択", group: "道具", keys: ["V"] },
  { id: "tool.cut", label: "コマ割り", group: "道具", keys: ["K"] },
  { id: "tool.text", label: "セリフ", group: "道具", keys: ["T"] },
  { id: "tool.pen", label: "ペン", group: "道具", keys: ["P"] },
  { id: "tool.eraser", label: "消しゴム（もう一度で消し方を切り替え）", group: "道具", keys: ["E"] },
  { id: "tool.fill", label: "投げなわ塗り（ベタ・グレー・白）", group: "道具", keys: ["G"] },
  { id: "tool.breakout", label: "はみ出し", group: "道具", keys: ["B"] },
  { id: "tool.sticky", label: "付箋", group: "道具", keys: ["M"] },
  { id: "eraser.next", label: "消し方を切り替える", group: "道具", keys: [] },
  { id: "brush.bigger", label: "ペン・消しゴムを太く", group: "道具", keys: ["]"] },
  { id: "brush.smaller", label: "ペン・消しゴムを細く", group: "道具", keys: ["["] },
  { id: "page.next", label: "次の見開き（何も選んでいないとき）", group: "ページ", keys: ["ArrowLeft"] },
  { id: "page.previous", label: "前の見開き（何も選んでいないとき）", group: "ページ", keys: ["ArrowRight"] },
  { id: "option.make", label: "このページの別案を作る", group: "ページ", keys: [] },
  { id: "view.edit", label: "編集画面", group: "画面", keys: ["F1"] },
  { id: "view.structure", label: "構成", group: "画面", keys: ["F2"] },
  { id: "view.emotion", label: "感情曲線", group: "画面", keys: ["F3"] },
  { id: "view.timeline", label: "時系列", group: "画面", keys: ["F4"] },
  { id: "view.fit", label: "全体を表示（拡大・移動・回転を戻す）", group: "画面", keys: ["Ctrl+0"] },
  { id: "view.rotateLeft", label: "画面を左に 15° 回す（Shift + Space + ドラッグで自由に）", group: "画面", keys: ["-"] },
  { id: "view.rotateRight", label: "画面を右に 15° 回す", group: "画面", keys: ["^"] },
  { id: "view.focus", label: "左右の欄を隠してページを大きく（もう一度で戻す）", group: "画面", keys: ["Tab"] },
];

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

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()) {
    this.custom = {};
    try {
      const saved = this.storage?.getItem(STORAGE_KEY);
      if (saved) this.custom = JSON.parse(saved);
    } catch {
      this.custom = {};
    }
  }

  keys(id: ActionId): string[] {
    return this.custom[id] ?? ACTIONS.find((action) => action.id === id)?.keys ?? [];
  }

  /** The action a key press runs. */
  actionFor(combo: string): ActionId | null {
    for (const action of ACTIONS) if (this.keys(action.id).includes(combo)) return action.id;
    return null;
  }

  /** Give `combo` to an action; another action that had it loses it. Returns that action. */
  bind(id: ActionId, combo: string): ActionId | null {
    const previous = this.actionFor(combo);
    if (previous === id) return null;
    if (previous) this.set(previous, this.keys(previous).filter((key) => key !== combo));
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
    const defaults = ACTIONS.find((action) => action.id === id)?.keys ?? [];
    if (keys.length === defaults.length && keys.every((key, i) => key === defaults[i])) delete this.custom[id];
    else this.custom[id] = keys;
    this.save();
  }

  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.custom));
    } catch {
      // Not kept for the next start; the keys still work now.
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

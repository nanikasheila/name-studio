// 描画色: the colour the pen, the fill (in 描画色) and the 指示 take, with
// CSP's メイン・サブ, the colours used lately (カラー履歴) and the person's own
// colour set. Kept on this computer, as CSP keeps them: they are how one
// draws, not part of the name.
import { BLACK, normalHex } from "../domain/color";
import { readJson, writeJson } from "../platform/settings";

export const COLORS_KEY = "namestudio.colors";
export const HISTORY_SIZE = 20;
export const MAX_SWATCHES = 48;

interface Kept {
  main: string;
  sub: string;
  history: string[];
  swatches: string[];
}

function read(raw: unknown): Kept {
  const kept = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Kept, unknown>>;
  const color = (value: unknown, fallback: string) => (typeof value === "string" && normalHex(value)) || fallback;
  const list = (value: unknown, size: number) =>
    (Array.isArray(value) ? value : [])
      .map((v) => (typeof v === "string" ? normalHex(v) : null))
      .filter((v): v is string => !!v)
      .filter((v, i, all) => all.indexOf(v) === i)
      .slice(0, size);
  return {
    main: color(kept.main, BLACK),
    sub: color(kept.sub, "#ffffff"),
    history: list(kept.history, HISTORY_SIZE),
    swatches: list(kept.swatches, MAX_SWATCHES),
  };
}

export class DrawColors {
  main: string;
  sub: string;
  history: string[];
  swatches: string[];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly load: () => unknown = () => readJson(COLORS_KEY, null),
    private readonly save: (kept: Kept) => void = (kept) => writeJson(COLORS_KEY, kept),
  ) {
    const kept = read(this.load());
    this.main = kept.main;
    this.sub = kept.sub;
    this.history = kept.history;
    this.swatches = kept.swatches;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.save({ main: this.main, sub: this.sub, history: this.history, swatches: this.swatches });
    for (const listener of this.listeners) listener();
  }

  /** The 描画色 (メイン) from now on; false when it is not a colour or did not change. */
  setMain(color: string): boolean {
    const hex = normalHex(color);
    if (!hex || hex === this.main) return false;
    this.main = hex;
    this.changed();
    return true;
  }

  /** メイン and サブ change places (CSP's 描画色の切り替え). */
  swap(): void {
    [this.main, this.sub] = [this.sub, this.main];
    this.changed();
  }

  /** A colour drawn with: first in the カラー履歴. */
  used(color: string = this.main): void {
    const hex = normalHex(color);
    if (!hex || this.history[0] === hex) return;
    this.history = [hex, ...this.history.filter((c) => c !== hex)].slice(0, HISTORY_SIZE);
    this.changed();
  }

  /** The colour added to the person's own set (at the end); false when it is there already or the set is full. */
  addSwatch(color: string = this.main): boolean {
    const hex = normalHex(color);
    if (!hex || this.swatches.includes(hex) || this.swatches.length >= MAX_SWATCHES) return false;
    this.swatches = [...this.swatches, hex];
    this.changed();
    return true;
  }

  removeSwatch(color: string): void {
    const before = this.swatches.length;
    this.swatches = this.swatches.filter((c) => c !== color);
    if (this.swatches.length !== before) this.changed();
  }

  clearHistory(): void {
    if (!this.history.length) return;
    this.history = [];
    this.changed();
  }
}

/** The app's 描画色. */
export const drawColors = new DrawColors();

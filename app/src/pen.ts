// ペンタブレットの設定 (as CSP's 環境設定 › タブレット and 筆圧検知レベルの調節):
// how hard a press counts, the pen's tilt, its eraser end and side button,
// fingers on the screen, and the cursor. Kept on this computer.
import { curveAt } from "./brush";

export type SideButton = "none" | "pan" | "eraser" | "undo";
export type TouchAction = "pan" | "draw" | "none";
export type PenCursor = "brush" | "cross" | "dot";

export interface PenSettings {
  /** 筆圧カーブ: control points (pen pressure → pressure used), both 0..1. */
  pressureCurve: [number, number][];
  /** Use the pen's tilt (for brushes that change with it). */
  tilt: boolean;
  /** The pen's eraser end erases (with the eraser's way of erasing). */
  eraserEnd: boolean;
  /** The side (barrel) button pressed while the pen touches the page. */
  sideButton: SideButton;
  /** One finger on the page. */
  touch: TouchAction;
  /** Two fingers: pinch to zoom and move the view. */
  pinch: boolean;
  /** Two fingers also turn the view. */
  pinchRotate: boolean;
  /** Tap with two fingers to undo, three to redo. */
  touchTaps: boolean;
  /** 手のひら: fingers are ignored while the pen is near the screen. */
  palmRejection: boolean;
  /** Cursor while drawing: the brush's size, a cross, or a dot. */
  cursor: PenCursor;
}

export const SIDE_BUTTON_LABELS: Record<SideButton, string> = {
  none: "何もしない",
  pan: "画面の移動（手のひら）",
  eraser: "消しゴム",
  undo: "元に戻す",
};

export const TOUCH_LABELS: Record<TouchAction, string> = {
  pan: "画面の移動",
  draw: "描く（ペンと同じ）",
  none: "何もしない",
};

export const CURSOR_LABELS: Record<PenCursor, string> = {
  brush: "ブラシの大きさ",
  cross: "十字",
  dot: "点",
};

export const LINEAR: [number, number][] = [
  [0, 0],
  [1, 1],
];

export function defaultPenSettings(): PenSettings {
  return {
    pressureCurve: LINEAR.map((p) => [...p] as [number, number]),
    tilt: true,
    eraserEnd: true,
    sideButton: "pan",
    touch: "pan",
    pinch: true,
    pinchRotate: true,
    touchTaps: true,
    palmRejection: true,
    cursor: "brush",
  };
}

/** The settings as read back, anything missing or broken taken from the defaults. */
export function parsePenSettings(text: string | null): PenSettings {
  const settings = defaultPenSettings();
  if (!text) return settings;
  let stored: Partial<PenSettings>;
  try {
    stored = JSON.parse(text) as Partial<PenSettings>;
  } catch {
    return settings;
  }
  const curve = stored.pressureCurve;
  if (Array.isArray(curve) && curve.length >= 2 && curve.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && v >= 0 && v <= 1))) {
    settings.pressureCurve = normalizeCurve(curve);
  }
  for (const key of ["tilt", "eraserEnd", "pinch", "pinchRotate", "touchTaps", "palmRejection"] as const) {
    if (typeof stored[key] === "boolean") settings[key] = stored[key];
  }
  if (stored.sideButton && stored.sideButton in SIDE_BUTTON_LABELS) settings.sideButton = stored.sideButton;
  if (stored.touch && stored.touch in TOUCH_LABELS) settings.touch = stored.touch;
  if (stored.cursor && stored.cursor in CURSOR_LABELS) settings.cursor = stored.cursor;
  return settings;
}

/**
 * Points in order of pressure, within 0..1. The ends need not be at 0 and 1:
 * below the first point and above the last the curve stays flat (下限・上限).
 */
export function normalizeCurve(points: [number, number][]): [number, number][] {
  const sorted = points.map(([x, y]) => [clamp(x), clamp(y)] as [number, number]).sort((a, b) => a[0] - b[0]);
  // The ends apart, so that the curve still rises somewhere.
  if (sorted.length >= 2 && sorted[sorted.length - 1][0] - sorted[0][0] < 0.02) {
    sorted[0] = [0, sorted[0][1]];
    sorted[sorted.length - 1] = [1, sorted[sorted.length - 1][1]];
  }
  return sorted;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** The pressure a line gets from the pen's own reading. */
export function adjustPressure(curve: [number, number][], raw: number): number {
  return clamp(curveAt(curve, clamp(raw)));
}

/**
 * 筆圧検知レベルの調節 by drawing: from the pressures of a few ordinary
 * lines, a curve that gives the usual press the middle of the range and the
 * firm end of it full pressure (as CSP's adjustment does).
 */
export function fitPressureCurve(samples: readonly number[]): [number, number][] | null {
  const pressed = samples.filter((p) => p > 0.01).sort((a, b) => a - b);
  if (pressed.length < 20) return null;
  const at = (q: number) => pressed[Math.min(pressed.length - 1, Math.floor(q * pressed.length))];
  const usual = at(0.5);
  const firm = Math.max(at(0.95), usual + 0.05);
  if (firm >= 0.999) return normalizeCurve([[0, 0], [usual, 0.5], [1, 1]]);
  return normalizeCurve([[0, 0], [usual, 0.5], [firm, 1], [1, 1]]);
}

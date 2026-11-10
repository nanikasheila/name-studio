// 「大きめ」を勧める: once on this computer, when the screen or the pen says the
// usual sizes will be small for this person (the words 12 px and under, the
// targets under 24 px). The person decides; asked once, never again.

/** What was seen of this computer. */
export interface LargeOfferSeen {
  /** 大きめ is already on. */
  large: boolean;
  /** Offered before (taken or not). */
  offered: boolean;
  /** A pen touched the page (or the screen). */
  pen: boolean;
  /** The screen in CSS px and its device pixels per CSS px. */
  screenWidth: number;
  pixelRatio: number;
}

export type LargeOfferReason = "pen" | "dense";

/**
 * Why to offer 大きめ now, or null: a pen in hand (larger targets are easier to hit with
 * a pen tip), or a wide high-resolution screen shown at near 100 %, where the words
 * come out physically small (2560 device px or more across at under 1.5×).
 */
export function largeOfferReason(seen: LargeOfferSeen): LargeOfferReason | null {
  if (seen.large || seen.offered) return null;
  if (seen.pen) return "pen";
  if (seen.screenWidth * seen.pixelRatio >= 2560 && seen.pixelRatio < 1.5) return "dense";
  return null;
}

/** What the offer says. */
export function largeOfferText(reason: LargeOfferReason): string {
  return reason === "pen"
    ? "ペンでお使いですね。ボタンや入力欄を「大きめ」にすると、ペン先で押しやすくなります（設定 › 画面の見た目 でいつでも戻せます）"
    : "細かい画面なので、文字やボタンが小さく見えるかもしれません。「大きめ」にすると押しやすく読みやすくなります（設定 › 画面の見た目 でいつでも戻せます）";
}

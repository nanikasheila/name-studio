// セリフの改行: a long line of dialogue broken into short lines the way a
// letterer would, a few characters each, after punctuation or a particle,
// never starting a line with small kana or closing punctuation (禁則) and not
// inside a word written in katakana, kanji or Latin letters.

/** Characters a line must not start with. */
const NO_START = new Set([..."、。，．,.・：；:;！？!?‼⁉…‥ー〜～）)」』】〕］]｝}〉》ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ゛゜ゝゞヽヾ々"]);
/** Characters a line must not end with. */
const NO_END = new Set([..."（(「『【〔［[｛{〈《"]);
const PUNCTUATION = new Set([..."、。，．,.！？!?‼⁉…‥"]);
/** Particles and endings after which a line may break. */
const PARTICLES = new Set([..."はがをにでともへやかねよなのわぞぜさ"]);

type Script = "kanji" | "hiragana" | "katakana" | "latin" | "other";

function scriptOf(char: string): Script {
  if (/[一-鿿㐀-䶿々〆]/.test(char)) return "kanji";
  if (/[ぁ-ゟ]/.test(char)) return "hiragana";
  if (/[゠-ヿｦ-ﾟ]/.test(char)) return "katakana";
  if (/[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]/.test(char)) return "latin";
  return "other";
}

/** How good a break is between `before` and `after` (higher is better; very low is not allowed). */
function breakScore(before: string, after: string): number {
  if (NO_START.has(after) || NO_END.has(before)) return -100;
  if (PUNCTUATION.has(before)) return 6;
  const a = scriptOf(before);
  const b = scriptOf(after);
  // Inside a word.
  if (a === b && (a === "katakana" || a === "latin")) return -20;
  if (a === "kanji" && b === "kanji") return -6;
  if (a === "kanji" && b === "hiragana") return -4;
  if (a === "hiragana" && PARTICLES.has(before) && b !== "hiragana") return 4;
  if (a === "hiragana" && b !== "hiragana") return 2.5;
  if (a === "hiragana" && PARTICLES.has(before)) return 0.5;
  if (a === "hiragana" && b === "hiragana") return -3;
  return 0;
}

/**
 * Break `text` into lines of about `width` characters (each between a few
 * fewer and a few more). Text that already has line breaks is left as it is.
 */
export function wrapDialogue(text: string, width = 8): string {
  if (text.includes("\n")) return text;
  const chars = [...text];
  if (chars.length <= width + 1) return text;
  const lines: string[] = [];
  let start = 0;
  while (chars.length - start > width + 1) {
    const min = start + Math.max(2, width - 4);
    const max = Math.min(chars.length - 2, start + width + 3);
    let best = -1;
    let bestScore = -Infinity;
    for (let end = min; end <= max; end++) {
      // `end`: the first character of the next line.
      const score = breakScore(chars[end - 1], chars[end]) - 0.6 * Math.abs(end - start - width);
      if (score > bestScore) {
        bestScore = score;
        best = end;
      }
    }
    // A poor break with little left: the rest goes on one line, a little long.
    if (bestScore < 0 && chars.length - start <= width + 4) break;
    if (best < 0 || bestScore < -50) {
      // Nowhere good: past the closing punctuation after the target, or just at it.
      best = Math.min(chars.length, start + width);
      while (best < chars.length && NO_START.has(chars[best])) best++;
    }
    lines.push(chars.slice(start, best).join(""));
    start = best;
  }
  if (start < chars.length) lines.push(chars.slice(start).join(""));
  return lines.join("\n");
}

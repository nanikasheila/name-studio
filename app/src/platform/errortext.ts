// What went wrong, in words for the person at the screen. An error from the
// Rust side or the system arrives as its own text ("…(os error 32)", "missing
// field `pages` at line 1 column 2"): true, but it does not say what to do.
// `explain` gives a sentence that does, and keeps the original for the log
// and for whoever looks into it.

export interface Explained {
  /** What to show. */
  text: string;
  /** The error as it came, when `text` says something else (null: `text` is it). */
  detail: string | null;
}

/** What the system's error numbers mean here (Windows and the rest number them differently). */
const WINDOWS: Record<number, string> = {
  2: "ファイルが見つかりません。動かしたり、名前を変えたりしていないか確かめてください",
  3: "フォルダーが見つかりません。動かしたり、名前を変えたりしていないか確かめてください",
  5: "書き込めません。ほかのアプリ（CLIP STUDIO PAINT など）が開いているか、書き込めない場所です",
  19: "書き込みが禁止されている場所です",
  32: "ほかのアプリ（CLIP STUDIO PAINT など）がこのファイルを開いています。閉じてからもう一度試してください",
  33: "ほかのアプリがこのファイルを使っています。閉じてからもう一度試してください",
  39: "ディスクの空きが足りません",
  53: "ネットワークの場所が見つかりません",
  67: "ネットワークの場所が見つかりません",
  80: "同じ名前のファイルがもうあります",
  112: "ディスクの空きが足りません",
  123: "ファイル名に使えない文字が入っています",
  183: "同じ名前のファイルがもうあります",
  206: "ファイルの場所の名前が長すぎます。浅いフォルダーに置いてください",
  1224: "ほかのアプリがこのファイルを開いています。閉じてからもう一度試してください",
};
const UNIX: Record<number, string> = {
  2: "ファイルかフォルダーが見つかりません。動かしたり、名前を変えたりしていないか確かめてください",
  13: "書き込めない場所です（権限がありません）",
  17: "同じ名前のファイルがもうあります",
  26: "ほかのアプリがこのファイルを使っています",
  28: "ディスクの空きが足りません",
  30: "書き込みが禁止されている場所です",
  36: "ファイルの名前が長すぎます",
};

const NETWORK =
  /error sending request|dns error|failed to lookup|connection (refused|reset|closed)|timed out|network|Failed to fetch|Load failed/i;

/** The text an error carries (an `Error`'s message without its name; anything else as text). */
export function rawText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

/** Whether a text is written for people here (it has kana or kanji). */
function japanese(text: string): boolean {
  return /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
}

/**
 * `error` in words that say what to do. `windows`: which system's error
 * numbers to read (this computer's, unless told).
 */
export function explain(error: unknown, windows = onWindows()): Explained {
  const raw = rawText(error).trim();
  const code = /\(os error (\d+)\)/.exec(raw);
  const known = code ? (windows ? WINDOWS : UNIX)[Number(code[1])] : undefined;
  if (known) return { text: known, detail: raw };
  if (NETWORK.test(raw) && !japanese(raw))
    return { text: "ネットワークにつながりませんでした。つながっているか確かめて、もう一度試してください", detail: raw };
  // Written here, for people: it is the explanation.
  if (japanese(raw)) return { text: raw, detail: null };
  if (!raw) return { text: "理由は分かりません", detail: null };
  return { text: "思わぬエラーが起きました", detail: raw };
}

/**
 * "<what>: <why>" for a message that stays on screen (a dialog's own line):
 * `what` is what did not work ("保存できませんでした"). The error as it came
 * follows in brackets when the words are not it, as there is nowhere else to
 * look it up from there.
 */
export function failureText(what: string, error: unknown, windows = onWindows()): string {
  const { text, detail } = explain(error, windows);
  return detail ? `${what}: ${text}（${detail}）` : `${what}: ${text}`;
}

function onWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

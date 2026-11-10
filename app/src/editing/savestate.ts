// Where the open name's changes are kept, in a few words for the bar at the
// top: in its file, only in the copy autosave keeps for recovery, or not yet
// anywhere; and what went wrong, until a save puts it right.

/** What the save state is worked out from. */
export interface SaveFacts {
  /** The name has a file. */
  hasPath: boolean;
  /** Changes not in the file. */
  dirty: boolean;
  /** A save or autosave is being written. */
  writing: boolean;
  /** When the file was last written (ms), this session. */
  savedAt: number | null;
  /** When autosave last kept a copy for recovery only (ms), since the file was written. */
  copyAt: number | null;
  /** Why the last save or autosave failed; cleared by the next one that works. */
  failed: string | null;
  /** The series file has not caught up with the name's last save. */
  seriesBehind: boolean;
}

export interface SaveState {
  text: string;
  tone: "saved" | "pending" | "warning" | "error";
  /** The longer explanation (a tooltip). */
  detail: string;
}

/** The save state shown, `time` writing a time of day. */
export function saveState(facts: SaveFacts, time: (ms: number) => string): SaveState {
  const series = facts.seriesBehind ? "・シリーズ未反映" : "";
  const seriesDetail = facts.seriesBehind ? "\nシリーズのファイルにはまだ反映できていません（次の保存でもう一度試します）。" : "";
  if (facts.failed) return { text: `保存できませんでした${series}`, tone: "error", detail: `${facts.failed}\n保存（Ctrl+S）でもう一度試せます。${seriesDetail}` };
  if (facts.writing) return { text: "保存中…", tone: "pending", detail: "ファイルに書いています。" };
  if (!facts.hasPath) {
    if (facts.copyAt !== null)
      return { text: "控えだけに保存", tone: "warning", detail: `保存先がまだありません。${time(facts.copyAt)} の変更までは復旧用の控えに残っています。保存（Ctrl+S）で保存先を決めます。` };
    return { text: "未保存", tone: "warning", detail: "保存先がまだありません。保存（Ctrl+S）で保存先を決めます。" };
  }
  if (facts.dirty) {
    if (facts.copyAt !== null)
      return { text: `控えに保存 ${time(facts.copyAt)}${series}`, tone: "warning", detail: `ファイルにはまだ書いていません。${time(facts.copyAt)} の変更までは復旧用の控えに残っています。${seriesDetail}` };
    return { text: `未保存の変更あり${series}`, tone: "pending", detail: `ファイルにはまだ書いていない変更があります。${seriesDetail}` };
  }
  const when = facts.savedAt !== null ? ` ${time(facts.savedAt)}` : "";
  return { text: `保存済み${when}${series}`, tone: facts.seriesBehind ? "warning" : "saved", detail: `変更はすべてファイルに保存されています。${seriesDetail}` };
}

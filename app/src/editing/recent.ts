// The names opened last, for the start screen: newest first, one entry per
// file, a few at most. Plain values only; prefs.ts keeps them on this computer.

export interface RecentName {
  path: string;
  title: string;
  pages: number;
  /** When it was last opened or saved (ms since 1970). */
  timeMs: number;
}

/** How many names the start screen lists. */
export const RECENT_NAMES = 12;

/** A path as compared: Windows paths ignore case and either slash. */
function samePath(a: string, b: string): boolean {
  const plain = (path: string) => path.replace(/\\/g, "/").toLowerCase();
  return plain(a) === plain(b);
}

/** The list with `entry` first (an older entry for the same file goes). */
export function remembered(list: readonly RecentName[], entry: RecentName, max = RECENT_NAMES): RecentName[] {
  return [entry, ...list.filter((name) => !samePath(name.path, entry.path))].slice(0, max);
}

/** The list without the file at `path`. */
export function forgotten(list: readonly RecentName[], path: string): RecentName[] {
  return list.filter((name) => !samePath(name.path, path));
}

/** The entries of a kept value that can be read (anything else is left out). */
export function recentFrom(value: unknown): RecentName[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is RecentName =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.path === "string" &&
        entry.path !== "" &&
        typeof entry.title === "string" &&
        Number.isFinite(entry.pages) &&
        Number.isFinite(entry.timeMs),
    )
    .map(({ path, title, pages, timeMs }) => ({ path, title, pages, timeMs }))
    .slice(0, RECENT_NAMES);
}

/** The file's name and the folder it is in, to show apart. */
export function splitPath(path: string): { name: string; folder: string } {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at < 0 ? { name: path, folder: "" } : { name: path.slice(at + 1), folder: path.slice(0, at) };
}

/** When, as the start screen says it: 「今日 14:05」「昨日 9:30」「10月3日」「2025年12月1日」. */
export function whenLabel(timeMs: number, now = Date.now()): string {
  const date = new Date(timeMs);
  const today = new Date(now);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(today) - dayStart(date)) / 86_400_000);
  const clock = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (days === 0) return `今日 ${clock}`;
  if (days === 1) return `昨日 ${clock}`;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === today.getFullYear() ? day : `${date.getFullYear()}年${day}`;
}

// シリーズ: several names (話) of one work that share their characters,
// brushes, fonts, look and CSP page settings. The series file (.nameseries)
// holds what is shared and the list of its names; each name keeps a copy of
// the shared parts too, so that it still opens on its own (and the series is
// mended from it when the series file is gone).
import type { Character, Project, Series, SeriesEpisode, SeriesShared } from "./model";

export const SERIES_EXTENSION = "nameseries";
export const SERIES_VERSION = 1;

/** What the name shares with its series, as the series keeps it. */
export function sharedOf(project: Project): SeriesShared {
  const copy = <T>(value: T): T => structuredClone(value);
  const shared: SeriesShared = { characters: copy(project.characters), brushes: copy(project.brushes) };
  if (project.fonts) shared.fonts = copy(project.fonts);
  if (project.style) shared.style = copy(project.style);
  if (project.cspPage) shared.cspPage = copy(project.cspPage);
  if (project.lineShapes) shared.lineShapes = copy(project.lineShapes);
  if (project.gutters) shared.gutters = copy(project.gutters);
  if (project.roughLayers?.length) shared.roughLayers = copy(project.roughLayers);
  return shared;
}

/** Characters the name's lines speak with. */
function speakers(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const page of project.pages) for (const line of page.lines) if (line.speaker) ids.add(line.speaker);
  return ids;
}

/**
 * The series' shared parts into the name: the series wins, but characters,
 * brushes and rough layers the name still uses and the series lacks stay
 * (they go into the series with the next save).
 */
export function applyShared(project: Project, shared: SeriesShared): void {
  const copy = <T>(value: T): T => structuredClone(value);
  const keep = <T extends { id: string }>(theirs: T[], ours: T[], used: (item: T) => boolean): T[] => {
    const ids = new Set(theirs.map((item) => item.id));
    return [...copy(theirs), ...ours.filter((item) => !ids.has(item.id) && used(item))];
  };
  const spoken = speakers(project);
  project.characters = keep<Character>(shared.characters ?? [], project.characters, (character) => spoken.has(character.id));
  const brushes = new Set(project.pages.flatMap((page) => page.strokes.map((stroke) => stroke.brush).filter((id): id is string => !!id)));
  project.brushes = keep(shared.brushes ?? [], project.brushes, (brush) => brushes.has(brush.id));
  const set = <K extends "fonts" | "style" | "cspPage" | "lineShapes" | "gutters">(key: K) => {
    if (shared[key] !== undefined) project[key] = copy(shared[key]) as Project[K];
    else delete project[key];
  };
  set("fonts");
  set("style");
  set("cspPage");
  set("lineShapes");
  set("gutters");
  const layers = new Set(project.pages.flatMap((page) => page.strokes.map((stroke) => stroke.layer).filter((id): id is string => !!id)));
  const roughs = keep(shared.roughLayers ?? [], project.roughLayers ?? [], (layer) => layers.has(layer.id));
  if (roughs.length) project.roughLayers = roughs;
  else delete project.roughLayers;
}

/** A new series made from a name (its shared parts and the name as its first 話). */
export function newSeries(project: Project, title: string, episodePath: string): Series {
  return {
    formatVersion: SERIES_VERSION,
    title: title.trim() || project.title,
    author: project.author,
    episodes: [episodeOf(project, episodePath)],
    shared: sharedOf(project),
  };
}

export function episodeOf(project: Project, path: string): SeriesEpisode {
  const episode: SeriesEpisode = { path, title: project.title, pages: project.pages.length };
  if (project.storyIndex !== undefined) episode.storyIndex = project.storyIndex;
  return episode;
}

/**
 * The series after the name was saved: what it shares now, and the name in
 * the list (in story order; names without a number keep their place after).
 */
export function withEpisode(series: Series, project: Project, path: string): Series {
  const next = structuredClone(series);
  next.shared = sharedOf(project);
  if (project.author) next.author = project.author;
  const episode = episodeOf(project, path);
  const at = next.episodes.findIndex((one) => samePath(one.path, path));
  if (at >= 0) next.episodes[at] = episode;
  else next.episodes.push(episode);
  next.episodes = next.episodes
    .map((one, index) => ({ one, index }))
    .sort((a, b) => (a.one.storyIndex ?? Infinity) - (b.one.storyIndex ?? Infinity) || a.index - b.index)
    .map(({ one }) => one);
  return next;
}

export function withoutEpisode(series: Series, path: string): Series {
  return { ...series, episodes: series.episodes.filter((one) => !samePath(one.path, path)) };
}

/** The story number a new 話 gets: one after the last. */
export function nextStoryIndex(series: Series): number {
  return Math.max(0, ...series.episodes.map((one) => one.storyIndex ?? 0)) + 1;
}

// --- paths (Windows or POSIX; stored with "/") -------------------------------------------

function parts(path: string): string[] {
  return path.split(/[\\/]+/).filter((part, index) => part !== "" || index === 0);
}

/** Windows paths compare without case. */
function samePart(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  return x.length === y.length && x.every((part, i) => samePart(part, y[i]));
}

/** The folder a file is in (with the separator the path uses). */
export function folderOf(path: string): string {
  const all = parts(path);
  return all.slice(0, -1).join(path.includes("\\") ? "\\" : "/");
}

/** `to` from the folder `from` ("../x/y"); null when they share no root (another drive). */
export function relativePath(from: string, to: string): string | null {
  const [base, target] = [parts(from), parts(to)];
  if (!base.length || !target.length || !samePart(base[0], target[0])) return null;
  let same = 0;
  while (same < base.length && same < target.length - 1 && samePart(base[same], target[same])) same++;
  return [...Array(base.length - same).fill(".."), ...target.slice(same)].join("/");
}

/** A path stored from the folder `from`, as a full path (with the separator `from` uses). */
export function resolvePath(from: string, relative: string): string {
  const separator = from.includes("\\") ? "\\" : "/";
  const out = parts(from);
  for (const part of relative.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join(separator);
}

/** When a name joins a series: what it shares then (nothing of the name's own characters or brushes is lost). */
export function joinedShared(project: Project, shared: SeriesShared): SeriesShared {
  const add = <T extends { id: string }>(theirs: T[], ours: T[]): T[] => {
    const ids = new Set(theirs.map((item) => item.id));
    return [...theirs, ...ours.filter((item) => !ids.has(item.id))];
  };
  return { ...shared, characters: add(shared.characters ?? [], project.characters), brushes: add(shared.brushes ?? [], project.brushes) };
}

/** What the series' shared settings say about it, in a line. */
export function sharedSummary(shared: SeriesShared): string {
  const parts = [`人物 ${shared.characters?.length ?? 0}`];
  if (shared.brushes?.length) parts.push(`ブラシ ${shared.brushes.length}`);
  if (shared.fonts) parts.push("フォント");
  if (shared.style || shared.lineShapes || shared.gutters) parts.push("作品の既定");
  if (shared.cspPage) parts.push("CSP のページ設定");
  if (shared.roughLayers?.length) parts.push(`ラフ線のレイヤー ${shared.roughLayers.length}`);
  return parts.join("・");
}

/** The file name without its folder and extension. */
export function stemOf(path: string): string {
  return (parts(path).pop() ?? "").replace(/\.[^.]*$/, "");
}

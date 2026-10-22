// Story structure derived from the name data for the overview views:
// scenes over pages, per-page amounts, emotion curves and story time.
import { pageIndex, textAmount, type Project, type Scene } from "./project";

export interface SceneSpan {
  scene: Scene;
  /** 0-based page indexes, inclusive. */
  first: number;
  last: number;
}

/** Scenes with their page ranges, in page order; scenes pointing at missing pages are left out. */
export function sceneSpans(project: Project): SceneSpan[] {
  return project.scenes
    .map((scene) => ({ scene, first: pageIndex(project, scene.firstPage), last: pageIndex(project, scene.lastPage) }))
    .filter((span) => span.first >= 0 && span.last >= span.first)
    .sort((a, b) => a.first - b.first || a.last - b.last);
}

export interface PageStats {
  index: number;
  panels: number;
  lines: number;
  characters: number;
  memo: string;
}

export function pageStats(project: Project): PageStats[] {
  return project.pages.map((page, index) => ({
    index,
    panels: page.panels.length,
    lines: page.lines.length,
    characters: textAmount(page),
    memo: page.memo,
  }));
}

/** Pages no scene covers, as 0-based inclusive runs. */
export function uncoveredRuns(project: Project): [number, number][] {
  const covered = new Array(project.pages.length).fill(false);
  for (const span of sceneSpans(project)) for (let i = span.first; i <= span.last; i++) covered[i] = true;
  const runs: [number, number][] = [];
  covered.forEach((isCovered, index) => {
    if (isCovered) return;
    const last = runs[runs.length - 1];
    if (last && last[1] === index - 1) last[1] = index;
    else runs.push([index, index]);
  });
  return runs;
}

export interface EmotionSample {
  index: number;
  value: number;
  note: string;
}

/** One character's emotion values in page order. */
export function emotionSeries(project: Project, characterId: string): EmotionSample[] {
  return project.emotions
    .filter((point) => point.character === characterId)
    .map((point) => ({ index: pageIndex(project, point.page), value: point.value, note: point.note }))
    .filter((sample) => sample.index >= 0)
    .sort((a, b) => a.index - b.index);
}

export interface TimelineRow extends SceneSpan {
  /** Position in story time, 0 = earliest. */
  storyRank: number;
  /** Told after a scene that happens later in the story (回想 and the like). */
  flashback: boolean;
}

/**
 * Scenes ranked by when they happen in the story. Scenes without a story
 * order keep their page position, so a name without any story order shows a
 * straight line.
 */
export function timeline(project: Project): TimelineRow[] {
  const spans = sceneSpans(project);
  const key = (span: SceneSpan, position: number) => span.scene.storyOrder ?? position;
  const ranked = spans
    .map((span, position) => ({ span, key: key(span, position), position }))
    .sort((a, b) => a.key - b.key || a.position - b.position);
  const rank = new Map(ranked.map((entry, index) => [entry.span, index]));
  let latest = -Infinity;
  return spans.map((span, position) => {
    const storyKey = key(span, position);
    const flashback = storyKey < latest;
    latest = Math.max(latest, storyKey);
    return { ...span, storyRank: rank.get(span)!, flashback };
  });
}

// Story structure derived from the name data for the overview views:
// scenes over pages, per-page amounts, emotion curves and story time.
import { pageIndex, STRUCTURES, textAmount, type Project, type Scene } from "./project";

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

// --- 構成補助 (R15) ------------------------------------------------------------------

/** A part of the story shape over the pages (0-based, inclusive). */
export interface PlanPart {
  name: string;
  first: number;
  last: number;
}

/** Where the parts of the chosen story shape fall over `pages` pages. */
export function planParts(project: Project, pages = project.plan?.targetPages ?? project.pages.length): PlanPart[] {
  const structure = project.plan?.structure ? STRUCTURES[project.plan.structure] : undefined;
  if (!structure || pages < structure.parts.length) return [];
  const parts: PlanPart[] = [];
  let done = 0;
  let share = 0;
  for (const part of structure.parts) {
    share += part.share;
    const end = Math.max(done + 1, Math.round(pages * share));
    parts.push({ name: part.name, first: done, last: Math.min(end, pages) - 1 });
    done = end;
  }
  return parts;
}

export interface Advice {
  level: "info" | "warn";
  text: string;
  /** The page (0-based) it is about, to open. */
  page?: number;
}

/** Characters on a page past which it reads heavy, and panels past which it gets crowded. */
export const HEAVY_TEXT = 180;
export const MANY_PANELS = 8;

/** 構成補助: how the page split compares with the aim, and pages worth a look. */
export function planAdvice(project: Project): Advice[] {
  const advice: Advice[] = [];
  const count = project.pages.length;
  const target = project.plan?.targetPages;
  if (target) {
    const diff = count - target;
    advice.push(
      diff === 0
        ? { level: "info", text: `目標の ${target} ページちょうどです` }
        : { level: "warn", text: `目標の ${target} ページより ${Math.abs(diff)} ページ${diff > 0 ? "多い" : "少ない"}です` },
    );
  }
  const spans = sceneSpans(project);
  const parts = planParts(project, count);
  for (const part of parts) {
    // Scenes whose middle falls in this part.
    const inside = spans.filter((span) => {
      const middle = (span.first + span.last) / 2;
      return middle >= part.first && middle <= part.last + 0.5;
    });
    const names = inside.map((span) => span.scene.title).join("・");
    advice.push({
      level: "info",
      text: `${part.name}: ${part.first + 1}〜${part.last + 1} ページ（${part.last - part.first + 1} ページ）${names ? ` … ${names}` : spans.length ? " … ここに当たるシーンがありません" : ""}`,
    });
  }
  for (const span of spans) {
    const share = (span.last - span.first + 1) / Math.max(count, 1);
    if (spans.length > 1 && share > 0.4) {
      advice.push({ level: "warn", text: `シーン「${span.scene.title}」が全体の ${Math.round(share * 100)}% あります`, page: span.first });
    }
  }
  project.pages.forEach((page, index) => {
    const text = textAmount(page);
    if (text > HEAVY_TEXT) advice.push({ level: "warn", text: `${index + 1} ページ: 字が多め（${text} 字）`, page: index });
    if (page.panels.length > MANY_PANELS) advice.push({ level: "warn", text: `${index + 1} ページ: コマが多め（${page.panels.length} コマ）`, page: index });
  });
  const empty = project.pages.map((page, index) => (page.panels.length + page.lines.length + page.strokes.length ? -1 : index)).filter((i) => i >= 0);
  if (empty.length && empty.length < count) {
    advice.push({ level: "info", text: `まだ何もないページ: ${runs(empty).map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}〜${b + 1}`)).join("、")}` });
  }
  return advice;
}

function runs(indexes: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const index of indexes) {
    const last = out[out.length - 1];
    if (last && last[1] === index - 1) last[1] = index;
    else out.push([index, index]);
  }
  return out;
}

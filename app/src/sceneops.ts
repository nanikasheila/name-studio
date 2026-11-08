// シーンの管理 (物語の帯): a scene split at a page, joined with the one next
// to it, copied with its pages, moved past the scene next to it — the same
// set of changes the page list gives pages.
import { addScene } from "./cast";
import type { Page, Project, Scene } from "./model";
import { duplicatePages } from "./pageops";
import { pageIndex } from "./project";
import { moveScene } from "./reorder";
import { sceneSpans, type SceneSpan } from "./story";

function spanOf(project: Project, sceneId: string): SceneSpan | undefined {
  return sceneSpans(project).find((span) => span.scene.id === sceneId);
}

/** The scenes just before and after a scene (in page order). */
export function sceneNeighbours(project: Project, sceneId: string): { before?: SceneSpan; after?: SceneSpan } {
  const spans = sceneSpans(project);
  const at = spans.findIndex((span) => span.scene.id === sceneId);
  if (at < 0) return {};
  return { before: spans[at - 1], after: spans[at + 1] };
}

/**
 * ここで分ける: the scene ends before page `index` (0-based), and a new scene
 * (its name with "（続き）") takes the pages from there. Null when `index`
 * is not inside the scene past its first page.
 */
export function splitScene(project: Project, sceneId: string, index: number): Scene | null {
  const span = spanOf(project, sceneId);
  if (!span || index <= span.first || index > span.last) return null;
  const { scene } = span;
  const rest = addScene(project, project.pages[index].id, scene.lastPage, `${scene.title}（続き）`);
  if (scene.storyTime) rest.storyTime = scene.storyTime;
  scene.lastPage = project.pages[index - 1].id;
  return rest;
}

/**
 * つなぐ: the scene and the one after it (`next` true) or before it become one,
 * over both their pages and the pages between; the summaries are kept one
 * after the other. Returns the scene that stays.
 */
export function joinScene(project: Project, sceneId: string, next: boolean): Scene | null {
  const { before, after } = sceneNeighbours(project, sceneId);
  const self = spanOf(project, sceneId);
  const other = next ? after : before;
  if (!self || !other) return null;
  const [first, second] = next ? [self, other] : [other, self];
  const kept = first.scene;
  kept.lastPage = second.scene.lastPage;
  kept.summary = [kept.summary.trim(), second.scene.summary.trim()].filter(Boolean).join("\n");
  project.scenes = project.scenes.filter((s) => s !== second.scene);
  return kept;
}

/** A copy of the scene's pages right behind it, with a scene of its own over them ("…のコピー"). */
export function duplicateScene(project: Project, sceneId: string): { scene: Scene; pages: Page[] } | null {
  const span = spanOf(project, sceneId);
  if (!span) return null;
  const indexes = Array.from({ length: span.last - span.first + 1 }, (_, i) => span.first + i);
  const last = span.scene.lastPage;
  const pages = duplicatePages(project, indexes);
  if (!pages.length) return null;
  // The copies are not part of the scene they were copied from.
  for (const scene of project.scenes) if (scene.lastPage === pages[pages.length - 1].id) scene.lastPage = last;
  const scene = addScene(project, pages[0].id, pages[pages.length - 1].id, `${span.scene.title}のコピー`);
  scene.summary = span.scene.summary;
  if (span.scene.storyTime) scene.storyTime = span.scene.storyTime;
  return { scene, pages };
}

/** Where the scene's pages go to pass the scene next to it (or to the front or the end). */
export function sceneTarget(project: Project, sceneId: string, to: -1 | 1 | "first" | "last"): number | null {
  const self = spanOf(project, sceneId);
  if (!self) return null;
  if (to === "first") return self.first === 0 ? null : 0;
  if (to === "last") return self.last === project.pages.length - 1 ? null : project.pages.length;
  const { before, after } = sceneNeighbours(project, sceneId);
  if (to < 0) return self.first === 0 ? null : before ? before.first : 0;
  return self.last === project.pages.length - 1 ? null : after ? after.last + 1 : project.pages.length;
}

/** Move the scene's pages one scene earlier or later (or to the front or the end). */
export function moveSceneTo(project: Project, sceneId: string, to: -1 | 1 | "first" | "last"): boolean {
  const target = sceneTarget(project, sceneId, to);
  return target !== null && moveScene(project, sceneId, target);
}

/** The ids of the scene's pages. */
export function scenePageIds(project: Project, sceneId: string): string[] {
  const span = spanOf(project, sceneId);
  return span ? project.pages.slice(span.first, span.last + 1).map((page) => page.id) : [];
}

/** Whether page `index` lies inside the scene past its first page (so the scene can be split there). */
export function canSplitAt(project: Project, sceneId: string, index: number): boolean {
  const span = spanOf(project, sceneId);
  return !!span && index > span.first && index <= span.last && pageIndex(project, project.pages[index]?.id ?? "") === index;
}

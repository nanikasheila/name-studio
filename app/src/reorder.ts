// 入れ替え（R14）: moving pages, a scene's pages, as blocks that keep spreads together.

import type { Project } from "./model";
import { pageIndex } from "./project";
import { wantsSpread } from "./panels";
import { sortScenes } from "./cast";

/** The pages that move with page `index`: it and its 見開き partner, as first and last index. */
export function pageBlock(project: Project, index: number): [number, number] {
  let [first, last] = [index, index];
  if (wantsSpread(project, index)) last = index + 1;
  else if (index > 0 && wantsSpread(project, index - 1)) first = index - 1;
  return [first, last];
}

/**
 * Move pages `first`..`last` (inclusive) to before page `target` (an index
 * from before the move; `pages.length` is the end). A target between the two
 * pages of a 見開き moves to before the pair. Scenes keep the pages that stay;
 * moved pages join the scene they land in, unless their whole scene moved
 * with them. Returns whether anything moved.
 */
export function movePagesTo(project: Project, first: number, last: number, target: number): boolean {
  const pages = project.pages;
  if (first < 0 || last >= pages.length || first > last) return false;
  if (target > 0 && target < pages.length && wantsSpread(project, target - 1)) target--;
  if (target >= first && target <= last + 1) return false;
  const moved = new Set(pages.slice(first, last + 1).map((page) => page.id));
  const staying = new Map(
    project.scenes.map((scene) => {
      const [a, b] = [pageIndex(project, scene.firstPage), pageIndex(project, scene.lastPage)];
      return [scene, pages.slice(a, b + 1).filter((page) => !moved.has(page.id)).map((page) => page.id)];
    }),
  );
  const block = pages.splice(first, last - first + 1);
  pages.splice(target > last ? target - block.length : target, 0, ...block);
  for (const scene of project.scenes) {
    const members = staying.get(scene) ?? [];
    // A scene moved whole keeps its ends; others keep the pages that stayed.
    if (!members.length) continue;
    const at = members.map((id) => pageIndex(project, id));
    scene.firstPage = members[at.indexOf(Math.min(...at))];
    scene.lastPage = members[at.indexOf(Math.max(...at))];
  }
  sortScenes(project);
  return true;
}

/**
 * Move page `index` with its 見開き partner one place earlier (-1) or later
 * (1), past the whole 見開き next to it: the same blocks as dragging in the
 * list or the strip. Returns whether anything moved.
 */
export function moveBlock(project: Project, index: number, step: -1 | 1): boolean {
  const [first, last] = pageBlock(project, index);
  if (step < 0) return first > 0 && movePagesTo(project, first, last, pageBlock(project, first - 1)[0]);
  return last < project.pages.length - 1 && movePagesTo(project, first, last, pageBlock(project, last + 1)[1] + 1);
}

/** Move a scene's pages (with any 見開き partners at its ends) to before page `target`. */
export function moveScene(project: Project, sceneId: string, target: number): boolean {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) return false;
  const first = pageBlock(project, pageIndex(project, scene.firstPage))[0];
  const last = pageBlock(project, pageIndex(project, scene.lastPage))[1];
  if (first < 0 || last < first) return false;
  return movePagesTo(project, first, last, target);
}

// The cast and the story: characters, scenes and the characters' emotions.

import type { Character, Project, Scene } from "./model";
import { newId, pageIndex } from "./project";

/** Categorical colours in a fixed order, checked for colour-blind separation. */
export const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];

export function addCharacter(project: Project, name: string): Character {
  const character: Character = {
    id: newId(project, "character"),
    name,
    // Past eight the colours repeat; the name tells them apart.
    color: PALETTE[project.characters.length % PALETTE.length],
  };
  project.characters.push(character);
  return character;
}

export function removeCharacter(project: Project, characterId: string): void {
  project.characters = project.characters.filter((character) => character.id !== characterId);
  project.emotions = project.emotions.filter((point) => point.character !== characterId);
  for (const page of project.pages) {
    for (const line of page.lines) if (line.speaker === characterId) delete line.speaker;
  }
}

/** Set (or with `null`, clear) how a character feels at a page. */
export function setEmotion(project: Project, characterId: string, pageId: string, value: number | null, note?: string): void {
  const existing = project.emotions.find((point) => point.character === characterId && point.page === pageId);
  if (value === null) {
    project.emotions = project.emotions.filter((point) => point !== existing);
    return;
  }
  const clamped = Math.max(-1, Math.min(1, value));
  if (existing) {
    existing.value = clamped;
    if (note !== undefined) existing.note = note;
  } else {
    project.emotions.push({ character: characterId, page: pageId, value: clamped, note: note ?? "" });
  }
}

export function addScene(project: Project, firstPage: string, lastPage: string, title: string): Scene {
  const scene: Scene = { id: newId(project, "scene"), title, summary: "", firstPage, lastPage };
  project.scenes.push(scene);
  sortScenes(project);
  return scene;
}

/**
 * A scene over pages `first`..`last` (0-based) that takes the place of the
 * scenes it overlaps; a scene it replaces over the very same pages hands on
 * its summary when the new one has none. Returns the scene and how many it replaced.
 */
export function putScene(project: Project, first: number, last: number, title: string, summary = ""): { scene: Scene; replaced: number } {
  let kept = "";
  let replaced = 0;
  project.scenes = project.scenes.filter((s) => {
    const [a, b] = [pageIndex(project, s.firstPage), pageIndex(project, s.lastPage)];
    if (b < first || a > last) return true;
    if (a === first && b === last) kept = s.summary;
    // The very same scene taken in again is not counted as replaced.
    if (!(a === first && b === last && s.title === title)) replaced++;
    return false;
  });
  const scene = addScene(project, project.pages[first].id, project.pages[last].id, title);
  scene.summary = summary || kept;
  return { scene, replaced };
}

export function sortScenes(project: Project): void {
  project.scenes.sort((a, b) => pageIndex(project, a.firstPage) - pageIndex(project, b.firstPage));
}

/** The scene a page belongs to (the first one that covers it). */
export function sceneOf(project: Project, pageId: string): Scene | undefined {
  const index = pageIndex(project, pageId);
  return project.scenes.find(
    (scene) => pageIndex(project, scene.firstPage) <= index && index <= pageIndex(project, scene.lastPage),
  );
}

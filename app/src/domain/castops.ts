// 人物の管理: characters put in, copied, moved, merged into one and copied to
// another name, as the page list does for pages. Removing one is cast.ts.
import { PALETTE, removeCharacter } from "./cast";
import { freeName, type MoveTo, moveIds } from "./listorder";
import type { Character, Project } from "../model/model";
import { newId } from "./project";
import { setLineSpeaker } from "./linelook";

/** Characters copied (kept while the app runs, so they can go into another name). */
export interface CharacterClip {
  characters: Character[];
}

/** A colour no character uses yet, else the next in turn. */
function freeColor(project: Project): string {
  const used = new Set(project.characters.map((c) => c.color));
  return PALETTE.find((color) => !used.has(color)) ?? PALETTE[project.characters.length % PALETTE.length];
}

/** A new character at `index` (0: the front; past the end: the end). */
export function insertCharacter(project: Project, index: number, name?: string): Character {
  const character: Character = {
    id: newId(project, "character"),
    name: freeName(
      name ?? `人物${project.characters.length + 1}`,
      project.characters.map((c) => c.name),
    ),
    color: freeColor(project),
  };
  project.characters.splice(Math.max(0, Math.min(index, project.characters.length)), 0, character);
  return character;
}

/** A copy of each character (name, colour, 口調) behind the last of them; their lines stay with the first. */
export function duplicateCharacters(project: Project, ids: readonly string[]): Character[] {
  const picked = project.characters.filter((c) => ids.includes(c.id));
  if (!picked.length) return [];
  const last = Math.max(...picked.map((c) => project.characters.indexOf(c)));
  const copies = picked.map((c) => {
    const copy = structuredClone(c);
    copy.id = newId(project, "character");
    copy.name = freeName(
      `${c.name}のコピー`,
      project.characters.map((one) => one.name),
    );
    return copy;
  });
  project.characters.splice(last + 1, 0, ...copies);
  return copies;
}

export function removeCharacters(project: Project, ids: readonly string[]): number {
  let count = 0;
  for (const id of ids) {
    if (!project.characters.some((c) => c.id === id)) continue;
    removeCharacter(project, id);
    count++;
  }
  return count;
}

/** How many lines each of `ids` speaks. */
export function linesOf(project: Project, ids: readonly string[]): number {
  return project.pages.reduce((sum, page) => sum + page.lines.filter((line) => line.speaker && ids.includes(line.speaker)).length, 0);
}

export function moveCharacters(project: Project, ids: readonly string[], to: MoveTo): boolean {
  const next = moveIds(project.characters, (c) => c.id, ids, to);
  if (next) project.characters = next;
  return !!next;
}

/**
 * 1 人にまとめる: the characters `ids` become `into` — their lines are its
 * lines, their feelings its feelings where it has none on that page, their
 * 口調 its own when it has none — and they go. Returns how many lines moved.
 */
export function mergeCharacters(project: Project, into: string, ids: readonly string[]): number {
  const target = project.characters.find((c) => c.id === into);
  const others = ids.filter((id) => id !== into && project.characters.some((c) => c.id === id));
  if (!target || !others.length) return 0;
  let moved = 0;
  for (const page of project.pages) {
    for (const line of page.lines) {
      if (line.speaker && others.includes(line.speaker)) {
        setLineSpeaker(project, line, into);
        moved++;
      }
    }
  }
  const felt = new Set(project.emotions.filter((p) => p.character === into).map((p) => p.page));
  for (const point of project.emotions) {
    if (!others.includes(point.character) || felt.has(point.page)) continue;
    point.character = into;
    felt.add(point.page);
  }
  if (!target.tone) {
    const tones = others.map((id) => project.characters.find((c) => c.id === id)?.tone).filter(Boolean);
    if (tones.length) target.tone = tones.join("\n");
  }
  for (const id of others) removeCharacter(project, id);
  return moved;
}

export function clipCharacters(project: Project, ids: readonly string[]): CharacterClip {
  return { characters: project.characters.filter((c) => ids.includes(c.id)).map((c) => structuredClone(c)) };
}

/**
 * The copied characters at `index`, with ids of this name; one whose name
 * this name already has is not added again (it is the same person — Ctrl+D
 * makes a second one).
 */
export function pasteCharacters(project: Project, clip: CharacterClip, index: number): { added: Character[]; skipped: number } {
  const names = new Set(project.characters.map((c) => c.name));
  const added: Character[] = [];
  for (const character of clip.characters) {
    if (names.has(character.name)) continue;
    names.add(character.name);
    added.push({ ...structuredClone(character), id: newId(project, "character") });
  }
  project.characters.splice(Math.max(0, Math.min(index, project.characters.length)), 0, ...added);
  return { added, skipped: clip.characters.length - added.length };
}

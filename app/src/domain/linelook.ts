// セリフ種類 × キャラのフキダシ設定: how a line looks is layered —
// 作品の既定 (by kind) → its セリフ種類 → its speaker's フキダシ設定 → the line's own.
//
// The layers are written into the line itself (its shape, font, size, 白抜き and
// 白縁), so drawing and exports read only the line. When a layer changes (the line
// gets another type or speaker, or a type's or character's look is changed), the
// fields still as the layers gave them follow; a field set on the line by hand stays.

import { fitLine } from "./dialogue";
import { newId } from "./project";
import { defaultFontPt } from "./style";
import type { BalloonShape, Character, Line, LineKind, LineLook, LineType, Project } from "../model/model";

/** The built-in kinds whose lines look the same whoever says them (a type says so itself with `ownLook`). */
export const OWN_LOOK_KINDS: readonly LineKind[] = ["narration", "sfx", "aside"];

/** The look a line gets from the layers under its own settings, every field filled. */
export interface UsualLook {
  shape: BalloonShape;
  /** None: the font for its kind (用途ごとのフォント). */
  font?: string;
  fontSizePt: number;
  inverted: boolean;
  edge: boolean;
}

type LookKey = keyof UsualLook;
const LOOK_KEYS: LookKey[] = ["shape", "font", "fontSizePt", "inverted", "edge"];

export function lineTypeOf(project: Project, line: Pick<Line, "type">): LineType | undefined {
  return line.type ? project.lineTypes?.find((type) => type.id === line.type) : undefined;
}

/** Whether the speaker's フキダシ設定 is used for this line. */
export function followsSpeaker(project: Project, line: Pick<Line, "type" | "kind">): boolean {
  const type = lineTypeOf(project, line);
  return type ? !type.ownLook : !OWN_LOOK_KINDS.includes(line.kind);
}

function speakerOf(project: Project, line: Pick<Line, "speaker">): Character | undefined {
  return line.speaker ? project.characters.find((character) => character.id === line.speaker) : undefined;
}

function over(look: UsualLook, layer: LineLook | undefined): UsualLook {
  if (!layer) return look;
  const next = { ...look };
  if (layer.shape !== undefined) next.shape = layer.shape;
  if (layer.font) next.font = layer.font;
  if (layer.fontSizePt !== undefined) next.fontSizePt = layer.fontSizePt;
  if (layer.inverted !== undefined) next.inverted = layer.inverted;
  if (layer.edge !== undefined) next.edge = layer.edge;
  return next;
}

/** The look a line gets from 作品の既定, its type and (when it follows them) its speaker. */
export function usualLook(project: Project, line: Pick<Line, "kind" | "type" | "speaker">): UsualLook {
  const base: UsualLook = {
    shape: project.lineShapes?.[line.kind] ?? "auto",
    fontSizePt: defaultFontPt(line.kind, project.style),
    inverted: false,
    edge: false,
  };
  const typed = over(base, lineTypeOf(project, line));
  return followsSpeaker(project, line) ? over(typed, speakerOf(project, line)?.look) : typed;
}

/** The line's look as it is now. */
function lookOf(line: Line): UsualLook {
  return {
    shape: line.balloonShape ?? "auto",
    ...(line.font ? { font: line.font } : {}),
    fontSizePt: line.fontSizePt,
    inverted: !!line.inverted,
    edge: !!line.edge,
  };
}

function setField(line: Line, key: LookKey, look: UsualLook): void {
  switch (key) {
    case "shape":
      if (look.shape === "auto") delete line.balloonShape;
      else line.balloonShape = look.shape;
      return;
    case "font":
      if (look.font) line.font = look.font;
      else delete line.font;
      return;
    case "fontSizePt":
      line.fontSizePt = look.fontSizePt;
      return;
    case "inverted":
      if (look.inverted) line.inverted = true;
      else delete line.inverted;
      return;
    case "edge":
      if (look.edge) line.edge = true;
      else delete line.edge;
  }
}

/**
 * The layers under a line went from `before` to `after`: each field the line
 * still had as `before` gave it takes `after`'s (one set by hand stays).
 * Returns whether the line changed.
 */
export function followLook(line: Line, before: UsualLook, after: UsualLook): boolean {
  const now = lookOf(line);
  let changed = false;
  for (const key of LOOK_KEYS) {
    if (now[key] !== before[key] || before[key] === after[key]) continue;
    setField(line, key, after);
    changed = true;
  }
  if (changed) fitLine(line);
  return changed;
}

/** A new line takes the look of its kind, type and speaker. */
export function applyLook(project: Project, line: Line): void {
  const look = usualLook(project, line);
  for (const key of LOOK_KEYS) setField(line, key, look);
  fitLine(line);
}

/** The 種類 to give a line: one of the five kinds, or a type made for the name. */
export type LineChoice = { kind: LineKind } | { type: string };

/** The choice a line has now. */
export function choiceOf(line: Pick<Line, "kind" | "type">): LineChoice {
  return line.type ? { type: line.type } : { kind: line.kind };
}

/** Change a line's 種類 (a kind or a type made for the name): what it had from the old one goes, the new one's comes. */
export function setLineType(project: Project, line: Line, choice: LineChoice): void {
  const before = usualLook(project, line);
  if ("type" in choice) {
    const type = project.lineTypes?.find((t) => t.id === choice.type);
    if (!type) return;
    line.type = type.id;
    line.kind = type.base;
  } else {
    delete line.type;
    line.kind = choice.kind;
  }
  if (!followLook(line, before, usualLook(project, line))) fitLine(line);
}

/** Change who says a line: the look it had from the old speaker goes, the new one's comes. */
export function setLineSpeaker(project: Project, line: Line, speaker: string | undefined): void {
  const before = usualLook(project, line);
  if (speaker) line.speaker = speaker;
  else delete line.speaker;
  followLook(line, before, usualLook(project, line));
}

/**
 * `change` alters looks under the lines (a type's or a character's, the
 * types themselves): the lines that had the usual look follow. Returns how many changed.
 */
export function changeLooks(project: Project, change: () => void): number {
  const lines = project.pages.flatMap((page) => page.lines);
  const before = lines.map((line) => usualLook(project, line));
  change();
  let count = 0;
  lines.forEach((line, i) => {
    if (followLook(line, before[i], usualLook(project, line))) count++;
  });
  return count;
}

/** A new セリフ種類 based on `base` (narration, 描き文字 and 小書き ones keep their look whoever says them). */
export function addLineType(project: Project, base: LineKind, name: string): LineType {
  const type: LineType = { id: newId(project, "type"), name, base };
  if (OWN_LOOK_KINDS.includes(base)) type.ownLook = true;
  project.lineTypes = [...(project.lineTypes ?? []), type];
  return type;
}

/** Remove a セリフ種類: its lines go back to its base kind. Returns how many lines it had. */
export function removeLineType(project: Project, id: string): number {
  const type = project.lineTypes?.find((t) => t.id === id);
  if (!type) return 0;
  let count = 0;
  for (const page of project.pages)
    for (const line of page.lines)
      if (line.type === id) {
        setLineType(project, line, { kind: type.base });
        count++;
      }
  const rest = (project.lineTypes ?? []).filter((t) => t.id !== id);
  if (rest.length) project.lineTypes = rest;
  else delete project.lineTypes;
  return count;
}

/** The name a line's 種類 is shown by. */
export function choiceLabel(project: Project, line: Pick<Line, "kind" | "type">, kinds: Record<LineKind, string>): string {
  return lineTypeOf(project, line)?.name ?? kinds[line.kind];
}

/** A look with nothing set is no look: kept out of the file. */
export function tidyLook<T extends LineLook>(look: T): T | undefined {
  const empty = LOOK_KEYS.every((key) => (look as LineLook)[key as keyof LineLook] === undefined);
  return empty ? undefined : look;
}

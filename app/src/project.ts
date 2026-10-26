// ネームデータ（正本）: a new name, its pages and settings, and reading a
// saved one into the current shape. The types live in model.ts; the edits by
// what they change in dialogue.ts, panels.ts, strokes.ts, stickies.ts,
// cast.ts and reorder.ts. Coordinates are millimetres on the page canvas,
// origin at its top left. Functions change the project in place; the editor
// takes a snapshot before each change for undo.

import type { Binding, Gutters, Page, PageFormat, Project } from "./model";

export const FORMAT_VERSION = 2;
export const MM_PER_PT = 25.4 / 72;
/** Gap between panels side by side (左右) and one above the other (上下). */
export const DEFAULT_GUTTERS: Gutters = { across: 2, down: 6 };
/** The widest コマ間 that can be set (mm). */
export const MAX_GUTTER_SETTING_MM = 40;
/** 縦スクロール: panels one above the other are far apart, as the strip is read scrolling. */
export const SCROLL_GUTTERS: Gutters = { across: 3, down: 24 };

/** The コマ間 new panels of the project get. */
export function gutters(project: Project): Gutters {
  return project.gutters ?? DEFAULT_GUTTERS;
}

/** Sets the project's コマ間 (each 0 to MAX_GUTTER_SETTING_MM, 0.1 mm steps); the default is kept as none. */
export function setGutters(project: Project, next: Gutters): void {
  const clamp = (value: number, fallback: number) =>
    Number.isFinite(value) ? Math.round(Math.min(Math.max(value, 0), MAX_GUTTER_SETTING_MM) * 10) / 10 : fallback;
  const value = { across: clamp(next.across, gutters(project).across), down: clamp(next.down, gutters(project).down) };
  if (value.across === DEFAULT_GUTTERS.across && value.down === DEFAULT_GUTTERS.down) delete project.gutters;
  else project.gutters = value;
}

/** A3 canvas, B4 trim and a 180 x 270 mm basic frame (same as the Rust default). */
export function defaultPageFormat(): PageFormat {
  return { canvasMm: [297, 420], trimMm: [257, 364], basicMm: [180, 270], basicOffsetMm: [0, 0] };
}

/**
 * 縦スクロール (Webtoon): one piece (区切り) of the strip, about two phone
 * screens tall. The strip is not cut, so the trim is the whole piece; the
 * basic frame keeps panels off its sides and apart across the pieces.
 */
export function scrollPageFormat(): PageFormat {
  return { canvasMm: [120, 240], trimMm: [120, 240], basicMm: [108, 228], basicOffsetMm: [0, 0] };
}

/** What kind of name it is: a right-bound (manga) or left-bound book, or a 縦スクロール strip (read top to bottom, left-bound otherwise). */
export type NameKind = Binding | "scroll";

export function nameKind(project: Project): NameKind {
  return project.scroll ? "scroll" : project.binding;
}

export function newProject(title: string, pageCount: number, kind: NameKind = "right"): Project {
  const project: Project = {
    formatVersion: FORMAT_VERSION,
    title,
    author: "",
    binding: kind === "right" ? "right" : "left",
    pageFormat: kind === "scroll" ? scrollPageFormat() : defaultPageFormat(),
    pages: [],
    characters: [],
    scenes: [],
    emotions: [],
    brushes: [],
    nextId: 1,
  };
  if (kind === "scroll") {
    project.scroll = true;
    project.gutters = { ...SCROLL_GUTTERS };
  }
  for (let i = 0; i < pageCount; i++) project.pages.push(emptyPage(newId(project, "page")));
  return project;
}

export function emptyPage(id: string): Page {
  return { id, memo: "", panels: [], lines: [], strokes: [], roughs: [], breakouts: [] };
}

/** Fill in fields the Rust side leaves out when they are empty. */
export function normalize(project: Project): Project {
  project.characters ??= [];
  project.scenes ??= [];
  project.emotions ??= [];
  project.author ??= "";
  project.brushes ??= [];
  for (const brush of project.brushes) {
    brush.kind ??= "pen";
    brush.opacity ??= 1;
    brush.hardness ??= 1;
    brush.stabilization ??= 0;
    brush.taperInMm ??= 0;
    brush.taperOutMm ??= 0;
    brush.thickness ??= 100;
    brush.rotation ??= 0;
  }
  const beforeShapes = (project.formatVersion ?? 1) < 2;
  const stored = (project.alternatives ?? []).flatMap((set) => set.options.flatMap((option) => (option.pages ??= [])));
  for (const page of [...project.pages, ...stored]) {
    page.memo ??= "";
    page.panels ??= [];
    page.lines ??= [];
    page.strokes ??= [];
    page.roughs ??= [];
    page.breakouts ??= [];
    for (const line of page.lines) {
      line.kind ??= "speech";
      // Before balloon shapes (format 1), an outline the editor did not make
      // (it made 40-point ellipses and 4-point boxes) came from CSP.
      if (beforeShapes && !line.balloonShape && line.balloon && line.balloon.length !== 40 && line.balloon.length !== 4) line.balloonShape = "custom";
    }
  }
  for (const scene of project.scenes) scene.summary ??= "";
  for (const point of project.emotions) point.note ??= "";
  project.pageFormat.basicOffsetMm ??= [0, 0];
  // Saved again by this version, the file may hold parts older versions drop.
  project.formatVersion = Math.max(project.formatVersion ?? FORMAT_VERSION, FORMAT_VERSION);
  return project;
}

export function newId(project: Project, prefix: string): string {
  return `${prefix}${project.nextId++}`;
}

export function pageIndex(project: Project, pageId: string): number {
  return project.pages.findIndex((page) => page.id === pageId);
}

export function insertPage(project: Project, index: number): Page {
  const page = emptyPage(newId(project, "page"));
  project.pages.splice(Math.max(0, Math.min(index, project.pages.length)), 0, page);
  return page;
}

/** Remove a page with what refers to it: emotion values and scene ends. */
export function removePage(project: Project, pageId: string): void {
  const index = pageIndex(project, pageId);
  if (index < 0) return;
  project.pages.splice(index, 1);
  project.emotions = project.emotions.filter((point) => point.page !== pageId);
  // 別案 of only this page go with it.
  if (project.alternatives) {
    for (const set of project.alternatives) set.pageIds = set.pageIds.filter((id) => id !== pageId);
    project.alternatives = project.alternatives.filter((set) => set.pageIds.length);
    if (!project.alternatives.length) delete project.alternatives;
  }
  const neighbour = (forward: boolean) => {
    const near = forward ? project.pages[index] : project.pages[index - 1];
    return (near ?? project.pages[index - 1] ?? project.pages[index])?.id;
  };
  project.scenes = project.scenes.flatMap((scene) => {
    if (scene.firstPage === pageId) scene.firstPage = neighbour(true) ?? "";
    if (scene.lastPage === pageId) scene.lastPage = neighbour(false) ?? "";
    const first = pageIndex(project, scene.firstPage);
    const last = pageIndex(project, scene.lastPage);
    return first < 0 || last < 0 || first > last ? [] : [scene];
  });
}

export function movePage(project: Project, pageId: string, step: number): void {
  const index = pageIndex(project, pageId);
  const target = index + step;
  if (index < 0 || target < 0 || target >= project.pages.length) return;
  const [page] = project.pages.splice(index, 1);
  project.pages.splice(target, 0, page);
  // Keep scenes in page order after the move.
  for (const scene of project.scenes) {
    if (pageIndex(project, scene.firstPage) > pageIndex(project, scene.lastPage)) {
      [scene.firstPage, scene.lastPage] = [scene.lastPage, scene.firstPage];
    }
  }
}

/** How many pages at the end have nothing on them (no panels, lines, strokes, roughs, fills or memo). */
export function trailingEmptyPages(project: Project): number {
  let count = 0;
  for (let i = project.pages.length - 1; i >= 0; i--) {
    const page = project.pages[i];
    const filled = page.panels.length + page.lines.length + page.strokes.length + page.roughs.length + (page.fills?.length ?? 0) + (page.references?.length ?? 0) > 0 || page.memo.trim() !== "";
    if (filled) break;
    count++;
  }
  return count;
}

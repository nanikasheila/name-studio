// CSP のページ設定: the CLIP STUDIO PAINT page and work a name is written out
// on without a CSP-made template. The Rust side makes them from settings
// (clip-core write::blank) out of a blank page CSP saved, built into the app.
import type { CspPage, CspStory, PageFormat, Project } from "./model";

/** What `prepare_builtin_template` takes (clip-core `PageSetup`). */
export interface PageSetup {
  canvasMm: [number, number];
  resolution: number;
  trimMm: [number, number];
  bleedMm: number;
  basicMm: [number, number];
  basicOffsetMm: [number, number];
  rightBinding: boolean;
  firstPageLeft: boolean;
  title: string;
  storyIndex: number | null;
  author: string;
  nombreStart: number;
  font: { name: string; postscript: string } | null;
  /** clip-core `StoryLayout`: what is not given is CSP's default. */
  story?: CspStory;
}

/** Where `prepare_builtin_template` put the page, the layers to copy and the work. */
export interface BuiltTemplate {
  page: string;
  parts: string;
  work: string;
}

/** The usual bleed (裁ち落とし) of a commercial manuscript. */
const USUAL_BLEED_MM = 5;

/** The largest side CSP takes, in px. */
const MAX_SIDE_PX = 30000;

/** The CSP page of the same size and frames as the name's own page, at 600 dpi. */
export function pageFromFormat(format: PageFormat): CspPage {
  const room = Math.min(format.canvasMm[0] - format.trimMm[0], format.canvasMm[1] - format.trimMm[1]) / 2;
  return {
    canvasMm: [...format.canvasMm],
    trimMm: [...format.trimMm],
    bleedMm: Math.max(0, Math.min(USUAL_BLEED_MM, Math.round(room * 10) / 10)),
    basicMm: [...format.basicMm],
    basicOffsetMm: format.basicOffsetMm ? [...format.basicOffsetMm] : [0, 0],
    resolution: 600,
  };
}

/** The name's CSP page settings, or ones made from its page. */
export function cspPageOf(project: Project): CspPage {
  return project.cspPage ? structuredClone(project.cspPage) : pageFromFormat(project.pageFormat);
}

/** Whether the book's first page is a left page (a manga's, bound on the right, is). */
export function firstPageLeft(project: Project, page: CspPage): boolean {
  return page.firstPageLeft ?? project.binding === "right";
}

export interface Preset {
  id: string;
  label: string;
  page: Pick<CspPage, "canvasMm" | "trimMm" | "bleedMm" | "basicMm">;
}

/** 用紙: common page sizes (仕上がり with its bleed, and a basic frame inside). */
export const PRESETS: Preset[] = [
  { id: "b4", label: "商業誌 B4（A3 キャンバス、裁ち落とし 5 mm）", page: { canvasMm: [297, 420], trimMm: [257, 364], bleedMm: 5, basicMm: [180, 270] } },
  { id: "b4-tight", label: "B4（キャンバス＝仕上がり＋裁ち落とし 5 mm）", page: { canvasMm: [267, 374], trimMm: [257, 364], bleedMm: 5, basicMm: [180, 270] } },
  { id: "a4", label: "A4（裁ち落とし 3 mm）", page: { canvasMm: [216, 303], trimMm: [210, 297], bleedMm: 3, basicMm: [170, 250] } },
  { id: "b5", label: "同人誌 B5（裁ち落とし 3 mm）", page: { canvasMm: [188, 263], trimMm: [182, 257], bleedMm: 3, basicMm: [150, 220] } },
  { id: "a5", label: "同人誌 A5（裁ち落とし 3 mm）", page: { canvasMm: [154, 216], trimMm: [148, 210], bleedMm: 3, basicMm: [120, 175] } },
];

/** The preset `page` is exactly, or null for one set by hand. */
export function presetOf(page: CspPage): string | null {
  const same = (a: number[], b: number[]) => a.every((value, index) => Math.abs(value - b[index]) < 1e-6);
  const found = PRESETS.find(
    ({ page: preset }) =>
      same(preset.canvasMm, page.canvasMm) &&
      same(preset.trimMm, page.trimMm) &&
      same(preset.basicMm, page.basicMm) &&
      Math.abs(preset.bleedMm - page.bleedMm) < 1e-6 &&
      same([0, 0], page.basicOffsetMm),
  );
  return found?.id ?? null;
}

/** `page` with the sizes of preset `id` (the rest kept). */
export function withPreset(page: CspPage, id: string): CspPage {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  if (!preset) return page;
  return {
    ...page,
    canvasMm: [...preset.page.canvasMm],
    trimMm: [...preset.page.trimMm],
    bleedMm: preset.page.bleedMm,
    basicMm: [...preset.page.basicMm],
    basicOffsetMm: [0, 0],
  };
}

/** `story` without what CSP has anyway (none when nothing is left). */
export function compactStory(story: CspStory): CspStory | undefined {
  const next: CspStory = {};
  if (story.subtitle?.trim()) next.subtitle = story.subtitle.trim();
  if (story.titlePosition && story.titlePosition !== "left") next.titlePosition = story.titlePosition;
  if (story.authorPosition && story.authorPosition !== "center") next.authorPosition = story.authorPosition;
  if (story.pageNumber) {
    next.pageNumber = { start: story.pageNumber.start };
    if (story.pageNumber.position && story.pageNumber.position !== "right") next.pageNumber.position = story.pageNumber.position;
  }
  if (story.nombre) {
    const { place, white, edgeMm, prefix, suffix, offsetMm, sizePt } = story.nombre;
    next.nombre = { place };
    if (white) next.nombre.white = true;
    if (edgeMm !== undefined) next.nombre.edgeMm = edgeMm;
    if (prefix) next.nombre.prefix = prefix;
    if (suffix) next.nombre.suffix = suffix;
    if (offsetMm && (offsetMm[0] !== 0 || offsetMm[1] !== 5)) next.nombre.offsetMm = [offsetMm[0], offsetMm[1]];
    if (sizePt !== undefined && sizePt !== 9) next.nombre.sizePt = sizePt;
  }
  return Object.keys(next).length ? next : undefined;
}

/** What the work's 作品情報 says, as the export dialog has it. */
export interface StoryInfo {
  title: string;
  storyIndex: number | null;
  author: string;
}

/**
 * 縦スクロール with its pieces joined: how many pieces go one under the other
 * on a CSP page, as many as CSP's largest side holds; otherwise 1.
 */
export function piecesPerPage(project: Pick<Project, "scroll" | "pages">, page: CspPage): number {
  if (!project.scroll || !page.joinPieces) return 1;
  const piecePx = Math.ceil((page.canvasMm[1] * page.resolution) / 25.4);
  return Math.max(1, Math.min(project.pages.length, Math.floor(MAX_SIDE_PX / piecePx)));
}

/** The CSP page that holds `pieces` pieces of `page` one under the other: taller by the pieces below the first. */
export function joinedPage(page: CspPage, pieces: number): CspPage {
  if (pieces <= 1) return page;
  const more = (pieces - 1) * page.canvasMm[1];
  return {
    ...page,
    canvasMm: [page.canvasMm[0], page.canvasMm[1] + more],
    trimMm: [page.trimMm[0], page.trimMm[1] + more],
    basicMm: [page.basicMm[0], page.basicMm[1] + more],
  };
}

/** The settings the Rust side makes the page and work with (縦スクロール with joined pieces: the tall page). */
export function pageSetup(
  project: Project,
  piece: CspPage,
  story: StoryInfo,
  postscriptOf: (font: string) => string | undefined = () => undefined,
): PageSetup {
  const page = joinedPage(piece, piecesPerPage(project, piece));
  return {
    canvasMm: [...page.canvasMm],
    resolution: page.resolution,
    trimMm: [...page.trimMm],
    bleedMm: page.bleedMm,
    basicMm: [...page.basicMm],
    basicOffsetMm: [...page.basicOffsetMm],
    rightBinding: !project.scroll && project.binding === "right",
    firstPageLeft: firstPageLeft(project, page),
    title: story.title.trim() || project.title.trim() || "無題",
    storyIndex: story.storyIndex,
    author: story.author.trim(),
    nombreStart: page.nombreStart ?? 1,
    font: page.font ? { name: page.font, postscript: postscriptOf(page.font) ?? page.font } : null,
    ...(page.story ? { story: structuredClone(page.story) } : {}),
  };
}

/** Why CSP cannot make this page, or null (the Rust side checks the same). */
export function setupProblem(setup: PageSetup): string | null {
  const positive = (values: number[]) => values.every((value) => Number.isFinite(value) && value > 0);
  if (!positive(setup.canvasMm)) return "キャンバスの幅と高さを入れてください";
  if (!(setup.resolution >= 72 && setup.resolution <= 1200)) return "解像度は 72〜1200 dpi にしてください";
  if (!positive(setup.trimMm)) return "仕上がりの幅と高さを入れてください";
  if (setup.trimMm[0] > setup.canvasMm[0] + 1e-9 || setup.trimMm[1] > setup.canvasMm[1] + 1e-9) return "仕上がりがキャンバスより大きくなっています";
  if (!(Number.isFinite(setup.bleedMm) && setup.bleedMm >= 0)) return "裁ち落とし幅は 0 以上にしてください";
  if (!positive(setup.basicMm)) return "基本枠の幅と高さを入れてください";
  const [ox, oy] = setup.basicOffsetMm;
  if (
    !Number.isFinite(ox) ||
    !Number.isFinite(oy) ||
    setup.basicMm[0] / 2 + Math.abs(ox) > setup.canvasMm[0] / 2 + 1e-9 ||
    setup.basicMm[1] / 2 + Math.abs(oy) > setup.canvasMm[1] / 2 + 1e-9
  ) {
    return "基本枠がキャンバスからはみ出しています";
  }
  const px = (mm: number) => Math.round((mm * setup.resolution) / 25.4);
  if (px(setup.canvasMm[0]) > MAX_SIDE_PX || px(setup.canvasMm[1]) > MAX_SIDE_PX) return "キャンバスが大きすぎます（解像度を下げてください）";
  if (!setup.title.trim()) return "作品名を入れてください";
  if ((setup.storyIndex ?? 0) < 0 || setup.nombreStart < 0) return "話数とノンブルの開始番号は 0 以上にしてください";
  const story = setup.story;
  if (story?.pageNumber && !(story.pageNumber.start >= 0)) return "ページ番号の開始番号は 0 以上にしてください";
  const nombre = story?.nombre;
  if (nombre) {
    const size = nombre.sizePt ?? 9;
    if (!(size >= 4 && size <= 72)) return "ノンブルの大きさは 4〜72 pt にしてください";
    if (nombre.edgeMm !== undefined && !(nombre.edgeMm >= 0 && nombre.edgeMm <= 5)) return "ノンブルのフチは 0〜5 mm にしてください";
    if (!(nombre.offsetMm ?? [0, 5]).every((offset) => Math.abs(offset) <= 100)) return "ノンブルの基本枠との間隔は ±100 mm までにしてください";
  }
  return null;
}

/** The page in pixels at its resolution, for the dialog to show. */
export function pixelSize(page: CspPage): [number, number] {
  return [Math.round((page.canvasMm[0] * page.resolution) / 25.4), Math.round((page.canvasMm[1] * page.resolution) / 25.4)];
}

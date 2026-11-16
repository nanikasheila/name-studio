// まとめて設定: what several things picked together (a 範囲選択, maybe over
// a 見開き's two pages) have in common, and the same change made to each of
// them. A field whose things differ shows as mixed; a change sets them all.
import { fitLine, setLineText } from "./dialogue";
import { setLineSpeaker, setLineType, type LineChoice } from "./linelook";
import { bleedPanel, isBled, rotatePanel, type Side } from "./koma";
import { isMark, layerOf, moveStrokesToLayer } from "./roughlayers";
import { setPanelLineMm } from "./style";
import { tidyPanels } from "./tidy";
import type { ItemRef } from "./transform";
import type { BalloonShape, Breakout, Fill, Line, Page, Panel, Project, Stroke, TailStyle } from "../model/model";

/** One thing picked and the page it is on. */
export interface On<T> {
  page: Page;
  item: T;
}

/** What is picked, kind by kind (things gone from the name left out). */
export interface PickedThings {
  lines: On<Line>[];
  panels: On<Panel>[];
  strokes: On<Stroke>[];
  fills: On<Fill>[];
  breakouts: On<Breakout>[];
}

/** The things `items` name (on `pageId` unless an item names its own page), found in `project`. */
export function pickedThings(project: Project, pageId: string, items: readonly ItemRef[]): PickedThings {
  const found: PickedThings = { lines: [], panels: [], strokes: [], fills: [], breakouts: [] };
  const seen = new Set<string>();
  for (const ref of items) {
    const page = project.pages.find((p) => p.id === (ref.pageId ?? pageId));
    if (!page) continue;
    const key = `${page.id}:${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const put = <T extends { id: string }>(list: readonly T[] | undefined, into: On<T>[]) => {
      const item = list?.find((x) => x.id === ref.id);
      if (item) into.push({ page, item });
    };
    if (ref.kind === "line") put(page.lines, found.lines);
    else if (ref.kind === "panel") put(page.panels, found.panels);
    else if (ref.kind === "stroke") put(page.strokes, found.strokes);
    else if (ref.kind === "fill") put(page.fills, found.fills);
    else put(page.breakouts, found.breakouts);
  }
  return found;
}

/** The value every one has, or null when they differ (or there are none). */
export function shared<T>(values: readonly T[]): { value: T } | null {
  if (!values.length) return null;
  const first = values[0];
  return values.every((value) => value === first) ? { value: first } : null;
}

/** A セリフ種類 as one word, to compare. */
export function choiceKey(line: Pick<Line, "kind" | "type">): string {
  return line.type ? `type:${line.type}` : `kind:${line.kind}`;
}

/** The yes / no fields of a line that are set alike for many. */
export type LineFlag = "vertical" | "emphasis" | "inverted" | "edge" | "mask";

/** Whether a line can take `flag` (コマ枠でマスク needs a panel). */
export function takesFlag(line: Line, flag: LineFlag): boolean {
  return flag !== "mask" || !!line.panel;
}

/** A line's yes / no field. */
export function lineFlag(line: Line, flag: LineFlag): boolean {
  return flag === "vertical" ? line.vertical : !!line[flag];
}

/** Each line on or off for `flag`; 縦書き fits the balloon again. Returns how many changed. */
export function setLinesFlag(lines: readonly Line[], flag: LineFlag, on: boolean): number {
  let changed = 0;
  for (const line of lines) {
    if (!takesFlag(line, flag) || lineFlag(line, flag) === on) continue;
    changed++;
    if (flag === "vertical") {
      line.vertical = on;
      fitLine(line);
    } else if (on) line[flag] = true;
    else delete line[flag];
  }
  return changed;
}

/** 文字の大きさ of each line, the balloon fitted to it (as typed in one line's field). */
export function setLinesSize(lines: readonly Line[], pt: number): void {
  for (const line of lines) {
    line.fontSizePt = pt;
    setLineText(line, line.text);
  }
}

/** フォント of each line; empty: the one for its kind. */
export function setLinesFont(lines: readonly Line[], font: string): void {
  for (const line of lines) {
    if (font) line.font = font;
    else delete line.font;
  }
}

/** フキダシの形 of each line ("auto": as its kind). An outline taken from CSP is kept unless another shape is chosen. */
export function setLinesShape(lines: readonly Line[], shape: BalloonShape): void {
  for (const line of lines) {
    if (shape === "auto") delete line.balloonShape;
    else line.balloonShape = shape;
    fitLine(line);
  }
}

/** Every しっぽ of each line in `style`. Returns how many tails. */
export function setTailsStyle(lines: readonly Line[], style: TailStyle): number {
  let count = 0;
  for (const line of lines)
    for (const tail of line.tails ?? []) {
      tail.style = style;
      count++;
    }
  return count;
}

/** フキダシを文字に合わせる for each line whose balloon was resized alone. Returns how many. */
export function fitBalloons(lines: readonly Line[]): number {
  let count = 0;
  for (const line of lines) {
    if (!line.balloonScale) continue;
    delete line.balloonScale;
    fitLine(line);
    count++;
  }
  return count;
}

/** 種類 of each line. */
export function setLinesType(project: Project, lines: readonly Line[], choice: LineChoice): void {
  for (const line of lines) setLineType(project, line, choice);
}

/** 話者 of each line (none: nobody). */
export function setLinesSpeaker(project: Project, lines: readonly Line[], speaker: string | undefined): void {
  for (const line of lines) setLineSpeaker(project, line, speaker);
}

/** A field of each panel; `none` (the value meaning "as usual") is left out of the data. */
export function setPanelsField<K extends "border" | "fill" | "effect" | "draft">(
  panels: readonly Panel[],
  key: K,
  value: NonNullable<Panel[K]>,
  none: NonNullable<Panel[K]>,
): void {
  for (const panel of panels) {
    if (value === none) delete panel[key];
    else panel[key] = value;
  }
}

/** 枠線の太さ of each panel (null: the name's for its border). */
export function setPanelsLineMm(project: Project, panels: readonly Panel[], mm: number | null): void {
  for (const panel of panels) setPanelLineMm(panel, mm, project.style);
}

/** 裁ち切り on a side for each panel not so yet (or off for each that is). Returns how many changed. */
export function bleedPanels(project: Project, panels: readonly Panel[], side: Side, on: boolean): number {
  let changed = 0;
  for (const panel of panels) {
    if (isBled(panel, side, project.pageFormat) === on) continue;
    bleedPanel(panel, side, project.pageFormat, on);
    changed++;
  }
  return changed;
}

/** Each panel turned by `degrees` about its own middle. */
export function tiltPanels(panels: readonly Panel[], degrees: number): void {
  for (const panel of panels) rotatePanel(panel, degrees);
}

/** Each panel one step up (or down) in the stacking. */
export function stackPanels(panels: readonly Panel[], step: 1 | -1): void {
  for (const panel of panels) {
    const z = (panel.z ?? 0) + step;
    if (z) panel.z = z;
    else delete panel.z;
  }
}

/** 整える the panels, page by page. Returns how many were tidied. */
export function tidyPicked(project: Project, panels: readonly On<Panel>[]): number {
  let tidied = 0;
  for (const [page, ids] of byPage(panels)) tidied += tidyPanels(project, page, ids).tidied;
  return tidied;
}

/** The ids of things page by page. */
export function byPage<T extends { id: string }>(things: readonly On<T>[]): Map<Page, string[]> {
  const pages = new Map<Page, string[]>();
  for (const { page, item } of things) pages.set(page, [...(pages.get(page) ?? []), item.id]);
  return pages;
}

/** Which layers lines can be moved among: the rough's, or the 指示's, when all are of one sort. */
export function strokeSort(project: Project, strokes: readonly Stroke[]): "rough" | "marks" | "both" {
  const marks = strokes.filter((stroke) => isMark(project, stroke)).length;
  return marks === 0 ? "rough" : marks === strokes.length ? "marks" : "both";
}

/** Each line's 太さ (mm). */
export function setStrokesWidth(strokes: readonly Stroke[], widthMm: number): void {
  for (const stroke of strokes) stroke.widthMm = widthMm;
}

/** Each rough line's 色 (none: black); 指示 keep their layer's. Returns how many changed. */
export function setStrokesColor(project: Project, strokes: readonly Stroke[], color: string | undefined): number {
  let changed = 0;
  for (const stroke of strokes) {
    if (isMark(project, stroke) || stroke.color === color) continue;
    if (color) stroke.color = color;
    else delete stroke.color;
    changed++;
  }
  return changed;
}

/** Each line over the panel borders (in a はみ出し) or not. */
export function setStrokesOver(strokes: readonly Stroke[], on: boolean): void {
  for (const stroke of strokes) {
    if (on) stroke.over = true;
    else delete stroke.over;
  }
}

/** The lines moved onto the layer `layerId`, page by page. Returns how many moved. */
export function strokesToLayer(project: Project, strokes: readonly On<Stroke>[], layerId: string): number {
  let moved = 0;
  for (const [page, ids] of byPage(strokes)) moved += moveStrokesToLayer(project, page, ids, layerId);
  return moved;
}

/** The id of the layer a line is on (ROUGH_BASE for the first of a name with one). */
export function strokeLayerId(project: Project, stroke: Stroke): string {
  return layerOf(project, stroke).id;
}

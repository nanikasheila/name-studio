// The Rust side's commands (app/src-tauri) and the shapes they take and give.
// Generated from the Rust source by `cargo run -p ipc-types`; do not edit.
// Change the Rust side and run it again (crates/ipc-types has a test that fails while this is behind).

import type { CspToolData, Project, Series } from "../model/model";

/**
 * A request body of `[u32 little-endian JSON length][JSON][bytes]` (see
 * `packBody` and `projectBody`): images and the project text travel as bytes.
 */
export type RawBody = Uint8Array;

/** What a turn says, as it says it. */
export interface AiEvent {
  run: number;
  /**
   * "session": the conversation's id (to go on with it); "delta": text as
   * it comes; "text": a whole message; "tool": something the AI did (read
   * a file, ran a command); "done": the turn ended; "error": it failed.
   */
  kind: "session" | "delta" | "text" | "tool" | "done" | "error";
  text: string;
}

export type AiKind = "claude" | "codex" | "local";

/** A model to choose, as the AI tool itself lists it. */
export interface AiModel {
  /** What goes to `--model` ("": the tool's own default). */
  value: string;
  label: string;
  description: string;
  /** The efforts it takes (none: it takes no effort). */
  efforts: string[];
  defaultEffort: string | null;
  /** The one used when none is chosen. */
  isDefault: boolean;
}

export interface AiTools {
  claude: FoundTool | null;
  codex: FoundTool | null;
  node: FoundTool | null;
}

/** One turn of a conversation. */
export interface AiTurn {
  kind: AiKind;
  /** The conversation's folder ([`ai_prepare_session`]). */
  dir: string;
  /** What the user says (Claude Code, Codex). */
  prompt?: string;
  /** The conversation to go on with (its "session" event). */
  resume?: string | null;
  model?: string | null;
  /** How hard it thinks (Claude Code `--effort`, Codex `model_reasoning_effort`), one its model offers. */
  effort?: string | null;
  /** The program, when the settings name one. */
  program?: string | null;
  /**
   * Codex's Windows sandbox (`windows.sandbox`): none for "mxc", "config"
   * for what ~/.codex/config.toml says, or a mode by name.
   */
  sandbox?: string | null;
  /** Pictures (in the folder) to show Codex with the prompt. */
  images?: string[];
  /** A local LLM's OpenAI-compatible API, such as http://localhost:11434/v1. */
  endpoint?: string | null;
  /** The whole conversation so far, for a local LLM. */
  messages?: ChatMessage[];
}

export interface AutosaveResult {
  /** The project file itself was written (otherwise only the autosave copy). */
  savedToFile: boolean;
  version: VersionInfo | null;
  /** What the check found wrong: the copy was kept anyway, the file was not written. */
  problems: string[];
}

export interface BatchExport {
  project: string;
  /** The page template; none with `--builtin`. */
  template: string | null;
  /** Pages from the name's own CSP page settings (`--builtin`), no template. */
  builtin: boolean;
  outDir: string;
  workTemplate: string | null;
  workName: string | null;
  storyIndex: number | null;
  /** 見本のページ: CSP pages to copy text and vector layers from. */
  donors: string[];
  /** The rough as 下描き layers at half opacity (`--no-draft-rough` turns it off). */
  draftRough: boolean;
  /** Panels as a コマ枠フォルダー copied from a donor (`--frame-folders`). */
  frameFolders: boolean;
  /** Each panel as a folder with a レイヤーマスク (`--panel-masks`). */
  panelMasks: boolean;
  /** The name's memos as a 下描き layer (`--no-notes` leaves them out). */
  notes: boolean;
  /** The 指示のレイヤー as 下描き layers (`--no-marks` leaves them out). */
  marks: boolean;
  /** Bring the dialogue into the pages there instead of writing them (`--update-dialogue`). */
  updateDialogue: boolean;
  /** Take the dialogue changed in CSP back into the name (`--read-dialogue`). */
  readDialogue: boolean;
  report: string;
}

/** Where [`write_builtin_template`] put its files. */
export interface BuiltTemplate {
  page: string;
  /** The vector and text layers to copy (a donor). */
  parts: string;
  work: string;
}

export interface CanvasView {
  widthPx: number;
  heightPx: number;
  resolution: number;
  isDoublePage: boolean;
}

/** One message of a conversation with a local LLM (it keeps no history itself). */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Pictures (files in the conversation's folder) shown with it. */
  images?: string[];
}

/**
 * The dialogue of a page as CSP has it now, and what this tool wrote there
 * last (to tell what was changed in CSP).
 */
export interface CspDialogue {
  texts: CspText[];
  written: string[] | null;
  /** What was written before the name last took this page's dialogue back. */
  adoptedFrom: string[] | null;
}

/** The dialogue of the next page as CSP has it now. */
export interface CspPageDialogue {
  path: string;
  /** None when the page's file is not there. */
  dialogue: CspDialogue | null;
}

/** A dialogue text on a page, as CSP has it now. */
export interface CspText {
  text: string;
  /** Where its text sits, in page px (the union of its blocks). */
  bbox: [number, number, number, number] | null;
}

/** Where CSP keeps its tools and materials on this computer, when found. */
export interface CspToolLocations {
  tools: string | null;
  materials: string | null;
}

/**
 * When CSP's tool database was last written, and its size: to tell whether
 * it changed since it was read. None when it is not there.
 */
export interface CspToolStamp {
  modifiedMs: number;
  size: number;
}

export interface DialogueUpdateReport {
  path: string;
  /** The page as it was, when it was changed. */
  backup: string | null;
  /** Texts left as they were. */
  kept: number;
  /** Texts hidden as 「（旧）」. */
  retired: string[];
  /** Texts added. */
  added: string[];
  /** Texts there that this tool did not write (left alone). */
  foreign: number;
  /**
   * Texts changed or deleted in CSP that the name still has as written
   * last time: CSP's stands.
   */
  leftAsInCsp: number;
  /** Layers swapped, and those that were not found (renamed or deleted in CSP). */
  replaced: string[];
  notFound: string[];
  /** Swapped layers that had been changed in CSP too (CSP's are hidden as 「（旧）」). */
  conflicts: string[];
  /** Whether the memos were redrawn. */
  notes: boolean;
  /** The 指示 layers redrawn (or added). */
  marks: string[];
  /** What the page read back does not hold as asked; empty when fine. */
  problems: string[];
}

/**
 * What changes a setting while drawing (影響元設定): which inputs are on
 * (pen pressure, tilt, speed, random), the value at their lightest touch and
 * their graphs. Graph points are control points: CSP draws a smooth curve
 * through the ends that bends towards the points in between.
 */
export interface Dynamics {
  pressure: boolean;
  /** Value at the lightest pressure, 0..1 of the setting. */
  pressureMin: number;
  /** Pressure graph; empty when it is the straight line. */
  pressureCurve: [number, number][];
  tilt: boolean;
  tiltMin: number;
  tiltCurve: [number, number][];
  velocity: boolean;
  velocityMin: number;
  velocityCurve: [number, number][];
  random: boolean;
  randomMin: number;
}

/** Default settings for writing out the open sheet. */
export interface ExportDefaults {
  workTemplate: string | null;
  workName: string;
}

export interface ExportRequest {
  template: string;
  outDir: string;
  fit: Fit;
  /** Writes `<work_name>.cmc` from this template when both are given. */
  workTemplate?: string | null;
  workName?: string | null;
  storyIndex?: number | null;
}

/** The result of checking one file. */
export interface FileCheck {
  path: string;
  /** Empty when everything is as meant. */
  problems: string[];
  layers: number;
  vectorLines: number;
  texts: number;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export type Fit = "basic" | "trim" | "cell";

/** One font face. */
export interface FontFace {
  /** Full name, as CSP lists it (`游明朝 Demibold`). */
  name: string;
  /** Family names to draw it by, the Japanese one first. */
  families: string[];
  postscript: string;
  /** `OS/2` weight class (400 regular, 700 bold). */
  weight: number;
  italic: boolean;
  /** Has the Japanese code page (JIS). */
  japanese: boolean;
}

/** A program found on this computer, and what it says its version is. */
export interface FoundTool {
  path: string;
  version: string;
}

/**
 * A newer version found, as the updater's own `check` hands it to the front
 * end (`new Update(…)` there downloads and installs it).
 */
export interface FoundUpdate {
  rid: number;
  currentVersion: string;
  version: string;
  date: string | null;
  body: string | null;
  rawJson: unknown;
}

export interface ImportResult {
  project: Project;
  warnings: string[];
}

/**
 * A file in the recovery folder as the start offers it: a project to bring
 * back, or one that cannot be read, shown all the same (with why) so that
 * work is never dropped without a word.
 */
export interface KeptRecovery {
  /** Its name in the recovery folder: what removing it names. */
  file: string;
  /** When autosave wrote it (the file's own time when it cannot be read). */
  timeMs: number;
  recovery: Recovery | null;
  /** Fields a newer version added that this one does not show (kept on saving). */
  unknownFields?: string[];
  /** Why it cannot be brought back (damaged, or a choice a newer version added). */
  unreadable: string | null;
}

/**
 * How a layer is written: its opacity (0..1, times what it has, such as a
 * 下描き layer's half, or as is with `whole`) and whether it is hidden.
 */
export interface LayerLook {
  name: string;
  opacity: number;
  hidden?: boolean;
  /** The opacity as is, not times a 下描き layer's half: 指示 keep their colour. */
  whole?: boolean;
}

export interface LayerView {
  id: number;
  parent: number | null;
  depth: number;
  name: string;
  kind: string;
  visible: boolean;
  opacity: number;
  hasPixels: boolean;
  /** Canvas position of the stored pixels' top-left corner. */
  pixelOrigin: [number, number];
  /** Size of the stored pixels (offscreen), when there are any. */
  pixelSize: [number, number] | null;
  vectors: VectorView[];
  texts: TextView[];
}

export interface Length {
  value: number;
  unit: LengthUnit;
}

export type LengthUnit = "px" | "px10";

export interface NameExportReport extends WorkReport {
  /** The work read back (none without a work). */
  workCheck: FileCheck | null;
}

export interface NameExportRequest {
  template: string;
  outDir: string;
  workTemplate?: string | null;
  workName?: string | null;
  storyIndex?: number | null;
  /** The name data and its source sheet: never overwritten. */
  inputs: string[];
  /**
   * .clip files (such as the name sheet) whose vector / text layers new
   * editable layers are copied from, after the template.
   */
  donors?: string[];
  /** Layers (by name) written as 下描き layers at half opacity. */
  draftLayers?: string[];
  /** Layers (by name) written fainter or hidden (the ラフ線のレイヤー). */
  layerLooks?: LayerLook[];
  /** Look for a コマ枠フォルダー to copy, to write panels as frames. */
  frameFolders?: boolean;
  /** The name's binding (true: right-bound), written over the template's. */
  rightBinding?: boolean | null;
}

/** The template's canvas and which parts can be written as editable layers. */
export interface NameExportStart extends TemplateCanvas {
  vectorLayers: boolean;
  textLayers: boolean;
  /** Whether panels can be written as a コマ枠フォルダー (one was found to copy). */
  frameFolders: boolean;
  /** Whether the book's first page (index 0) is a left page. */
  firstPageLeft: boolean | null;
  /** Where pages go on a 見開き page, or why spreads cannot be written. */
  spread: SpreadLayout | null;
  spreadProblem: string | null;
}

/**
 * Where a shown ノンブル goes, from the 基本枠: above or below it, on the
 * binding side (内側), in the middle or on the other side (外側).
 */
export type NombrePlace = "top-inner" | "top" | "top-outer" | "bottom-inner" | "bottom" | "bottom-outer";

export interface OpenOptions {
  title?: string | null;
  filters?: FileFilter[];
  /** Several files at once. */
  multiple?: boolean;
  /** A folder, not a file. */
  directory?: boolean;
  defaultPath?: string | null;
}

/** CSP files already in a folder an export would write into. */
export interface OverwriteCheck {
  /** Every .clip / .cmc there, sorted. */
  existing: string[];
  /** Written by the last export and changed since (saved in CSP). */
  changed: string[];
  /** Not from the last export (another tool, an older version, or by hand). */
  unknown: string[];
  /** When the last export there was written. */
  lastExportMs: number | null;
}

/** One page of the sheet, in reading order (index from 1). */
export interface PageCell {
  index: number;
  rect: Rect;
  frame: Rect | null;
  spread_side: SpreadSide | null;
}

/** ページ番号 in the 作品情報. */
export interface PageNumber {
  /** The first page's number. */
  start: number;
  /** Where the ページ番号 goes. */
  position?: StoryPosition;
}

/** What a page and its work are made with. Lengths in mm. */
export interface PageSetup {
  /** キャンバス (用紙) size. */
  canvasMm: [number, number];
  /** 解像度 (dpi). */
  resolution: number;
  /** 仕上がり (製本) size. */
  trimMm: [number, number];
  /** 裁ち落とし幅. */
  bleedMm: number;
  /** 基本枠 size and its offset from the middle of the canvas. */
  basicMm: [number, number];
  /** Offset of the 基本枠 from the middle of the canvas (x, y). */
  basicOffsetMm?: [number, number];
  /** 右綴じ (a manga) rather than 左綴じ. */
  rightBinding: boolean;
  /** Whether the book's first page (index 0) is a left page. */
  firstPageLeft: boolean;
  /** 作品名. */
  title: string;
  /** 話数; none leaves it out of the 作品情報. */
  storyIndex?: number | null;
  /** 作者名. */
  author?: string;
  /** ノンブルの開始番号. */
  nombreStart?: number;
  /** None keeps the built-in one (ＭＳ ゴシック). */
  font?: StoryFont | null;
  /** サブタイトル, where the 作品情報 go, ページ番号 and a shown ノンブル. */
  story?: StoryLayout;
}

/**
 * Where a palette's window (ui/popout.ts) goes once it is open. The place window.open asks for is kept on
 * the main window's display by the WebView, and the page's screen pixels do not say which display a point is
 * on when the displays are scaled differently, so the app puts the window there itself.
 */
export interface PalettePlace {
  /** The window's title (the palette's name): it takes it a moment after it opens. */
  title: string;
  /**
   * Where it goes: the screen's own pixels (`physical`, as [`palette_window_rect`] gave them), or, with
   * `at_cursor`, the point of the window held under the pointer (the page's pixels, from its top left;
   * dragged out of the main window, it opens where it was let go), else the page's screen pixels.
   */
  x: number;
  y: number;
  /** Its size in the page's pixels (as large on any display). */
  width: number;
  height: number;
  physical: boolean;
  atCursor: boolean;
}

/** Where a palette's window is: `x`, `y` in the screen's own pixels, its size in the page's. */
export interface PaletteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What was picked: nothing (the dialog was closed), one path or several. */
export type Picked = string | string[] | null;

/** A project kept by autosave that may not have been saved to its file. */
export interface Recovery {
  /** The project's file, or none for a project never saved. */
  path: string | null;
  timeMs: number;
  /** The project as the app wrote it (kept as it is). */
  project: Project;
  /**
   * What the check found wrong with it: kept anyway, so the work is not
   * lost, for the app to mend when it is brought back.
   */
  problems?: string[];
}

/** Axis-aligned rectangle in canvas pixels. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SaveOptions {
  title?: string | null;
  filters?: FileFilter[];
  defaultPath?: string | null;
}

/** A file of a conversation's folder: text, or bytes in base64. */
export interface SessionFile {
  /** Inside the folder, `/` between folders. */
  path: string;
  text?: string | null;
  base64?: string | null;
}

export interface SheetView {
  path: string;
  fileName: string;
  canvas: CanvasView;
  cells: PageCell[];
  /** Layers in drawing order (bottom to top), folders included. */
  layers: LayerView[];
  warnings: string[];
}

/** A ノンブル printed on the page (CSP's ノンブル, not the hidden one). */
export interface ShownNombre {
  /** Where the ノンブル goes. */
  place: NombrePlace;
  /** 白 rather than 黒. */
  white?: boolean;
  /** フチ width (mm); none: no フチ. */
  edgeMm?: number | null;
  /** フォーマット: the text before and after the number. */
  prefix?: string;
  /** Text after the number. */
  suffix?: string;
  /** 基本枠との間隔: 横 (from the 基本枠's side, inwards) and 縦. */
  offsetMm?: [number, number];
  /** サイズ (pt). */
  sizePt?: number;
}

export interface SplitReport {
  pages: WrittenPage[];
  work: string | null;
  warnings: string[];
}

/** Where single-page content goes on the spread, in template px. */
export interface SpreadLayout {
  widthPx: number;
  heightPx: number;
  /** x of the gutter: the left page's trim ends and the right page's starts. */
  gutterPx: number;
  /** Added to the x of a single page's content for the left / right half. */
  leftDx: number;
  rightDx: number;
}

export type SpreadSide = "left" | "right";

/** The font of the 作品情報 and ノンブル texts. */
export interface StoryFont {
  /** As CSP shows it (`ＭＳ ゴシック`). */
  name: string;
  /** PostScript name of the font (`MS-Gothic`). */
  postscript: string;
}

/**
 * The rest of CSP's 作品情報 and ノンブル settings. The default is what
 * CSP's new works have: 作品名 左下, 作者名 下, no ページ番号, the hidden
 * ノンブル.
 */
export interface StoryLayout {
  /** サブタイトル, after 作品名 and 話数. */
  subtitle?: string;
  /** Where the 作品名 goes. */
  titlePosition?: StoryPosition;
  /** Where the 作者名 goes. */
  authorPosition?: StoryPosition;
  /** ページ番号 in the 作品情報 (`7ページ`); none shows none. */
  pageNumber?: PageNumber | null;
  /** A ノンブル printed on the page, in place of the hidden one. */
  nombre?: ShownNombre | null;
}

/** Where a 作品情報 text goes under the 仕上がり: CSP's 左下・下・右下. */
export type StoryPosition = "left" | "center" | "right";

export interface SubTool {
  /**
   * `NodeUuid` in hex: the same sub tool in CSP's tool database from one
   * read to the next (renamed or moved, too).
   */
  uuid: string;
  name: string;
  /** Tool and group names above it (empty in a .sut). */
  group: string[];
  kind: SubToolKind;
  size: Length | null;
  sizeDynamics: Dynamics | null;
  /** 0..1. */
  opacity: number;
  opacityDynamics: Dynamics | null;
  /** ブラシ濃度, 0..1. */
  flow: number;
  flowDynamics: Dynamics | null;
  /** 0..1; 1 is a hard edge. */
  hardness: number;
  antiAlias: number;
  /** 手ブレ補正, 0..100. */
  stabilization: number;
  /** 速度による手ブレ補正: steadier the faster the pen moves. */
  stabilizationBySpeed: boolean;
  /** 後補正: the strength the line is smoothed with once drawn (0 when off). */
  postCorrection: number;
  /** 入り・抜き: only when they change the brush size (入り抜きの影響先). */
  taperIn: Length | null;
  taperOut: Length | null;
  /** The width they start and end at, 0..1 of the size. */
  taperMin: number;
  /** Stamp spacing in % of the size. */
  interval: number;
  /** Tip height in % of its width. */
  thickness: number;
  /** Tip rotation in degrees. */
  rotation: number;
  /** Material path of the first tip picture, as CSP stores it. */
  tipMaterial: string | null;
  tip: TipImage | null;
  vectorErase: VectorErase | null;
  /**
   * Every setting as CSP keeps it, to edit and to write back as a .sut
   * ([`sub_tool_file`]); `dpi` is left for the app to fill in.
   */
  csp: CspToolData;
}

export type SubToolKind = "pen" | "eraser" | "other";

/** Size and frames of the template page, in its pixels. */
export interface TemplateCanvas {
  widthPx: number;
  heightPx: number;
  resolution: number;
  /** 仕上がり枠 and 基本枠 as `[x0, y0, x1, y1]`, when the template has them. */
  trimPx: [number, number, number, number] | null;
  basicPx: [number, number, number, number] | null;
}

export interface TextView {
  text: string;
  /**
   * Canvas box of the text block. For blocks inside balloons the stored
   * box is relative to the balloon, so it is re-centred on the balloon.
   */
  bbox: [number, number, number, number] | null;
  fontSizePx: number;
  fontName: string | null;
  vertical: boolean;
  inBalloon: boolean;
}

/** What to say, and how (設定 › タイマー). */
export interface TimerNotice {
  title: string;
  body: string;
  /** Windows' notification. */
  toast: boolean;
  /** The taskbar button flashes (only while the window is not the one in front). */
  flash: boolean;
  /** The window is shown, restored and brought to the front. */
  front: boolean;
}

/** A brush tip picture: white, with the tip's coverage in alpha. */
export interface TipImage {
  width: number;
  height: number;
  /** PNG, base64. */
  pngBase64: string;
}

export type VectorErase = "touched" | "intersection" | "whole";

export interface VectorView {
  points: [number, number][];
  closed: boolean;
  brushSize: number;
}

export interface VersionInfo {
  id: string;
  /** Milliseconds since the Unix epoch. */
  timeMs: number;
  kind: VersionKind;
  title: string;
  pages: number;
  /** Compressed size on disk. */
  bytes: number;
  /** Hash of the project's JSON, to skip versions that change nothing. */
  hash: string;
}

export type VersionKind = "saved" | "auto" | "beforeRestore";

export interface WorkReport {
  pages: string[];
  work: string | null;
}

export interface WrittenPage {
  number: number;
  path: string;
  layers: number;
  warnings: string[];
}

/** What writing a sub tool for CSP left out. */
export interface WrittenSubTool {
  /** Materials (brush tips, paper) the settings use that were not found. */
  missingMaterials: string[];
}

/** Each command: what it takes (`void`: nothing) and what it gives back. */
export interface Commands {
  // viewer.rs
  /** Open a .clip name sheet; returns everything the viewer draws except pixels. */
  open_sheet: [{ path: string }, SheetView];
  /** A raster layer shrunk by `factor`, as PNG (empty when it stores no pixels). */
  layer_overview: [{ layerId: number; factor: number }, ArrayBuffer];
  /** A raster layer's pixels inside a canvas box at full resolution, as PNG. */
  layer_region: [{ layerId: number; region: [number, number, number, number] }, ArrayBuffer];
  export_defaults: [void, ExportDefaults];
  /** Write the open sheet as one .clip per page (and a .cmc work). */
  export_pages: [{ request: ExportRequest }, SplitReport];
  /** Make name data from a name sheet; the sheet stays open for its roughs. */
  import_project: [{ path: string }, ImportResult];
  /** Part of a raster layer of the source sheet, at most `max_height` pixels high, as PNG. */
  rough_image: [{ sheet: string; layerId: number; crop: [number, number, number, number]; maxHeight: number }, ArrayBuffer];
  // project_io.rs
  /** Note an error the front end met (see [`errorlog`]). */
  log_error: [{ message: string }, void];
  /** The project file's text, checked; fields only the app knows stay as they are. */
  load_project: [{ path: string }, Project];
  /**
   * Fields of the project file this version does not know (added by a newer
   * one): kept when saving, but neither shown nor written out here.
   */
  unknown_project_fields: [{ path: string }, string[]];
  /**
   * Check and save the name data; nothing is written when it has problems.
   * The saved state is kept as a version, and the autosave copy is dropped.
   */
  save_project: [RawBody, VersionInfo | null];
  /** The series file's text, checked; fields only the app knows stay as they are. */
  load_series: [{ path: string }, Series];
  /** Check and save a series file; nothing is written when it has problems. */
  save_series: [{ path: string; text: string }, void];
  /**
   * Autosave: write the project file when it has one and `to_file` is on,
   * otherwise a copy that is offered back after a crash; keep a version now
   * and then. A project the check finds problems with still gets its copy
   * (with the problems noted), so work is never left unkept.
   */
  autosave_project: [RawBody, AutosaveResult];
  /** Versions of the project at `path` (or of the unsaved one), newest first. */
  list_versions: [{ path?: string | null }, VersionInfo[]];
  load_version: [{ path?: string | null; id: string }, Project];
  /** Keep the current state as a version (before an older one replaces it). */
  record_version: [RawBody, VersionInfo | null];
  /**
   * Projects autosave kept that were never saved, newest first (those that
   * cannot be read too, with why).
   */
  pending_recoveries: [void, KeptRecovery[]];
  discard_recovery: [{ path?: string | null }, void];
  /** Removes one kept project, by its file name in the recovery folder. */
  remove_recovery: [{ file: string }, void];
  // name_export.rs
  /** Start writing the name data as CSP pages; returns the template's canvas. */
  begin_name_export: [{ request: NameExportRequest }, NameExportStart];
  /**
   * Write the next page from its layer images (raw body, see [`split_body`]),
   * then read it back to check it holds what was sent.
   */
  export_name_page: [RawBody, FileCheck];
  /**
   * Bring the dialogue of the next page (raw body: JSON, then the balloon
   * images) into the page the export wrote there, keeping what was drawn in CSP.
   */
  update_name_dialogue: [RawBody, DialogueUpdateReport];
  /**
   * Read the dialogue of the next page the export wrote (a 見開き page when
   * `spread`), to take what was changed in CSP back into the name.
   */
  read_name_dialogue: [{ spread: boolean }, CspPageDialogue];
  /** Record the dialogue of these pages as CSP has it now as the name's (taken back into it). */
  adopt_name_dialogue: [{ paths: string[] }, void];
  /** Finish: write the work (.cmc) around the pages written so far, and check it. */
  finish_name_export: [void, NameExportReport];
  cancel_name_export: [void, number];
  /** CSP files an export into `out_dir` would overwrite, and which of them were changed after the last export. */
  check_export_target: [{ outDir: string }, OverwriteCheck];
  /**
   * Make the built-in template for `setup` (a page, its parts to copy and a
   * work) in the app's data folder: exports set up in the tool, without a
   * CSP-made template, start from it.
   */
  prepare_builtin_template: [{ setup: PageSetup }, BuiltTemplate];
  // files.rs
  /** Write a PDF of page images (raw body: JSON, then the JPEGs in page order). */
  write_pdf: [RawBody, void];
  /**
   * Write a file the page made (the ミニネーム picture; raw body: JSON with
   * the path, then the bytes).
   */
  write_binary_file: [RawBody, void];
  /**
   * Write a text file (the script) as UTF-8 with a byte order mark, which
   * Windows' Notepad and Excel read as UTF-8.
   */
  write_text_file: [{ path: string; text: string }, void];
  /**
   * Adds `entry` to the record in the export folder `out_dir` (newest last,
   * as a log reads), so what each run changed can be looked at again later,
   * from this app or with Notepad.
   */
  record_dialogue_update: [{ outDir: string; entry: string }, void];
  csp_tool_locations: [void, CspToolLocations];
  /** Pens and erasers of a .sut or of CSP's tool database (read from a copy). */
  read_csp_sub_tools: [{ path: string; materials?: string | null }, SubTool[]];
  csp_tool_stamp: [{ path: string }, CspToolStamp | null];
  /**
   * A brush's CSP settings as a .sut for CSP's ツールの読み込み (CSP names
   * the tool after the file). `materials` is CSP's material folder, where
   * the tips and papers it uses are packed from.
   */
  write_csp_sub_tool: [{ path: string; tool: CspToolData; name: string; materials?: string | null }, WrittenSubTool];
  /**
   * Shows `path` in the computer's file manager: a file in its folder, chosen
   * there (Explorer on Windows); a folder opened. A path that is not there
   * (a save that failed before the file was made) opens the nearest folder
   * above it that is. Only shows: nothing is opened with a program or changed.
   */
  show_in_folder: [{ path: string }, void];
  // fonts.rs
  /** The fonts in the system and user font folders, by name. */
  list_fonts: [void, FontFace[]];
  // lib.rs
  /**
   * Whether this build came from the release workflow. Only those update
   * themselves; a build made on the PC to try a change is left as it is.
   */
  is_release_build: [void, boolean];
  /** When the process began, in ms since 1970. */
  started_at: [void, number];
  safe_look: [void, boolean];
  // updates.rs
  /** Look for a version newer than this one on `channel` ("stable" or "beta"). */
  check_update: [{ channel: "stable" | "beta"; timeoutMs: number }, FoundUpdate | null];
  /** Download and install release `version` (Windows closes the app for the installer). */
  install_release: [{ version: string }, void];
  // lib.rs
  /** The command-line export to run, if the app was started for one. */
  batch_export_task: [void, BatchExport | null];
  /**
   * End a command-line export: close the app with this exit code, saying why
   * on stderr (and in the error log) when it did not go through. The report
   * may be the very thing that could not be written, so this is the one place
   * sure to be seen by whatever ran it.
   */
  end_batch_export: [{ code: number; message?: string | null }, void];
  // attention.rs
  /**
   * Say that a timer came due outside the window. A part that fails (no
   * notifications on this computer) does not stop the others; the first
   * failure is given back to be logged.
   */
  timer_notice: [{ notice: TimerNotice }, void];
  // ai/programs.rs
  /** Which AI tools (and Node, for the Skill's command line) this computer has. */
  ai_detect: [{ claude?: string | null; codex?: string | null }, AiTools];
  // ai/session.rs
  ai_prepare_session: [{ dir?: string | null; files: SessionFile[] }, string];
  /**
   * Put the Skill where Claude Code ("claude": ~/.claude/skills) or Codex
   * ("codex": ~/.agents/skills) finds it for every folder, or into `folder`.
   */
  ai_install_skill: [{ target: "claude" | "codex" | "folder"; folder?: string | null }, string];
  // ai/mod.rs
  /** Start a turn; its events come as `ai-event` with the number this returns. */
  ai_turn: [{ turn: AiTurn }, number];
  /** Stop a turn that is running. */
  ai_stop: [{ run: number }, void];
  // ai/local.rs
  /** Keep the key for a local LLM's API in the system's credential store (none forgets it). */
  ai_save_key: [{ key?: string | null }, void];
  /** Whether a key is kept (the key itself never goes back to the screen). */
  ai_has_key: [void, boolean];
  /** The models a local LLM's API offers (also tells whether it is there). */
  ai_local_models: [{ endpoint: string }, string[]];
  // ai/models.rs
  /**
   * The models Claude Code, Codex or a local LLM offers, as each lists them
   * itself, so that a model or an effort cannot be mistyped.
   */
  ai_models: [{ kind: AiKind; program?: string | null; endpoint?: string | null }, AiModel[]];
  // ai/history.rs
  ai_history_save: [{ talk: unknown }, void];
  ai_history_list: [void, unknown[]];
  ai_history_load: [{ id: string }, unknown];
  ai_history_delete: [{ id: string }, void];
  // dialogs.rs
  /** Ask for a file (or files, or a folder) to open. */
  choose_open: [{ options: OpenOptions }, Picked];
  /** Ask where to save a file. The answer ends in one of the filters' extensions. */
  choose_save: [{ options: SaveOptions }, string | null];
  /**
   * Whether a place was picked in a dialog (now or in an earlier run): what
   * 「前回と同じ設定で書き出す」 asks before it writes there without a dialog.
   */
  place_chosen: [{ path: string }, boolean];
  // lib.rs
  /** Put a palette's window where [`PalettePlace`] says (on whichever display that is). */
  place_palette_window: [{ place: PalettePlace }, void];
  /** Where a palette's window is now (kept, so that it opens there again); none when it is not open. */
  palette_window_rect: [{ title: string }, PaletteRect | null];
}

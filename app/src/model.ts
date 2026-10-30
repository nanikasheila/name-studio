// ネームデータ（正本）の型: the same shapes as crates/name-model/src/model.rs
// (tests/contract.rs checks that they agree). Only types live here, so that
// any module can use them without importing the edits (project.ts, dialogue.ts, panels.ts, …).
// Coordinates are millimetres on the page canvas, origin at its top left.

export type Point = [number, number];

/** `[x0, y0, x1, y1]` in millimetres. */
export type BoxMm = [number, number, number, number];

export type Binding = "right" | "left";

export type LineKind = "speech" | "thought" | "narration" | "sfx" | "aside";

/** 枠線: solid, 太枠, 枠なし, 破線 (flashback), 波線 (dream). */
export type PanelBorder = "solid" | "thick" | "none" | "dashed" | "wavy";

/** 塗り: none lets panels under it show; white covers them (inset panels). */
export type PanelFill = "none" | "white" | "black" | "gray";

/** Background effect: 流線, 集中線, ウニフラ, キラキラ. */
export type PanelEffect = "none" | "speed" | "focus" | "flash" | "sparkle";

/** フキダシの形; "auto" follows the kind of line. */
export type BalloonShape =
  | "auto"
  | "ellipse"
  | "rounded"
  | "box"
  | "polygon"
  | "cloud"
  | "spike"
  | "burst"
  | "wavy"
  | "flash"
  | "electric"
  | "dashed"
  | "none"
  /** An outline imported from CSP, kept as it is in `balloon`. */
  | "custom";

export type TailStyle = "wedge" | "bubbles" | "line" | "zigzag";

/** しっぽ: from the balloon towards the speaker (who may be off the panel). */
export interface Tail {
  tip: Point;
  style?: TailStyle;
  /** 曲がり: how far (mm) the middle of the tail is pushed to its left (negative: right). */
  bend?: number;
  /** 根本: the direction (radians from the balloon's centre, 0 right, π/2 down) where it leaves the balloon; none: towards the tip. */
  root?: number;
}

export interface PageFormat {
  canvasMm: [number, number];
  trimMm: [number, number];
  basicMm: [number, number];
  basicOffsetMm: [number, number];
}

export interface Panel {
  id: string;
  shape: Point[];
  order: number;
  border?: PanelBorder;
  /** Edges not drawn (裁ち切り): edge i runs from shape[i] to shape[i + 1]. */
  openEdges?: number[];
  fill?: PanelFill;
  effect?: PanelEffect;
  /** Stacking order; inset panels (はめ込み) sit above with 1. */
  z?: number;
  /** 演出メモ */
  note?: string;
  /** Where the memo's tag was moved to: its top left from the panel's top left (mm); none: in the panel's corner. */
  noteAt?: Point;
  /** 見開き: shared by the two halves of a panel across the gutter. */
  spread?: string;
  /** 枠線の太さ (mm) of this panel alone; none: the name's for its border (NameStyle). */
  lineMm?: number;
  /** 仮のコマ: laid out roughly (drawn by hand), not decided yet; 整える makes it exact. */
  draft?: boolean;
}

/** はみ出し: an area over the panels where borders and gutters are blanked. */
export interface Breakout {
  id: string;
  shape: Point[];
  note?: string;
}

export interface Line {
  id: string;
  text: string;
  kind: LineKind;
  speaker?: string;
  panel?: string;
  box: BoxMm;
  fontSizePt: number;
  vertical: boolean;
  /** Balloon outline with tails and links merged in (what exports draw). */
  balloon?: Point[];
  balloonShape?: BalloonShape;
  tails?: Tail[];
  /** 連結: joined to this line's balloon. */
  linkTo?: string;
  /** 白抜き: black balloon, white text. */
  inverted?: boolean;
  /** 強調: bold. */
  emphasis?: boolean;
  /** コマ枠でマスク: the balloon is cut off at the border of its panel. */
  mask?: boolean;
  /** フキダシの大きさ: its width and height as shares of the usual size for its text (changed without the text). */
  balloonScale?: [number, number];
  /** フォント for this line alone (as CLIP STUDIO PAINT names it); none: the one for its kind in `Project.fonts`. */
  font?: string;
}

/**
 * `[x, y, pressure]`, or `[x, y, pressure, tilt, speed]` when the brush
 * changes with them; all but x and y are 0..1, tilt 0 is the pen upright.
 */
export type StrokePoint = [number, number, number] | [number, number, number, number, number];

export interface Stroke {
  id: string;
  points: StrokePoint[];
  widthMm: number;
  closed: boolean;
  /** Drawn over the panel borders (in a はみ出し). */
  over?: boolean;
  /** Id of the brush it was drawn with; none is the plain pen. */
  brush?: string;
  /** Start / end left by an eraser: no 入り抜き there. */
  cut?: [boolean, boolean];
  /** The ラフ線のレイヤー it is on (`RoughLayer.id`); none (or one gone) is the first layer. */
  layer?: string;
}

/** ラフ線のレイヤー: rough lines kept apart (人物・背景・効果…), shown, faded and locked together. */
export interface RoughLayer {
  id: string;
  name: string;
  /** Not shown on the page (written to CSP hidden). */
  hidden?: boolean;
  /** 0.1..1; none is 1. */
  opacity?: number;
  /** Not drawn on, erased or picked. */
  locked?: boolean;
  /**
   * 指示のレイヤー: notes and instructions scribbled over the name (for whoever
   * inks it), drawn over everything in `color`, apart from the rough: the pen
   * and the eraser leave them alone, the 指示 tool draws and erases them.
   */
  marks?: boolean;
  /** A 指示のレイヤー's colour (`#rrggbb`); none: red. */
  color?: string;
}

export type BrushKind = "pen" | "eraser";

/** 触れた部分 / 交点まで / 線全体. */
export type EraseMode = "touched" | "intersection" | "whole";

/** `min` at the lightest pressure (or tilt, speed), 1 at the most, along `curve` (control points in 0..1). */
export interface PressureCurve {
  min: number;
  curve?: [number, number][];
}

export interface BrushTip {
  /** White PNG with the tip's coverage in alpha. */
  pngBase64: string;
  width: number;
  height: number;
  /** Stamp spacing in % of the size. */
  interval: number;
  enabled: boolean;
}

/** A pen or eraser, often taken from CLIP STUDIO PAINT (crates/name-model Brush). */
export interface Brush {
  id: string;
  name: string;
  kind: BrushKind;
  sizeMm: number;
  sizePressure?: PressureCurve;
  sizeTilt?: PressureCurve;
  sizeSpeed?: PressureCurve;
  /** Random change along the line (only `min` is used). */
  sizeRandom?: PressureCurve;
  opacity: number;
  opacityPressure?: PressureCurve;
  opacityTilt?: PressureCurve;
  opacitySpeed?: PressureCurve;
  opacityRandom?: PressureCurve;
  hardness: number;
  /** 手ブレ補正, 0..100. */
  stabilization: number;
  /** 速度による手ブレ補正: steadier the faster the pen moves. */
  stabilizationBySpeed?: boolean;
  /** 後補正: smoothing applied once a line is drawn, 0..100. */
  postCorrection?: number;
  taperInMm: number;
  taperOutMm: number;
  /** Width at the very ends of 入り・抜き, 0..1 (CSP's 入り抜き影響先 ブラシサイズ minimum; none: 0). */
  taperMin?: number;
  /** Tip height in % of its width, and its angle in degrees. */
  thickness: number;
  rotation: number;
  tip?: BrushTip;
  erase?: EraseMode;
  source?: string;
  /** The CSP sub tool behind it, every setting as CSP keeps it (see cspsettings.ts). */
  csp?: CspToolData;
}

/** One value of a CSP sub tool setting: a number, text, or bytes in base64. */
export type CspValue = number | string | { blob: string };

/** A material a .sut carried (CSP's `MaterialFile` row), kept to go back with the sub tool. */
export interface CspMaterial {
  originalPath: string;
  catalogPath?: string;
  installFolder?: number;
  /** The material folder as a tar, base64. */
  data: string;
}

/** A CSP sub tool as rows of its tables: the settings (`Variant`), the node and the manager. */
export interface CspToolData {
  settings: Record<string, CspValue>;
  node?: Record<string, CspValue>;
  manager?: Record<string, CspValue>;
  /** Resolution sizes in pixels were turned into mm at. */
  dpi: number;
  materials?: CspMaterial[];
}

export interface RoughImage {
  id: string;
  layerId: number;
  layerName: string;
  sheetCrop: [number, number, number, number];
  box: BoxMm;
}

export interface Page {
  id: string;
  memo: string;
  panels: Panel[];
  lines: Line[];
  strokes: Stroke[];
  roughs: RoughImage[];
  breakouts: Breakout[];
  /** 見開きページ: this page and the next (its facing page) go to CSP as one spread page. */
  joinNext?: boolean;
  /** 付箋: notes stuck on the page while working (never exported). */
  stickies?: Sticky[];
  /** 塗り: areas filled by lasso (ベタ and the like), drawn with the panel fills. */
  fills?: Fill[];
  /** 資料画像: pictures laid faintly under the page (photos, backgrounds, earlier panels). */
  references?: ReferenceImage[];
}

/** 資料画像 on a page: one of the project's pictures, where it lies and how faint. */
export interface ReferenceImage {
  id: string;
  /** Id of the picture in `Project.images`. */
  image: string;
  /** Where it lies on the page (mm). */
  box: BoxMm;
  /** 0–1; none is 0.5. */
  opacity?: number;
  /**
   * "name": the name itself, drawn elsewhere (on paper, in a ミニネーム) and
   * taken in from a picture of it. It is read and written out with the
   * name's own lines (読む, PDF, ミニネーム, its own layer in CSP); a 資料
   * picture is only looked at while drawing.
   */
  kind?: "name";
}

/** A picture kept in the project (resized when it was taken in). */
export interface StoredImage {
  id: string;
  /** The file it came from, to show. */
  name: string;
  mime: "image/jpeg" | "image/png";
  dataBase64: string;
  widthPx: number;
  heightPx: number;
}

export type FillTone = "black" | "gray" | "white";

/** 塗り: an outline filled with one tone (black when none is given). */
export interface Fill {
  id: string;
  shape: Point[];
  /** Holes in it (塗りつぶし round a closed line inside the area). */
  holes?: Point[][];
  tone?: FillTone;
  /** Under the rough lines (as a fill layer under the drawing in CSP); none: over them. */
  under?: boolean;
}

export type StickyColor = "yellow" | "pink" | "blue" | "green";

/** 付箋: a note on the page, at its top-left corner. */
export interface Sticky {
  id: string;
  text: string;
  at: Point;
  color?: StickyColor;
  /** 紐づけ: what the note is about; it points there wherever the note is put. */
  link?: StickyLink;
}

/** A panel or a line a 付箋 is about, and the point on it the note points to (from its top left, mm). */
export interface StickyLink {
  kind: "panel" | "line";
  id: string;
  at: Point;
}

/** A story shape that comes with the app. */
export type BuiltinShapeId = "kishotenketsu" | "threeAct" | "johakyu" | "saveTheCat";

/** 話の型: parts over the pages (by share) and beats at points in them. */
export interface StoryShape {
  id: string;
  label: string;
  parts: ShapePart[];
  /** Turning points (ビート), at 0..1 of the pages. */
  beats?: ShapeBeat[];
}

export interface ShapePart {
  name: string;
  /** Share of the pages; the shares of a shape need not add up to 1. */
  share: number;
  color?: string;
}

export interface ShapeBeat {
  name: string;
  at: number;
}

/** コマ間 (mm): between panels side by side (左右) and one above the other (上下). */
export interface Gutters {
  across: number;
  down: number;
}

/** 構成補助: what the name is aimed at. */
export interface Plan {
  targetPages?: number;
  /** Id of a built-in shape or of one in `shapes`. */
  structure?: string;
  /** オリジナルの型 made for this name. */
  shapes?: StoryShape[];
}

export interface Character {
  id: string;
  name: string;
  color?: string;
  /** 口調のメモ: how the character talks. */
  tone?: string;
}

export interface Scene {
  id: string;
  title: string;
  summary: string;
  firstPage: string;
  lastPage: string;
  storyTime?: string;
  storyOrder?: number;
}

export interface EmotionPoint {
  character: string;
  page: string;
  value: number;
  note: string;
}

export interface SourceSheet {
  path: string;
  resolution: number;
  cells: [number, number, number, number][];
}

export interface Project {
  formatVersion: number;
  title: string;
  storyIndex?: number;
  author: string;
  binding: Binding;
  pageFormat: PageFormat;
  pages: Page[];
  characters: Character[];
  scenes: Scene[];
  emotions: EmotionPoint[];
  source?: SourceSheet;
  brushes: Brush[];
  /** 別案: other versions of runs of pages, kept to compare and switch to. */
  alternatives?: Alternatives[];
  /** 構成補助: the aimed page count and story shape. */
  plan?: Plan;
  /** 作品ごとのフキダシの既定: the shape new lines of each kind get. */
  lineShapes?: Partial<Record<LineKind, BalloonShape>>;
  /** 保留コマ: panels taken off the pages until it is decided where they go. */
  held?: HeldPanel[];
  /** Pictures the pages' 資料画像 show. */
  images?: StoredImage[];
  /** コマ間: the gaps new panels get (cuts, panel patterns); none is DEFAULT_GUTTERS. */
  gutters?: Gutters;
  /** 縦スクロール (Webtoon): the pages are pieces (区切り) of one tall strip, read top to bottom, with no spreads. */
  scroll?: boolean;
  /** 用途ごとのフォント: the typeface each kind of line (and 強調) is set in. */
  fonts?: LineFonts;
  /** 作品の既定: sizes and line widths new things get (and borders without their own width). */
  style?: NameStyle;
  /** CSP のページ設定: what CSP pages are made with when no CSP-made template is chosen; none: from the name's page (csppage.ts). */
  cspPage?: CspPage;
  /** ラフ線のレイヤー, bottom first; none is one layer (ROUGH_BASE). */
  roughLayers?: RoughLayer[];
  /** シリーズ: the series file this name belongs to, from the name's folder ("/" between folders); the name keeps a copy of what is shared. */
  series?: string;
  nextId: number;
}

/** シリーズ: several names (話) of one work sharing characters, brushes, fonts, look and CSP page settings. */
export interface Series {
  formatVersion: number;
  title: string;
  author: string;
  /** In story order. */
  episodes: SeriesEpisode[];
  shared: SeriesShared;
}

export interface SeriesEpisode {
  /** The name's file, from the series file's folder ("/" between folders). */
  path: string;
  title: string;
  storyIndex?: number;
  pages: number;
}

export interface SeriesShared {
  characters: Character[];
  brushes: Brush[];
  fonts?: LineFonts;
  style?: NameStyle;
  cspPage?: CspPage;
  lineShapes?: Partial<Record<LineKind, BalloonShape>>;
  gutters?: Gutters;
  roughLayers?: RoughLayer[];
}

/**
 * CSP のページ設定 (lengths in mm): the CLIP STUDIO PAINT page a name is
 * written out on without a CSP-made template. The name's basic frame is
 * fitted to this page's.
 */
export interface CspPage {
  /** キャンバス (用紙). */
  canvasMm: [number, number];
  /** 仕上がり (製本). */
  trimMm: [number, number];
  /** 裁ち落とし幅. */
  bleedMm: number;
  /** 基本枠 and its offset from the middle. */
  basicMm: [number, number];
  basicOffsetMm: [number, number];
  /** 解像度 (dpi). */
  resolution: number;
  /** Whether the first page is a left page; none: as the binding has it (a manga's on the left). */
  firstPageLeft?: boolean;
  /** ノンブルの開始番号; none: 1. */
  nombreStart?: number;
  /** 作品情報・ノンブルのフォント (as CSP names it); none: the built-in one (ＭＳ ゴシック). */
  font?: string;
  /** 縦スクロール: the pieces joined one under the other into tall pages (as many as CSP's largest side holds) rather than a page each. */
  joinPieces?: boolean;
  /** 作品情報・ノンブルの残りの設定 (CSP の作品基本設定); none: CSP's defaults (作品名 左下, 作者名 下, ページ番号なし, 隠しノンブル). */
  story?: CspStory;
}

/** Where a 作品情報 text goes under the 仕上がり: 左下・下・右下. */
export type StoryPosition = "left" | "center" | "right";

/** CSP's 作品情報 and ノンブル settings besides 作品名・話数・作者名. */
export interface CspStory {
  /** サブタイトル, after 作品名 and 話数. */
  subtitle?: string;
  /** none: left. */
  titlePosition?: StoryPosition;
  /** none: center. */
  authorPosition?: StoryPosition;
  /** ページ番号 in the 作品情報 (`7ページ`) from `start`; none: not shown. Its position, none: right. */
  pageNumber?: { start: number; position?: StoryPosition };
  /** A ノンブル printed on the page in place of the hidden one (at the binding edge, in the bleed). */
  nombre?: ShownNombre;
}

/** Where a shown ノンブル goes: above or below the 基本枠, on the binding side (内側), in the middle or the other side (外側). */
export type NombrePlace = "top-inner" | "top" | "top-outer" | "bottom-inner" | "bottom" | "bottom-outer";

export interface ShownNombre {
  place: NombrePlace;
  /** 白 rather than 黒. */
  white?: boolean;
  /** フチ width (mm); none: no フチ. */
  edgeMm?: number;
  /** フォーマット: the text before and after the number. */
  prefix?: string;
  suffix?: string;
  /** 基本枠との間隔 (mm): 横 (inwards), 縦; none: [0, 5]. */
  offsetMm?: [number, number];
  /** サイズ (pt); none: 9. */
  sizePt?: number;
}

/** 作品の既定: the sizes and line widths a name draws with; none: the app's (style.ts). */
export interface NameStyle {
  /** 文字の大きさ (pt) new lines of each kind get. */
  fontPt?: Partial<Record<LineKind, number>>;
  /** 枠線の太さ (mm) of plain, dashed and wavy borders. */
  panelLineMm?: number;
  /** 太枠の太さ (mm). */
  thickLineMm?: number;
  /** フキダシの線の太さ (mm). */
  balloonLineMm?: number;
  /** セリフの行間: the pitch of lines (columns in 縦書き) in percent of the font size, as CSP's 行間. */
  lineSpacing?: number;
}

/** What a font is chosen for: each kind of line, and lines marked 強調. */
export type FontRole = LineKind | "emphasis";

/** Font names (as CLIP STUDIO PAINT shows them) by role; none: the usual one (セリフ's, else the app's). */
export type LineFonts = Partial<Record<FontRole, string>>;

/**
 * 別案: versions of the same run of pages (a page, a 見開き, a scene). The
 * option in use has its pages in `Project.pages`; the others keep theirs here.
 */
export interface Alternatives {
  id: string;
  /** Pages of the option in use, as they are in the project. */
  pageIds: string[];
  /** Id of the option in use. */
  active: string;
  options: AlternativeOption[];
}

export interface AlternativeOption {
  id: string;
  name: string;
  /** The option's pages while another option is in use (empty for the one in use). */
  pages: Page[];
}

/** 保留コマ: a panel taken off its page with what is in it (see hold.ts). */
export interface HeldPanel {
  id: string;
  /** The panel and what it holds, where they were on the page they came from (mm). */
  panel: Panel;
  lines: Line[];
  strokes: Stroke[];
  fills?: Fill[];
  stickies?: Sticky[];
  /** このあたり: the page it is meant to go near. */
  near?: string;
  /** The page it was taken from. */
  from?: string;
  /** 欄外: laid beside page `near` (the top left of its panel's box, mm on that page, off the page); none: only in the 保留 list. */
  at?: Point;
}

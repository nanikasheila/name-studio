// Generated from crates/name-model (cargo test -p name-model --features ts --test typescript). Do not edit.
// app/src/modelcheck.ts checks it against model.ts.

export type StrokePoint = [number, number, number] | [number, number, number, number, number];

export type Project = { formatVersion: number, title: string, storyIndex?: number, author: string, binding: Binding, pageFormat: PageFormat, pages: Array<Page>, characters: Array<Character>, scenes: Array<Scene>, emotions: Array<EmotionPoint>, source?: SourceSheet, 
/**
 * Pens and erasers the strokes are drawn with (often taken from CSP).
 */
brushes: Array<Brush>, 
/**
 * 別案: other versions of runs of pages, kept to compare and switch to.
 */
alternatives: Array<Alternatives>, 
/**
 * 構成補助: the aimed page count and story shape.
 */
plan?: Plan, 
/**
 * 作品ごとのフキダシの既定: the shape new lines of each kind get.
 */
lineShapes?: LineShapes, 
/**
 * 保留コマ: panels taken off the pages until it is decided where they go.
 */
held: Array<HeldPanel>, 
/**
 * 資料画像: pictures laid under pages ([`Page::references`]), each kept once.
 */
images: Array<StoredImage>, 
/**
 * コマ間: the gaps new panels get (cuts, panel patterns); none is the default 2 mm / 6 mm.
 */
gutters?: Gutters, 
/**
 * 縦スクロール (Webtoon): the pages are pieces of one tall strip, read
 * top to bottom, with no spreads.
 */
scroll?: boolean, 
/**
 * 用途ごとのフォント: the typeface each kind of line (and 強調) is set in.
 */
fonts?: LineFonts, 
/**
 * 作品の既定: sizes and line widths new things get (and borders without their own width).
 */
style?: NameStyle, 
/**
 * CSP のページ設定: the CSP page the name is written out on when no
 * CSP-made template is chosen; none: from the name's page.
 */
cspPage?: CspPage, 
/**
 * ラフ線のレイヤー, bottom first; none is one layer.
 */
roughLayers: Array<RoughLayer>, 
/**
 * シリーズ: the series file this name belongs to, from the name's folder
 * (`/` between folders). The name keeps its own copy of what is shared.
 */
series?: string, 
/**
 * Next number used by [`Project::new_id`]; ids are never reused.
 */
nextId: number, };

export type HeldPanel = { id: string, panel: Panel, lines: Array<Line>, strokes: Array<Stroke>, fills: Array<Fill>, stickies: Array<Sticky>, 
/**
 * このあたり: the page it is meant to go near.
 */
near?: string, 
/**
 * The page it was taken from.
 */
from?: string, 
/**
 * 欄外: laid beside page `near` (the top left of its panel's box, mm on
 * that page, off the page); none: only in the 保留 list.
 */
at?: [number, number], };

export type Alternatives = { id: string, 
/**
 * Pages of the option in use, as they are in the project.
 */
pageIds: Array<string>, 
/**
 * Id of the option in use.
 */
active: string, options: Array<AlternativeOption>, };

export type AlternativeOption = { id: string, name: string, 
/**
 * The option's pages while another option is in use (empty for the one in use).
 */
pages: Array<Page>, };

export type Binding = "right" | "left";

export type PageFormat = { 
/**
 * The page canvas (A3 in the user's manuscripts).
 */
canvasMm: [number, number], 
/**
 * 仕上がり枠 (trim), centred on the canvas.
 */
trimMm: [number, number], 
/**
 * 基本枠 (basic frame), centred on the canvas and moved by `basic_offset_mm`.
 */
basicMm: [number, number], basicOffsetMm: [number, number], };

export type Page = { id: string, memo: string, panels: Array<Panel>, lines: Array<Line>, strokes: Array<Stroke>, roughs: Array<RoughImage>, 
/**
 * はみ出し: areas drawn over the panels (a figure or effect breaking out
 * of its panel). Panel borders and gutters under them are blanked.
 */
breakouts: Array<Breakout>, 
/**
 * 見開きページ: this page and the next (its facing page) go to CSP as
 * one spread page.
 */
joinNext: boolean, 
/**
 * 付箋: notes stuck on the page while working (never exported).
 */
stickies: Array<Sticky>, 
/**
 * 投げなわ塗り: areas filled with one tone (ベタ and the like).
 */
fills: Array<Fill>, 
/**
 * 資料画像: photos or backgrounds laid faintly under the page to draw over.
 */
references: Array<ReferenceImage>, };

export type ReferenceImage = { id: string, image: string, box: [number, number, number, number], 
/**
 * How strongly it shows (0–1); none is half.
 */
opacity?: number, 
/**
 * "name": the name itself, taken in from a picture of it (a ミニネーム
 * or a page drawn on paper), written out with the name's own lines.
 */
kind?: string, };

export type StoredImage = { id: string, name: string, 
/**
 * "image/jpeg" or "image/png".
 */
mime: string, dataBase64: string, widthPx: number, heightPx: number, };

export type Fill = { id: string, shape: Array<[number, number]>, 
/**
 * "gray" or "white"; none is black (ベタ).
 */
tone?: string, };

export type Sticky = { id: string, text: string, at: [number, number], color?: string, 
/**
 * 紐づけ: the panel or line the note is about; it points there wherever
 * the note is put.
 */
link?: StickyLink, };

export type StickyLink = { 
/**
 * "panel" or "line".
 */
kind: string, id: string, at: [number, number], };

export type Gutters = { across: number, down: number, };

export type LineFonts = { speech?: string, thought?: string, narration?: string, sfx?: string, aside?: string, emphasis?: string, };

export type NameStyle = { 
/**
 * 文字の大きさ (pt) new lines of each kind get.
 */
fontPt?: KindSizes, 
/**
 * 枠線の太さ (mm) of plain, dashed and wavy borders.
 */
panelLineMm?: number, 
/**
 * 太枠の太さ (mm).
 */
thickLineMm?: number, 
/**
 * フキダシの線の太さ (mm).
 */
balloonLineMm?: number, 
/**
 * セリフの行間 (% of the font size), as CSP's 行間.
 */
lineSpacing?: number, };

export type CspPage = { canvasMm: [number, number], trimMm: [number, number], bleedMm: number, basicMm: [number, number], basicOffsetMm: [number, number], resolution: number, 
/**
 * None: as the binding has it (a manga's first page on the left).
 */
firstPageLeft?: boolean, nombreStart?: number, 
/**
 * 作品情報・ノンブルのフォント, as CSP names it.
 */
font?: string, 
/**
 * 縦スクロール: the pieces joined one under the other into tall pages.
 */
joinPieces?: boolean, 
/**
 * The rest of CSP's 作品情報 and ノンブル settings; none: CSP's defaults.
 */
story?: CspStory, };

export type StoryPosition = "left" | "center" | "right";

export type CspStory = { subtitle?: string, titlePosition?: StoryPosition, authorPosition?: StoryPosition, 
/**
 * ページ番号 in the 作品情報.
 */
pageNumber?: StoryPageNumber, 
/**
 * A ノンブル printed on the page rather than the hidden one.
 */
nombre?: ShownNombre, };

export type StoryPageNumber = { start: number, position?: StoryPosition, };

export type NombrePlace = "top-inner" | "top" | "top-outer" | "bottom-inner" | "bottom" | "bottom-outer";

export type ShownNombre = { place: NombrePlace, white?: boolean, 
/**
 * フチ (mm).
 */
edgeMm?: number, prefix?: string, suffix?: string, 
/**
 * 基本枠との間隔: 横, 縦.
 */
offsetMm?: [number, number], sizePt?: number, };

export type KindSizes = { speech?: number, thought?: number, narration?: number, sfx?: number, aside?: number, };

export type Plan = { 
/**
 * 目標ページ数.
 */
targetPages?: number, 
/**
 * The shape of the story the page split is held against: a built-in
 * one (起承転結, Save the Cat and the like) or the id of one in `shapes`.
 */
structure?: string, 
/**
 * オリジナルの型 made for this name.
 */
shapes: Array<StoryShape>, };

export type StoryShape = { id: string, label: string, parts: Array<ShapePart>, beats: Array<ShapeBeat>, };

export type ShapePart = { name: string, 
/**
 * Share of the pages; the shares of a shape need not add up to 1.
 */
share: number, color?: string, };

export type ShapeBeat = { name: string, 
/**
 * Where it falls, 0..1 of the pages.
 */
at: number, };

export type Panel = { id: string, shape: Array<[number, number]>, order: number, border: PanelBorder, 
/**
 * Edges not drawn: edge `i` runs from `shape[i]` to `shape[i + 1]`.
 */
openEdges: Array<number>, fill: PanelFill, effect: PanelEffect, 
/**
 * Stacking order; higher is drawn later (on top). Inset panels use 1.
 */
z: number, 
/**
 * 演出メモ: camera, timing or what the panel is for.
 */
note: string, 
/**
 * Where the memo's tag was moved to: its top left from the top left of
 * the panel's bounds (mm); none: in the panel's corner. Screen only.
 */
noteAt?: [number, number], 
/**
 * 見開き: shared by the two halves of a panel across the gutter, one on
 * each page of the spread.
 */
spread: string, 
/**
 * 枠線の太さ (mm) of this panel alone; none: the name's for its border.
 */
lineMm?: number, 
/**
 * 仮のコマ: laid out roughly (drawn by hand) and not decided yet;
 * 整える makes it exact. Exported like any panel.
 */
draft: boolean, };

export type PanelBorder = "solid" | "thick" | "none" | "dashed" | "wavy";

export type PanelFill = "none" | "white" | "black" | "gray";

export type PanelEffect = "none" | "speed" | "focus" | "flash" | "sparkle";

export type Breakout = { id: string, shape: Array<[number, number]>, note: string, };

export type LineKind = "speech" | "thought" | "narration" | "sfx" | "aside";

export type LineShapes = { speech?: BalloonShape, thought?: BalloonShape, narration?: BalloonShape, sfx?: BalloonShape, aside?: BalloonShape, };

export type BalloonShape = "auto" | "ellipse" | "rounded" | "box" | "polygon" | "cloud" | "spike" | "burst" | "wavy" | "flash" | "electric" | "dashed" | "none" | "custom";

export type TailStyle = "wedge" | "bubbles" | "line" | "zigzag";

export type Tail = { tip: [number, number], style: TailStyle, 
/**
 * 曲がり: how far (mm) the middle of the tail is pushed to its left.
 */
bend?: number, 
/**
 * 根本: the direction (radians from the balloon's centre, 0 right, π/2
 * down) where it leaves the balloon; none is towards the tip.
 */
root?: number, };

export type Line = { id: string, text: string, kind: LineKind, speaker?: string, panel?: string, box: [number, number, number, number], fontSizePt: number, vertical: boolean, 
/**
 * Balloon outline without tails and links, when the line has one. Made
 * from `balloon_shape` by the editor; kept as is for `Custom`.
 */
balloon?: Array<[number, number]>, balloonShape: BalloonShape, tails: Array<Tail>, 
/**
 * 連結: the line whose balloon this one is joined to (same speaker).
 */
linkTo?: string, 
/**
 * 白抜き: black balloon (or none on a black panel) with white text.
 */
inverted: boolean, 
/**
 * 強調: bold type.
 */
emphasis: boolean, 
/**
 * コマ枠でマスク: the balloon is cut off at the border of its panel.
 */
mask: boolean, 
/**
 * フキダシの大きさ: its width and height as shares of the usual size
 * for its text, when changed without the text.
 */
balloonScale?: [number, number], 
/**
 * フォント for this line alone (as CLIP STUDIO PAINT names it); none
 * is the one for its kind in [`Project::fonts`].
 */
font?: string, };

export type Stroke = { id: string, points: StrokePoint[], widthMm: number, closed: boolean, 
/**
 * Drawn over the panel borders (inside a はみ出し), not under them.
 */
over: boolean, 
/**
 * [`Brush::id`] of the pen it was drawn with; none is the plain pen.
 */
brush?: string, 
/**
 * Whether the start / end was left by an eraser (no 入り抜き there).
 */
cut?: [boolean, boolean], 
/**
 * The [`RoughLayer`] it is on; none (or one gone) is the first layer.
 */
layer?: string, };

export type RoughLayer = { id: string, name: string, 
/**
 * Not shown on the page (written to CSP hidden).
 */
hidden?: boolean, 
/**
 * 0.1..1; none is 1.
 */
opacity?: number, 
/**
 * Not drawn on, erased or picked.
 */
locked?: boolean, 
/**
 * 指示のレイヤー: notes scribbled over the name for whoever inks it,
 * drawn over everything in `color` and kept apart from the rough.
 */
marks?: boolean, 
/**
 * A 指示のレイヤー's colour (`#rrggbb`); none: red.
 */
color?: string, };

export type BrushKind = "pen" | "eraser";

export type EraseMode = "touched" | "intersection" | "whole";

export type PressureCurve = { min: number, curve: Array<[number, number]>, };

export type BrushTip = { pngBase64: string, width: number, height: number, 
/**
 * Stamp spacing in % of the size.
 */
interval: number, 
/**
 * Drawn with the picture; off falls back to a round tip.
 */
enabled: boolean, };

export type Brush = { id: string, name: string, kind: BrushKind, sizeMm: number, sizePressure?: PressureCurve, sizeTilt?: PressureCurve, sizeSpeed?: PressureCurve, 
/**
 * Random change along the line (only `min` is used).
 */
sizeRandom?: PressureCurve, opacity: number, opacityPressure?: PressureCurve, opacityTilt?: PressureCurve, opacitySpeed?: PressureCurve, opacityRandom?: PressureCurve, 
/**
 * 1 is a hard edge.
 */
hardness: number, 
/**
 * 手ブレ補正, 0..100.
 */
stabilization: number, 
/**
 * 速度による手ブレ補正.
 */
stabilizationBySpeed: boolean, 
/**
 * 後補正: smoothing applied once a line is drawn, 0..100 (0: off).
 */
postCorrection: number, 
/**
 * 入り・抜き lengths.
 */
taperInMm: number, taperOutMm: number, 
/**
 * Tip height in % of its width, and its angle in degrees.
 */
thickness: number, rotation: number, tip?: BrushTip, erase?: EraseMode, 
/**
 * Where it came from, e.g. "CSP: ペン / 丸ペン".
 */
source?: string, };

export type RoughImage = { id: string, layerId: number, layerName: string, 
/**
 * Crop of the sheet, in sheet pixels.
 */
sheetCrop: [number, number, number, number], 
/**
 * Where the crop lands on the page, in millimetres.
 */
box: [number, number, number, number], };

export type Character = { id: string, name: string, color?: string, 
/**
 * 口調のメモ: how the character talks, to keep the dialogue in voice.
 */
tone?: string, };

export type Scene = { id: string, title: string, summary: string, firstPage: string, lastPage: string, 
/**
 * Label of when the scene happens in the story (e.g. "1日目 朝").
 */
storyTime?: string, 
/**
 * Sort key in story time; differs from page order for flashbacks.
 */
storyOrder?: number, };

export type EmotionPoint = { character: string, page: string, value: number, note: string, };

export type SourceSheet = { path: string, resolution: number, 
/**
 * Sheet pixels of each page cell, in page order.
 */
cells: Array<[number, number, number, number]>, };

export type Series = { formatVersion: number, title: string, author: string, 
/**
 * The names of the series, in story order.
 */
episodes: Array<SeriesEpisode>, shared: SeriesShared, };

export type SeriesEpisode = { 
/**
 * The name's file, from the series file's folder (`/` between folders).
 */
path: string, title: string, storyIndex?: number, pages: number, };

export type SeriesShared = { characters: Array<Character>, brushes: Array<Brush>, fonts?: LineFonts, style?: NameStyle, cspPage?: CspPage, lineShapes?: LineShapes, gutters?: Gutters, roughLayers: Array<RoughLayer>, };

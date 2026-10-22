// Shapes returned by the Rust side (src-tauri/src/sheet.rs). Canvas pixels.

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageCell {
  index: number;
  rect: Rect;
  frame: Rect | null;
  spread_side: "left" | "right" | null;
}

export interface VectorView {
  points: [number, number][];
  closed: boolean;
  brushSize: number;
}

export interface TextView {
  text: string;
  bbox: [number, number, number, number] | null;
  fontSizePx: number;
  fontName: string | null;
  vertical: boolean;
  inBalloon: boolean;
  /** Ink colour; white for 白抜き. */
  color?: string;
  bold?: boolean;
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
  pixelOrigin: [number, number];
  pixelSize: [number, number] | null;
  vectors: VectorView[];
  texts: TextView[];
}

export interface SheetView {
  path: string;
  fileName: string;
  canvas: { widthPx: number; heightPx: number; resolution: number; isDoublePage: boolean };
  cells: PageCell[];
  layers: LayerView[];
  warnings: string[];
}

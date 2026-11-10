// Shapes returned by the Rust side (src-tauri/src/sheet.rs). Canvas pixels.
// They are generated from the Rust source (generated/ipc.ts); here are the
// names the viewer knows them by, and what the app adds for its own drawing.
import type { LayerView as SheetLayer, TextView as SheetText } from "../generated/ipc";

export type { PageCell, Rect, SheetView, VectorView } from "../generated/ipc";

/** A text to draw: as the sheet has it, or made from the name's dialogue (with how it looks). */
export interface TextView extends SheetText {
  /** Ink colour; white for 白抜き. */
  color?: string;
  bold?: boolean;
  /** Line pitch as a multiple of the font size (1.15 when not given). */
  pitch?: number;
}

/** A layer to draw: the sheet's, or one made from the name. */
export interface LayerView extends Omit<SheetLayer, "texts"> {
  texts: TextView[];
}

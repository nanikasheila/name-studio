// The tools of the page editor: what a press does with each, and how each
// kind of drag goes on and ends. A new tool or drag must be added here (the
// types say so).
import type { DragHandler, EditorCore, Press, Tool, ToolDrag } from "./editorcore";
import { ERASER_DRAGS, pressEraser } from "./tooleraser";
import { FILL_DRAGS, pressBreakout, pressFill } from "./toolfill";
import { PANEL_DRAGS, pressCut } from "./toolpanels";
import { PEN_DRAGS, pressPen } from "./toolpen";
import { REFERENCE_DRAGS, pressReference } from "./toolreference";
import { SELECT_DRAGS, pressSelect } from "./toolselect";
import { STICKY_DRAGS, pressSticky } from "./toolsticky";
import { pressText } from "./tooltext";
import { TRANSFORM_DRAGS } from "./tooltransform";

export const PRESS: Record<Tool, (editor: EditorCore, press: Press) => void> = {
  select: pressSelect,
  cut: pressCut,
  text: pressText,
  pen: pressPen,
  eraser: pressEraser,
  fill: pressFill,
  breakout: pressBreakout,
  sticky: pressSticky,
  reference: pressReference,
};

const DRAGS: {
  [K in ToolDrag["kind"]]: DragHandler<Extract<ToolDrag, { kind: K }>>;
} = {
  ...SELECT_DRAGS,
  ...TRANSFORM_DRAGS,
  ...PANEL_DRAGS,
  ...PEN_DRAGS,
  ...ERASER_DRAGS,
  ...FILL_DRAGS,
  ...STICKY_DRAGS,
  ...REFERENCE_DRAGS,
};

/** The handler of a drag. */
export function dragHandler<D extends ToolDrag>(drag: D): DragHandler<D> {
  return DRAGS[drag.kind] as unknown as DragHandler<D>;
}

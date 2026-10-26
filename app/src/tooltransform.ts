// 変形 (Ctrl+T) with the select tool: the frame's squares scale what is
// selected (the far side staying, or the middle with Alt), the round handle
// turns it, Ctrl + a corner warps it.
import { FRAME_HANDLES, type DragHandler, type DragOf, type EditorCore, type Press } from "./editorcore";
import type { Point, Project } from "./model";
import { assignPanels, orderPanels, sortLines } from "./readingorder";
import { NO_TARGETS } from "./snapping";
import { rotation, scaling, transformBase, transformItems, type Affine } from "./transform";

/** A press on the transform frame starts scaling, turning or warping; false when it is not on the frame. */
export function pressFrame(editor: EditorCore, { event, project, point, sx, sy }: Press): boolean {
  const handle = editor.frameHandleAt(sx, sy);
  if (handle < 0) return false;
  const frame = editor.frameGeometry()!;
  const items = editor.selectedItems();
  // A balloon on its own grows with its text, or (as set) changes alone around it.
  const lone = editor.selection?.kind === "line" ? (editor.balloonTextFollows ? "withText" : "balloonOnly") : undefined;
  const base = transformBase(frame.slot.page, items, lone);
  editor.host.begin();
  if (handle < 4 && (event.ctrlKey || event.metaKey)) {
    const [x0, y0, x1, y1] = frame.box;
    const corners: [Point, Point, Point, Point] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    editor.startDrag({
      kind: "warp",
      slot: frame.slot,
      handle,
      base,
      box: frame.box,
      corners,
      moved: false,
    });
  } else if (handle === FRAME_HANDLES) {
    const [x0, y0, x1, y1] = frame.box;
    const centre: Point = [(x0 + x1) / 2, (y0 + y1) / 2];
    editor.startDrag({
      kind: "rotate",
      slot: frame.slot,
      base,
      centre,
      start: Math.atan2(point[1] - centre[1], point[0] - centre[0]),
      moved: false,
    });
  } else {
    // Panels' sides snap as they are pulled.
    const panelIds = base.panels?.map((panel) => panel.id) ?? [];
    const targets = panelIds.length ? editor.snapTargetsOn(project, frame.slot.page, panelIds) : NO_TARGETS;
    editor.startDrag({
      kind: "scale",
      slot: frame.slot,
      handle,
      base,
      box: frame.box,
      moved: false,
      targets,
    });
  }
  return true;
}

/** Scale from the handle being dragged: the far side stays (the centre with Alt). */
export function scaleFor(drag: DragOf<"scale">, point: Point, free: boolean, fromCentre: boolean): Affine {
  const [x0, y0, x1, y1] = drag.box;
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const at: Point[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [cx, y0],
    [x1, cy],
    [cx, y1],
    [x0, cy],
  ];
  const handle = at[drag.handle];
  const anchor: Point = fromCentre ? [cx, cy] : at[drag.handle < 4 ? (drag.handle + 2) % 4 : 4 + ((drag.handle - 2) % 4)];
  const ratio = (i: 0 | 1) => {
    const span = handle[i] - anchor[i];
    return Math.abs(span) < 1e-6 ? 1 : Math.max(0.05, (point[i] - anchor[i]) / span);
  };
  if (drag.handle >= 4) return drag.handle % 2 === 0 ? scaling(1, ratio(1), anchor) : scaling(ratio(0), 1, anchor);
  if (free) return scaling(ratio(0), ratio(1), anchor);
  // Corners keep the proportions: how far along the diagonal the pointer is.
  const [hx, hy] = [handle[0] - anchor[0], handle[1] - anchor[1]];
  const s = Math.max(0.05, ((point[0] - anchor[0]) * hx + (point[1] - anchor[1]) * hy) / (hx * hx + hy * hy || 1));
  return scaling(s, s, anchor);
}

/**
 * The point a transform handle is pulled to, snapped so that the panels'
 * side (inside the frame's padding) lands on a line.
 */
function snappedHandle(editor: EditorCore, drag: DragOf<"scale">, point: Point, free: boolean): Point {
  if (drag.targets === NO_TARGETS) return point;
  const pad = 3 / drag.slot.scale;
  // Which way each axis of the handle is from the frame's middle: the padding is outward that way.
  const side = (
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as Point[]
  )[drag.handle];
  const edge: Point = [point[0] - side[0] * pad, point[1] - side[1] * pad];
  const snapped = editor.snapped(drag.slot, edge, drag.targets, free);
  // Only the axes the handle pulls show a guide.
  const guides = editor.guides;
  if (guides) {
    if (!side[0]) guides.xs = [];
    if (!side[1]) guides.ys = [];
  }
  return [snapped[0] + side[0] * pad, snapped[1] + side[1] * pad];
}

/** The transformed panels in reading order again, over the gutter as 見開き; lines and contents with their panels. */
function finish(editor: EditorCore, drag: DragOf<"scale" | "warp" | "rotate">, project: Project): void {
  if (!drag.moved) {
    editor.host.cancel();
    return;
  }
  if (drag.base.panels) {
    orderPanels(drag.slot.page, project.binding);
    editor.spanPanels(project, drag.slot.page.id);
  }
  assignPanels(drag.slot.page);
  sortLines(drag.slot.page, editor.binding());
  editor.host.commit();
}

const scale: DragHandler<DragOf<"scale">> = {
  move(editor, drag, { event, point }) {
    const m = scaleFor(drag, snappedHandle(editor, drag, point, event.altKey), event.shiftKey, event.altKey);
    transformItems(drag.slot.page, drag.base, m);
    drag.moved = true;
    editor.host.status(`大きさ ${Math.round(m[0] * 100)}% × ${Math.round(m[3] * 100)}%（Shift で縦横別々、Alt で中心から）`);
  },
  end: finish,
};

const warp: DragHandler<DragOf<"warp">> = {
  move(editor, drag, { point }) {
    drag.corners[drag.handle] = point;
    transformItems(drag.slot.page, drag.base, {
      box: drag.box,
      corners: drag.corners,
    });
    drag.moved = true;
    editor.host.status("自由変形: 角をそれぞれ動かしています（Ctrl を押したまま角をドラッグ）");
  },
  end: finish,
};

const rotate: DragHandler<DragOf<"rotate">> = {
  move(editor, drag, { event, point }) {
    let angle = Math.atan2(point[1] - drag.centre[1], point[0] - drag.centre[0]) - drag.start;
    const step = Math.PI / 12;
    if (event.shiftKey) angle = Math.round(angle / step) * step;
    transformItems(drag.slot.page, drag.base, rotation(angle, drag.centre));
    drag.moved = true;
    const degrees = (((Math.round((angle * 180) / Math.PI) % 360) + 540) % 360) - 180;
    editor.host.status(`${degrees}° 回しています（Shift で 15° ずつ）`);
  },
  end: finish,
};

export const TRANSFORM_DRAGS = { scale, warp, rotate };

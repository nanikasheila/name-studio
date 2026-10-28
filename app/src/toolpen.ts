// The pen: a rough line with the pen's brush (手ブレ補正 as it is drawn,
// 後補正 when it is done), straight with Shift, cut where it crosses onto the
// facing page (or, 連続, onto other pages).
import { FULL_SPEED_MM, followFactor, postCorrect, tiltOf as penTilt, usesMotion } from "./brush";
import type { DragHandler, DragOf, EditorCore, Press } from "./editorcore";

/** A 指示 being drawn: its colour and width, and the 指示のレイヤー it goes on ("": the top one, made if there is none). */
export type PenMark = NonNullable<DragOf<"pen">["mark"]>;
import { toPage } from "./layout";
import { adjustPressure, pressureReading } from "./pen";
import { penPreferences } from "./prefs";
import { insidePolygon } from "./geometry";
import type { StrokePoint } from "./model";
import { addStroke, splitOverPages } from "./strokes";
import { layerOf, markLayerFor, ROUGH_BASE, setRoughLayer } from "./roughlayers";
import { newId } from "./project";
import { densify, straightEnd } from "./transform";

export function pressPen(editor: EditorCore, press: Press): void {
  // A hidden or locked ラフ線のレイヤー is not drawn on.
  const layer = layerOf(press.project, { layer: editor.roughLayer });
  if (layer.hidden || layer.locked) {
    editor.host.status(`レイヤー「${layer.name}」は${layer.hidden ? "隠して" : "ロックして"}います。レイヤーの欄で${layer.hidden ? "目を開ける" : "ロックを外す"}か、ほかのレイヤーを選んでください`);
    return;
  }
  startLine(editor, press);
}

/** A line begins: a rough line with the pen's brush, or (`mark`) a 指示 with the plain pen. */
export function startLine(editor: EditorCore, { event, slot, point }: Press, mark?: PenMark): void {
  // Keep tilt and speed only for brushes that change with them.
  const motion = !mark && usesMotion(editor.brush("pen"));
  const reading = pressureReading(event.pointerType, event.pressure);
  const pressure = usedPressure(reading);
  const first: StrokePoint = motion ? [...point, pressure, tiltOf(event), 0] : [...point, pressure];
  // Shift: a straight line from where the pen went down.
  editor.startDrag({
    kind: "pen",
    slot,
    points: [first],
    last: first,
    motion,
    time: event.timeStamp,
    speed: 0,
    straight: event.shiftKey,
    pressure: reading,
    unread: reading === null ? 1 : 0,
    mark,
  });
  editor.captureBase();
}

const pen: DragHandler<DragOf<"pen">> = {
  move(editor, drag, { event, point, phase }) {
    if (drag.straight) {
      if (phase === "frame") return;
      const [x, y] = straightEnd(drag.points[0], point);
      const pressure = pressureOf(drag, event);
      const end: StrokePoint = drag.motion ? [x, y, pressure, tiltOf(event), 0] : [x, y, pressure];
      drag.points = [drag.points[0], end];
      drag.last = end;
      return;
    }
    // 手ブレ補正: each point moves only part of the way towards the pen (a 指示 follows it as it is).
    const brush = drag.mark ? undefined : editor.brush("pen");
    const events = phase === "frame" ? [] : (event.getCoalescedEvents?.() ?? [event]);
    for (const e of events.length || phase === "frame" ? events : [event]) {
      const [x, y] = toPage(drag.slot, ...editor.at(e));
      const seconds = (e.timeStamp - drag.time) / 1000;
      if (seconds > 0) {
        const speed = Math.hypot(x - drag.last[0], y - drag.last[1]) / seconds / FULL_SPEED_MM;
        // Smoothed: single samples jump about.
        drag.speed += (Math.min(speed, 1) - drag.speed) * 0.3;
        drag.time = e.timeStamp;
      }
      const pressure = pressureOf(drag, e);
      const raw: StrokePoint = drag.motion ? [x, y, pressure, tiltOf(e), drag.speed] : [x, y, pressure];
      const follow = followFactor(brush?.stabilization ?? 0, drag.speed, brush?.stabilizationBySpeed);
      const previous = drag.points[drag.points.length - 1];
      drag.points.push(previous.map((value, i) => value + (raw[i] - value) * follow) as StrokePoint);
      drag.last = raw;
    }
    if (phase !== "raw") drag.ahead = penPreferences.settings.predict ? ahead(editor, drag, event, brush) : undefined;
  },
  end(editor, drag, project) {
    editor.host.begin();
    const brushId = drag.mark ? undefined : editor.brush("pen")?.id;
    if (drag.straight) {
      // Points along the line, so that pressure and 入り抜き work along it.
      drag.points = densify(drag.points);
    } else {
      // The smoothed line catches up with where the pen left the page.
      if (drag.points.length > 1) drag.points.push(drag.last);
      // 後補正: the finished line loses its wobble.
      drag.points = postCorrect(drag.points, (brushId && editor.brush("pen")?.postCorrection) || 0);
    }
    // Begun inside a はみ出し: the line goes over the panel borders.
    const [bx, by] = drag.points[0];
    const over = !drag.mark && drag.slot.page.breakouts.some((breakout) => insidePolygon(breakout.shape, [bx, by]));
    // A line drawn across the gutter (or, 連続, onto other pages) goes onto each page it is over, cut where it crosses.
    const from = drag.slot;
    const slotOf = (index: number) => editor.slots.find((slot) => slot.index === index) ?? from;
    const runs = splitOverPages<number>(
      drag.points,
      from.index,
      ([x, y]) => editor.slotAt(from.x + x * from.scale, from.y + y * from.scale, project)?.index ?? null,
      (a, b) => {
        const [sa, sb] = [slotOf(a), slotOf(b)];
        return editor.facingSlot(sa)?.index === b ? (sa.x + editor.gutterOf(sa, sb) * sa.scale - from.x) / from.scale : null;
      },
    );
    // A 指示 goes on its 指示のレイヤー (made when there is none yet), shown again if it was hidden.
    const layers = project.roughLayers?.length ?? 0;
    const markLayer = drag.mark && markLayerFor(project, drag.mark.layer, () => newId(project, "rough"));
    // A layer made or shown again changes more than the pages: all is drawn again at once.
    const onlyLine = (project.roughLayers?.length ?? 0) === layers && !markLayer?.hidden;
    if (markLayer?.hidden) setRoughLayer(project, markLayer.id, { hidden: false });
    const layer = markLayer ? markLayer.id : layerOf(project, { layer: editor.roughLayer }).id;
    let added = 0;
    for (const [index, run] of runs.entries()) {
      const target = slotOf(run.page);
      const [dx, dy] = [(from.x - target.x) / from.scale, (from.y - target.y) / from.scale];
      const points = run.points.map((p) => [p[0] + dx, p[1] + dy, ...p.slice(2)] as StrokePoint);
      const stroke = addStroke(project, target.page, points, drag.mark?.widthMm ?? editor.penWidthMm, brushId);
      if (!stroke) continue;
      added++;
      if (over && target.index === drag.slot.index) stroke.over = true;
      if (layer !== ROUGH_BASE) stroke.layer = layer;
      const cut: [boolean, boolean] = [index > 0, index < runs.length - 1];
      if (cut[0] || cut[1]) stroke.cut = cut;
    }
    if (added) editor.host.commit(onlyLine);
    else editor.host.cancel();
  },
};

export const PEN_DRAGS = { pen };

/** The pressure a line gets where the pen read none yet (a pen that never reads one draws as a mouse did). */
const UNREAD = 0.5;

/** The pressure a point gets from a reading: the 筆圧カーブ of the tablet settings (the brush's own comes when it is drawn). */
function usedPressure(reading: number | null): number {
  return Math.max(0.05, adjustPressure(penPreferences.settings.pressureCurve, reading ?? UNREAD));
}

/**
 * The pressure of a move during a line: a missed reading keeps the one
 * before it; the first reading of a line that began without one goes back to
 * the points before it too, so the line does not start with a blob or a dot.
 */
function pressureOf(drag: DragOf<"pen">, event: PointerEvent): number {
  const reading = pressureReading(event.pointerType, event.pressure);
  if (reading === null) {
    if (drag.pressure === null) drag.unread++;
    return usedPressure(drag.pressure);
  }
  const pressure = usedPressure(reading);
  if (drag.pressure === null && drag.unread) {
    for (const point of drag.points.slice(0, drag.unread)) point[2] = pressure;
    drag.last[2] = pressure;
    drag.unread = 0;
  }
  drag.pressure = reading;
  return pressure;
}

/** The most of the browser's prediction shown: a few events, this far on screen (px) at most. */
const AHEAD_EVENTS = 3;
const AHEAD_PX = 24;

/** 先読み: the line on through where the pen is predicted to be, smoothed as the line is; not kept. */
function ahead(editor: EditorCore, drag: DragOf<"pen">, event: PointerEvent, brush: ReturnType<EditorCore["brush"]>): StrokePoint[] | undefined {
  const predicted = event.getPredictedEvents?.() ?? [];
  if (!predicted.length) return undefined;
  const points: StrokePoint[] = [];
  let previous = drag.points[drag.points.length - 1];
  const pressure = usedPressure(drag.pressure);
  for (const e of predicted.slice(0, AHEAD_EVENTS)) {
    const [x, y] = toPage(drag.slot, ...editor.at(e));
    if (Math.hypot(x - drag.last[0], y - drag.last[1]) * drag.slot.scale > AHEAD_PX) break;
    const raw: StrokePoint = drag.motion ? [x, y, pressure, tiltOf(e), drag.speed] : [x, y, pressure];
    const follow = followFactor(brush?.stabilization ?? 0, drag.speed, brush?.stabilizationBySpeed);
    previous = previous.map((value, i) => value + (raw[i] - value) * follow) as StrokePoint;
    points.push(previous);
  }
  return points.length ? points : undefined;
}

function tiltOf(event: PointerEvent): number {
  return penPreferences.settings.tilt ? penTilt(event) : 0;
}

// The pen: a rough line with the pen's brush (手ブレ補正 as it is drawn,
// 後補正 when it is done), straight with Shift, cut where it crosses onto the
// facing page (or, 連続, onto other pages).
import { FULL_SPEED_MM, followFactor, postCorrect, tiltOf as penTilt, usesMotion } from "./brush";
import type { DragHandler, DragOf, EditorCore, Press } from "./editorcore";

/** A 指示 being drawn: its colour and width, and the 指示のレイヤー it goes on ("": the top one, made if there is none). */
export type PenMark = NonNullable<DragOf<"pen">["mark"]>;
import { toPage } from "./layout";
import { adjustPressure } from "./pen";
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
  const first: StrokePoint = motion ? [...point, pressureOf(event), tiltOf(event), 0] : [...point, pressureOf(event)];
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
    mark,
  });
  editor.captureBase();
}

const pen: DragHandler<DragOf<"pen">> = {
  move(editor, drag, { event, point }) {
    if (drag.straight) {
      const [x, y] = straightEnd(drag.points[0], point);
      const end: StrokePoint = drag.motion ? [x, y, pressureOf(event), tiltOf(event), 0] : [x, y, pressureOf(event)];
      drag.points = [drag.points[0], end];
      drag.last = end;
      return;
    }
    // 手ブレ補正: each point moves only part of the way towards the pen (a 指示 follows it as it is).
    const brush = drag.mark ? undefined : editor.brush("pen");
    const events = event.getCoalescedEvents?.() ?? [event];
    for (const e of events.length ? events : [event]) {
      const [x, y] = toPage(drag.slot, ...editor.at(e));
      const seconds = (e.timeStamp - drag.time) / 1000;
      if (seconds > 0) {
        const speed = Math.hypot(x - drag.last[0], y - drag.last[1]) / seconds / FULL_SPEED_MM;
        // Smoothed: single samples jump about.
        drag.speed += (Math.min(speed, 1) - drag.speed) * 0.3;
        drag.time = e.timeStamp;
      }
      const raw: StrokePoint = drag.motion ? [x, y, pressureOf(e), tiltOf(e), drag.speed] : [x, y, pressureOf(e)];
      const follow = followFactor(brush?.stabilization ?? 0, drag.speed, brush?.stabilizationBySpeed);
      const previous = drag.points[drag.points.length - 1];
      drag.points.push(previous.map((value, i) => value + (raw[i] - value) * follow) as StrokePoint);
      drag.last = raw;
    }
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
    const markLayer = drag.mark && markLayerFor(project, drag.mark.layer, () => newId(project, "rough"));
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
    if (added) editor.host.commit();
    else editor.host.cancel();
  },
};

export const PEN_DRAGS = { pen };

function pressureOf(event: PointerEvent): number {
  // Mice report 0.5 while a button is down; treat that as full pressure.
  if (event.pointerType !== "pen") return 1;
  // The 筆圧カーブ of the tablet settings, then the brush's own.
  return Math.max(0.05, adjustPressure(penPreferences.settings.pressureCurve, event.pressure || 0.5));
}

function tiltOf(event: PointerEvent): number {
  return penPreferences.settings.tilt ? penTilt(event) : 0;
}

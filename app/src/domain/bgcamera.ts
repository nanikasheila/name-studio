// 背景の指示 as a camera: where the eye level and the vanishing points fall
// in the picture to be drawn (its pixels), and the camera that puts them
// there (lens, turn, shift or tilt), worked out here so the AI drawing need
// not fit the camera by trying. The camera is a pinhole: its horizon is the
// row level with the eye; a straight edge level on the ground goes to a
// point on that row; two such edges at right angles (a building's two walls)
// go to points u1 and u2 with (u1 − c)(u2 − c) = −(f² + d²), where c is the
// picture's centre, f the focal length and d how far the horizon is from the
// centre (d = f·tan(tilt); 0 for a level camera, which keeps verticals
// upright and moves the horizon with Blender's lens shift instead). With a
// third point (where the uprights meet) the camera looks up or down: the
// principal point is where the heights of the three points' triangle meet,
// and f² = d·e (e: from it to the third point). With one point the camera
// looks straight at it. The points come from the ruler (bgruler.ts).
import type { BoxMm, Panel, Point } from "../model/model";
import { horizonAcross } from "./background";
import { rulerOf } from "./bgruler";

/** Blender's sensor (mm) across the picture's longer side. */
export const SENSOR_MM = 36;
/** The lens taken when the instructions do not fix it (a natural view, 35 mm film). */
export const DEFAULT_LENS_MM = 35;

export interface CameraFit {
  /** The picture, in pixels. */
  width: number;
  height: number;
  /** The horizon's row at the picture's left and right edges (px from the top). */
  horizon: [number, number] | null;
  /** The vanishing points in the picture's pixels (outside it when beyond its edges). */
  vanishing: Point[];
  /** Level (lens shift, verticals upright) or tilted (looking up or down: 3点). */
  mode: "level" | "tilt";
  /** How many vanishing points the ruler has. */
  points: number;
  /** The focal length (px) and as a lens (mm) for Blender's 36 mm sensor; fixed by two points, else the default. */
  focalPx: number;
  lensMm: number;
  /** The lens was worked out from two vanishing points (not taken as the default). */
  lensFromPoints: boolean;
  /** Blender's lens shift (share of the longer side; +y moves the view up, so the horizon down). */
  shiftX: number;
  shiftY: number;
  /** Looking down (+) or up (−), degrees; 0 for a level camera. */
  tiltDeg: number;
  /** The camera's roll (degrees, + turns the picture's horizon clockwise). */
  rollDeg: number;
  /** For each level vanishing point: how far its edges turn from the camera's direction (degrees, + to the right). */
  turnsDeg: (number | null)[];
}

/** The camera for a panel's 背景の指示 in a picture of `box` at `dpi` (none without an eye level). */
export function cameraFit(panel: Panel, box: BoxMm, dpi: number): CameraFit | null {
  const ruler = rulerOf(panel);
  if (!ruler.horizon) return null;
  const scale = dpi / 25.4;
  const width = Math.round((box[2] - box[0]) * scale);
  const height = Math.round((box[3] - box[1]) * scale);
  const toPx = ([x, y]: Point): Point => [(x - box[0]) * scale, (y - box[1]) * scale];
  const [a, b] = horizonAcross(panel, ruler.horizon).map(toPx);
  // The row at the picture's own left and right edges.
  const slope = Math.abs(b[0] - a[0]) < 1e-6 ? 0 : (b[1] - a[1]) / (b[0] - a[0]);
  const rowAt = (x: number) => a[1] + (x - a[0]) * slope;
  const horizon: [number, number] = [rowAt(0), rowAt(width)];
  const vanishing = ruler.vanishing.map(toPx);
  const longer = Math.max(width, height);
  // Along the eye level (s, to the right) and across it (t, downwards), from the picture's centre: the camera's roll taken out.
  const roll = Math.atan(slope);
  const [cos, sin] = [Math.cos(roll), Math.sin(roll)];
  const [cx, cy] = [width / 2, height / 2];
  const s = ([x, y]: Point) => (x - cx) * cos + (y - cy) * sin;
  const t = ([x, y]: Point) => -(x - cx) * sin + (y - cy) * cos;
  const th = t(a);
  const onLine = vanishing.slice(0, 2).map(s);
  // The principal point (where the camera looks), the focal length and the tilt.
  let ps = 0;
  let pt = th;
  let focalPx = (DEFAULT_LENS_MM * longer) / SENSOR_MM;
  let fromPoints = false;
  let tilt = 0;
  if (vanishing.length >= 3) {
    // 3点: the principal point is where the heights of the three points' triangle meet; f² = d·e.
    const [s1, s2] = onLine;
    const [s3, t3] = [s(vanishing[2]), t(vanishing[2])];
    ps = s3;
    pt = th - ((s3 - s1) * (s3 - s2)) / (t3 - th);
    const d = Math.abs(pt - th);
    const e = Math.abs(t3 - pt);
    if (d * e > 1) {
      focalPx = Math.sqrt(d * e);
      fromPoints = true;
    }
    tilt = (t3 > th ? 1 : -1) * Math.atan2(d, focalPx);
  } else if (onLine.length === 2) {
    // 2点: level; the principal point between the points (the picture's middle when they lie either side of it).
    const [u1, u2] = [...onLine].sort((p, q) => p - q);
    ps = u1 < 0 && 0 < u2 ? 0 : (u1 + u2) / 2;
    const product = (ps - u1) * (u2 - ps);
    if (product > 1) {
      focalPx = Math.sqrt(product);
      fromPoints = true;
    }
  } else if (onLine.length === 1) {
    // 1点: the camera looks straight at the point.
    ps = onLine[0];
  }
  const along = Math.cos(tilt);
  const turns = vanishing.map((point, i) => (i < 2 ? (Math.atan2((s(point) - ps) * along, focalPx) * 180) / Math.PI : null));
  const round = (v: number, places = 3) => Math.round(v * 10 ** places) / 10 ** places || 0;
  return {
    width,
    height,
    horizon: [round(horizon[0], 0), round(horizon[1], 0)],
    vanishing: vanishing.map(([x, y]) => [round(x, 0), round(y, 0)]),
    mode: vanishing.length >= 3 ? "tilt" : "level",
    points: Math.min(3, vanishing.length),
    focalPx: round(focalPx, 0),
    lensMm: round((focalPx * SENSOR_MM) / longer, 1),
    lensFromPoints: fromPoints,
    // Blender's shift is in the picture's own axes: the principal point (ps, pt along and across the eye level) is
    // turned back by the roll first. +x moves the view right (the principal point appears left of the middle), +y up.
    shiftX: round(-(ps * cos - pt * sin) / longer),
    shiftY: round((ps * sin + pt * cos) / longer),
    tiltDeg: round((tilt * 180) / Math.PI, 1),
    rollDeg: round((roll * 180) / Math.PI, 1),
    turnsDeg: turns.map((turn) => (turn === null ? null : round(turn, 1))),
  };
}

const px = (v: number) => `${Math.round(v)}px`;

/** The camera in words for 依頼.md, a line each. */
export function cameraWords(fit: CameraFit): string[] {
  const [left, right] = fit.horizon ?? [0, 0];
  const out = [
    `画像の中のアイレベル: 上から ${px((left + right) / 2)}${Math.abs(left - right) >= 2 ? `（左端 ${px(left)} → 右端 ${px(right)}）` : ""}（画像 ${fit.width}×${fit.height}px）`,
  ];
  fit.vanishing.forEach(([x, y], i) => {
    const outside = x < 0 || y < 0 || x > fit.width || y > fit.height ? "、画像の外" : "";
    const turn = fit.turnsDeg[i];
    const way =
      turn === null
        ? "（縦の線が集まる点）"
        : fit.points === 1
          ? "。カメラはこの点をまっすぐ向く（奥へ向かう水平の線がここに集まり、横の線は水平のまま）"
          : `。そこへ向かう水平の線は、カメラの向きから ${turn >= 0 ? "右" : "左"}へ ${Math.abs(turn)}°`;
    out.push(`画像の中の消失点 ${i + 1}: (${px(x)}, ${px(y)})${outside}${way}`);
  });
  const lens = fit.lensFromPoints
    ? `レンズ ${fit.lensMm}mm（センサー ${SENSOR_MM}mm、${fit.points} つの消失点から決まる。焦点距離 ${fit.focalPx}px）`
    : `レンズ ${fit.lensMm}mm（決まっていないので仮。ラフの人物の大きさに合わせて変えてよい）`;
  out.push(
    fit.mode === "level"
      ? `カメラ（計算済み）: 水平（縦の線はまっすぐ）、${lens}、レンズシフト X ${fit.shiftX}・Y ${fit.shiftY}${fit.rollDeg ? `、傾き（ロール）${fit.rollDeg}°` : ""}。カメラの高さ＝アイレベルの高さ`
      : `カメラ（計算済み）: ${fit.tiltDeg >= 0 ? "見下ろし" : "見上げ"} ${Math.abs(fit.tiltDeg)}°、${lens}、レンズシフト X ${fit.shiftX}・Y ${fit.shiftY}${fit.rollDeg ? `、傾き（ロール）${fit.rollDeg}°` : ""}`,
  );
  return out;
}

// 背景の指示 as a camera: where the eye level and the vanishing points fall
// in the picture to be drawn (its pixels), and the camera that puts them
// there (lens, turn, shift or tilt), worked out here so the AI drawing need
// not fit the camera by trying. The camera is a pinhole: its horizon is the
// row level with the eye; a straight edge level on the ground goes to a
// point on that row; two such edges at right angles (a building's two walls)
// go to points u1 and u2 with (u1 − c)(u2 − c) = −(f² + d²), where c is the
// picture's centre, f the focal length and d how far the horizon is from the
// centre (d = f·tan(tilt); 0 for a level camera, which keeps verticals
// upright and moves the horizon with Blender's lens shift instead).
import type { BoxMm, Panel, Point } from "../model/model";
import { backgroundOf, horizonAcross } from "./background";

/** Blender's sensor (mm) across the picture's longer side. */
export const SENSOR_MM = 36;
/** The lens taken when the instructions do not fix it (a natural view, 35 mm film). */
export const DEFAULT_LENS_MM = 35;
/** A vanishing point this close to the horizon (share of the picture's height) is one of a level edge. */
const ON_HORIZON = 0.04;

export interface CameraFit {
  /** The picture, in pixels. */
  width: number;
  height: number;
  /** The horizon's row at the picture's left and right edges (px from the top). */
  horizon: [number, number] | null;
  /** The vanishing points in the picture's pixels (outside it when beyond its edges). */
  vanishing: Point[];
  /** Level (lens shift, verticals upright) or tilted (looking up or down). */
  mode: "level" | "tilt";
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
  const bg = backgroundOf(panel);
  if (!bg.horizon) return null;
  const scale = dpi / 25.4;
  const width = Math.round((box[2] - box[0]) * scale);
  const height = Math.round((box[3] - box[1]) * scale);
  const toPx = ([x, y]: Point): Point => [(x - box[0]) * scale, (y - box[1]) * scale];
  const [a, b] = horizonAcross(panel, bg.horizon).map(toPx);
  // The row at the picture's own left and right edges.
  const slope = Math.abs(b[0] - a[0]) < 1e-6 ? 0 : (b[1] - a[1]) / (b[0] - a[0]);
  const rowAt = (x: number) => a[1] + (x - a[0]) * slope;
  const horizon: [number, number] = [rowAt(0), rowAt(width)];
  const vanishing = (bg.vanishing ?? []).map(toPx);
  const longer = Math.max(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const level = vanishing.filter(([x, y]) => Math.abs(y - rowAt(x)) <= ON_HORIZON * height);
  const centreRow = rowAt(cx);
  const d = cy - centreRow;
  const steep = Math.abs(d) > height;
  const mode: CameraFit["mode"] = bg.camera === "high" || steep ? "tilt" : "level";
  // Two level points either side of the centre fix the lens; on one side, the centre is moved between them.
  let principal = cx;
  let focalPx = (DEFAULT_LENS_MM * longer) / SENSOR_MM;
  let fromPoints = false;
  if (level.length >= 2) {
    const [u1, u2] = [level[0][0], level[1][0]].sort((p, q) => p - q);
    if (!(u1 < cx && cx < u2)) principal = (u1 + u2) / 2;
    const product = (principal - u1) * (u2 - principal) - (mode === "tilt" ? d * d : 0);
    if (product > 1) {
      focalPx = Math.sqrt(product);
      fromPoints = true;
    }
  }
  const tilt = mode === "tilt" ? Math.atan2(d, focalPx) : 0;
  const along = Math.cos(tilt);
  const turns = vanishing.map(([x, y]) =>
    Math.abs(y - rowAt(x)) <= ON_HORIZON * height ? (Math.atan2((x - principal) * along, focalPx) * 180) / Math.PI : null,
  );
  const round = (v: number, places = 3) => Math.round(v * 10 ** places) / 10 ** places;
  return {
    width,
    height,
    horizon: [round(horizon[0], 0), round(horizon[1], 0)],
    vanishing: vanishing.map(([x, y]) => [round(x, 0), round(y, 0)]),
    mode,
    focalPx: round(focalPx, 0),
    lensMm: round((focalPx * SENSOR_MM) / longer, 1),
    lensFromPoints: fromPoints,
    shiftX: round((principal - cx) / longer),
    shiftY: mode === "level" ? round((centreRow - cy) / longer) : 0,
    tiltDeg: round((tilt * 180) / Math.PI, 1),
    rollDeg: round((Math.atan(slope) * 180) / Math.PI, 1),
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
    out.push(
      `画像の中の消失点 ${i + 1}: (${px(x)}, ${px(y)})${outside}${turn === null ? "（アイレベルの上にない: 縦の線の消失点）" : `。そこへ向かう水平の線は、カメラの向きから ${turn >= 0 ? "右" : "左"}へ ${Math.abs(turn)}°`}`,
    );
  });
  const lens = fit.lensFromPoints
    ? `レンズ ${fit.lensMm}mm（センサー ${SENSOR_MM}mm、2 つの消失点から決まる。焦点距離 ${fit.focalPx}px）`
    : `レンズ ${fit.lensMm}mm（決まっていないので仮。ラフの人物の大きさに合わせて変えてよい）`;
  out.push(
    fit.mode === "level"
      ? `カメラ（計算済み）: 水平（縦の線はまっすぐ）、${lens}、レンズシフト X ${fit.shiftX}・Y ${fit.shiftY}${fit.rollDeg ? `、傾き（ロール）${fit.rollDeg}°` : ""}。カメラの高さ＝アイレベルの高さ`
      : `カメラ（計算済み）: ${fit.tiltDeg >= 0 ? "見下ろし" : "見上げ"} ${Math.abs(fit.tiltDeg)}°、${lens}、レンズシフト X ${fit.shiftX}・Y 0${fit.rollDeg ? `、傾き（ロール）${fit.rollDeg}°` : ""}`,
  );
  return out;
}

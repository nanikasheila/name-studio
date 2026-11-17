import { describe, expect, it } from "vitest";
import type { BoxMm, Panel, Point } from "../model/model";
import { cameraFit, cameraWords } from "./bgcamera";

const DPI = 254; // 10 px a mm
const box: BoxMm = [0, 0, 200, 100];
const panel = (horizon: [Point, Point], vanishing: Point[]): Panel => ({
  id: "panel1",
  order: 1,
  shape: [
    [0, 0],
    [200, 0],
    [200, 100],
    [0, 100],
  ],
  background: { horizon, vanishing },
});

/** Where a pinhole camera (focal f px, looking down `tilt`, picture 2000×1000) puts the horizon and the VPs of edges turned `yaw` and yaw − 90°. */
function shot(f: number, tilt: number, yaw: number) {
  const cx = 1000;
  const cy = 500;
  const row = cy - f * Math.tan(tilt);
  const u = (phi: number) => cx + (f * Math.tan(phi)) / Math.cos(tilt);
  const mm = (v: number) => v / 10;
  return {
    horizon: [
      [0, mm(row)],
      [200, mm(row)],
    ] as [Point, Point],
    vanishing: [
      [mm(u(yaw)), mm(row)],
      [mm(u(yaw - Math.PI / 2)), mm(row)],
    ] as Point[],
  };
}

describe("背景の指示 as a camera", () => {
  it("finds the lens and the walls' turn from two vanishing points with a level camera", () => {
    const { horizon, vanishing } = shot(1500, 0, (30 * Math.PI) / 180);
    // The level camera keeps the horizon where it is drawn by shifting the lens.
    horizon[0][1] = horizon[1][1] = 70;
    vanishing[0][1] = vanishing[1][1] = 70;
    const fit = cameraFit(panel(horizon, vanishing), box, DPI)!;
    expect(fit.mode).toBe("level");
    expect(fit.width).toBe(2000);
    expect(fit.focalPx).toBeCloseTo(1500, -1);
    expect(fit.lensMm).toBeCloseTo((1500 * 36) / 2000, 0);
    expect(fit.turnsDeg[0]).toBeCloseTo(30, 0);
    expect(fit.turnsDeg[1]).toBeCloseTo(-60, 0);
    expect(fit.shiftY).toBeCloseTo((700 - 500) / 2000, 3);
    expect(fit.tiltDeg).toBe(0);
    expect(cameraWords(fit).join("\n")).toContain("レンズシフト X 0・Y 0.1");
  });

  it("looks down with a third point below the eye level (3点), the lens and tilt from the three points", () => {
    const tilt = (35 * Math.PI) / 180;
    const f = 1800;
    const { horizon, vanishing } = shot(f, tilt, (20 * Math.PI) / 180);
    // The uprights meet below the middle, f / tan(tilt) from it.
    vanishing.push([100, (500 + f / Math.tan(tilt)) / 10]);
    const fit = cameraFit(panel(horizon, vanishing), box, DPI)!;
    expect(fit.mode).toBe("tilt");
    expect(fit.points).toBe(3);
    expect(fit.tiltDeg).toBeCloseTo(35, 0);
    expect(fit.focalPx).toBeCloseTo(f, -1);
    expect(fit.turnsDeg[0]).toBeCloseTo(20, 0);
    expect(fit.turnsDeg[2]).toBeNull();
    expect(fit.shiftX).toBeCloseTo(0, 2);
    expect(fit.shiftY).toBeCloseTo(0, 2);
    expect(cameraWords(fit).join("\n")).toContain("見下ろし 35°");
  });

  it("looks up with the third point above, and shifts the lens to where the heights of the triangle meet", () => {
    const tilt = (-25 * Math.PI) / 180;
    const f = 1500;
    const { horizon, vanishing } = shot(f, tilt, (40 * Math.PI) / 180);
    // Moved 300 px left in the picture: the principal point too (Blender's shift x is then +0.15).
    const left = (p: Point): Point => [p[0] - 30, p[1]];
    vanishing.forEach((p, i) => (vanishing[i] = left(p)));
    vanishing.push(left([100, (500 + f / Math.tan(tilt)) / 10]));
    const fit = cameraFit(panel(horizon, vanishing), box, DPI)!;
    expect(fit.tiltDeg).toBeCloseTo(-25, 0);
    expect(fit.focalPx).toBeCloseTo(f, -1);
    expect(fit.shiftX).toBeCloseTo(300 / 2000, 2);
    expect(cameraWords(fit).join("\n")).toContain("見上げ 25°");
  });

  it("shifts the lens towards two points on one side (Blender: +x moves the view right)", () => {
    // Both points right of the middle: the camera looks between them, so the principal point is right and the shift negative.
    const { horizon, vanishing } = shot(1200, 0, (60 * Math.PI) / 180);
    vanishing.forEach((p, i) => (vanishing[i] = [p[0] + 80, p[1]]));
    const fit = cameraFit(panel(horizon, vanishing), box, DPI)!;
    const middle = (vanishing[0][0] + vanishing[1][0]) * 5 - 1000;
    expect(fit.shiftX).toBeCloseTo(-middle / 2000, 2);
    expect(fit.shiftX).toBeLessThan(0);
    // The two walls stay at right angles.
    expect(fit.turnsDeg[0]! - fit.turnsDeg[1]!).toBeCloseTo(90, 0);
  });

  it("looks straight at the one point of 1点透視", () => {
    const fit = cameraFit(
      panel(
        [
          [0, 40],
          [200, 40],
        ],
        [[150, 40]],
      ),
      box,
      DPI,
    )!;
    expect(fit.turnsDeg[0]).toBe(0);
    expect(fit.shiftX).toBeCloseTo(-500 / 2000, 3);
    expect(cameraWords(fit).join("\n")).toContain("まっすぐ向く");
  });

  it("takes the default lens with one vanishing point, and none without an eye level", () => {
    const fit = cameraFit(
      panel(
        [
          [0, 50],
          [200, 50],
        ],
        [[150, 50]],
      ),
      box,
      DPI,
    )!;
    expect(fit.lensFromPoints).toBe(false);
    expect(fit.lensMm).toBe(35);
    expect(fit.turnsDeg[0]).toBe(0);
    expect(
      cameraFit(
        {
          ...panel(
            [
              [0, 0],
              [1, 0],
            ],
            [],
          ),
          background: {},
        },
        box,
        DPI,
      ),
    ).toBeNull();
  });
});

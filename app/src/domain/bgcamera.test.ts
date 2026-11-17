import { describe, expect, it } from "vitest";
import type { BoxMm, Panel, Point } from "../model/model";
import { cameraFit, cameraWords } from "./bgcamera";

const DPI = 254; // 10 px a mm
const box: BoxMm = [0, 0, 200, 100];
const panel = (horizon: [Point, Point], vanishing: Point[], camera?: "eye" | "low" | "high"): Panel => ({
  id: "panel1",
  order: 1,
  shape: [
    [0, 0],
    [200, 0],
    [200, 100],
    [0, 100],
  ],
  background: { horizon, vanishing, ...(camera ? { camera } : {}) },
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
    const fit = cameraFit(panel(horizon, vanishing, "low"), box, DPI)!;
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

  it("looks down when asked for 俯瞰, the lens and tilt from the horizon above", () => {
    const tilt = (35 * Math.PI) / 180;
    const { horizon, vanishing } = shot(1800, tilt, (20 * Math.PI) / 180);
    const fit = cameraFit(panel(horizon, vanishing, "high"), box, DPI)!;
    expect(fit.mode).toBe("tilt");
    expect(fit.tiltDeg).toBeCloseTo(35, 0);
    expect(fit.focalPx).toBeCloseTo(1800, -1);
    expect(fit.turnsDeg[0]).toBeCloseTo(20, 0);
    expect(cameraWords(fit).join("\n")).toContain("見下ろし 35°");
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
    expect(fit.turnsDeg[0]).toBeGreaterThan(0);
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

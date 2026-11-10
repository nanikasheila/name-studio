import { describe, expect, it } from "vitest";
import { normalAngle, turn, Viewport } from "./viewport";

const close = (a: readonly number[], b: readonly number[]) => a.forEach((value, i) => expect(value).toBeCloseTo(b[i], 9));
const view = () => new Viewport(() => ({ width: 800, height: 600 }));

describe("the editor's view", () => {
  it("turns vectors clockwise on screen and keeps angles in -π..π", () => {
    close(turn(1, 0, Math.PI / 2), [0, 1]);
    expect(normalAngle(3 * Math.PI)).toBeCloseTo(-Math.PI, 9);
    expect(normalAngle(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 9);
  });

  it("maps between the screen and the upright view both ways", () => {
    const v = view();
    expect(v.turnTo(0.7)).toBe(true);
    const p: [number, number] = [123, 456];
    close(v.onScreen(v.unturned(p)), p);
    close(v.unturned([400, 300]), [400, 300]);
  });

  it("turns upright when close to it, and says when nothing changed", () => {
    const v = view();
    expect(v.turnTo(0.02, (3 * Math.PI) / 180)).toBe(false);
    expect(v.rotation).toBe(0);
    v.turnTo(1);
    expect(v.turnTo(1 + 2 * Math.PI)).toBe(false);
  });

  it("matches the canvas transform: translate, rotate, translate back", () => {
    const v = view();
    v.turnTo(0.5);
    const [a, b, c, d, e, f] = v.matrix(2);
    const p: [number, number] = [100, 50];
    const onScreen = v.onScreen(p);
    close([(a * p[0] + c * p[1] + e) / 2, (b * p[0] + d * p[1] + f) / 2], onScreen);
  });

  it("moves the pages with the hand however the view is turned", () => {
    const v = view();
    v.turnTo(Math.PI / 2);
    v.dragBy(0, 10);
    close(v.pan, [10, 0]);
  });

  it("zooms about a point, keeping it still", () => {
    const v = view();
    v.pan = [30, -20];
    const at: [number, number] = [600, 100];
    // A point of the layout at `at`: x = width/2 + pan + offset * zoom.
    const offset = (at[0] - 400 - v.pan[0]) / v.zoom;
    v.zoomAbout(at, 3);
    expect(400 + v.pan[0] + offset * v.zoom).toBeCloseTo(at[0], 9);
  });

  it("keeps what was under two fingers under them", () => {
    const v = view();
    v.turnTo(0.3);
    const mid: [number, number] = [500, 200];
    const anchor = v.anchorAt(mid);
    v.holdAnchor(anchor, mid, 2.5);
    close(v.anchorAt(mid), anchor);
  });
});

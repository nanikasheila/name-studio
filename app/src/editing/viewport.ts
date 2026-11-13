// The page editor's view: how far it is zoomed, moved and turned. The pages
// are laid out in an upright view (zoom and pan, see layout.ts); the turn is
// applied about the middle of the stage on top of it, as CSP's 画面の回転, and
// so is 左右反転 (the view mirrored across, before it is turned).
// Points are CSS px on the stage. Pure: the editor gives the stage's size and
// sets the canvas transform from `matrix`.
import type { Point } from "../model/model";

/** A vector turned by `radians` (clockwise on screen). */
export function turn(x: number, y: number, radians: number): Point {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [x * cos - y * sin, x * sin + y * cos];
}

/** An angle as -π..π. */
export function normalAngle(radians: number): number {
  const full = Math.PI * 2;
  return ((((radians + Math.PI) % full) + full) % full) - Math.PI;
}

export class Viewport {
  zoom = 1;
  pan: Point = [0, 0];
  /** 画面の回転 (radians, clockwise): the whole view turns about the middle of the stage. */
  rotation = 0;
  /** 左右反転: the view mirrored left to right about the middle of the stage (then turned). */
  flipped = false;

  constructor(private readonly size: () => { width: number; height: number }) {}

  /** The middle of the stage, which the view turns about. */
  centre(): Point {
    const { width, height } = this.size();
    return [width / 2, height / 2];
  }

  /** Upright at `zoom`, not moved. */
  reset(zoom = 1): void {
    this.zoom = zoom;
    this.pan = [0, 0];
  }

  /** Turns the view to `radians` (upright when within `upright` of it); false when it did not change. */
  turnTo(radians: number, upright = 1e-9): boolean {
    let next = normalAngle(radians);
    if (Math.abs(next) < upright) next = 0;
    if (next === this.rotation) return false;
    this.rotation = next;
    return true;
  }

  /** Where a point on screen is in the upright view (what the pages are laid out in). */
  unturned([sx, sy]: Point): Point {
    if (!this.rotation && !this.flipped) return [sx, sy];
    const [cx, cy] = this.centre();
    const [x, y] = this.unturnedFromCentre([sx, sy]);
    return [cx + x, cy + y];
  }

  /** Where a point of the upright view shows on screen. */
  onScreen([x, y]: Point): Point {
    if (!this.rotation && !this.flipped) return [x, y];
    const [cx, cy] = this.centre();
    const [dx, dy] = turn(this.mirror(x - cx), y - cy, this.rotation);
    return [cx + dx, cy + dy];
  }

  /** The angle on screen of a point of the upright view, about the middle (for turning by a drag). */
  angleAt(x: number, y: number): number {
    const [cx, cy] = this.centre();
    const [tx, ty] = turn(this.mirror(x - cx), y - cy, this.rotation);
    return Math.atan2(ty, tx);
  }

  /** Moves the pages by a hand's move on screen, however the view is turned. */
  dragBy(dx: number, dy: number): void {
    const [x, y] = turn(dx, dy, -this.rotation);
    this.pan[0] += this.mirror(x);
    this.pan[1] += y;
  }

  /** Zooms to `zoom` keeping the upright view's point `at` still. */
  zoomAbout(at: Point, zoom: number): void {
    const { width, height } = this.size();
    const applied = zoom / this.zoom;
    this.pan[0] += (at[0] - (width / 2 + this.pan[0])) * (1 - applied);
    this.pan[1] += (at[1] - (height / 2 + this.pan[1])) * (1 - applied);
    this.zoom = zoom;
  }

  /** What is under a point on screen, independent of zoom and pan (to keep it under a pinch). */
  anchorAt(screen: Point): Point {
    const [ux, uy] = this.unturnedFromCentre(screen);
    return [(ux - this.pan[0]) / this.zoom, (uy - this.pan[1]) / this.zoom];
  }

  /** Zooms to `zoom` with `anchor` (from `anchorAt`) under the point on screen. */
  holdAnchor(anchor: Point, screen: Point, zoom: number): void {
    const [ux, uy] = this.unturnedFromCentre(screen);
    this.zoom = zoom;
    this.pan = [ux - anchor[0] * zoom, uy - anchor[1] * zoom];
  }

  /** The canvas transform for a device pixel ratio: CSS px, turned about the middle. */
  matrix(ratio: number): [number, number, number, number, number, number] {
    if (!this.rotation && !this.flipped) return [ratio, 0, 0, ratio, 0, 0];
    const [cx, cy] = this.centre();
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    const f = this.flipped ? -1 : 1;
    // Turned after being mirrored: [[f cos, -sin], [f sin, cos]] about the middle.
    const [a, b, c, d] = [f * cos, f * sin, -sin, cos];
    return [ratio * a, ratio * b, ratio * c, ratio * d, ratio * (cx - a * cx - c * cy), ratio * (cy - b * cx - d * cy)];
  }

  /** Whether the view is turned or mirrored at all. */
  get changed(): boolean {
    return this.rotation !== 0 || this.flipped;
  }

  /** A length across, mirrored when the view is. */
  private mirror(x: number): number {
    return this.flipped ? -x : x;
  }

  /** A point on screen as a vector from the middle, turned upright (and mirrored back). */
  private unturnedFromCentre([sx, sy]: Point): Point {
    const [cx, cy] = this.centre();
    const [x, y] = turn(sx - cx, sy - cy, -this.rotation);
    return [this.mirror(x), y];
  }
}

// 多角形 (コマ割り): corners placed one click at a time, snapped like the other
// panel points, then closed into a panel — on the first corner (or the last
// again), with a double click or Enter. Backspace takes back a corner, Esc stops.
import { toPage, type Slot } from "../editing/layout";
import type { Page, Point, Project } from "../model/model";
import { isTyping } from "../platform/dom";
import type { PolygonPreview } from "./editorcore";

export interface PolygonHost {
  project(): Project | null;
  slots(): readonly Slot[];
  /** A corner snapped to the page's panels (as it is with `free`), lining up with the corners `beside`. */
  snap(slot: Slot, point: Point, free: boolean, beside: readonly Point[]): Point;
  /** The outline closed: a panel on `page`. */
  addPanel(project: Project, page: Page, outline: Point[]): void;
  status(message: string): void;
  clearGuides(): void;
  requestOverlay(): void;
  draw(): void;
}

export class PolygonOutline {
  /** The corners placed so far, on one page (null: none being placed). */
  current: { pageId: string; points: Point[] } | null = null;

  constructor(private readonly host: PolygonHost) {}

  get placing(): boolean {
    return this.current !== null;
  }

  /** The page of the outline being placed, as laid out now. */
  slot(): Slot | null {
    const current = this.current;
    return current ? (this.host.slots().find((slot) => slot.page.id === current.pageId) ?? null) : null;
  }

  /** The next corner, snapped, from the pointer at `point` on the outline's page. */
  nextCorner(slot: Slot, point: Point, free: boolean): Point {
    const points = this.current?.points ?? [];
    const beside = points.length ? [points[points.length - 1], points[0]] : [];
    return this.host.snap(slot, point, free, beside);
  }

  /** The outline to show, with the side to the screen point `pointer` (null while dragging). */
  preview(pointer: readonly [number, number] | null): PolygonPreview | null {
    const current = this.current;
    const slot = this.slot();
    if (!current || !slot) return null;
    const outline = [...current.points];
    let closing = false;
    if (pointer) {
      const at = toPage(slot, pointer[0], pointer[1]);
      const first = current.points[0];
      closing = current.points.length >= 3 && Math.hypot(first[0] - at[0], first[1] - at[1]) * slot.scale <= 8;
      if (!closing) outline.push(this.nextCorner(slot, at, false));
    }
    return { slot, placed: current.points, outline, closing };
  }

  /** A click places a corner; on the first corner (or the last again) it closes the outline into a panel. */
  place(slot: Slot, point: Point, free: boolean): void {
    const current = this.current?.pageId === slot.page.id ? this.current : null;
    if (!current) {
      this.current = { pageId: slot.page.id, points: [this.nextCorner(slot, point, free)] };
      this.host.status(
        "多角形: クリックで角を置く。最初の角をクリック・ダブルクリック・Enter で閉じてコマに（Backspace で 1 つ戻す、Esc でやめる）",
      );
      this.host.requestOverlay();
      return;
    }
    const near = (p: Point) => Math.hypot(p[0] - point[0], p[1] - point[1]) * slot.scale <= 8;
    if (current.points.length >= 3 && (near(current.points[0]) || near(current.points[current.points.length - 1]))) {
      this.finish();
      return;
    }
    current.points.push(this.nextCorner(slot, point, free));
    this.host.clearGuides();
    this.host.requestOverlay();
  }

  /** The corners placed make a panel (with three or more). */
  finish(): boolean {
    const current = this.current;
    const project = this.host.project();
    if (!current || !project) return false;
    this.current = null;
    this.host.clearGuides();
    const page = project.pages.find((p) => p.id === current.pageId);
    if (page && current.points.length >= 3) this.host.addPanel(project, page, current.points);
    else this.host.status("コマにするには角を 3 つ以上置いてください");
    this.host.draw();
    return true;
  }

  /** Stop placing corners (`last`: take back only the last one). */
  cancel(last = false): boolean {
    if (!this.current) return false;
    if (last && this.current.points.length > 1) this.current.points.pop();
    else {
      this.current = null;
      this.host.status("");
    }
    this.host.clearGuides();
    this.host.requestOverlay();
    return true;
  }

  /** Enter, Backspace and Esc while corners are being placed (true: the key was taken). */
  key(event: KeyboardEvent): boolean {
    if (!this.current || isTyping(event)) return false;
    if (event.key === "Enter") return this.finish();
    if (event.key === "Backspace") return this.cancel(true);
    if (event.key === "Escape") return this.cancel();
    return false;
  }
}

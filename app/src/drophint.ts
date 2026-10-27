// Where a held panel dragged from the 保留 list would go, shown over the
// pages while it is dragged: the panel it would fill (中身を入れる), or its
// outline where it would be put, on the page or in the 欄外.
import { svg } from "./dom";
import { bounds } from "./geometry";
import type { HeldPanel, Page, Panel, Point, Project } from "./model";
import { pointOff } from "./aside";

export type DropKind = "into" | "place" | "aside";

export class DropHint {
  private readonly layer: SVGSVGElement;
  private readonly outline: SVGPolygonElement;
  private readonly label: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.outline = svg("polygon");
    this.layer = svg("svg", { class: "drop-hint", "aria-hidden": "true" }, this.outline);
    this.label = document.createElement("div");
    this.label.className = "drop-hint-label";
    this.hide();
    container.append(this.layer, this.label);
  }

  /** The outline `points` (window px) with `text` beside it. */
  show(kind: DropKind, points: Point[], text: string): void {
    // Shown before it is measured: hidden, it has no place on the page.
    this.layer.style.display = "";
    const box = this.layer.getBoundingClientRect();
    this.outline.setAttribute("points", points.map(([x, y]) => `${x - box.left},${y - box.top}`).join(" "));
    this.layer.dataset.kind = kind;
    const xs = points.map(([x]) => x - box.left);
    const ys = points.map(([, y]) => y - box.top);
    this.label.textContent = text;
    this.label.dataset.kind = kind;
    this.label.style.left = `${Math.min(...xs)}px`;
    this.label.style.top = `${Math.max(0, Math.min(...ys) - 26)}px`;
    this.label.style.display = "";
  }

  hide(): void {
    this.layer.style.display = "none";
    this.label.style.display = "none";
  }

  get shown(): string | null {
    return this.label.style.display === "none" ? null : this.label.textContent;
  }
}

/**
 * What dropping `held` at `where` would do, as an outline in page mm and
 * words: fill the panel there, or put the panel there (on the page or in
 * its 欄外), as the drop does.
 */
export function dropPlan(
  project: Project,
  held: HeldPanel,
  where: { page: Page; point: Point; panel?: Panel },
): { kind: DropKind; shape: Point[]; text: string } {
  const number = project.pages.indexOf(where.page) + 1;
  if (pointOff(where.point, project.pageFormat)) return { kind: "aside", shape: centred(held.panel.shape, where.point), text: `${number} ページの欄外に置く` };
  if (where.panel) return { kind: "into", shape: where.panel.shape, text: `${number} ページのコマ ${where.panel.order} に中身を入れる` };
  return { kind: "place", shape: centred(held.panel.shape, where.point), text: `${number} ページのここに置く` };
}

/** `shape` moved so its box is centred on `at`, as a held panel is put. */
function centred(shape: Point[], [x, y]: Point): Point[] {
  const [x0, y0, x1, y1] = bounds(shape);
  return shape.map(([px, py]) => [px + x - (x0 + x1) / 2, py + y - (y0 + y1) / 2]);
}

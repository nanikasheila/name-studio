// The 別案 dialog: the options of a set side by side, to compare and pick.
import { optionPages, removeAlternative, useAlternative } from "./alternatives";
import { drawBalloons, drawPageTexts, drawPanelBorders, drawPanelFills, drawStrokes } from "./pagedraw";
import type { Alternatives, Page, Project } from "./model";
import { trimBox } from "./pagebox";
import { $ } from "./dom";
import { withoutMarks } from "./roughlayers";

export interface AltDialogHost {
  project(): Project | null;
  /** Run `change` as one undoable step. */
  edit(change: (project: Project) => void): void;
  /** Show the pages of the option now in use. */
  shown(set: Alternatives): void;
}
const THUMB_WIDTH = 150;

/** A small picture of a page as it reads: panels, rough lines, balloons and text, cut at the trim. */
export function pageThumbnail(project: Project, page: Page, width = THUMB_WIDTH): HTMLCanvasElement {
  const [x0, y0, x1, y1] = trimBox(project.pageFormat);
  const scale = width / (x1 - x0);
  const canvas = document.createElement("canvas");
  const ratio = 2;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round((y1 - y0) * scale * ratio);
  canvas.style.width = `${width}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.scale(ratio, ratio);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, (y1 - y0) * scale);
  const m = { scale, x: -x0 * scale, y: -y0 * scale };
  const brushes = project.brushes;
  const rough = { ...page, strokes: withoutMarks(project, page.strokes) };
  drawStrokes(ctx, rough, m, false, () => "#3a3834", 0.4, brushes);
  drawPanelFills(ctx, page, m, 0.4);
  drawPanelBorders(ctx, page, m, undefined, 0.6);
  drawStrokes(ctx, rough, m, true, () => "#3a3834", 0.4, brushes);
  drawBalloons(ctx, page, m, 0.5);
  drawPageTexts(ctx, page, m);
  return canvas;
}

export class AltDialog {
  private setId: string | null = null;

  constructor(private readonly host: AltDialogHost) {}

  open(setId: string): void {
    this.setId = setId;
    this.render();
    const dialog = $<HTMLDialogElement>("alt-dialog");
    if (!dialog.open) dialog.showModal();
  }

  /** Redraw after a change (or close when the set is gone). */
  render(): void {
    const project = this.host.project();
    const set = project?.alternatives?.find((s) => s.id === this.setId);
    const dialog = $<HTMLDialogElement>("alt-dialog");
    if (!project || !set) {
      if (dialog.open) dialog.close();
      return;
    }
    const numbers = set.pageIds.map((id) => project.pages.findIndex((page) => page.id === id) + 1).filter((n) => n > 0);
    $("ad-where").textContent = numbers.length
      ? `${numbers.length === 1 ? `${numbers[0]} ページ` : `${numbers[0]}–${numbers[numbers.length - 1]} ページ`}の別案です。「この案にする」で、そのページが入れ替わります（元に戻すは Ctrl+Z）。`
      : "";
    const columns = set.options.map((option) => {
      const inUse = option.id === set.active;
      const pages = optionPages(project, set, option);
      const name = Object.assign(document.createElement("input"), { type: "text", value: option.name });
      name.addEventListener("change", () => this.host.edit(() => (option.name = name.value.trim() || option.name)));
      const use = Object.assign(document.createElement("button"), {
        type: "button",
        className: inUse ? "" : "primary",
        textContent: inUse ? "使用中" : "この案にする",
        disabled: inUse,
      });
      use.addEventListener("click", () => {
        this.host.edit((p) => useAlternative(p, set.id, option.id));
        this.host.shown(set);
        this.render();
      });
      const remove = Object.assign(document.createElement("button"), { type: "button", className: "danger", textContent: "消す", disabled: inUse });
      remove.addEventListener("click", () => {
        this.host.edit((p) => removeAlternative(p, set.id, option.id));
        this.render();
      });
      const thumbs = document.createElement("div");
      thumbs.className = "alt-pages";
      // Right binding reads right to left: the first page on the right.
      const ordered = project.binding === "right" ? [...pages].reverse() : pages;
      thumbs.append(...ordered.map((page) => pageThumbnail(project, page, pages.length > 2 ? 100 : THUMB_WIDTH)));
      const head = document.createElement("div");
      head.className = "alt-head";
      const count = Object.assign(document.createElement("span"), { className: "hint", textContent: `${pages.length} ページ` });
      head.append(name, count);
      const actions = document.createElement("div");
      actions.className = "alt-actions";
      actions.append(use, remove);
      const column = document.createElement("div");
      column.className = `alt-option${inUse ? " in-use" : ""}`;
      column.append(head, thumbs, actions);
      return column;
    });
    $("ad-options").replaceChildren(...columns);
  }
}

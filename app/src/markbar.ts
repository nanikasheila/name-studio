// The 指示 tool's bar: the colour drawn in (a 指示のレイヤー each), its width,
// drawing or erasing; and, beside the page buttons, 指示 shown or hidden.
import { $ } from "./dom";
import type { PageEditor, Tool } from "./editor";
import type { Project } from "./model";
import type { RoughChange } from "./roughpanel";
import { markColor, markLayersOf, MARK_COLORS, MARK_COLOR_NAMES, MARK_LAYER_NAME } from "./roughlayers";
import { markPen, setMarkWidth } from "./toolmark";

export interface MarkBarHost {
  readonly editor: PageEditor;
  project(): Project | null;
  status(message: string): void;
  setTool(tool: Tool): void;
  /** A change to the layers, as one undoable step. */
  rough(change: RoughChange): void;
}

export class MarkBar {
  constructor(private readonly host: MarkBarHost) {}

  render(): void {
    const project = this.host.project();
    const marks = project ? markLayersOf(project) : [];
    // 指示 shown or hidden, beside the page buttons, once there are any.
    $("marks-shown-label").hidden = !marks.length;
    $("marks-shown").setAttribute("aria-pressed", String(marks.some((layer) => !layer.hidden)));
    const bar = $("mark-bar");
    bar.classList.toggle("off", this.host.editor.tool !== "mark");
    if (this.host.editor.tool !== "mark") return;
    const active = marks.find((layer) => layer.id === markPen.layer) ?? marks[marks.length - 1];
    const chips = marks.length
      ? [...marks].reverse().map((layer) => this.chip(layer.id, layer.name, markColor(layer), layer === active, !!layer.hidden))
      : [this.chip("", MARK_LAYER_NAME, MARK_COLORS[0], true, false)];
    $("mark-colors").replaceChildren(...chips);
    const size = $<HTMLInputElement>("mark-size");
    if (document.activeElement !== size) size.value = String(markPen.widthMm);
    $("mark-draw").classList.toggle("active", !markPen.erase);
    $("mark-erase").classList.toggle("active", markPen.erase);
  }

  /** One colour to draw in: its 指示のレイヤー ("" for the one made by the first 指示). */
  private chip(id: string, name: string, color: string, active: boolean, hidden: boolean): HTMLButtonElement {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `mark-chip${active ? " active" : ""}${hidden ? " hidden-layer" : ""}`;
    chip.dataset.mark = id;
    const dot = document.createElement("i");
    dot.style.background = color;
    chip.append(dot, name);
    const named = MARK_COLOR_NAMES[color as (typeof MARK_COLORS)[number]] ?? "";
    chip.title = `${named ? `${named}で` : ""}描く（レイヤー「${name}」${hidden ? "、いまは隠しています。描くと出ます" : ""}）`;
    chip.addEventListener("click", () => {
      markPen.layer = id;
      markPen.erase = false;
      this.render();
      this.host.status(`指示: 「${name}」に描きます`);
    });
    return chip;
  }

  /** ] / [: the 指示 pen a size up or down. */
  resize(factor: number): void {
    setMarkWidth(markPen.widthMm * factor);
    this.render();
    this.host.status(`指示の太さ: ${markPen.widthMm} mm`);
  }

  bind(): void {
    $("mark-add").addEventListener("click", () => this.host.rough({ kind: "addMarks" }));
    $<HTMLInputElement>("mark-size").addEventListener("change", (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      if (value > 0) setMarkWidth(value);
      this.render();
    });
    const mode = (erase: boolean) => () => {
      markPen.erase = erase;
      if (this.host.editor.tool !== "mark") this.host.setTool("mark");
      this.render();
      this.host.editor.draw();
      this.host.status(erase ? "指示を消します（ラフ線は消えません）" : "指示を描きます");
    };
    $("mark-draw").addEventListener("click", mode(false));
    $("mark-erase").addEventListener("click", mode(true));
    $("marks-shown").addEventListener("click", (event) => {
      const shown = (event.currentTarget as HTMLElement).getAttribute("aria-pressed") !== "true";
      this.host.rough({ kind: "showMarks", shown });
    });
  }
}

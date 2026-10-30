// サブツールの欄の塗り: CSP's sub tools of 塗りつぶし (塗りつぶし, 囲って塗る,
// 投げなわ塗り, 塗り残し部分に塗る), each with a small picture of what it does,
// and ツールプロパティ for the one in hand: the tone and its own settings
// (the same as on the bar above the pages).
import type { PageEditor } from "./editor";
import type { FillBar } from "./fillbar";
import { FILL_WAY_HINTS, FILL_WAY_LABELS, FILL_WAYS, GAP_STEPS, type AreaWay, type FillWay } from "./fillsettings";
import { element } from "./dom";
import { INK } from "./pagedraw";
import type { SubTool, SubToolSource } from "./subtools";

const PREFIX = "fill:";

export class FillSource implements SubToolSource {
  readonly tool = "fill" as const;
  readonly label = "塗り";

  constructor(
    private readonly editor: PageEditor,
    private readonly bar: FillBar,
  ) {}

  list(): SubTool[] {
    return FILL_WAYS.map((way) => ({ ref: `${PREFIX}${way}`, name: FILL_WAY_LABELS[way], detail: this.detail(way), sample: (canvas) => drawSample(canvas, way) }));
  }

  /** Beside the name: how small a gap it closes. */
  private detail(way: FillWay): string {
    if (way === "lasso") return "";
    const gap = this.editor.fill.options[way as AreaWay].gapMm;
    return gap ? `隙間 ${GAP_STEPS.find((step) => step.mm === gap)?.label.replace(/（.*/, "") ?? gap}` : "";
  }

  current(): string | null {
    return `${PREFIX}${this.editor.fill.way}`;
  }

  pick(ref: string): void {
    const way = ref.slice(PREFIX.length) as FillWay;
    if (FILL_WAYS.includes(way)) this.bar.setWay(way);
  }

  properties(box: HTMLElement): void {
    const way = this.editor.fill.way;
    box.append(
      element("div", { className: "subtool-props-title", textContent: FILL_WAY_LABELS[way] }),
      element("p", { className: "subtool-note", textContent: FILL_WAY_HINTS[way] }),
      this.bar.tones(true),
      ...this.bar.properties(true),
    );
  }

  signature(): string {
    return JSON.stringify(["fill", this.editor.fill]);
  }
}

/** What the way does, in a 96 × 20 row. */
function drawSample(canvas: HTMLCanvasElement, way: FillWay): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const k = canvas.width / 96;
  ctx.save();
  ctx.scale(k, k);
  ctx.clearRect(0, 0, 96, 20);
  ctx.lineWidth = 1;
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  const box = (x: number, y: number, w: number, h: number, filled: boolean) => {
    if (filled) ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  };
  if (way === "click") {
    // A closed shape filled, and the point clicked.
    box(8, 3, 34, 14, true);
    box(54, 3, 34, 14, false);
    ctx.beginPath();
    ctx.arc(71, 10, 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (way === "enclose") {
    // The closed shapes inside the lasso filled, the one it cuts not.
    box(10, 5, 16, 10, true);
    box(32, 5, 16, 10, true);
    box(62, 5, 22, 10, false);
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.ellipse(29, 10, 25, 9, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (way === "lasso") {
    // The outline drawn, filled as it is.
    ctx.beginPath();
    ctx.moveTo(12, 12);
    ctx.bezierCurveTo(14, 1, 50, 0, 62, 6);
    ctx.bezierCurveTo(80, 12, 60, 20, 40, 17);
    ctx.bezierCurveTo(24, 16, 10, 18, 12, 12);
    ctx.fill();
  } else {
    // A fill next to a line, and the sliver between them brushed.
    ctx.fillRect(8, 3, 80, 9);
    ctx.beginPath();
    ctx.moveTo(8, 15.5);
    ctx.lineTo(88, 15.5);
    ctx.stroke();
    ctx.fillStyle = "rgba(47, 111, 219, 0.45)";
    ctx.fillRect(30, 11, 36, 5);
  }
  ctx.restore();
}

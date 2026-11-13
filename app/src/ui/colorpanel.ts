// カラー: the 描画色 as CSP's colour palettes give it — the メイン and サブ
// colours, a カラーサークル (hue ring round a saturation × value square), HSV
// and RGB sliders with the hex, the カラー履歴, and a カラーセット: the basic
// colours, each character's colour (to tell them apart in the name) and the
// person's own. スポイト picks a colour off the page. Built once; what changes
// is only redrawn.
import { BASIC_COLORS, hsvToRgb, normalHex, parseHex, rgbToHsv, toHex, type Hsv } from "../domain/color";
import { drawColors } from "../platform/drawcolor";
import type { Project } from "../model/model";

export interface ColorPanelHost {
  project(): Project | null;
  status(message: string): void;
  /** スポイト: the next click on the page gives its colour (null: given up). */
  pickFromPage(done: (color: string | null) => void): void;
}

type SliderMode = "hsv" | "rgb";
const MODE_KEY = "namestudio.colorSliders";

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export class ColorPanel {
  private built: HTMLElement | null = null;
  /** The colour as the circle holds it: the hue stays where it was at grey and black. */
  private hsv: Hsv = [0, 0, 0];
  private mode: SliderMode = localStorage.getItem(MODE_KEY) === "rgb" ? "rgb" : "hsv";
  private wheel!: HTMLCanvasElement;
  private mainChip!: HTMLButtonElement;
  private subChip!: HTMLButtonElement;
  private hex!: HTMLInputElement;
  private sliders!: HTMLElement;
  private history!: HTMLElement;
  private sets!: HTMLElement;
  private dropper!: HTMLButtonElement;
  private castSign = "";

  constructor(private readonly host: ColorPanelHost) {
    drawColors.onChange(() => this.update());
  }

  /** Into `container` (built the first time), up to date. */
  render(container: HTMLElement): void {
    if (!this.built || this.built.parentElement !== container) {
      this.built = this.build();
      container.replaceChildren(this.built);
    }
    this.update();
  }

  private build(): HTMLElement {
    const root = node("div", "color-panel");
    // メイン and サブ, the swap, the hex and the スポイト.
    const top = node("div", "color-top");
    const chips = node("div", "color-chips");
    this.mainChip = node("button", "color-chip main");
    this.mainChip.type = "button";
    this.mainChip.title = "描画色（メイン）。ペン・塗り（描画色）がこの色で描きます";
    this.subChip = node("button", "color-chip sub");
    this.subChip.type = "button";
    this.subChip.title = "サブの色。押すとメインと入れ替え（X）";
    this.subChip.addEventListener("click", () => drawColors.swap());
    const swap = node("button", "color-swap", "⇄");
    swap.type = "button";
    swap.title = "メインとサブを入れ替える（X）";
    swap.addEventListener("click", () => drawColors.swap());
    chips.append(this.subChip, this.mainChip, swap);
    this.hex = node("input", "color-hex");
    this.hex.type = "text";
    this.hex.spellcheck = false;
    this.hex.setAttribute("aria-label", "色の 16 進（#rrggbb）");
    this.hex.addEventListener("change", () => {
      if (!drawColors.setMain(this.hex.value)) this.update();
    });
    this.hex.addEventListener("keydown", (event) => {
      event.stopPropagation();
      // Enter sets it and gives the keys back to the page.
      if (event.key === "Enter" || event.key === "Escape") {
        if (event.key === "Escape") this.hex.value = drawColors.main;
        this.hex.blur();
      }
    });
    this.dropper = node("button", "color-dropper");
    this.dropper.type = "button";
    this.dropper.innerHTML =
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M13.5 3.5l3 3-2 2-3-3zM11.5 5.5l3 3-7 7H4.5v-3z"/></svg>';
    this.dropper.title = "スポイト: 紙面をクリックしてその色を描画色に（ペン・塗りでは Alt+クリックでも）";
    this.dropper.setAttribute("aria-label", "スポイト");
    this.dropper.addEventListener("click", () => this.pick());
    const black = node("button", "color-black", "黒");
    black.type = "button";
    black.title = "描画色を黒に戻す";
    black.addEventListener("click", () => drawColors.setMain("#000000"));
    top.append(chips, this.hex, this.dropper, black);
    // カラーサークル.
    this.wheel = node("canvas", "color-wheel");
    this.wheel.setAttribute("aria-label", "カラーサークル: 外の輪で色相、中の四角で彩度と明度");
    this.bindWheel();
    // スライダー.
    const tabs = node("div", "segmented color-modes");
    for (const mode of ["hsv", "rgb"] as const) {
      const button = node("button", "", mode.toUpperCase());
      button.type = "button";
      button.dataset.mode = mode;
      button.addEventListener("click", () => {
        this.mode = mode;
        try {
          localStorage.setItem(MODE_KEY, mode);
        } catch {
          // Not kept; the choice still holds now.
        }
        this.update();
      });
      tabs.append(button);
    }
    this.sliders = node("div", "color-sliders");
    // カラー履歴 and カラーセット.
    this.history = node("div", "color-swatches color-history");
    this.sets = node("div", "color-sets");
    root.append(top, this.wheel, tabs, this.sliders, node("div", "color-heading", "カラー履歴"), this.history, this.sets);
    return root;
  }

  /** Bring everything into line with the 描画色. */
  private update(): void {
    if (!this.built) return;
    const main = drawColors.main;
    // The circle keeps its hue when the colour is the same one (dragging into grey).
    if (toHex(hsvToRgb(this.hsv)) !== main) {
      const rgb = parseHex(main) ?? [0, 0, 0];
      const [h, s, v] = rgbToHsv(rgb);
      this.hsv = [s === 0 || v === 0 ? this.hsv[0] : h, v === 0 ? this.hsv[1] : s, v];
    }
    this.mainChip.style.background = main;
    this.subChip.style.background = drawColors.sub;
    if (document.activeElement !== this.hex) this.hex.value = main;
    this.drawWheel();
    for (const button of this.built.querySelectorAll<HTMLButtonElement>(".color-modes button")) {
      button.classList.toggle("active", button.dataset.mode === this.mode);
      button.setAttribute("aria-pressed", String(button.dataset.mode === this.mode));
    }
    this.renderSliders();
    this.renderSwatches(this.history, drawColors.history, "まだありません（描くと使った色が並びます）");
    this.renderSets();
  }

  // --- カラーサークル -----------------------------------------------------------

  private geometry() {
    const size = this.wheel.clientWidth || 168;
    const outer = size / 2 - 2;
    const inner = outer * 0.8;
    const side = inner * Math.SQRT2 * 0.94;
    return { size, centre: size / 2, outer, inner, side, x0: size / 2 - side / 2, y0: size / 2 - side / 2 };
  }

  private drawWheel(): void {
    const g = this.geometry();
    const ratio = window.devicePixelRatio || 1;
    this.wheel.width = Math.round(g.size * ratio);
    this.wheel.height = Math.round(g.size * ratio);
    const ctx = this.wheel.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, g.size, g.size);
    // The hue ring, a degree at a time (clockwise from the top, as CSP's).
    for (let degree = 0; degree < 360; degree++) {
      const from = ((degree - 90 - 0.6) * Math.PI) / 180;
      const to = ((degree - 90 + 0.6) * Math.PI) / 180;
      ctx.beginPath();
      ctx.arc(g.centre, g.centre, g.outer, from, to);
      ctx.arc(g.centre, g.centre, g.inner, to, from, true);
      ctx.closePath();
      ctx.fillStyle = `hsl(${degree}, 100%, 50%)`;
      ctx.fill();
    }
    // The square: the hue, whiter to the left, darker downwards.
    const [h, s, v] = this.hsv;
    ctx.fillStyle = toHex(hsvToRgb([h, 1, 1]));
    ctx.fillRect(g.x0, g.y0, g.side, g.side);
    const white = ctx.createLinearGradient(g.x0, 0, g.x0 + g.side, 0);
    white.addColorStop(0, "#ffffff");
    white.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = white;
    ctx.fillRect(g.x0, g.y0, g.side, g.side);
    const dark = ctx.createLinearGradient(0, g.y0, 0, g.y0 + g.side);
    dark.addColorStop(0, "rgba(0,0,0,0)");
    dark.addColorStop(1, "#000000");
    ctx.fillStyle = dark;
    ctx.fillRect(g.x0, g.y0, g.side, g.side);
    // Where the colour is: on the ring and in the square.
    const angle = ((h - 90) * Math.PI) / 180;
    const ring = (g.outer + g.inner) / 2;
    const mark = (x: number, y: number, r: number) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#000000";
      ctx.stroke();
    };
    mark(g.centre + Math.cos(angle) * ring, g.centre + Math.sin(angle) * ring, (g.outer - g.inner) / 2);
    mark(g.x0 + s * g.side, g.y0 + (1 - v) * g.side, 5);
  }

  private bindWheel(): void {
    let part: "ring" | "square" | null = null;
    const at = (event: PointerEvent) => {
      const rect = this.wheel.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top] as const;
    };
    const apply = (event: PointerEvent) => {
      const g = this.geometry();
      const [x, y] = at(event);
      let [h, s, v] = this.hsv;
      if (part === "ring") {
        h = ((Math.atan2(y - g.centre, x - g.centre) * 180) / Math.PI + 90 + 360) % 360;
      } else if (part === "square") {
        s = Math.min(1, Math.max(0, (x - g.x0) / g.side));
        v = Math.min(1, Math.max(0, 1 - (y - g.y0) / g.side));
      }
      this.hsv = [h, s, v];
      if (!drawColors.setMain(toHex(hsvToRgb(this.hsv)))) this.drawWheel();
    };
    this.wheel.addEventListener("pointerdown", (event) => {
      const g = this.geometry();
      const [x, y] = at(event);
      const r = Math.hypot(x - g.centre, y - g.centre);
      if (r >= g.inner - 2 && r <= g.outer + 2) part = "ring";
      else if (x >= g.x0 - 4 && x <= g.x0 + g.side + 4 && y >= g.y0 - 4 && y <= g.y0 + g.side + 4) part = "square";
      else return;
      this.wheel.setPointerCapture(event.pointerId);
      apply(event);
    });
    this.wheel.addEventListener("pointermove", (event) => {
      if (part) apply(event);
    });
    const end = () => {
      part = null;
    };
    this.wheel.addEventListener("pointerup", end);
    this.wheel.addEventListener("pointercancel", end);
  }

  // --- スライダー ---------------------------------------------------------------

  private renderSliders(): void {
    const rgb = parseHex(drawColors.main) ?? [0, 0, 0];
    const rows =
      this.mode === "hsv"
        ? ([
            ["H", 0, 359, Math.round(this.hsv[0]), (n: number) => this.setHsv([n, this.hsv[1], this.hsv[2]])],
            ["S", 0, 100, Math.round(this.hsv[1] * 100), (n: number) => this.setHsv([this.hsv[0], n / 100, this.hsv[2]])],
            ["V", 0, 100, Math.round(this.hsv[2] * 100), (n: number) => this.setHsv([this.hsv[0], this.hsv[1], n / 100])],
          ] as const)
        : ([
            ["R", 0, 255, rgb[0], (n: number) => drawColors.setMain(toHex([n, rgb[1], rgb[2]]))],
            ["G", 0, 255, rgb[1], (n: number) => drawColors.setMain(toHex([rgb[0], n, rgb[2]]))],
            ["B", 0, 255, rgb[2], (n: number) => drawColors.setMain(toHex([rgb[0], rgb[1], n]))],
          ] as const);
    // While a slider is dragged it stays as it is (only its numbers change).
    const existing = [...this.sliders.querySelectorAll<HTMLInputElement>("input[type=range]")];
    if (existing.length === 3 && this.sliders.dataset.mode === this.mode) {
      rows.forEach(([, , , value], i) => {
        existing[i].value = String(value);
        const number = existing[i].nextElementSibling as HTMLInputElement;
        if (document.activeElement !== number) number.value = String(value);
      });
      return;
    }
    this.sliders.dataset.mode = this.mode;
    this.sliders.replaceChildren(
      ...rows.map(([label, min, max, value, set]) => {
        const row = node("label", "color-slider");
        const range = node("input");
        range.type = "range";
        range.min = String(min);
        range.max = String(max);
        range.value = String(value);
        range.setAttribute("aria-label", label);
        const number = node("input");
        number.type = "number";
        number.min = String(min);
        number.max = String(max);
        number.value = String(value);
        number.setAttribute("aria-label", `${label} の値`);
        number.addEventListener("keydown", (event) => event.stopPropagation());
        range.addEventListener("input", () => set(Number(range.value)));
        number.addEventListener("change", () => set(Math.min(max, Math.max(min, Number(number.value) || 0))));
        row.append(node("span", "", label), range, number);
        return row;
      }),
    );
  }

  private setHsv(hsv: Hsv): void {
    this.hsv = hsv;
    if (!drawColors.setMain(toHex(hsvToRgb(hsv)))) this.update();
  }

  // --- 履歴とカラーセット ---------------------------------------------------------

  private swatch(color: string, title: string, remove?: () => void): HTMLButtonElement {
    const button = node("button", "color-swatch");
    button.type = "button";
    button.style.background = color;
    button.title = remove ? `${title}（右クリックで外す）` : title;
    button.setAttribute("aria-label", title);
    button.dataset.color = color;
    button.classList.toggle("current", color === drawColors.main);
    button.addEventListener("click", () => {
      drawColors.setMain(color);
      this.host.status(`描画色: ${title}`);
    });
    if (remove)
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        remove();
      });
    return button;
  }

  private renderSwatches(box: HTMLElement, colors: readonly string[], empty: string): void {
    box.replaceChildren(...(colors.length ? colors.map((c) => this.swatch(c, c)) : [node("span", "color-empty", empty)]));
  }

  private renderSets(): void {
    const project = this.host.project();
    const cast = (project?.characters ?? []).filter((c) => c.color && normalHex(c.color));
    const sign = JSON.stringify([drawColors.main, drawColors.swatches, cast.map((c) => [c.name, c.color])]);
    if (sign === this.castSign) return;
    this.castSign = sign;
    const section = (title: string, buttons: HTMLElement[], extra?: HTMLElement) => {
      const head = node("div", "color-heading", title);
      if (extra) head.append(extra);
      const box = node("div", "color-swatches");
      box.append(...buttons);
      return [head, box];
    };
    const add = node("button", "color-add", "＋");
    add.type = "button";
    add.title = "いまの描画色を自分の色に足す";
    add.addEventListener("click", () => {
      if (drawColors.addSwatch()) this.host.status(`自分の色に ${drawColors.main} を足しました`);
    });
    const own = drawColors.swatches.map((c) => this.swatch(c, c, () => drawColors.removeSwatch(c)));
    this.sets.replaceChildren(
      ...section(
        "基本色",
        BASIC_COLORS.map((c) => this.swatch(c, c)),
      ),
      ...(cast.length
        ? section(
            "人物の色",
            cast.map((c) => {
              const button = this.swatch(normalHex(c.color!)!, c.name);
              button.classList.add("named");
              return button;
            }),
          )
        : []),
      ...section("自分の色", own.length ? own : [node("span", "color-empty", "＋で今の色を足せます")], add),
    );
  }

  // --- スポイト -----------------------------------------------------------------

  /** Pick a colour off the page with the next click. */
  pick(): void {
    this.dropper.classList.add("active");
    this.host.status("スポイト: 紙面をクリックするとその色を描画色にします（Esc でやめる）");
    this.host.pickFromPage((color) => {
      this.dropper.classList.remove("active");
      if (color) {
        drawColors.setMain(color);
        this.host.status(`スポイト: 描画色を ${color} にしました`);
      } else this.host.status("スポイトをやめました");
    });
  }
}

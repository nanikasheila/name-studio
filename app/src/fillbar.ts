// The fill tool's bar: its sub tools as CSP has them (塗りつぶし, 囲って塗る,
// 投げなわ塗り, 塗り残し部分に塗る), the tone, and the settings of the sub tool
// in hand (隙間閉じ, ベクターの中心で塗り止まり, 領域拡縮, 参照, the brush of
// 塗り残し). What is chosen is kept on this computer.
import { $, element } from "./dom";
import type { PageEditor, Tool } from "./editor";
import {
  BRUSH_MM,
  FILL_WAY_HINTS,
  FILL_WAY_LABELS,
  FILL_WAYS,
  GAP_STEPS,
  MAX_GROW_MM,
  REFER_LABELS,
  nextFillWay,
  type AreaWay,
  type FillWay,
} from "./fillsettings";
import type { FillRefer } from "./fillregion";
import type { FillTone } from "./model";
import { saveFillSettings } from "./prefs";
import { TONE_LABELS } from "./strokes";

export interface FillBarHost {
  readonly editor: PageEditor;
  status(message: string): void;
  setTool(tool: Tool): void;
}

/** Short names for the buttons (the full name is in the title). */
const SHORT: Record<FillWay, string> = { click: "クリック", enclose: "囲う", lasso: "投げなわ", remaining: "塗り残し" };

const ICONS: Record<FillWay, string> = {
  click: '<path d="M4 9l5-5 7 7-5 5z"/><path d="M16 11c1.2 1.8 1.8 3 1.8 3.8a1.8 1.8 0 0 1-3.6 0c0-.8.6-2 1.8-3.8z" class="fill"/>',
  enclose: '<path d="M4 10c0-4 3-6.5 6.5-6.5S17 6 17 10s-3 6.5-6.5 6.5" stroke-dasharray="2 2"/><rect x="7" y="7.5" width="6" height="5" class="fill"/>',
  lasso: '<path d="M4 9c0-3.5 3-5.5 6.5-5.5S17 5.5 17 9s-3 5.5-6.5 5.5S4 12.5 4 9z" class="fill"/><path d="M6 13.5c-1 1.5-.5 3.5 1.5 3.5"/>',
  remaining: '<path d="M3 16c3-1 5-4 7-7s4-5 7-6"/><circle cx="7.5" cy="11.5" r="1.2" class="fill"/><circle cx="12.5" cy="6.5" r="1.2" class="fill"/>',
};

const TONE_TITLES: Record<FillTone, string> = { black: "黒（ベタ）", gray: "グレー（トーンの代わり）", white: "白（ホワイトで消す）" };

export class FillBar {
  constructor(private readonly host: FillBarHost) {}

  private get fill() {
    return this.host.editor.fill;
  }

  /** Show the bar for the fill tool (and hide it for the others). */
  render(): void {
    const bar = $("fill-bar");
    const on = this.host.editor.tool === "fill";
    bar.classList.toggle("off", !on);
    if (!on) return;
    bar.replaceChildren(this.ways(), this.tones(), ...this.properties());
    $("tool-hint").textContent = FILL_WAY_HINTS[this.fill.way];
  }

  /** Take up a sub tool (and the fill tool with it). */
  setWay(way: FillWay): void {
    this.fill.way = way;
    this.save();
    if (this.host.editor.tool !== "fill") this.host.setTool("fill");
    else this.render();
    this.host.status(`塗り: ${FILL_WAY_LABELS[way]}`);
  }

  /** G again: the next sub tool. */
  nextWay(): void {
    this.setWay(nextFillWay(this.fill.way));
  }

  setTone(tone: FillTone): void {
    this.fill.tone = tone;
    this.save();
    if (this.host.editor.tool !== "fill") this.host.setTool("fill");
    else this.render();
    this.host.status(`塗り: ${TONE_LABELS[tone]}`);
  }

  private save(): void {
    saveFillSettings(this.fill);
  }

  private ways(): HTMLElement {
    const group = this.group("segmented fill-ways", "塗りのサブツール");
    for (const way of FILL_WAYS) {
      const button = element("button", { id: `fill-${way}`, className: `with-icon${way === this.fill.way ? " active" : ""}`, title: `${FILL_WAY_LABELS[way]}: ${FILL_WAY_HINTS[way]}（G を押すたびに切り替え）` });
      button.innerHTML = `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true">${ICONS[way]}</svg>`;
      button.append(SHORT[way]);
      button.addEventListener("click", () => this.setWay(way));
      group.append(button);
    }
    return group;
  }

  private tones(): HTMLElement {
    const group = this.group("segmented", "塗りの色");
    for (const tone of ["black", "gray", "white"] as const) {
      const button = element("button", { id: `fill-${tone}`, className: tone === this.fill.tone ? "active" : "", title: TONE_TITLES[tone] });
      const swatch = element("i", { className: `tone ${tone}` });
      button.append(swatch, TONE_LABELS[tone].replace(/（.*/, ""));
      button.addEventListener("click", () => this.setTone(tone));
      group.append(button);
    }
    return group;
  }

  /** The settings of the sub tool in hand (CSP's ツールプロパティ); 投げなわ塗り has none. */
  properties(): HTMLElement[] {
    const way = this.fill.way;
    const changed = (message: string) => {
      this.save();
      this.host.status(`${FILL_WAY_LABELS[way]}: ${message}`);
    };
    const under = element("input", { type: "checkbox", id: "fill-under", checked: this.fill.under[way] });
    under.addEventListener("change", () => {
      this.fill.under[way] = under.checked;
      changed(under.checked ? "ラフ線の下に塗る" : "ラフ線の上に塗る");
    });
    const underLabel = element("label", { className: "check", title: "ラフ線の下に塗る（CSP では「塗り（線の下）」レイヤー）。切ると線の上に塗り、線も隠れます（ホワイトで消すとき）" });
    underLabel.append(under, " 線の下");
    if (way === "lasso") return [underLabel];
    const options = this.fill.options[way as AreaWay];
    const parts: HTMLElement[] = [underLabel];
    if (way === "remaining") {
      const size = this.number("fill-brush", "ブラシ", this.fill.brushMm, BRUSH_MM[0], BRUSH_MM[1], 0.5, "なぞるブラシの大きさ（mm）", (value) => {
        this.fill.brushMm = value;
        changed(`ブラシ ${value} mm`);
      });
      parts.push(size);
    }
    const gap = element("select", { id: "fill-gap", title: "隙間閉じ: 線の途切れがこの幅までなら閉じているものとして塗る" });
    for (const step of GAP_STEPS) gap.append(element("option", { value: String(step.mm), textContent: step.label }));
    gap.value = String(GAP_STEPS.find((step) => step.mm === options.gapMm)?.mm ?? GAP_STEPS[1].mm);
    gap.addEventListener("change", () => {
      options.gapMm = Number(gap.value);
      changed(`隙間閉じ ${GAP_STEPS.find((step) => step.mm === options.gapMm)?.label ?? ""}`);
    });
    parts.push(this.labelled("隙間閉じ", gap));
    const center = element("input", { type: "checkbox", id: "fill-center", checked: options.center });
    center.addEventListener("change", () => {
      options.center = center.checked;
      changed(center.checked ? "線の中心まで塗る" : "線の手前で止める");
    });
    const centerLabel = element("label", { className: "check", title: "ベクターの中心で塗り止まり: 線の下、線の中心まで塗って、線との間に隙間を残さない（切ると線の手前で止まる）" });
    centerLabel.append(center, " 線の中心まで");
    parts.push(centerLabel);
    parts.push(
      this.number("fill-grow", "拡縮", options.growMm, -MAX_GROW_MM, MAX_GROW_MM, 0.1, "領域拡縮: 塗る範囲をこの幅（mm）だけ広げる。マイナスで狭める", (value) => {
        options.growMm = value;
        changed(`領域拡縮 ${value} mm`);
      }),
    );
    const refer = element("select", { id: "fill-refer", title: "参照: どの線で閉じた範囲を塗るか（塗りはどれでも境目になります。フキダシは塗りの上に描かれるので境目にしません）" });
    for (const [value, label] of Object.entries(REFER_LABELS)) refer.append(element("option", { value, textContent: label }));
    refer.value = options.refer;
    refer.addEventListener("change", () => {
      options.refer = refer.value as FillRefer;
      changed(`参照 ${REFER_LABELS[options.refer]}`);
    });
    parts.push(this.labelled("参照", refer));
    return parts;
  }

  private group(className: string, label: string): HTMLElement {
    const group = element("div", { className });
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    return group;
  }

  private labelled(text: string, control: HTMLElement): HTMLElement {
    const label = element("label", { className: "size", title: control.title });
    label.append(element("span", { textContent: text }), control);
    return label;
  }

  private number(id: string, text: string, value: number, min: number, max: number, step: number, title: string, set: (value: number) => void): HTMLElement {
    const input = element("input", { type: "number", id, min: String(min), max: String(max), step: String(step), value: String(value) });
    input.addEventListener("change", () => {
      const next = Number(input.value);
      if (!Number.isFinite(next)) return;
      const clamped = Math.round(Math.min(max, Math.max(min, next)) * 100) / 100;
      input.value = String(clamped);
      set(clamped);
    });
    const label = element("label", { className: "size", title });
    label.append(element("span", { textContent: text }), input, " mm");
    return label;
  }
}

// The 背景 tool's bar: what a press marks (アイレベル, 消失点, 物, 消す), the
// name the next 物 gets, and whether 背景の指示 show with the other tools too.
import { $, element } from "../platform/dom";
import type { PageEditor } from "./editor";
import { BACKGROUND_MODE_LABELS, backgroundPen, type BackgroundMode } from "./toolbackground";

export interface BackgroundBarHost {
  readonly editor: PageEditor;
  status(message: string): void;
}

const MODE_TITLES: Record<BackgroundMode, string> = {
  horizon: "アイレベル（カメラの高さ・地平線）をドラッグで引く。クリックだけならコマを横切る水平の線",
  vanishing: "消失点をクリックで置く（コマの外にも置ける。3 つまで）",
  object: "物が立つ所をドラッグで囲む。右の欄の名前が付く",
  erase: "押した所の近くの指示を消す",
};

export class BackgroundBar {
  constructor(private readonly host: BackgroundBarHost) {}

  render(): void {
    const bar = $("background-bar");
    const on = this.host.editor.tool === "background";
    bar.classList.toggle("off", !on);
    if (!on) return;
    const modes = element("div", { className: "segmented", role: "group", ariaLabel: "背景の指示" });
    for (const mode of Object.keys(BACKGROUND_MODE_LABELS) as BackgroundMode[]) {
      const button = element("button", { type: "button", title: MODE_TITLES[mode] }, BACKGROUND_MODE_LABELS[mode]);
      button.classList.toggle("active", backgroundPen.mode === mode);
      button.setAttribute("aria-pressed", String(backgroundPen.mode === mode));
      button.dataset.bgMode = mode;
      button.addEventListener("click", () => {
        backgroundPen.mode = mode;
        this.render();
        this.host.status(MODE_TITLES[mode]);
      });
      modes.append(button);
    }
    const label = element("input", { type: "text", placeholder: "物の名前（例: バン 横向き）", ariaLabel: "物の名前", id: "background-label" });
    label.value = backgroundPen.label;
    label.addEventListener("input", () => {
      backgroundPen.label = label.value;
    });
    label.addEventListener("keydown", (event) => event.stopPropagation());
    const shown = element("input", { type: "checkbox" });
    shown.checked = backgroundPen.alwaysShown;
    shown.addEventListener("change", () => {
      backgroundPen.alwaysShown = shown.checked;
      this.host.editor.draw();
    });
    const always = element(
      "label",
      { className: "check", title: "背景の指示をほかの道具のときも出す（書き出しには入りません）" },
      shown,
      " いつも出す",
    );
    bar.replaceChildren(modes, label, always);
  }
}

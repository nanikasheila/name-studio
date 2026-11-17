// The 背景 tool's bar: the panel's 透視 (なし・1点・2点・3点, like a
// perspective ruler), what a press marks (アイレベル, 線 with its axis X・Y・Z,
// 消失点, 物, 消す), the name the next 物 gets, and whether 背景の指示 show with
// the other tools too.
import { $, element } from "../platform/dom";
import type { Project } from "../model/model";
import { backgroundOf, findPanel, panelLabel, renameObject } from "../domain/background";
import { AXIS_COLORS, PERSPECTIVES, PERSPECTIVE_LABELS, PERSPECTIVE_TITLES, perspectiveOf, setPerspective } from "../domain/bgruler";
import type { PageEditor } from "./editor";
import { BACKGROUND_MODE_LABELS, backgroundPen, type BackgroundMode, type GuideAxis } from "./toolbackground";

export interface BackgroundBarHost {
  readonly editor: PageEditor;
  project(): Project | null;
  edit(change: (project: Project) => void): void;
  status(message: string): void;
}

const MODE_TITLES: Record<BackgroundMode, string> = {
  horizon:
    "アイレベル（カメラの高さ・地平線）をドラッグで引く。クリックだけならコマを横切る水平の線。線の上をドラッグで上下に動かす（消失点は線に沿って動く）",
  line: "コマの中の辺（建物・床・道）に沿って X・Y・Z の線を引く。線とアイレベルの交わる所が消失点（コマの外でも）。線の端はドラッグで動かせる",
  vanishing: "消失点をクリックで置く（コマの外にも）。消失点はドラッグで動かせる（アイレベルも一緒に動く）",
  object: "物が立つ所をドラッグで囲む。右の名前が付く",
  erase: "押した所の近くの指示を消す（アイレベルを消すと定規ごと）",
};

const AXIS_TITLES: Record<GuideAxis, string> = {
  X: "X の線: 消失点 1（アイレベルの上）へ向かう辺",
  Y: "Y の線: 消失点 2（アイレベルの上）へ向かう辺。2点透視になる",
  Z: "Z の線: 縦の辺（3点透視の消失点 3 へ）。2 本の交わる所が消失点 3",
};

export class BackgroundBar {
  constructor(private readonly host: BackgroundBarHost) {
    backgroundPen.changed = () => this.render();
  }

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
    const parts: HTMLElement[] = [this.perspective(), modes];
    if (backgroundPen.mode === "line") parts.push(this.axes());
    if (backgroundPen.mode === "object") parts.push(this.objectName());
    const shown = element("input", { type: "checkbox" });
    shown.checked = backgroundPen.alwaysShown;
    shown.addEventListener("change", () => {
      backgroundPen.alwaysShown = shown.checked;
      this.host.editor.draw();
    });
    parts.push(
      element("label", { className: "check", title: "背景の指示をほかの道具のときも出す（書き出しには入りません）" }, shown, " いつも出す"),
    );
    bar.replaceChildren(...parts);
  }

  /** 透視 of the panel marked last: choosing lays out the points and lines (beyond the panel's sides) to drag into place. */
  private perspective(): HTMLElement {
    const project = this.host.project();
    const found = project && backgroundPen.panel ? findPanel(project, backgroundPen.panel) : null;
    const current = found ? perspectiveOf(backgroundOf(found.panel)) : null;
    const group = element("div", { className: "segmented", role: "group", ariaLabel: "透視" });
    group.append(
      element(
        "span",
        { className: "hint", title: found ? "このコマの透視の定規" : "コマを押すと、そのコマの透視を選べます" },
        found ? `${panelLabel(project!, found.page, found.panel)} 透視` : "透視",
      ),
    );
    for (const points of PERSPECTIVES) {
      const button = element("button", { type: "button", title: PERSPECTIVE_TITLES[points] }, PERSPECTIVE_LABELS[points]);
      button.dataset.perspective = String(points);
      button.classList.toggle("active", current === points);
      button.setAttribute("aria-pressed", String(current === points));
      button.disabled = !found;
      button.addEventListener("click", () => {
        if (!found) return;
        this.host.edit((project) => {
          const panel = findPanel(project, found.panel.id)?.panel;
          if (panel) setPerspective(panel, points);
        });
        if (points && backgroundPen.mode === "object") backgroundPen.mode = "line";
        this.render();
        this.host.editor.draw();
        this.host.status(
          points
            ? `${PERSPECTIVE_LABELS[points]}透視にしました。消失点・線の端・アイレベルをドラッグして、ラフの線に合わせます`
            : "透視の定規を外しました",
        );
      });
      group.append(button);
    }
    return group;
  }

  /** The name of the 物 picked last (changed as typed, one undo step), else the name the next one gets. */
  private objectName(): HTMLElement {
    const project = this.host.project();
    const found = project && backgroundPen.panel ? findPanel(project, backgroundPen.panel) : null;
    const picked = found ? backgroundOf(found.panel).objects?.find((one) => one.id === backgroundPen.object) : undefined;
    const label = element("input", {
      type: "text",
      placeholder: picked ? "選んだ物の名前" : "次に置く物の名前（例: バン 横向き）",
      ariaLabel: picked ? "選んだ物の名前" : "物の名前",
      title: picked
        ? "選んだ物の名前（物はドラッグで動かす・角で大きさを変える）"
        : "次に置く物の名前。置いた物は、押して選ぶとここで名前を直せる",
      id: "background-label",
    });
    label.value = picked ? picked.label : backgroundPen.label;
    label.addEventListener("input", () => {
      backgroundPen.label = label.value;
    });
    label.addEventListener("change", () => {
      if (!picked || !found) return;
      this.host.edit((project) => {
        const panel = findPanel(project, found.panel.id)?.panel;
        if (panel) renameObject(panel, picked.id, label.value);
      });
      this.host.editor.draw();
      this.host.status(`物の名前を「${label.value.trim() || "物"}」にしました`);
    });
    label.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") label.blur();
    });
    return element("span", { className: "bg-object-name" }, picked ? element("span", { className: "hint" }, "選んだ物") : "", label);
  }

  /** The axis the next 線 is for (Z only means something with 3点). */
  private axes(): HTMLElement {
    const group = element("div", { className: "segmented", role: "group", ariaLabel: "線の向き" });
    for (const axis of ["X", "Y", "Z"] as GuideAxis[]) {
      const button = element("button", { type: "button", title: AXIS_TITLES[axis] }, axis);
      button.style.color = AXIS_COLORS[axis];
      button.dataset.bgAxis = axis;
      button.classList.toggle("active", backgroundPen.axis === axis);
      button.setAttribute("aria-pressed", String(backgroundPen.axis === axis));
      button.addEventListener("click", () => {
        backgroundPen.axis = axis;
        this.render();
        this.host.status(AXIS_TITLES[axis]);
      });
      group.append(button);
    }
    return group;
  }
}

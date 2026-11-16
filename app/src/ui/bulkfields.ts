// まとめて設定 in the right panel: with several things picked (a 範囲選択),
// each kind among them (セリフ・コマ・線・塗り) gets the fields one of them
// has on its own, set for all at once. A field whose things differ is shown
// mixed (「いろいろ」, an empty number, a half-ticked box); changing it sets
// them all alike, as one undo step.
import { SHAPE_LABELS, TAIL_LABELS } from "../domain/balloon";
import {
  bleedPanels,
  choiceKey,
  fitBalloons,
  lineFlag,
  type LineFlag,
  type On,
  type PickedThings,
  pickedThings,
  setLinesFlag,
  setLinesFont,
  setLinesShape,
  setLinesSize,
  setLinesSpeaker,
  setLinesType,
  setPanelsField,
  setPanelsLineMm,
  setStrokesColor,
  setStrokesOver,
  setStrokesWidth,
  setTailsStyle,
  shared,
  stackPanels,
  strokeLayerId,
  strokeSort,
  strokesToLayer,
  takesFlag,
  tidyPicked,
  tiltPanels,
} from "../domain/bulk";
import { addCharacter } from "../domain/cast";
import { normalHex, ownColor } from "../domain/color";
import { BORDER_LABELS, EFFECT_LABELS, FILL_LABELS, isBled, SIDE_LABELS, type Side } from "../domain/koma";
import { isMark, markLayersOf, roughLayersOf } from "../domain/roughlayers";
import { MAX_LINE_MM, MIN_LINE_MM, styleLineMm } from "../domain/style";
import { TONE_LABELS } from "../domain/strokes";
import type { ItemRef } from "../domain/transform";
import type { LineChoice } from "../domain/linelook";
import type {
  BalloonShape,
  Fill,
  FillTone,
  Line,
  Panel,
  PanelBorder,
  PanelEffect,
  PanelFill,
  Project,
  Stroke,
  TailStyle,
} from "../model/model";
import { element } from "../platform/dom";
import { fontField } from "./fontpicker";
import { lineChoiceSelect } from "./lookfields";

/** What the fields need from the inspector around them. */
export interface BulkHost {
  project(): Project | null;
  /** One undoable change. */
  edit(change: (project: Project) => void): void;
  status(message: string): void;
  /** A number edited live (typing, arrows, the wheel); a pause makes it one undo step. */
  liveNumber(field: HTMLInputElement, apply: (value: number) => void): void;
  readonly editor: { select(selection: null): void };
}

/** The value a mixed drop-down shows until something is chosen. */
const MIXED = "__mixed";
/** Words for a field whose things differ. */
export const MIXED_LABEL = "（いろいろ）";

/** 太さ of a rough line (mm). */
const MIN_STROKE_MM = 0.05;
const MAX_STROKE_MM = 30;

/** A drop-down of `labels` showing the value all have, or 「いろいろ」 until one is chosen. */
function pick<T extends string>(
  labels: Record<T, string>,
  current: { value: T } | null,
  change: (value: T) => void,
  skip: T[] = [],
): HTMLSelectElement {
  const select = element("select");
  if (!current) select.append(element("option", { value: MIXED, textContent: MIXED_LABEL }));
  for (const [key, label] of Object.entries(labels) as [T, string][])
    if (!skip.includes(key) || key === current?.value) select.append(element("option", { value: key, textContent: label }));
  select.value = current ? current.value : MIXED;
  select.classList.toggle("mixed", !current);
  select.addEventListener("change", () => {
    if (select.value !== MIXED) change(select.value as T);
  });
  return select;
}

/** A tick box for many: ticked, not, or half-ticked when they differ. */
function check(label: string, values: readonly boolean[], set: (on: boolean) => void, title = ""): HTMLLabelElement {
  const same = shared(values);
  const box = element("input", { type: "checkbox", checked: same?.value ?? false, indeterminate: !same, disabled: !values.length });
  box.addEventListener("change", () => set(box.checked));
  const row = element("label", { className: `inline${same ? "" : " mixed"}`, title }, box, label);
  return row;
}

/** A number for many: the one they all have, or empty (「いろいろ」) when they differ. */
function amount(
  host: BulkHost,
  props: { min: string; max: string; step: string; title: string; placeholder?: string },
  current: { value: number | undefined } | null,
  apply: (value: number) => void,
): HTMLInputElement {
  const field = element("input", { type: "number", ...props });
  if (current) {
    field.value = current.value === undefined ? "" : String(Math.round(current.value * 100) / 100);
    host.liveNumber(field, apply);
  } else {
    // Differing: typed in (Enter or leaving the field) sets them all; the wheel has nothing to count from.
    field.placeholder = MIXED_LABEL;
    field.classList.add("mixed");
    field.addEventListener("change", () => {
      const value = Number(field.value);
      if (field.value.trim() && Number.isFinite(value) && value > 0) {
        const clamped = Math.min(Number(props.max), Math.max(Number(props.min), value));
        host.edit(() => apply(clamped));
      }
    });
  }
  return field;
}

/** The fields for what is picked, kind by kind. */
export class BulkFields {
  constructor(
    private readonly host: BulkHost,
    private readonly pageId: string,
    private readonly items: readonly ItemRef[],
  ) {}

  /** What is picked, found again in the name as it is now. */
  private things(project: Project): PickedThings {
    return pickedThings(project, this.pageId, this.items);
  }

  /** One undoable change to what is picked. */
  private change(what: (things: PickedThings, project: Project) => void): void {
    this.host.edit((project) => what(this.things(project), project));
  }

  /** A change made live (a number field): straight on the name, recorded by the field. */
  private live(what: (things: PickedThings, project: Project) => void): void {
    const project = this.host.project();
    if (project) what(this.things(project), project);
  }

  /** A section per kind picked, each headed with how many. */
  sections(project: Project): HTMLElement[] {
    const found = this.things(project);
    const parts: HTMLElement[] = [];
    const section = (name: string, kind: string, fields: HTMLElement[]) =>
      parts.push(element("section", { className: `bulk-kind bulk-${kind}` }, element("h3", { textContent: name }), ...fields));
    if (found.lines.length) section(`セリフ ${found.lines.length} 個`, "line", this.lineFields(project, found.lines));
    if (found.panels.length) section(`コマ ${found.panels.length} つ`, "panel", this.panelFields(project, found.panels));
    if (found.strokes.length) section(`線 ${found.strokes.length} 本`, "stroke", this.strokeFields(project, found.strokes));
    if (found.fills.length) section(`塗り ${found.fills.length} つ`, "fill", this.fillFields(found.fills.map(({ item }) => item)));
    if (!parts.length) return [];
    return [
      element(
        "div",
        { id: "inspector-bulk", className: "bulk" },
        element("p", {
          className: "bulk-note",
          textContent: "まとめて設定: 変えると選んだもの全部がそろいます（値がちがう項目は「いろいろ」・空欄・半分のチェック）。",
        }),
        ...parts,
      ),
    ];
  }

  /** The 種類 drop-down for the lines (also in the bar beside them). */
  kindSelect(project: Project, lines: readonly Line[]): HTMLSelectElement {
    const select: HTMLSelectElement = lineChoiceSelect(project, lines[0], (choice: LineChoice) => {
      // 「いろいろ」 is never chosen again once left.
      if (select.value === MIXED) return;
      this.change((things, p) =>
        setLinesType(
          p,
          things.lines.map(({ item }) => item),
          choice,
        ),
      );
    });
    if (!shared(lines.map(choiceKey))) {
      select.prepend(element("option", { value: MIXED, textContent: MIXED_LABEL }));
      select.value = MIXED;
      select.classList.add("mixed");
    }
    return select;
  }

  /** セリフ: what one line has in the panel, for all. */
  lineFields(project: Project, picked: readonly On<Line>[]): HTMLElement[] {
    const lines = picked.map(({ item }) => item);
    const all = (set: (lines: Line[], project: Project) => void) =>
      this.change((things, p) =>
        set(
          things.lines.map(({ item }) => item),
          p,
        ),
      );
    const speakerLabels: Record<string, string> = { "": "（なし）" };
    for (const character of project.characters) speakerLabels[character.id] = character.name;
    speakerLabels.__new = "新しい人物…";
    const speaker = pick(speakerLabels, shared(lines.map((line) => line.speaker ?? "")), (value) =>
      all((targets, p) => {
        if (value === "__new") {
          setLinesSpeaker(p, targets, addCharacter(p, `人物${p.characters.length + 1}`).id);
          this.host.status("人物を足しました。名前は左の「人物」で変えられます");
        } else setLinesSpeaker(p, targets, value || undefined);
      }),
    );
    const size = amount(
      this.host,
      { min: "4", max: "72", step: "0.5", title: "文字の大きさ（pt）。全部この大きさに" },
      shared(lines.map((line) => line.fontSizePt)),
      (pt) =>
        this.live((things) =>
          setLinesSize(
            things.lines.map(({ item }) => item),
            pt,
          ),
        ),
    );
    if (!size.classList.contains("mixed"))
      size.addEventListener("change", () => this.host.status(`文字の大きさを ${size.value} pt にしました`));
    const flag = (label: string, which: LineFlag, title = "") => {
      const takers = lines.filter((line) => takesFlag(line, which));
      return check(
        label,
        takers.map((line) => lineFlag(line, which)),
        (on) => all((targets) => setLinesFlag(targets, which, on)),
        title,
      );
    };
    const fonts = shared(lines.map((line) => line.font ?? ""));
    const font = fontField(
      fonts?.value ?? "",
      fonts ? "種類ごとのフォント" : `${MIXED_LABEL}（× で種類ごとに戻す）`,
      (name) => all((targets) => setLinesFont(targets, name)),
      "選んだセリフ全部のフォント。× で指定をやめて種類ごとのフォントに",
      lines[0].text.replace(/\s+/g, " ").slice(0, 40),
      !fonts,
    );
    const shape = pick(
      SHAPE_LABELS,
      shared(lines.map((line) => line.balloonShape ?? "auto")),
      (value: BalloonShape) => all((targets) => setLinesShape(targets, value)),
      ["custom"],
    );
    const mask = flag("コマ枠でマスク（枠の外を隠す）", "mask", "コマの中にあるセリフだけ");
    const fitBalloon = element("button", {
      textContent: "フキダシを文字に合わせる",
      title: "フキダシだけ変えた大きさをやめて、文字に合った大きさに戻す（そうしたセリフ全部）",
      disabled: !lines.some((line) => line.balloonScale),
    });
    fitBalloon.addEventListener("click", () => all((targets) => fitBalloons(targets)));
    const tails = lines.flatMap((line) => line.tails ?? []);
    const tailStyle = pick(TAIL_LABELS, shared(tails.map((tail) => tail.style ?? "wedge")), (value: TailStyle) =>
      all((targets) => setTailsStyle(targets, value)),
    );
    tailStyle.disabled = !tails.length;
    return [
      element(
        "div",
        { className: "row" },
        element("label", {}, "種類", this.kindSelect(project, lines)),
        element("label", {}, "話者", speaker),
      ),
      element("div", { className: "row" }, element("label", {}, "文字の大きさ（pt）", size), flag("縦書き", "vertical")),
      element("div", { className: "row" }, flag("太字（強調）", "emphasis"), flag("白抜き", "inverted"), flag("白縁", "edge")),
      element("label", {}, "フォント", font),
      element(
        "div",
        { className: "row" },
        element("label", {}, "フキダシの形", shape),
        element("label", {}, `しっぽの形（${tails.length} 本）`, tailStyle),
      ),
      mask,
      fitBalloon,
    ];
  }

  /** コマ: the look of the panels and turning, stacking and tidying each. */
  panelFields(project: Project, picked: readonly On<Panel>[]): HTMLElement[] {
    const panels = picked.map(({ item }) => item);
    const all = (set: (panels: Panel[], project: Project) => void) =>
      this.change((things, p) =>
        set(
          things.panels.map(({ item }) => item),
          p,
        ),
      );
    const border = pick(BORDER_LABELS, shared(panels.map((p) => p.border ?? "solid")), (value: PanelBorder) =>
      all((targets) => setPanelsField(targets, "border", value, "solid")),
    );
    const fill = pick(FILL_LABELS, shared(panels.map((p) => p.fill ?? "none")), (value: PanelFill) =>
      all((targets) => setPanelsField(targets, "fill", value, "none")),
    );
    const effect = pick(EFFECT_LABELS, shared(panels.map((p) => p.effect ?? "none")), (value: PanelEffect) =>
      all((targets) => setPanelsField(targets, "effect", value, "none")),
    );
    const widths = shared(panels.map((p) => p.lineMm));
    const usual = shared(panels.map((p) => styleLineMm(p.border === "thick", project.style)));
    const width = element("input", {
      type: "number",
      min: String(MIN_LINE_MM),
      max: String(MAX_LINE_MM),
      step: "0.05",
      value: widths?.value === undefined ? "" : String(widths.value),
      placeholder: widths ? `${usual?.value ?? ""}（既定）` : MIXED_LABEL,
      title: "選んだコマ全部の枠線の太さ（mm）。空欄にすると作品の既定（設定 → コマ割り）",
      disabled: panels.every((p) => p.border === "none"),
    });
    width.classList.toggle("mixed", !widths);
    width.addEventListener("change", () => {
      const value = width.value.trim() === "" ? null : Number(width.value);
      all((targets, p) => setPanelsLineMm(p, targets, value));
    });
    const draft = check(
      "仮のコマ（あとで決める）",
      panels.map((p) => !!p.draft),
      (on) => all((targets) => setPanelsField(targets, "draft", on, false)),
    );
    const button = (label: string, title: string, run: (panels: Panel[], project: Project) => void) => {
      const b = element("button", { textContent: label, title });
      b.addEventListener("click", () => all(run));
      return b;
    };
    const tidy = element("button", {
      className: "small",
      textContent: "整える",
      title: "選んだコマの線をまっすぐに、まわりのコマ・基本枠にそろえ、コマ間を設定の幅にする（仮でなくなります）",
    });
    tidy.addEventListener("click", () => {
      let tidied = 0;
      this.change((things, p) => (tidied = tidyPicked(p, things.panels)));
      this.host.status(`コマ ${tidied} つを整えました（元に戻すは Ctrl+Z）`);
    });
    const bleeds = (["top", "right", "bottom", "left"] as Side[]).map((side) =>
      check(
        SIDE_LABELS[side],
        panels.map((p) => isBled(p, side, project.pageFormat)),
        (on) => all((targets, p) => bleedPanels(p, targets, side, on)),
      ),
    );
    return [
      element("div", { className: "row" }, element("label", {}, "枠線", border), element("label", {}, "塗り", fill)),
      element("label", {}, "枠線の太さ（mm）", width),
      element("label", {}, "背景の効果", effect),
      element("div", { className: "row" }, draft, tidy),
      element("h4", { textContent: "裁ち切り（ページの外まで）" }),
      element("div", { className: "row" }, ...bleeds),
      element(
        "div",
        { className: "row" },
        button("⟲ 2°", "それぞれ左に傾ける", (targets) => tiltPanels(targets, -2)),
        button("⟳ 2°", "それぞれ右に傾ける", (targets) => tiltPanels(targets, 2)),
      ),
      element(
        "div",
        { className: "row" },
        button("前へ", "それぞれ重なりで上にする", (targets) => stackPanels(targets, 1)),
        button("後ろへ", "それぞれ重なりで下にする", (targets) => stackPanels(targets, -1)),
      ),
    ];
  }

  /** 線（ラフ線・指示）: 太さ, 色, レイヤー, はみ出し. */
  strokeFields(project: Project, picked: readonly On<Stroke>[]): HTMLElement[] {
    const strokes = picked.map(({ item }) => item);
    const all = (set: (strokes: Stroke[], project: Project) => void) =>
      this.change((things, p) =>
        set(
          things.strokes.map(({ item }) => item),
          p,
        ),
      );
    const width = amount(
      this.host,
      { min: String(MIN_STROKE_MM), max: String(MAX_STROKE_MM), step: "0.05", title: "線の太さ（mm）。全部この太さに" },
      shared(strokes.map((s) => s.widthMm)),
      (mm) =>
        this.live((things) =>
          setStrokesWidth(
            things.strokes.map(({ item }) => item),
            mm,
          ),
        ),
    );
    const sort = strokeSort(project, strokes);
    const fields: HTMLElement[] = [element("label", {}, "太さ（mm）", width)];
    if (sort !== "marks") {
      const rough = strokes.filter((s) => !isMark(project, s));
      const colors = shared(rough.map((s) => normalHex(s.color ?? "#000000") ?? "#000000"));
      const color = element("input", {
        type: "color",
        value: colors?.value ?? normalHex(rough[0]?.color ?? "#000000") ?? "#000000",
        title: "ラフ線の色（指示の色はそのレイヤーの色）",
      });
      color.addEventListener("change", () => all((targets, p) => setStrokesColor(p, targets, ownColor(color.value))));
      const black = element("button", { className: "small", textContent: "黒に戻す", disabled: rough.every((s) => !s.color) });
      black.addEventListener("click", () => all((targets, p) => setStrokesColor(p, targets, undefined)));
      fields.push(
        element(
          "label",
          { className: colors ? "" : "mixed" },
          `色${colors ? "" : MIXED_LABEL}`,
          element("span", { className: "with-button" }, color, black),
        ),
      );
    }
    if (sort !== "both") {
      const layers = sort === "marks" ? markLayersOf(project) : roughLayersOf(project);
      if (layers.length > 1) {
        const labels = Object.fromEntries(layers.map((layer) => [layer.id, layer.name]));
        const layer = pick(labels, shared(strokes.map((s) => strokeLayerId(project, s))), (id: string) => {
          let moved = 0;
          this.change((things, p) => (moved = strokesToLayer(p, things.strokes, id)));
          this.host.status(`線 ${moved} 本をレイヤー「${labels[id]}」へ移しました`);
          // On a layer hidden or locked, they can no longer be picked.
          const to = layers.find((l) => l.id === id);
          if (to?.hidden || to?.locked) this.host.editor.select(null);
        });
        fields.push(element("label", {}, sort === "marks" ? "指示のレイヤー" : "ラフ線のレイヤー", layer));
      }
    }
    fields.push(
      check(
        "コマ枠の上に描く（はみ出し）",
        strokes.map((s) => !!s.over),
        (on) => all((targets) => setStrokesOver(targets, on)),
      ),
    );
    return fields;
  }

  /** 塗り: tone and where it lies against the rough lines. */
  fillFields(fills: readonly Fill[]): HTMLElement[] {
    const tone = pick(TONE_LABELS, shared(fills.map((f) => f.tone ?? "black")), (value: FillTone) =>
      this.change((things) => {
        for (const { item } of things.fills) {
          if (value === "black") delete item.tone;
          else item.tone = value;
        }
      }),
    );
    const place = pick({ under: "線の下", over: "線の上" }, shared(fills.map((f) => (f.under ? "under" : "over"))), (value) =>
      this.change((things) => {
        for (const { item } of things.fills) {
          if (value === "under") item.under = true;
          else delete item.under;
        }
      }),
    );
    return [element("div", { className: "row" }, element("label", {}, "色", tone), element("label", {}, "重なり", place))];
  }
}

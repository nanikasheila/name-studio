// The controls for a セリフの見た目 (a セリフ種類's or a character's フキダシ設定),
// and the 種類 menu of a line (the five kinds and the types made for the name).
// Each field can be left as it comes from the layer under it.
import { SHAPE_LABELS } from "../domain/balloon";
import { KIND_LABELS } from "../domain/dialogue";
import type { LineChoice } from "../domain/linelook";
import type { BalloonShape, Line, LineKind, LineLook, Project } from "../model/model";
import { element } from "../platform/dom";
import { fontField } from "./fontpicker";

const KEEP = "";

/** The 種類 menu: the five kinds, then the types made for the name; `pick` gets the one chosen. */
export function lineChoiceSelect(
  project: Project,
  line: Pick<Line, "kind" | "type">,
  pick: (choice: LineChoice) => void,
): HTMLSelectElement {
  const select = element("select", { title: "種類（作った種類は 設定 › セリフ で足せます）" });
  for (const [value, label] of Object.entries(KIND_LABELS))
    select.append(element("option", { value: `kind:${value}`, textContent: label }));
  const types = project.lineTypes ?? [];
  if (types.length) {
    const group = element("optgroup", { label: "作った種類" });
    for (const type of types) group.append(element("option", { value: `type:${type.id}`, textContent: type.name }));
    select.append(group);
  }
  select.value = line.type && types.some((t) => t.id === line.type) ? `type:${line.type}` : `kind:${line.kind}`;
  select.addEventListener("change", () => {
    const [what, value] = select.value.split(":");
    pick(what === "type" ? { type: value } : { kind: value as LineKind });
  });
  return select;
}

/** Yes / no / as it comes (a select, for 白抜き and 白縁). */
function triState(value: boolean | undefined, keep: string, set: (value: boolean | undefined) => void): HTMLSelectElement {
  const select = element("select");
  for (const [v, label] of [
    [KEEP, keep],
    ["on", "する"],
    ["off", "しない"],
  ])
    select.append(element("option", { value: v, textContent: label }));
  select.value = value === undefined ? KEEP : value ? "on" : "off";
  select.addEventListener("change", () => set(select.value === KEEP ? undefined : select.value === "on"));
  return select;
}

/**
 * Rows for a look: 形, フォント, 文字の大きさ, 白抜き, 白縁. `keep` names what a
 * field left as is takes ("種類のまま", "作品の既定"); `change` gets the look to keep
 * (fields not set left out).
 */
export function lookFields(look: LineLook, keep: string, change: (next: LineLook) => void): HTMLElement[] {
  const next = (patch: Partial<LineLook>) => {
    const merged: LineLook = { ...look, ...patch };
    for (const key of Object.keys(merged) as (keyof LineLook)[]) if (merged[key] === undefined || merged[key] === "") delete merged[key];
    change(merged);
  };
  const shape = element("select");
  shape.append(element("option", { value: KEEP, textContent: keep }));
  for (const [value, label] of Object.entries(SHAPE_LABELS))
    if (value !== "custom") shape.append(element("option", { value, textContent: label }));
  shape.value = look.shape ?? KEEP;
  shape.addEventListener("change", () => next({ shape: (shape.value || undefined) as BalloonShape | undefined }));
  const font = fontField(look.font ?? "", keep, (name) => next({ font: name || undefined }), "フォント（空欄は下の設定のまま）");
  const size = element("input", {
    type: "number",
    min: "4",
    max: "72",
    step: "0.5",
    value: look.fontSizePt === undefined ? "" : String(look.fontSizePt),
    placeholder: keep,
    title: "文字の大きさ（pt）。空欄は下の設定のまま",
  });
  size.addEventListener("change", () => {
    const value = Number(size.value);
    next({ fontSizePt: size.value.trim() && Number.isFinite(value) ? Math.min(72, Math.max(4, value)) : undefined });
  });
  const row = (label: string, control: HTMLElement) =>
    element("label", { className: "look-row" }, element("span", { textContent: label }), control);
  return [
    row("形", shape),
    row("フォント", font),
    row("大きさ", size),
    row(
      "白抜き",
      triState(look.inverted, keep, (inverted) => next({ inverted })),
    ),
    row(
      "白縁",
      triState(look.edge, keep, (edge) => next({ edge })),
    ),
  ];
}

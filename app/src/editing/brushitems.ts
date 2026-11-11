// The settings of a pen or eraser as CSP's palettes list them: the groups of
// サブツール詳細 in CSP's order and the items first in each (the brush
// settings show them so), and which of them ツールプロパティ can show — the
// ones changed in a row (a check box, a choice or a number), not graphs,
// pictures or materials — with the app's own (the size buttons, how an
// eraser erases, the tip's shape). Out of the box it shows what CSP showed
// for the brush (`VariantShowParam`), else size, opacity and 手ブレ補正.
import { CSP_COLUMNS, type CspColumn } from "../generated/csp-columns";
import { columnsOfShowItems, parseShowItems } from "../domain/cspshow";
import { bytesOf } from "../domain/cspsettings";
import type { Brush, BrushKind } from "../model/model";
import type { PropItem } from "./toolprops";

/** The palette's groups for pens and erasers, in CSP's order; the others show when asked for (or set). */
export const PEN_GROUPS = [
  "ブラシサイズ",
  "不透明度",
  "インク",
  "アンチエイリアス",
  "ブラシ先端",
  "ストローク",
  "紙質",
  "散布効果",
  "入り抜き",
  "水彩",
  "水彩境界",
  "補正",
  "消去",
  "色の変化",
  "線",
  "ベクター線",
  "2-ブラシ形状",
  "ブラシサイズ（デュアルブラシ）",
  "インク（デュアルブラシ）",
  "アンチエイリアス（デュアルブラシ）",
  "ブラシ先端（デュアルブラシ）",
  "ストローク（デュアルブラシ）",
  "紙質（デュアルブラシ）",
  "散布効果（デュアルブラシ）",
];

/** Groups open at first in the brush settings. */
export const OPEN_GROUPS = ["ブラシサイズ", "不透明度", "インク", "入り抜き", "補正", "消去"];

/** Items that come first in their group (the rest follow by name). */
export const FIRST = [
  "BrushSize",
  "BrushSizeUnit",
  "Opacity",
  "AntiAlias",
  "BrushFlow",
  "CompositeMode",
  "BrushUsePatternImage",
  "BrushHardness",
  "BrushInterval",
  "BrushAutoIntervalType",
  "BrushThickness",
  "BrushRotation",
  "BrushInOutType",
  "BrushUseIn",
  "BrushInLength",
  "BrushInRatio",
  "BrushUseOut",
  "BrushOutLength",
  "BrushOutRatio",
  "FlickerReduction",
  "FlickerReductionBySpeed",
  "BrushUseRevision",
  "BrushRevision",
  "BrushUseVectorMagnet",
  "BrushVectorMagnetPower",
  "BrushUseVectorEraser",
  "BrushVectorEraserType",
];

/** Columns kept as they are and not shown (the palette's own layout). */
export const HIDDEN = new Set(["VariantShowParam", "VariantShowSeparator"]);

export const COLUMNS: ReadonlyMap<string, CspColumn> = new Map(CSP_COLUMNS.map((column) => [column.column, column]));

/** The value column an `…Unit` or `…Effector` column goes with, shown on its row. */
export function partnerOf(column: string): string | null {
  if (column === "BrushOpacityEffector") return "Opacity";
  for (const suffix of ["Unit", "Effector"]) {
    if (!column.endsWith(suffix) || !COLUMNS.has(column.slice(0, -suffix.length))) continue;
    // 向きの影響元 (BrushRotationEffector) is a number of its own, not a graph shown on its value's row.
    if (suffix === "Effector" && COLUMNS.get(column)?.edit.kind !== "effector") continue;
    return column.slice(0, -suffix.length);
  }
  return null;
}

/** The 影響元設定 column that goes with a value column, if there is one. */
export function effectorOfColumn(column: string): string | null {
  const name = column === "Opacity" ? "BrushOpacityEffector" : `${column}Effector`;
  return COLUMNS.get(name)?.edit.kind === "effector" ? name : null;
}

export function rank(column: string): number {
  const index = FIRST.indexOf(column);
  return index < 0 ? FIRST.length : index;
}

export function groupRank(group: string): number {
  const index = PEN_GROUPS.indexOf(group);
  return index < 0 ? PEN_GROUPS.length : index;
}

// --- ツールプロパティ ----------------------------------------------------------------------

/** The app's own items. */
export const SIZE_BUTTONS = "ns:sizePresets";
export const ERASE_MODE = "ns:eraseMode";
export const TIP_SHAPE = "ns:tip";

const OWN: Record<string, PropItem> = {
  [SIZE_BUTTONS]: {
    id: SIZE_BUTTONS,
    label: "太さの丸ボタン",
    group: "ブラシサイズ",
    hint: "よく使う太さを丸いボタンで（CSP のブラシサイズパレットのように）",
  },
  [ERASE_MODE]: { id: ERASE_MODE, label: "消し方", group: "消去", hint: "なぞったところ・線ごと・交点まで" },
  [TIP_SHAPE]: { id: TIP_SHAPE, label: "先端の形で描く", group: "ブラシ先端", hint: "CSP の素材のサムネイルから作った先端の形" },
};

function columnItem(column: CspColumn): PropItem {
  return { id: column.column, label: column.label, group: column.group, hint: column.values || undefined };
}

/** Whether ツールプロパティ can show this column (edited in a row). */
function showable(column: CspColumn): boolean {
  const kind = column.edit.kind;
  if (kind !== "check" && kind !== "choice" && kind !== "number") return false;
  if (HIDDEN.has(column.column) || partnerOf(column.column)) return false;
  // The shape, line and balloon tools' own (they share a heading with the pens').
  if (/^(?:Shape|Line|Balloon)/.test(column.column)) return false;
  return PEN_GROUPS.includes(column.group);
}

/** Its label, told apart from another of the same name (the dual brush's as CSP calls them: 2-…). */
function itemLabel(column: CspColumn, twins: ReadonlySet<string>): string {
  if (column.group.includes("（デュアルブラシ）")) return `2-${column.label}`;
  return twins.has(column.label) ? `${column.label}（${column.group}）` : column.label;
}

/** Every CSP item ツールプロパティ can show for a brush of its own, in CSP's order. */
const CSP_ITEMS: PropItem[] = (() => {
  const columns = CSP_COLUMNS.filter(showable).sort(
    (a, b) => groupRank(a.group) - groupRank(b.group) || rank(a.column) - rank(b.column) || a.column.localeCompare(b.column),
  );
  const seen = new Map<string, number>();
  for (const column of columns) if (!column.group.includes("（デュアルブラシ）")) seen.set(column.label, (seen.get(column.label) ?? 0) + 1);
  const twins = new Set([...seen].filter(([, count]) => count > 1).map(([label]) => label));
  return columns.map((column) => ({ ...columnItem(column), label: itemLabel(column, twins) }));
})();

/** What ツールプロパティ can show for this pen or eraser (none: the plain one). */
export function brushPropItems(kind: BrushKind, brush: Brush | null): PropItem[] {
  const size = COLUMNS.get("BrushSize");
  const sizeItem: PropItem = size ? columnItem(size) : { id: "BrushSize", label: "ブラシサイズ", group: "ブラシサイズ" };
  const flicker = COLUMNS.get("FlickerReduction");
  const flickerItem: PropItem = flicker ? columnItem(flicker) : { id: "FlickerReduction", label: "手ブレ補正", group: "補正" };
  if (!brush) return kind === "pen" ? [sizeItem, OWN[SIZE_BUTTONS], flickerItem] : [sizeItem, OWN[SIZE_BUTTONS], OWN[ERASE_MODE]];
  const items: PropItem[] = [];
  for (const item of CSP_ITEMS) {
    items.push(item);
    if (item.id === "BrushSize") items.push(OWN[SIZE_BUTTONS]);
  }
  // The app's own, at the end of their group.
  const own = [kind === "eraser" ? OWN[ERASE_MODE] : null, brush.tip ? OWN[TIP_SHAPE] : null].filter((x): x is PropItem => !!x);
  for (const item of own) {
    const last = items.map((x) => x.group).lastIndexOf(item.group);
    items.splice(last < 0 ? items.length : last + 1, 0, item);
  }
  return items;
}

/** What ツールプロパティ shows for the brush out of the box: what CSP showed, else the usual few. */
export function defaultBrushItems(kind: BrushKind, brush: Brush | null): string[] {
  if (!brush) return kind === "pen" ? ["BrushSize", SIZE_BUTTONS, "FlickerReduction"] : ["BrushSize", SIZE_BUTTONS, ERASE_MODE];
  const blob = brush.csp?.settings.VariantShowParam;
  const fromCsp = blob && typeof blob === "object" ? parseShowItems(bytesOf(blob.blob)) : null;
  const known = fromCsp ? columnsOfShowItems(fromCsp) : [];
  const items = known.length ? known : ["BrushSize", "Opacity", "FlickerReduction"];
  const at = items.indexOf("BrushSize");
  if (at >= 0) items.splice(at + 1, 0, SIZE_BUTTONS);
  if (kind === "eraser") items.push(ERASE_MODE);
  if (brush.tip) items.push(TIP_SHAPE);
  return items;
}

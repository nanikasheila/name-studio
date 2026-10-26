// The editor's palettes, left or right of the pages and several at once, as
// CSP's: what each one is, its tab's icon and tip. What they hold is drawn by
// the lists, the layer view, the series panel and the inspector.
import { Docks, type PaletteDef, type PaletteId } from "./dock";
import { $ } from "./dom";
import { readFlag } from "./settings";

const SIDE_FOLDED_KEY = "namestudio.sideFolded";

/** The palettes' icons. */
const PAGES_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="2.5" width="12" height="15" rx="1"/><path d="M4 9h12M10 9v8.5"/></svg>';
const SCRIPT_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h10v15H5z"/><path d="M8 6.5h4M8 9.5h4M8 12.5h2.5"/></svg>';
const CAST_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6.5" r="3"/><path d="M4 17c0-3.3 2.7-5.2 6-5.2s6 1.9 6 5.2"/></svg>';
const NOTES_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 3h13v9l-5 5h-8z"/><path d="M11.5 17v-5h5"/></svg>';
const HELD_ICON =
  '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="3.5" width="13" height="13" rx="1" stroke-dasharray="2.2 2"/><path d="M10 7v6M7 10h6"/></svg>';
const LAYERS_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3l7 3.8-7 3.8-7-3.8z"/><path d="M3 10.5l7 3.8 7-3.8M3 14l7 3.8 7-3.8"/></svg>';
const SERIES_ICON = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="5" width="9" height="12" rx="1"/><path d="M6 5V3h9.5v12h-4"/></svg>';
const INSPECTOR_ICON =
  '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5.5h8M15 5.5h2M3 10h3M10 10h7M3 14.5h7M14 14.5h3"/><circle cx="13" cy="5.5" r="2"/><circle cx="8" cy="10" r="2"/><circle cx="12" cy="14.5" r="2"/></svg>';

/** The palettes in their columns; `changed` when the ones on screen change. */
export function editorDocks(changed: () => void): Docks {
  const palette = (id: PaletteId, title: string, tip: string, icon: string, tabId = `tab-${id}`): PaletteDef => ({
    id,
    title,
    tip,
    icon,
    tabId,
    body: $(id === "inspector" ? "inspector" : `side-${id}`),
  });
  return new Docks(
    { left: $("dock-left"), right: $("dock-right") },
    [
      palette("pages", "ページ", "ページの一覧（ドラッグで並べ替え）", PAGES_ICON),
      palette("script", "台本", "全ページのセリフを台本の形で。台本・プロットの取り込みも", SCRIPT_ICON),
      palette("cast", "人物", "登場人物（名前・色・口調）", CAST_ICON),
      palette("notes", "付箋", "全ページの付箋（未決のこと）", NOTES_ICON),
      palette("held", "保留", "置き場所の決まっていないコマ（保留）", HELD_ICON),
      palette("layers", "レイヤー", "見開きのコマと、その中のセリフ・ラフ線・塗り（CSP のコマ枠フォルダのように）", LAYERS_ICON, "tab-layers-edit"),
      palette("series", "シリーズ", "何話ものネームで人物・ブラシ・フォント・設定を共有する（話から話へ移る・次の話を作る）", SERIES_ICON),
      palette("inspector", "詳細", "選んだもの（ページ・コマ・セリフ・付箋など）の設定", INSPECTOR_ICON),
    ],
    changed,
    undefined,
    // On a narrow screen the strip under the page lists the pages: the left column starts folded.
    readFlag(SIDE_FOLDED_KEY, window.innerWidth < 1500),
  );
}

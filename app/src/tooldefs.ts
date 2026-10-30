// The tools of the page editor in one place: their order on the rail, their
// button, name, keys and words for the command palette, the line under the
// tool's name, the help over the screen, and the cursor. A new tool is added
// here; the types then ask for the rest: its press (PRESS in tools.ts), what
// it can pick up (HOLDS in editorcore.ts) and its help (TOOL_TOPICS in
// helptopics.ts).

export const TOOL_IDS = ["select", "cut", "text", "pen", "mark", "eraser", "fill", "breakout", "sticky", "reference"] as const;

export type ToolId = (typeof TOOL_IDS)[number];

export interface ToolDefinition {
  /** On the button and in the help. */
  name: string;
  /** The command's label in the palette and the key settings. */
  label: string;
  /** Default keys. */
  keys: string[];
  /** More words the palette finds it by. */
  words?: string;
  /** The button's tooltip. */
  title: string;
  /** The button's icon: the inside of a 20 × 20 SVG. */
  icon: string;
  /** One line under the tool's name in the options row (none: the row shows the tool's settings). */
  hint: string;
  /** What the help over the screen says beside the button. */
  overlay: string;
  /** The mouse cursor over the pages (CSS). */
  cursor: string;
}

export const TOOLS: Record<ToolId, ToolDefinition> = {
  select: {
    name: "選択",
    label: "選択",
    keys: ["V"],
    title: "選ぶ・動かす",
    icon: '<path d="M5 2.5l10 8-4.5 1 2.5 5-2 1-2.5-5L5 16z" class="fill"/>',
    hint: "クリックで選ぶ・ドラッグで動かす・ダブルクリックで書き込む。Shift で足す、囲んでまとめて選ぶ",
    overlay: "選ぶ・動かす・ダブルクリックで書く",
    cursor: "default",
  },
  cut: {
    name: "コマ割り",
    label: "コマ割り",
    keys: ["K"],
    words: "コマ 割る 枠",
    title: "コマを割る。コマの外をドラッグすると新しいコマ",
    icon: '<rect x="2.5" y="2.5" width="15" height="15" rx="1"/><path d="M2.5 8.5l15 2.5M10 9.8V17.5"/>',
    hint: "コマを横切るように引くと割れる（Alt で斜め）。Shift + コマの外のドラッグで新しいコマ",
    overlay: "引いて割る・なぐり描き・四角・多角形",
    cursor: "crosshair",
  },
  text: {
    name: "セリフ",
    label: "セリフ",
    keys: ["T"],
    words: "文字 フキダシ テキスト",
    title: "クリックでセリフを置く",
    icon: '<path d="M10 3c4.4 0 7.5 2.5 7.5 5.6S14.4 14 10 14c-.8 0-1.5 0-2.2-.2L4 17l1-3.8C3.4 12.2 2.5 10.5 2.5 8.6 2.5 5.5 5.6 3 10 3z"/>',
    hint: "クリックした所にセリフを置く。選んで Alt+ホイールで文字の大きさ",
    overlay: "クリックで置いてその場で書く",
    cursor: "text",
  },
  pen: {
    name: "ペン",
    label: "ペン",
    keys: ["P"],
    words: "ラフ 描く",
    title: "ラフを描く",
    icon: '<path d="M3.5 16.5l1-4 9-9 3 3-9 9z"/><path d="M12 5l3 3"/>',
    hint: "",
    overlay: "ラフを描く",
    cursor: "crosshair",
  },
  mark: {
    name: "指示",
    label: "指示（赤ペン・注釈）",
    keys: ["R"],
    words: "赤ペン 注釈 コメント 指定 アシスタント",
    title: "指示・注釈をページに直接描く（赤ペン）。ラフ線とは別のレイヤーで、いちばん上に色付きで出ます",
    icon: '<path d="M8.5 13.5l1-3.5 6-6 2.5 2.5-6 6z"/><path d="M2.5 16c1.5-2 3-2.5 4-1.5s2.5.5 4-1"/>',
    hint: "指示を描きなぐる。消しゴム側か「消す」で指示だけ消す。CSP へは下描きレイヤー「指示」",
    overlay: "注釈を色ペンで描きなぐる",
    cursor: "crosshair",
  },
  eraser: {
    name: "消しゴム",
    label: "消しゴム（もう一度で消し方を切り替え）",
    keys: ["E"],
    title: "ラフの線を消す",
    icon: '<path d="M2.8 12.6l7.8-7.8 5.6 5.6-5.4 5.4H7z"/><path d="M6.6 8.8l5.6 5.6M8 17.5h9.5"/>',
    hint: "",
    overlay: "もう一度押すと消し方を切り替え",
    // A ring the size of the eraser is drawn instead.
    cursor: "none",
  },
  fill: {
    name: "塗り",
    label: "塗り（もう一度で塗り方を切り替え）",
    keys: ["G"],
    words: "塗り ベタ トーン 塗りつぶし バケツ 囲って塗る 投げなわ 塗り残し 隙間閉じ",
    title: "線で閉じた所や囲んだ所を塗る。ベタ・グレー・白。塗りつぶし・囲って塗る・投げなわ塗り・塗り残し部分に塗る",
    icon: '<path d="M10 2.5c3.2 4.2 5 7 5 9.2a5 5 0 0 1-10 0c0-2.2 1.8-5 5-9.2z" class="fill"/>',
    hint: "線で閉じた所や囲んだ所を塗る",
    overlay: "もう一度押すと塗り方を切り替え",
    cursor: "crosshair",
  },
  breakout: {
    name: "はみ出し",
    label: "はみ出し",
    keys: ["B"],
    title: "コマを突き抜ける所を囲む。中に描いた線はコマ枠の上に",
    icon: '<rect x="2.5" y="6.5" width="11" height="11" rx="1"/><path d="M8 12l9-9.5M12.5 2.5H17V7"/>',
    hint: "コマを突き抜ける所を囲む。中に描いた線はコマ枠の上に",
    overlay: "コマを突き抜ける所を囲む",
    cursor: "crosshair",
  },
  sticky: {
    name: "付箋",
    label: "付箋",
    keys: ["M"],
    words: "メモ",
    title: "付箋を貼る。作業用のメモで、書き出しには入りません",
    icon: '<path d="M3.5 3h13v9l-5 5h-8z"/><path d="M11.5 17v-5h5"/>',
    hint: "クリックで付箋を貼る（書き出しには入りません）",
    overlay: "作業用のメモ（書き出さない）",
    cursor: "copy",
  },
  reference: {
    name: "資料",
    label: "資料画像",
    keys: ["I"],
    words: "写真 背景 画像",
    title: "資料画像を貼る・動かす。写真や背景をページの下に薄く敷きます。Ctrl+V や画像のドロップでも貼れます",
    icon: '<rect x="2.5" y="4" width="15" height="12" rx="1"/><path d="M2.5 13.5l4.5-4.5 4 4 2.5-2.5 4 4"/><circle cx="13.5" cy="7.5" r="1.3"/>',
    hint: "写真や背景を薄く敷く。Ctrl+V・ドロップでも貼れる。ドラッグで動かし、角で大きさ（CSP には下描きレイヤーで出ます）",
    overlay: "写真や背景を薄く敷く",
    cursor: "default",
  },
};

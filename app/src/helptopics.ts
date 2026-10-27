// ヘルプ: what each part of the screen is and what the mouse and the keys do
// there, for the help bar under the window (the thing under the pointer),
// the help over the whole screen and the first-time guide. Keys are named
// by the command they run, so the help says the keys as they are set now.

/** One thing to do: the input ("ドラッグ", or a command's keys) and what it does. */
export interface HelpStep {
  /** What is done with the mouse or pen ("ドラッグ", "Shift+クリック"). */
  input?: string;
  /** A command whose keys are the input (as set in キー設定); left out when it has none. */
  command?: string;
  /** With `command`: the key held down, not pressed (一時切り替え). */
  hold?: boolean;
  does: string;
}

export interface HelpTopic {
  name: string;
  /** One sentence on what it is. */
  what?: string;
  steps?: HelpStep[];
}

/** What the help can be asked for (the commands and the help button). */
export type HelpKind = "overlay" | "tour" | "bar";

/** A step as shown: its input in words, what it does, and whether a key held now is part of it. */
export interface ShownStep {
  input: string;
  does: string;
  held: boolean;
}

const KEY_WORDS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  " ": "Space",
};

/** A key as written in the settings ("Alt+ArrowUp"), as shown to the eye ("Alt+↑"). */
export function keyLabel(combo: string): string {
  return combo
    .split("+")
    .map((part) => KEY_WORDS[part] ?? part)
    .join("+")
    .replace(/\+\+$/, "++");
}

/** The modifiers in an input ("Shift+Space+ドラッグ": Shift and Space). */
function modifiersOf(input: string): string[] {
  return input.split(/[+＋]/).filter((part) => ["Shift", "Alt", "Ctrl", "Space"].includes(part));
}

/**
 * The steps of a topic with their keys as set now: a command with no key is
 * left out. With modifiers held, the steps that use them come first.
 */
export function shownSteps(topic: HelpTopic, keysOf: (command: string) => string[], held: ReadonlySet<string> = new Set()): ShownStep[] {
  const shown: ShownStep[] = [];
  for (const step of topic.steps ?? []) {
    let input = step.input ?? "";
    if (step.command) {
      const keys = keysOf(step.command).map(keyLabel);
      if (!keys.length) continue;
      input = step.hold ? `${keys[0]} を押したまま` : keys.slice(0, 2).join(" / ");
    }
    if (!input) continue;
    const mods = modifiersOf(input);
    shown.push({ input, does: step.does, held: held.size > 0 && mods.length > 0 && mods.every((m) => held.has(m)) });
  }
  return [...shown.filter((s) => s.held), ...shown.filter((s) => !s.held)];
}

/** Moving about the pages, whatever the tool. */
const VIEW_STEPS: HelpStep[] = [
  { input: "Space+ドラッグ", does: "画面を動かす" },
  { input: "ホイール", does: "拡大・縮小" },
  { input: "Shift+Space+ドラッグ", does: "画面を回す" },
  { command: "view.fit", does: "全体を表示" },
];

/** The tools on the page (コマ割り by its way of making panels: "cut.rect"). */
export const TOOL_TOPICS: Record<string, HelpTopic> = {
  select: {
    name: "選択",
    what: "コマ・セリフ・ラフ線・塗り・付箋を選んで動かす",
    steps: [
      { input: "クリック", does: "選ぶ" },
      { input: "ドラッグ（何もない所）", does: "囲んで選ぶ" },
      { input: "Shift+クリック", does: "選択に足す・外す" },
      { command: "selectAll", does: "ページを全部選ぶ" },
      { command: "deselect", does: "選択を外す" },
      ...VIEW_STEPS,
    ],
  },
  cut: {
    name: "コマ割り（割る）",
    what: "コマを横切るように引いて割る",
    steps: [
      { input: "ドラッグ（コマを横切る）", does: "割る（ほぼ水平・垂直はまっすぐ）" },
      { input: "Alt+ドラッグ", does: "斜めに割る" },
      { input: "Shift+ドラッグ（コマの外）", does: "四角いコマを足す" },
      { input: "ダブルクリック（コマの間）", does: "選択ツールで 2 コマをつなげる" },
      ...VIEW_STEPS,
    ],
  },
  "cut.rect": {
    name: "コマ割り（四角）",
    what: "ドラッグで四角いコマを描く",
    steps: [
      { input: "ドラッグ", does: "四角いコマを描く" },
      { input: "ドラッグ（コマの中）", does: "はめ込みのコマ" },
      { input: "Alt+ドラッグ", does: "吸い付かずに描く" },
      ...VIEW_STEPS,
    ],
  },
  "cut.polygon": {
    name: "コマ割り（多角形）",
    what: "角を置いて台形など好きな形のコマを描く",
    steps: [
      { input: "クリック", does: "角を置く" },
      { input: "ダブルクリック / Enter", does: "閉じてコマにする" },
      { input: "最初の角をクリック", does: "閉じる" },
      { input: "Backspace", does: "角を 1 つ戻す" },
      { input: "Esc", does: "やめる" },
    ],
  },
  text: {
    name: "セリフ",
    what: "クリックした所にセリフを置いて、その場で書く",
    steps: [
      { input: "クリック", does: "セリフを置く・書く" },
      { input: "Tab / Shift+Tab（書いている間）", does: "次・前のセリフへ" },
      { input: "Ctrl+Enter", does: "書き終える" },
      { input: "Alt+ホイール", does: "選んだセリフの文字の大きさ" },
      ...VIEW_STEPS,
    ],
  },
  pen: {
    name: "ペン",
    what: "ラフを描く（書き出すと CSP のラフ線レイヤー）",
    steps: [
      { input: "ドラッグ", does: "描く" },
      { input: "Shift+ドラッグ", does: "まっすぐな線" },
      { command: "brush.bigger", does: "太く" },
      { command: "brush.smaller", does: "細く" },
      { input: "ペンの消しゴム側", does: "消す" },
      ...VIEW_STEPS,
    ],
  },
  mark: {
    name: "指示",
    what: "ペン入れする人への指示を色付きで描きなぐる（ラフ線とは別のレイヤー）",
    steps: [
      { input: "ドラッグ", does: "描く" },
      { input: "Shift+ドラッグ", does: "まっすぐな線" },
      { input: "ペンの消しゴム側", does: "指示だけ消す" },
      { input: "段の「消す」", does: "指示だけ消す（ラフ線は消えない）" },
      { input: "段の「＋色」", does: "別の色（別の指示のレイヤー）を足す" },
      { command: "button.marks-shown", does: "指示を出す・隠す" },
      { command: "brush.bigger", does: "太く" },
      { command: "brush.smaller", does: "細く" },
      ...VIEW_STEPS,
    ],
  },
  eraser: {
    name: "消しゴム",
    what: "ラフの線を消す（指示は消さない）。消し方は 部分・交点まで・線ごと・囲む",
    steps: [
      { input: "ドラッグ", does: "消す" },
      { command: "tool.eraser", does: "消し方を切り替える（消しゴムを持っているとき）" },
      { command: "brush.bigger", does: "太く" },
      { command: "brush.smaller", does: "細く" },
      ...VIEW_STEPS,
    ],
  },
  fill: {
    name: "塗り",
    what: "囲んだ所を塗る（黒・グレー・白）",
    steps: [{ input: "ドラッグで囲む", does: "塗る" }, ...VIEW_STEPS],
  },
  breakout: {
    name: "はみ出し",
    what: "コマを突き抜ける所を囲む。中に描いた線はコマ枠の上に出る",
    steps: [{ input: "ドラッグで囲む", does: "はみ出しを作る" }, ...VIEW_STEPS],
  },
  sticky: {
    name: "付箋",
    what: "作業用のメモ。書き出しには入らない",
    steps: [
      { input: "クリック", does: "付箋を貼る（コマやセリフの上ならそれに紐づく）" },
      { input: "ドラッグ（付箋）", does: "動かす" },
      { input: "丸い取っ手をドラッグ", does: "コマ・セリフに紐づける" },
      ...VIEW_STEPS,
    ],
  },
  reference: {
    name: "資料画像",
    what: "写真や背景をページの下に薄く敷く（CSP には下描きレイヤーで出る）",
    steps: [
      { input: "ドラッグ", does: "動かす" },
      { input: "角をドラッグ", does: "大きさを変える" },
      { command: "paste", does: "クリップボードの画像を貼る" },
      { command: "delete", does: "選んだ画像を外す" },
      { input: "画像をドロップ", does: "貼る" },
      ...VIEW_STEPS,
    ],
  },
};

/** What the select tool would grab under the pointer ("item.panel", "seam", "tail.tip" ...). */
export const HOVER_TOPICS: Record<string, HelpTopic> = {
  "item.panel": {
    name: "コマ",
    what: "動かすと中のセリフ・ラフ線も一緒に動く",
    steps: [
      { input: "ドラッグ", does: "動かす" },
      { input: "ダブルクリック", does: "コマのメモを書く" },
      { input: "番号をドラッグ", does: "ほかのコマと入れ替え" },
      { input: "Alt+ドラッグ", does: "吸い付かずに動かす" },
      { input: "Shift+クリック", does: "選択に足す" },
      { command: "transform", does: "変形" },
      { command: "delete", does: "消す" },
    ],
  },
  "item.line": {
    name: "セリフ",
    what: "フキダシとその文字",
    steps: [
      { input: "ドラッグ", does: "動かす" },
      { input: "ダブルクリック", does: "その場で書く" },
      { input: "Alt+ドラッグ", does: "しっぽを足す" },
      { input: "Alt+ホイール", does: "文字の大きさ（選んでいるとき）" },
      { input: "同じ所をもう一度クリック", does: "下に重なったセリフを選ぶ" },
      { command: "transform", does: "変形" },
      { command: "delete", does: "消す" },
    ],
  },
  "item.stroke": {
    name: "ラフ線・指示",
    steps: [
      { input: "ドラッグ", does: "動かす" },
      { input: "Shift+クリック", does: "選択に足す" },
      { command: "transform", does: "変形" },
      { command: "delete", does: "消す" },
    ],
  },
  "item.fill": {
    name: "塗り",
    steps: [
      { input: "ドラッグ", does: "動かす" },
      { input: "Shift+クリック", does: "選択に足す" },
      { command: "transform", does: "変形" },
      { command: "delete", does: "消す" },
    ],
  },
  "item.breakout": {
    name: "はみ出し",
    what: "囲みの中の線はコマ枠の上に出る",
    steps: [
      { input: "ドラッグ", does: "動かす" },
      { command: "transform", does: "変形" },
      { command: "delete", does: "消す" },
    ],
  },
  "item.sticky": {
    name: "付箋",
    what: "作業用のメモ。書き出しには入らない",
    steps: [
      { input: "ドラッグ", does: "動かす" },
      { input: "ダブルクリック", does: "右の欄で書く" },
      { input: "丸い取っ手をドラッグ", does: "コマ・セリフに紐づける" },
      { command: "delete", does: "消す" },
    ],
  },
  "item.group": {
    name: "選んだもの（まとめて）",
    steps: [
      { input: "ドラッグ", does: "まとめて動かす" },
      { input: "Shift+クリック", does: "足す・外す" },
      { command: "transform", does: "変形" },
      { command: "copy", does: "コピー" },
      { command: "delete", does: "消す" },
    ],
  },
  seam: {
    name: "コマの境目",
    what: "両側のコマ（と中身）が一緒に動く",
    steps: [
      { input: "ドラッグ", does: "境目を動かす" },
      { input: "ダブルクリック", does: "2 つのコマをつなげる" },
      { input: "Alt+ドラッグ", does: "吸い付かずに動かす" },
    ],
  },
  "tail.tip": {
    name: "しっぽの先",
    steps: [
      { input: "ドラッグ", does: "向きと長さを変える" },
      { input: "クリックして Delete", does: "このしっぽを消す" },
    ],
  },
  "tail.body": {
    name: "しっぽ",
    steps: [
      { input: "ドラッグ", does: "しっぽの先を動かす" },
      { input: "クリックして Delete", does: "このしっぽを消す" },
    ],
  },
  "tail.root": {
    name: "しっぽの根本",
    steps: [{ input: "ドラッグ", does: "フキダシのまわりで根本を動かす" }],
  },
  "tail.bend": {
    name: "しっぽの曲がり",
    steps: [{ input: "ドラッグ", does: "しっぽを曲げる" }],
  },
  handle: {
    name: "変形の枠",
    what: "選んだものを拡大縮小・回転・自由変形",
    steps: [
      { input: "角・辺をドラッグ", does: "拡大縮小（角は比率を保つ）" },
      { input: "Shift+ドラッグ", does: "比率を変える" },
      { input: "Alt+ドラッグ", does: "中心から" },
      { input: "Ctrl+角をドラッグ", does: "自由変形" },
      { input: "丸い取っ手をドラッグ", does: "回す（Shift で 15° ずつ）" },
      { input: "Enter", does: "確定" },
    ],
  },
};

/** Parts of the screen with no words of their own (by element id), and the larger areas around them. */
export const AREA_TOPICS: Record<string, HelpTopic> = {
  "dock-left": {
    name: "左の欄",
    what: "ページ・台本・人物・付箋・保留・レイヤー・シリーズ",
    steps: [
      { input: "上のアイコン", does: "欄を出す・隠す" },
      { input: "見出しをドラッグ", does: "別の場所・右の欄へ" },
      { input: "見出しをダブルクリック", does: "たたむ" },
    ],
  },
  "dock-right": {
    name: "右の欄",
    what: "詳細: 選んだもの（ページ・コマ・セリフ・付箋・シーン）の設定",
    steps: [
      { input: "上のアイコン", does: "欄を出す・隠す" },
      { input: "見出しをドラッグ", does: "別の場所・左の欄へ" },
    ],
  },
  "editor-tools": {
    name: "道具",
    what: "持つ道具を選ぶ",
    steps: [
      { input: "クリック", does: "持ち替える" },
      { input: "道具のキーを押したまま", does: "その間だけ持ち替える" },
    ],
  },
  "tool-options": { name: "道具の設定", what: "持っている道具の設定とひと言の説明" },
  "page-nav": {
    name: "ページの見せ方",
    what: "見開き・単独・連続、読む表示、物語の帯に出すもの",
    steps: [
      { command: "page.next", does: "左の見開きへ" },
      { command: "page.previous", does: "右の見開きへ" },
      { command: "view.continuous", does: "連続と切り替え" },
    ],
  },
  story: {
    name: "物語の帯",
    what: "話の型・シーン・時系列・感情・ページをページの並びにそろえて見る",
    steps: [
      { input: "ページ・コマをクリック", does: "そのページを開く" },
      { input: "Ctrl+ホイール", does: "帯の拡大・縮小" },
      { command: "view.board", does: "帯を大きく" },
      { command: "view.fold", does: "たたむ" },
    ],
  },
  "help-bar": {
    name: "ヘルプの帯",
    what: "ポインターの下にあるものの名前と、マウス・キーでできること",
    steps: [
      { command: "help.overlay", does: "画面全体のヘルプ" },
      { input: "設定 › 表示", does: "隠す" },
    ],
  },
  status: { name: "お知らせ", what: "したことの結果がここに出る" },
  reader: {
    name: "読む表示",
    what: "見開きで通し読み",
    steps: [
      { input: "← / →・クリック・ホイール", does: "めくる" },
      { input: "Esc", does: "編集に戻る" },
    ],
  },
  "inline-edit": {
    name: "その場で書く",
    what: "ページの上でセリフ・メモを書く",
    steps: [
      { input: "Ctrl+Enter・ほかをクリック", does: "決める" },
      { input: "Tab / Shift+Tab", does: "決めて次・前のセリフへ" },
      { input: "Esc", does: "やめる（書く前に戻す）" },
    ],
  },
  "action-bar": { name: "操作バー", what: "選んだものにすぐ使う操作" },
  "start-recent": { name: "最近のネーム", what: "クリックで開く" },
};

/** The words for a modifier held, in the order they are read. */
export function heldFrom(event: Pick<KeyboardEvent, "shiftKey" | "altKey" | "ctrlKey" | "metaKey">, space: boolean): Set<string> {
  const held = new Set<string>();
  if (event.ctrlKey || event.metaKey) held.add("Ctrl");
  if (event.altKey) held.add("Alt");
  if (event.shiftKey) held.add("Shift");
  if (space) held.add("Space");
  return held;
}

/**
 * A topic from an element's own words (its tooltip): "シーン: 両端の…" is
 * named シーン, lines starting "・X: Y" become steps, and a command's keys
 * come as one more step.
 */
export function topicFromWords(words: string, label: string, command?: string): HelpTopic {
  const lines = words.split("\n").map((line) => line.trim()).filter(Boolean);
  const steps: HelpStep[] = [];
  const prose: string[] = [];
  for (const line of lines) {
    const bullet = /^[・•]\s*(.+?)[:：]\s*(.+)$/.exec(line);
    if (bullet) steps.push({ input: bullet[1], does: bullet[2] });
    else prose.push(line.replace(/^[・•]\s*/, ""));
  }
  let name = label.trim();
  let what = prose.join(" ");
  const named = /^([^:：。、（(]{1,14})[:：]\s*(.+)$/.exec(what);
  if (named && (!name || name === named[1])) {
    name = named[1];
    what = named[2];
  }
  if (!name) {
    // The first words up to a stop or a bracket; the rest stays as the sentence.
    const head = /^([^。、（(:：]{1,18})/.exec(what)?.[1] ?? what;
    name = head;
    if (head === what) what = "";
  }
  if (what === name) what = "";
  if (command) steps.push({ command, does: "でも同じ" });
  return { name, what: what || undefined, steps };
}

/** One part of the screen named on the help over the whole screen. */
export interface OverlaySpot {
  /** CSS selector of the part; parts not on screen are left out. */
  target: string;
  name: string;
  text: string;
  /** Its keys, shown after the name. */
  command?: string;
  /** Where the words go: beside a small part (with a line to it), or inside a large one. */
  side: "right" | "below" | "above" | "inside";
}

const tool = (id: string, name: string, text: string): OverlaySpot => ({ target: `#tool-${id}`, name, text, command: `tool.${id}`, side: "right" });

/** The help over the whole screen: the parts of the editor and of the start screen. */
export const OVERLAY_SPOTS: OverlaySpot[] = [
  // The bar at the top.
  { target: "#open", name: "開く", text: "ネームデータか CSP のネーム用紙", command: "button.open", side: "below" },
  { target: "#new-project", name: "新しいネーム", text: "白紙から作る", command: "button.new-project", side: "below" },
  { target: "#save", name: "保存", text: "編集中は自動でも保存", command: "save", side: "below" },
  { target: "#versions", name: "履歴", text: "前の版に戻す", side: "below" },
  { target: "#settings", name: "設定", text: "コマ間・フォント・吸着・表示など", side: "below" },
  { target: "#shortcuts", name: "キー設定", text: "キーの割り当てを変える", side: "below" },
  { target: "#pen-settings", name: "ペン設定", text: "筆圧・タブレット", side: "below" },
  { target: "#save-state", name: "保存の状態", text: "保存済み・未保存・自動保存の写し", side: "below" },
  { target: "#undo", name: "元に戻す", text: "", command: "undo", side: "below" },
  { target: "#name-export", name: "書き出す", text: "CSP のページと作品・PDF・台本", command: "exportAgain", side: "below" },
  { target: "#help", name: "ヘルプ", text: "この画面。もう一度で閉じる", command: "help.overlay", side: "below" },
  // The tools.
  tool("select", "選択", "選ぶ・動かす・ダブルクリックで書く"),
  tool("cut", "コマ割り", "引いて割る・四角・多角形"),
  tool("text", "セリフ", "クリックで置いてその場で書く"),
  tool("pen", "ペン", "ラフを描く"),
  tool("mark", "指示", "注釈を色ペンで描きなぐる"),
  tool("eraser", "消しゴム", "もう一度押すと消し方を切り替え"),
  tool("fill", "塗り", "囲んでベタ・グレー・白"),
  tool("breakout", "はみ出し", "コマを突き抜ける所を囲む"),
  tool("sticky", "付箋", "作業用のメモ（書き出さない）"),
  tool("reference", "資料", "写真や背景を薄く敷く"),
  // Around the pages.
  { target: "#tool-options", name: "道具の設定", text: "持っている道具の設定と使い方のひと言", side: "below" },
  { target: "#editor-canvas", name: "紙面", text: "ここに描く。Space+ドラッグで動かす・ホイールで拡大縮小・Shift+Space+ドラッグで回す", command: "view.fit", side: "inside" },
  { target: "#editor-next", name: "ページをめくる", text: "", command: "page.next", side: "above" },
  { target: "#spread-mode", name: "見開き・単独・連続", text: "連続は全ページを一枚に並べる", command: "view.continuous", side: "above" },
  { target: "#marks-shown", name: "指示", text: "指示を全部出す・隠す", command: "button.marks-shown", side: "above" },
  { target: "#read-mode", name: "読む", text: "見開きで通し読み", command: "button.read-mode", side: "above" },
  { target: "#focus-mode", name: "ページだけ", text: "欄と帯を隠す", command: "view.focus", side: "above" },
  { target: ".lane-toggles", name: "帯に出すもの", text: "型・シーン・時系列・感情・字数", side: "above" },
  { target: "#story", name: "物語の帯", text: "シーン・感情・ページを並びにそろえて見る。クリックでそのページへ", command: "view.board", side: "inside" },
  { target: "#dock-left", name: "左の欄", text: "ページ・台本・人物・付箋・保留・レイヤー・シリーズ。上のアイコンで出し入れ、見出しのドラッグで反対側へ", side: "inside" },
  { target: "#dock-right", name: "右の欄（詳細）", text: "選んだもの（ページ・コマ・セリフ・付箋・シーン）の設定", side: "inside" },
  { target: "#help-bar", name: "ヘルプの帯", text: "ポインターの下の名前と操作。設定 › 表示で隠せる", side: "above" },
  // The start screen.
  { target: "#start-open", name: "開く", text: "ネームデータか CSP のネーム用紙", command: "button.open", side: "below" },
  { target: "#start-new", name: "新しいネーム", text: "白紙から作る", side: "below" },
  { target: "#start-recent", name: "最近のネーム", text: "クリックで開く", side: "inside" },
];

/** One stop of the first-time guide. */
export interface TourStop {
  /** CSS selector of what it points at; none: in the middle. Stops whose part is not on screen are passed. */
  target?: string;
  title: string;
  /** Paragraphs; `{command}` is replaced by that command's keys. */
  text: string[];
}

/** The first-time guide in the editor. */
export const TOUR_STOPS: TourStop[] = [
  {
    title: "Name Studio へようこそ",
    text: ["ネームを描いて、CLIP STUDIO PAINT のページと作品に書き出す道具です。", "画面の各部を順に案内します（1 分ほど）。→ キーか「次へ」で進み、Esc でいつでも閉じられます。"],
  },
  {
    target: "#editor-tools",
    title: "道具",
    text: ["選択 {tool.select}・コマ割り {tool.cut}・セリフ {tool.text}・ペン {tool.pen} など。", "道具のキーを押したままにすると、その間だけ持ち替えます。"],
  },
  {
    target: "#tool-options",
    title: "道具の設定",
    text: ["持っている道具の設定（コマの作り方・ペンの太さ・消し方など）と、使い方のひと言が出ます。"],
  },
  {
    target: "#editor-canvas",
    title: "紙面",
    text: ["まずコマ割り {tool.cut} でページを横切るように引くとコマが割れます。セリフ {tool.text} はクリックした所に書けます。", "Space+ドラッグで動かす、ホイールで拡大縮小、{view.fit} で全体を表示。"],
  },
  {
    target: "#page-nav",
    title: "ページの見せ方",
    text: ["見開き・単独・連続（{view.continuous}）を切り替え、読む（{button.read-mode}）で通し読み。", "{view.focus} で左右の欄と帯を隠してページを大きくできます。"],
  },
  {
    target: "#story",
    title: "物語の帯",
    text: ["話の型・シーン・時系列・感情曲線・ページを、ページの並びにそろえて見ます。", "ページやコマをクリックするとそのページへ。{view.board} で大きく、{view.fold} でたたみます。"],
  },
  {
    target: "#dock-left",
    title: "左の欄",
    text: ["ページの一覧・台本・人物・付箋・保留・レイヤー。上のアイコンで出し入れし、見出しをドラッグすると右の欄へ移せます。"],
  },
  {
    target: "#dock-right",
    title: "右の欄（詳細）",
    text: ["選んだもの（ページ・コマ・セリフ・付箋・シーン）の設定です。"],
  },
  {
    target: "#name-export",
    title: "書き出す",
    text: ["CSP のページと作品（.clip/.cmc）・PDF・台本に書き出します。2 回目からは {exportAgain} で同じ設定のまま。", "保存は自動でもされます（{save} でいつでも）。"],
  },
  {
    target: "#help-bar",
    title: "困ったときは",
    text: ["下のヘルプの帯に、ポインターの下にあるものの名前とできることが出ます。", "{help.overlay} で画面全体のヘルプ、{palette.commands} で命令を名前で探せます。この案内はヘルプから何度でも見られます。"],
  },
];

/** The first-time guide on the start screen (before a name is open). */
export const START_STOPS: TourStop[] = [
  {
    target: ".start-actions",
    title: "Name Studio へようこそ",
    text: [
      "まず「新しいネーム」で白紙のネームを作るか、「開く」でネームデータや CSP のネーム用紙を開きます。",
      "ネームを開くと、画面の各部を案内します。",
    ],
  },
];

/** A guide's words with `{command}` written as that command's keys (or 「キー設定で割り当て」 when it has none). */
export function fillKeys(text: string, keysOf: (command: string) => string[]): string {
  return text.replace(/\{([\w.-]+)\}/g, (_, id: string) => {
    const keys = keysOf(id);
    return keys.length ? keyLabel(keys[0]) : "（キー未設定）";
  });
}

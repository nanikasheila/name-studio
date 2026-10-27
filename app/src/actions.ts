// What the workbench can be told to do, as commands: the keyboard shortcuts
// (R16) and the command palette run these, and the key settings list them.
// An action is added here once, with its label, group, keys and what it does.
import type { Board, LaneId } from "./board";
import type { Command } from "./commands";
import type { PaletteId } from "./dock";
import { ERASE_MODE_LABELS, type EditorEraseMode, type PageEditor, type Tool } from "./editor";
import type { Page } from "./model";

/** What the commands need from the workbench. */
export interface CommandHost {
  readonly editor: PageEditor;
  readonly board: Board;
  /** Whether a name is open. */
  hasProject(): boolean;
  status(message: string): void;
  save(saveAs: boolean): void;
  undo(): void;
  redo(): void;
  setView(mode: "spread" | "single" | "continuous"): void;
  setRows(rows: number): void;
  setTool(tool: Tool): void;
  setEraseMode(mode: EditorEraseMode): void;
  resizeBrush(factor: number): boolean;
  deleteSelection(): void;
  copyItems(): boolean;
  /** Paste what was copied, or the clipboard's picture. */
  paste(): void;
  /** One spread to the left (1) or right (-1). */
  flipLeft(step: 1 | -1): void;
  makeOption(first: number, last: number): void;
  /** Tab: the side palettes and the story band hidden, the pages take the room (again: back). */
  toggleFocus(): void;
  arrange(pageId: string): void;
  addTails(pageId?: string): number;
  addPageAfter(page: Page): void;
  openPalette(id: PaletteId): void;
  openCommandPalette(): void;
  /** This name's last export again, with the same settings (the first time: the export dialog). */
  exportAgain(): void;
  /** Click a button of the screen when it is there and can be pressed; false otherwise. */
  click(buttonId: string): boolean;
  /** Whether that button is there and can be pressed. */
  canClick(buttonId: string): boolean;
}

/** Every command, in the order the key settings and the palette show them. */
export function buildCommands(host: CommandHost): Command[] {
  const editor = host.editor;
  const page = () => editor.focusPage();
  const named = host.hasProject;
  const selected = () => editor.selection !== null;
  const button = (id: string, label: string, group: string, keys: string[] = [], words?: string): Command => ({
    id: `button.${id}`,
    label,
    group,
    keys,
    words,
    available: () => host.canClick(id),
    run: () => host.click(id),
  });
  const tool = (id: string, to: Tool, label: string, keys: string[], words?: string): Command => ({
    id,
    label,
    group: "道具",
    keys,
    words,
    available: named,
    run: () => {
      // As CSP's sub tools cycle: the eraser again changes how it erases.
      if (to === "eraser" && editor.tool === "eraser") nextEraseMode();
      else host.setTool(to);
      return true;
    },
  });
  const nextEraseMode = () => {
    const modes = Object.keys(ERASE_MODE_LABELS) as EditorEraseMode[];
    host.setEraseMode(modes[(modes.indexOf(editor.eraseMode) + 1) % modes.length]);
  };
  const lanes = (id: string, label: string, keys: string[], shown: LaneId[]): Command => ({
    id,
    label,
    group: "画面",
    keys,
    available: named,
    run: () => {
      for (const lane of shown) host.board.toggleLane(lane, true);
      return true;
    },
  });
  const palette = (id: PaletteId, label: string, words?: string): Command => ({
    id: `palette.${id}`,
    label: `欄「${label}」を開く`,
    group: "欄",
    keys: [],
    words,
    available: named,
    run: () => {
      host.openPalette(id);
      return true;
    },
  });
  const always = (run: () => void) => () => {
    run();
    return true;
  };

  return [
    { id: "palette.commands", label: "命令を探して実行する（命令パレット）", group: "ファイル", keys: ["Ctrl+K"], words: "コマンド 検索 さがす", run: always(() => host.openCommandPalette()) },
    { id: "save", label: "保存", group: "ファイル", keys: ["Ctrl+S"], available: named, run: always(() => host.save(false)) },
    { id: "saveAs", label: "名前を付けて保存", group: "ファイル", keys: ["Ctrl+Shift+S"], available: named, run: always(() => host.save(true)) },
    button("open", "開く…", "ファイル", [], "ファイル ネーム 読む"),
    button("new-project", "新しいネーム…", "ファイル", [], "作る 白紙"),
    button("name-export", "書き出す…（CSP・PDF・台本）", "ファイル", [], "エクスポート clip cmc pdf 台本 テキスト"),
    { id: "exportAgain", label: "前回と同じ設定で書き出す", group: "ファイル", keys: ["Ctrl+Shift+E"], words: "もう一度 再書き出し エクスポート clip pdf", available: named, run: always(() => host.exportAgain()) },
    button("versions", "版の履歴…", "ファイル", [], "バージョン 戻す 自動保存"),
    { id: "undo", label: "元に戻す", group: "編集", keys: ["Ctrl+Z"], available: named, run: always(() => host.undo()) },
    { id: "redo", label: "やり直す", group: "編集", keys: ["Ctrl+Y", "Ctrl+Shift+Z"], available: named, run: always(() => host.redo()) },
    { id: "delete", label: "選んだものを消す", group: "編集", keys: ["Delete", "Backspace"], available: selected, run: always(() => host.deleteSelection()) },
    { id: "copy", label: "コピー", group: "編集", keys: ["Ctrl+C"], available: selected, run: () => host.copyItems() },
    {
      id: "cut",
      label: "切り取り",
      group: "編集",
      keys: ["Ctrl+X"],
      available: selected,
      run: () => {
        if (!host.copyItems()) return false;
        host.deleteSelection();
        host.status("切り取りました。Ctrl+V で、ポインターのあるページに貼り付けます");
        return true;
      },
    },
    {
      id: "paste",
      label: "貼り付け（ポインターのあるページへ）",
      group: "編集",
      keys: ["Ctrl+V"],
      available: named,
      run: () => {
        host.paste();
        // The browser's paste comes too, with the clipboard's picture if there is one.
        return false;
      },
    },
    { id: "selectAll", label: "ページの線とセリフを全部選ぶ", group: "編集", keys: ["Ctrl+A"], available: named, run: () => editor.selectAll() },
    { id: "flip.horizontal", label: "選んだ線とセリフを左右反転", group: "編集", keys: [], available: selected, run: () => editor.transformSelection("flipH") },
    { id: "flip.vertical", label: "選んだ線とセリフを上下反転", group: "編集", keys: [], available: selected, run: () => editor.transformSelection("flipV") },
    { id: "transform", label: "選んだものを変形（拡大縮小・回転・自由変形）", group: "編集", keys: ["Ctrl+T"], available: selected, run: () => editor.toggleTransform() },
    {
      id: "deselect",
      label: "選択を外す",
      group: "編集",
      keys: ["Escape"],
      available: named,
      run: always(() => {
        // Esc ends 変形 first, then lets go of the selection.
        if (editor.isTransforming) editor.toggleTransform(false);
        else editor.select(null);
      }),
    },
    tool("tool.select", "select", "選択", ["V"]),
    tool("tool.cut", "cut", "コマ割り", ["K"], "コマ 割る 枠"),
    tool("tool.text", "text", "セリフ", ["T"], "文字 フキダシ テキスト"),
    tool("tool.pen", "pen", "ペン", ["P"], "ラフ 描く"),
    tool("tool.eraser", "eraser", "消しゴム（もう一度で消し方を切り替え）", ["E"]),
    tool("tool.fill", "fill", "投げなわ塗り（ベタ・グレー・白）", ["G"], "塗り ベタ トーン"),
    tool("tool.breakout", "breakout", "はみ出し", ["B"]),
    tool("tool.sticky", "sticky", "付箋", ["M"], "メモ"),
    tool("tool.reference", "reference", "資料画像", ["I"], "写真 背景 画像"),
    {
      id: "eraser.next",
      label: "消し方を切り替える",
      group: "道具",
      keys: [],
      available: named,
      run: always(() => {
        if (editor.tool !== "eraser") host.setTool("eraser");
        else nextEraseMode();
      }),
    },
    { id: "brush.bigger", label: "ペン・消しゴムを太く", group: "道具", keys: ["]"], available: named, run: () => host.resizeBrush(1.25) },
    { id: "brush.smaller", label: "ペン・消しゴムを細く", group: "道具", keys: ["["], available: named, run: () => host.resizeBrush(0.8) },
    button("reference-add", "資料画像を貼る…", "道具", [], "写真 背景 画像"),
    button("brush-import", "CSP のブラシを取り込む…", "道具", [], "サブツール sut ペン"),
    { id: "page.next", label: "左の見開きへ（右綴じは次・左綴じは前。何も選んでいないとき）", group: "ページ", keys: ["ArrowLeft"], available: named, run: always(() => host.flipLeft(1)) },
    { id: "page.previous", label: "右の見開きへ（右綴じは前・左綴じは次。何も選んでいないとき）", group: "ページ", keys: ["ArrowRight"], available: named, run: always(() => host.flipLeft(-1)) },
    {
      id: "page.arrange",
      label: "このページのセリフを並べ直す",
      group: "ページ",
      keys: [],
      words: "読む順 改行 整列",
      available: () => page() !== null,
      run: () => {
        const p = page();
        if (p) host.arrange(p.id);
        return p !== null;
      },
    },
    {
      id: "page.tails",
      label: "このページのしっぽのないセリフにしっぽを付ける",
      group: "ページ",
      keys: [],
      words: "しっぽ 話者",
      available: () => page() !== null,
      run: () => {
        const p = page();
        if (p) host.addTails(p.id);
        return p !== null;
      },
    },
    { id: "name.tails", label: "全ページのしっぽのないセリフにしっぽを付ける", group: "ページ", keys: [], words: "しっぽ 話者 全部", available: named, run: always(() => host.addTails()) },
    {
      id: "page.add",
      label: "このページの後ろにページを足す",
      group: "ページ",
      keys: [],
      words: "追加 挿入",
      available: () => page() !== null,
      run: () => {
        const p = page();
        if (p) host.addPageAfter(p);
        return p !== null;
      },
    },
    {
      id: "option.make",
      label: "このページの別案を作る",
      group: "ページ",
      keys: [],
      available: named,
      run: () => {
        const [first] = editor.currentPages();
        if (!first) return false;
        host.makeOption(first - 1, first - 1);
        return true;
      },
    },
    { id: "view.edit", label: "物語の帯を元の高さに（ページを大きく）", group: "画面", keys: ["F1"], available: named, run: always(() => host.board.toggleWide(false)) },
    { id: "view.board", label: "物語の帯を大きく・戻す（型・シーン・時系列・感情・ページ）", group: "画面", keys: ["F6"], available: named, run: always(() => host.board.toggleWide()) },
    { id: "view.fold", label: "物語の帯をたたむ・広げる（ページを広く）", group: "画面", keys: ["Shift+F6"], words: "隠す 閉じる 下の帯", available: named, run: always(() => host.board.toggleFold()) },
    lanes("view.structure", "帯にシーンと字数を出す", ["F2"], ["scene", "text"]),
    lanes("view.emotion", "帯に感情曲線を出す", ["F3"], ["emotion"]),
    lanes("view.timeline", "帯に時系列を出す", ["F4"], ["time"]),
    { id: "view.fit", label: "全体を表示（拡大・移動・回転を戻す）", group: "画面", keys: ["Ctrl+0"], available: named, run: always(() => editor.fitView()) },
    { id: "view.rotateLeft", label: "画面を左に 15° 回す（Shift + Space + ドラッグで自由に）", group: "画面", keys: ["-"], available: named, run: always(() => editor.rotateView(-15)) },
    { id: "view.rotateRight", label: "画面を右に 15° 回す", group: "画面", keys: ["^"], available: named, run: always(() => editor.rotateView(15)) },
    {
      id: "view.continuous",
      label: "連続（全ページを一枚のキャンバスに）と見開きを切り替える",
      group: "画面",
      keys: ["F7"],
      available: named,
      run: always(() => host.setView(editor.continuous ? (editor.single ? "single" : "spread") : "continuous")),
    },
    { id: "view.spread", label: "見開きで表示", group: "画面", keys: [], words: "見開き", available: named, run: always(() => host.setView("spread")) },
    { id: "view.single", label: "1 ページずつ大きく表示（単独）", group: "画面", keys: [], words: "単独 1ページ", available: named, run: always(() => host.setView("single")) },
    {
      id: "view.fewerRows",
      label: "連続: 行を減らす（1 行で全ページ横一列）",
      group: "画面",
      keys: ["Alt+ArrowUp"],
      available: named,
      run: always(() => {
        if (!editor.continuous) host.setView("continuous");
        host.setRows(editor.rowCount() - 1);
      }),
    },
    {
      id: "view.moreRows",
      label: "連続: 行を増やす（俯瞰しやすく）",
      group: "画面",
      keys: ["Alt+ArrowDown"],
      available: named,
      run: always(() => {
        if (!editor.continuous) host.setView("continuous");
        host.setRows(editor.rowCount() + 1);
      }),
    },
    {
      id: "view.all",
      label: "連続: 全ページを画面に収める",
      group: "画面",
      keys: ["Ctrl+Alt+0"],
      available: named,
      run: always(() => {
        if (!editor.continuous) host.setView("continuous");
        editor.fitAll();
      }),
    },
    button("read-mode", "読む（見開きで通し読み。←→・クリック・ホイールでめくる、Esc で戻る）", "画面", ["F5"], "読む 通し読み プレビュー 確認"),
    { id: "view.focus", label: "左右の欄と物語の帯を隠してページを大きく（もう一度で戻す）", group: "画面", keys: ["Tab"], available: named, run: always(() => host.toggleFocus()) },
    palette("pages", "ページ", "一覧 並べ替え"),
    palette("script", "台本", "台本 プロット 取り込み markdown"),
    palette("cast", "人物", "登場人物 キャラ"),
    palette("notes", "付箋", "メモ 未決"),
    palette("held", "保留", "置き場所"),
    palette("layers", "レイヤー", "コマ枠 フォルダ"),
    palette("series", "シリーズ", "話 次の話"),
    palette("inspector", "詳細", "設定 プロパティ"),
    button("settings", "設定…", "設定", [], "コマ間 フォント 吸着 読む向き"),
    button("shortcuts", "キー設定…", "設定", [], "ショートカット キーボード"),
    button("pen-settings", "ペン設定…", "設定", [], "筆圧 タブレット"),
  ];
}

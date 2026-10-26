// The right panel (the inspector) and the bar of actions beside the
// selection: what can be changed about the selected panel, line, sticky,
// fill, line drawing or the page in view.
import { ask } from "@tauri-apps/plugin-dialog";
import { alternativesOf, joinAlternative } from "./alternatives";
import { wantsTail } from "./autotail";
import { SHAPE_LABELS, TAIL_LABELS, defaultTailStyle, resolvedShape } from "./balloon";
import type { Board } from "./board";
import { $, choice, element, plainButton, svg } from "./dom";
import { pickedSummary, type PageEditor, type Selection } from "./editor";
import { BALLOON_TEXT_KEY, PANEL_CARRIES_KEY } from "./prefs";
import { fontField } from "./fontpicker";
import { APP_FONT_LABEL, FONT_ROLE_LABELS, lineFont } from "./fonts";
import { writeFlag } from "./settings";
import { MAX_LINE_MM, MIN_LINE_MM, defaultFontPt, setPanelLineMm, setStyleLine, styleLineMm } from "./style";
import {
  BORDER_LABELS,
  EFFECT_LABELS,
  FILL_LABELS,
  PATTERNS,
  patternCount,
  SIDE_LABELS,
  addInset,
  applyPattern,
  bleedPanel,
  facingPage,
  isBled,
  rotatePanel,
  spreadPanel,
  spreadPair,
  setSpreadPage,
  unspreadPanel,
  type Side,
} from "./koma";
import { joinPanels, joinedShape, neighbours } from "./komaedit";
import { addCharacter } from "./cast";
import { fitLine, KIND_LABELS, setDefaultLineSize, setDefaultShape, setLineKind, setLineText, wrapTypedLine } from "./dialogue";
import { rectShape } from "./geometry";
import type { Alternatives, BalloonShape, FillTone, Line, LineKind, Page, Panel, PanelBorder, PanelEffect, PanelFill, Project, Sticky, StickyColor, TailStyle } from "./model";
import { basicBox } from "./pagebox";
import { addPanel, wantsSpread } from "./panels";
import { insertPage, movePage, pageIndex, removePage } from "./project";
import { assignPanels, orderPanels, sortLines } from "./readingorder";
import { linkLabel, STICKY_COLORS } from "./stickies";
import { TONE_LABELS } from "./strokes";

/** What the inspector needs from the workbench around it. */
export interface InspectorHost {
  readonly editor: PageEditor;
  readonly board: Board;
  project(): Project | null;
  /** One undoable change. */
  edit(change: (project: Project) => void): void;
  status(message: string): void;
  deleteSelection(): void;
  /** Take one しっぽ off a line. */
  removeTail(pageId: string, lineId: string, index: number): void;
  /** A text field edited live; the whole edit becomes one undo step. */
  liveText(field: HTMLInputElement | HTMLTextAreaElement, apply: (value: string) => void): void;
  /** A number edited live (typing, arrows, the wheel); a pause makes it one undo step. */
  liveNumber(field: HTMLInputElement, apply: (value: number) => void): void;
  arrange(pageId: string, panelId?: string): void;
  addTails(pageId?: string): number;
  holdSelected(page: Page, panel: Panel): void;
  moveSelectedTo(page: Page, panel: Panel, to: Page): void;
  makeOption(first: number, last: number): void;
  useOption(set: Alternatives, optionId: string): void;
  /** Opens the 別案 comparison for a set. */
  compare(setId: string): void;
}

export class Inspector {
  constructor(private readonly host: InspectorHost) {}

  /** The bar of actions beside the selection: what is used most, without going to the right. */
  actions(selection: Selection): HTMLElement[] {
    const project = this.host.project();
    const page = project?.pages.find((p) => p.id === selection.pageId);
    if (!project || !page) return [];
    const button = (label: string, title: string, run: () => void, className = "") => {
      const b = element("button", { textContent: label, title, className });
      b.addEventListener("click", run);
      return b;
    };
    const copy = button("コピー", "コピー（Ctrl+C）。Ctrl+V でポインターのあるページへ", () => this.host.editor.copy());
    const transform = button(
      "変形",
      "拡大縮小・回転・自由変形（Ctrl+T）。四角で大きさ、丸で回転、Ctrl + 角で自由変形。Enter で終わる",
      () => this.host.editor.toggleTransform(),
      this.host.editor.isTransforming ? "active" : "",
    );
    const remove = button("消す", "消す（Delete）", () => this.host.deleteSelection(), "danger");
    switch (selection.kind) {
      case "panel": {
        const panel = page.panels.find((p) => p.id === selection.id);
        if (!panel) return [];
        const inset = button("はめ込み", "このコマの角に重ねる小さなコマを足す", () => {
          let created: Panel | null = null;
          this.host.edit((p) => (created = addInset(p, page, panel)));
          if (created) this.host.editor.select({ kind: "panel", pageId: page.id, id: (created as Panel).id });
        });
        const hasLines = page.lines.some((line) => line.panel === panel.id);
        const arrange = button("セリフを並べる", "このコマのセリフを読む順に右上から並べ直す（長いセリフは改行）", () => this.host.arrange(page.id, panel.id));
        const hold = button("保留", "中身ごと保留にする: 置き場所を決めるまで、左の「保留」に置いておく", () => this.host.holdSelected(page, panel));
        const moveTo = element("select", { title: "中身ごとほかのページへ移す" });
        moveTo.append(element("option", { value: "", textContent: "移す…" }));
        project.pages.forEach((other, index) => {
          if (other !== page) moveTo.append(element("option", { value: other.id, textContent: `→ ${index + 1} ページ` }));
        });
        moveTo.addEventListener("change", () => {
          const to = project.pages.find((p) => p.id === moveTo.value);
          if (to) this.host.moveSelectedTo(page, panel, to);
        });
        return [
          button("メモ", "このコマのメモをその場で書く（コマをダブルクリックでも）", () => this.host.editor.editInPlace(page.id, "note", panel.id)),
          transform,
          ...(hasLines ? [arrange] : []),
          inset,
          hold,
          moveTo,
          copy,
          remove,
        ];
      }
      case "line": {
        const line = page.lines.find((l) => l.id === selection.id);
        if (!line) return [];
        const kind = choice(KIND_LABELS, line.kind, (value: LineKind) => this.host.edit((p) => setLineKind(p, line, value)));
        kind.title = "種類";
        const tail = button("しっぽ", "しっぽを足す。丸い先をドラッグして話者に向ける", () =>
          this.host.edit(() => {
            const [x0, , , y1] = line.box;
            const offset = (line.tails?.length ?? 0) * 8;
            line.tails = [...(line.tails ?? []), { tip: [x0 - 6 - offset, y1 + 12], style: defaultTailStyle(line) }];
          }),
        );
        tail.disabled = resolvedShape(line) === "none";
        const mask = button(
          "マスク",
          "コマ枠でマスク: コマの外に出た所を隠す（もう一度押すと戻す）",
          () => this.host.edit(() => (line.mask ? delete line.mask : (line.mask = true))),
          line.mask ? "active" : "",
        );
        if (selection.tail !== undefined && line.tails?.[selection.tail]) {
          remove.textContent = "しっぽを消す";
          remove.title = `選んだ ${selection.tail + 1} 本目のしっぽだけ消す（Delete）`;
        }
        return [button("書く", "その場で書き直す（ダブルクリックでも）", () => this.host.editor.editInPlace(page.id, "line", line.id)), kind, tail, ...(line.panel ? [mask] : []), transform, copy, remove];
      }
      case "stroke":
      case "group":
        return [
          button("左右反転", "左右を入れ替える", () => this.host.editor.transformSelection("flipH")),
          button("⟳ 90°", "右に 90° 回す", () => this.host.editor.transformSelection("right")),
          copy,
          remove,
        ];
      case "fill": {
        const fill = page.fills?.find((f) => f.id === selection.id);
        if (!fill) return [];
        const tone = choice(TONE_LABELS, fill.tone ?? "black", (value: FillTone) =>
          this.host.edit(() => {
            if (value === "black") delete fill.tone;
            else fill.tone = value;
          }),
        );
        return [tone, transform, copy, remove];
      }
      case "breakout":
        return [transform, copy, remove];
      default:
        return [copy, remove];
    }
  }

  /** そのページのメモ（プロット）, kept in sight while working on its panels and dialogue. */
  private pageMemo(project: Project, page: Page): HTMLElement[] {
    const memo = page.memo.trim();
    if (!memo) return [];
    const box = element("div", { className: "page-memo", title: "ページのメモ（ページを選ぶと直せます）" });
    box.append(element("span", { className: "label", textContent: `${pageIndex(project, page.id) + 1} ページのメモ` }), element("div", { textContent: memo }));
    return [box];
  }

  /** Fills the right panel for the selection (or the page in view). */
  render(): void {
    const panel = $("inspector");
    const project = this.host.project();
    if (!project) {
      panel.replaceChildren();
      return;
    }
    // A scene or the story shape picked in the strip under the page.
    const story = this.host.board.inspector();
    if (story) return panel.replaceChildren(...story);
    const s = this.host.editor.selection;
    const page = s ? project.pages.find((p) => p.id === s.pageId) : this.host.editor.focusPage();
    if (!page) {
      panel.replaceChildren(element("p", { className: "hint", textContent: "ページがありません。左の「最後にページを足す」で始めましょう。" }));
      return;
    }
    if (s?.kind === "line") {
      const line = page.lines.find((l) => l.id === s.id);
      if (line) return panel.replaceChildren(...this.pageMemo(project, page), ...this.lineInspector(project, page, line));
    }
    if (s?.kind === "panel") {
      const target = page.panels.find((p) => p.id === s.id);
      if (target) return panel.replaceChildren(...this.pageMemo(project, page), ...this.panelInspector(project, page, target.id, target.order));
    }
    if (s?.kind === "sticky") {
      const sticky = page.stickies?.find((n) => n.id === s.id);
      if (sticky) return panel.replaceChildren(...this.stickyInspector(page, sticky));
    }
    if (s?.kind === "fill") {
      const fill = page.fills?.find((f) => f.id === s.id);
      if (fill) {
        const tone = choice(TONE_LABELS, fill.tone ?? "black", (value: FillTone) =>
          this.host.edit(() => {
            if (value === "black") delete fill.tone;
            else fill.tone = value;
          }),
        );
        const remove = element("button", { className: "danger", textContent: "この塗りを消す" });
        remove.addEventListener("click", () => this.host.deleteSelection());
        return panel.replaceChildren(
          element("h2", { textContent: "塗り" }),
          element("label", {}, "色", tone),
          element("p", { className: "hint", textContent: "ドラッグや矢印キーで動かせます。コマを動かすと一緒に動きます。CSP には「コマの塗り・効果」の画像レイヤーで書き出します。" }),
          remove,
        );
      }
    }
    if (s?.kind === "group") {
      const remove = element("button", { className: "danger", textContent: "選んだものを消す（Delete）" });
      remove.addEventListener("click", () => this.host.deleteSelection());
      return panel.replaceChildren(
        element("h2", { textContent: "範囲選択" }),
        element("p", {
          className: "hint",
          textContent: `${pickedSummary(s.items ?? [])}。ドラッグや矢印キーでまとめて動かせます（コマは中に描いたものと一緒に）。枠の四角で大きさ（Shift で縦横別々、Alt で中心から）、上の丸で向き（Shift で 15° ずつ）、Ctrl + 角で自由変形。Shift + クリックで足す・外す。Ctrl+C / Ctrl+V でほかのページへも写せます。`,
        }),
        ...this.transformButtons(),
        remove,
      );
    }
    if (s?.kind === "stroke") {
      const stroke = page.strokes.find((x) => x.id === s.id);
      const remove = element("button", { className: "danger", textContent: "この線を消す" });
      remove.addEventListener("click", () => this.host.deleteSelection());
      const over = element("input", { type: "checkbox", checked: !!stroke?.over });
      over.addEventListener("change", () =>
        this.host.edit(() => {
          if (!stroke) return;
          if (over.checked) stroke.over = true;
          else delete stroke.over;
        }),
      );
      return panel.replaceChildren(
        element("h2", { textContent: "ラフの線" }),
        element("label", { className: "inline" }, over, "コマ枠の上に描く（はみ出し）"),
        ...this.transformButtons(),
        remove,
      );
    }
    if (s?.kind === "breakout") {
      const breakout = page.breakouts.find((x) => x.id === s.id);
      if (breakout) {
        const note = element("input", { type: "text", value: breakout.note ?? "", placeholder: "例: 全身が枠を突き抜ける" });
        this.host.liveText(note, (value) => {
          if (value) breakout.note = value;
          else delete breakout.note;
        });
        const remove = element("button", { className: "danger", textContent: "このはみ出しを消す" });
        remove.addEventListener("click", () => this.host.deleteSelection());
        return panel.replaceChildren(
          element("h2", { textContent: "はみ出し" }),
          element("p", {
            className: "hint",
            textContent: "この中ではコマ枠と間白が消えます。中でペンを描き始めた線は、コマ枠の上に描かれます（CSP では「はみ出し（ラフ線）」レイヤー）。",
          }),
          element("label", {}, "メモ", note),
          remove,
        );
      }
    }
    panel.replaceChildren(...this.pageInspector(project, page));
  }

  /** Hints folded away once read: the first sentence shows, the rest opens on a click. */
  private openHints = new Set<string>();

  /**
   * The inspector in the colour of what is selected, with its tool's icon, and
   * long how-to hints folded to their first sentence.
   */
  dress(): void {
    const panel = $("inspector");
    const kind = this.host.board.selected ? "story" : (this.host.editor.selection?.kind ?? "page");
    panel.dataset.kind = kind;
    const tool = { panel: "tool-cut", line: "tool-text", sticky: "tool-sticky", fill: "tool-fill", stroke: "tool-pen", breakout: "tool-breakout", group: "tool-select" }[kind as string];
    const icon = tool ? document.getElementById(tool)?.querySelector("svg") : kind === "page" ? pageIcon() : null;
    const title = panel.querySelector("h2");
    if (icon && title && !title.querySelector("svg")) title.prepend(icon.cloneNode(true));
    for (const hint of panel.querySelectorAll<HTMLElement>("p.hint")) {
      const text = hint.textContent ?? "";
      const cut = text.indexOf("。") + 1;
      if (cut <= 0 || cut >= text.length - 1 || text.length < 40) continue;
      const head = cut <= 46 ? text.slice(0, cut) : "使い方";
      const fold = element("details", { className: "hint-fold" }, element("summary", { textContent: head }), element("p", { textContent: head === "使い方" ? text : text.slice(cut) }));
      fold.open = this.openHints.has(text);
      fold.addEventListener("toggle", () => (fold.open ? this.openHints.add(text) : this.openHints.delete(text)));
      hint.replaceWith(fold);
    }
  }

  private lineInspector(project: Project, page: Page, line: Line): HTMLElement[] {
    const text = element("textarea", { value: line.text, spellcheck: false });
    this.host.liveText(text, (value) => setLineText(line, value));
    // Done typing a long line in one go: broken into short lines (before the change is recorded).
    text.addEventListener("change", () => {
      if (wrapTypedLine(line)) {
        text.value = line.text;
        this.host.editor.draw();
      }
    }, { capture: true });
    const kind = element("select");
    for (const [value, label] of Object.entries(KIND_LABELS)) kind.append(element("option", { value, textContent: label }));
    kind.value = line.kind;
    kind.addEventListener("change", () => this.host.edit((p) => setLineKind(p, line, kind.value as LineKind)));
    const speaker = element("select");
    speaker.append(element("option", { value: "", textContent: "（なし）" }));
    for (const character of project.characters) speaker.append(element("option", { value: character.id, textContent: character.name }));
    speaker.append(element("option", { value: "__new", textContent: "新しい人物…" }));
    speaker.value = line.speaker ?? "";
    speaker.addEventListener("change", () =>
      this.host.edit((p) => {
        if (speaker.value === "__new") {
          // Named in the 人物 tab; a prompt here would interrupt the writing.
          line.speaker = addCharacter(p, `人物${p.characters.length + 1}`).id;
          this.host.status("人物を足しました。名前は左の「人物」で変えられます");
        } else if (speaker.value) {
          line.speaker = speaker.value;
        } else {
          delete line.speaker;
        }
      }),
    );
    const size = element("input", { type: "number", min: "4", max: "72", step: "0.5", value: String(round(line.fontSizePt)), title: "文字の大きさ（pt）。マウスのホイールでも変えられます" });
    this.host.liveNumber(size, (value) => {
      line.fontSizePt = value;
      setLineText(line, line.text);
    });
    // 文字の大きさの既定: this kind of line gets this size from now on.
    const usualSize = defaultFontPt(line.kind, project.style);
    const sizeDefault = element("button", {
      className: "small",
      textContent: "既定にする",
      title: `この大きさを「${KIND_LABELS[line.kind]}」の文字の大きさの既定にする（今は ${round(usualSize)} pt）。既定の大きさのままだった同じ種類のセリフも変わります`,
      disabled: line.fontSizePt === usualSize,
    });
    sizeDefault.addEventListener("click", () => {
      let changed = 0;
      const pt = line.fontSizePt;
      this.host.edit((p) => (changed = setDefaultLineSize(p, line.kind, pt)));
      this.host.status(`「${KIND_LABELS[line.kind]}」の文字の大きさの既定を ${round(pt)} pt にしました（同じ種類のほかのセリフ ${changed} 個も変えました）`);
    });
    const vertical = element("input", { type: "checkbox", checked: line.vertical });
    vertical.addEventListener("change", () =>
      this.host.edit(() => {
        line.vertical = vertical.checked;
        fitLine(line);
      }),
    );
    const remove = element("button", { className: "danger", textContent: "このセリフを消す" });
    remove.addEventListener("click", () => this.host.deleteSelection());
    // フォント: this line's own, else the one for its kind (設定 → 用途ごと).
    const usualFont = lineFont({ kind: line.kind, emphasis: line.emphasis }, project.fonts);
    const usualRole = line.emphasis && project.fonts?.emphasis ? "emphasis" : line.kind;
    const font = fontField(
      line.font ?? "",
      `${FONT_ROLE_LABELS[usualRole]}のフォント（${usualFont ?? APP_FONT_LABEL}）`,
      (name) =>
        this.host.edit(() => {
          if (name) line.font = name;
          else delete line.font;
        }),
      "このセリフだけのフォント。種類ごとのフォントは「設定」で決めます",
      line.text.replace(/\s+/g, " ").slice(0, 40),
    );
    // 変形: the text grows with the balloon, or the balloon alone changes around it.
    const follows = element("input", { type: "checkbox", checked: this.host.editor.balloonTextFollows });
    follows.addEventListener("change", () => {
      this.host.editor.balloonTextFollows = follows.checked;
      writeFlag(BALLOON_TEXT_KEY, follows.checked);
    });
    const fitBalloon = element("button", {
      textContent: "フキダシを文字に合わせる",
      title: "フキダシだけ変えた大きさをやめて、文字に合った大きさに戻す",
      disabled: !line.balloonScale,
    });
    fitBalloon.addEventListener("click", () =>
      this.host.edit(() => {
        delete line.balloonScale;
        fitLine(line);
      }),
    );
    const panelNumber = page.panels.find((p) => p.id === line.panel)?.order;
    const shape = choice(
      SHAPE_LABELS,
      line.balloonShape ?? "auto",
      (value: BalloonShape) =>
        this.host.edit(() => {
          if (value === "auto") delete line.balloonShape;
          else line.balloonShape = value;
          fitLine(line);
        }),
      ["custom"],
    );
    // 作品の既定: this kind of line gets this shape from now on.
    const current = line.balloonShape ?? "auto";
    const usual = project.lineShapes?.[line.kind] ?? "auto";
    const makeDefault = element("button", {
      textContent: `「${KIND_LABELS[line.kind]}」の既定にする`,
      title: "この作品で、この種類のセリフを作るときの形にする。今までの既定の形だった同じ種類のセリフも変わります",
      disabled: current === usual || current === "custom",
    });
    makeDefault.addEventListener("click", () => {
      let changed = 0;
      this.host.edit((p) => {
        changed = setDefaultShape(p, line.kind, current);
      });
      this.host.status(`「${KIND_LABELS[line.kind]}」の形を「${SHAPE_LABELS[current]}」にしました（同じ種類のほかのセリフ ${changed} 個も変えました）。台本の取り込みや新しいセリフもこの形になります`);
    });
    const flag = (label: string, checked: boolean, set: (on: boolean) => void) => {
      const box = element("input", { type: "checkbox", checked });
      box.addEventListener("change", () => this.host.edit(() => set(box.checked)));
      return element("label", { className: "inline" }, box, label);
    };
    const inverted = flag("白抜き", !!line.inverted, (on) => (on ? (line.inverted = true) : delete line.inverted));
    const emphasis = flag("太字（強調）", !!line.emphasis, (on) => (on ? (line.emphasis = true) : delete line.emphasis));
    const mask = flag("コマ枠でマスク（枠の外を隠す）", !!line.mask, (on) => (on ? (line.mask = true) : delete line.mask));
    if (!line.panel) {
      mask.title = "コマの中にないセリフはマスクできません";
      mask.querySelector("input")!.disabled = !line.mask;
    }
    const hasBalloon = resolvedShape(line) !== "none";
    const tails = line.tails ?? [];
    const addTail = element("button", { textContent: "しっぽを足す", disabled: !hasBalloon });
    addTail.addEventListener("click", () => {
      this.host.edit(() => {
        const [x0, , , y1] = line.box;
        // Down and to the left; drag the round handle to the speaker.
        const offset = (line.tails?.length ?? 0) * 8;
        line.tails = [...(line.tails ?? []), { tip: [x0 - 6 - offset, y1 + 12], style: defaultTailStyle(line) }];
      });
      this.host.editor.select({ kind: "line", pageId: page.id, id: line.id, tail: (line.tails?.length ?? 1) - 1 });
    });
    // しっぽ: one row each, to choose (its tip is filled on the page), restyle or remove that tail alone.
    const chosen = this.host.editor.selection?.kind === "line" && this.host.editor.selection.id === line.id ? this.host.editor.selection.tail : undefined;
    const tailRows = tails.map((tail, index) => {
      const pick = element("button", {
        className: `tail-pick${index === chosen ? " active" : ""}`,
        textContent: `${index + 1}`,
        title: `${index + 1} 本目のしっぽを選ぶ（先が塗られます。Delete で消せます）`,
      });
      pick.addEventListener("click", () =>
        this.host.editor.select(index === chosen ? { kind: "line", pageId: page.id, id: line.id } : { kind: "line", pageId: page.id, id: line.id, tail: index }),
      );
      const style = choice(TAIL_LABELS, tail.style ?? defaultTailStyle(line), (value: TailStyle) =>
        this.host.edit(() => {
          const target = line.tails?.[index];
          if (target) target.style = value;
        }),
      );
      style.title = `${index + 1} 本目のしっぽの形`;
      const remove = element("button", { className: "tail-remove", textContent: "×", title: `${index + 1} 本目のしっぽを消す` });
      remove.addEventListener("click", () => this.host.removeTail(page.id, line.id, index));
      return element("div", { className: `tail-row${index === chosen ? " chosen" : ""}` }, pick, style, remove);
    });
    const tailStyleAll =
      tails.length > 1
        ? choice({ "": "（全部をそろえる）", ...TAIL_LABELS } as Record<"" | TailStyle, string>, "", (value: "" | TailStyle) => {
            if (!value) return;
            this.host.edit(() => {
              for (const tail of line.tails ?? []) tail.style = value;
            });
          })
        : null;
    const names = new Map(project.characters.map((c) => [c.id, c.name]));
    const link = element("select");
    link.append(element("option", { value: "", textContent: "（つながない）" }));
    for (const other of page.lines) {
      if (other.id === line.id || other.linkTo === line.id) continue;
      const who = names.get(other.speaker ?? "");
      const text = other.text.replace(/\s+/g, " ").slice(0, 12);
      link.append(element("option", { value: other.id, textContent: `${who ? `${who}：` : ""}${text}` }));
    }
    link.value = line.linkTo ?? "";
    link.disabled = !hasBalloon;
    link.addEventListener("change", () =>
      this.host.edit(() => {
        if (link.value) line.linkTo = link.value;
        else delete line.linkTo;
      }),
    );
    setTimeout(() => {
      // Written on the page itself when it is open there.
      if (line.text === "セリフ" && !this.host.editor.editingInPlace) {
        text.focus();
        text.select();
      }
    });
    return [
      element("h2", { textContent: `${pageIndex(project, page.id) + 1} ページのセリフ${panelNumber ? `（${panelNumber} コマ目）` : ""}` }),
      element("label", {}, "文字", text),
      element("div", { className: "row" }, element("label", {}, "種類", kind), element("label", {}, "話者", speaker)),
      ...(toneOf(project, line.speaker) ? [element("p", { className: "hint tone-hint", textContent: `口調: ${toneOf(project, line.speaker)}` })] : []),
      element("div", { className: "row" }, element("label", {}, "文字の大きさ（pt）", element("span", { className: "with-button" }, size, sizeDefault)), element("label", { className: "inline" }, vertical, "縦書き")),
      element("div", { className: "row" }, emphasis, inverted),
      element("label", {}, "フォント", font),
      element("h3", { textContent: "フキダシ" }),
      element("label", {}, "形", shape),
      makeDefault,
      mask,
      element("label", { className: "inline", title: "切ると、変形の枠でフキダシだけ広げたり細くしたりでき、文字の大きさはそのまま" }, follows, "変形で文字の大きさも変える"),
      fitBalloon,
      element("div", { className: "tails-head" }, element("span", { textContent: `しっぽ（${tails.length} 本）` }), ...(tailStyleAll ? [tailStyleAll] : []), addTail),
      ...(tailRows.length ? [element("div", { className: "tail-rows" }, ...tailRows)] : []),
      element("label", {}, "つなぐ（連結フキダシ）", link),
      element("p", {
        className: "hint",
        textContent:
          "しっぽの丸い先をドラッグして話者に向けます（コマの外の話者にも）。ひし形で曲げ、フキダシの縁の小さな四角で根本の位置を動かせます。2本以上で同時に話す声。しっぽを押すと選べて（先が塗られます）、Delete か × でその 1 本だけ消せます。改行で行を分けます。ドラッグか矢印キーで動かせます。",
      }),
      remove,
    ];
  }

  private panelInspector(project: Project, page: Page, panelId: string, order: number): HTMLElement[] {
    const panel = page.panels.find((p) => p.id === panelId)!;
    const remove = element("button", { className: "danger", textContent: "このコマを消す" });
    remove.addEventListener("click", () => this.host.deleteSelection());
    const lines = page.lines.filter((line) => line.panel === panelId).length;
    const set = <K extends keyof Panel>(key: K, value: Panel[K], none: Panel[K]) =>
      this.host.edit(() => {
        if (value === none) delete panel[key];
        else panel[key] = value;
      });
    const border = choice(BORDER_LABELS, panel.border ?? "solid", (value: PanelBorder) => set("border", value, "solid"));
    // 枠線の太さ: this panel's own, else the name's for its kind of border (設定).
    const thick = panel.border === "thick";
    const usualWidth = styleLineMm(thick, project.style);
    const width = element("input", {
      type: "number",
      min: String(MIN_LINE_MM),
      max: String(MAX_LINE_MM),
      step: "0.05",
      value: panel.lineMm === undefined ? "" : String(panel.lineMm),
      placeholder: `${usualWidth}（既定）`,
      title: "このコマの枠線の太さ（mm）。空欄で作品の既定（設定 → コマ割り）",
      disabled: panel.border === "none",
    });
    width.addEventListener("change", () => {
      const value = width.value.trim() === "" ? null : Number(width.value);
      this.host.edit((p) => setPanelLineMm(panel, value, p.style));
    });
    const widthDefault = element("button", {
      className: "small",
      textContent: "既定にする",
      title: `この太さを作品の${thick ? "太枠" : "枠線"}の既定にする（ほかの${thick ? "太枠" : "枠線"}のコマも変わります）`,
      disabled: panel.lineMm === undefined,
    });
    widthDefault.addEventListener("click", () => {
      const mm = panel.lineMm;
      if (mm === undefined) return;
      this.host.edit((p) => {
        setStyleLine(p, thick ? "thickLineMm" : "panelLineMm", mm);
        delete panel.lineMm;
      });
      this.host.status(`${thick ? "太枠" : "枠線"}の太さの既定を ${mm} mm にしました（太さを決めていないコマはみなこの太さです）`);
    });
    const fill = choice(FILL_LABELS, panel.fill ?? "none", (value: PanelFill) => set("fill", value, "none"));
    const effect = choice(EFFECT_LABELS, panel.effect ?? "none", (value: PanelEffect) => set("effect", value, "none"));
    const bleeds = (["top", "right", "bottom", "left"] as Side[]).map((side) => {
      const box = element("input", { type: "checkbox", checked: isBled(panel, side, project.pageFormat) });
      box.addEventListener("change", () => this.host.edit((p) => bleedPanel(panel, side, p.pageFormat, box.checked)));
      return element("label", { className: "inline" }, box, SIDE_LABELS[side]);
    });
    const button = (label: string, action: (p: Project) => void, title = "") => {
      const b = element("button", { textContent: label, title });
      b.addEventListener("click", () => this.host.edit(action));
      return b;
    };
    const tiltLeft = button("⟲ 2°", () => rotatePanel(panel, -2), "左に傾ける");
    const tiltRight = button("⟳ 2°", () => rotatePanel(panel, 2), "右に傾ける");
    const raise = button("前へ", () => (panel.z = (panel.z ?? 0) + 1), "重なりで上にする");
    const lower = button("後ろへ", () => {
      panel.z = (panel.z ?? 0) - 1;
      if (!panel.z) delete panel.z;
    }, "重なりで下にする");
    const inset = element("button", { textContent: "はめ込みコマを足す", title: "このコマの左下に重ねる小さなコマ" });
    inset.addEventListener("click", () => {
      let created: Panel | null = null;
      this.host.edit((p) => (created = addInset(p, page, panel)));
      if (created) this.host.editor.select({ kind: "panel", pageId: page.id, id: (created as Panel).id });
    });
    const firstAlone = this.host.editor.firstAlone;
    const spread = panel.spread
      ? button("見開きをやめる", (p) => unspreadPanel(p, page, panel, firstAlone), "向かいのページの半分を消して、このページだけのコマに戻す")
      : button("見開きにする", (p) => spreadPanel(p, page, panel, firstAlone), "のどをまたいで向かいのページまで伸ばす");
    spread.disabled = !panel.spread && !facingPage(project, page, firstAlone);
    const carries = element("input", { type: "checkbox", checked: this.host.editor.panelCarries });
    carries.addEventListener("change", () => {
      this.host.editor.panelCarries = carries.checked;
      writeFlag(PANEL_CARRIES_KEY, carries.checked);
    });
    const note = element("input", { type: "text", value: panel.note ?? "", placeholder: "例: 俯瞰で教室全体 / 間" });
    this.host.liveText(note, (value) => {
      if (value) panel.note = value;
      else delete panel.note;
    });
    return [
      element("h2", { textContent: `${pageIndex(project, page.id) + 1} ページ ${order} コマ目` }),
      element("label", {}, "メモ（ページの上にも出ます。コマをダブルクリックでその場で書けます。札はドラッグで好きな所へ）", note),
      ...(panel.noteAt ? [plainButton("メモの札をコマの角に戻す", () => this.host.edit(() => delete panel.noteAt))] : []),
      element("div", { className: "row" }, element("label", {}, "枠線", border), element("label", {}, "塗り", fill)),
      element("label", {}, "枠線の太さ（mm）", element("span", { className: "with-button" }, width, widthDefault)),
      element("label", {}, "背景の効果", effect),
      element("h3", { textContent: "裁ち切り（ページの外まで）" }),
      element("div", { className: "row" }, ...bleeds),
      spread,
      element("h3", { textContent: "形と重なり" }),
      element("label", { className: "inline" }, carries, "動かす・形を変えるとき、中のセリフとラフ線も一緒に"),
      element("div", { className: "row" }, tiltLeft, tiltRight, raise, lower),
      inset,
      ...(lines
        ? [
            (() => {
              const b = element("button", { textContent: "このコマのセリフを並べ直す", title: "読む順に右上から並べ直す。長いセリフは句読点や助詞のあとで改行する" });
              b.addEventListener("click", () => this.host.arrange(page.id, panel.id));
              return b;
            })(),
          ]
        : []),
      ...this.joinButtons(page, panel),
      element("p", {
        className: "hint",
        textContent: `セリフ ${lines} 件。コマの境目（間白）をドラッグすると両側のコマが一緒に動き、外側の辺なら辺だけが動きます。境目をダブルクリックで隣とつなげます。角の四角をドラッグすると形を変えられます（枠に吸い付きます。Alt で吸い付かない）。右上の番号を別のコマへドラッグ（または Alt + ドラッグ）すると中身を入れ替えます。重なり ${panel.z ?? 0}。`,
      }),
      remove,
    ];
  }

  /** 反転・回転 of the selected rough lines and dialogue. */
  private transformButtons(): HTMLElement[] {
    const make = (label: string, how: "flipH" | "flipV" | "left" | "right", title: string) => {
      const b = element("button", { textContent: label, title });
      b.addEventListener("click", () => this.host.editor.transformSelection(how));
      return b;
    };
    return [
      element("h3", { textContent: "変形" }),
      element("div", { className: "row" }, make("左右反転", "flipH", "左右を入れ替える"), make("上下反転", "flipV", "上下を入れ替える")),
      element("div", { className: "row" }, make("⟲ 90°", "left", "左に 90° 回す"), make("⟳ 90°", "right", "右に 90° 回す")),
    ];
  }

  /** つなげる: one button per panel across a border from this one. */
  private joinButtons(page: Page, panel: Panel): HTMLElement[] {
    const found = neighbours(page, panel);
    if (!found.length) return [];
    const order = { right: 0, top: 1, bottom: 2, left: 3 } as const;
    const buttons = found
      .sort((a, b) => order[a.side] - order[b.side])
      .map(({ panel: other, side }) => {
        const b = element("button", { textContent: `${SIDE_LABELS[side]}の ${other.order} とつなげる`, title: "間白をなくして 1 つのコマにする" });
        b.disabled = !!panel.spread || !!other.spread || !joinedShape(panel, other);
        if (b.disabled) b.title = "形がそろっていないか見開きのコマなので、つなげられません";
        b.addEventListener("click", () => {
          let joined = false;
          this.host.edit((p) => {
            const target = p.pages.find((x) => x.id === page.id);
            const a = target?.panels.find((x) => x.id === panel.id);
            const c = target?.panels.find((x) => x.id === other.id);
            if (!target || !a || !c) return;
            const [first, second] = a.order < c.order ? [a, c] : [c, a];
            joined = joinPanels(target, first, second, p.binding);
            if (joined) {
              assignPanels(target);
              sortLines(target, p.binding);
              this.host.editor.selection = { kind: "panel", pageId: page.id, id: first.id };
            }
          });
          if (joined) this.host.status("コマをつなげました（元に戻すは Ctrl+Z）");
        });
        return b;
      });
    return [element("h3", { textContent: "つなげる" }), element("div", { className: "row" }, ...buttons)];
  }

  private stickyInspector(page: Page, sticky: Sticky): HTMLElement[] {
    const text = element("textarea", { value: sticky.text, placeholder: "気づいたこと、直したいこと" });
    this.host.liveText(text, (value) => (sticky.text = value));
    const colors = (Object.keys(STICKY_COLORS) as StickyColor[]).map((color) => {
      const chip = element("button", { className: `sticky-color${(sticky.color ?? "yellow") === color ? " active" : ""}`, textContent: STICKY_COLORS[color].label, title: `${STICKY_COLORS[color].label}色` });
      chip.style.background = STICKY_COLORS[color].fill;
      chip.addEventListener("click", () =>
        this.host.edit(() => {
          if (color === "yellow") delete sticky.color;
          else sticky.color = color;
        }),
      );
      return chip;
    });
    const remove = element("button", { className: "danger", textContent: "この付箋をはがす" });
    remove.addEventListener("click", () => this.host.deleteSelection());
    // A new note: ready to write in.
    if (!sticky.text) setTimeout(() => text.focus(), 0);
    return [
      element("h2", { textContent: "付箋" }),
      element("label", {}, "メモ", text),
      element("div", { className: "row sticky-colors" }, ...colors),
      element("h3", { textContent: "紐づけ" }),
      linkLabel(page, sticky)
        ? element("div", { className: "row link-row" }, element("span", { className: "link-target", textContent: `→ ${linkLabel(page, sticky)}` }), plainButton("外す", () => this.host.edit(() => delete sticky.link)))
        : element("p", { className: "hint", textContent: "どこにも紐づいていません。付箋の左下の丸を、コマかセリフの上へドラッグすると紐づきます。" }),
      element("p", { className: "hint", textContent: "付箋は作業用のメモで、CSP・PDF には書き出しません。ドラッグで好きな所へ動かせ、紐づけた先とは線でつながったままです（コマやセリフを動かすと付いてきます）。" }),
      remove,
    ];
  }

  private pageInspector(project: Project, page: Page): HTMLElement[] {
    const index = pageIndex(project, page.id);
    const memo = element("textarea", { value: page.memo, placeholder: "このページで描くこと、狙い" });
    this.host.liveText(memo, (value) => (page.memo = value));
    const button = (label: string, action: () => void, disabled = false) => {
      const b = element("button", { textContent: label, disabled });
      b.addEventListener("click", action);
      return b;
    };
    const frame = button(
      "基本枠を 1 コマにする",
      () => this.host.edit((p) => addPanel(p, page, rectShape(basicBox(p.pageFormat)))),
      page.panels.length > 0,
    );
    const reorder = button("コマ番号を振り直す", () =>
      this.host.edit((p) => {
        orderPanels(page, p.binding);
        assignPanels(page);
        sortLines(page, p.binding);
      }),
    );
    const pattern = element("select");
    for (const item of PATTERNS) pattern.append(element("option", { value: item.id, textContent: `${item.label}（${patternCount(item.id)}）`, title: item.note }));
    const patternNote = element("p", { className: "hint", textContent: PATTERNS[0].note });
    // コマ数: empty keeps the pattern's own; the page's count is one click away.
    const count = element("input", { type: "number", min: "1", max: "12", step: "1", className: "count", title: "コマ数（空なら型のまま）" });
    count.placeholder = String(patternCount(pattern.value));
    pattern.addEventListener("change", () => {
      patternNote.textContent = PATTERNS.find((item) => item.id === pattern.value)?.note ?? "";
      count.placeholder = String(patternCount(pattern.value));
    });
    const applyButton = button("このページに当てる", async () => {
      const question = "今のコマを置き換えますか？中のセリフ・ラフ線・コマのメモは、コマの順に新しいコマへ移します（元に戻すで戻せます）";
      if (page.panels.length && !(await ask(question, { title: "Name Studio", kind: "warning" }))) return;
      this.host.edit((p) => {
        const wanted = Number(count.value);
        applyPattern(p, page, pattern.value, wanted >= 1 ? Math.min(12, Math.round(wanted)) : undefined);
        sortLines(page, p.binding);
      });
    });
    // A page added inside a 別案 belongs to that option (another ページ配分).
    const after = button("後ろにページを足す", () => this.host.edit((p) => joinAlternative(p, insertPage(p, index + 1).id, page.id, true)));
    const before = button("前にページを足す", () => this.host.edit((p) => joinAlternative(p, insertPage(p, index).id, page.id, false)));
    const earlier = button("1 つ前へ", () => this.host.edit((p) => movePage(p, page.id, -1)), index === 0);
    const later = button("1 つ後ろへ", () => this.host.edit((p) => movePage(p, page.id, 1)), index === project.pages.length - 1);
    const remove = button("このページを消す", async () => {
      const filled = page.panels.length + page.lines.length + page.strokes.length > 0;
      if (filled && !(await ask(`${index + 1} ページを消しますか？（元に戻すで戻せます）`, { title: "Name Studio", kind: "warning" }))) return;
      this.host.edit((p) => removePage(p, page.id));
    });
    remove.className = "danger";
    const pair = spreadPair(project, page, this.host.editor.firstAlone);
    const spreadSection: HTMLElement[] = [];
    if (pair) {
      const pairIndex = pageIndex(project, pair[0].id);
      const forced = wantsSpread(project, pairIndex) && !pair[0].joinNext;
      const box = element("input", { type: "checkbox", checked: wantsSpread(project, pairIndex), disabled: forced });
      box.addEventListener("change", () => this.host.edit((p) => setSpreadPage(p, page, this.host.editor.firstAlone, box.checked)));
      spreadSection.push(
        element("h3", { textContent: "見開き" }),
        element("label", { className: "inline" }, box, `${pairIndex + 1}–${pairIndex + 2} ページを CSP で 1 枚の見開きページにする`),
        element("p", {
          className: "hint",
          textContent: forced
            ? "ノドをまたぐコマがあるので、見開きページとして書き出します。"
            : "書き出すと、CSP の見開きページ（幅 2 倍の 1 ファイル）になります。ノドをまたいで線やコマを描けます。",
        }),
      );
    }
    const set = alternativesOf(project, page.id);
    const altSection: HTMLElement[] = [element("h3", { textContent: "別案" })];
    if (set) {
      const chips = set.options.map((option) => {
        const chip = button(option.name, () => this.host.useOption(set, option.id), false);
        if (option.id === set.active) chip.className = "in-use";
        chip.title = option.id === set.active ? "使用中" : "この案にする";
        return chip;
      });
      const first = pageIndex(project, set.pageIds[0]);
      const last = pageIndex(project, set.pageIds[set.pageIds.length - 1]);
      altSection.push(
        element("div", { className: "alt-chips" }, ...chips),
        element(
          "div",
          { className: "row" },
          button("比べる…", () => this.host.compare(set.id)),
          button("もう 1 案", () => this.host.makeOption(first, last)),
        ),
        element("p", { className: "hint", textContent: "案を押すとその案に入れ替わります。ページを足すと、その案だけのページになります（ページ配分の案）。" }),
      );
    } else {
      altSection.push(element("div", { className: "row" }, button("このページの別案を作る", () => this.host.makeOption(index, index))));
      if (pair) {
        const pairIndex = pageIndex(project, pair[0].id);
        altSection.push(element("div", { className: "row" }, button(`${pairIndex + 1}–${pairIndex + 2} ページの別案を作る`, () => this.host.makeOption(pairIndex, pairIndex + 1))));
      }
      altSection.push(element("p", { className: "hint", textContent: "今のページを写した案ができ、そちらを編集します。元の案はそのまま残り、比べて選べます。" }));
    }
    return [
      element("h2", { textContent: `${index + 1} ページ` }),
      element("label", {}, "メモ", memo),
      ...this.host.board.pageStory(project, page.id),
      element("h3", { textContent: "コマ" }),
      element("div", { className: "row" }, frame, reorder),
      button("このページのセリフを並べ直す", () => this.host.arrange(page.id), !page.lines.length),
      button("しっぽのないセリフにしっぽを付ける", () => this.host.addTails(page.id), !page.lines.some((line) => wantsTail(page, line))),
      element("p", { className: "hint", textContent: "コマ割り: コマを横切るように線を引くと割れます（ほぼ水平・垂直はまっすぐに。Alt で斜め）。コマの外をドラッグすると新しいコマ。" }),
      element("h3", { textContent: "コマ割りの型" }),
      element("div", { className: "row" }, pattern, element("label", { className: "inline" }, count, "コマ")),
      applyButton,
      patternNote,
      element(
        "p",
        { className: "hint" },
        "コマ数を入れると、型の見た目のまま段のコマをつなげる・割って合わせます。",
        ...(page.panels.length
          ? [" ", button(`今のコマ数（${page.panels.length}）にする`, () => (count.value = String(page.panels.length)), false)]
          : []),
      ),
      ...spreadSection,
      ...altSection,
      element("h3", { textContent: "ページ" }),
      element("div", { className: "row" }, before, after),
      element("div", { className: "row" }, earlier, later),
      remove,
    ];
  }
}

/** The page icon for the inspector's title when nothing is selected. */
function pageIcon(): SVGSVGElement {
  const icon = svg("svg", { viewBox: "0 0 20 20", class: "icon", "aria-hidden": "true" });
  icon.innerHTML = '<rect x="4" y="2.5" width="12" height="15" rx="1"/><path d="M4 9h12M10 9v8.5"/>';
  return icon;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The 口調 memo of a speaker, if they have one. */
function toneOf(project: Project, speaker: string | undefined): string | undefined {
  return speaker ? project.characters.find((character) => character.id === speaker)?.tone : undefined;
}

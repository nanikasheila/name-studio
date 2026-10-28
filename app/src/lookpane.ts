// 設定 › 画面の見た目: the theme (a sample of each), the screen's font and
// the size of its words, and the user's own CSS. A theme, a font and a size
// are the app's own and are kept at once; CSS is tried first: it is on the
// screen for a while with a bar to keep it or put it back, and only kept when
// asked, so CSS that breaks the screen goes away by itself. However the
// screen looks, Ctrl+Shift+Alt+R puts the look back as it comes (the keys
// are fixed, not in キー設定): the theme, font and size as they come, the CSS
// off but kept. Holding Shift as the app starts (or --safe-look) starts it
// without the CSS, that time only.
import { message } from "@tauri-apps/plugin-dialog";
import { showAlert } from "./alerts";
import { call } from "./backend";
import { $, element } from "./dom";
import { fontField } from "./fontpicker";
import {
  applyLook,
  clampSize,
  cssNotes,
  cssTemplate,
  DEFAULT_LOOK,
  DEFAULT_SIZE_PX,
  type Look,
  readLook,
  RESET_KEYS,
  THEMES,
  type ThemeId,
  tokenValues,
  userCssRules,
  writeLook,
} from "./look";

/** How long CSS is tried before it is put back by itself. */
export const TRIAL_SECONDS = 15;

/** Whether a key press is the fixed keys that put the look back. */
export function isResetKeys(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "code">): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && event.altKey && event.code === "KeyR";
}

export class LookPane {
  /** The look kept for the next start. */
  private kept: Look = readLook();
  /** CSS on the screen on trial (kept is what comes back), with its countdown. */
  private trial: { look: Look; left: number; timer: number } | null = null;
  private bar: HTMLElement | null = null;
  /** Started without the user's CSS (Shift held, --safe-look): it stays off until it is tried again. */
  private safe = false;
  private editorFilled = false;

  constructor(private readonly status: (message: string) => void) {
    $("st-ui-size").addEventListener("change", () => {
      const text = $<HTMLInputElement>("st-ui-size").value.trim();
      this.change({ sizePx: text === "" ? DEFAULT_SIZE_PX : clampSize(Number(text) || DEFAULT_SIZE_PX) });
      this.status(`画面の文字の大きさを ${this.kept.sizePx} px にしました`);
    });
    $("st-ui-size-reset").addEventListener("click", () => {
      this.change({ sizePx: DEFAULT_SIZE_PX });
      this.status(`画面の文字の大きさを初期（${DEFAULT_SIZE_PX} px）に戻しました`);
    });
    $<HTMLInputElement>("st-css-on").addEventListener("change", (event) => {
      if ((event.target as HTMLInputElement).checked) this.tryCss(this.editorText());
      else {
        this.endTrial(false);
        this.change({ css: this.editorText(), cssOn: false });
        this.status("カスタム CSS を切りました（中身は残っています）");
      }
    });
    $("st-css-apply").addEventListener("click", () => this.tryCss(this.editorText()));
    $<HTMLTextAreaElement>("st-css").addEventListener("input", () => this.showNotes());
    $("st-css-load").addEventListener("click", () => $<HTMLInputElement>("st-css-file").click());
    $<HTMLInputElement>("st-css-file").addEventListener("change", async (event) => {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      try {
        $<HTMLTextAreaElement>("st-css").value = await file.text();
        this.showNotes();
        this.status(`${file.name} を読み込みました。「当てて試す」で画面に当てます`);
      } catch (error) {
        this.status(`${file.name} を読めませんでした: ${error}`);
      }
    });
    $("st-css-template").addEventListener("click", () => {
      const editor = $<HTMLTextAreaElement>("st-css");
      const template = cssTemplate(tokenValues());
      editor.value = editor.value.trim() ? `${editor.value.trimEnd()}\n\n${template}` : template;
      editor.focus();
      this.showNotes();
    });
    // Whatever the screen looks like, and before anything else that listens to keys.
    window.addEventListener(
      "keydown",
      (event) => {
        if (!isResetKeys(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void this.reset();
      },
      { capture: true },
    );
    // The user's CSS waits for this (main.ts shows the rest of the look at once): started with
    // Shift held (or --safe-look), it is left off, the way back when the keys cannot be found either.
    void call("safe_look")
      .catch(() => false)
      .then((safe) => {
        this.safe = safe && this.kept.cssOn;
        applyLook(this.onScreen());
        if (this.safe) showAlert("look-safe", "Shift を押しながら起動したので、今回はカスタム CSS を当てていません。設定 › 画面の見た目 で直すか切ってください。", "warning", 20);
      });
  }

  /** The look on the screen: CSS on trial, or what is kept (without its CSS after a safe start). */
  private onScreen(): Look {
    if (this.trial) return this.trial.look;
    return this.safe ? { ...this.kept, cssOn: false } : this.kept;
  }

  /** Fills the pane from the look kept (and the CSS on trial, if any). */
  render(): void {
    const look = this.trial?.look ?? this.kept;
    this.renderThemes(look.theme);
    this.renderFont(look.font);
    const size = $<HTMLInputElement>("st-ui-size");
    if (document.activeElement !== size) size.value = String(look.sizePx);
    $<HTMLButtonElement>("st-ui-size-reset").disabled = look.sizePx === DEFAULT_SIZE_PX;
    $<HTMLInputElement>("st-css-on").checked = look.cssOn;
    // Filled once: after that it holds what is being written, also CSS that was tried and put back.
    if (!this.editorFilled) $<HTMLTextAreaElement>("st-css").value = look.css;
    this.editorFilled = true;
    this.showNotes();
  }

  /** この PC の設定を初期に戻す: the look as it comes, the user's CSS off but kept. */
  resetToDefault(): void {
    this.endTrial(false);
    this.safe = false;
    this.kept = { ...DEFAULT_LOOK, css: this.kept.css };
    writeLook(this.kept);
    applyLook(this.kept);
    this.render();
  }

  /** The fixed keys: the look as it comes, said where it can be seen whatever the screen looks like. */
  private async reset(): Promise<void> {
    this.resetToDefault();
    const words = `画面の見た目を初期に戻しました（${RESET_KEYS}）。カスタム CSS は切りました。中身は 設定 › 画面の見た目 に残っています。`;
    this.status(words);
    // A window of the system's own, which no CSS reaches.
    await message(words, { title: "Name Studio", kind: "info" }).catch(() => showAlert("look-reset", words, "warning", 10));
  }

  /** A theme, a font or a size: kept and shown at once (over CSS on trial, which stays on trial). */
  private change(change: Partial<Look>): void {
    this.kept = { ...this.kept, ...change };
    writeLook(this.kept);
    if (this.trial) this.trial.look = { ...this.trial.look, ...change, css: this.trial.look.css, cssOn: this.trial.look.cssOn };
    applyLook(this.onScreen());
    this.render();
  }

  private editorText(): string {
    return $<HTMLTextAreaElement>("st-css").value;
  }

  /** Puts `css` on the screen for a while: kept only when 「このままにする」 is pressed. */
  private tryCss(css: string): void {
    if (!css.trim()) {
      this.endTrial(false);
      this.change({ css, cssOn: false });
      this.status("カスタム CSS が空です。書くか、ファイルから読み込んでください");
      return;
    }
    const look = { ...this.kept, css, cssOn: true };
    if (this.trial) window.clearInterval(this.trial.timer);
    this.trial = { look, left: TRIAL_SECONDS, timer: window.setInterval(() => this.tick(), 1000) };
    applyLook(look);
    this.render();
    this.showBar();
    const rules = userCssRules();
    this.status(`カスタム CSS を当てました（${rules} 個の規則）。${TRIAL_SECONDS} 秒のうちに「このままにする」を押すと残ります`);
  }

  private tick(): void {
    if (!this.trial) return;
    this.trial.left -= 1;
    if (this.trial.left <= 0) {
      this.endTrial(false);
      this.status("カスタム CSS を元に戻しました（「このままにする」が押されなかったので）");
      return;
    }
    this.showBar();
  }

  /** Ends the trial: keeps the CSS tried, or puts back what was kept. */
  private endTrial(keep: boolean): void {
    const trial = this.trial;
    this.bar?.remove();
    this.bar = null;
    if (!trial) return;
    window.clearInterval(trial.timer);
    this.trial = null;
    if (keep) {
      this.kept = trial.look;
      this.safe = false;
      writeLook(this.kept);
    }
    applyLook(this.onScreen());
    this.render();
  }

  /** The bar that asks to keep the CSS, in the settings while they are open (the rest of the window cannot be pressed then). */
  private showBar(): void {
    if (!this.trial) return;
    if (!this.bar) {
      const keep = element("button", { type: "button", className: "primary", textContent: "このままにする", title: "このカスタム CSS を残す（次の起動からも使う）" });
      keep.addEventListener("click", () => {
        this.endTrial(true);
        this.status("カスタム CSS を残しました（次の起動からも使います）");
      });
      const back = element("button", { type: "button", textContent: "元に戻す", title: "試す前の見た目に戻す（CSS は欄に残る）" });
      back.addEventListener("click", () => {
        this.endTrial(false);
        this.status("カスタム CSS を元に戻しました");
      });
      this.bar = element("div", { id: "look-trial", className: "look-trial" }, element("span", { className: "look-trial-text" }), keep, back);
      this.bar.setAttribute("role", "alertdialog");
      this.bar.setAttribute("aria-label", "カスタム CSS を残すか");
    }
    const host = document.querySelector<HTMLDialogElement>("dialog[open]") ?? document.body;
    if (this.bar.parentElement !== host) host.append(this.bar);
    const text = this.bar.querySelector(".look-trial-text");
    if (text) text.textContent = `カスタム CSS を試しています。このままにしますか？ あと ${this.trial.left} 秒で元に戻ります`;
  }

  /** Under the CSS: what is worth knowing before it is used, or how much of it the screen took. */
  private showNotes(): void {
    const css = this.editorText();
    const notes = cssNotes(css);
    const on = (this.trial?.look ?? this.kept).cssOn;
    const sameAsShown = css === (this.trial?.look ?? this.kept).css;
    const note = $("st-css-note");
    note.classList.toggle("warn", notes.length > 0 || this.safe);
    if (notes.length) note.textContent = notes.join("。");
    else if (this.safe) note.textContent = "Shift を押しながら起動したので、今回は当てていません（「当てて試す」でまた試せます）";
    else if (on && sameAsShown) note.textContent = `${this.trial ? "試しています" : "使っています"}（${userCssRules()} 個の規則）`;
    else if (on) note.textContent = "書きかえたところは「当てて試す」で画面に当たります";
    else note.textContent = "";
  }

  private renderThemes(current: ThemeId): void {
    const box = $("st-themes");
    if (box.contains(document.activeElement) && box.querySelector(`[data-theme-id="${current}"][aria-checked="true"]`)) return;
    box.replaceChildren(
      ...THEMES.map((theme) => {
        const card = element("button", { type: "button", className: "theme-card", title: theme.note });
        card.dataset.themeId = theme.id;
        card.setAttribute("role", "radio");
        card.setAttribute("aria-checked", String(theme.id === current));
        // The sample in the theme's own colours (Windows に合わせる: light and dark side by side).
        const sample = (id: ThemeId) => {
          const look = element("span", { className: "theme-sample" }, element("i", { className: "ts-bar" }), element("i", { className: "ts-side" }), element("i", { className: "ts-page" }), element("i", { className: "ts-accent" }));
          look.dataset.theme = id;
          return look;
        };
        const samples = theme.id === "system" ? element("span", { className: "theme-samples split" }, sample("light"), sample("dark")) : element("span", { className: "theme-samples" }, sample(theme.id));
        card.append(samples, element("span", { className: "theme-name", textContent: theme.label }));
        card.addEventListener("click", () => {
          this.change({ theme: theme.id });
          this.status(`配色を「${theme.label}」にしました`);
          box.querySelector<HTMLElement>(`[data-theme-id="${theme.id}"]`)?.focus();
        });
        return card;
      }),
    );
  }

  private renderFont(font: string | null): void {
    const box = $("st-ui-font");
    if (box.contains(document.activeElement)) return;
    box.replaceChildren(
      fontField(
        font ?? "",
        "アプリの既定（Yu Gothic UI）",
        (name) => {
          this.change({ font: name || null });
          this.status(name ? `画面のフォントを ${name} にしました` : "画面のフォントをアプリの既定に戻しました");
        },
        "画面のフォント",
        "画面の文字 あいう アイウ 漢字 ABC 123",
      ),
    );
  }
}

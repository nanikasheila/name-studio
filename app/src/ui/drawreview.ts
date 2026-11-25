// 要求の点検 in the 作画 palette: name-blockout (Python, on this computer)
// checks the panels about to be asked (what is missing or contradicts) and
// puts one or two questions at a time, each with choices and one
// recommended. A choice is taken into the name (bgreview.ts) and the check
// runs again, so the next question comes; what is still guessed stays listed.
// Where name-blockout is (a folder of its source, or installed for Python)
// is set here too, and the request tells the AI how to run it.
import { findingsByShot, readReview, answer, type Finding, type Question, type Review } from "../domain/bgreview";
import { findPanel, type BackgroundTake } from "../domain/background";
import { BACKGROUND_DPI } from "../domain/background";
import type { BackgroundAsset } from "../domain/bgassets";
import { requestInstruction } from "../domain/bginstruction";
import type { Panel, Project } from "../model/model";
import { call } from "../platform/backend";
import { open } from "../platform/dialogs";
import { plainButton } from "../platform/dom";
import { failureText } from "../platform/errortext";
import { readText, writeText } from "../platform/settings";
import { tag as element } from "./drawinstructions";

const SOURCE_KEY = "namestudio.blockout.folder";
/** Questions put at a time. */
const AT_ONCE = 2;
const MARKS: Record<Finding["level"], string> = { error: "✗", warn: "!", info: "・" };

export interface ReviewHost {
  project(): Project | null;
  edit(change: (project: Project) => void): void;
  status(message: string): void;
  /** The background folder (made when need be). */
  folder(): Promise<string>;
  /** The panels 頼む would send now. */
  targets(project: Project): Panel[];
  takes(): readonly BackgroundTake[];
  assets(): { folder: string; list: BackgroundAsset[] } | undefined;
  /** Show a panel on the page. */
  reveal(panelId: string): void;
}

export class DrawReview {
  /** name-blockout's source folder (none: as installed for Python). */
  private source = readText(SOURCE_KEY) ?? "";
  /** Python and name-blockout found (or why not; null: not looked for yet). */
  private found: { python: string; version: string } | string | null = null;
  private review: Review | null = null;
  /** The panels the last check was of. */
  private checked: string[] = [];
  private busy = false;
  private error = "";
  private built: HTMLElement | null = null;
  private setupBuilt: HTMLElement | null = null;

  constructor(private readonly host: ReviewHost) {}

  /** How to run name-blockout here, for the request's words (none: not found). */
  get command(): { python: string; source: string | null } | null {
    return this.found && typeof this.found !== "string" ? { python: this.found.python, source: this.source || null } : null;
  }

  async detect(): Promise<void> {
    try {
      this.found = await call("blockout_detect", { folder: this.source || null });
    } catch (error) {
      this.found = failureText("", error);
    }
    this.render();
  }

  /** The row in the palette's settings: where name-blockout is. */
  setupView(): HTMLElement {
    const pick = plainButton("選ぶ…", () => void this.pickSource());
    pick.title = "name-blockout のフォルダー（GitHub から取ってきたもの。中に src/name_blockout がある）を選ぶ";
    const forget = plainButton("外す", () => {
      this.source = "";
      writeText(SOURCE_KEY, null);
      void this.detect();
    });
    forget.dataset.part = "blockout-forget";
    forget.title = "フォルダーを使わない（pip で入れた name-blockout を使う）";
    this.setupBuilt = element(
      "div",
      { class: "drawing-folder drawing-blockout" },
      element("span", { class: "hint", title: "背景の要求の点検と、箱のあたり・作画を Blender で組む道具" }, "name-blockout: "),
      element("span", { "data-part": "blockout-found" }),
      pick,
      forget,
    );
    this.renderSetup();
    return this.setupBuilt;
  }

  private async pickSource(): Promise<void> {
    const chosen = await open({ directory: true, title: "name-blockout のフォルダー" });
    if (typeof chosen !== "string") return;
    this.source = chosen;
    writeText(SOURCE_KEY, chosen);
    await this.detect();
  }

  /** The 点検 section: its button, the questions and what is still open. */
  view(): HTMLElement {
    const go = plainButton("点検", () => void this.run());
    go.dataset.part = "review-go";
    go.title = "頼む前に、name-blockout で指示の足りない所・食い違いを確かめ、選択肢つきで 1〜2 問ずつ聞く";
    this.built = element(
      "section",
      { class: "drawing-review", "data-part": "review" },
      element(
        "div",
        { class: "assist-row" },
        go,
        element("span", { class: "hint drawing-review-state", "data-part": "review-state", "aria-live": "polite" }),
      ),
      element("div", { class: "drawing-questions", "data-part": "questions" }),
      element("div", { "data-part": "findings" }),
    );
    this.render();
    return this.built;
  }

  private part<T extends HTMLElement>(name: string): T {
    return this.built!.querySelector<T>(`[data-part="${name}"]`)!;
  }

  /** Check the panels 頼む would send. */
  async run(ids?: string[]): Promise<void> {
    const project = this.host.project();
    if (!project || this.busy) return;
    const targets = ids ?? this.host.targets(project).map((panel) => panel.id);
    if (!targets.length) {
      this.error = "点検するコマがありません（頼むコマを選んでください）";
      this.render();
      return;
    }
    this.busy = true;
    this.error = "";
    this.render();
    try {
      const background = await this.host.folder();
      const assets = this.host.assets();
      const instruction = requestInstruction(
        project,
        {
          stamp: "点検",
          targets: targets.map((panel) => ({ panel })),
          note: "",
          dpi: BACKGROUND_DPI,
          folder: background,
          blender: null,
          ...(assets ? { assets } : {}),
        },
        this.host.takes(),
      );
      const out = await call("blockout_check", {
        background,
        folder: this.source || null,
        instruction: JSON.stringify(instruction),
        questions: AT_ONCE,
      });
      this.review = readReview(out);
      this.checked = targets;
    } catch (error) {
      this.error = failureText("", error);
      this.review = null;
    }
    this.busy = false;
    this.render();
  }

  /** A choice made: into the name, then checked again for the next question. */
  private choose(question: Question, set: Record<string, unknown> | null): void {
    this.host.edit((project) => {
      const found = findPanel(project, question.shot);
      if (found) answer(found.panel, question, set);
    });
    void this.run(this.checked);
  }

  render(): void {
    this.renderSetup();
    if (!this.built) return;
    const go = this.part<HTMLButtonElement>("review-go");
    const missing = typeof this.found === "string";
    go.disabled = this.busy || missing;
    const review = this.review;
    const open = review?.findings.filter((f) => f.level !== "info") ?? [];
    this.part("review-state").textContent = this.busy
      ? "点検しています…"
      : this.error
        ? this.error
        : missing
          ? "name-blockout が見つかりません（設定で選べます）"
          : !review
            ? ""
            : review.questions.length
              ? `質問 ${review.questions.length} 問${open.length ? `・気になる所 ${open.length} 件` : ""}`
              : open.length
                ? `質問はありません・気になる所 ${open.length} 件`
                : "点検: 足りない所・食い違いはありません";
    this.part("review-state").dataset.tone = this.error || open.some((f) => f.level === "error") ? "warn" : "";
    this.part("questions").replaceChildren(...(review?.questions ?? []).map((question) => this.questionView(question)));
    this.part("findings").replaceChildren(...(review ? this.findingsView(review) : []));
  }

  private renderSetup(): void {
    const says = this.setupBuilt?.querySelector<HTMLElement>('[data-part="blockout-found"]');
    if (!says) return;
    says.textContent =
      this.found === null
        ? "探しています…"
        : typeof this.found === "string"
          ? this.found
          : `${this.found.version}${this.source ? `（${this.source}）` : ""}`;
    says.title = typeof this.found === "string" || !this.found ? "" : `Python: ${this.found.python}`;
    this.setupBuilt!.querySelector<HTMLElement>('[data-part="blockout-forget"]')!.hidden = !this.source;
  }

  private questionView(question: Question): HTMLElement {
    const head = element("button", { type: "button", class: "drawing-question-panel", title: "紙面でこのコマを見る" }, question.label);
    head.addEventListener("click", () => this.host.reveal(question.shot));
    const options = question.options.map((option, i) => {
      const button = plainButton(i === question.recommended ? `${option.label}（おすすめ）` : option.label, () =>
        this.choose(question, option.set),
      );
      if (i === question.recommended) button.classList.add("primary");
      button.disabled = this.busy;
      return button;
    });
    return element(
      "div",
      { class: "drawing-question", "data-shot": question.shot, "data-path": question.path },
      element("div", { class: "assist-row" }, head, element("strong", {}, question.text)),
      ...(question.why ? [element("p", { class: "hint" }, question.why)] : []),
      element("div", { class: "assist-row drawing-question-options" }, ...options),
    );
  }

  /** What is still open, a panel each: errors and warnings shown, what was guessed folded. */
  private findingsView(review: Review): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const [shot, findings] of findingsByShot(review)) {
      const shown = findings.filter((f) => f.level !== "info");
      const guessed = findings.filter((f) => f.level === "info");
      const line = (f: Finding) => element("li", { "data-level": f.level }, `${MARKS[f.level]} ${f.message}`);
      out.push(
        element(
          "div",
          { class: "drawing-findings", "data-shot": shot },
          element("strong", {}, findings[0].label || shot),
          ...(shown.length ? [element("ul", {}, ...shown.map(line))] : []),
          ...(guessed.length
            ? [
                element(
                  "details",
                  {},
                  element("summary", { class: "hint" }, `仮に決めること ${guessed.length} 件`),
                  element("ul", {}, ...guessed.map(line)),
                ),
              ]
            : []),
        ),
      );
    }
    return out;
  }
}

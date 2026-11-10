// The 相談 palette (AI に相談): talk the open name over with Claude Code,
// Codex or a local LLM. The AI is shown the name in words and as pictures
// (assistchat.ts says what it is told); what it proposes comes back as
// 変更の案, shown with what each would do, and applied with 当てる as one
// undoable change. The palette's ⚙ holds where the programs are, the models,
// the local LLM's address and key, and puts the Skill where the AI tools find it.
import { open } from "./dialogs";
import { applyOps, nameBrief, parseOps, previewOps, type AssistOp } from "./assist";
import {
  agentInstructions,
  AI_LABELS,
  BRIEF_FILE,
  changedPrompt,
  choiceProblem,
  Conversation,
  COPY_FILE,
  DEFAULT_ASSIST,
  firstPrompt,
  localInstructions,
  modelFor,
  newTalkId,
  orderTalks,
  pictureFile,
  readAssistSettings,
  readSavedTalk,
  replyParts,
  STARTERS,
  talkTitle,
  type AiModel,
  type AssistSettings,
  type SavedTalk,
  type TalkSummary,
} from "./assistchat";
import { call, onAiEvent, type AiEvent, type AiKind, type AiTools, type ChatMessage, type SessionFile } from "./backend";
import { plainButton } from "./dom";
import { pagePictures } from "./flatpage";
import { markdownView } from "./mdview";
import type { Project, RoughImage } from "./model";
import { readJson, writeText } from "./settings";
import { fail } from "./status";
import { failureText } from "./errortext";

/** Codex's sandbox can be chosen only where it has more than one (Windows). */
const WINDOWS = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

export interface AssistHost {
  project(): Project | null;
  /** The open name's file (null: not saved yet). */
  path(): string | null;
  /** One undoable change. */
  edit(change: (project: Project) => void): void;
  /** Page numbers (from 1) on screen now. */
  currentPages(): number[];
  rough(rough: RoughImage): Promise<CanvasImageSource | null>;
  status(message: string): void;
}

export const ASSIST_KEY = "namestudio.assist";

/** A new element with these attributes and children. */
function element<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

/** A cheap fingerprint of a name, to tell whether it changed since the AI last saw it. */
function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}

/** The models a tool listed (or why it could not), for the program or address asked. */
interface ModelList {
  from: string;
  list?: AiModel[];
  error?: string;
}

interface Talk {
  /** Its id in the kept conversations (ai-history). */
  id: string;
  created: number;
  conversation: Conversation;
  /** The conversation's folder. */
  dir: string | null;
  /** The name it is about (its file; empty when not saved). */
  name: string;
  /** The name as the AI last saw it. */
  seen: string;
}

export class AssistPanel {
  private settings: AssistSettings = readAssistSettings(readJson(ASSIST_KEY, null));
  private talk: Talk | null = null;
  private tools: AiTools | null = null;
  private hasKey = false;
  private built: HTMLElement | null = null;
  /** Events for a turn whose number is not known yet (the turn's first events can come before it is). */
  private early: AiEvent[] = [];
  /** 変更の案 applied, by where they are in the conversation. */
  private readonly applied = new Set<string>();
  private preparing = false;
  /** The list of kept conversations shows other names' too. */
  private allTalks = false;
  /** The settings' 詳しく is open. */
  private moreOpen = false;
  /** Each tool's own list of models, fetched when the settings are opened. */
  private readonly models: Partial<Record<AiKind, ModelList>> = {};

  constructor(private readonly host: AssistHost) {
    void onAiEvent((event) => this.hear(event)).catch(() => {});
  }

  private save(change: Partial<AssistSettings>): void {
    this.settings = { ...this.settings, ...change };
    writeText(ASSIST_KEY, JSON.stringify(this.settings));
  }

  /** Draw the palette (built once; later only what changed). */
  render(container: HTMLElement): void {
    if (this.built?.parentElement !== container) {
      container.replaceChildren(this.build());
      void this.detect();
    }
    this.renderState();
  }

  private get root(): HTMLElement {
    return this.built!;
  }

  private part<T extends HTMLElement>(name: string): T {
    return this.root.querySelector<T>(`[data-part="${name}"]`)!;
  }

  private build(): HTMLElement {
    const kind = element("select", { "data-part": "kind", "aria-label": "相談する相手", title: "相談する相手" });
    for (const id of Object.keys(AI_LABELS) as AiKind[]) kind.append(element("option", { value: id }, AI_LABELS[id]));
    kind.value = this.settings.kind;
    kind.addEventListener("change", () => {
      this.save({ kind: kind.value as AiKind });
      this.renderSettings();
      this.renderState();
    });
    const gear = plainButton("接続…", () => {
      const form = this.part("settings");
      form.hidden = !form.hidden;
      if (!form.hidden) this.renderSettings();
    });
    gear.title = "相手の場所・モデル、ローカル LLM の URL と鍵、スキルを入れる";
    const past = plainButton("履歴", () => {
      const box = this.part("history");
      box.hidden = !box.hidden;
      if (!box.hidden) void this.renderHistory();
    });
    past.title = "前の相談の一覧。開くと続きを話せる";
    const fresh = plainButton("新しい相談", () => this.reset());
    fresh.title = "今の相談を終えて、新しく始める（相手は前の話を忘れます）";
    const input = element("textarea", { "data-part": "input", rows: "3", placeholder: "相談したいこと（Ctrl+Enter で送る）", "aria-label": "相談したいこと" });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.send(input.value);
      }
      event.stopPropagation();
    });
    const pictures = element("input", { type: "checkbox", "data-part": "pictures" });
    pictures.checked = this.settings.pictures;
    pictures.addEventListener("change", () => this.save({ pictures: pictures.checked }));
    const send = plainButton("送る", () => void this.send(input.value));
    send.dataset.part = "send";
    send.classList.add("primary");
    const stop = plainButton("止める", () => void this.stop());
    stop.dataset.part = "stop";
    const starters = element("div", { class: "assist-starters" });
    for (const starter of STARTERS) {
      const button = plainButton(starter.label, () => {
        input.value = starter.text;
        input.focus();
      });
      button.title = starter.text;
      starters.append(button);
    }
    this.built = element(
      "div",
      { class: "assist" },
      // What may shrink and scroll when the palette is short; the box to write in and 送る stay below it.
      element(
        "div",
        { class: "assist-top" },
        element("div", { class: "assist-head" }, kind, gear, past, fresh),
        element("p", { class: "hint assist-state", "data-part": "state" }),
        element("div", { class: "assist-settings", "data-part": "settings", hidden: "" }),
        element("div", { class: "assist-history", "data-part": "history", hidden: "" }),
        element("div", { class: "assist-log", "data-part": "log", "aria-live": "polite" }),
        starters,
      ),
      input,
      element("div", { class: "assist-actions" }, element("label", { class: "check", title: "ページの絵（ラフ・コマ・フキダシ）も見せる。言葉だけより的確になるが、少し時間がかかる" }, pictures, " ページの絵も見せる"), send, stop),
    );
    this.renderLog();
    return this.built;
  }

  /** Which tools this computer has. */
  private async detect(): Promise<void> {
    try {
      this.tools = await call("ai_detect", { claude: this.settings.claudePath || null, codex: this.settings.codexPath || null });
      this.hasKey = await call("ai_has_key");
    } catch {
      this.tools = null;
    }
    this.renderState();
  }

  /** Where the list of `kind`'s models comes from (a different program or address means a different list). */
  private modelSource(kind: AiKind): string {
    return kind === "claude" ? this.settings.claudePath : kind === "codex" ? this.settings.codexPath : this.settings.endpoint;
  }

  private chosenModel(kind: AiKind): string {
    return kind === "claude" ? this.settings.claudeModel : kind === "codex" ? this.settings.codexModel : this.settings.localModel;
  }

  private chosenEffort(kind: AiKind): string {
    return kind === "claude" ? this.settings.claudeEffort : kind === "codex" ? this.settings.codexEffort : "";
  }

  /** The list for `kind`, if fetched from where it now comes from. */
  private listed(kind: AiKind): ModelList | undefined {
    const known = this.models[kind];
    return known && known.from === this.modelSource(kind) ? known : undefined;
  }

  /** Ask the tool for its models (it lists them itself, so none is mistyped). */
  private async loadModels(kind: AiKind, again = false): Promise<void> {
    if (!again && this.listed(kind)) return;
    const from = this.modelSource(kind);
    this.models[kind] = { from };
    this.renderSettings();
    let fetched: ModelList;
    try {
      const list = await call("ai_models", { kind, program: kind === "local" ? null : from || null, endpoint: kind === "local" ? from : null });
      fetched = { from, list };
    } catch (error) {
      fetched = { from, error: String(error) };
    }
    if (this.modelSource(kind) !== from) return;
    this.models[kind] = fetched;
    if (kind === "local" && fetched.list && !this.settings.localModel && fetched.list.length) this.save({ localModel: fetched.list[0].value });
    this.renderSettings();
    this.renderState();
  }

  /** The line under the header: who will answer, and whether they are there. */
  private renderState(): void {
    if (!this.built) return;
    const state = this.part("state");
    const kind = this.settings.kind;
    const running = this.talk?.conversation.running != null || this.preparing;
    this.part<HTMLButtonElement>("send").disabled = running;
    this.part<HTMLButtonElement>("stop").hidden = !running;
    const listed = this.listed(kind)?.list;
    const problem = listed ? choiceProblem(listed, this.chosenModel(kind), this.chosenEffort(kind)) : null;
    if (kind === "local") {
      state.textContent = problem ?? `${this.settings.endpoint || "（URL がありません）"}${this.settings.localModel ? ` の ${this.settings.localModel}` : ""} に聞きます。`;
      state.dataset.tone = problem ? "warn" : "";
      return;
    }
    if (!this.tools) {
      state.textContent = "相手を探しています…";
      return;
    }
    const found = this.tools[kind];
    const model = listed ? modelFor(listed, this.chosenModel(kind))?.label : this.chosenModel(kind);
    const effort = this.chosenEffort(kind);
    const which = [model, effort && `effort ${effort}`].filter(Boolean).join("・");
    state.textContent = !found
      ? `${AI_LABELS[kind]} が見つかりません。入れてログインしてから、「接続…」で場所を指定してください。`
      : (problem ?? `${AI_LABELS[kind]}（${found.version}）${which ? `の ${which} ` : ""}に聞きます。${this.tools.node ? "" : "Node.js がないので、ネームの写しはスキルのコマンドで読めません（要約と絵は見られます）。"}`);
    state.dataset.tone = found && !problem ? "" : "warn";
  }

  /** The model and its effort, chosen from what the tool itself lists. */
  private modelRows(kind: AiKind): HTMLElement[] {
    const known = this.listed(kind);
    const chosen = this.chosenModel(kind);
    const effortNow = this.chosenEffort(kind);
    const modelKey = kind === "claude" ? "claudeModel" : kind === "codex" ? "codexModel" : "localModel";
    const effortKey = kind === "claude" ? "claudeEffort" : "codexEffort";
    const model = element("select", { "aria-label": "モデル", "data-part": "model" });
    const effort = element("select", { "aria-label": "effort", "data-part": "effort" });
    const again = plainButton("↻", () => void this.loadModels(kind, true));
    again.title = `${AI_LABELS[kind]} にモデルの一覧を聞き直す（新しいモデルが出たとき・ログインし直したとき）`;
    again.setAttribute("aria-label", "モデルの一覧を取り直す");
    const rows: HTMLElement[] = [];
    const list = known?.list;
    if (!known) {
      model.append(element("option", { value: chosen }, chosen || "既定"));
      model.disabled = true;
      void this.loadModels(kind);
    } else if (!list && !known.error) {
      model.append(element("option", { value: chosen }, "一覧を取得しています…"));
      model.disabled = true;
    } else {
      const models = list ?? [];
      // Codex has no "default" entry of its own: offer one (its isDefault model).
      const fallback = models.find((found) => found.isDefault);
      if (kind !== "local" && !models.some((found) => found.value === "")) model.append(element("option", { value: "" }, `既定（${fallback?.label ?? `${AI_LABELS[kind]} が決める`}）`));
      if (kind === "local" && !models.length) model.append(element("option", { value: "" }, "（モデルがありません）"));
      for (const found of models) model.append(element("option", { value: found.value, title: found.description }, found.label));
      if (!modelFor(models, chosen) && (chosen || kind === "local")) model.append(element("option", { value: chosen }, `${chosen || "（なし）"}（一覧にありません）`));
      model.value = chosen;
    }
    model.addEventListener("change", () => {
      const change: Partial<AssistSettings> = { [modelKey]: model.value };
      // An effort the new model does not take goes back to its default.
      // (Read it now: it may have changed since these rows were built.)
      const effortThen = this.chosenEffort(kind);
      const picked = list && modelFor(list, model.value);
      if (kind !== "local" && effortThen && picked && !picked.efforts.includes(effortThen)) Object.assign(change, { [effortKey]: "" });
      this.save(change);
      this.renderSettings();
      this.renderState();
    });
    // The model, its effort and ↻ on one line.
    const line = element("div", { class: "assist-field assist-model" }, element("span", {}, "モデル"), model);
    rows.push(line);
    if (kind !== "local") {
      const efforts = list ? (modelFor(list, chosen)?.efforts ?? []) : effortNow ? [effortNow] : [];
      const preset = list && modelFor(list, chosen)?.defaultEffort;
      effort.append(element("option", { value: "" }, preset ? `既定（${preset}）` : "既定"));
      for (const level of efforts) effort.append(element("option", { value: level }, level));
      if (effortNow && !efforts.includes(effortNow)) effort.append(element("option", { value: effortNow }, `${effortNow}（このモデルでは選べません）`));
      effort.value = effortNow;
      effort.disabled = !list || (!efforts.length && !effortNow);
      effort.title = "考える深さ。深いほど答えはよくなるが、時間と使用量が増える";
      effort.addEventListener("change", () => {
        this.save({ [effortKey]: effort.value } as Partial<AssistSettings>);
        this.renderState();
      });
      line.append(effort);
    }
    line.append(again);
    if (known?.error) rows.push(element("p", { class: "hint assist-warn" }, `一覧を取れません: ${known.error}`));
    const problem = list ? choiceProblem(list, chosen, kind === "local" ? "" : effortNow) : null;
    if (problem) rows.push(element("p", { class: "hint assist-warn" }, problem));
    return rows;
  }

  private renderSettings(): void {
    const form = this.part("settings");
    const kind = this.settings.kind;
    const field = (label: string, key: keyof AssistSettings, placeholder: string, extra?: HTMLElement) => {
      const box = element("input", { type: "text", placeholder, "aria-label": label });
      box.value = String(this.settings[key]);
      box.addEventListener("change", () => {
        this.save({ [key]: box.value.trim() } as Partial<AssistSettings>);
        if (key === "claudePath" || key === "codexPath") void this.detect();
        if (key === "claudePath" || key === "codexPath" || key === "endpoint") void this.loadModels(this.settings.kind);
        this.renderState();
      });
      box.addEventListener("keydown", (event) => event.stopPropagation());
      return element("label", { class: "assist-field" }, element("span", {}, label), box, ...(extra ? [extra] : []));
    };
    const rows: HTMLElement[] = [];
    // What is set once (where the program is, the key, the Skill) folds away under 詳しく.
    const more: HTMLElement[] = [];
    if (kind === "claude" || kind === "codex") {
      const pathKey = kind === "claude" ? "claudePath" : "codexPath";
      const browse = plainButton("参照…", async () => {
        const chosen = await open({ multiple: false, directory: false, title: `${AI_LABELS[kind]} の場所` });
        if (typeof chosen !== "string") return;
        this.save({ [pathKey]: chosen } as Partial<AssistSettings>);
        this.renderSettings();
        void this.detect();
        void this.loadModels(kind);
      });
      rows.push(...this.modelRows(kind));
      more.push(field("場所", pathKey, "空なら自動で探す（指定は「参照…」で選ぶ）", browse));
      if (kind === "codex" && WINDOWS) {
        const sandbox = element("select", { "aria-label": "サンドボックス（Windows）", "data-part": "sandbox" });
        for (const [value, label] of [
          ["", "mxc（おすすめ）"],
          ["config", "Codex の設定（config.toml）のまま"],
          ["elevated", "elevated"],
          ["unelevated", "unelevated"],
        ])
          sandbox.append(element("option", { value }, label));
        sandbox.value = this.settings.codexSandbox;
        sandbox.title = "Codex がコマンドを動かす囲い。elevated は Codex アプリを開いていると準備に失敗し、ファイルを読めないことがあります";
        sandbox.addEventListener("change", () => this.save({ codexSandbox: sandbox.value }));
        more.push(element("label", { class: "assist-field" }, element("span", {}, "サンドボックス"), sandbox));
      }
      more.push(
        element(
          "p",
          { class: "hint" },
          kind === "claude"
            ? "Claude Code にログインしてあれば、その契約で使えます。相手はネームの写しと絵を読むだけで、ファイルを書き換えません。"
            : "Codex にログインしてあれば、その契約で使えます。読むだけの設定（read-only）で動かします。",
        ),
      );
    } else {
      rows.push(field("URL", "endpoint", DEFAULT_ASSIST.endpoint));
      const key = element("input", { type: "password", placeholder: this.hasKey ? "保存してあります（変えるときだけ入れる）" : "要るときだけ（Ollama・LM Studio は不要）", "aria-label": "API キー", autocomplete: "off" });
      key.addEventListener("keydown", (event) => event.stopPropagation());
      const keep = plainButton("保存", async () => {
        try {
          await call("ai_save_key", { key: key.value || null });
          key.value = "";
          this.hasKey = await call("ai_has_key");
          this.host.status(this.hasKey ? "API キーを Windows の資格情報マネージャーに保存しました" : "API キーを消しました");
          this.renderSettings();
        } catch (error) {
          fail("API キーを保存できません", error);
        }
      });
      keep.title = "入れたキーを保存する（空のまま押すと消す）。キーはファイルに書かず、システムの資格情報の保管庫に入れます";
      rows.push(...this.modelRows(kind));
      more.push(element("label", { class: "assist-field" }, element("span", {}, "API キー"), key, keep));
      more.push(element("p", { class: "hint" }, "Ollama・LM Studio・llama.cpp など、OpenAI と同じ形の API なら使えます。絵を見られるモデル（llava・gemma3 など）なら、ページの絵も見せられます。"));
    }
    const install = (target: "claude" | "codex" | "folder") =>
      plainButton({ claude: "Claude Code に入れる", codex: "Codex に入れる", folder: "フォルダーに書き出す…" }[target], async () => {
        let folder: string | null = null;
        if (target === "folder") {
          const chosen = await open({ directory: true, title: "スキルを書き出すフォルダー" });
          if (typeof chosen !== "string") return;
          folder = chosen;
        }
        try {
          const where = await call("ai_install_skill", { target, folder });
          this.host.status(`スキル name-studio を入れました: ${where}`);
        } catch (error) {
          fail("スキルを入れられません", error);
        }
      });
    more.push(
      element(
        "div",
        { class: "assist-skill" },
        element("span", {}, "スキル（アプリなしで AI に .namestudio を読み書きさせる）"),
        element("div", { class: "assist-row" }, install("claude"), install("codex"), install("folder")),
      ),
    );
    const details = element("details", { class: "assist-more" }, element("summary", {}, kind === "local" ? "詳しく（API キー・スキル）" : "詳しく（場所・スキル）"), ...more);
    details.open = this.moreOpen;
    details.addEventListener("toggle", () => {
      this.moreOpen = details.open;
    });
    form.replaceChildren(...rows, details);
  }

  /** The conversation, with each 変更の案 as a card. */
  private renderLog(): void {
    if (!this.built) return;
    const log = this.part("log");
    const entries = this.talk?.conversation.entries ?? [];
    if (!entries.length) {
      log.replaceChildren(element("p", { class: "hint" }, "ネームで行き詰まったら、ここで AI に相談できます。今のネーム（要約とページの絵）を見せて話します。下のボタンから始めても。"));
      return;
    }
    const running = this.talk?.conversation.running != null;
    log.replaceChildren(
      ...entries.map((entry, index) => {
        if (entry.role !== "assistant") return element("div", { class: `assist-entry ${entry.role}` }, entry.text);
        const settled = !running || index < entries.length - 1;
        return element(
          "div",
          { class: "assist-entry assistant" },
          ...replyParts(entry.text).map((part, k) => (part.kind === "text" ? this.markdown(part.text) : this.opsCard(part.json, `${index}:${k}`, settled))),
        );
      }),
    );
    log.scrollTop = log.scrollHeight;
  }

  /** What the AI says, as the Markdown it writes it in. */
  private markdown(text: string): HTMLElement {
    const view = markdownView(text, (href) => void navigator.clipboard?.writeText(href).then(() => this.host.status(`リンクをコピーしました: ${href}`)));
    view.classList.add("assist-text");
    return view;
  }

  private opsCard(json: string, key: string, settled: boolean): HTMLElement {
    const card = element("div", { class: "assist-ops" });
    const { ops, problems: unread } = parseOps(json);
    const project = this.host.project();
    if (unread.length || !project) {
      card.append(element("strong", {}, "変更の案（読めません）"), ...unread.map((problem) => element("p", { class: "problem" }, problem)));
      return card;
    }
    const preview = settled ? previewOps(project, ops) : null;
    const done = this.applied.has(key);
    card.append(element("strong", {}, `変更の案（${ops.length} 件）${done ? " — 当てました" : ""}`));
    if (preview) {
      card.append(element("ul", {}, ...preview.done.map((line) => element("li", {}, line))));
      for (const problem of preview.problems) card.append(element("p", { class: "problem" }, problem));
    }
    const apply = plainButton(done ? "もう一度当てる" : "当てる", () => this.apply(ops, key));
    apply.classList.add("primary");
    apply.disabled = !preview || preview.broken || !preview.done.length;
    apply.title = "このネームに当てる（1 回の操作として。Ctrl+Z で戻せます）";
    const copy = plainButton("JSON をコピー", () => void navigator.clipboard?.writeText(json).then(() => this.host.status("変更の案の JSON をコピーしました")));
    card.append(element("div", { class: "assist-row" }, apply, copy));
    return card;
  }

  private apply(ops: AssistOp[], key: string): void {
    let result: ReturnType<typeof applyOps> | null = null;
    const project = this.host.project();
    if (!project) return;
    // Checked on a copy first: a change that would leave the name unopenable is not made at all.
    if (previewOps(project, ops).broken) {
      this.host.status("この案を当てるとネームが開けなくなるので、当てませんでした");
      return;
    }
    this.host.edit((name) => {
      result = applyOps(name, ops);
    });
    const done = (result as ReturnType<typeof applyOps> | null)?.done.length ?? 0;
    this.applied.add(key);
    if (this.talk) void this.keep(this.talk);
    this.host.status(`変更の案を当てました（${done} 件）。Ctrl+Z で元に戻せます`);
    this.renderLog();
  }

  /** Keep the conversation (with what was applied) to go on with later. */
  private async keep(talk: Talk): Promise<void> {
    const entries = talk.conversation.entries;
    if (!entries.some((entry) => entry.role === "user")) return;
    const saved: SavedTalk = {
      id: talk.id,
      kind: talk.conversation.kind,
      name: talk.name,
      title: talkTitle(entries),
      created: talk.created,
      updated: Date.now(),
      session: talk.conversation.session,
      dir: talk.dir,
      entries,
      applied: talk === this.talk ? [...this.applied] : [],
    };
    try {
      await call("ai_history_save", { talk: saved });
    } catch (error) {
      fail("相談を残せません", error);
    }
    if (!this.part("history").hidden) void this.renderHistory();
  }

  /** The kept conversations: this name's (or all), to open one and go on. */
  private async renderHistory(): Promise<void> {
    const box = this.part("history");
    let talks: TalkSummary[];
    try {
      talks = await call("ai_history_list");
    } catch (error) {
      box.replaceChildren(element("p", { class: "hint assist-warn" }, failureText("前の相談を読めません", error)));
      return;
    }
    const name = this.host.path() ?? "";
    const others = talks.filter((talk) => talk.name !== name).length;
    const shown = orderTalks(this.allTalks ? talks : talks.filter((talk) => talk.name === name), name);
    const all = element("input", { type: "checkbox" });
    all.checked = this.allTalks;
    all.addEventListener("change", () => {
      this.allTalks = all.checked;
      void this.renderHistory();
    });
    const rows = shown.map((talk) => {
      const when = new Date(talk.updated).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const where = talk.name === name ? "" : `・${talk.name ? (talk.name.split(/[\\/]/).pop() ?? talk.name) : "保存前のネーム"}`;
      const now = this.talk?.id === talk.id;
      const open = element("button", { type: "button", class: "assist-talk", title: `この相談を開いて続きを話す（${AI_LABELS[talk.kind]}）` }, element("span", { class: "assist-talk-title" }, talk.title), element("span", { class: "assist-talk-meta" }, `${AI_LABELS[talk.kind]}・${talk.count} 問・${when}${where}${now ? "・いまの相談" : ""}`));
      open.addEventListener("click", () => void this.reopen(talk.id));
      const remove = plainButton("消す", () => {
        if (remove.dataset.sure !== "1") {
          remove.dataset.sure = "1";
          remove.textContent = "消す？";
          return;
        }
        void call("ai_history_delete", { id: talk.id })
          .then(() => this.renderHistory())
          .catch((error) => fail("相談を消せません", error));
      });
      remove.title = "この相談を一覧から消す（もう一度押して確かめる）";
      return element("li", { class: now ? "now" : "" }, open, remove);
    });
    box.replaceChildren(
      element("div", { class: "assist-row" }, element("strong", {}, "前の相談"), element("label", { class: "check", title: "ほかのネームで話した相談も出す" }, all, ` ほかのネームも（${others}）`)),
      rows.length ? element("ul", { class: "assist-talks" }, ...rows) : element("p", { class: "hint" }, this.allTalks ? "残っている相談はありません。" : "このネームの相談はまだありません。"),
    );
  }

  /** Open a kept conversation and go on with it (with this name as it is now). */
  private async reopen(id: string): Promise<void> {
    if (this.talk?.conversation.running != null || this.preparing) {
      this.host.status("答えが終わってから開いてください");
      return;
    }
    let talk: SavedTalk | null;
    try {
      talk = readSavedTalk(await call("ai_history_load", { id }));
    } catch (error) {
      fail("相談を開けません", error);
      return;
    }
    if (!talk) {
      this.host.status("相談を読めません（壊れているかもしれません）");
      return;
    }
    this.save({ kind: talk.kind });
    this.part<HTMLSelectElement>("kind").value = talk.kind;
    // Seen as never: the next question brings the name as it is now (and its folder up to date).
    this.talk = { id: talk.id, created: talk.created, conversation: Conversation.restore(talk), dir: talk.dir, name: this.host.path() ?? "", seen: "" };
    this.applied.clear();
    for (const key of talk.applied) this.applied.add(key);
    this.part("history").hidden = true;
    this.renderSettings();
    this.renderLog();
    this.renderState();
    this.host.status(`前の相談を開きました。続けて書くと${AI_LABELS[talk.kind]}はその話の続きとして答えます`);
  }

  private reset(): void {
    void this.stop();
    this.talk = null;
    this.applied.clear();
    this.renderLog();
    this.renderState();
  }

  private async stop(): Promise<void> {
    const run = this.talk?.conversation.running;
    if (run == null) return;
    await call("ai_stop", { run }).catch(() => {});
  }

  private hear(event: AiEvent): void {
    const conversation = this.talk?.conversation;
    if (!conversation || conversation.running === null) {
      this.early.push(event);
      if (this.early.length > 200) this.early.shift();
      return;
    }
    if (!conversation.hear(event)) return;
    if ((event.kind === "done" || event.kind === "error" || event.kind === "session") && this.talk) void this.keep(this.talk);
    if (event.kind === "error") this.host.status(`${AI_LABELS[conversation.kind]}: ${event.text.split("\n")[0]}`);
    this.renderLog();
    this.renderState();
  }

  /** The files of the conversation's folder for the name as it is now. */
  private async files(project: Project, brief: string, pictures: number[]): Promise<SessionFile[]> {
    const files: SessionFile[] = [
      { path: BRIEF_FILE, text: brief },
      { path: COPY_FILE, text: JSON.stringify(project) },
    ];
    const instructions = agentInstructions(pictures.length > 0);
    files.push({ path: "SYSTEM.md", text: instructions }, { path: "CLAUDE.md", text: instructions }, { path: "AGENTS.md", text: instructions });
    if (pictures.length) {
      this.host.status("ページの絵を用意しています…");
      for (const picture of await pagePictures(project, pictures, (rough) => this.host.rough(rough))) files.push({ path: pictureFile(picture.number), base64: picture.base64 });
    }
    return files;
  }

  private async send(text: string): Promise<void> {
    const question = text.trim();
    const project = this.host.project();
    if (!question || !project || this.preparing || this.talk?.conversation.running != null) return;
    const kind = this.settings.kind;
    // A model or an effort the tool does not list is not sent (the question stays in the box).
    const listed = this.listed(kind)?.list;
    const problem = listed ? choiceProblem(listed, this.chosenModel(kind), this.chosenEffort(kind)) : null;
    if (problem) {
      this.host.status(problem);
      this.renderState();
      return;
    }
    // By its file: a new title is the same name. One not saved yet goes on until another is saved or 新しい相談.
    const name = this.host.path() ?? "";
    if (!this.talk || this.talk.conversation.kind !== kind || this.talk.name !== name) {
      this.talk = { id: newTalkId(Date.now()), created: Date.now(), conversation: new Conversation(kind), dir: null, name, seen: "" };
      this.applied.clear();
    }
    const talk = this.talk;
    const current = this.host.currentPages().sort((a, b) => a - b);
    const now = fingerprint(JSON.stringify(project));
    const first = talk.seen === "";
    const changed = !first && talk.seen !== now;
    this.preparing = true;
    this.renderState();
    try {
      const pictures = this.settings.pictures ? (kind === "local" ? current : project.pages.map((_, i) => i + 1)) : [];
      const brief = first || changed ? nameBrief(project, { current }) : "";
      if (first || changed) {
        const files = await this.files(project, brief, pictures);
        // A kept conversation's folder that is not one of ours (another computer's): a new one.
        talk.dir = await call("ai_prepare_session", { dir: talk.dir, files }).catch((error) => {
          if (!talk.dir) throw error;
          return call("ai_prepare_session", { dir: null, files });
        });
        talk.seen = now;
      }
      const turnPictures = this.settings.pictures && (first || changed) ? current.filter((n) => n <= project.pages.length).map(pictureFile) : [];
      const messages: ChatMessage[] =
        kind === "local"
          ? [
              { role: "system", content: localInstructions(project, current) },
              ...talk.conversation.history(),
              { role: "user", content: question, images: turnPictures },
            ]
          : [];
      const prompt = first ? firstPrompt(question, current, brief) : changed ? changedPrompt(question, current, brief) : question;
      const run = await call("ai_turn", {
        turn: {
          kind,
          dir: talk.dir!,
          prompt,
          resume: talk.conversation.session,
          model: this.chosenModel(kind) || null,
          effort: this.chosenEffort(kind) || null,
          sandbox: kind === "codex" ? this.settings.codexSandbox || null : null,
          program: (kind === "claude" ? this.settings.claudePath : kind === "codex" ? this.settings.codexPath : "") || null,
          images: kind === "codex" ? turnPictures : [],
          endpoint: kind === "local" ? this.settings.endpoint : null,
          messages,
        },
      });
      talk.conversation.ask(question, run);
      void this.keep(talk);
      this.part<HTMLTextAreaElement>("input").value = "";
      this.host.status(`${AI_LABELS[kind]} に聞いています…`);
      for (const event of this.early.splice(0)) talk.conversation.hear(event);
    } catch (error) {
      talk.conversation.entries.push({ role: "user", text: question }, { role: "error", text: String(error) });
      void this.keep(talk);
      fail("相談を始められません", error);
    } finally {
      this.preparing = false;
    }
    this.renderLog();
    this.renderState();
  }
}

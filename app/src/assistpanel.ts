// The 相談 palette (AI に相談): talk the open name over with Claude Code,
// Codex or a local LLM. The AI is shown the name in words and as pictures
// (assistchat.ts says what it is told); what it proposes comes back as
// 変更の案, shown with what each would do, and applied with 当てる as one
// undoable change. The palette's ⚙ holds where the programs are, the models,
// the local LLM's address and key, and puts the Skill where the AI tools find it.
import { open } from "@tauri-apps/plugin-dialog";
import { applyOps, nameBrief, parseOps, previewOps, type AssistOp } from "./assist";
import {
  agentInstructions,
  AI_LABELS,
  BRIEF_FILE,
  changedPrompt,
  Conversation,
  COPY_FILE,
  DEFAULT_ASSIST,
  firstPrompt,
  localInstructions,
  pictureFile,
  readAssistSettings,
  replyParts,
  STARTERS,
  type AssistSettings,
} from "./assistchat";
import { call, onAiEvent, type AiEvent, type AiKind, type AiTools, type ChatMessage, type SessionFile } from "./backend";
import { plainButton } from "./dom";
import { pagePictures } from "./flatpage";
import type { Project, RoughImage } from "./model";
import { readJson, writeText } from "./settings";

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

interface Talk {
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
        element("div", { class: "assist-head" }, kind, gear, fresh),
        element("p", { class: "hint assist-state", "data-part": "state" }),
        element("div", { class: "assist-settings", "data-part": "settings", hidden: "" }),
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

  /** The line under the header: who will answer, and whether they are there. */
  private renderState(): void {
    if (!this.built) return;
    const state = this.part("state");
    const kind = this.settings.kind;
    const running = this.talk?.conversation.running != null || this.preparing;
    this.part<HTMLButtonElement>("send").disabled = running;
    this.part<HTMLButtonElement>("stop").hidden = !running;
    if (kind === "local") {
      state.textContent = `${this.settings.endpoint || "（URL がありません）"}${this.settings.localModel ? ` の ${this.settings.localModel}` : ""} に聞きます。`;
      return;
    }
    if (!this.tools) {
      state.textContent = "相手を探しています…";
      return;
    }
    const found = this.tools[kind];
    state.textContent = found
      ? `${AI_LABELS[kind]}（${found.version}）に聞きます。${this.tools.node ? "" : "Node.js がないので、ネームの写しはスキルのコマンドで読めません（要約と絵は見られます）。"}`
      : `${AI_LABELS[kind]} が見つかりません。入れてログインしてから、「接続…」で場所を指定してください。`;
    state.dataset.tone = found ? "" : "warn";
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
        this.renderState();
      });
      box.addEventListener("keydown", (event) => event.stopPropagation());
      return element("label", { class: "assist-field" }, element("span", {}, label), box, ...(extra ? [extra] : []));
    };
    const rows: HTMLElement[] = [];
    if (kind === "claude" || kind === "codex") {
      const pathKey = kind === "claude" ? "claudePath" : "codexPath";
      const browse = plainButton("参照…", async () => {
        const chosen = await open({ multiple: false, directory: false, title: `${AI_LABELS[kind]} の場所` });
        if (typeof chosen !== "string") return;
        this.save({ [pathKey]: chosen } as Partial<AssistSettings>);
        this.renderSettings();
        void this.detect();
      });
      rows.push(field("場所", pathKey, "空なら自動で探す", browse));
      rows.push(field("モデル", kind === "claude" ? "claudeModel" : "codexModel", kind === "claude" ? "空なら既定（例: sonnet・opus）" : "空なら既定"));
      rows.push(
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
      const models = element("datalist", { id: "assist-models" });
      const model = field("モデル", "localModel", "例: llama3.2 ・ qwen2.5");
      model.querySelector("input")!.setAttribute("list", "assist-models");
      const check = plainButton("つながるか確かめる", async () => {
        try {
          const found = await call("ai_local_models", { endpoint: this.settings.endpoint });
          models.replaceChildren(...found.map((id) => element("option", { value: id })));
          this.host.status(found.length ? `つながりました。モデル: ${found.slice(0, 8).join("・")}${found.length > 8 ? " ほか" : ""}` : "つながりましたが、モデルがありません");
        } catch (error) {
          this.host.status(`つながりません: ${error}`);
        }
      });
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
          this.host.status(`API キーを保存できません: ${error}`);
        }
      });
      keep.title = "入れたキーを保存する（空のまま押すと消す）。キーはファイルに書かず、システムの資格情報の保管庫に入れます";
      rows.push(model, models, element("div", { class: "assist-row" }, check));
      rows.push(element("label", { class: "assist-field" }, element("span", {}, "API キー"), key, keep));
      rows.push(element("p", { class: "hint" }, "Ollama・LM Studio・llama.cpp など、OpenAI と同じ形の API なら使えます。絵を見られるモデル（llava・gemma3 など）なら、ページの絵も見せられます。"));
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
          this.host.status(`スキルを入れられません: ${error}`);
        }
      });
    rows.push(
      element(
        "div",
        { class: "assist-skill" },
        element("span", {}, "スキル（アプリなしで AI に .namestudio を読み書きさせる）"),
        element("div", { class: "assist-row" }, install("claude"), install("codex"), install("folder")),
      ),
    );
    form.replaceChildren(...rows);
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
          ...replyParts(entry.text).map((part, k) => (part.kind === "text" ? element("div", { class: "assist-text" }, part.text) : this.opsCard(part.json, `${index}:${k}`, settled))),
        );
      }),
    );
    log.scrollTop = log.scrollHeight;
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
    this.host.status(`変更の案を当てました（${done} 件）。Ctrl+Z で元に戻せます`);
    this.renderLog();
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
    if (event.kind === "error") this.host.status(`${AI_LABELS[conversation.kind]}: ${event.text.split("\n")[0]}`);
    this.renderLog();
    this.renderState();
  }

  /** The files of the conversation's folder for the name as it is now. */
  private async files(project: Project, pictures: number[]): Promise<SessionFile[]> {
    const files: SessionFile[] = [
      { path: BRIEF_FILE, text: nameBrief(project, { current: this.host.currentPages() }) },
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
    // By its file: a new title is the same name. One not saved yet goes on until another is saved or 新しい相談.
    const name = this.host.path() ?? "";
    if (!this.talk || this.talk.conversation.kind !== kind || this.talk.name !== name) {
      this.talk = { conversation: new Conversation(kind), dir: null, name, seen: "" };
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
      if (first || changed) {
        talk.dir = await call("ai_prepare_session", { dir: talk.dir, files: await this.files(project, pictures) });
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
      const prompt = first ? firstPrompt(question, current) : changed ? changedPrompt(question, current) : question;
      const run = await call("ai_turn", {
        turn: {
          kind,
          dir: talk.dir!,
          prompt,
          resume: talk.conversation.session,
          model: (kind === "claude" ? this.settings.claudeModel : kind === "codex" ? this.settings.codexModel : this.settings.localModel) || null,
          program: (kind === "claude" ? this.settings.claudePath : kind === "codex" ? this.settings.codexPath : "") || null,
          images: kind === "codex" ? turnPictures : [],
          endpoint: kind === "local" ? this.settings.endpoint : null,
          messages,
        },
      });
      talk.conversation.ask(question, run);
      this.part<HTMLTextAreaElement>("input").value = "";
      this.host.status(`${AI_LABELS[kind]} に聞いています…`);
      for (const event of this.early.splice(0)) talk.conversation.hear(event);
    } catch (error) {
      talk.conversation.entries.push({ role: "user", text: question }, { role: "error", text: String(error) });
      this.host.status(`相談を始められません: ${error}`);
    } finally {
      this.preparing = false;
    }
    this.renderLog();
    this.renderState();
  }
}

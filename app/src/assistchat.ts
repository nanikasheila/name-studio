// AI に相談: the conversation itself, apart from the screen. Who is talked
// to and how (the settings), what they are told (the instructions and what
// goes with the first question), and what they say, put together from the
// events of each turn into the entries the palette shows.
import { nameBrief, OPS_FENCE, opsGuide } from "./assist";
import type { Project } from "./model";

/** Who is talked to. */
export type AiKind = "claude" | "codex" | "local";

/** What a turn says, as it says it (ai.rs `AiEvent`). */
export interface AiEvent {
  run: number;
  kind: "session" | "delta" | "text" | "tool" | "done" | "error";
  text: string;
}

export const AI_LABELS: Record<AiKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  local: "ローカル LLM",
};

/** Who to talk to and how, kept on this computer. The key for an API is not here (the credential store keeps it). */
export interface AssistSettings {
  kind: AiKind;
  /** Where claude / codex are, when not found by themselves. */
  claudePath: string;
  codexPath: string;
  /** Models to ask for (empty: their own default). */
  claudeModel: string;
  codexModel: string;
  /** How hard they think (empty: the model's own default), one the model offers. */
  claudeEffort: string;
  codexEffort: string;
  /** Codex's sandbox on Windows: "" for mxc, "config" for its own config.toml, or a mode by name. */
  codexSandbox: string;
  /** A local LLM's OpenAI-compatible API (Ollama, LM Studio, llama.cpp…). */
  endpoint: string;
  localModel: string;
  /** Show the AI the pages as pictures (the rough and the panels), not only in words. */
  pictures: boolean;
}

export const DEFAULT_ASSIST: AssistSettings = {
  kind: "claude",
  claudePath: "",
  codexPath: "",
  claudeModel: "",
  codexModel: "",
  claudeEffort: "",
  codexEffort: "",
  codexSandbox: "",
  endpoint: "http://localhost:11434/v1",
  localModel: "",
  pictures: true,
};

/** Settings as kept, with anything missing or wrong put back to the default. */
export function readAssistSettings(kept: unknown): AssistSettings {
  const out = { ...DEFAULT_ASSIST };
  if (typeof kept !== "object" || kept === null) return out;
  const from = kept as Record<string, unknown>;
  if (from.kind === "claude" || from.kind === "codex" || from.kind === "local") out.kind = from.kind;
  for (const key of ["claudePath", "codexPath", "claudeModel", "codexModel", "claudeEffort", "codexEffort", "codexSandbox", "endpoint", "localModel"] as const) {
    if (typeof from[key] === "string") out[key] = from[key];
  }
  if (typeof from.pictures === "boolean") out.pictures = from.pictures;
  return out;
}

/** A model as Claude Code, Codex or the local LLM lists it (ai.rs `AiModel`). */
export interface AiModel {
  /** What is asked for ("": the tool's own default). */
  value: string;
  label: string;
  description: string;
  /** The efforts it takes (none: no choice). */
  efforts: string[];
  defaultEffort: string | null;
  isDefault: boolean;
}

/** The model a choice means: the one named, or for "" the tool's default. */
export function modelFor(models: AiModel[], value: string): AiModel | undefined {
  return models.find((model) => model.value === value) ?? (value === "" ? models.find((model) => model.isDefault) : undefined);
}

/** What is wrong with a model and an effort, against the list the tool gave (null: nothing). */
export function choiceProblem(models: AiModel[], value: string, effort: string): string | null {
  const model = modelFor(models, value);
  if (!model) return value ? `モデル「${value}」は一覧にありません。「接続…」で選び直してください。` : null;
  if (effort && !model.efforts.includes(effort)) return `${model.label} は effort「${effort}」を選べません（${model.efforts.join("・") || "選べるものなし"}）。`;
  return null;
}

/** The file names in a conversation's folder. */
export const BRIEF_FILE = "ネーム.md";
export const COPY_FILE = "ネーム.namestudio";
export const pictureFile = (number: number) => `pages/p${String(number).padStart(3, "0")}.png`;
const CLI = "node .claude/skills/name-studio/scripts/namestudio.mjs";

const ROLE = `あなたは漫画のネーム（絵コンテ）の相談相手です。作者は Name Studio というアプリでネームを作っていて、行き詰まったところを相談しています。日本語で、作者の言葉づかいに合わせて答えてください。

相談の進め方:
- 作者が何に行き詰まっているかをつかみ、言葉にしてから答える。わからなければ短く聞き返す。
- 直すより先に、選べる案を 2〜3 出す（狙い・読者の感じ方・ページ数への影響を添えて）。
- 作者のセリフや演出を勝手に書き換えない。作品の主は作者。
- コマ割りは読む順・ページめくり（めくった最初のコマ・見開き）・間（コマの大きさと数）を見る。
- 構成は目標ページ数・話の型・シーンの配分・感情の推移を見る。`;

/** How to hand back changes, for every kind of AI. */
function proposing(): string {
  return `変更の案:
作者が頼んだとき、または案を具体的に見せたいときは、返事の中に次の形で書いてください。作者が確かめてから「当てる」を押すとアプリで当たります（元に戻せます）。案は小さくまとまりごとに分け、何を変えるかを先に文で説明してください。

\`\`\`${OPS_FENCE}
[{"op":"setLine","line":"line12","text":"…"}]
\`\`\`

${opsGuide()}`;
}

/** What Claude Code and Codex are told (their folder holds the name's copy and pictures). */
export function agentInstructions(pictures: boolean): string {
  return `${ROLE}

作業フォルダーにあるもの:
- ${BRIEF_FILE}: ネームの要約（構成・人物・シーン・ページごとのコマとセリフ。[line12] はセリフの id）。まずこれを読む。
- ${COPY_FILE}: ネームの写し。\`${CLI} brief ${COPY_FILE} --pages 3-5\` などで読める（name-studio スキル）。
${pictures ? `- ${pictureFile(1).replace("001", "NNN")}: ページの絵（ラフ・コマ・フキダシ）。コマ割りや絵の相談では見る。\n` : ""}写しやフォルダーのファイルを書き換えても、作者のネームには届きません。ファイルは書き換えないでください。
作者はアプリの画面で話しています。コマンドやファイルの使い方は作者に案内しないでください（案を自分で \`apply --dry-run\` で確かめるのはかまいません）。

${proposing()}`;
}

/** What a local LLM is told: everything in the message, as it cannot read files. */
export function localInstructions(project: Project, current: number[]): string {
  return `${ROLE}

${proposing()}

いまのネーム:
${nameBrief(project, { current })}`;
}

/** The name's brief, in the message itself: the AI has it even when it cannot read files (a sandbox that turns every command away). */
function withBrief(note: string, brief: string, question: string): string {
  return `（${note}）\n\n<ネームの要約>\n${brief.trim()}\n</ネームの要約>\n\n作者の相談:\n${question}`;
}

/** The first question as it is sent to Claude Code or Codex: the name in brief, and the pages the user is on. */
export function firstPrompt(question: string, current: number[], brief: string): string {
  const pages = current.length ? `作者はいま p${current.join("・p")} を開いています。` : "";
  return withBrief(`ネームの要約を付けます。同じものが ${BRIEF_FILE} に、写しとページの絵もフォルダーにあります。${pages}`, brief, question);
}

/** A later question, when the name was changed since the last one. */
export function changedPrompt(question: string, current: number[], brief: string): string {
  const pages = current.length ? `いまは p${current.join("・p")} を開いています。` : "";
  return withBrief(`ネームが変わったので、新しい要約を付けます（${BRIEF_FILE} とページの絵も新しくしました）。${pages}`, brief, question);
}

/** Ready-made questions for when the user does not know what to ask. */
export const STARTERS: { label: string; text: string }[] = [
  { label: "行き詰まった", text: "このあたりで行き詰まっています。何が引っかかっているのか、一緒に整理してください。" },
  { label: "このページのコマ割り", text: "いま開いているページのコマ割りを見て、読みやすさ・間・めくりの効果から、別の割り方の案を 2〜3 出してください。" },
  { label: "セリフを詰める", text: "いま開いているページのセリフを、意味を変えずに短く・口調に合わせて詰める案をください。" },
  { label: "構成を見て", text: "全体の構成（ページ配分・シーン・山場・感情の流れ）を見て、気になるところを挙げてください。" },
  { label: "この先の展開", text: "ここまでの流れから、この先の展開の案をいくつか出してください。それぞれの良さと難しさも。" },
];

export type EntryRole = "user" | "assistant" | "tool" | "error";

export interface ChatEntry {
  role: EntryRole;
  text: string;
}

/** A conversation as the palette shows it, put together from the turns' events. */
export class Conversation {
  entries: ChatEntry[] = [];
  /** The AI's id for the conversation, to go on with it. */
  session: string | null = null;
  /** The turn running now. */
  running: number | null = null;

  constructor(readonly kind: AiKind) {}

  ask(text: string, run: number): void {
    this.entries.push({ role: "user", text });
    this.running = run;
  }

  /** Take in an event; true when it was this conversation's. */
  hear(event: AiEvent): boolean {
    if (event.run !== this.running) return false;
    const last = this.entries[this.entries.length - 1];
    switch (event.kind) {
      case "session":
        this.session = event.text;
        break;
      case "delta":
        if (last?.role === "assistant") last.text += event.text;
        else this.entries.push({ role: "assistant", text: event.text });
        break;
      case "text":
        if (!event.text.trim()) break;
        if (last?.role === "assistant") last.text = `${last.text.trimEnd()}\n\n${event.text}`;
        else this.entries.push({ role: "assistant", text: event.text });
        break;
      case "tool":
        this.entries.push({ role: "tool", text: event.text });
        break;
      case "error":
        this.entries.push({ role: "error", text: event.text });
        this.running = null;
        break;
      case "done":
        this.running = null;
        break;
    }
    return true;
  }

  /** The conversation for an API that keeps no history: what was said, without the tools' lines. */
  history(): { role: "user" | "assistant"; content: string }[] {
    return this.entries.filter((entry) => entry.role === "user" || entry.role === "assistant").map((entry) => ({ role: entry.role as "user" | "assistant", content: entry.text }));
  }
}

/** A reply cut into its words and its 変更の案, in order. */
export function replyParts(text: string): ({ kind: "text"; text: string } | { kind: "ops"; json: string })[] {
  const parts: ({ kind: "text"; text: string } | { kind: "ops"; json: string })[] = [];
  const fence = new RegExp(`\`\`\`${OPS_FENCE}[^\\n]*\\n([\\s\\S]*?)(?:\`\`\`|$)`, "g");
  let from = 0;
  for (const match of text.matchAll(fence)) {
    const before = text.slice(from, match.index).trim();
    if (before) parts.push({ kind: "text", text: before });
    // One still being written (no closing fence yet) is shown once it is whole.
    if (match[0].trimEnd().endsWith("```")) parts.push({ kind: "ops", json: match[1].trim() });
    from = match.index + match[0].length;
  }
  const rest = text.slice(from).trim();
  if (rest) parts.push({ kind: "text", text: rest });
  return parts;
}


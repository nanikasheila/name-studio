// AI に相談: the conversation itself, apart from the screen. Who is talked
// to and how (the settings), what they are told (the instructions and what
// goes with the first question), and what they say, put together from the
// events of each turn into the entries the palette shows.
import { nameBrief, OPS_FENCE, opsGuide } from "../domain/assist";
import type { Project } from "../model/model";
import { HELP_FILE } from "./apphelp";
import type { AiEvent, AiKind, AiModel } from "../generated/ipc";

export type { AiEvent, AiKind, AiModel } from "../generated/ipc";

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
  for (const key of [
    "claudePath",
    "codexPath",
    "claudeModel",
    "codexModel",
    "claudeEffort",
    "codexEffort",
    "codexSandbox",
    "endpoint",
    "localModel",
  ] as const) {
    if (typeof from[key] === "string") out[key] = from[key];
  }
  if (typeof from.pictures === "boolean") out.pictures = from.pictures;
  return out;
}

/** The model a choice means: the one named, or for "" the tool's default. */
export function modelFor(models: AiModel[], value: string): AiModel | undefined {
  return models.find((model) => model.value === value) ?? (value === "" ? models.find((model) => model.isDefault) : undefined);
}

/** What is wrong with a model and an effort, against the list the tool gave (null: nothing). */
export function choiceProblem(models: AiModel[], value: string, effort: string): string | null {
  const model = modelFor(models, value);
  if (!model) return value ? `モデル「${value}」は一覧にありません。「接続…」で選び直してください。` : null;
  if (effort && !model.efforts.includes(effort))
    return `${model.label} は effort「${effort}」を選べません（${model.efforts.join("・") || "選べるものなし"}）。`;
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
- 構成は目標ページ数・話の型・シーンの配分・感情の推移を見る。

アプリの使い方の質問（「〜はどうやるの」「〜のキーは」）:
- 使い方（${HELP_FILE}）に書いてあることだけで答える。どの道具・欄・ボタンで、どのキーか（作者のキー設定のとおり）を、手順の順に短く。
- 書いていないことは作れるふりをせず「その機能は見当たりません」と言い、近いやり方があれば挙げる。
- 頼まれたことが変更の案（下）でできるなら、手順の説明に加えて案も出してよい。`;

/** How to hand back changes, for every kind of AI. */
function proposing(): string {
  return `変更の案:
作者が頼んだとき、または案を具体的に見せたいときは、返事の中に次の形で書いてください。作者は「画面で見る」で変更後のネームを画面で確かめ、「採用」か「却下」を選びます（却下すると元のまま）。案は小さくまとまりごとに分け（一つの案は一緒に採用・却下されます）、何を変えるかを先に文で説明してください。

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
- ${HELP_FILE}: アプリの使い方（道具・欄・命令と、この PC でのキー、ユーザーガイド）。使い方の質問ではこれを読む。
- ${COPY_FILE}: ネームの写し。\`${CLI} brief ${COPY_FILE} --pages 3-5\` などで読める（name-studio スキル）。
${pictures ? `- ${pictureFile(1).replace("001", "NNN")}: ページの絵（ラフ・コマ・フキダシ）。コマ割りや絵の相談では見る。\n` : ""}写しやフォルダーのファイルを書き換えても、作者のネームには届きません。ファイルは書き換えないでください。
作者はアプリの画面で話しています。コマンドやファイルの使い方は作者に案内しないでください（案を自分で \`apply --dry-run\` で確かめるのはかまいません）。

${proposing()}`;
}

/** What a local LLM is told: everything in the message, as it cannot read files. */
export function localInstructions(project: Project, current: number[], help: string): string {
  return `${ROLE}

${proposing()}
${help.trim() ? `\n<${HELP_FILE}>\n${help.trim()}\n</${HELP_FILE}>\n` : ""}
いまのネーム:
${nameBrief(project, { current })}`;
}

/** A question on using the app (a local LLM is sent the help only then: it is long for a small model). */
export function asksHow(question: string): boolean {
  return /使い方|どうや[っるれ]|どうすれば|には？|どうしたら|やり方|方法|キー|ショートカット|ボタン|どこ|操作|設定|機能|できますか|できる？|ヘルプ/.test(
    question,
  );
}

/** The name's brief, in the message itself: the AI has it even when it cannot read files (a sandbox that turns every command away). */
function withBrief(note: string, brief: string, question: string): string {
  return `（${note}）\n\n<ネームの要約>\n${brief.trim()}\n</ネームの要約>\n\n作者の相談:\n${question}`;
}

/** The first question as it is sent to Claude Code or Codex: the name in brief, and the pages the user is on. */
export function firstPrompt(question: string, current: number[], brief: string): string {
  const pages = current.length ? `作者はいま p${current.join("・p")} を開いています。` : "";
  return withBrief(
    `ネームの要約を付けます。同じものが ${BRIEF_FILE} に、写しとページの絵もフォルダーにあります。${pages}`,
    brief,
    question,
  );
}

/** A later question, when the name was changed since the last one. */
export function changedPrompt(question: string, current: number[], brief: string): string {
  const pages = current.length ? `いまは p${current.join("・p")} を開いています。` : "";
  return withBrief(`ネームが変わったので、新しい要約を付けます（${BRIEF_FILE} とページの絵も新しくしました）。${pages}`, brief, question);
}

/** Ready-made questions for when the user does not know what to ask. */
export const STARTERS: { label: string; text: string }[] = [
  { label: "使い方を聞く", text: "Name Studio の使い方の質問です。" },
  { label: "直してみて", text: "いま開いているページを良くする変更の案を出してください。画面で確かめてから採用します。" },
  { label: "行き詰まった", text: "このあたりで行き詰まっています。何が引っかかっているのか、一緒に整理してください。" },
  {
    label: "このページのコマ割り",
    text: "いま開いているページのコマ割りを見て、読みやすさ・間・めくりの効果から、別の割り方の案を 2〜3 出してください。",
  },
  { label: "セリフを詰める", text: "いま開いているページのセリフを、意味を変えずに短く・口調に合わせて詰める案をください。" },
  { label: "構成を見て", text: "全体の構成（ページ配分・シーン・山場・感情の流れ）を見て、気になるところを挙げてください。" },
  { label: "この先の展開", text: "ここまでの流れから、この先の展開の案をいくつか出してください。それぞれの良さと難しさも。" },
];

export type EntryRole = "user" | "assistant" | "tool" | "error";

export interface ChatEntry {
  role: EntryRole;
  text: string;
}

/** A conversation kept to go on with later (ai/history.rs keeps it as JSON in ai-history/). */
export interface SavedTalk {
  id: string;
  kind: AiKind;
  /** The name it is about (its file; empty when not saved). */
  name: string;
  /** Its first question, short. */
  title: string;
  created: number;
  updated: number;
  /** The AI's id for it (Claude Code's session, Codex's thread). */
  session: string | null;
  /** Its folder (Claude Code goes on with a session only in the folder it began in). */
  dir: string | null;
  entries: ChatEntry[];
  /** 変更の案 kept (採用), by where they are in it. */
  applied: string[];
  /** 変更の案 taken back (却下). */
  rejected: string[];
}

/** A kept conversation as the list shows it. */
export interface TalkSummary {
  id: string;
  kind: AiKind;
  name: string;
  title: string;
  created: number;
  updated: number;
  /** How many questions. */
  count: number;
}

/** What a conversation is called in the list: its first question, on one line. */
export function talkTitle(entries: ChatEntry[]): string {
  const first =
    entries
      .find((entry) => entry.role === "user")
      ?.text.replace(/\s+/g, " ")
      .trim() ?? "";
  return first.length > 40 ? `${first.slice(0, 39)}…` : first || "（質問なし）";
}

export function newTalkId(now: number): string {
  return `talk-${now}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

const KINDS: AiKind[] = ["claude", "codex", "local"];
const ROLES: EntryRole[] = ["user", "assistant", "tool", "error"];
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const time = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** A kept conversation as read back, or null when it is not one. */
export function readSavedTalk(value: unknown): SavedTalk | null {
  if (typeof value !== "object" || value === null) return null;
  const from = value as Record<string, unknown>;
  if (!text(from.id) || !KINDS.includes(from.kind as AiKind) || !Array.isArray(from.entries)) return null;
  const entries = from.entries.flatMap((entry): ChatEntry[] => {
    const read = (entry ?? {}) as Record<string, unknown>;
    return ROLES.includes(read.role as EntryRole) && typeof read.text === "string"
      ? [{ role: read.role as EntryRole, text: read.text }]
      : [];
  });
  return {
    id: text(from.id),
    kind: from.kind as AiKind,
    name: text(from.name),
    title: text(from.title) || talkTitle(entries),
    created: time(from.created),
    updated: time(from.updated),
    session: text(from.session) || null,
    dir: text(from.dir) || null,
    entries,
    applied: Array.isArray(from.applied) ? from.applied.filter((key): key is string => typeof key === "string") : [],
    rejected: Array.isArray(from.rejected) ? from.rejected.filter((key): key is string => typeof key === "string") : [],
  };
}

/** The kept conversations of the name `name` first, then the rest; each group newest first. */
export function orderTalks(talks: TalkSummary[], name: string): TalkSummary[] {
  return [...talks].sort((a, b) => Number(b.name === name) - Number(a.name === name) || b.updated - a.updated);
}

/** A conversation as the palette shows it, put together from the turns' events. */
export class Conversation {
  entries: ChatEntry[] = [];
  /** The AI's id for the conversation, to go on with it. */
  session: string | null = null;
  /** The turn running now. */
  running: number | null = null;

  constructor(readonly kind: AiKind) {}

  /** A kept conversation, to go on with. */
  static restore(talk: SavedTalk): Conversation {
    const conversation = new Conversation(talk.kind);
    conversation.entries = talk.entries.map((entry) => ({ ...entry }));
    conversation.session = talk.session;
    return conversation;
  }

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
    return this.entries
      .filter((entry) => entry.role === "user" || entry.role === "assistant")
      .map((entry) => ({ role: entry.role as "user" | "assistant", content: entry.text }));
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

/** One thing the AI did (read a file, ran a command), in words, with what it ran as is. */
export interface ToolStep {
  /** What it did, said plainly ("ネームの要約を読みました"). */
  label: string;
  /** The command or file as the AI gave it (shortened: the conversation's folder left out). */
  detail: string;
}

/** A command as shown: a shell's wrapper (pwsh -Command "…") taken off, doubled \ made single, the folder of the conversation left out. */
function shortCommand(command: string): string {
  let text = command.replace(/\\\\/g, "\\").trim();
  const wrapped = text.match(
    /^"?[^"]*?(?:pwsh|powershell|cmd|bash|sh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|-c|\/c|-lc)\s+(["']?)([\s\S]*)\1$/i,
  );
  if (wrapped) text = wrapped[2];
  return text.replace(/[A-Za-z]:[\\/][^'"\s]*?ai-sessions[\\/][^\\/'"\s]+[\\/]/g, "").replace(/\/[^'"\s]*?ai-sessions\/[^/'"\s]+\//g, "");
}

/** What a step of the AI's work means for the user (null: not a step but something to tell them, as it is). */
export function toolStep(text: string): ToolStep | null {
  const named = text.match(/^([A-Za-z][\w-]*)(?::\s*([\s\S]*))?$/);
  if (!named) return null;
  const [, tool, rest = ""] = named;
  const detail = tool === "command" || tool === "Bash" ? shortCommand(rest) : rest.trim();
  const lower = detail.toLowerCase();
  const pictures = [...detail.matchAll(/pages[\\/]p0*(\d+)\.png/gi)].map((match) => `p${match[1]}`);
  const pages = detail.match(/--pages[ =](\S+)/)?.[1];
  let label: string;
  if (tool === "Skill") label = "スキルを使いました";
  else if (lower.includes("namestudio.mjs") && /\bapply\b/.test(lower)) label = "変更の案を試しました";
  else if (lower.includes("namestudio.mjs") && /\bbrief\b/.test(lower)) label = `ネームの写しを読みました${pages ? `（p${pages}）` : ""}`;
  else if (lower.includes("namestudio.mjs")) label = "スキルでネームを調べました";
  else if (lower.includes("skill.md")) label = "スキルの説明を読みました";
  else if (pictures.length) label = `${pictures.join("・")} の絵を見ました`;
  else if (detail.includes(BRIEF_FILE)) label = "ネームの要約を読みました";
  else if (detail.includes(HELP_FILE)) label = "使い方を読みました";
  else if (detail.includes(COPY_FILE)) label = "ネームの写しを読みました";
  else if (/(agents|claude|system)\.md/.test(lower)) label = "相談の決まりを読みました";
  else if (
    tool === "Glob" ||
    tool === "Grep" ||
    tool === "LS" ||
    /^(rg|grep|ls|dir|find|findstr|get-childitem|select-string)\b/i.test(detail)
  )
    label = "フォルダーの中を調べました";
  else if (tool === "Read") label = `${detail.split(/[\\/]/).pop() || "ファイル"} を読みました`;
  else if (tool === "command" || tool === "Bash") label = "コマンドを動かしました";
  else label = `${tool} を使いました`;
  return { label, detail };
}

/** What follows a question: the AI's words, the steps it took (one after another, as one group), what it told and what went wrong. */
export type ReplyPiece =
  | { kind: "text"; text: string; index: number }
  | { kind: "steps"; steps: ToolStep[]; index: number }
  | { kind: "notice"; text: string; index: number }
  | { kind: "error"; text: string; index: number };

/** A question and what came back (a kept conversation may begin with a reply and no question). */
export interface ChatTurn {
  question: { text: string; index: number } | null;
  reply: ReplyPiece[];
}

/** A conversation cut into its questions, each with its reply. `index` is where an entry is in `entries`. */
export function chatTurns(entries: ChatEntry[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  entries.forEach((entry, index) => {
    if (entry.role === "user") {
      turns.push({ question: { text: entry.text, index }, reply: [] });
      return;
    }
    if (!turns.length) turns.push({ question: null, reply: [] });
    const reply = turns[turns.length - 1].reply;
    const last = reply[reply.length - 1];
    if (entry.role === "assistant") reply.push({ kind: "text", text: entry.text, index });
    else if (entry.role === "error") reply.push({ kind: "error", text: entry.text, index });
    else {
      const step = toolStep(entry.text);
      if (!step) reply.push({ kind: "notice", text: entry.text, index });
      else if (last?.kind === "steps") last.steps.push(step);
      else reply.push({ kind: "steps", steps: [step], index });
    }
  });
  return turns;
}

/** A group of steps in one line: what was done, each once, in order. */
export function stepsSummary(steps: ToolStep[]): string {
  return [...new Set(steps.map((step) => step.label))].join("・");
}

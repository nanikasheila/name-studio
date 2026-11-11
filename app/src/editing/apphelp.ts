// 使い方.md: the app's help as one text an AI can read to answer "how do I…"
// in the 相談 palette. It is written from what the screen's help shows (the
// help bar's topics, with the keys as set on this computer), every command
// with its keys, and the user guide (docs/guide.md), so the AI answers from
// the app as it is, not from guesses.
import { AREA_TOPICS, HOVER_TOPICS, keyLabel, shownSteps, TOOL_TOPICS, type HelpTopic } from "./helptopics";

/** A command as the help lists it. */
export interface HelpCommand {
  id: string;
  label: string;
  group: string;
}

/** The file the help goes in, in the conversation's folder. */
export const HELP_FILE = "使い方.md";

function topicText(topic: HelpTopic, keysOf: (command: string) => string[]): string {
  const steps = shownSteps(topic, keysOf);
  return [`### ${topic.name}`, ...(topic.what ? [topic.what] : []), ...steps.map((step) => `- ${step.input}: ${step.does}`)].join("\n");
}

/** Every command by group, with its keys as set now ("なし": only from the palette or a button). */
function commandsText(commands: readonly HelpCommand[], keysOf: (command: string) => string[]): string {
  const groups = new Map<string, string[]>();
  for (const command of commands) {
    const keys = keysOf(command.id).map(keyLabel);
    const rows = groups.get(command.group) ?? [];
    rows.push(`- ${command.label}: ${keys.length ? keys.join(" / ") : "キーなし"}`);
    groups.set(command.group, rows);
  }
  return [...groups].map(([group, rows]) => `### ${group}\n${rows.join("\n")}`).join("\n\n");
}

/** The guide with its pictures left out (the AI cannot see them, and their paths lead nowhere from its folder). */
function guideText(guide: string): string {
  return guide
    .replace(/!\[[^\]]*\]\([^)]*\)\n?/g, "")
    .replace(/\[([^\]]+)\]\((?!https?:)[^)]*\)/g, "$1")
    .replace(/^#/gm, "##")
    .trim();
}

/**
 * The whole help. `full` adds the user guide (for Claude Code and Codex,
 * which read it from the file); without it, it is short enough to go in a
 * local LLM's message.
 */
export function appHelp(keysOf: (command: string) => string[], commands: readonly HelpCommand[], guide: string, full = true): string {
  const tools = Object.values(TOOL_TOPICS).map((topic) => topicText(topic, keysOf));
  const areas = [...Object.values(AREA_TOPICS), ...Object.values(HOVER_TOPICS)].map((topic) => topicText(topic, keysOf));
  const parts = [
    "# Name Studio の使い方（この PC のキー設定）",
    "キーは作者がキー設定で変えたものを含め、いまの割り当てです。Ctrl+K の命令パレットで名前から探して実行でき、? で画面全体のヘルプ、キー設定で変えられます。",
    "## 道具（左の道具の列）",
    tools.join("\n\n"),
    "## 画面の各部と、その上のもの",
    areas.join("\n\n"),
    "## 命令とキー（Ctrl+K で名前から探せる）",
    commandsText(commands, keysOf),
  ];
  if (full && guide.trim()) parts.push("# くわしい説明（ユーザーガイド）", guideText(guide));
  return `${parts.join("\n\n")}\n`;
}

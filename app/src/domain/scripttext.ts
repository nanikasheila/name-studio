// 台本の書き出し: the dialogue as a script, page by page and panel by panel,
// in the form 台本の取り込み (scriptimport.ts) reads back.
import { KIND_LABELS } from "./dialogue";
import type { Line, Project } from "../model/model";
import { sceneSpans } from "./story";

/** One line of dialogue as the script writes it (名前「…」, ナレーション：…). */
function scriptLine(names: ReadonlyMap<string, string>, line: Line): string {
  const text = line.text.replace(/\s*\n\s*/g, "　").trim();
  const who = names.get(line.speaker ?? "") ?? "";
  if (line.kind === "narration") return `${KIND_LABELS.narration}：${text}`;
  if (line.kind === "sfx") return `${KIND_LABELS.sfx}：${text}`;
  if (line.kind === "thought") return `${who}（${text}）`;
  if (line.kind === "aside") return `${who}・${text}`;
  return `${who}「${text}」`;
}

/** Some lines (by id) as script text, under the heading of each page they are on (for the clipboard). */
export function linesText(project: Project, ids: readonly string[]): string {
  const names = new Map(project.characters.map((character) => [character.id, character.name]));
  const out: string[] = [];
  project.pages.forEach((page, index) => {
    const lines = page.lines.filter((line) => ids.includes(line.id));
    if (!lines.length) return;
    out.push(`■ ${index + 1} ページ`, ...lines.map((line) => scriptLine(names, line)), "");
  });
  return out.join("\n").trim();
}

/** The dialogue as a script: page by page, panel by panel, with speakers. */
export function scriptText(project: Project): string {
  const names = new Map(project.characters.map((character) => [character.id, character.name]));
  const spans = sceneSpans(project);
  const story = project.storyIndex !== undefined ? ` 第${project.storyIndex}話` : "";
  const out: string[] = [`${project.title}${story}`, ""];
  project.pages.forEach((page, index) => {
    const scene = spans.find((span) => span.first === index);
    if (scene) out.push(`◆ ${scene.scene.title}${scene.scene.storyTime ? `（${scene.scene.storyTime}）` : ""}`, "");
    out.push(`■ ${index + 1} ページ${page.memo ? `　${page.memo.split("\n")[0]}` : ""}`);
    const order = new Map(page.panels.map((panel) => [panel.id, panel.order]));
    let lastPanel: number | undefined;
    for (const line of page.lines) {
      const panel = line.panel ? order.get(line.panel) : undefined;
      if (panel !== undefined && panel !== lastPanel) out.push(`  ［${panel}］`);
      lastPanel = panel;
      out.push(`    ${scriptLine(names, line)}`);
    }
    out.push("");
  });
  return out.join("\n");
}

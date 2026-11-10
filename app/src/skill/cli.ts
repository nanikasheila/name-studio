// The Skills' command line (built into skills/name-studio/scripts/namestudio.mjs
// by `npm run build:skill`): reads and changes a .namestudio file without the
// app, with the same code the app uses, so that an AI (Claude Code, Codex…)
// can help make a name from the file alone.
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { applyOps, nameBrief, opsGuide, parseOps } from "../domain/assist";
import type { Project } from "../model/model";
import { ISSUE_LABELS, checkName } from "../domain/namecheck";
import { newProject, normalize, type NameKind } from "../domain/project";
import { scriptText } from "../domain/scripttext";
import { validate } from "../domain/validate";

const USAGE = `使い方（node namestudio.mjs …）:
  brief  <ネーム.namestudio> [--pages 3-5] [--current 3]   ネームの要約（AI が読む形）
  script <ネーム.namestudio>                              台本（セリフをページ・コマごとに。取り込める形）
  check  <ネーム.namestudio>                              開けるか・書き出し前のチェック
  ops                                                    変更の案（操作）の説明
  apply  <ネーム.namestudio> <案.json | -> [--dry-run] [--out 別名.namestudio]
                                                         変更の案を当てて保存（前の中身は .bak に）
  new    <ネーム.namestudio> [--title 題] [--pages 24] [--kind right|left|scroll]
                                                         新しいネームを作る`;

class Usage extends Error {}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Usage(`${name} の値がありません`);
  args.splice(at, 2);
  return value;
}

function flag(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at >= 0) args.splice(at, 1);
  return at >= 0;
}

function load(path: string): Project {
  const project = normalize(JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as Project);
  if (!Array.isArray(project.pages) || !project.pageFormat) throw new Error(`${path} はネームのファイルではないようです`);
  return project;
}

/** Write whole or not at all, and not over a file changed since it was read (the app saving it meanwhile). */
function save(path: string, project: Project, readAt: number | null): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(project)}\n`, "utf8");
  if (readAt !== null && existsSync(path) && statSync(path).mtimeMs !== readAt) {
    unlinkSync(temporary);
    throw new Error(`${path} は読んだあとで変わりました（アプリで開いて保存した？）。もう一度やり直してください`);
  }
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(temporary, path);
}

const say = (text: string) => process.stdout.write(`${text}\n`);

function range(text: string | undefined): [number, number] | undefined {
  if (!text) return undefined;
  const match = /^(\d+)(?:-(\d+))?$/.exec(text);
  if (!match) throw new Usage(`ページの範囲は 3 か 3-5 の形で（${text}）`);
  return [Number(match[1]), Number(match[2] ?? match[1])];
}

function run(argv: string[]): number {
  const args = [...argv];
  const command = args.shift();
  switch (command) {
    case "brief": {
      const pages = range(option(args, "--pages"));
      const current = option(args, "--current");
      const [path] = args;
      if (!path) throw new Usage("ファイルがありません");
      say(nameBrief(load(path), { pages, current: current ? [Number(current)] : undefined }));
      return 0;
    }
    case "script": {
      const [path] = args;
      if (!path) throw new Usage("ファイルがありません");
      say(scriptText(load(path)));
      return 0;
    }
    case "check": {
      const [path] = args;
      if (!path) throw new Usage("ファイルがありません");
      const project = load(path);
      const problems = validate(project);
      for (const problem of problems) say(`開けない: ${problem}`);
      const issues = checkName(project);
      for (const issue of issues) say(`${issue.page} ページ ${ISSUE_LABELS[issue.kind]}: ${issue.lineId}「${issue.text}」`);
      if (!problems.length && !issues.length) say("問題はありません");
      return problems.length ? 1 : 0;
    }
    case "ops":
      say(opsGuide());
      return 0;
    case "apply": {
      const dryRun = flag(args, "--dry-run");
      const out = option(args, "--out");
      const [path, source] = args;
      if (!path || !source) throw new Usage("ファイルと変更の案がありません");
      const readAt = statSync(path).mtimeMs;
      const project = load(path);
      const { ops, problems: unread } = parseOps(readFileSync(source === "-" ? 0 : source, "utf8"));
      for (const problem of unread) say(`読めない: ${problem}`);
      if (unread.length) return 1;
      const result = applyOps(project, ops);
      for (const done of result.done) say(`・${done}`);
      for (const problem of result.problems) say(`できない: ${problem}`);
      if (result.problems.length) {
        say("何も保存していません。直してもう一度どうぞ");
        return 1;
      }
      if (dryRun) {
        say("（--dry-run なので保存していません）");
        return 0;
      }
      save(out ?? path, project, out ? null : readAt);
      say(`保存しました: ${out ?? path}`);
      return 0;
    }
    case "new": {
      const title = option(args, "--title") ?? "新しいネーム";
      const pages = Number(option(args, "--pages") ?? "1");
      const kind = (option(args, "--kind") ?? "right") as NameKind;
      const [path] = args;
      if (!path) throw new Usage("ファイルがありません");
      if (!["right", "left", "scroll"].includes(kind)) throw new Usage("--kind は right・left・scroll のどれか");
      if (!Number.isInteger(pages) || pages < 1 || pages > 400) throw new Usage("--pages は 1〜400");
      if (existsSync(path)) throw new Error(`${path} はもうあります`);
      save(path, newProject(title, pages, kind), null);
      say(`作りました: ${path}（${pages} ページ）`);
      return 0;
    }
    default:
      throw new Usage(command ? `知らないコマンド ${command}` : "コマンドがありません");
  }
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  if (error instanceof Usage) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

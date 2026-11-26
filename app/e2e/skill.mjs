// The Skills' command line as built (skills/name-studio/scripts/namestudio.mjs):
// makes a name, changes it, reads it back, refuses a bad change without
// writing, and keeps the file as it was before in .bak.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../skills/name-studio/scripts/namestudio.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "namestudio-skill-"));
const name = join(dir, "試し.namestudio");
const ns = (...args) => execFileSync("node", [cli, ...args], { encoding: "utf8" });
const fail = (message) => {
  console.error(`skill: ${message}`);
  process.exit(1);
};

ns("new", name, "--title", "試し", "--pages", "3");
const ops = join(dir, "案.json");
writeFileSync(
  ops,
  JSON.stringify([
    { op: "script", text: "### 1ページ\n[1]\nミカ「おはよう」\n[2]\nソラ「おそいよ」" },
    { op: "addSticky", page: 1, panel: 2, text: "ここで間" },
  ]),
);
const applied = ns("apply", name, ops);
if (!applied.includes("保存しました")) fail(`apply: ${applied}`);
const brief = ns("brief", name);
if (!/\[line\d+\] ミカ「おはよう」/.test(brief) || !brief.includes("付箋: ここで間")) fail(`brief: ${brief}`);
if (!ns("script", name).includes("ソラ「おそいよ」")) fail("script");
if (!existsSync(`${name}.bak`)) fail("no .bak");
const before = readFileSync(name, "utf8");
const bad = spawnSync("node", [cli, "apply", name, "-"], {
  input: '[{"op":"setTitle","title":"x"},{"op":"removeLine","line":"line999"}]',
  encoding: "utf8",
});
if (bad.status !== 1 || readFileSync(name, "utf8") !== before) fail(`a bad change was saved: ${bad.stdout}`);
if (spawnSync("node", [cli, "nope"]).status !== 2) fail("usage");
if (!ns("ops").includes("- addLine: ")) fail("ops");
// The background's instruction for name-blockout, as the app writes it: the panel's ruler, things and look.
const full = fileURLToPath(new URL("../../crates/name-model/tests/fixtures/full-project.json", import.meta.url));
const instruction = join(dir, "指示.json");
if (!ns("blockout", full, instruction, "--dpi", "300").includes("1 コマ")) fail("blockout");
const shot = JSON.parse(readFileSync(instruction, "utf8")).shots[0];
if (shot.id !== "page1-panel1" || !shot.ruler || shot.frame.dpi !== 300) fail(`blockout shot: ${JSON.stringify(shot).slice(0, 200)}`);
if (spawnSync("node", [cli, "blockout", full, instruction, "--panels", "nope"]).status !== 1) fail("blockout: unknown panel");
console.log("skill: ok");

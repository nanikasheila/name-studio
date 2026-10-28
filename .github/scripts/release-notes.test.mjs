// node --test .github/scripts/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { commitLine, releaseNotes, userSection } from "./release-notes.mjs";

// A pull request body as this repository writes them (attribution, changes, checks).
const BODY = `<!-- claude-projects-attribution: {"github_login":"nanikasheila"} -->
_Requested by **シイラちゃん** · [project thread](https://claude.ai/code/project/x)_

## 使う人への変更
- 指示のレイヤーが CSP で色のまま見えるように（不透明度 100%）
- 書き出し画面に「指示を書き出す」

## 変更
- update.rs: layer opacity

## 確かめたこと
- cargo test

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;

test("the notes are the section for the people who use the app, nothing else", () => {
  assert.equal(userSection(BODY), "- 指示のレイヤーが CSP で色のまま見えるように（不透明度 100%）\n- 書き出し画面に「指示を書き出す」");
  const notes = releaseNotes({ body: BODY, title: "指示のレイヤーを 100% に", message: "Merge pull request #75 from x/y\n\n..." });
  assert.ok(!/Requested by|update\.rs|cargo test|Generated with|claude-projects/.test(notes), notes);
});

test("the section may be the last one, and its template hint is left out", () => {
  assert.equal(userSection("## 変更\n- a\n\n### 使う人への変更\n<!-- 使う人に見える変化を -->\n保存が速くなりました\n"), "保存が速くなりました");
});

test("an empty or missing section falls back to the title, then to the commit", () => {
  assert.equal(releaseNotes({ body: "## 使う人への変更\n<!-- なし -->\n\n## 変更\n- x", title: "保存を fsync に", message: "" }), "保存を fsync に");
  assert.equal(releaseNotes({ body: null, title: null, message: "Merge pull request #75 from a/b\n\nCSP の指示のレイヤーを 100% に" }), "CSP の指示のレイヤーを 100% に");
  assert.equal(commitLine("Merge branch 'main' into x\n\n本文"), "本文");
});

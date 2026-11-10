// 相談 (AI に相談) in its palette, with the Rust side stood in for: the AI
// found, the conversation's folder made with the name in words, its copy, the
// instructions and pictures of the pages; what the AI says comes in as
// events (its 変更の案 as a card saying what it would do), 当てる changes the
// name as one undoable step, a 変更の案 that cannot be done cannot be applied,
// a later question goes on with the same conversation (and the name changed
// meanwhile is shown again), and the connection settings are kept.
// Run: node e2e/assist.mjs
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1441, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(() => {
    window.__turns = [];
    window.__sessions = [];
    window.__talks = {};
    window.__listeners = [];
    window.__answer = (command, args) => {
      if (command === "plugin:event|listen" && args.event === "ai-event") {
        window.__listeners.push(args.handler);
        return window.__listeners.length;
      }
      if (command === "ai_detect") return { claude: { path: "C:\\bin\\claude.exe", version: "2.1.0 (Claude Code)" }, codex: null, node: { path: "node", version: "v22" } };
      if (command === "ai_has_key") return false;
      if (command === "ai_models") {
        window.__modelAsks = (window.__modelAsks ?? 0) + 1;
        if (args.kind === "claude")
          return [
            { value: "", label: "Default (recommended)", description: "Sonnet", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, isDefault: true },
            { value: "opus", label: "Opus", description: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, isDefault: false },
            { value: "old", label: "Old", description: "", efforts: ["low"], defaultEffort: null, isDefault: false },
          ];
        if (args.kind === "local") return [{ value: "gemma3", label: "gemma3", description: "", efforts: [], defaultEffort: null, isDefault: false }, { value: "llama3.2", label: "llama3.2", description: "", efforts: [], defaultEffort: null, isDefault: false }];
        throw "codex: not signed in";
      }
      if (command === "ai_prepare_session") {
        window.__sessions.push(args);
        return args.dir ?? "C:\\data\\ai-sessions\\session-1";
      }
      if (command === "ai_turn") {
        window.__turns.push(args.turn);
        return window.__turns.length;
      }
      if (command === "ai_stop") return null;
      if (command === "ai_history_save") {
        window.__talks[args.talk.id] = JSON.parse(JSON.stringify(args.talk));
        return null;
      }
      if (command === "ai_history_list")
        return Object.values(window.__talks)
          .map((talk) => ({ id: talk.id, kind: talk.kind, name: talk.name, title: talk.title, created: talk.created, updated: talk.updated, count: talk.entries.filter((entry) => entry.role === "user").length }))
          .sort((a, b) => b.updated - a.updated);
      if (command === "ai_history_load") {
        if (!window.__talks[args.id]) throw "その相談は見つかりません";
        return window.__talks[args.id];
      }
      if (command === "ai_history_delete") {
        delete window.__talks[args.id];
        return null;
      }
      return undefined;
    };
    // What the AI says: an event of turn `run`, as the Rust side would emit it.
    window.__say = (run, kind, text) => {
      for (const id of window.__listeners) window[`_${id}`]?.({ event: "ai-event", id: 1, payload: { run, kind, text } });
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const { applyOps } = await import("/src/domain/assist.ts");
    const project = newProject("屋上", 4);
    applyOps(project, [{ op: "script", text: "### 1ページ\n[1]\nミカ「星、見えないね」\n[2]\nソラ「見えなくても、あるよ」" }]);
    window.nameStudio.show(project);
  });
  const settle = (ms = 150) => page.evaluate((ms) => new Promise((resolve) => setTimeout(resolve, ms)), ms);
  const project = () => page.evaluate(() => window.nameStudio.workbench.session.project);

  await page.click("#tab-assist");
  await page.waitForSelector(".assist");
  await settle();
  check((await page.textContent(".assist-state")).includes("Claude Code（2.1.0 (Claude Code)）に聞きます"), "says which AI will answer, as found");
  check(!(await page.isVisible(".assist-settings")), "the connection settings are closed until 接続… is pressed");

  await page.click(".assist-starters button:first-child");
  check((await page.inputValue(".assist textarea")).includes("行き詰まって"), "a ready-made question goes into the box");
  await page.fill(".assist textarea", "1ページの間をどう取るか相談したい");
  await page.click(".assist-actions button.primary");
  await page.waitForFunction(() => window.__turns.length === 1);
  const [session] = await page.evaluate(() => window.__sessions);
  const files = Object.fromEntries(session.files.map((file) => [file.path, file]));
  check(session.dir === null, "the first question makes a new folder");
  check(files["ネーム.md"]?.text.includes("ミカ「星、見えないね」") && files["ネーム.md"].text.includes("### p1"), "the name goes in words");
  check(JSON.parse(files["ネーム.namestudio"]?.text ?? "{}").title === "屋上", "and as a copy");
  check(files["SYSTEM.md"]?.text.includes("namestudio-ops") && files["AGENTS.md"] && files["CLAUDE.md"], "with the instructions for Claude Code and Codex");
  check(["pages/p001.png", "pages/p004.png"].every((path) => files[path]?.base64?.length > 100), "and every page as a picture");
  const [turn] = await page.evaluate(() => window.__turns);
  check(turn.kind === "claude" && turn.resume === null && turn.dir.endsWith("session-1"), "the turn goes to Claude Code in that folder");
  check(turn.prompt.startsWith("（ネームの要約を付けます。") && turn.prompt.includes("作者はいま p1") && /<ネームの要約>\n[\s\S]*\[line\d+\][\s\S]*<\/ネームの要約>/.test(turn.prompt) && turn.prompt.endsWith("作者の相談:\n1ページの間をどう取るか相談したい"), `the question carries the name's brief and the pages open (${turn.prompt.slice(0, 60)})`);
  check(await page.locator(".assist-actions button.primary").isDisabled(), "no second question while one is answered");

  await page.evaluate(() => {
    window.__say(1, "session", "sess-1");
    window.__say(1, "tool", "Read: ネーム.md");
    window.__say(1, "delta", "2コマ目の前に、**間**のコマを足す案です。\n\n```namestudio-ops\n");
    window.__say(1, "delta", '[{"op":"addPages","after":1,"count":1,"memos":["間"]},{"op":"addSticky","page":1,"panel":2,"text":"ここで一拍"}]\n```\nどうでしょう。\n\n- 案A\n- 案B');
  });
  await settle();
  if (process.env.ASSIST_SHOT) await page.screenshot({ path: process.env.ASSIST_SHOT });
  check(await page.locator(".assist-entry.tool").first().textContent() === "Read: ネーム.md", "what the AI did shows as it does it");
  check((await page.locator(".assist-ops").count()) === 1, "its 変更の案 shows as a card");
  check(await page.locator(".assist-ops button.primary").isDisabled(), "not to be applied while the reply is still coming");
  await page.evaluate(() => window.__say(1, "done", ""));
  await settle();
  const card = await page.textContent(".assist-ops");
  if (process.env.ASSIST_SHOT) await page.screenshot({ path: process.env.ASSIST_SHOT.replace(".png", "-card.png") });
  check(card.includes("2 ページを足しました") && card.includes("1 ページに付箋「ここで一拍」"), `the card says what it would do (${card})`);
  check((await page.textContent(".assist-entry.assistant")).includes("どうでしょう。"), "the words around it stay");
  check((await page.textContent(".assist-entry.assistant .assist-text strong")) === "間" && (await page.locator(".assist-entry.assistant .assist-text li").count()) === 2, "and show as the Markdown they are written in (bold, a list)");
  check(!(await page.textContent(".assist-entry.assistant")).includes("**"), "with no marks left over");
  check((await project()).pages.length === 4, "nothing changes before 当てる");
  await page.click(".assist-ops button.primary");
  await settle();
  const after = await project();
  check(after.pages.length === 5 && after.pages[1].memo === "間" && after.pages[0].stickies?.[0]?.text === "ここで一拍", "当てる changes the name");
  await page.click("#undo");
  await settle();
  check((await project()).pages.length === 4 && !(await project()).pages[0].stickies?.length, "and one 元に戻す takes it all back");

  // A second question goes on with the conversation; the name changed since is shown again.
  await page.evaluate(() => window.nameStudio.workbench.edit((p) => (p.title = "屋上の約束")));
  await page.fill(".assist textarea", "では2ページ目は？");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => window.__turns.length === 2);
  const second = await page.evaluate(() => ({ turn: window.__turns[1], sessions: window.__sessions.length, dir: window.__sessions.at(-1).dir }));
  check(second.turn.resume === "sess-1", "the next question goes on with the same conversation");
  check(second.sessions === 2 && second.dir.endsWith("session-1"), "the name changed, so its folder is brought up to date");
  check(second.turn.prompt.startsWith("（ネームが変わったので"), "and the AI is told to read it again");
  await page.evaluate(() => {
    window.__say(2, "text", '```namestudio-ops\n[{"op":"setLine","line":"line999","text":"x"}]\n```');
    window.__say(2, "done", "");
  });
  await settle();
  const bad = page.locator(".assist-ops").last();
  check((await bad.textContent()).includes("セリフ line999 はありません") && (await bad.locator("button.primary").isDisabled()), "a 変更の案 that cannot be done says why and cannot be applied");
  await page.evaluate(() => window.__say(2, "error", "これは前のターンの後の知らせ"));
  await settle();
  check(!(await page.locator(".assist-entry.error").count()), "an event of a turn that ended is not shown");

  // The model and its effort, chosen from the list the tool gives.
  await page.click(".assist-head button:has-text('接続')");
  await page.waitForFunction(() => document.querySelectorAll(".assist-settings select[aria-label='モデル'] option").length >= 3);
  const options = await page.$$eval(".assist-settings select[aria-label='モデル'] option", (all) => all.map((option) => option.value));
  check(options.join(",") === ",opus,old", `the models are the ones Claude Code listed (${options.join(",")})`);
  await page.selectOption(".assist-settings select[aria-label='モデル']", "opus");
  await page.selectOption(".assist-settings select[aria-label='effort']", "xhigh");
  const effortOptions = await page.$$eval(".assist-settings select[aria-label='effort'] option", (all) => all.map((option) => option.value));
  check(effortOptions.join(",") === ",low,medium,high,xhigh,max", `the efforts are the ones Opus takes (${effortOptions.join(",")})`);
  check((await page.textContent(".assist-state")).includes("Opus・effort xhigh"), "and the line says which");
  if (process.env.ASSIST_SHOT) await page.locator("#dock-right").screenshot({ path: process.env.ASSIST_SHOT.replace(".png", "-models.png") });
  const compact = await page.evaluate(() => {
    const box = document.querySelector(".assist-settings");
    const model = box.querySelector("select[data-part='model']").getBoundingClientRect();
    const effort = box.querySelector("select[data-part='effort']").getBoundingClientRect();
    return { height: box.getBoundingClientRect().height, oneLine: Math.abs(model.top - effort.top) < 2 };
  });
  check(compact.oneLine && compact.height < 90, `the settings take little room: model and effort on one line (${Math.round(compact.height)}px)`);
  check(!(await page.isVisible(".assist-settings input[aria-label='場所']")), "where the program is and the Skill fold away under 詳しく");
  await page.click(".assist-more > summary");
  check(await page.isVisible(".assist-settings input[aria-label='場所']"), "and show when it is opened");
  await page.click(".assist-more > summary");
  await page.selectOption(".assist-settings select[aria-label='モデル']", "old");
  check((await page.inputValue(".assist-settings select[aria-label='effort']")) === "", "an effort the next model does not take goes back to its default");
  await page.selectOption(".assist-settings select[aria-label='モデル']", "opus");
  await page.selectOption(".assist-settings select[aria-label='effort']", "high");
  await page.fill(".assist textarea", "モデルを変えて");
  await page.click(".assist-actions button.primary");
  await page.waitForFunction(() => window.__turns.length === 3);
  const chosenTurn = await page.evaluate(() => window.__turns[2]);
  check(chosenTurn.model === "opus" && chosenTurn.effort === "high", `the turn asks for that model and effort (${chosenTurn.model}・${chosenTurn.effort})`);
  await page.evaluate(() => window.__say(3, "done", ""));
  // A model kept from before that the tool no longer lists is not sent.
  await page.evaluate(() => {
    const kept = JSON.parse(localStorage.getItem("namestudio.assist"));
    localStorage.setItem("namestudio.assist", JSON.stringify({ ...kept, claudeModel: "opsu" }));
  });
  await page.evaluate(() => window.nameStudio.workbench.lists.assistPanel.settings.claudeModel = "opsu");
  await page.click(".assist-head button:has-text('接続')");
  await page.click(".assist-head button:has-text('接続')");
  check((await page.textContent(".assist-settings")).includes("「opsu」は一覧にありません"), "a model not in the list says so");
  await page.fill(".assist textarea", "これは送られない");
  await page.click(".assist-actions button.primary");
  await settle();
  check((await page.evaluate(() => window.__turns.length)) === 3 && (await page.inputValue(".assist textarea")) === "これは送られない", "and is not sent (the question stays)");
  await page.selectOption(".assist-settings select[aria-label='モデル']", "");
  // Codex could not list its models: why is said, and it can be asked again.
  await page.selectOption(".assist-head select", "codex");
  await page.waitForFunction(() => document.querySelector(".assist-settings")?.textContent.includes("一覧を取れません"));
  check((await page.textContent(".assist-settings")).includes("codex: not signed in"), "a tool that cannot list its models says why");
  await page.selectOption(".assist-head select", "claude");
  await page.click(".assist-head button:has-text('接続')");

  // The settings: a local LLM, kept for the next start.
  await page.click(".assist-head button:has-text('接続')");
  await page.selectOption(".assist-head select", "local");
  check((await page.locator(".assist-settings input[aria-label='URL']").inputValue()) === "http://localhost:11434/v1", "a local LLM starts with Ollama's address");
  await page.waitForFunction(() => document.querySelectorAll(".assist-settings select[aria-label='モデル'] option").length === 2);
  await page.selectOption(".assist-settings select[aria-label='モデル']", "gemma3");
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.assist")));
  check(kept.kind === "local" && kept.localModel === "gemma3", "the choice is kept");
  check((await page.textContent(".assist-state")).includes("gemma3 に聞きます"), "and said");
  await page.click(".assist-head button:has-text('新しい相談')");
  await page.fill(".assist textarea", "こんにちは");
  await page.click(".assist-actions button.primary");
  await page.waitForFunction(() => window.__turns.length === 4);
  const local = await page.evaluate(() => window.__turns[3]);
  check(local.kind === "local" && local.messages[0].role === "system" && local.messages[0].content.includes("# ネーム「屋上の約束」"), "a local LLM is told the name in its instructions");
  check(local.messages.at(-1).content === "こんにちは" && local.messages.at(-1).images.includes("pages/p001.png"), "with the pages on screen as pictures");
  check(local.messages.length === 2, "a new conversation forgets the old one");

  // What was said is kept: the list of past conversations opens one to go on with.
  await page.evaluate(() => {
    window.__say(4, "text", "こんにちは。\n\n| 案 | ページ |\n|---|--:|\n| A | 1 |");
    window.__say(4, "done", "");
  });
  await settle();
  check((await page.locator(".assist-entry.assistant table td").count()) === 2, "a table shows as a table");
  const talks = await page.evaluate(() => Object.values(window.__talks));
  const claudeTalk = talks.find((talk) => talk.kind === "claude");
  check(talks.length === 2 && claudeTalk?.session === "sess-1" && claudeTalk.dir.endsWith("session-1") && claudeTalk.entries.filter((entry) => entry.role === "user").length === 3, `each conversation is kept with its session and folder (${talks.length})`);
  check(claudeTalk.title === "1ページの間をどう取るか相談したい", "named by its first question");
  await page.click(".assist-head button:has-text('履歴')");
  await page.waitForSelector(".assist-history .assist-talk");
  const listed = await page.$$eval(".assist-history .assist-talk-title", (all) => all.map((title) => title.textContent));
  check(listed.join("|") === "こんにちは|1ページの間をどう取るか相談したい", `the list shows them newest first (${listed.join("|")})`);
  check((await page.textContent(".assist-history li.now")).includes("こんにちは"), "with the one open now marked");
  await page.click(".assist-history .assist-talk:has-text('1ページの間')");
  await settle();
  check((await page.inputValue(".assist-head select")) === "claude" && (await page.locator(".assist-entry.user").first().textContent()) === "1ページの間をどう取るか相談したい", "opening one brings back its AI and what was said");
  check(!(await page.isVisible(".assist-history")), "and closes the list");
  check((await page.textContent(".assist-entry.assistant .assist-text strong")) === "間", "its replies still as Markdown");
  await page.fill(".assist textarea", "続きです");
  await page.click(".assist-actions button.primary");
  await page.waitForFunction(() => window.__turns.length === 5);
  const goOn = await page.evaluate(() => ({ turn: window.__turns[4], dir: window.__sessions.at(-1).dir }));
  check(goOn.turn.kind === "claude" && goOn.turn.resume === "sess-1" && goOn.turn.dir.endsWith("session-1") && goOn.dir.endsWith("session-1"), "the next question goes on with that session, in its folder");
  check(goOn.turn.prompt.startsWith("（ネームの要約を付けます。") && goOn.turn.prompt.endsWith("続きです"), "with the name as it is now");
  await page.evaluate(() => window.__say(5, "done", ""));
  await settle();
  check((await page.evaluate(() => Object.keys(window.__talks).length)) === 2, "kept as the same conversation, not a new one");
  await page.click(".assist-head button:has-text('履歴')");
  await page.waitForSelector(".assist-history .assist-talk");
  const remove = page.locator(".assist-history li:has-text('こんにちは') button:has-text('消す')");
  await remove.click();
  check((await page.evaluate(() => Object.keys(window.__talks).length)) === 2 && (await remove.textContent()) === "消す？", "消す asks once more");
  await remove.click();
  await settle();
  check((await page.evaluate(() => Object.keys(window.__talks).length)) === 1 && (await page.locator(".assist-history .assist-talk").count()) === 1, "and then takes it off the list");
  if (process.env.ASSIST_SHOT) await page.locator("#dock-right").screenshot({ path: process.env.ASSIST_SHOT.replace(".png", "-history.png") });
  await page.click(".assist-head button:has-text('履歴')");

  // A short palette (its column shared with 詳細 and サブツール): the box to write in and 送る stay whole.
  for (const height of [260, 160]) {
    const room = await page.evaluate((height) => {
      const panel = document.getElementById("side-assist");
      panel.style.flex = "none";
      panel.style.height = `${height}px`;
      const inside = (element) => {
        const box = element.getBoundingClientRect();
        const outer = panel.querySelector(".assist").getBoundingClientRect();
        return { height: box.height, shown: box.top >= outer.top - 1 && box.bottom <= outer.bottom + 1 };
      };
      return { input: inside(panel.querySelector("textarea")), send: inside(panel.querySelector(".assist-actions button.primary")) };
    }, height);
    check(room.input.height >= 40 && room.input.shown && room.send.shown, `in a palette ${height}px high the box (${Math.round(room.input.height)}px) and 送る show`);
  }
  await page.click(".assist-head button:has-text('接続')");
  const withSettings = await page.evaluate(() => document.querySelector("#side-assist textarea").getBoundingClientRect().height);
  check(withSettings >= 40, `and with the settings open too (${Math.round(withSettings)}px)`);
  if (process.env.ASSIST_SHOT) await page.locator("#dock-right").screenshot({ path: process.env.ASSIST_SHOT.replace(".png", "-short.png") });
  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

// Autosave writes only when there is something new: a name just opened, a
// step that changed nothing, a change taken back or the setting turned on
// with nothing unsaved leave the file alone. When it writes is set in the
// settings (保存), and so is how new versions come in (更新), with a way to
// look now. Run: npm run e2e:autosave
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const A = "C:\\ネーム\\A.namestudio";

const server = await createServer({ root, logLevel: "error", server: { port: 1443, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(() => {
    window.__writes = [];
    window.__answer = async (command, args) => {
      switch (command) {
        case "load_project":
          return JSON.parse(JSON.stringify(window.__project));
        case "autosave_project":
        case "save_project": {
          const length = new DataView(args.buffer, args.byteOffset).getUint32(0, true);
          const meta = JSON.parse(new TextDecoder().decode(args.subarray(4, 4 + length)));
          const text = new TextDecoder().decode(args.subarray(4 + length));
          window.__writes.push({ command, toFile: meta.toFile, title: JSON.parse(text).title });
          return command === "save_project" ? null : { savedToFile: !!(meta.path && meta.toFile), version: null, problems: [] };
        }
        case "discard_recovery":
          window.__discarded = (window.__discarded ?? 0) + 1;
          return null;
        default:
          return undefined;
      }
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  const writes = () => page.evaluate(() => window.__writes.length);
  const lastWrite = () => page.evaluate(() => window.__writes.at(-1) ?? null);
  const saveState = () => page.locator("#save-state").textContent();
  const dirty = () => page.evaluate(() => window.nameStudio.workbench.session.dirty);
  const step = (change) =>
    page.evaluate((change) => {
      const wb = window.nameStudio.workbench;
      wb.begin();
      if (change !== null) wb.project.title = change;
      wb.commit();
    }, change);
  const status = () => page.locator("#status").textContent();

  // A name opened from its file: nothing to write until it changes.
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    window.__project = newProject("A", 2);
    window.nameStudio.show(newProject("A", 2));
  });
  await page.evaluate((path) => window.nameStudio.workbench.load(path), A);

  // The settings: 3 and 30 seconds until set; 1 second here so the test is quick.
  await page.locator("#settings").click();
  await page.locator('.settings-nav-item[data-pane="save"]').click();
  const delay = page.locator("#st-autosave-delay");
  const maxWait = page.locator("#st-autosave-max-wait");
  check((await delay.inputValue()) === "3" && (await maxWait.inputValue()) === "30", `autosave waits 3 s of quiet, 30 s at most, until set (${await delay.inputValue()}, ${await maxWait.inputValue()})`);
  await maxWait.fill("2");
  await maxWait.dispatchEvent("change");
  check((await delay.inputValue()) === "2" && (await maxWait.inputValue()) === "5", `the longest wait stays in its range and takes the quiet along (${await delay.inputValue()}, ${await maxWait.inputValue()})`);
  await delay.fill("1");
  await delay.dispatchEvent("change");
  check((await status()).includes("1 秒") && (await status()).includes("5 秒"), `the times set are said (${await status()})`);
  const kept = await page.evaluate(() => [localStorage.getItem("namestudio.autosaveDelaySec"), localStorage.getItem("namestudio.autosaveMaxWaitSec")]);
  check(kept[0] === "1" && kept[1] === "5", `and kept for the next start (${kept})`);

  // 更新: three ways, kept; 「今すぐ確かめる」 says what it found.
  await page.locator('.settings-nav-item[data-pane="update"]').click();
  const mode = page.locator("#st-update-mode");
  check((await mode.inputValue()) === "auto", "new versions go in by themselves until set");
  await mode.selectOption("off");
  check((await page.evaluate(() => localStorage.getItem("namestudio.updateMode"))) === "off", "「確かめない」 is kept");
  check((await status()).includes("確かめません"), `and said (${await status()})`);
  await page.locator("#st-check-update").click();
  await page.waitForTimeout(200);
  check((await status()).includes("開発中の版"), `「今すぐ確かめる」 says a build from the source is not updated (${await status()})`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.waitForTimeout(1500);
  check((await writes()) === 0, "a name just opened is not written (nor while the settings were changed)");

  // A step that changed nothing: unsaved for a moment, then saved again without writing.
  await step(null);
  check(await dirty(), "a step that changed nothing still counts as a change at first");
  await page.waitForTimeout(1500);
  check((await writes()) === 0, `autosave finds the file holds it already and writes nothing (${await writes()} writes)`);
  check(!(await dirty()) && (await saveState()).startsWith("保存済み"), `and the name is saved (${await saveState()})`);

  // A change is written once, a second later.
  await step("A2");
  await page.waitForTimeout(400);
  check((await writes()) === 0, "autosave waits the quiet set");
  await page.waitForTimeout(1100);
  let last = await lastWrite();
  check((await writes()) === 1 && last?.command === "autosave_project" && last.toFile && last.title === "A2", `then writes the change to the file (${JSON.stringify(last)})`);
  await page.waitForTimeout(1500);
  check((await writes()) === 1, "and not again while nothing changes");

  // Changed and taken back before autosave: nothing written.
  await step("A3");
  await page.evaluate(() => window.nameStudio.workbench.undo());
  await page.waitForTimeout(1500);
  check((await writes()) === 1, `a change undone before autosave is not written (${await writes()} writes)`);
  check(!(await dirty()), "and the name is saved");

  // Turning 「ファイルに上書き」 off and on with nothing unsaved writes nothing.
  await page.locator("#settings").click();
  await page.locator('.settings-nav-item[data-pane="save"]').click();
  await page.locator("#st-autosave").click();
  await page.locator("#st-autosave").click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  check((await writes()) === 1, `turning the setting off and on with nothing unsaved writes nothing (${await writes()} writes)`);

  // With the file off, changes go to the copy, once; taken back to what the file holds, the copy goes.
  await page.evaluate(() => localStorage.setItem("namestudio.autosaveToFile", "off"));
  await step("A4");
  await page.waitForTimeout(1500);
  last = await lastWrite();
  check((await writes()) === 2 && last?.toFile === false && last.title === "A4", `with the file off, a change goes to the copy (${JSON.stringify(last)})`);
  check((await saveState()).startsWith("控えに保存"), `and the save state says so (${await saveState()})`);
  await step(null);
  await page.waitForTimeout(1500);
  check((await writes()) === 2, "a step that changed nothing is not written to the copy again");
  await step("A2");
  await page.waitForTimeout(1500);
  check((await writes()) === 2 && !(await dirty()), `back to what the file holds: nothing written, saved (${await saveState()})`);
  check((await page.evaluate(() => window.__discarded ?? 0)) === 1, "and the copy kept on the way is thrown away");

  // A manual save still writes when asked.
  await page.evaluate(() => window.nameStudio.workbench.save());
  check((await lastWrite())?.command === "save_project", "Ctrl+S writes when asked, changed or not");

  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

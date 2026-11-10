// やり直す: Ctrl+Y, Ctrl+Shift+Z and the button bring back what Ctrl+Z took,
// for the page operations too; a step that changed nothing neither counts as
// one nor loses what can be redone; undo works from a checkbox just used and
// inside the pen settings; the help over the screen names the button.
// Run: npm run e2e:redo
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.SHOTS;
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1447, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(() => {
    window.__answer = (command) => (command === "plugin:dialog|message" ? "Yes" : undefined);
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const project = newProject("やり直し", 4);
    project.pages.forEach((p, i) => (p.memo = `メモ${i + 1}`));
    window.nameStudio.show(project);
    window.nameStudio.workbench.docks.open("pages");
    await new Promise((done) => setTimeout(done, 300));
  });
  const wb = (fn, arg) => page.evaluate(fn, arg);
  const memos = async () => (await wb(() => window.nameStudio.workbench.project.pages.map((p) => p.memo))).join(",");
  const depth = () => wb(() => window.nameStudio.workbench.session.historyDepth);
  const item = (n) => page.locator("#side-pages .page-item").nth(n - 1);
  const redoEnabled = () => page.locator("#redo").isEnabled();
  const toCanvas = () => page.mouse.click(700, 120);

  // --- keys and the button, on the page operations ---
  check(!(await redoEnabled()), "nothing to redo at first: the button is off");
  await item(2).click();
  await page.keyboard.press("Control+d");
  await item(4).click();
  await page.keyboard.press("Delete");
  const changed = await memos();
  check(changed === "メモ1,メモ2,メモ2,メモ4", `a page duplicated and one deleted (${changed})`);
  await toCanvas();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  check((await memos()) === "メモ1,メモ2,メモ3,メモ4", "Ctrl+Z twice takes both back");
  check(await redoEnabled(), "the redo button turns on");
  await page.keyboard.press("Control+y");
  check((await memos()) === "メモ1,メモ2,メモ2,メモ3,メモ4", "Ctrl+Y redoes the duplicate");
  await page.keyboard.press("Control+Shift+z");
  check((await memos()) === changed, "Ctrl+Shift+Z redoes the delete");
  check(!(await redoEnabled()), "all redone: the button is off again");
  await page.keyboard.press("Control+z");
  await page.click("#redo");
  check((await memos()) === changed, "the button redoes too");

  // Holding pages and putting them back, then undo and redo all of it.
  await item(1).click();
  await item(1).click({ button: "right" });
  await page.locator(".popup-menu button", { hasText: "保留" }).first().click();
  const held = await wb(() => window.nameStudio.workbench.project.heldPages?.length ?? 0);
  check(held === 1 && (await memos()) === "メモ2,メモ2,メモ4", `a page held (${await memos()})`);
  await toCanvas();
  await page.keyboard.press("Control+z");
  check(
    (await memos()) === changed && (await wb(() => window.nameStudio.workbench.project.heldPages?.length ?? 0)) === 0,
    "undo puts the held page back",
  );
  await page.keyboard.press("Control+y");
  check((await memos()) === "メモ2,メモ2,メモ4", "redo holds it again");
  await page.keyboard.press("Control+z");

  // --- a step that changed nothing ---
  await page.keyboard.press("Control+z");
  const d = await depth();
  await wb(() => window.nameStudio.workbench.edit(() => {}));
  await toCanvas();
  check(
    JSON.stringify(await depth()) === JSON.stringify(d),
    `a change that changed nothing is no step and keeps the redo (${JSON.stringify(d)})`,
  );
  await page.keyboard.press("Control+y");
  check((await memos()) === changed, "and redo still works after it");

  // --- from a checkbox just used ---
  await page.keyboard.press("Control+z");
  await page.locator("#first-alone-label").click();
  await page.locator("#first-alone-label").click();
  check(await wb(() => document.activeElement?.id === "editor-first-alone"), "the checkbox has the focus");
  await page.keyboard.press("Control+y");
  check((await memos()) === changed, "Ctrl+Y works from the checkbox");
  await page.keyboard.press("Control+z");
  check((await memos()) === "メモ1,メモ2,メモ2,メモ3,メモ4", "and Ctrl+Z too");
  await page.keyboard.press("Control+y");
  // A text field keeps its own undo.
  await page.locator("#side-pages input[placeholder='作品名']").focus();
  await page.keyboard.press("Control+z");
  check((await memos()) === changed, "Ctrl+Z in a text field is the field's");
  await toCanvas();

  // --- inside the pen settings ---
  await page.keyboard.press("p");
  await page.click("#brush-edit");
  await page.click("#be-new");
  await page.click("#be-duplicate");
  const names = () => wb(() => window.nameStudio.workbench.project.brushes.map((b) => b.name).join());
  check((await names()) === "新しいペン,新しいペン のコピー", `two pens made in the pen settings (${await names()})`);
  await page.locator("#be-delete").focus();
  await page.keyboard.press("Control+z");
  check((await names()) === "新しいペン", "Ctrl+Z there undoes the copy");
  check((await page.locator("#be-list").textContent()).includes("のコピー") === false, "and the list shows it");
  await page.keyboard.press("Control+y");
  check(
    (await names()) === "新しいペン,新しいペン のコピー" && (await page.locator("#be-list").textContent()).includes("のコピー"),
    "Ctrl+Y brings it back, in the list too",
  );
  check(await page.locator("#brush-editor").evaluate((dialog) => dialog.open), "the pen settings stay open");
  await page.keyboard.press("Escape");

  // --- Ctrl+Z while the pen is down waits for the line to end ---
  const strokes = () => wb(() => window.nameStudio.workbench.project.pages.reduce((sum, p) => sum + p.strokes.length, 0));
  const before = await strokes();
  await page.mouse.move(650, 400);
  await page.mouse.down();
  await page.mouse.move(700, 430, { steps: 5 });
  await page.keyboard.press("Control+z");
  await page.mouse.move(750, 460, { steps: 5 });
  await page.mouse.up();
  check((await strokes()) === before + 1, `a line drawn through Ctrl+Z is kept whole (${before} → ${await strokes()})`);
  await page.keyboard.press("Control+z");
  check((await strokes()) === before, "and the next Ctrl+Z takes it back");
  await page.keyboard.press("Control+y");
  check((await strokes()) === before + 1, "Ctrl+Y draws it again");

  // --- the help over the screen and the key settings ---
  await toCanvas();
  await page.keyboard.press("?");
  const labels = await page.evaluate(() => [...document.querySelectorAll(".help-label")].map((label) => label.textContent));
  const undoLabel = labels.find((text) => text.startsWith("元に戻すCtrl+Z")) ?? "";
  check(undoLabel.includes("右はやり直すCtrl+Y"), `the help names the redo button beside it, with its key (${undoLabel})`);
  if (shots) await page.screenshot({ path: `${shots}/redo-help.png` });
  await page.keyboard.press("?");
  const keys = await wb(() => window.nameStudio.workbench.shortcuts.keys("redo"));
  check(JSON.stringify(keys) === JSON.stringify(["Ctrl+Y", "Ctrl+Shift+Z"]), `キー設定 has redo on Ctrl+Y and Ctrl+Shift+Z (${keys})`);
  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

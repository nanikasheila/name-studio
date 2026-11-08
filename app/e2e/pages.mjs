// ページ管理: the page list's menu, buttons and keys insert, duplicate,
// delete, hold and copy pages, one undo step each; several pages are picked
// with Ctrl / Shift; the story band's pages have the same menu; and Delete
// pressed on the canvas after the list stays the canvas's.
// Run: npm run e2e:pages
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

const server = await createServer({ root, logLevel: "error", server: { port: 1446, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(() => {
    window.__asked = [];
    window.__answer = (command, args) => {
      // ask(): the message dialog with Yes / No, answered Yes.
      if (command === "plugin:dialog|message") {
        window.__asked.push(args?.message ?? "");
        return "Yes";
      }
      return undefined;
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const { addPanel } = await import("/src/panels.ts");
    const { rectShape } = await import("/src/geometry.ts");
    const project = newProject("ページ管理", 6);
    project.pages.forEach((p, i) => (p.memo = `メモ${i + 1}`));
    addPanel(project, project.pages[1], rectShape([20, 20, 160, 120]));
    window.nameStudio.show(project);
    window.nameStudio.workbench.docks.open("pages");
    await new Promise((done) => setTimeout(done, 300));
  });
  const wb = (fn, arg) => page.evaluate(fn, arg);
  const undos = () => wb(() => window.nameStudio.workbench.session.history.undoStack.length);
  const memos = () => wb(() => window.nameStudio.workbench.project.pages.map((p) => p.memo));
  const item = (n) => page.locator("#side-pages .page-item").nth(n - 1);
  const menuItem = (label) => page.locator(".popup-menu button", { hasText: label });

  // The menu on a page.
  await item(3).click();
  await item(3).click({ button: "right" });
  check(await page.locator(".popup-menu").isVisible(), "right click on a page opens its menu");
  check((await page.locator(".popup-menu button").count()) >= 12, "with insert, duplicate, copy, move, hold and delete");
  if (shots) await page.screenshot({ path: `${shots}/page-menu.png` });
  let before = await undos();
  await menuItem("後ろに白紙のページを入れる").click();
  let m = await memos();
  check(m.length === 7 && m[3] === "" && m[4] === "メモ4", `a blank page goes behind page 3 (${m.join(",")})`);
  check((await undos()) === before + 1, "in one undo step");
  check((await wb(() => window.nameStudio.workbench.editor.focusPage()?.memo)) === "", "and the new page is the one shown");

  // Keys while the list has the focus: Ctrl+D duplicates, Insert / Shift+Insert insert.
  await item(2).click();
  await page.keyboard.press("Control+d");
  m = await memos();
  check(m.length === 8 && m[1] === "メモ2" && m[2] === "メモ2", `Ctrl+D copies page 2 behind it (${m.join(",")})`);
  const panelIds = await wb(() => window.nameStudio.workbench.project.pages.slice(1, 3).map((p) => p.panels[0]?.id));
  check(panelIds[0] && panelIds[1] && panelIds[0] !== panelIds[1], "the copy's panel has its own id");
  await page.keyboard.press("Shift+Insert");
  m = await memos();
  check(m.length === 9 && m[2] === "", `Shift+Insert puts a blank page in front (${m.join(",")})`);

  // Several pages: Ctrl+click and Shift+click, then delete them in one step.
  await wb(() => window.nameStudio.workbench.undo());
  await wb(() => window.nameStudio.workbench.undo());
  await wb(() => window.nameStudio.workbench.undo());
  m = await memos();
  check(m.length === 6 && m.join(",") === "メモ1,メモ2,メモ3,メモ4,メモ5,メモ6", `undo takes them back (${m.join(",")})`);
  await item(2).click();
  await item(4).click({ modifiers: ["Control"] });
  check((await page.locator("#side-pages .page-item.picked").count()) === 2, "Ctrl+click picks a second page");
  await item(5).click({ modifiers: ["Shift"] });
  check((await page.locator("#side-pages .page-item.picked").count()) === 2, "Shift+click picks a run from the last one (4–5)");
  await item(2).click();
  await item(4).click({ modifiers: ["Shift"] });
  check((await page.locator("#side-pages .page-item.picked").count()) === 3, "Shift+click picks 2–4");
  before = await undos();
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => window.nameStudio.workbench.project.pages.length === 3);
  m = await memos();
  check(m.join(",") === "メモ1,メモ5,メモ6", `Delete takes the picked pages out (${m.join(",")})`);
  check((await wb(() => window.__asked.length)) === 1, "asking first, as there was something on them");
  check((await undos()) === before + 1, "in one undo step");
  await wb(() => window.nameStudio.workbench.undo());

  // 保留: out to the 保留 list and back where it was.
  await item(2).click();
  await page.click("#page-hold");
  m = await memos();
  check(m.join(",") === "メモ1,メモ3,メモ4,メモ5,メモ6", `保留 takes page 2 out (${m.join(",")})`);
  await wb(() => window.nameStudio.workbench.docks.open("held"));
  await page.waitForTimeout(100);
  check(await page.locator("#side-held .held-pages").isVisible(), "and the 保留 list shows it");
  if (shots) await page.screenshot({ path: `${shots}/held-pages.png` });
  await page.locator("#side-held .held-pages button", { hasText: "元の場所に戻す" }).click();
  m = await memos();
  check(m.join(",") === "メモ1,メモ2,メモ3,メモ4,メモ5,メモ6", `元の場所に戻す puts it back (${m.join(",")})`);
  check((await wb(() => window.nameStudio.workbench.project.pages[1].panels.length)) === 1, "with what was on it");

  // Copy and paste.
  await wb(() => window.nameStudio.workbench.docks.open("pages"));
  await item(1).click();
  await page.keyboard.press("Control+c");
  await item(6).click();
  await page.keyboard.press("Control+v");
  m = await memos();
  check(m.length === 7 && m[6] === "メモ1", `Ctrl+V pastes the copied page behind the picked one (${m.join(",")})`);
  await wb(() => window.nameStudio.workbench.undo());

  // Alt+↓ moves the page.
  await item(1).click();
  await page.keyboard.press("Alt+ArrowDown");
  m = await memos();
  check(m[0] === "メモ2" && m[1] === "メモ1", `Alt+↓ moves page 1 behind page 2 (${m.slice(0, 3).join(",")})`);
  await wb(() => window.nameStudio.workbench.undo());

  // From anywhere: the commands.
  await wb(() => window.nameStudio.workbench.editor.showPage(3));
  before = (await memos()).length;
  check(await wb(() => window.nameStudio.workbench.run("page.duplicate")), "「ページを複製」 as a command");
  check((await memos()).length === before + 1, "adds a page");
  await wb(() => window.nameStudio.workbench.undo());

  // The story band's pages: the same menu.
  await page.waitForTimeout(300);
  const opened = await wb(() => {
    const card = document.querySelectorAll(".board-page")[4];
    if (!card) return false;
    const box = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 10, clientY: box.top + 10 }));
    return true;
  });
  check(opened, "the story band shows the pages");
  if (opened) {
    check(await page.locator(".popup-menu").isVisible(), "right click on a page in the story band opens the page menu");
    await page.keyboard.press("Escape");
    check(!(await page.locator(".popup-menu").count()), "Escape closes it");
  }

  // Delete on the canvas after the list is the canvas's.
  await item(2).click();
  const canvas = await page.locator("#editor-canvas").boundingBox();
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + 30);
  before = (await memos()).length;
  await page.keyboard.press("Delete");
  check((await memos()).length === before, "Delete after pressing on the canvas does not delete pages");

  // Never every page.
  await page.locator("#side-pages").focus();
  await page.keyboard.press("Control+a");
  check((await page.locator("#side-pages .page-item.picked").count()) === 6, "Ctrl+A picks every page");
  check(await page.locator("#page-delete").isDisabled(), "and then 削除 cannot be pressed (one page stays)");
  check(errors.length === 0, `no page errors ${errors.join(" / ")}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\npages checked");

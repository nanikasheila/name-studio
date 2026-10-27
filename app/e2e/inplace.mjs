// Writing on the page itself: a double-click on dialogue or inside a panel
// opens a field right there; Ctrl+Enter keeps what was written as one undo
// step, Esc puts it back. Run: npm run e2e:inplace
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1439, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  // A page with one panel and one line of dialogue in it.
  const where = await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const { addPanel } = await import("/src/panels.ts");
    const { addLine } = await import("/src/dialogue.ts");
    const { rectShape } = await import("/src/geometry.ts");
    const project = newProject("その場で書く", 4);
    const first = project.pages[0];
    const panel = addPanel(project, first, rectShape([20, 20, 200, 160]));
    const line = addLine(project, first, [150, 50], "セリフ");
    line.panel = panel.id;
    window.nameStudio.show(project);
    // Once the pages have slid into place.
    await new Promise((done) => setTimeout(done, 400));
    const editor = window.nameStudio.workbench.editor;
    const [x0, y0, x1, y1] = line.box;
    return { pageId: first.id, line: editor.clientOf(first.id, [(x0 + x1) / 2, (y0 + y1) / 2]), inside: editor.clientOf(first.id, [60, 120]) };
  });
  const state = () =>
    page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      const first = wb.project.pages[0];
      return { text: first.lines[0].text, note: first.panels[0].note ?? null, undo: wb.session.history.undoStack.length, dirty: wb.dirty };
    });
  const status = () => page.locator("#status").textContent();
  const before = await state();

  await page.mouse.dblclick(...where.line);
  const field = page.locator("textarea.inline-edit");
  check((await field.count()) === 1 && (await field.getAttribute("class")).includes("line"), "a double-click on dialogue opens a field over it");
  check((await status()).startsWith("セリフを書いています"), "and the status says how to finish");
  check((await field.inputValue()) === "セリフ" && (await field.evaluate((f) => f.selectionStart === 0 && f.selectionEnd === 3)), "the placeholder text is picked, to type over");
  await page.keyboard.type("こんにちは");
  check((await state()).text === "こんにちは", "the page follows each key");
  await page.keyboard.press("Control+Enter");
  let after = await state();
  check((await field.count()) === 0, "Ctrl+Enter closes the field");
  check(after.text === "こんにちは" && after.undo === before.undo + 1 && after.dirty, "and keeps what was written as one undo step");
  check((await status()) === "セリフを直しました", "the status says so");

  // Off the dialogue first: its action bar sits beside it.
  await page.locator("#editor-canvas").click({ position: { x: 5, y: 5 } });
  await page.mouse.dblclick(...where.inside);
  check((await field.count()) === 1 && (await field.getAttribute("class")).includes("note"), "a double-click inside a panel opens its memo");
  check((await field.getAttribute("placeholder")).startsWith("このコマのメモ"), "with a hint of what goes there");
  await page.keyboard.type("引きの絵");
  check((await state()).note === "引きの絵", "the memo shows as it is typed");
  await page.keyboard.press("Escape");
  after = await state();
  check((await field.count()) === 0 && after.note === null, "Esc puts it back");
  check(after.undo === before.undo + 1, "with no undo step");

  await page.mouse.dblclick(...where.inside);
  await page.keyboard.type("間を長く");
  // A click elsewhere keeps it, as Ctrl+Enter does.
  await page.locator("#status").click();
  after = await state();
  check((await field.count()) === 0 && after.note === "間を長く" && after.undo === before.undo + 2, "a click elsewhere keeps the memo");

  await page.locator("#editor-canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  check((await state()).note === null, "Ctrl+Z takes the memo back");
  await page.keyboard.press("Control+z");
  check((await state()).text === "セリフ", "and then the dialogue");

  // The text tool on an empty spot: a new line and a field in it, one step together.
  const lines = () => page.evaluate(() => window.nameStudio.workbench.project.pages[0].lines.length);
  const undos = () => page.evaluate(() => window.nameStudio.workbench.session.history.undoStack.length);
  const [count, steps] = [await lines(), await undos()];
  await page.evaluate(() => window.nameStudio.workbench.setTool("text"));
  await page.mouse.click(where.inside[0], where.inside[1] + 40);
  await field.waitFor({ timeout: 2000 }).catch(() => undefined);
  check((await field.count()) === 1 && (await lines()) === count + 1, "the text tool places a line and opens a field in it");
  await page.keyboard.press("Escape");
  check((await field.count()) === 0 && (await lines()) === count && (await undos()) === steps, "Esc takes the new line away again, with no undo step");
  await page.mouse.click(where.inside[0], where.inside[1] + 40);
  await field.waitFor({ timeout: 2000 }).catch(() => undefined);
  await page.keyboard.type("やあ");
  await page.keyboard.press("Control+Enter");
  check((await lines()) === count + 1 && (await undos()) === steps + 1, "written and kept, the line is one undo step");
  await page.locator("#editor-canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  check((await lines()) === count, "which Ctrl+Z takes back whole");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

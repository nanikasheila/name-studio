// The command palette as a person uses it: Ctrl+K, a few letters, Enter. The
// key settings list the same commands. Run: npm run e2e:palette
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1434, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    window.nameStudio.show(newProject("パレット", 8));
  });
  await page.waitForTimeout(300);
  const palette = page.locator("#command-palette");
  const input = palette.locator("input");
  const wb = (expression) => page.evaluate(expression);

  await page.keyboard.press("Control+k");
  check(await palette.evaluate((d) => d.open), "Ctrl+K opens the palette");
  check(await input.evaluate((i) => i === document.activeElement), "the search field has the focus");
  const all = await palette.locator(".cmdp-item").count();
  check(all > 60, `it lists every command (${all})`);

  await input.fill("ぺん");
  check((await palette.locator(".cmdp-item.current .cmdp-label").textContent()) === "ペン", "「ぺん」 finds ペン first");
  await page.keyboard.press("Enter");
  check(!(await palette.evaluate((d) => d.open)), "Enter closes it");
  check((await wb(() => window.nameStudio.workbench.editor.tool)) === "pen", "and takes the pen");

  // A key-less command found by words, run from the palette.
  await page.keyboard.press("Control+k");
  await input.fill("ページ 足す");
  await page.keyboard.press("Enter");
  check((await wb(() => window.nameStudio.workbench.project.pages.length)) === 9, "「ページ 足す」 adds a page after this one");
  await page.keyboard.press("Control+z");
  check((await wb(() => window.nameStudio.workbench.project.pages.length)) === 8, "undone with Ctrl+Z");

  // The recent one leads next time; arrows choose.
  await page.keyboard.press("Control+k");
  check((await palette.locator(".cmdp-item").first().locator(".cmdp-label").textContent()) === "このページの後ろにページを足す", "the last used command comes first");
  await input.fill("連続");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  check(await wb(() => window.nameStudio.workbench.editor.continuous), "「連続」 shows every page on one canvas");

  // What cannot be done now is greyed and does nothing.
  await page.keyboard.press("Control+k");
  await input.fill("選んだものを消す");
  check(await palette.locator(".cmdp-item.current").evaluate((row) => row.classList.contains("unavailable")), "with nothing selected, 消す is greyed");
  await page.keyboard.press("Enter");
  check(await palette.evaluate((d) => d.open), "and Enter leaves the palette open");
  await page.keyboard.press("Escape");
  check(!(await palette.evaluate((d) => d.open)), "Escape closes it");

  // A button's command presses the button: 設定.
  await page.keyboard.press("Control+k");
  await input.fill("設定…");
  await page.keyboard.press("Enter");
  check(await page.locator("#settings-dialog").evaluate((d) => d.open), "「設定…」 opens the settings");
  await page.keyboard.press("Escape");

  // The key settings list the palette's commands too, so any of them can have a key.
  await page.locator("#shortcuts").click();
  const listed = await page.locator("#shortcut-dialog").textContent();
  check(listed.includes("このページのセリフを並べ直す") && listed.includes("命令を探して実行する"), "the key settings list every command");
  await page.keyboard.press("Escape");

  check(errors.length === 0, `no errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

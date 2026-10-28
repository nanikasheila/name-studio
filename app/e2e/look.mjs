// 画面の見た目 (設定 › 画面の見た目): a theme recolours the screen and not the
// pages; the screen's font and the size of its words; the user's CSS is tried
// for 15 seconds and goes back by itself unless kept, is kept for the next
// start when asked, and Ctrl+Shift+Alt+R puts the look back however the
// screen looks. Started with Shift held, the CSS is left off that time.
// Run: npm run e2e:look
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1474, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  // One storage for the whole run: what is kept is there at the next start.
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: "light" });
  await context.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const page = await context.newPage();
  await page.clock.install();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const start = async () => {
    await page.goto(url);
    await page.waitForFunction(() => window.nameStudio);
    await page.evaluate(async () => {
      const { newProject } = await import("/src/project.ts");
      window.nameStudio.show(newProject("見た目", 2));
    });
    await page.waitForTimeout(200);
  };
  await start();

  /** The colour of `property` on the element, as the screen shows it. */
  const colour = (selector, property) => page.evaluate(([selector, property]) => getComputedStyle(document.querySelector(selector))[property], [selector, property]);
  /** The page's paper, read from the canvas in the middle of the first page. */
  const paper = () =>
    page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      const page = wb.project.pages[0];
      const [x, y] = wb.editor.clientOf(page.id, [page.widthMm ?? 182 / 2, 60]);
      const canvas = document.getElementById("editor-canvas");
      const rect = canvas.getBoundingClientRect();
      const k = canvas.width / rect.width;
      const [r, g, b] = canvas.getContext("2d").getImageData(Math.round((x - rect.left) * k), Math.round((y - rect.top) * k), 1, 1).data;
      return `${r},${g},${b}`;
    });
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const lightBar = await colour(".toolbar", "backgroundColor");
  const lightPaper = await paper();
  check(lightPaper === "255,255,255", `the page is white (${lightPaper})`);

  // --- the settings: 画面の見た目 is one of this PC's kinds, and found by searching ---
  await page.click("#settings");
  await page.fill("#st-search", "ダーク");
  check(await page.locator('.settings-pane[data-pane="look"]').isVisible(), "searching ダーク finds 画面の見た目");
  await page.fill("#st-search", "カスタム CSS");
  check(await page.locator("#st-css").isVisible(), "searching カスタム CSS finds the CSS box");
  await page.fill("#st-search", "");
  await page.locator(".settings-nav-item", { hasText: "画面の見た目" }).click();
  check((await page.locator(".theme-card").count()) === 6, "six themes to choose from");
  check((await page.locator('.theme-card[aria-checked="true"]').textContent()).includes("Windows に合わせる"), "out of the box the theme follows Windows");

  // --- a theme recolours the screen, not the page ---
  await page.locator(".theme-card", { hasText: "暗い" }).click();
  await settle();
  const darkBar = await colour(".toolbar", "backgroundColor");
  check(darkBar === "rgb(42, 41, 38)", `暗い: the bars go dark (${lightBar} → ${darkBar})`);
  check((await colour("#settings-dialog", "backgroundColor")) === "rgb(42, 41, 38)", "暗い: the settings too");
  check((await paper()) === lightPaper, "暗い: the page stays white");
  await page.locator(".theme-card", { hasText: "高コントラスト（黒）" }).click();
  await settle();
  check((await colour(".toolbar", "backgroundColor")) === "rgb(0, 0, 0)" && (await colour("button.primary", "backgroundColor")) === "rgb(255, 212, 0)", "高コントラスト（黒）: black, with yellow for what is chosen");
  check((await paper()) === lightPaper, "高コントラスト: the page stays white");
  // Each sample shows its own theme whatever the window's is.
  const sepiaSample = await colour('.theme-card[data-theme-id="sepia"] .ts-bar', "backgroundColor");
  check(sepiaSample === "rgb(248, 242, 228)", `the sample of 目にやさしい is in its own colours (${sepiaSample})`);
  await page.locator(".theme-card", { hasText: "目にやさしい" }).click();
  await settle();
  check((await colour(".toolbar", "backgroundColor")) === sepiaSample, "目にやさしい: the bars as its sample");

  // --- the screen's words: their size grows, the page's do not ---
  const sizeOf = (selector) => page.evaluate((selector) => Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize), selector);
  const hint = await sizeOf(".tool-hint");
  const status = await sizeOf("#status");
  await page.fill("#st-ui-size", "18");
  await page.locator("#st-ui-size").press("Tab");
  await settle();
  check(Math.abs((await sizeOf(".tool-hint")) - (hint * 18) / 14) < 0.01 && Math.abs((await sizeOf("#status")) - (status * 18) / 14) < 0.01, `18 px: the screen's words grow by 18/14 (${hint} → ${await sizeOf(".tool-hint")})`);
  const railFits = await page.evaluate(() => [...document.querySelectorAll("#editor-tools button")].every((b) => b.scrollWidth <= b.clientWidth + 1));
  check(railFits, "18 px: the tools' names still fit their buttons");
  check((await paper()) === lightPaper, "18 px: the page as it was");
  await page.click("#st-ui-size-reset");
  await settle();
  check(Math.abs((await sizeOf(".tool-hint")) - hint) < 0.01, "初期（14）: back as they were");

  // The screen's font: the name typed is used for the screen (with the app's after it).
  const field = page.locator("#st-ui-font input");
  await field.fill("Noto Serif CJK JP");
  await field.press("Enter");
  check((await colour(".toolbar", "fontFamily")).startsWith('"Noto Serif CJK JP", "Yu Gothic UI"'), "the screen's font is the one chosen, then the app's");
  check((await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.look")).font)) === "Noto Serif CJK JP", "and kept on this computer");
  await page.locator("#st-ui-font .font-clear").click();
  check((await colour(".toolbar", "fontFamily")).startsWith('"Yu Gothic UI"'), "× puts back the app's font");

  // --- the user's CSS: tried, then back by itself ---
  const accentCss = ":root, [data-theme] { --accent: #d0457a; }";
  await page.fill("#st-css", `${accentCss} button {`);
  check((await page.locator("#st-css-note").textContent()).includes("閉じていない {"), "a brace left open is said before it is used");
  await page.fill("#st-css", accentCss);
  const sepiaAccent = await colour("button.primary", "backgroundColor");
  await page.click("#st-css-apply");
  await settle();
  check((await colour("button.primary", "backgroundColor")) === "rgb(208, 69, 122)", "当てて試す: the CSS is on the screen");
  check(await page.locator("#look-trial").isVisible(), "a bar asks to keep it");
  check((await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.look")).cssOn)) === false, "not kept while it is tried");
  await page.clock.runFor(16_000);
  await settle();
  check((await colour("button.primary", "backgroundColor")) === sepiaAccent && !(await page.locator("#look-trial").isVisible()), "not kept in 15 seconds: put back by itself");
  check(!(await page.locator("#st-css-on").isChecked()), "and the box says it is off");
  check((await page.inputValue("#st-css")) === accentCss, "the CSS tried is still in the box, to be put right");

  // Kept when asked, and there at the next start.
  await page.click("#st-css-apply");
  await page.locator("#look-trial button", { hasText: "このままにする" }).click();
  await page.clock.runFor(20_000);
  check((await colour("button.primary", "backgroundColor")) === "rgb(208, 69, 122)", "このままにする: it stays after the 15 seconds");
  await start();
  await settle();
  check((await colour("button.primary", "backgroundColor")) === "rgb(208, 69, 122)" && (await page.evaluate(() => document.documentElement.dataset.theme)) === "sepia", "the next start: the theme and the CSS kept");

  // --- CSS that hides the whole screen: the fixed keys put the look back ---
  await page.evaluate(async () => {
    const { readLook, writeLook } = await import("/src/look.ts");
    writeLook({ ...readLook(), css: "body { display: none !important; }", cssOn: true });
  });
  await start().catch(() => undefined);
  await page.waitForFunction(() => window.nameStudio);
  await settle();
  check(!(await page.locator("#settings").isVisible()), "CSS can hide everything");
  await page.keyboard.press("Control+Shift+Alt+KeyR");
  await settle();
  check(await page.locator("#settings").isVisible(), "Ctrl+Shift+Alt+R: the screen is back");
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.look")));
  check(kept.theme === "system" && kept.cssOn === false && kept.css.includes("display: none"), "the look as it comes, the CSS off but kept");
  check((await colour(".toolbar", "backgroundColor")) === lightBar, "the colours as they come");

  // --- started with Shift held: the CSS left off that time only ---
  await page.evaluate(async () => {
    const { readLook, writeLook } = await import("/src/look.ts");
    writeLook({ ...readLook(), theme: "dark", css: "body { display: none !important; }", cssOn: true });
  });
  await page.evaluate(() => sessionStorage.setItem("safeLook", "1"));
  await context.addInitScript(() => {
    if (sessionStorage.getItem("safeLook")) window.__answer = (command) => (command === "safe_look" ? true : undefined);
  });
  await start();
  await settle();
  check(await page.locator("#settings").isVisible(), "Shift held at the start: the CSS is not on the screen");
  check((await colour(".toolbar", "backgroundColor")) === darkBar, "the theme kept still is");
  check((await page.locator(".alert.warning").textContent()).includes("Shift を押しながら起動したので"), "and it says why");
  check((await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.look")).cssOn)) === true, "what is kept is not changed");
  await page.click("#settings");
  await page.locator(".settings-nav-item", { hasText: "画面の見た目" }).click();
  check((await page.locator("#st-css-note").textContent()).includes("今回は当てていません"), "the settings say the CSS was left off this time");

  // --- Windows に合わせる: with Windows dark, dark; 明るい stays light there ---
  const night = await browser.newContext({ viewport: { width: 1000, height: 700 }, colorScheme: "dark" });
  await night.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const nightPage = await night.newPage();
  await nightPage.goto(url);
  await nightPage.waitForFunction(() => window.nameStudio);
  const nightBar = () => nightPage.evaluate(() => getComputedStyle(document.querySelector(".toolbar")).backgroundColor);
  check((await nightBar()) === darkBar, "Windows に合わせる with Windows dark: the screen is dark");
  await nightPage.evaluate(async () => {
    const { applyLook, DEFAULT_LOOK } = await import("/src/look.ts");
    applyLook({ ...DEFAULT_LOOK, theme: "light" });
  });
  check((await nightBar()) === lightBar, "明るい with Windows dark: light all the same");
  await night.close();

  check(errors.length === 0, `no errors (${errors.join("; ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

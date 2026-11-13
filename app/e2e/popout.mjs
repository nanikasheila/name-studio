// 欄を別のウィンドウへ: a palette taken out into a window of its own (for
// another display) keeps working there — drawn, its buttons and keys acting
// on the name — follows the theme, and comes back when the window closes; the
// window opens where it was left.
// Run: npm run e2e:popout
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1444, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const { addPanel } = await import("/src/domain/panels.ts");
    const { rectShape } = await import("/src/model/geometry.ts");
    const project = newProject("別窓", 2);
    for (const page of project.pages) page.panels = [];
    addPanel(project, project.pages[0], rectShape([30, 40, 230, 160])).id = "p1";
    addPanel(project, project.pages[0], rectShape([30, 170, 230, 330])).id = "p2";
    project.characters = [{ id: "c1", name: "ミオ", color: "#d23c78" }];
    window.nameStudio.show(project);
  });
  await page.waitForTimeout(400);
  const zoom = () => page.evaluate(() => window.nameStudio.workbench.editor.stage.view.zoom);

  // --- the サブビュー out into a window ---
  await page.locator("#tab-subview").click();
  await page.waitForTimeout(200);
  await page.locator('.palette[data-lead="subview"] .palette-menu').click();
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.locator(".popup-menu [role=menuitem]", { hasText: "別のウィンドウへ" }).click(),
  ]);
  await popup.waitForLoadState();
  await page.waitForTimeout(300);
  check((await popup.locator(".palette-window .subview-canvas").count()) === 1, "the サブビュー is in a window of its own");
  check((await page.locator("#dock-right .subview-canvas").count()) === 0, "and out of the main window's palettes");
  check(await page.locator("#tab-subview").evaluate((b) => b.classList.contains("floating")), "its icon shows it is out");
  check((await popup.title()).includes("サブビュー"), `the window is named after it (${await popup.title()})`);
  await popup.setViewportSize({ width: 320, height: 480 });
  await page.waitForTimeout(300);
  if (process.env.SHOT) await popup.screenshot({ path: process.env.SHOT });
  const drawn = await popup.evaluate(() => {
    const canvas = document.querySelector(".subview-canvas");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let white = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 240 && data[i + 1] > 225 && data[i + 2] > 225 && data[i + 3] > 250) white++;
    return { white, width: canvas.clientWidth };
  });
  check(drawn.white > 1000 && drawn.width > 200, `the pages are drawn there, filling it (${JSON.stringify(drawn)})`);
  check(
    await page.evaluate(() => !!window.open("", "namestudio-subview").document.querySelector(".palette-window .subview-canvas")),
    "the window is found again by its name, as it is (e2e/realwalk.mjs looks at it so)",
  );
  check(page.context().pages().length === 2, "and nothing new opens");
  const styled = await popup.evaluate(() => getComputedStyle(document.querySelector(".subview-bar")).display);
  check(styled === "flex", "the main window's styles are there");

  // --- it works from there ---
  const whole = await zoom();
  await popup.locator(".subview-bar button", { hasText: "次のコマ" }).click();
  await page.waitForTimeout(100);
  check((await zoom()) > whole * 1.2, "次のコマ in the window brings the main view to a panel");
  const z1 = await zoom();
  await popup.locator(".subview-canvas").click({ position: { x: 5, y: 5 } });
  await popup.keyboard.press("PageDown");
  await page.waitForTimeout(100);
  check(
    (await page.locator("#status").textContent()).includes("2 コマ目") && (await zoom()) !== 0 && z1 > 0,
    "PageDown pressed in the window goes on to the main window",
  );

  // --- the theme follows ---
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(100);
  check(
    (await popup.evaluate(() => document.documentElement.dataset.theme)) === "dark",
    "a theme changed in the main window shows in the window",
  );
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

  // --- the 人物 list out too: edited there ---
  await page.locator("#tab-cast").click();
  await page.waitForTimeout(200);
  await page.locator('.palette[data-lead="cast"] .palette-menu').click();
  const [castWindow] = await Promise.all([
    page.waitForEvent("popup"),
    page.locator(".popup-menu [role=menuitem]", { hasText: "別のウィンドウへ" }).click(),
  ]);
  await castWindow.waitForLoadState();
  await page.waitForTimeout(200);
  const name = castWindow.locator("input.cast-name").first();
  await name.fill("ミオン");
  await name.press("Enter");
  await page.waitForTimeout(100);
  check(
    (await page.evaluate(() => window.nameStudio.workbench.project.characters[0].name)) === "ミオン",
    "a list out in a window edits the name",
  );
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  check((await castWindow.locator("input.cast-name").first().inputValue()) === "ミオ", "and an undo in the main window shows there");

  // --- closed: back in the palettes, and its place kept ---
  await popup.close();
  await page.waitForTimeout(1300);
  check((await page.locator("#dock-right .subview-canvas").count()) === 1, "closing the window puts the サブビュー back");
  check(!(await page.locator("#tab-subview").evaluate((b) => b.classList.contains("floating"))), "its icon too");
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.paletteWindows")));
  check(
    kept.rects.subview?.w > 100 && !kept.open.includes("subview") && kept.open.includes("cast"),
    `where it was is kept (${JSON.stringify(kept)})`,
  );
  await page.locator("#tab-cast").click();
  await page.waitForTimeout(100);
  check(castWindow.isClosed() === false, "an icon of a palette out brings its window up (it stays)");
  await castWindow.close();
  await page.waitForTimeout(1300);
  check(
    (await page.locator(".dock input.cast-name, #dock-left input.cast-name, #dock-right input.cast-name").count()) >= 1,
    "the 人物 list is back too",
  );

  check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall passed");

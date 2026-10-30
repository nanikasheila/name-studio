// 下の帯のページの並び (設定 › 表示): out of the box page 1 is at the left of
// 物語の帯; "編集画面と同じ" runs the pages of a 右綴じ name from the right as
// the canvas does (every lane with them: scenes, ruler, the frame of the pages
// shown), drags land in reading order, and a 左綴じ name stays left to right.
// Run: npm run e2e:striporder
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1462, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(() => localStorage.setItem("namestudio.storyHeight", JSON.stringify({ strip: 300 })));
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const show = (kind) =>
    page.evaluate(async (kind) => {
      const { newProject } = await import("/src/project.ts");
      const { addScene } = await import("/src/cast.ts");
      const project = newProject("並び", 6, kind);
      addScene(project, project.pages[0].id, project.pages[1].id, "はじまり");
      window.nameStudio.show(project);
      window.nameStudio.workbench.editor.showPage(1);
    }, kind);
  /** The page cards of the strip, left to right: their page numbers. */
  const cards = () =>
    page.evaluate(() => {
      const nodes = [...document.querySelectorAll("#story .board-page")];
      return nodes.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((node) => Number(node.querySelector(".board-page-head span").textContent));
    });
  const box = (selector) => page.evaluate((selector) => {
    const r = document.querySelector(selector)?.getBoundingClientRect();
    return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
  }, selector);
  const cardBox = (number) => page.evaluate((number) => {
    const node = [...document.querySelectorAll("#story .board-page")].find((n) => n.querySelector(".board-page-head span").textContent === String(number));
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }, number);
  const choose = async (order) => {
    await page.evaluate(() => document.getElementById("settings").click());
    await page.locator("#st-search").fill("並び");
    const select = page.locator("#st-strip-order");
    const shown = await select.isVisible();
    const was = await select.inputValue();
    await select.selectOption(order);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await settle();
    return { shown, was };
  };

  await show("right");
  await page.waitForTimeout(300);
  // The strip open (900 px and lower start folded; this window is 1000 px high).
  if (await page.evaluate(() => document.querySelector("#story .story-lanes").hidden)) await page.keyboard.press("Shift+F6");
  await settle();
  check(JSON.stringify(await cards()) === "[1,2,3,4,5,6]", `out of the box page 1 is at the left (${await cards()})`);

  const { shown, was } = await choose("binding");
  check(shown && was === "left", "設定 › 表示 shows the choice (found by 並び), 左から右 at first");
  check((await page.evaluate(() => localStorage.getItem("namestudio.stripOrder"))) === "binding", "編集画面と同じ is kept on this computer");
  check(JSON.stringify(await cards()) === "[6,5,4,3,2,1]", `編集画面と同じ: a 右綴じ name's page 1 is at the right end (${await cards()})`);

  // The scene of pages 1–2 sits over those pages; the frame of the pages shown too.
  const [one, two] = [await cardBox(1), await cardBox(2)];
  const scene = await box("#story rect.scene");
  check(scene && Math.abs(scene.left - two.left) < 8 && Math.abs(scene.right - one.right) < 8, "the scene of pages 1–2 lies over pages 1 and 2");
  const frame = await box("#story .board-current");
  check(frame && frame.left >= two.left - 8 && frame.right <= one.right + 8 && frame.right > one.left, "the frame of the pages shown is over page 1");

  // Page 1 dragged by its number strip to the left of page 3: it goes after page 3 (reading order).
  const ids = () => page.evaluate(() => window.nameStudio.workbench.project.pages.map((p) => p.id));
  const before = await ids();
  const three = await cardBox(3);
  await page.mouse.move(one.left + 20, one.top + 8);
  await page.mouse.down();
  for (let s = 1; s <= 10; s++) await page.mouse.move(one.left + 20 + ((three.left + 2 - one.left - 20) * s) / 10, one.top + 8);
  await page.mouse.up();
  await settle();
  const after = await ids();
  check(JSON.stringify(after) === JSON.stringify([before[1], before[2], before[0], ...before.slice(3)]), "page 1 dragged to the left of page 3 goes after page 3");
  await page.keyboard.press("Control+z");
  await settle();

  // A 左綴じ name runs left to right on the canvas, and so in the strip.
  await show("left");
  await settle();
  await settle();
  check(JSON.stringify(await cards()) === "[1,2,3,4,5,6]", `a 左綴じ name stays left to right (${await cards()})`);

  await choose("left");
  await show("right");
  await settle();
  await settle();
  check(JSON.stringify(await cards()) === "[1,2,3,4,5,6]", "back to 左から右, a 右綴じ name's page 1 is at the left again");
  check(errors.length === 0, `no errors (${errors.join("; ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`${failures.length} failed`);
  process.exit(1);
}

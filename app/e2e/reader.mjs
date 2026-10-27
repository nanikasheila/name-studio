// 読む表示: F5 (or the button) shows the name as the book on the whole
// window, with nothing of the work over it; the keys, a click and the wheel
// turn the pages, Esc goes back to the editor at the spread read last.
// Run: npm run e2e:reader
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1440, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  // 8 pages; page 2 has a panel, a line and a sticky (the sticky is the work's, not the book's).
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const { addPanel } = await import("/src/panels.ts");
    const { addLine } = await import("/src/dialogue.ts");
    const { addSticky } = await import("/src/stickies.ts");
    const { rectShape } = await import("/src/geometry.ts");
    const project = newProject("読む", 8);
    const second = project.pages[1];
    addPanel(project, second, rectShape([20, 20, 160, 120]));
    addLine(project, second, [100, 60], "セリフ");
    addSticky(project, second, [60, 180], "未決のこと");
    window.nameStudio.show(project);
    await new Promise((done) => setTimeout(done, 300));
    window.nameStudio.workbench.editor.showPage(2);
  });
  const reader = page.locator("#reader");
  const caption = () => page.locator("#reader .reader-caption").textContent();
  check(await reader.isHidden(), "reading is not shown at first");

  await page.keyboard.press("F5");
  await page.waitForFunction(() => document.querySelector("#reader .reader-caption")?.textContent);
  check(await reader.isVisible(), "F5 shows the name on the whole window");
  check((await caption()) === "2–3 / 8", "from the spread the editor was on");

  // Ink where the panel's border is, paper (not the sticky's yellow) where the sticky is.
  const pixels = await page.evaluate(async () => {
    const { placeSpread } = await import("/src/reader.ts");
    const { trimBox } = await import("/src/pagebox.ts");
    const project = window.nameStudio.workbench.project;
    const placed = placeSpread(project, [2, 3], window.innerWidth, window.innerHeight).find((p) => p.index === 1);
    const [x0, y0] = trimBox(project.pageFormat);
    const at = ([x, y]) => [placed.left + (x - x0) * placed.scale, placed.top + (y - y0) * placed.scale];
    const canvas = document.querySelector("#reader canvas");
    const ctx = canvas.getContext("2d");
    const ratio = canvas.width / window.innerWidth;
    const rgb = ([x, y]) => [...ctx.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data].slice(0, 3);
    // Darkest pixel along a short run across the border at y = 70 mm.
    const [bx, by] = at([20, 70]);
    let darkest = 255;
    for (let dx = -3; dx <= 3; dx++) darkest = Math.min(darkest, ...rgb([bx + dx, by]));
    return { border: darkest, sticky: rgb(at([66, 186])) };
  });
  check(pixels.border < 120, `the panel border is drawn (darkest ${pixels.border})`);
  check(pixels.sticky.every((v) => v > 245), `the sticky is not (${pixels.sticky})`);

  await page.keyboard.press("ArrowLeft");
  check((await caption()) === "4–5 / 8", "← turns on in a right-bound book");
  await page.keyboard.press("ArrowRight");
  check((await caption()) === "2–3 / 8", "→ turns back");
  await page.keyboard.press("End");
  check((await caption()) === "8 / 8", "End goes to the last page");
  await page.keyboard.press("Home");
  check((await caption()) === "1 / 8", "Home to the first");
  await page.mouse.click(300, 450);
  check((await caption()) === "2–3 / 8", "a click on the left side turns on");
  await page.mouse.click(1100, 450);
  check((await caption()) === "1 / 8", "on the right side, back");
  await page.mouse.move(700, 450);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(50);
  check((await caption()) === "2–3 / 8", "the wheel turns on");
  await page.mouse.wheel(0, 120);
  check((await caption()) === "2–3 / 8", "one turn for one flick of the wheel");
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, 120);
  check((await caption()) === "4–5 / 8", "and on again after it");

  const toolBefore = await page.evaluate(() => window.nameStudio.workbench.editor.tool);
  await page.keyboard.press("e");
  await page.keyboard.press("Tab");
  check(
    (await page.evaluate(() => window.nameStudio.workbench.editor.tool)) === toolBefore && !(await page.evaluate(() => document.body.classList.contains("focus-mode"))),
    "while reading, the editor's keys do nothing",
  );

  await page.keyboard.press("Escape");
  check(await reader.isHidden(), "Esc goes back");
  const shown = await page.evaluate(() => window.nameStudio.workbench.editor.currentPages());
  check(shown.includes(4) && shown.includes(5), `at the spread read last (${shown})`);

  await page.click("#read-mode");
  check(await reader.isVisible(), "the button reads too");
  check((await caption()) === "4–5 / 8", "from where the editor is");
  await page.keyboard.press("F5");
  check(await reader.isHidden(), "F5 again goes back");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nreading checked");

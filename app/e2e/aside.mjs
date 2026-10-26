// 欄外: the room around the pages, driven with the mouse. A sketch with the
// pen and a 付箋 beside the page, a panel held into the 欄外 above its page
// and dragged from there onto the facing page, the eraser in the 欄外, the
// room 連続 keeps between the rows, and undo back to the start.
// Run: npm run e2e:aside (-- --shots <dir> keeps a picture of each step).
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1433, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);

  await page.evaluate(async () => {
    localStorage.clear();
    const { newProject } = await import("/src/project.ts");
    const { addPanel } = await import("/src/panels.ts");
    const { rectShape } = await import("/src/geometry.ts");
    const { addLine } = await import("/src/dialogue.ts");
    const project = newProject("欄外の通しテスト", 4);
    const second = project.pages[1];
    addPanel(project, second, rectShape([20, 20, 240, 150]));
    addPanel(project, second, rectShape([20, 160, 240, 340]));
    const line = addLine(project, second, [200, 60], "ここは保留");
    line.panel = second.panels[0].id;
    window.nameStudio.show(project);
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(2);
    // Room around the spread to work in.
    wb.editor.resetView(0.55);
    wb.editor.draw();
  });
  await page.waitForTimeout(300);

  const tool = (name) => page.evaluate((name) => window.nameStudio.workbench.setTool(name), name);
  const at = (n, mm) => page.evaluate(([n, mm]) => window.nameStudio.workbench.editor.clientOf(window.nameStudio.workbench.project.pages[n - 1].id, mm), [n, mm]);
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function drag(points) {
    await page.mouse.move(...points[0]);
    await page.mouse.down();
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      for (let s = 1; s <= 8; s++) await page.mouse.move(ax + ((bx - ax) * s) / 8, ay + ((by - ay) * s) / 8);
    }
    await page.mouse.up();
    await settle();
  }
  const dragMm = async (n, points) => drag(await Promise.all(points.map((p) => at(n, p))));
  const state = () =>
    page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      const p = wb.project;
      return {
        pages: p.pages.map((pg) => ({ strokes: pg.strokes.map((s) => s.points.map(([x, y]) => [x, y])), stickies: pg.stickies ?? [], panels: pg.panels.length, lines: pg.lines.length })),
        held: p.held ?? [],
        width: p.pageFormat.canvasMm[0],
        height: p.pageFormat.canvasMm[1],
        selection: wb.editor.selection,
        status: document.getElementById("status").textContent,
      };
    });
  let step = 0;
  const shot = async (name) => {
    if (shots) await page.locator("#editor-canvas").screenshot({ path: `${shots}/${String(++step).padStart(2, "0")} ${name}.png` });
  };

  const start = await state();
  const { width: w } = start;
  // Page 2 is the right page of its spread (right binding): its 欄外 is to the right and above.
  await tool("pen");
  await dragMm(2, [
    [w + 15, 60],
    [w + 45, 90],
    [w + 25, 130],
  ]);
  let now = await state();
  const sketch = now.pages[1].strokes[0];
  check(now.pages[1].strokes.length === 1 && sketch.every(([x]) => x > w), "the pen draws in the 欄外 beside page 2, on page 2");
  await shot("sketch beside the page");

  await tool("sticky");
  await page.mouse.click(...(await at(2, [w + 20, 200])));
  await settle();
  now = await state();
  const note = now.pages[1].stickies[0];
  check(!!note && note.at[0] >= w, "a 付箋 put beside the page stays beside it");
  await page.keyboard.press("Escape");

  // Select picks the sketch in the 欄外 and moves it.
  await tool("select");
  await page.evaluate(() => window.nameStudio.workbench.editor.select(null));
  const [sx, sy] = sketch[Math.floor(sketch.length / 2)];
  await dragMm(2, [
    [sx, sy],
    [sx + 5, sy + 40],
  ]);
  now = await state();
  check(now.selection?.kind === "stroke" && Math.abs(now.pages[1].strokes[0][0][1] - sketch[0][1] - 40) < 1, "select picks a line in the 欄外 and moves it there");

  // The 付箋 dragged onto the page lands on it; dragged out, beside it again.
  await page.evaluate(() => window.nameStudio.workbench.editor.select(null));
  await dragMm(2, [
    [note.at[0] + 32, note.at[1] + 5],
    [w - 60, note.at[1] + 5],
  ]);
  now = await state();
  check(now.pages[1].stickies[0].at[0] + 64 <= w + 0.01, "a 付箋 dragged onto the page lies wholly on it");
  const onPage = now.pages[1].stickies[0].at;
  await dragMm(2, [
    [onPage[0] + 32, onPage[1] + 5],
    [w + 22, onPage[1] + 5],
  ]);
  now = await state();
  check(now.pages[1].stickies[0].at[0] >= w - 0.01, "and dragged out mostly, wholly beside it");

  // 保留: the top panel goes to the 欄外 above the page with its dialogue.
  await page.mouse.click(...(await at(2, [60, 100])));
  await settle();
  await page.locator(".action-bar button", { hasText: "保留" }).first().click();
  await settle();
  now = await state();
  const held = now.held[0];
  check(now.pages[1].panels === 1 && now.pages[1].lines === 0, "保留 takes the panel and its dialogue off the page");
  check(!!held?.at && held.at[1] < 0 && held.near === (await page.evaluate(() => window.nameStudio.workbench.project.pages[1].id)), "and lays it in the 欄外 above its page");
  await shot("held above the page");

  // Dragged about in the 欄外, then onto page 3: it is put there.
  const [hx0, hy0] = held.at;
  await dragMm(2, [
    [hx0 + 30, hy0 + 30],
    [hx0 + 10, hy0 - 10],
  ]);
  now = await state();
  check(Math.abs(now.held[0].at[0] - (hx0 - 20)) < 1 && Math.abs(now.held[0].at[1] - (hy0 - 40)) < 1, "a held panel moves about in the 欄外");
  const third = await at(3, [120, 250]);
  const from = await at(2, [hx0 - 20 + 30, hy0 - 40 + 30]);
  await drag([from, [(from[0] + third[0]) / 2, (from[1] + third[1]) / 2], third]);
  now = await state();
  check(now.held.length === 0 && now.pages[2].panels === 1 && now.pages[2].lines === 1, "dragged onto page 3, it is put there with its dialogue");
  check(now.selection?.kind === "panel", "and is selected there");
  await shot("held put on page 3");

  // The eraser works in the 欄外 too.
  await tool("eraser");
  await page.evaluate(() => (window.nameStudio.workbench.editor.eraseMode = "whole"));
  const line = now.pages[1].strokes[0];
  await dragMm(2, [line[0], line[Math.floor(line.length / 2)], line[line.length - 1]]);
  now = await state();
  check(now.pages[1].strokes.length === 0, "the eraser erases a line in the 欄外");
  await page.keyboard.press("Control+z");
  await settle();

  // 連続: the rows keep room for what lies above and beside the pages.
  await tool("select");
  const tight = await page.evaluate(() => {
    const e = window.nameStudio.workbench.editor;
    e.continuous = true;
    e.rows = 2;
    e.fitAll(false);
    e.draw();
    return e.slots.map((s) => [s.index, s.y, s.scale]);
  });
  await shot("連続 with the 欄外");
  const room = await page.evaluate(() => window.nameStudio.workbench.editor.room);
  check(room[1] > 30, `連続 keeps room beside the pages for the sketch and the 付箋 (${room.map((r) => Math.round(r)).join(", ")} mm)`);
  check(tight.length === 4, "every page is laid out");

  // Undo to the start.
  for (let i = 0; i < 20; i++) await page.keyboard.press("Control+z");
  await settle();
  now = await state();
  check(JSON.stringify(now.pages) === JSON.stringify(start.pages) && now.held.length === 0, "undo goes back to the start");
  check(errors.length === 0, `no errors on the page${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall ok");

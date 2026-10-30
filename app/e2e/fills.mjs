// 塗り (G) as CSP's: 塗りつぶし fills the closed area clicked (bounded by the
// rough lines and panel borders, through small gaps with 隙間閉じ, to the
// middle of the lines), a click on a fill gives it the tone in hand, 囲って
// 塗る fills every closed area inside the lasso, 塗り残し部分に塗る the
// sliver brushed over, a closed line inside the area is left as a hole, and
// G again goes to the next way. The fills go under the rough lines. The
// way and its settings are kept.
// Run: npm run e2e:fills
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1438, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: process.env.SHOT ? 3 : 1 });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const project = newProject("塗り", 2);
    const line = (id, corners, closed = true) => ({
      id,
      points: (closed ? [...corners, corners[0]] : corners).map(([x, y]) => [x, y, 1]),
      widthMm: 0.6,
      closed: false,
    });
    const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
    const page = project.pages[0];
    page.panels.push({ id: "panel1", shape: square(30, 30, 160), order: 1 });
    page.strokes.push(
      // A square with a 0.8 mm gap in its top side.
      line("gap", [[60.4, 50], [100, 50], [100, 90], [40, 90], [40, 50], [59.6, 50]], false),
      // A square with a smaller one inside.
      line("outer", square(110, 50, 60)),
      line("inner", square(130, 70, 20)),
      // Two squares side by side, for 囲って塗る.
      line("left", square(40, 110, 25)),
      line("right", square(75, 110, 25)),
      // A square for 塗り残し.
      line("sliver", square(120, 140, 30)),
    );
    page.fills = [{ id: "fill1", shape: [[120, 140], [150, 140], [150, 168.6], [120, 168.6]], tone: "gray" }];
    window.nameStudio.show(project);
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(1);
    wb.editor.fitView();
  });
  await page.waitForTimeout(300);

  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const at = (mm) =>
    page.evaluate((mm) => {
      const wb = window.nameStudio.workbench;
      return wb.editor.clientOf(wb.project.pages[0].id, mm);
    }, mm);
  async function clickMm(mm) {
    const [x, y] = await at(mm);
    await page.mouse.click(x, y);
    await settle();
  }
  async function dragMm(points) {
    const screen = await Promise.all(points.map(at));
    await page.mouse.move(...screen[0]);
    await page.mouse.down();
    for (let i = 1; i < screen.length; i++) {
      const [ax, ay] = screen[i - 1];
      const [bx, by] = screen[i];
      for (let s = 1; s <= 8; s++) await page.mouse.move(ax + ((bx - ax) * s) / 8, ay + ((by - ay) * s) / 8);
    }
    await page.mouse.up();
    await settle();
  }
  const state = () =>
    page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      return {
        tool: wb.editor.tool,
        way: wb.editor.fill.way,
        fills: (wb.project.pages[0].fills ?? []).map((fill) => {
          const xs = fill.shape.map(([x]) => x);
          const ys = fill.shape.map(([, y]) => y);
          return { id: fill.id, tone: fill.tone ?? "black", under: !!fill.under, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], holes: fill.holes?.length ?? 0 };
        }),
        status: document.getElementById("status").textContent,
        hint: document.getElementById("tool-hint").textContent,
      };
    });
  const pixel = async (mm) => {
    const [x, y] = await at(mm);
    return page.evaluate(
      ([x, y]) => {
        const canvas = document.getElementById("editor-canvas");
        const box = canvas.getBoundingClientRect();
        const ratio = canvas.width / box.width;
        const data = canvas.getContext("2d").getImageData(Math.round((x - box.left) * ratio), Math.round((y - box.top) * ratio), 1, 1).data;
        return [data[0], data[1], data[2]];
      },
      [x, y],
    );
  };
  const dark = ([r, g, b]) => r < 80 && g < 80 && b < 80;
  const light = ([r, g, b]) => r > 220 && g > 220 && b > 220;
  const newest = (s, before) => s.fills.filter((fill) => !before.fills.some((old) => old.id === fill.id));

  // G: the fill tool; its bar shows the ways and, for 投げなわ塗り, the tones only.
  await page.keyboard.press("g");
  await settle();
  let s = await state();
  check(s.tool === "fill" && s.way === "lasso", `G takes up 塗り, 投げなわ塗り to begin with (${s.tool}, ${s.way})`);
  check(await page.isVisible("#fill-click") && !(await page.isVisible("#fill-gap")), "the bar shows the ways and no 隙間閉じ for 投げなわ塗り");
  await page.keyboard.press("g");
  await settle();
  check((await state()).way === "remaining", "G again: the next way (塗り残し部分に塗る)");

  // 塗りつぶし with 隙間閉じ しない: the gap lets it out over the panel.
  await page.click("#fill-click");
  await settle();
  check(await page.isVisible("#fill-gap") && await page.isVisible("#fill-center"), "塗りつぶし shows 隙間閉じ and 線の中心まで");
  check((await state()).hint.includes("閉じた範囲"), "the hint says what 塗りつぶし does");
  await page.selectOption("#fill-gap", "0");
  let before = await state();
  await clickMm([70, 70]);
  s = await state();
  let made = newest(s, before);
  check(made.length === 1 && made[0].box[2] - made[0].box[0] > 100, `without 隙間閉じ the fill goes out through the gap, as far as the panel (${JSON.stringify(made[0]?.box)})`);
  await page.keyboard.press("Control+z");
  await settle();
  check((await state()).fills.length === before.fills.length, "Ctrl+Z takes it back");

  // 隙間閉じ 中 (1 mm): the square only, to the middle of its line.
  await page.selectOption("#fill-gap", "1");
  before = await state();
  await clickMm([70, 70]);
  s = await state();
  made = newest(s, before);
  const box = made[0]?.box ?? [0, 0, 0, 0];
  check(made.length === 1 && Math.abs(box[0] - 40) < 0.4 && Math.abs(box[2] - 100) < 0.4 && Math.abs(box[1] - 50) < 0.6 && Math.abs(box[3] - 90) < 0.4, `隙間閉じ: the square, to the middle of its line (${JSON.stringify(box)})`);
  check(dark(await pixel([70, 70])), "the area is black on the page");

  // A click on the fill with グレー in hand: it turns grey.
  await page.click("#fill-gray");
  await clickMm([70, 70]);
  s = await state();
  check(s.fills.find((fill) => fill.id === made[0]?.id)?.tone === "gray" && s.fills.length === before.fills.length + 1, `a click on a fill gives it the tone in hand (${s.status})`);
  // Under the rough lines: the line shows over the grey along its whole width.
  check(made[0]?.under === true, "塗りつぶし goes under the rough lines");
  const [onLine, inside] = [await pixel([40, 70]), await pixel([70, 70])];
  check(onLine[0] < inside[0] - 25, `the line shows over the fill that reaches its middle (${onLine} on the line, ${inside} inside)`);
  await page.click("#fill-black");

  // Round a closed line inside: a hole, white on the page.
  before = await state();
  await clickMm([115, 55]);
  s = await state();
  made = newest(s, before);
  check(made.length === 1 && made[0].holes === 1, `the square inside is a hole (${JSON.stringify(made)})`);
  check(dark(await pixel([120, 60])) && light(await pixel([140, 80])), "black round the hole, white in it");

  // 囲って塗る: both squares, not what is round them.
  await page.click("#fill-enclose");
  before = await state();
  await dragMm([[35, 105], [105, 105], [105, 140], [35, 140], [35, 106]]);
  s = await state();
  made = newest(s, before);
  check(made.length === 1 || made.length === 2, `囲って塗る fills the closed squares inside (${made.length}: ${s.status})`);
  check(dark(await pixel([52, 122])) && dark(await pixel([87, 122])) && !dark(await pixel([70, 105.5])), "both squares black, nothing between them outside");

  // 塗り残し部分に塗る: the sliver under the grey fill.
  await page.click("#fill-remaining");
  await page.click("#fill-gray");
  before = await state();
  await dragMm([[122, 169.4], [148, 169.4]]);
  s = await state();
  made = newest(s, before);
  check(made.length === 1 && made[0].box[1] > 167.5 && made[0].box[3] < 171, `塗り残し: the sliver between the fill and the line (${JSON.stringify(made[0]?.box)}, ${s.status})`);

  // The サブツール palette: the four ways, the one in hand marked, its settings, kept in step with the bar.
  const panel = page.locator("#side-subtools");
  check((await panel.locator(".subtool-row .subtool-name").allTextContents()).join("/") === "塗りつぶし/囲って塗る/投げなわ塗り/塗り残し部分に塗る", "サブツール lists the four ways");
  check((await panel.locator(".subtool-row.current .subtool-name").textContent()) === "塗り残し部分に塗る", "the way in hand is marked there");
  await panel.locator(".subtool-row", { hasText: "囲って塗る" }).click();
  await settle();
  check((await state()).way === "enclose" && (await page.locator("#fill-enclose").getAttribute("class")).includes("active"), "a click on a row takes that way up, and the bar follows");
  await panel.locator(".subtool-field", { hasText: "隙間閉じ" }).locator("select").selectOption("2");
  await settle();
  check((await page.locator("#fill-gap").inputValue()) === "2", "a setting changed in the palette shows on the bar");
  await page.selectOption("#fill-gap", "0.5");
  await settle();
  check((await panel.locator(".subtool-field", { hasText: "隙間閉じ" }).locator("select").inputValue()) === "0.5", "and the other way round");
  const drawn = await panel.locator(".subtool-row", { hasText: "囲って塗る" }).locator("canvas").evaluate((canvas) => {
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink++;
    return ink;
  });
  check(drawn > 50, `each row has a small picture of the way (${drawn} px)`);
  await panel.locator(".subtool-row", { hasText: "塗り残し部分に塗る" }).click();

  // Kept on this computer.
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.fill") ?? "null"));
  check(kept?.way === "remaining" && kept?.tone === "gray" && kept?.options?.click?.gapMm === 1, `the way and settings are kept (${JSON.stringify(kept)?.slice(0, 80)})`);

  if (process.env.FULL) await page.screenshot({ path: process.env.FULL });
  if (process.env.SHOT) {
    const [x0, y0] = await at([30, 40]);
    const [x1, y1] = await at([180, 180]);
    await page.screenshot({ path: process.env.SHOT, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
  }
  check(errors.length === 0, `no errors in the page (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall ok");

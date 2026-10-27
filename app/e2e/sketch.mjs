// なぐり描きのコマ割り: panels drawn by hand with the mouse, as on paper. A
// line across an empty page cuts its 基本枠, a line across a panel cuts it,
// boxes drawn round on another page become 仮のコマ, a scribble over a gutter
// joins two panels, 整える makes the page exact (gutters as set, edges on the
// frame), and undo goes back. The 仮のコマ are drawn in pencil.
// Run: npm run e2e:sketch (-- --shots <dir> keeps a picture of each step).
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: shots ? 2 : 1 });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);

  await page.evaluate(async () => {
    localStorage.clear();
    localStorage.setItem("namestudio.tourSeen", JSON.stringify({ editor: true, start: true }));
    const { newProject } = await import("/src/project.ts");
    const project = newProject("仮のコマ割りの通しテスト", 2);
    window.nameStudio.show(project);
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(1);
    wb.editor.draw();
  });
  await page.waitForTimeout(300);

  const at = (n, mm) => page.evaluate(([n, mm]) => window.nameStudio.workbench.editor.clientOf(window.nameStudio.workbench.project.pages[n - 1].id, mm), [n, mm]);
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // A line drawn by hand: through the points, a little wavy.
  async function draw(n, points, wobble = 0.8) {
    const screen = await Promise.all(points.map((p) => at(n, p)));
    await page.mouse.move(...screen[0]);
    await page.mouse.down();
    let k = 0;
    for (let i = 1; i < screen.length; i++) {
      const [ax, ay] = screen[i - 1];
      const [bx, by] = screen[i];
      for (let s = 1; s <= 12; s++) {
        const off = Math.sin(++k * 1.7) * wobble;
        await page.mouse.move(ax + ((bx - ax) * s) / 12 + off, ay + ((by - ay) * s) / 12 - off);
      }
    }
    await page.mouse.up();
    await settle();
  }
  const panels = (n) =>
    page.evaluate((n) => window.nameStudio.workbench.project.pages[n - 1].panels.map((p) => ({ id: p.id, draft: !!p.draft, shape: p.shape, open: p.openEdges ?? [] })), n);
  const box = (shape) => [Math.min(...shape.map((p) => p[0])), Math.min(...shape.map((p) => p[1])), Math.max(...shape.map((p) => p[0])), Math.max(...shape.map((p) => p[1]))];
  const status = () => page.evaluate(() => document.getElementById("status").textContent);
  let step = 0;
  const shot = async (name) => {
    if (shots) await page.locator("#editor-canvas").screenshot({ path: `${shots}/${String(++step).padStart(2, "0")} ${name}.png` });
  };

  // コマ割り → 描く from the options row.
  await page.locator("#tool-cut").click();
  await page.locator("#panel-sketch").click();
  check(await page.evaluate(() => window.nameStudio.workbench.editor.panelMode === "sketch"), "描く is chosen from the options row");
  check(await page.locator("#panel-tidy").isVisible(), "整える is in the options row with コマ割り");

  // Page 1, empty: a line across cuts the 基本枠 into two 仮のコマ.
  await draw(1, [[50, 180], [150, 182], [248, 179]]);
  let now = await panels(1);
  check(now.length === 2 && now.every((p) => p.draft), "a line across an empty page cuts its 基本枠 into two 仮のコマ");
  // Then the top one cut again, upright and wobbly.
  await draw(1, [[150, 70], [149, 120], [151, 172]]);
  now = await panels(1);
  check(now.length === 3 && now.every((p) => p.draft), "a line across a panel cuts it again");
  await shot("cut by hand");

  // Page 2, empty: three boxes drawn round, loosely.
  await page.evaluate(() => window.nameStudio.workbench.editor.showPage(2));
  await settle();
  const loop = (x0, y0, x1, y1) => [[x0 + 3, y0], [x1 - 2, y0 + 1.5], [x1, y0 + 4], [x1 - 1, y1 - 2], [x1 - 4, y1], [x0 + 2, y1 - 1.5], [x0, y1 - 4], [x0 + 1, y0 + 5], [x0 + 4, y0 + 0.5]];
  await draw(2, loop(60, 77, 146, 160));
  await draw(2, loop(151, 75, 237, 161));
  await draw(2, loop(57, 168, 240, 344));
  let second = await panels(2);
  check(second.length === 3 && second.every((p) => p.draft && p.shape.length === 4), "boxes drawn round become four-cornered 仮のコマ");
  await shot("boxes by hand");

  // A scribble over the gap between the top two joins them; undo brings them back.
  const scribble = [];
  for (let i = 0; i <= 8; i++) scribble.push([148.5 + (i % 2 ? 7 : -7), 110 + i * 2]);
  await draw(2, scribble, 0);
  second = await panels(2);
  check(second.length === 2, "a scribble over a gutter joins the two panels");
  await page.keyboard.press("Control+z");
  await settle();
  second = await panels(2);
  check(second.length === 3, "undo brings the two back");

  // 整える (from the options row): edges on the frame, the gutters as set.
  await page.evaluate(() => window.nameStudio.workbench.editor.select(null));
  await page.locator("#panel-tidy").click();
  await settle();
  second = await panels(2);
  const boxes = second.map((p) => box(p.shape)).sort((a, b) => a[1] - b[1] || b[0] - a[0]);
  const frame = await page.evaluate(async () => {
    const { basicBox } = await import("/src/pagebox.ts");
    return basicBox(window.nameStudio.workbench.project.pageFormat);
  });
  const [right, left, bottom] = boxes;
  check(second.every((p) => !p.draft), "整える makes them no longer 仮");
  check(left[0] === frame[0] && right[2] === frame[2] && right[1] === frame[1] && bottom[3] === frame[3], "the outer edges go onto the 基本枠");
  check(Math.abs(right[0] - left[2] - 2) < 0.01 && Math.abs(bottom[1] - right[3] - 6) < 0.01, "the gutters become the name's (2 mm side by side, 6 mm between rows)");
  check(/整えました/.test(await status()), "and the status line says so");
  await shot("tidied");

  // The 仮のコマ on page 1 are tidied with the command (Shift+K), lined up with nothing left as it was.
  await page.evaluate(() => window.nameStudio.workbench.editor.showPage(1));
  await settle();
  await page.keyboard.press("Shift+K");
  await settle();
  now = await panels(1);
  check(now.every((p) => !p.draft), "Shift+K tidies the page worked on");
  await page.keyboard.press("Control+z");
  await settle();
  now = await panels(1);
  check(now.every((p) => p.draft), "and undo makes them 仮 again");

  // The inspector of a 仮のコマ: marked, with a box to unmark and its own 整える.
  await page.evaluate((id) => {
    const wb = window.nameStudio.workbench;
    wb.setTool("select");
    wb.editor.select({ kind: "panel", pageId: wb.project.pages[0].id, id });
  }, now[0].id);
  await settle();
  check(await page.locator("#inspector h2", { hasText: "（仮）" }).count() === 1, "the inspector names a 仮のコマ");
  await page.locator("#inspector button", { hasText: "整える" }).first().click();
  await settle();
  now = await panels(1);
  check(now.filter((p) => !p.draft).length === 1, "and its 整える tidies that panel alone");

  // 書き出し: the check names the 仮のコマ left and tidies them all.
  await page.locator("#name-export").click();
  await page.waitForTimeout(300);
  const summary = await page.locator("#ne-check-summary").textContent();
  check(/仮のコマ 2/.test(summary ?? ""), "the export's check counts the 仮のコマ left");
  await page.locator("#ne-check").evaluate((d) => (d.open = true));
  await page.locator("#ne-check-list button", { hasText: "仮のコマ" }).click();
  await settle();
  now = await panels(1);
  check(now.every((p) => !p.draft), "and tidies them all at a click");
  await page.keyboard.press("Escape");

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall ok");

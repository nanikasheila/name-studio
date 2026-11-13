// サブビュー (画面分割): the spread whole in a palette, the main view one panel
// at a time — PageDown / PageUp step through the panels, a panel pressed in the
// sub view brings the main view to it, a drag elsewhere moves the view, and
// the sub view mirrors on its own.
// Run: npm run e2e:subview
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1443, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const { addPanel } = await import("/src/domain/panels.ts");
    const { rectShape } = await import("/src/model/geometry.ts");
    const project = newProject("分割", 4);
    for (const page of project.pages) page.panels = [];
    const [first, second] = project.pages;
    addPanel(project, first, rectShape([30, 40, 230, 160])).id = "p1";
    addPanel(project, first, rectShape([30, 170, 230, 330])).id = "p2";
    addPanel(project, second, rectShape([30, 40, 230, 330])).id = "p3";
    window.nameStudio.show(project);
  });
  await page.waitForTimeout(400);
  const status = () => page.locator("#status").textContent();
  /** Where a panel's middle shows in the main view, against the middle of the stage. */
  const offCentre = (pageIndex, id) =>
    page.evaluate(
      ([pageIndex, id]) => {
        const wb = window.nameStudio.workbench;
        const sheet = wb.project.pages[pageIndex];
        const panel = sheet.panels.find((p) => p.id === id);
        const xs = panel.shape.map((p) => p[0]);
        const ys = panel.shape.map((p) => p[1]);
        const at = wb.editor.clientOf(sheet.id, [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
        const rect = document.querySelector("#editor-canvas").getBoundingClientRect();
        return at ? Math.hypot(at[0] - (rect.left + rect.width / 2), at[1] - (rect.top + rect.height / 2)) : 1e9;
      },
      [pageIndex, id],
    );
  const zoom = () => page.evaluate(() => window.nameStudio.workbench.editor.stage.view.zoom);
  /** Where a page point (mm) shows in the sub view (client px). */
  const inSub = (pageIndex, point) =>
    page.evaluate(
      ([pageIndex, [x, y]]) => {
        const sub = window.nameStudio.workbench.subView;
        const fit = sub.fit;
        const slot = fit.slots.find((s) => s.page.id === window.nameStudio.workbench.project.pages[pageIndex].id);
        let sx = fit.dx + (slot.x + x * slot.scale) * fit.k;
        if (sub.flipped) sx = fit.width - sx;
        const rect = document.querySelector(".subview-canvas").getBoundingClientRect();
        return [rect.left + sx, rect.top + fit.dy + (slot.y + y * slot.scale) * fit.k];
      },
      [pageIndex, point],
    );

  // --- the palette ---
  await page.locator("#tab-subview").click();
  await page.waitForTimeout(300);
  const box = await page.locator(".subview-canvas").boundingBox();
  check(box && box.width > 100 && box.height > 150, `the sub view shows in its palette (${box?.width}×${box?.height})`);
  // --- PageDown / PageUp: one panel at a time ---
  const whole = await zoom();
  await page.locator("#editor-canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Escape");
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(100);
  check((await zoom()) > whole * 1.2, `PageDown zooms to a panel (${whole.toFixed(2)} → ${(await zoom()).toFixed(2)})`);
  check((await offCentre(0, "p1")) < 3, "the first panel in the middle");
  check((await status()).includes("1 ページ 1 コマ目"), "the status line names it");
  await page.waitForTimeout(100);
  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector(".subview-canvas");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let white = 0;
    let red = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 250) continue;
      if (data[i] > 235 && data[i + 1] > 225 && data[i + 2] > 225) white++;
      else if (data[i] > 180 && data[i + 1] < 130 && data[i + 2] < 130) red++;
    }
    return { white, red };
  });
  check(
    pixels.white > 1000 && pixels.red > 20,
    `the sub view draws the pages, the red frame of what shows and the panel (${JSON.stringify(pixels)})`,
  );

  await page.keyboard.press("PageDown");
  await page.waitForTimeout(100);
  check((await offCentre(0, "p2")) < 3, "PageDown again: the second panel");
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(100);
  check((await offCentre(1, "p3")) < 3, "and on to the next page's panel");
  await page.keyboard.press("PageUp");
  await page.waitForTimeout(100);
  check((await offCentre(0, "p2")) < 3, "PageUp goes back");

  // --- a panel pressed in the sub view ---
  const p1 = await inSub(0, [130, 100]);
  await page.mouse.click(...p1);
  await page.waitForTimeout(100);
  check((await offCentre(0, "p1")) < 3, "a panel pressed in the sub view brings the main view to it");
  await page.keyboard.press("PageUp");
  check((await status()).includes("最初のコマ"), "PageUp at the first panel says so");

  // --- a drag elsewhere moves the view, its zoom kept ---
  const before = await zoom();
  const margin = await inSub(0, [8, 8]);
  await page.mouse.move(...margin);
  await page.mouse.down();
  const further = await inSub(0, [12, 380]);
  await page.mouse.move(...further, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const moved = await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    const at = wb.editor.clientOf(wb.project.pages[0].id, [12, 380]);
    const rect = document.querySelector("#editor-canvas").getBoundingClientRect();
    return Math.hypot(at[0] - (rect.left + rect.width / 2), at[1] - (rect.top + rect.height / 2));
  });
  check(
    moved < 4 && Math.abs((await zoom()) - before) < 1e-9,
    `a drag in the sub view moves the main view there (${moved.toFixed(1)} px off)`,
  );

  // --- mirrored on its own ---
  await page.locator(".subview-bar label", { hasText: "反転" }).locator("input").check();
  await page.waitForTimeout(100);
  check(
    await page.evaluate(
      () => localStorage.getItem("namestudio.subviewFlipped") === "1" && !window.nameStudio.workbench.editor.stage.view.flipped,
    ),
    "反転 mirrors the sub view alone, and is kept",
  );
  const p2 = await inSub(0, [130, 250]);
  await page.mouse.click(...p2);
  await page.waitForTimeout(100);
  check((await offCentre(0, "p2")) < 3, "mirrored, pressing a panel still finds it");

  // --- 全体 ---
  await page.locator(".subview-bar button", { hasText: "全体" }).click();
  await page.waitForTimeout(100);
  check(Math.abs((await zoom()) - whole) < 0.01, "全体 shows the whole spread again");

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

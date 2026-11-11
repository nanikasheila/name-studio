// The page editor's view: the wheel zooms about the pointer, Space + drag, Ctrl +
// drag and the middle button move the pages with the hand, - and ^ turn the view, and a point of a page stays
// where it is on screen through all of it. Run: npm run e2e:view
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const near = (a, b, tolerance = 0.6) => a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) < tolerance;

const server = await createServer({ root, logLevel: "error", server: { port: 1438, strictPort: false } });
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
    const { newProject } = await import("/src/domain/project.ts");
    window.nameStudio.show(newProject("表示", 8));
  });
  await page.waitForTimeout(300);
  const box = await page.locator("#editor-canvas").boundingBox();
  const middle = [box.x + box.width / 2, box.y + box.height / 2];
  const under = (client) => page.evaluate(([x, y]) => window.nameStudio.workbench.editor.pageAtClient(x, y)?.point ?? null, client);
  const onScreen = (pageId, point) => page.evaluate(([id, p]) => window.nameStudio.workbench.editor.clientOf(id, p), [pageId, point]);
  const pageId = await page.evaluate(
    ([x, y]) => window.nameStudio.workbench.editor.pageAtClient(x, y)?.page.id ?? null,
    [middle[0] - 120, middle[1]],
  );
  check(pageId !== null, "a page is under the middle of the stage");

  const target = [middle[0] - 120, middle[1] - 80];
  const before = await under(target);
  await page.mouse.move(...target);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(100);
  const zoomed = await under(target);
  check(near(zoomed, before), `the wheel zooms about the pointer: the point under it stays (${before} → ${zoomed})`);

  await page.locator("#editor-canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Escape");
  for (let i = 0; i < 3; i++) await page.keyboard.press("-");
  await page.waitForTimeout(100);
  const status = await page.locator("#status").textContent();
  check(/画面を -?\d+° 回しています/.test(status), `- turns the view (${status})`);
  const point = await under(target);
  check(point !== null, "a page is still under the pointer after turning");
  check(near(await onScreen(pageId, point), target), "and the page point maps back to the same place on screen");

  const handFrom = [middle[0] - 60, middle[1] + 40];
  const held = await under(handFrom);
  await page.mouse.move(...handFrom);
  await page.keyboard.down(" ");
  await page.mouse.down();
  await page.mouse.move(handFrom[0] + 40, handFrom[1] + 25, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up(" ");
  await page.waitForTimeout(100);
  check(near(await under([handFrom[0] + 40, handFrom[1] + 25]), held, 1), "Space + drag moves the pages with the hand, turned or not");

  // Ctrl + drag moves the pages too, whatever the tool (here the pen: nothing is drawn).
  const strokes = () => page.evaluate(() => window.nameStudio.workbench.project.pages.reduce((n, p) => n + (p.strokes?.length ?? 0), 0));
  const strokesBefore = await strokes();
  await page.keyboard.press("p");
  const ctrlFrom = [middle[0] - 40, middle[1] + 20];
  const ctrlHeld = await under(ctrlFrom);
  await page.mouse.move(...ctrlFrom);
  await page.keyboard.down("Control");
  await page.waitForTimeout(50);
  const grabbing = await page.locator("#editor-canvas").evaluate((c) => c.style.cursor);
  check(grabbing === "grab", `holding Ctrl over the pages shows the hand (${grabbing})`);
  await page.mouse.down();
  await page.mouse.move(ctrlFrom[0] - 50, ctrlFrom[1] + 30, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  await page.waitForTimeout(100);
  check(near(await under([ctrlFrom[0] - 50, ctrlFrom[1] + 30]), ctrlHeld, 1), "Ctrl + drag moves the pages with the hand");
  check((await strokes()) === strokesBefore, "and the pen draws nothing meanwhile");
  const released = await page.locator("#editor-canvas").evaluate((c) => c.style.cursor);
  check(released !== "grab", `letting Ctrl go puts the tool's cursor back (${released})`);

  // The middle button moves them as before.
  const midFrom = [middle[0] + 30, middle[1] - 10];
  const midHeld = await under(midFrom);
  await page.mouse.move(...midFrom);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(midFrom[0] + 35, midFrom[1] - 20, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  await page.waitForTimeout(100);
  check(near(await under([midFrom[0] + 35, midFrom[1] - 20]), midHeld, 1), "the middle button moves the pages too");

  // Turned off in 設定 › 操作: Ctrl + drag draws with the pen again.
  await page.evaluate(() => {
    window.nameStudio.workbench.editor.ctrlPans = false;
  });
  const offHeld = await under(ctrlFrom);
  await page.mouse.move(...ctrlFrom);
  await page.keyboard.down("Control");
  await page.mouse.down();
  await page.mouse.move(ctrlFrom[0] - 50, ctrlFrom[1] + 30, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  await page.waitForTimeout(100);
  check(near(await under(ctrlFrom), offHeld, 1), "with Ctrl + drag turned off, the pages stay");
  check((await strokes()) === strokesBefore + 1, "and the pen draws");
  await page.evaluate(() => {
    window.nameStudio.workbench.editor.ctrlPans = true;
  });
  await page.keyboard.press("v");

  await page.keyboard.press("Control+0");
  await page.waitForTimeout(100);
  check((await page.locator("#status").textContent()).includes("回転を戻しました"), "Ctrl+0 turns the view upright again");
  const upright = await page.evaluate(([x, y]) => {
    const hit = window.nameStudio.workbench.editor.pageAtClient(x, y);
    return hit && window.nameStudio.workbench.editor.clientOf(hit.page.id, hit.point);
  }, target);
  check(near(upright, target), "upright, points map back too");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

// 物語の帯 folds down to its row of buttons (its button, Shift+F6, a double
// click on its top edge) and opens again as it was; 連続 fits the rows to
// the stage's height, again when it changes size (Tab), and zoomed in keeps
// what was in its middle there; the command palette does not list itself. Run: npm run e2e:band
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1442, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  const show = () =>
    page.evaluate(async () => {
      const { newProject } = await import("/src/project.ts");
      window.nameStudio.show(newProject("帯", 8));
    });
  await show();
  await page.waitForTimeout(300);
  const heights = () =>
    page.evaluate(() => ({
      band: document.getElementById("story").getBoundingClientRect().height,
      stage: document.getElementById("editor-canvas").getBoundingClientRect().height,
      lanes: !document.querySelector("#story .story-lanes").hidden,
    }));
  const open = await heights();
  check(open.lanes && open.band > 100, `the strip starts open (${Math.round(open.band)} px)`);

  await page.locator("#story .story-controls button[aria-pressed]").last().click();
  await page.waitForTimeout(200);
  const folded = await heights();
  check(!folded.lanes && folded.band < 40, `its button folds it to its row of buttons (${Math.round(folded.band)} px)`);
  check(folded.stage > open.stage + 60, `and the pages get the room (${Math.round(open.stage)} → ${Math.round(folded.stage)} px)`);

  await page.locator("#editor-canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+F6");
  await page.waitForTimeout(200);
  const again = await heights();
  check(again.lanes && Math.abs(again.band - open.band) < 2, `Shift+F6 opens it as it was (${Math.round(again.band)} px)`);

  await page.locator("#story-handle").dblclick();
  await page.waitForTimeout(200);
  check(!(await heights()).lanes, "a double click on its top edge folds it");
  // Kept for the next time.
  await page.reload();
  await page.waitForFunction(() => window.nameStudio);
  await show();
  await page.waitForTimeout(300);
  check(!(await heights()).lanes, "still folded after starting again");
  await page.locator("#story-handle").dblclick();
  await page.waitForTimeout(200);
  check((await heights()).lanes, "and a double click opens it");

  // 連続: the rows as tall as the stage, and again after Tab; zoomed in, what is in the middle stays there.
  await page.evaluate(() => window.nameStudio.workbench.bars.setView("continuous"));
  await page.waitForTimeout(500);
  const middleOf = async () => {
    const box = await page.locator("#editor-canvas").boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  /** The pages' height on screen against the stage's. */
  const filled = () =>
    page.evaluate(() => {
      const { editor, project } = window.nameStudio.workbench;
      const [top, bottom] = project.pages.map((p) => [editor.clientOf(p.id, [0, 0]), editor.clientOf(p.id, project.pageFormat.canvasMm)]).find(([a]) => a);
      return (bottom[1] - top[1]) / document.getElementById("editor-canvas").getBoundingClientRect().height;
    });
  const tabbed = async () => {
    await page.locator("#editor-canvas").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(500);
  };
  const one = await filled();
  check(one > 0.75, `連続, 1 row: the pages fill the height (${Math.round(one * 100)} %)`);
  await tabbed();
  const roomier = await filled();
  check(roomier > 0.75, `and still do after Tab (${Math.round(roomier * 100)} %)`);
  await tabbed();
  // Zoomed in: the point of the page nearest the middle is the point kept there.
  await page.evaluate(() => {
    const { editor } = window.nameStudio.workbench;
    editor.view.zoom = 1.6;
    editor.draw();
  });
  const held = await page.evaluate(([cx, cy]) => {
    const { editor, project } = window.nameStudio.workbench;
    const [w, h] = project.pageFormat.canvasMm;
    let best = null;
    for (const p of project.pages) {
      const o = editor.clientOf(p.id, [0, 0]);
      const one = editor.clientOf(p.id, [1, 0]);
      if (!o || !one) continue;
      const scale = one[0] - o[0];
      const point = [(cx - o[0]) / scale, (cy - o[1]) / scale];
      const far = Math.hypot(Math.max(0, -point[0], point[0] - w), Math.max(0, -point[1], point[1] - h));
      if (!best || far < best.far) best = { id: p.id, point, far };
    }
    return best;
  }, await middleOf());
  check(held !== null, `zoomed in, the page nearest the middle (${held && Math.round(held.far)} mm off it)`);
  await tabbed();
  const middle = await middleOf();
  const there = await page.evaluate(([h]) => window.nameStudio.workbench.editor.clientOf(h.id, h.point), [held]);
  const off = there ? Math.hypot(there[0] - middle[0], there[1] - middle[1]) : Infinity;
  check(off < 2, `and the same point is in the middle after Tab gave the stage more room (${Math.round(off)} px off)`);
  await tabbed();

  // The palette does not offer to open itself.
  await page.locator("#editor-canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(150);
  check(await page.locator("#command-palette").evaluate((d) => d.open), "Ctrl+K opens the palette");
  // With nothing typed it lists every command.
  const labels = await page.locator("#command-palette .cmdp-label").allTextContents();
  check(labels.length > 20 && !labels.some((label) => label.includes("命令パレット")), `the palette does not list itself (${labels.length} commands)`);
  await page.keyboard.press("Escape");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

// コマの入れ替えの合わせ方 (設定 › 操作): out of the box the contents spread
// over the panel they go to (wider or taller as it is); "縦横比を保つ" scales
// them all alike, as large as fits, in the middle of the panel. Chosen in the
// settings, it works on a swap (a panel's number dragged onto another) and on
// a 保留 panel dropped into a panel. Run: npm run e2e:swapfit
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const near = (a, b) => Math.abs(a - b) < 0.05;

const server = await createServer({ root, logLevel: "error", server: { port: 1452, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(() => localStorage.setItem("namestudio.storyHeight", JSON.stringify({ strip: 354 })));
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  // Page 2: a wide panel on top with two rough lines far apart, under it a tall panel and a wide-ish one.
  const panels = await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const { addPanel } = await import("/src/panels.ts");
    const { rectShape } = await import("/src/geometry.ts");
    const { basicBox } = await import("/src/pagebox.ts");
    const project = newProject("入れ替えの合わせ方", 3);
    const [x0, y0, x1, y1] = basicBox(project.pageFormat);
    const page = project.pages[1];
    const boxes = { wide: [x0, y0, x1, y0 + 60], tall: [x0, y0 + 66, x0 + 50, y1], rest: [x0 + 56, y0 + 66, x1, y1] };
    const ids = Object.fromEntries(Object.entries(boxes).map(([name, box]) => [name, addPanel(project, page, rectShape(box)).id]));
    page.strokes.push({ id: "a", points: [[x0 + 10, y0 + 10, 1], [x0 + 30, y0 + 10, 1]], widthMm: 0.4 });
    page.strokes.push({ id: "b", points: [[x1 - 30, y0 + 50, 1], [x1 - 10, y0 + 50, 1]], widthMm: 0.4 });
    window.nameStudio.show(project);
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(2);
    // Room above the page for the 欄外, the pages still large enough to show the panels' numbers.
    wb.editor.resetView(0.8);
    wb.editor.draw();
    return { boxes, ids };
  });
  await page.waitForTimeout(300);
  const { boxes, ids } = panels;

  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const at = (mm) => page.evaluate((mm) => window.nameStudio.workbench.editor.clientOf(window.nameStudio.workbench.project.pages[1].id, mm), mm);
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
  /** The two rough lines' centres, and how far apart they are. */
  const lines = () =>
    page.evaluate(() => {
      const strokes = window.nameStudio.workbench.project.pages[1].strokes;
      const centre = (id) => {
        const points = strokes.find((s) => s.id === id).points;
        return [(points[0][0] + points.at(-1)[0]) / 2, (points[0][1] + points.at(-1)[1]) / 2];
      };
      const [a, b] = [centre("a"), centre("b")];
      return { a, b, gap: [b[0] - a[0], b[1] - a[1]] };
    });
  /** The panel's number, where a drag starts a swap. */
  const badge = (id) =>
    page.evaluate((id) => {
      const editor = window.nameStudio.workbench.editor;
      const project = window.nameStudio.workbench.project;
      const slot = editor.slots.find((s) => s.page.id === project.pages[1].id);
      const panel = slot.page.panels.find((p) => p.id === id);
      const { x, y } = window.nameStudio.hittest.panelBadge(slot, panel, project.pageFormat, project.pageFormat.canvasMm[0]);
      return editor.clientOf(slot.page.id, [(x - slot.x) / slot.scale, (y - slot.y) / slot.scale]);
    }, id);
  const centreOf = ([x0, y0, x1, y1]) => [(x0 + x1) / 2, (y0 + y1) / 2];
  const size = ([x0, y0, x1, y1]) => [x1 - x0, y1 - y0];
  const choose = async (fit) => {
    await page.evaluate(() => document.getElementById("settings").click());
    await page.locator("#st-search").fill("縦横比");
    const select = page.locator("#st-swap-fit");
    const shown = await select.isVisible();
    const was = await select.inputValue();
    await select.selectOption(fit);
    // Esc empties the search, the next one closes the settings.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await settle();
    return { shown, was };
  };

  const start = await lines();
  const [ww, wh] = size(boxes.wide);
  const [tw, th] = size(boxes.tall);

  // Out of the box: a swap spreads the contents over the tall panel (the gap stretched apart in x and y).
  await drag([await badge(ids.wide), await at(centreOf(boxes.tall))]);
  let now = await lines();
  check(near(now.gap[0], start.gap[0] * (tw / ww)) && near(now.gap[1], start.gap[1] * (th / wh)), "out of the box, a swap fits the contents to the new panel's width and height");
  await page.keyboard.press("Control+z");
  await settle();

  // Found by searching 縦横比 in the settings; chosen there, kept on this computer.
  const { shown, was } = await choose("keep");
  check(shown && was === "stretch", "設定 › 操作 shows the choice (found by 縦横比), 入れ替え先に合わせる at first");
  check((await page.evaluate(() => localStorage.getItem("namestudio.swapFit"))) === "keep", "縦横比を保つ is kept on this computer");

  // 縦横比を保つ: everything scales alike, as large as fits, in the middle of the tall panel.
  // (Esc first: the action bar of the panel picked by the last swap lies over the top panel's number.)
  await page.keyboard.press("Escape");
  await drag([await badge(ids.wide), await at(centreOf(boxes.tall))]);
  now = await lines();
  let s = Math.min(tw / ww, th / wh);
  check(near(now.gap[0], start.gap[0] * s) && near(now.gap[1], start.gap[1] * s), "with 縦横比を保つ, a swap scales the contents alike (the gap keeps its direction)");
  const mid = (start.a[1] + start.b[1]) / 2 - (boxes.wide[1] + wh / 2);
  check(near((now.a[1] + now.b[1]) / 2, centreOf(boxes.tall)[1] + mid * s), "and puts them in the middle of the panel's height");
  check([now.a, now.b].every(([x, y]) => x > boxes.tall[0] && x < boxes.tall[2] && y > boxes.tall[1] && y < boxes.tall[3]), "inside the panel");
  await page.keyboard.press("Control+z");
  await settle();
  now = await lines();
  check(near(now.a[0], start.a[0]) && near(now.b[1], start.b[1]), "undo puts them back");

  // A 保留 panel dropped into a panel: the same choice.
  await page.mouse.click(...(await at([boxes.wide[0] + 60, boxes.wide[1] + 30])));
  await settle();
  await page.locator(".action-bar button", { hasText: "保留" }).first().click();
  await settle();
  const held = await page.evaluate(() => window.nameStudio.workbench.project.held?.[0]);
  check(!!held?.at, "保留 lays the wide panel in the 欄外");
  const [rw, rh] = size(boxes.rest);
  await drag([await at([held.at[0] + 30, held.at[1] + 30]), await at(centreOf(boxes.rest))]);
  now = await lines();
  s = Math.min(rw / ww, rh / wh);
  check(near(now.gap[0], start.gap[0] * s) && near(now.gap[1], start.gap[1] * s), "a 保留 panel dropped into a panel keeps the 縦横比 too");
  check(near((now.a[0] + now.b[0]) / 2, centreOf(boxes.rest)[0] + ((start.a[0] + start.b[0]) / 2 - centreOf(boxes.wide)[0]) * s), "in the middle of that panel");

  // Back to 入れ替え先に合わせる: the drop stretches again.
  await page.keyboard.press("Control+z");
  await settle();
  await choose("stretch");
  const again = await page.evaluate(() => window.nameStudio.workbench.project.held?.[0]);
  await drag([await at([again.at[0] + 30, again.at[1] + 30]), await at(centreOf(boxes.rest))]);
  now = await lines();
  check(near(now.gap[0], start.gap[0] * (rw / ww)) && near(now.gap[1], start.gap[1] * (rh / wh)), "set back, a dropped 保留 panel is fitted to the panel's width and height");

  check(errors.length === 0, `no errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

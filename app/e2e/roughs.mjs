// ラフ線のレイヤー in the レイヤー palette, with the mouse: add a layer and draw
// on it, pick the layer the pen draws on, lock one (the pen refuses, the
// eraser and the select tool leave its lines), hide one, fade one, move a
// selected line onto a layer, and undo. Run: npm run e2e:roughs
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1434, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    window.nameStudio.show(newProject("ラフ線のレイヤー", 2));
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
  async function dragMm(points) {
    const screen = await Promise.all(points.map(at));
    await page.mouse.move(...screen[0]);
    await page.mouse.down();
    for (let i = 1; i < screen.length; i++) {
      const [ax, ay] = screen[i - 1];
      const [bx, by] = screen[i];
      for (let s = 1; s <= 6; s++) await page.mouse.move(ax + ((bx - ax) * s) / 6, ay + ((by - ay) * s) / 6);
    }
    await page.mouse.up();
    await settle();
  }
  const tool = (name) => page.evaluate((name) => window.nameStudio.workbench.setTool(name), name);
  const state = () =>
    page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      return {
        layers: wb.project.roughLayers ?? null,
        strokes: wb.project.pages[0].strokes.map(({ id, layer }) => ({ id, layer: layer ?? null })),
        active: wb.editor.roughLayer,
        selection: wb.editor.selection,
        status: document.getElementById("status").textContent,
      };
    });
  const row = (id) => page.locator(`.rough-row[data-rough="${id}"]`);

  // The レイヤー palette, with the rough layers at its top.
  if (!(await page.locator("#rough-add").isVisible())) await page.click("#tab-layers-edit");
  await page.waitForSelector("#rough-add", { state: "visible" });
  check((await page.locator(".rough-row").count()) === 1, "one rough layer to begin with");

  await page.click("#rough-add");
  let s = await state();
  const added = s.layers?.[1]?.id;
  check(s.layers?.length === 2 && s.active === added, `a layer is added and the pen draws on it (${s.status})`);

  await tool("pen");
  await dragMm([
    [40, 60],
    [120, 80],
  ]);
  s = await state();
  check(s.strokes.length === 1 && s.strokes[0].layer === added, "the line is on the new layer");

  await row("rough").click();
  await dragMm([
    [40, 120],
    [120, 140],
  ]);
  s = await state();
  check(s.active === "rough" && s.strokes.length === 2 && s.strokes[1].layer === null, "after picking the first layer, the pen draws there");

  // Locked: the pen refuses it, the eraser leaves its lines.
  await row(added).locator(".rough-lock").click();
  s = await state();
  check(s.layers[1].locked === true, "the layer is locked");
  await row(added).click();
  await dragMm([
    [40, 200],
    [120, 220],
  ]);
  s = await state();
  check(s.strokes.length === 2 && s.status.includes("ロック"), `the pen does not draw on a locked layer (${s.status})`);
  await page.evaluate(() => window.nameStudio.workbench.setEraseMode("whole"));
  await tool("eraser");
  // Slowly down across both lines (the eraser takes what it passes over at each move).
  await dragMm(Array.from({ length: 25 }, (_, i) => [80, 40 + i * 5]));
  s = await state();
  check(s.strokes.length === 1 && s.strokes[0].layer === added, `the eraser takes the line on the open layer only (${JSON.stringify(s.strokes)} ${s.status})`);
  await tool("select");
  await dragMm([[80, 70]]);
  s = await state();
  check(s.selection === null, "a line on a locked layer is not picked");

  // Hidden: not shown nor picked; faded: kept in the name.
  await row(added).locator(".rough-lock").click();
  await row(added).locator(".layer-eye").first().click();
  s = await state();
  check(s.layers[1].hidden === true && s.layers[1].locked === undefined, "the layer is hidden and unlocked");
  await dragMm([[80, 70]]);
  check((await state()).selection === null, "a line on a hidden layer is not picked");
  await row(added).locator(".layer-eye").first().click();
  await row(added)
    .locator(".rough-opacity")
    .evaluate((input) => {
      input.value = "50";
      input.dispatchEvent(new Event("change"));
    });
  s = await state();
  check(s.layers[1].opacity === 0.5 && !s.layers[1].hidden, "the layer is shown again at half opacity");
  await page.keyboard.press("Control+z");
  check((await state()).layers[1].opacity === undefined, "undo gives the opacity back");

  // A line picked on the page goes onto the layer picked in the list.
  await tool("pen");
  await row("rough").click();
  await dragMm([
    [40, 250],
    [120, 260],
  ]);
  await tool("select");
  await dragMm([[80, 255]]);
  await row(added).click();
  await page.click("#rough-take");
  s = await state();
  check(
    s.strokes.every((stroke) => stroke.layer === added),
    `the picked line moved onto the layer (${s.status})`,
  );
  check((await row(added).locator(".layer-detail").textContent()) === "2 本", "the list counts its lines");

  // 下と結合.
  await row(added).locator("button[title^='下のレイヤーと結合']").click();
  s = await state();
  check(s.layers === null && s.strokes.every((stroke) => stroke.layer === null), "merged down, the name has one layer again");
  check(errors.length === 0, `no errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

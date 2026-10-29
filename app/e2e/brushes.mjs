// ペン・消しゴムの設定 (設定… on the pen's bar): a pen made new gets CSP's
// settings; a setting changed there changes how the pen draws at once (its
// size, 筆圧 on and off, the pressure graph dragged), the pad redraws with
// it, the search narrows the items, undo brings the setting back, and
// .sut に書き出す sends the CSP rows to the Rust side as they are.
// Run: npm run e2e:brushes   (SHOTS=<folder> keeps pictures of the dialog)
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.SHOTS;
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
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    window.nameStudio.show(newProject("ペン", 2));
    window.__dialogs = [];
    window.__answer = (command) => {
      switch (command) {
        case "plugin:dialog|save":
          return window.__dialogs.shift() ?? null;
        case "csp_tool_locations":
          return { tools: null, materials: null };
        case "write_csp_sub_tool":
          return { missingMaterials: [] };
        default:
          return undefined;
      }
    };
  });
  await page.keyboard.press("p");
  await page.click("#brush-edit");
  check(await page.locator("#brush-editor").evaluate((d) => d.open), "設定… opens the brush settings");
  check((await page.textContent("#be-list")).includes("まだありません"), "with no pen yet it says how to make one");

  await page.click("#be-new");
  const brush = () =>
    page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      const b = wb.project.brushes[0];
      return b && { ...b, inHand: wb.editor.penBrush, width: wb.editor.penWidthMm, columns: Object.keys(b.csp?.settings ?? {}).length };
    });
  let pen = await brush();
  check(pen?.name === "新しいペン" && pen.columns > 10 && pen.inHand === pen.id, "新規 makes a pen with CSP settings and puts it in hand");

  const row = (label) => page.locator(".be-row", { has: page.locator(".be-label", { hasText: new RegExp(`^${label}$`) }) }).first();
  const size = row("ブラシサイズ");
  // CSP keeps the size in pixels: 60 px on a 600 dpi page is 2.54 mm.
  await size.locator('.be-field input[type="number"]').fill("60");
  await size.locator('.be-field input[type="number"]').press("Enter");
  pen = await brush();
  check(Math.abs(pen.sizeMm - 2.54) < 1e-9 && pen.csp.settings.BrushSize === 60 && pen.width === pen.sizeMm, "a size typed in is the pen's size (and the size in hand)");
  check((await size.locator(".be-mm").textContent()) === "= 2.54 mm", "the size shows its mm too");

  const pressure = size.locator(".be-inputs button", { hasText: "筆圧" });
  await pressure.click();
  pen = await brush();
  check(!pen.sizePressure, "筆圧 off: the width no longer follows the pressure");
  await size.locator(".be-inputs button", { hasText: "筆圧" }).click();
  pen = await brush();
  check(!!pen.sizePressure, "筆圧 on again");

  // Drag the graph's middle down: light presses draw thinner.
  const graph = size.locator("canvas.be-graph").first();
  const box = await graph.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8, { steps: 6 });
  await page.mouse.up();
  pen = await brush();
  const middle = pen.sizePressure?.curve?.find(([x]) => x > 0.3 && x < 0.7);
  check(!!middle && middle[1] < 0.35, `dragging the graph bends the pen's pressure curve (${JSON.stringify(pen.sizePressure)})`);

  // The pad draws with the pen as it is set.
  const inked = () =>
    page.evaluate(() => {
      const canvas = document.getElementById("be-pad");
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 128) count++;
      return count;
    });
  const thick = await inked();
  await size.locator('.be-field input[type="number"]').fill("8");
  await size.locator('.be-field input[type="number"]').press("Enter");
  const thin = await inked();
  check(thick > 0 && thin > 0 && thin < thick * 0.5, `the pad's sample lines get thinner with the size (${thick} → ${thin} px)`);
  const pad = await page.locator("#be-pad").boundingBox();
  await page.mouse.move(pad.x + 30, pad.y + 30);
  await page.mouse.down();
  await page.mouse.move(pad.x + 300, pad.y + 120, { steps: 20 });
  await page.mouse.up();
  check((await inked()) > 0 && (await inked()) !== thin, "drawing on the pad shows the line drawn");

  await page.evaluate(() => window.nameStudio.workbench.undo());
  pen = await brush();
  check(pen.csp.settings.BrushSize === 60, "undo brings the size before back");
  check((await size.locator('.be-field input[type="number"]').inputValue()) === "60", "and the settings show it");

  await page.fill("#be-filter", "入り");
  const groups = await page.locator(".be-group > summary").allTextContents();
  check(groups.length >= 1 && groups.every((text) => text.startsWith("入り抜き")), `searching narrows the items (${groups.join(", ")})`);
  await row("入り").locator('input[type="checkbox"]').check();
  // CSP's unit 2 is tens of pixels: 4.8 of them are 2.03 mm.
  await row("入り（長さ指定）").locator('input[type="number"]').fill("4.8");
  await row("入り（長さ指定）").locator('input[type="number"]').press("Enter");
  await row("入り（長さ指定）").locator("select").selectOption("2");
  pen = await brush();
  check(Math.abs(pen.taperInMm - (48 * 25.4) / 600) < 1e-9, `入り 4.8 × 10 px (${pen.taperInMm} mm)`);
  await page.fill("#be-filter", "");
  if (shots) await page.locator("#brush-editor").screenshot({ path: `${shots}/brush-editor.png` });

  await page.evaluate(() => window.__dialogs.push("/tmp/ペン.sut"));
  await page.click("#be-export");
  await page.waitForFunction(() => document.getElementById("be-message").textContent.includes("書き出しました"));
  const written = await page.evaluate(() => window.__calls.find((call) => call.command === "write_csp_sub_tool")?.args);
  check(written?.path === "/tmp/ペン.sut" && written.name === "新しいペン" && written.tool.settings.BrushSize === 60 && written.tool.settings.BrushInLength === 4.8, ".sut に書き出す sends the CSP rows");

  await page.click("#be-duplicate");
  let names = await page.evaluate(() => window.nameStudio.workbench.project.brushes.map((b) => b.name));
  check(names.join() === "新しいペン,新しいペン のコピー", `複製 (${names.join()})`);
  await page.click("#be-delete");
  names = await page.evaluate(() => window.nameStudio.workbench.project.brushes.map((b) => b.name));
  check(names.join() === "新しいペン", "削除");

  await page.click("#be-kind-eraser");
  await page.click("#be-new");
  const eraser = await page.evaluate(() => window.nameStudio.workbench.project.brushes.find((b) => b.kind === "eraser"));
  check(eraser?.erase === "touched" && eraser.csp.node.NodeInputOp === 12, "an eraser made new erases as CSP's vector eraser");
  await row("ベクター消去の方式").locator("select").selectOption("2");
  check((await page.evaluate(() => window.nameStudio.workbench.project.brushes.find((b) => b.kind === "eraser").erase)) === "whole", "its way of erasing is a CSP setting too");
  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}

// ツールプロパティ as its own palette, and the wrench under it (as CSP's): the
// items shown for the sub tool in hand are chosen, ordered, given to every
// pen at once and set back; a right click hides one; a CSP setting shown
// there changes the pen (one undoable step); the 影響元 button opens the
// pen's settings on that item; ブラシサイズ is a palette of its own; and a pen
// written out as .sut carries the items chosen (CSP shows the same).
// Run: npm run e2e:toolprops   (SHOTS=<folder> keeps pictures)
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

const server = await createServer({ root, logLevel: "error", server: { port: 1446, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const { newBrush, base64Of } = await import("/src/domain/cspsettings.ts");
    const { showItemsBytes } = await import("/src/domain/cspshow.ts");
    const project = newProject("ツールプロパティ", 2);
    const g = newBrush("pen", "brush-1", "Gペン");
    // As CSP keeps it: ブラシサイズ・不透明度・表示メニューに従いスナップ and one item not known here.
    g.csp.settings.VariantShowParam = { blob: base64Of(showItemsBytes([1000, 10, 1230, 30])) };
    const maru = newBrush("pen", "brush-2", "丸ペン");
    project.brushes.push(g, maru);
    project.nextId = 10;
    window.nameStudio.show(project);
    window.__dialogs = [];
    window.__answer = (command) => {
      switch (command) {
        case "choose_save":
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
  const list = page.locator("#side-subtools");
  const props = page.locator("#side-toolprops");
  const shown = () => props.locator(".toolprop-item").evaluateAll((items) => items.map((item) => item.dataset.item));

  // A pen taken in from CSP shows what CSP showed for it.
  await list.locator(".subtool-row", { hasText: "Gペン" }).click();
  check(
    (await shown()).join() === "BrushSize,ns:sizePresets,Opacity,BrushEnableSnap",
    `CSP の表示項目 are shown out of the box (${await shown()})`,
  );
  await list.locator(".subtool-row", { hasText: "丸ペン" }).click();
  check((await shown()).join() === "BrushSize,ns:sizePresets,Opacity,FlickerReduction", "a pen of its own: size, opacity, 手ブレ補正");

  // The wrench: check アンチエイリアス.
  await props.locator("#toolprops-wrench").click();
  const dialog = page.locator("#toolprops-dialog");
  check(await dialog.evaluate((d) => d.open), "the wrench opens 出す項目");
  check((await page.textContent("#tp-where")).includes("丸ペン"), "for the pen in hand");
  await page.fill("#tp-filter", "アンチ");
  check((await dialog.locator(".tp-item").count()) >= 1, "the search narrows the items");
  await dialog
    .locator(".tp-item", { hasText: /^アンチエイリアス$/ })
    .locator("input")
    .check();
  check(
    (await shown()).join() === "BrushSize,ns:sizePresets,Opacity,AntiAlias,FlickerReduction",
    "an item checked shows at once, where it comes in CSP's order",
  );
  if (shots) await dialog.screenshot({ path: `${shots}/toolprops-dialog.png` });
  // Dragged to the top.
  await page.fill("#tp-filter", "");
  const rows = dialog.locator(".tp-row");
  const from = await rows.filter({ hasText: "アンチエイリアス" }).boundingBox();
  const to = await rows.first().boundingBox();
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, to.y + 2, { steps: 8 });
  await page.mouse.up();
  check((await shown())[0] === "AntiAlias", "dragged in the order list, it goes first in the palette");
  // ほかのペンにも使う.
  await page.click("#tp-all-kind");
  await page.keyboard.press("Escape");
  await list.locator(".subtool-row", { hasText: "Gペン" }).click();
  check((await shown())[0] === "AntiAlias", "「ほかのペンにも使う」 gives every pen the same items");

  // A CSP setting shown there changes the pen, as one undoable step.
  const anti = props.locator('.toolprop-item[data-item="AntiAlias"] select');
  await anti.selectOption("0");
  const gpen = () => page.evaluate(() => window.nameStudio.workbench.project.brushes.find((b) => b.id === "brush-1"));
  check((await gpen()).csp.settings.AntiAlias === 0, "アンチエイリアス changed in the palette changes the pen");
  await page.keyboard.press("Control+z");
  check((await gpen()).csp.settings.AntiAlias !== 0, "undo brings it back");

  // Right click: hide it.
  await props.locator('.toolprop-item[data-item="AntiAlias"]').click({ button: "right" });
  await page.locator(".popup-menu button", { hasText: "この項目を出さない" }).click();
  check(!(await shown()).includes("AntiAlias"), "right click › この項目を出さない hides it");

  // The 影響元 button opens the settings on that item.
  await props.locator('.toolprop-item[data-item="BrushSize"] .effector-button').click();
  check(await page.locator("#brush-editor").evaluate((d) => d.open), "the 影響元 button opens the pen's settings");
  check((await page.inputValue("#be-filter")) === "ブラシサイズ", "on ブラシサイズ");
  await page.keyboard.press("Escape");

  // .sut: the items chosen go with it (CSP's own it did not know stay).
  await page.click("#brush-edit");
  await page.evaluate(() => window.__dialogs.push("/tmp/G.sut"));
  await page.click("#be-export");
  await page.waitForFunction(() => document.getElementById("be-message").textContent.includes("書き出しました"));
  const items = await page.evaluate(async () => {
    const { parseShowItems } = await import("/src/domain/cspshow.ts");
    const { bytesOf } = await import("/src/domain/cspsettings.ts");
    const call = window.__calls.find((c) => c.command === "write_csp_sub_tool");
    return parseShowItems(bytesOf(call.args.tool.settings.VariantShowParam.blob));
  });
  check(items?.join() === "1000,10,40,30", `the .sut shows in CSP what is shown here (${items})`);
  await page.keyboard.press("Escape");

  // 初めに戻す: Gペン back to CSP's own (the pens' choice set aside for it).
  await props.locator("#toolprops-wrench").click();
  await page.click("#tp-reset");
  check((await shown()).join() === "AntiAlias,BrushSize,ns:sizePresets,Opacity,FlickerReduction", "初めに戻す: back to the pens' items");
  await page.keyboard.press("Escape");

  // ブラシサイズ: a palette of its own.
  await page.evaluate(() => window.nameStudio.workbench.docks.open("brushsize"));
  const sizes = page.locator("#side-brushsize .size-presets.large button");
  check((await sizes.count()) > 5, "ブラシサイズ shows the round buttons, large");
  await sizes.filter({ hasText: /^2$/ }).click();
  check((await page.evaluate(() => window.nameStudio.workbench.editor.penWidthMm)) === 2, "a button there sets the size");

  // 塗り: its own items.
  await page.keyboard.press("g");
  const fill = await shown();
  check(fill.includes("tone") && fill.includes("under"), `塗り shows its tone and settings (${fill})`);
  if (shots) await page.locator(".dock.left").screenshot({ path: `${shots}/toolprops-left.png` });
  check(errors.length === 0, `no page errors ${errors.join("; ")}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

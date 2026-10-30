// サブツールの欄 (the palette beside the pages): the pens and erasers to pick
// at a click, each with a line drawn the way it draws; ツールプロパティ under
// them (the size slider, the round size buttons, opacity, 手ブレ補正); a key
// given to a pen from its row takes that pen up from any tool, and shows in
// キー設定 and Ctrl+K; each pen keeps the size it was last used at; a pen
// taken in another name can be picked (it comes into this one); rows are
// dragged into another order.
// Run: npm run e2e:subtools   (SHOTS=<folder> keeps pictures of the palette)
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

const server = await createServer({ root, logLevel: "error", server: { port: 1439, strictPort: false } });
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
  // A name without pens of its own still lists the plain ones.
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    window.nameStudio.show(newProject("ペンなし", 2));
  });
  check((await page.locator("#side-subtools .subtool-row .subtool-name").allTextContents()).join("/") === "標準のペン", "a name with no pens shows the plain pen");
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const { newBrush } = await import("/src/cspsettings.ts");
    const project = newProject("サブツール", 2);
    const g = newBrush("pen", "brush-1", "Gペン");
    g.sizeMm = 0.6;
    const maru = newBrush("pen", "brush-2", "丸ペン");
    maru.sizeMm = 0.3;
    maru.sizePressure = { min: 0, curve: [[0, 0], [0.6, 0.3], [1, 1]] };
    const kneaded = newBrush("eraser", "brush-3", "硬め");
    project.brushes.push(g, maru, kneaded);
    project.nextId = 10;
    // A pen taken in another name, kept on this computer.
    const other = newBrush("pen", "brush-9", "鉛筆");
    other.source = "CSP: 鉛筆 / 鉛筆";
    other.sizeMm = 1.2;
    localStorage.setItem("name-studio.brushes", JSON.stringify([other]));
    window.nameStudio.show(project);
  });
  const panel = page.locator("#side-subtools");
  check(await panel.isVisible(), "サブツール shows beside the pages out of the box");
  check((await panel.locator(".subtool-tabs button").allTextContents()).join("/") === "ペン/消しゴム", "it has ペン and 消しゴム");
  const names = async () => (await panel.locator(".subtool-row .subtool-name").allTextContents()).join("/");
  check((await names()) === "標準のペン/Gペン/丸ペン/鉛筆", "the plain pen, the name's pens, then one of another name");
  check((await panel.locator(".subtool-group").allTextContents()).includes("ほかのネームで取り込んだもの"), "the other name's pen is under its own heading");
  const inHand = () => page.evaluate(() => ({ tool: window.nameStudio.workbench.editor.tool, brush: window.nameStudio.workbench.editor.penBrush, eraser: window.nameStudio.workbench.editor.eraserBrush, width: window.nameStudio.workbench.editor.penWidthMm, eraserSize: window.nameStudio.workbench.editor.eraserSizeMm }));

  // A click on a row: that pen, with the pen tool.
  await panel.locator(".subtool-row", { hasText: "Gペン" }).click();
  let hand = await inHand();
  check(hand.tool === "pen" && hand.brush === "brush-1" && hand.width === 0.6, "a click takes the pen up with its size");
  check(await panel.locator(".subtool-row.current", { hasText: "Gペン" }).count() === 1, "the pen in hand is marked");
  check((await panel.locator(".subtool-props-title").textContent()) === "Gペン", "ツールプロパティ shows the pen in hand");
  const sample = await panel.locator(".subtool-row", { hasText: "丸ペン" }).locator("canvas").evaluate((canvas) => {
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let inked = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) inked++;
    return inked;
  });
  check(sample > 30, "each row draws a sample line");

  // Size: the round buttons, and the pen keeps the size it was last used at.
  await panel.locator(".size-presets button", { hasText: /^1\.5$/ }).click();
  hand = await inHand();
  check(hand.width === 1.5, "a round size button sets the size");
  check(await panel.locator(".size-presets button.active").textContent() === "1.5", "the size in hand is marked");
  await panel.locator(".subtool-row", { hasText: "丸ペン" }).click();
  check((await inHand()).width === 0.3, "another pen comes at its own size");
  await page.keyboard.press("]");
  const bigger = (await inHand()).width;
  check(bigger > 0.3, "] makes it thicker");
  await panel.locator(".subtool-row", { hasText: "Gペン" }).click();
  check((await inHand()).width === 1.5, "back to Gペン: the size it was last used at");
  await panel.locator(".subtool-row", { hasText: "丸ペン" }).click();
  check((await inHand()).width === bigger, "and 丸ペン its own last size");

  // The slider follows the pen in hand.
  const slider = panel.locator('.subtool-props input[type="range"]').first();
  await slider.evaluate((input) => {
    input.value = "900";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  check((await inHand()).width > 5, "the size slider sets a size along its ratio scale");
  await page.locator(".size-presets button", { hasText: /^0\.5$/ }).click();
  await panel.locator(".size-presets button.add").click();
  check(await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.sizePresets")).pen.includes(0.5)), "＋ keeps the size among the round buttons");

  // Opacity and 手ブレ補正 change the pen (one undoable step), and its CSP rows with it.
  const opacity = panel.locator(".subtool-field", { hasText: "不透明度" }).locator("input");
  await opacity.evaluate((input) => {
    input.value = "40";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const maru = () => page.evaluate(() => window.nameStudio.workbench.project.brushes.find((b) => b.id === "brush-2"));
  let brush = await maru();
  check(brush.opacity === 0.4 && brush.csp.settings.Opacity === 40, "不透明度 changes the pen and its CSP setting");
  await page.keyboard.press("Control+z");
  brush = await maru();
  check(brush.opacity === 1, "undo brings it back");

  // A key from the row: press ⌨, then the key.
  await panel.locator(".subtool-row", { hasText: "Gペン" }).locator(".subtool-key").click();
  check(await panel.locator(".subtool-row.waiting").count() === 1, "⌨ waits for a key");
  await page.keyboard.press("1");
  check((await panel.locator(".subtool-row", { hasText: "Gペン" }).locator(".subtool-key").textContent()) === "1", "the key shows on the row");
  await page.keyboard.press("v");
  check((await inHand()).tool === "select", "V: the select tool");
  await page.keyboard.press("1");
  hand = await inHand();
  check(hand.tool === "pen" && hand.brush === "brush-1", "1 takes Gペン up from any tool");
  // The eraser too, with Shift.
  await panel.locator(".subtool-tabs button", { hasText: "消しゴム" }).click();
  check((await names()) === "標準の消しゴム/硬め", "the 消しゴム tab lists the erasers");
  await panel.locator(".subtool-row", { hasText: "硬め" }).click({ button: "right" });
  await page.locator(".subtool-menu button", { hasText: "キーを割り当てる" }).click();
  await page.keyboard.press("2");
  await page.keyboard.press("1");
  check((await inHand()).brush === "brush-1", "keys stay with their pens");
  await page.keyboard.press("2");
  hand = await inHand();
  check(hand.tool === "eraser" && hand.eraser === "brush-3", "2 takes the eraser up (its menu gave the key)");
  check((await names()) === "標準の消しゴム/硬め", "the palette follows the tool taken up");
  // A key given again moves from one pen to the other.
  await panel.locator(".subtool-tabs button", { hasText: "ペン" }).first().click();
  await panel.locator(".subtool-row", { hasText: "丸ペン" }).locator(".subtool-key").click();
  await page.keyboard.press("1");
  check((await panel.locator(".subtool-row", { hasText: "Gペン" }).locator(".subtool-key").textContent()) === "⌨", "a key given to another pen leaves the first");
  await page.keyboard.press("1");
  check((await inHand()).brush === "brush-2", "and takes the other");

  // キー設定 and Ctrl+K know them.
  await page.click("#shortcuts");
  const dialog = await page.locator("#sc-list").textContent();
  check(dialog.includes("サブツール") && dialog.includes("ペン: 丸ペン") && dialog.includes("消しゴム: 硬め"), "キー設定 lists every pen and eraser");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("鉛筆");
  check((await page.locator(".cmdp-item.current .cmdp-label").textContent()) === "ペン: 鉛筆", "Ctrl+K finds a pen by its name");
  await page.keyboard.press("Enter");
  const project = await page.evaluate(() => window.nameStudio.workbench.project.brushes.map((b) => b.name));
  hand = await inHand();
  check(project.includes("鉛筆") && hand.brush && hand.width === 1.2, "picking another name's pen brings it into this name and takes it up");
  check(!(await names()).includes("ほかのネーム") && (await panel.locator(".subtool-group").count()) === 0, "it is the name's own now");

  // Drag 鉛筆 above Gペン.
  const from = await panel.locator(".subtool-row", { hasText: "鉛筆" }).boundingBox();
  const to = await panel.locator(".subtool-row", { hasText: "Gペン" }).boundingBox();
  await page.mouse.move(from.x + 140, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 140, to.y + 3, { steps: 8 });
  await page.mouse.up();
  check((await names()) === "標準のペン/鉛筆/Gペン/丸ペン", "a row dragged goes to its new place");
  check(await page.evaluate(() => window.nameStudio.workbench.project.brushes.map((b) => b.name).join("/")) === "鉛筆/Gペン/硬め/丸ペン", "in the name's brushes too (the erasers keep their places)");

  // Keys and sizes outlast a restart (they are kept on this computer, by the pen's name).
  await page.reload();
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const { newBrush } = await import("/src/cspsettings.ts");
    const project = newProject("別のネーム", 2);
    const g = newBrush("pen", "brush-1", "丸ペン");
    g.sizeMm = 0.3;
    project.brushes.push(g);
    project.nextId = 5;
    window.nameStudio.show(project);
  });
  await page.keyboard.press("1");
  hand = await inHand();
  // 丸ペン was last at 0.5 (the round button above).
  check(hand.tool === "pen" && hand.brush === "brush-1" && hand.width === 0.5, "in another name the same pen has the same key and its last size");

  if (shots) {
    await page.locator(".dock.left").screenshot({ path: `${shots}/subtools-pen.png` });
  }
  check(errors.length === 0, `no page errors ${errors.join("; ")}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

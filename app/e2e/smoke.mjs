// The app in a browser, driven as a person would: open a drawn name, draw,
// undo, see an error undone, autosave, and the one-canvas view, with timings
// kept to what a drawn name of many pages needs. Run: npm run e2e
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1431, strictPort: false } });
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

  // A drawn name: 24 pages, 120 rough lines each.
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const project = newProject("通しテスト", 24);
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let id = 0;
    for (const p of project.pages) {
      for (let s = 0; s < 120; s++) {
        let [x, y, a] = [30 + random() * 180, 30 + random() * 280, random() * 6.28];
        const points = [];
        for (let i = 0; i < 40; i++) {
          a += (random() - 0.5) * 0.5;
          x += Math.cos(a) * 0.4;
          y += Math.sin(a) * 0.4;
          points.push([x, y, 0.5]);
        }
        p.strokes.push({ id: `s${id++}`, points, widthMm: 0.5, closed: false });
      }
    }
    project.nextId = id + 1000;
    window.nameStudio.show(project);
  });
  await page.waitForTimeout(300);
  const strokes = () => page.evaluate(() => window.nameStudio.workbench.project.pages.reduce((n, p) => n + p.strokes.length, 0));
  const before = await strokes();

  // Draw a line with the pen.
  await page.locator("#editor-tools button", { hasText: "ペン" }).click();
  const box = await page.locator("#editor-canvas").boundingBox();
  const [cx, cy] = [box.x + box.width * 0.4, box.y + box.height * 0.4];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) await page.mouse.move(cx + i * 6, cy + i * 3);
  const upAt = Date.now();
  await page.mouse.up();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const penUp = Date.now() - upAt;
  check((await strokes()) === before + 1, "the pen adds a line");
  check(penUp < 250, `the page shows the new line soon after the pen leaves (${penUp} ms)`);

  // Undo and redo.
  await page.keyboard.press("Control+z");
  check((await strokes()) === before, "undo takes the line away");
  await page.keyboard.press("Control+Shift+z");
  check((await strokes()) === before + 1, "redo brings it back");

  // A change that fails is undone, and said so.
  const rolled = await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    const count = wb.project.pages[0].strokes.length;
    wb.edit((p) => {
      p.pages[0].strokes = [];
      throw new Error("テストの失敗");
    });
    return wb.project.pages[0].strokes.length === count && wb.state.pending === null;
  });
  check(rolled, "a change that throws is undone");
  check(await page.locator(".alert.error", { hasText: "取り消しました" }).isVisible(), "the person is told it was undone");
  await page.locator(".alert.error button").click();

  // An error nothing catches, during a change: undone too.
  await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    wb.begin();
    wb.project.pages[1].strokes = [];
    setTimeout(() => {
      throw new Error("拾われない失敗");
    });
  });
  await page.waitForTimeout(100);
  check(
    await page.evaluate(() => window.nameStudio.workbench.project.pages[1].strokes.length === 120 && window.nameStudio.workbench.state.pending === null),
    "an uncaught error during a change undoes it",
  );
  check(
    await page.evaluate(() => window.__calls.some((call) => call.command === "log_error")),
    "errors go to the log",
  );

  // Autosave sends the project as text that reads back as the same name.
  await page.waitForTimeout(3500);
  const saved = await page.evaluate(() => {
    const call = window.__calls.filter((c) => c.command === "autosave_project").at(-1);
    if (!call) return null;
    const body = call.args;
    const length = new DataView(body.buffer, body.byteOffset).getUint32(0, true);
    const text = new TextDecoder().decode(body.slice(4 + length));
    const project = JSON.parse(text);
    return { pages: project.pages.length, strokes: project.pages.reduce((n, p) => n + p.strokes.length, 0), bytes: text.length };
  });
  check(saved?.pages === 24 && saved.strokes === before + 1, `autosave sends the whole name (${JSON.stringify(saved)})`);

  // 資料画像: a picture pasted lies on the page under the pointer, moves, and is saved once.
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = [640, 480];
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 640, 480);
    gradient.addColorStop(0, "#3a6");
    gradient.addColorStop(1, "#236");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = "#fff";
    ctx.fillRect(200, 150, 240, 180);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "背景.png", { type: "image/png" }));
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  await page.waitForFunction(() => window.nameStudio.workbench.project.pages.some((p) => p.references?.length), null, { timeout: 5000 });
  const pasted = await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    const index = wb.project.pages.findIndex((p) => p.references?.length);
    const reference = wb.project.pages[index].references[0];
    return { index, box: reference.box, tool: wb.editor.tool, chosen: wb.editor.reference?.id === reference.id, images: wb.project.images.length };
  });
  check(pasted.tool === "reference" && pasted.chosen && pasted.images === 1, `a pasted picture lies on page ${pasted.index + 1}, chosen with the 資料 tool`);
  // Drag it by its middle.
  const middle = await page.evaluate(({ index }) => {
    const wb = window.nameStudio.workbench;
    const [x0, y0, x1, y1] = wb.project.pages[index].references[0].box;
    return wb.editor.clientOf(wb.project.pages[index].id, [(x0 + x1) / 2, (y0 + y1) / 2]);
  }, pasted);
  if (middle) {
    await page.mouse.move(middle[0], middle[1]);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(middle[0] + i * 5, middle[1] + i * 4);
    await page.mouse.up();
  }
  const moved = await page.evaluate(({ index }) => window.nameStudio.workbench.project.pages[index].references[0].box, pasted);
  check(!!middle && moved[0] > pasted.box[0] + 1 && moved[1] > pasted.box[1] + 1, "dragging moves the picture");
  await page.keyboard.press("Control+z");
  const back = await page.evaluate(({ index }) => window.nameStudio.workbench.project.pages[index].references[0].box, pasted);
  check(back[0] === pasted.box[0] && back[1] === pasted.box[1], "undo puts it back");
  await page.keyboard.press("Delete");
  check(
    await page.evaluate(({ index }) => !window.nameStudio.workbench.project.pages[index].references, pasted),
    "Delete takes the chosen picture off",
  );
  await page.keyboard.press("Control+z");
  await page.keyboard.press("v");

  // Every page on one canvas: moving about stays smooth.
  await page.keyboard.press("F7");
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+Alt+0");
  await page.waitForTimeout(400);
  const frames = await page.evaluate(async () => {
    const editor = window.nameStudio.workbench.editor;
    editor.draw();
    const times = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      editor.draw();
      times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[5];
  });
  check(frames < 50, `連続: a frame with every page takes ${frames.toFixed(1)} ms`);

  const unexpected = errors.filter((message) => !message.includes("拾われない失敗"));
  check(unexpected.length === 0, `no other errors (${unexpected.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

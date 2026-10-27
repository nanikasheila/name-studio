// 一時切り替え: a tool's key pressed briefly changes the tool; held down (or
// used on the page while held) it lends the tool, and letting go gives back
// the one from before; let go mid-stroke, after the stroke. Run: npm run e2e:keys
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1441, strictPort: false } });
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
    const { newProject } = await import("/src/project.ts");
    window.nameStudio.show(newProject("道具", 2));
    await new Promise((done) => setTimeout(done, 300));
    window.nameStudio.workbench.setTool("pen");
  });
  const tool = () => page.evaluate(() => window.nameStudio.workbench.editor.tool);
  const mode = () => page.evaluate(() => window.nameStudio.workbench.editor.eraseMode);
  const box = await page.locator("#editor-canvas").boundingBox();
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];

  await page.keyboard.press("KeyE");
  check((await tool()) === "eraser", "a short press changes the tool");
  await page.keyboard.press("KeyP");
  check((await tool()) === "pen", "and back with its own key");

  // Held: repeats change nothing (the eraser's would cycle how it erases); let go, the pen again.
  const before = await mode();
  await page.keyboard.down("KeyE");
  for (let i = 0; i < 4; i++) await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", code: "KeyE", repeat: true, bubbles: true })));
  check((await tool()) === "eraser" && (await mode()) === before, "held, the eraser is lent and its repeats change nothing");
  await page.waitForTimeout(600);
  await page.keyboard.up("KeyE");
  check((await tool()) === "pen", "let go after holding: the pen again");

  // Used while held, however short: given back.
  await page.keyboard.down("KeyE");
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy + 10);
  await page.mouse.up();
  await page.keyboard.up("KeyE");
  check((await tool()) === "pen", "erased with E held, then let go: the pen again");

  // Let go in the middle of a stroke: the pen when the stroke ends.
  await page.keyboard.down("KeyE");
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 20);
  await page.keyboard.up("KeyE");
  check((await tool()) === "eraser", "let go mid-stroke, the eraser stays for the stroke");
  await page.mouse.up();
  check((await tool()) === "pen", "and the pen comes back when it ends");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\ntool keys checked");

// How the built app feels on this computer: the real window (WebView2 on
// Windows, with the GPU), driven through its debugging port. It starts the
// app, opens the heavy name (heavy.mjs) from the start screen's list, draws
// with pen events (pressure and tilt, as a tablet sends them), turns the
// spread, undoes, goes to 連続 and back, waits for autosave, and reads the
// app's own 動作の記録 (perfmeter.ts): the start, the pen's input to the
// screen, the frames, the frames that stopped the screen and what ran in
// them, the memory. Also the size of the app and of its page.
//
// The app is built with an identifier of its own, so it keeps its settings,
// autosaves and WebView data apart from the Name Studio in use:
//   npx tauri build --no-bundle --config '{"identifier":"com.nanikasheila.namestudio.feel"}'
//   node e2e/feel.mjs [--report <file.json>] [--lines <n>]
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { fillHeavy } from "./heavy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const report = arg("--report", null);
const LINES = Number(arg("--lines", 40));
const PORT = 9333;
const app = join(root, "..", "target", "release", process.platform === "win32" ? "name-studio-app.exe" : "name-studio-app");
const work = mkdtempSync(join(tmpdir(), "name-studio-feel-"));

// The heavy name as a file.
const server = await createServer({ root, logLevel: "error", server: { middlewareMode: true } });
const m = {};
for (const module of ["project", "panels", "dialogue", "geometry", "pagebox"]) Object.assign(m, await server.ssrLoadModule(`/src/${module}.ts`));
const { projectJson } = await server.ssrLoadModule("/src/projectjson.ts");
await server.close();
const name = join(work, "重いネーム.namestudio");
writeFileSync(name, projectJson(fillHeavy(m, { pages: 32, strokes: 200 })));

const sizes = { appMb: Math.round(statSync(app).size / 104857.6) / 10, pageKb: 0 };
const dist = join(root, "dist", "assets");
try {
  sizes.pageKb = Math.round(readdirSync(dist).reduce((sum, file) => sum + statSync(join(dist, file)).size, 0) / 1024);
} catch {
  // Not built here.
}

const spawned = Date.now();
const child = spawn(app, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: "ignore",
});
let browser = null;
const out = { sizes };
try {
  for (let i = 0; i < 100 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!browser) throw new Error("the app's debugging port did not open");
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));
  await page.waitForFunction(() => window.nameStudioPerf?.report().startup, null, { timeout: 30_000 });
  out.startup = (await page.evaluate(() => window.nameStudioPerf.report())).startup;
  out.startup.spawnToConnected = Date.now() - spawned;

  // Opened from the start screen's list, as a person does.
  await page.evaluate((path) => {
    localStorage.setItem("namestudio.recentNames", JSON.stringify([{ path, title: "重いネーム", pages: 32, timeMs: Date.now() }]));
    localStorage.setItem("namestudio.tourSeen", JSON.stringify({ editor: true, start: true }));
  }, name);
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".recent-open"));
  const opening = Date.now();
  await page.click(".recent-open");
  await page.waitForFunction(() => !document.getElementById("editor").hidden);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  out.openMs = Date.now() - opening;
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.nameStudioPerf.reset());

  const cdp = await context.newCDPSession(page);
  const box = await page.locator("#editor-canvas").boundingBox();
  const pen = (type, [x, y], pressure, buttons = 1) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "pen", force: pressure, tiltX: 12, tiltY: 4 });
  await page.keyboard.press("p");
  // Lines over the middle of the spread, each 120 moves (a tablet's second of drawing).
  for (let l = 0; l < LINES; l++) {
    const [x0, y0] = [box.x + box.width * (0.25 + 0.5 * ((l * 37) % 100) / 100), box.y + box.height * (0.2 + 0.6 * ((l * 53) % 100) / 100)];
    const points = Array.from({ length: 120 }, (_, i) => [x0 + i * 2.2, y0 + Math.sin(i / 9 + l) * 30]);
    await pen("mouseMoved", points[0], 0, 0);
    await pen("mousePressed", points[0], 0.3);
    for (let i = 1; i < points.length; i++) await pen("mouseMoved", points[i], 0.25 + 0.5 * Math.sin((Math.PI * i) / points.length));
    await pen("mouseReleased", points[points.length - 1], 0, 0);
  }
  out.pen = await page.evaluate(() => window.nameStudioPerf.report());

  // The rest of a session: spreads turned, undo, 連続 and back, then a pause for autosave.
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Control+z");
  await page.keyboard.press("F7");
  await page.waitForTimeout(1500);
  await page.keyboard.press("F7");
  await page.waitForTimeout(6000);
  out.session = await page.evaluate(() => window.nameStudioPerf.report());
} finally {
  await browser?.close().catch(() => {});
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

const r = out.pen;
const s = out.session;
console.log(`app ${sizes.appMb} MB, its page ${sizes.pageKb} KB`);
console.log(`start: process to first screen ${out.startup.process} ms (page ${out.startup.page} ms); the heavy name opened in ${out.openMs} ms`);
console.log(`pen (${r.penLatency?.count} frames, ${r.penRate} events/s): input to screen ${JSON.stringify(r.penLatency)}, a frame ${JSON.stringify(r.penFrame)}, between frames ${JSON.stringify(r.penInterval)}`);
console.log(`the session: frames that stopped the screen ${s.long.count} (${s.long.total} ms)`);
for (const long of s.long.worst.slice(0, 8)) console.log(`  ${long.at}s ${long.duration} ms (blocking ${long.blocking}) ${long.scripts.join(" / ")}`);
console.log(`memory: ${JSON.stringify(s.memory && { first: s.memory.first, now: s.memory.now, most: s.memory.most })}; ${JSON.stringify(s.resources)}`);
if (report) writeFileSync(report, `${JSON.stringify(out, null, 1)}\n`);

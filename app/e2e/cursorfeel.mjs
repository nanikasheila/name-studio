// Does the pen's cursor stay on the pages in the built app (WebView2 with the
// GPU, the screen canvas desynchronized)? Started as feel.mjs starts it, on
// a name of blank pages: the pen hovers to a place, draws a short line,
// hovers away, many times (as a tablet sends it, 240 reports a second), and
// after each line looks where the pen came down and where it left the page:
// the cursor's cross (a thin pen) must not be there any more.
// It looks three ways: the screen canvas read back (getImageData), the
// window as the browser composes it (CDP screenshot) and, on Windows, the
// screen itself (PowerShell, saved as PNGs to look at).
//
//   npx tauri build --no-bundle --config '{"identifier":"com.nanikasheila.namestudio.feel"}'
//   node e2e/cursorfeel.mjs [--lines <n>, 30] [--shots <folder>] [--cursor brush|circle|…] [--app <exe>]
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const LINES = Number(arg("--lines", 30));
const RATE = 240;
const shots = arg("--shots", null);
const look = arg("--cursor", "brush");
const PORT = 9334;
const app = arg("--app", join(root, "..", "target", "release", process.platform === "win32" ? "name-studio-app.exe" : "name-studio-app"));
const work = mkdtempSync(join(tmpdir(), "name-studio-cursor-"));
if (shots) mkdirSync(shots, { recursive: true });

const server = await createServer({ root, logLevel: "error", server: { middlewareMode: true } });
const { newProject } = await server.ssrLoadModule("/src/domain/project.ts");
const { projectJson } = await server.ssrLoadModule("/src/domain/projectjson.ts");
await server.close();
const name = join(work, "カーソル確認.namestudio");
writeFileSync(name, projectJson(newProject("カーソル確認", 8)));

/** The whole screen as a PNG (Windows), to see what is shown rather than what the canvas holds. */
function screenShot(file) {
  if (process.platform !== "win32" || !shots) return;
  const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${join(shots, file).replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose()`;
  spawnSync("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
}

const child = spawn(app, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    NAME_STUDIO_DEBUG_PORT: String(PORT),
    WEBVIEW2_USER_DATA_FOLDER: join(work, "webview"),
  },
  stdio: "ignore",
});
let browser = null;
const out = { cursor: look, lines: LINES, stale: [], checks: 0 };
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
  await page.waitForLoadState();
  await page.evaluate(
    ([path, look]) => {
      localStorage.setItem("namestudio.recentNames", JSON.stringify([{ path, title: "カーソル確認", pages: 8, timeMs: Date.now() }]));
      localStorage.setItem("namestudio.tourSeen", JSON.stringify({ editor: true, start: true }));
      const pen = JSON.parse(localStorage.getItem("namestudio.pen") ?? "{}");
      localStorage.setItem("namestudio.pen", JSON.stringify({ ...pen, cursor: look }));
    },
    [name, look],
  );
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".recent-open"));
  await page.click(".recent-open");
  await page.waitForFunction(() => !document.getElementById("editor").hidden);
  await page.waitForTimeout(1500);
  out.userAgent = await page.evaluate(() => navigator.userAgent);
  out.devicePixelRatio = await page.evaluate(() => devicePixelRatio);
  await page.keyboard.press("p");

  const cdp = await context.newCDPSession(page);
  const box = await page.locator("#editor-canvas").boundingBox();
  const pen = (type, [x, y], pressure, buttons = 1) =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" && !buttons ? "none" : "left",
      buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
      pointerType: "pen",
      force: pressure,
    });
  const due = async (start, i) => {
    while (performance.now() < start + (i * 1000) / RATE) await new Promise((resolve) => setImmediate(resolve));
  };
  /** The darkest of a few pixels where a thin pen's cursor puts its cross (above, below and beside where it was). */
  const crossAt = (points) =>
    page.evaluate((points) => {
      const canvas = document.getElementById("editor-canvas");
      const rect = canvas.getBoundingClientRect();
      const k = canvas.width / rect.width;
      const ctx = canvas.getContext("2d");
      return points.map(([x, y, side]) => {
        let darkest = 765;
        for (const [dx, dy] of [
          [0, -6],
          [0, 6],
          [side * 6, 0],
        ])
          for (const e of [-1, 0, 1]) {
            const px = Math.round((x + dx + (dy ? e : 0) - rect.left) * k);
            const py = Math.round((y + dy + (dx ? e : 0) - rect.top) * k);
            const [r, g, b, a] = ctx.getImageData(px, py, 1, 1).data;
            darkest = Math.min(darkest, a ? r + g + b : 765);
          }
        return darkest;
      });
    }, points);

  // Where the pages are blank: the middle of the canvas.
  for (let l = 0; l < LINES; l++) {
    const x0 = box.x + box.width * (0.3 + 0.4 * (((l * 37) % 100) / 100));
    const y0 = box.y + box.height * (0.25 + 0.5 * (((l * 53) % 100) / 100));
    const stroke = Array.from({ length: 50 }, (_, i) => [x0 + i * 2, y0 + Math.sin(i / 8) * 4]);
    const end = stroke[stroke.length - 1];
    // Hover in from the left, draw, hover away up and to the right.
    let start = performance.now();
    for (let i = 0; i < 12; i++) {
      await due(start, i);
      await pen("mouseMoved", [x0 - 48 + i * 4, y0 - 20 + i * (20 / 11)], 0, 0);
    }
    await pen("mousePressed", stroke[0], 0.3);
    start = performance.now();
    for (let i = 1; i < stroke.length; i++) {
      await due(start, i);
      await pen("mouseMoved", stroke[i], 0.3 + 0.3 * Math.sin((Math.PI * i) / stroke.length));
    }
    await pen("mouseReleased", end, 0, 0);
    start = performance.now();
    for (let i = 1; i <= 12; i++) {
      await due(start, i);
      await pen("mouseMoved", [end[0] + i * 5, end[1] - i * 5], 0, 0);
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Where the pen came down (the line goes right: look left) and left the page (look right).
    const [down, up] = await crossAt([
      [stroke[0][0], stroke[0][1], -1],
      [end[0], end[1], 1],
    ]);
    out.checks += 2;
    if (l % 10 === 9) screenShot(`line-${l}-screen.png`);
    if (down < 600 || up < 600) {
      out.stale.push({ line: l, down, up });
      if (out.stale.length <= 3) {
        screenShot(`stale-${l}-screen.png`);
        await page.screenshot({ path: shots ? join(shots, `stale-${l}-page.png`) : join(work, "x.png") });
      }
    }
  }
  screenShot("end-screen.png");
  if (shots) await page.screenshot({ path: join(shots, "end-page.png") });
} finally {
  await browser?.close().catch(() => {});
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
console.log(JSON.stringify(out, null, 1));
if (out.stale.length) process.exitCode = 1;

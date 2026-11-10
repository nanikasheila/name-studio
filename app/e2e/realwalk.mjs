// The built app's own window, walked through as a person does (Windows: the
// WebView2 of the installed app, driven through its debugging port): the
// start screen, 見本で試す and its guide, a line drawn with the pen, undone and
// done again, the command palette and the help, a colour theme chosen, and
// autosave writing a copy through the Rust side. Then the app is stopped
// without saving and started again: it offers the copy, brings it back with
// the line, and the theme is as chosen. No page errors, nothing in the
// console's errors. What the browser walk-throughs cannot see: the real
// WebView, its Content-Security-Policy, the calls to Rust, a restart.
//
// On a PC with Name Studio in use, build with an identifier of its own (its
// settings, autosaves and WebView data stay apart):
//   npx tauri build --no-bundle --config '{"identifier":"com.nanikasheila.namestudio.feel"}'
//   node e2e/realwalk.mjs
// In CI (a fresh Windows runner) the plain release build is walked.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

if (process.platform !== "win32") {
  console.log("skip: the real window is walked on Windows only (WebView2's debugging port)");
  process.exit(0);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const app = join(root, "..", "target", "release", "name-studio-app.exe");
const PORT = 9335;
const work = mkdtempSync(join(tmpdir(), "name-studio-walk-"));
const SAMPLE = "サンプル 部室の片付け";
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

/** The app started, and its page through the debugging port. */
async function launch() {
  const child = spawn(app, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      // The app opens the port itself (WebView2 can leave the variable above out).
      NAME_STUDIO_DEBUG_PORT: String(PORT),
      // The same WebView data both times: what the page keeps is there at the next start.
      WEBVIEW2_USER_DATA_FOLDER: join(work, "webview"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    stderr += text;
  });
  let exited = null;
  child.on("exit", (code) => {
    exited = code;
  });
  let browser = null;
  // A fresh CI machine takes long to start WebView2 the first time (an export there takes 6–14 s).
  const until = Date.now() + 120_000;
  while (!browser && exited === null && Date.now() < until) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 5000 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!browser) {
    // What WebView2 was started with (its own processes, and whether the port is among their arguments).
    try {
      console.error(
        execFileSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe' or Name='name-studio-app.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | Format-List | Out-String -Width 400; netstat -ano | Select-String ':9335'",
          ],
          { encoding: "utf8" },
        ),
      );
    } catch (error) {
      console.error(`(could not list the processes: ${error.message})`);
    }
    child.kill();
    const why = exited !== null ? `the app ended (exit ${exited})` : "the app is running, but the port did not open in 120 s";
    throw new Error(`the app's debugging port did not open: ${why}${stderr ? `\n${stderr}` : ""}`);
  }
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  await page.waitForFunction(() => window.nameStudioPerf?.report().startup, null, { timeout: 30_000 });
  return { child, browser, page, errors };
}

/** The app stopped as a crash or a power cut would (no chance to save). */
async function stop({ child, browser }) {
  await browser.close().catch(() => {});
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

const resources = (page) => page.evaluate(() => window.nameStudioPerf.report().resources);
const invoke = (page, command, args) =>
  page.evaluate(([command, args]) => window.__TAURI_INTERNALS__.invoke(command, args), [command, args]);
const kept = async (page) => ((await invoke(page, "pending_recoveries")) ?? []).filter((kept) => kept.recovery?.project?.title === SAMPLE);

let run = null;
try {
  // 1. The first start: the start screen, the sample name and its guide.
  run = await launch();
  let { page } = run;
  const started = (await page.evaluate(() => window.nameStudioPerf.report())).startup;
  check(started.process > 0, `the window shows its first screen (${started.process} ms from the process)`);
  await page.waitForSelector("#start-sample", { state: "visible", timeout: 10_000 });
  check(/^v/.test((await page.locator("#app-version").textContent()) ?? ""), "the start screen says the version");
  await page.keyboard.press("Escape");
  await page.click("#start-sample");
  await page.waitForFunction(() => !document.getElementById("editor").hidden);
  await page.waitForSelector("#tour:not([hidden])", { timeout: 5000 }).catch(() => undefined);
  const first = await page.evaluate(() => document.querySelector(".tour-count")?.textContent ?? "");
  check(first.startsWith("1 /"), `見本で試す opens the sample with its guide (${first})`);
  await page.keyboard.press("Escape");
  const before = await resources(page);
  check(before.pages === 8, `the sample has 8 pages (${before.pages})`);

  // 2. A line with the pen, undone and done again.
  const cdp = await page.context().newCDPSession(page);
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
  await page.keyboard.press("p");
  const [x0, y0] = [box.x + box.width * 0.4, box.y + box.height * 0.45];
  await pen("mouseMoved", [x0, y0], 0, 0);
  await pen("mousePressed", [x0, y0], 0.4);
  for (let i = 1; i <= 40; i++) await pen("mouseMoved", [x0 + i * 3, y0 + Math.sin(i / 6) * 20], 0.5);
  await pen("mouseReleased", [x0 + 120, y0], 0, 0);
  await page.waitForTimeout(300);
  // はじめてのペン: 「大きめ」 may be offered once; it is closed, not taken.
  await page
    .locator(".alert.info button[title='閉じる']")
    .click({ timeout: 1000 })
    .catch(() => undefined);
  const drawn = await resources(page);
  check(drawn.strokes === before.strokes + 1, `the pen draws a line (${before.strokes} → ${drawn.strokes})`);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  check((await resources(page)).strokes === before.strokes, "Ctrl+Z takes it back");
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(150);
  check((await resources(page)).strokes === drawn.strokes, "Ctrl+Y puts it again");

  // 3. The command palette and the help over the screen.
  await page.keyboard.press("Control+k");
  check(await page.locator("#command-palette").evaluate((d) => d.open), "Ctrl+K opens the command palette");
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await page.waitForTimeout(200);
  check(
    await page
      .locator("#help-overlay")
      .isVisible()
      .catch(() => false),
    "? shows the help over the screen",
  );
  await page.keyboard.press("Escape");

  // 4. A colour theme, kept on this computer.
  await page.click("#settings");
  await page.locator(".settings-nav-item", { hasText: "画面の見た目" }).click();
  await page.locator('[data-theme-id="dark"]').click();
  await page.keyboard.press("Escape");
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "暗い is chosen");

  // 5. Autosave writes a copy through the Rust side (the sample has no file yet).
  let copies = [];
  for (let i = 0; i < 60 && !copies.length; i++) {
    copies = await kept(page);
    if (!copies.length) await page.waitForTimeout(500);
  }
  check(copies.length === 1, `autosave keeps a copy of the unsaved name (${copies.length})`);
  check(copies[0]?.recovery?.project?.pages?.length === 8, "with all its pages");
  check(run.errors.length === 0, `no errors on the page or in its console (${run.errors.join(" / ")})`);
  await stop(run);

  // 6. Started again after stopping unsaved: the copy is offered and comes back.
  run = await launch();
  page = run.page;
  await page.waitForSelector("#recovery-dialog[open]", { timeout: 15_000 }).catch(() => undefined);
  const offered = await page.locator("#recovery-dialog").evaluate((d) => (d.open ? d.textContent : ""));
  check(offered.includes(SAMPLE), "the next start offers the unsaved name back");
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "and the theme is as chosen");
  await page.locator("#recovery-dialog button", { hasText: "復元する" }).first().click();
  await page.waitForFunction(() => !document.getElementById("editor").hidden, null, { timeout: 10_000 });
  const back = await resources(page);
  check(
    back.pages === 8 && back.strokes === drawn.strokes,
    `復元する brings it back with the line (${back.pages} pages, ${back.strokes} lines)`,
  );
  // Nothing left behind for the next walk.
  await invoke(page, "discard_recovery", { path: null }).catch(() => undefined);
  check(run.errors.length === 0, `no errors after the restart either (${run.errors.join(" / ")})`);
} finally {
  if (run) await stop(run);
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}

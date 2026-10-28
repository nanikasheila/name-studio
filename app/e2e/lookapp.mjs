// 画面の見た目 in the built app (WebView2 on Windows, its Content-Security-
// Policy, its storage), driven through its debugging port: a theme and the
// user's CSS chosen in the settings and kept, there again at the next start;
// started with Shift held, the CSS is left off that time; Ctrl+Shift+Alt+R
// puts the look back. Pictures of each step go to the folder given.
//
// The app is built with an identifier of its own, so it keeps its settings
// apart from the Name Studio in use:
//   npx tauri build --no-bundle --config '{"identifier":"com.nanikasheila.namestudio.look"}'
//   node e2e/lookapp.mjs <folder for the pictures>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.argv[2] ?? join(root, "look-shots");
mkdirSync(shots, { recursive: true });
const PORT = 9334;
const app = join(root, "..", "target", "release", process.platform === "win32" ? "name-studio-app.exe" : "name-studio-app");
const work = mkdtempSync(join(tmpdir(), "name-studio-look-"));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

/** Shift down or up for the whole computer (Windows), as a person holding it. */
function shift(down) {
  const flags = down ? 0 : 2;
  spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    `Add-Type -Name K -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);'; [W.K]::keybd_event(0x10, 0x2A, ${flags}, [System.UIntPtr]::Zero)`,
  ]);
}

/** The app started (the same WebView data each time), its window's page once it is up. */
async function start({ holdShift = false } = {}) {
  if (holdShift) shift(true);
  const child = spawn(app, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
    stdio: "ignore",
  });
  let browser = null;
  try {
    for (let i = 0; i < 100 && !browser; i++) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  } finally {
    if (holdShift) shift(false);
  }
  if (!browser) throw new Error("the app's window did not open");
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector("#start-new");
  await page.waitForTimeout(800);
  return { child, browser, page };
}

async function stop({ child, browser }) {
  await browser.close().catch(() => undefined);
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const bar = (page) => page.evaluate(() => getComputedStyle(document.querySelector(".toolbar")).backgroundColor);
const accent = (page) => page.evaluate(() => getComputedStyle(document.querySelector("#open")).backgroundColor);
const CSS = ":root, [data-theme] { --accent: #d0457a; } button { border-radius: 14px; }";

try {
  // 1. As it comes, then 暗い and CSS chosen in the settings (opened over a new name), CSS kept.
  let run = await start();
  const firstBar = await bar(run.page);
  await run.page.screenshot({ path: join(shots, "1-as-it-comes.png") });
  // A new name open (設定 is on the bar with a name), made as the dialog offers.
  await run.page.click("#start-new");
  await run.page.locator('#new-dialog button[value="ok"]').click();
  await run.page.waitForSelector("#settings:not([hidden])");
  await run.page.click("#settings");
  await run.page.locator(".settings-nav-item", { hasText: "画面の見た目" }).click();
  await run.page.locator(".theme-card", { hasText: "暗い" }).click();
  await run.page.waitForTimeout(300);
  check((await bar(run.page)) === "rgb(42, 41, 38)", `暗い in the real window (${firstBar} → ${await bar(run.page)})`);
  await run.page.fill("#st-css", CSS);
  await run.page.click("#st-css-apply");
  await run.page.waitForTimeout(300);
  check((await accent(run.page)) === "rgb(208, 69, 122)", "the user's CSS is on the screen (a constructed sheet under the app's CSP)");
  await run.page.screenshot({ path: join(shots, "2-dark-css-trial.png") });
  await run.page.locator("#look-trial button", { hasText: "このままにする" }).click();
  await run.page.waitForTimeout(300);
  await stop(run);

  // 2. The next start: both kept.
  run = await start();
  check((await bar(run.page)) === "rgb(42, 41, 38)" && (await accent(run.page)) === "rgb(208, 69, 122)", "the next start: 暗い and the CSS kept");
  await run.page.screenshot({ path: join(shots, "3-next-start.png") });
  await stop(run);

  // 3. Started with Shift held: the CSS left off this time, the theme still 暗い.
  if (process.platform === "win32") {
    run = await start({ holdShift: true });
    check((await accent(run.page)) !== "rgb(208, 69, 122)" && (await bar(run.page)) === "rgb(42, 41, 38)", "Shift held at the start: the CSS left off, the theme kept");
    check(((await run.page.locator(".alert.warning").textContent().catch(() => "")) ?? "").includes("Shift を押しながら起動したので"), "and it says why");
    await run.page.screenshot({ path: join(shots, "4-shift-start.png") });
    await stop(run);
  }

  // 4. Ctrl+Shift+Alt+R: the look as it comes, said in a window of the system's own.
  run = await start();
  await run.page.keyboard.press("Control+Shift+Alt+KeyR");
  await run.page.waitForTimeout(800);
  check((await bar(run.page)) === firstBar && (await accent(run.page)) !== "rgb(208, 69, 122)", "Ctrl+Shift+Alt+R: the look as it comes");
  await run.page.screenshot({ path: join(shots, "5-reset.png") });
  await stop(run);
} finally {
  if (process.platform === "win32") shift(false);
  rmSync(work, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

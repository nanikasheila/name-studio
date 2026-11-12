// タイマー (the bar at the top): ポモドーロ goes work → break with the time in
// the bar, says so with a notice and next steps, logs the work period; the
// countdown rings and offers again; 計る keeps 区切り with the pages open; an
// アラーム rings at its time; what is set survives a restart; the break can
// cover the screen; 設定 › タイマー and the command palette reach it.
// Run: npm run e2e:timer
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1493, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
// 2026-11-12 (Thu) 09:00 on the page's clock.
const START = new Date(2026, 10, 12, 9, 0, 0).getTime();
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: shots ? 2 : 1 });
  await context.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await context.addInitScript(() => {
    localStorage.setItem("namestudio.largeOffered", "1");
    // 記録を消す… is asked first: the test says yes.
    window.__answer = (command, args) =>
      command === "timer_notice" ? null : command === "plugin:dialog|message" ? (args.buttons?.OkCancelCustom?.[0] ?? "Ok") : undefined;
  });
  const page = await context.newPage();
  await page.clock.install({ time: START });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  const openSample = () =>
    page.evaluate(async () => {
      const { sampleName } = await import("/src/domain/samplename.ts");
      window.nameStudio.show(sampleName());
    });
  await openSample();
  await page.clock.runFor(500);

  const chip = page.locator("#timer-chip");
  const pop = page.locator("#timer-pop");
  const chipText = () => page.locator("#timer-chip-text").textContent();
  const alertText = () => page.locator("#alerts .alert").last().textContent();
  check(await chip.isVisible(), "the timer is in the bar at the top");
  check((await chipText()) === "", "idle, it shows only its icon");

  // --- ポモドーロ ---
  await chip.click();
  check(await pop.evaluate((el) => el.matches(":popover-open")), "pressing it opens the timers under it");
  await page.locator("#timer-tab-pomodoro").click();
  await pop.locator(".tm-goal").fill("p.5〜8 のネーム");
  if (shots) await page.screenshot({ path: `${shots}/1_ポモドーロ.png` });
  await pop.getByRole("button", { name: "始める" }).click();
  await page.clock.runFor(1000);
  check((await chip.getAttribute("data-phase")) === "work", "a work period shows red in the bar");
  check(/^2[45]:\d\d$/.test(await chipText()), `with the time left (${await chipText()})`);
  check((await page.title()).startsWith("● 2"), `and in the window's title, for the taskbar (${await page.title()})`);
  await page.keyboard.press("Escape");
  check(!(await pop.evaluate((el) => el.matches(":popover-open"))), "Esc closes the timers; the time stays in the bar");
  if (shots) await page.screenshot({ path: `${shots}/2_作業中.png`, clip: { x: 700, y: 0, width: 700, height: 60 } });

  await page.clock.runFor(25 * 60_000);
  const done = await alertText();
  check(
    done.includes("おつかれさまでした") && done.includes("今日 1 回目") && done.includes("休憩 5 分 を始めました"),
    `the end of work is said (${done})`,
  );
  check((await chip.getAttribute("data-phase")) === "rest", "the break starts by itself, green");
  const log = await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.focusLog")));
  check(log?.["2026-11-12"]?.count === 1 && log["2026-11-12"].minutes === 25, `the work period is logged (${JSON.stringify(log)})`);
  if (shots) await page.screenshot({ path: `${shots}/3_休憩の知らせ.png`, clip: { x: 300, y: 0, width: 1100, height: 160 } });

  await page.clock.runFor(5 * 60_000);
  const back = await alertText();
  check(back.includes("休憩おわり") && back.includes("（p.5〜8 のネーム）"), `the end of the break is said, with the goal (${back})`);
  check((await chip.getAttribute("class")).includes("paused"), "work waits to be started (as set)");
  await page.locator("#alerts .alert").last().getByRole("button", { name: "作業を始める" }).click();
  check(!(await chip.getAttribute("class")).includes("paused"), "作業を始める on the notice starts it");

  // 設定 › タイマー from the timers: the cover over a break.
  await chip.click();
  await pop.getByRole("button", { name: "設定…" }).click();
  check(await page.locator('.settings-pane[data-pane="timer"]').isVisible(), "設定… opens 設定 › タイマー");
  await page.locator("#st-tm-cover").check();
  await page.locator("#st-tm-work").fill("50");
  await page.locator("#st-tm-work").dispatchEvent("change");
  await page.keyboard.press("Escape");
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.timerSettings")));
  check(settings.cover === true && settings.workMin === 50, `the settings are kept (${JSON.stringify(settings)})`);
  // The running work period ends (still 25 minutes: it began before the change).
  await page.clock.runFor(26 * 60_000);
  check(await page.locator("#timer-cover").isVisible(), "a break covers the screen when set to");
  if (shots) await page.screenshot({ path: `${shots}/4_休憩のおおい.png` });
  await page.getByRole("button", { name: "おおいを外す" }).click();
  check(await page.locator("#timer-cover").isHidden(), "おおいを外す puts it aside for this break");
  await page.clock.runFor(2000);
  check(await page.locator("#timer-cover").isHidden(), "and it stays aside");

  // The command palette: ポモドーロを止める.
  await page.locator("#editor-canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+k");
  await page.keyboard.type("ポモドーロを止める");
  await page.keyboard.press("Enter");
  await page.clock.runFor(1000);
  check((await chipText()) === "", "the palette's ポモドーロを止める stops it");

  // --- タイマー ---
  await chip.click();
  await page.locator("#timer-tab-countdown").click();
  await pop.locator(".tm-length").fill("1:30");
  await pop.locator(".tm-label").fill("p.3 のコマ割り");
  await pop.locator(".tm-length").press("Enter");
  await page.clock.runFor(1000);
  check(/^1:(29|30)$/.test(await chipText()), `the countdown runs in the bar (${await chipText()})`);
  if (shots) await page.screenshot({ path: `${shots}/5_タイマー.png` });
  await page.keyboard.press("Escape");
  await page.clock.runFor(90_000);
  const rang = await alertText();
  check(rang.includes("タイマー「p.3 のコマ割り」の 1 分 30 秒 が経ちました"), `its end is said (${rang})`);
  await page.locator("#alerts .alert").last().getByRole("button", { name: "あと 5 分" }).click();
  check((await chipText()) === "5:00", `あと 5 分 starts five more (${await chipText()})`);
  await chip.click();
  await pop.getByRole("button", { name: "リセット" }).click();
  await page.keyboard.press("Escape");

  // --- 計る ---
  await chip.click();
  await page.locator("#timer-tab-stopwatch").click();
  await pop.getByRole("button", { name: "始める" }).click();
  await page.clock.runFor(65_000);
  await pop.getByRole("button", { name: "区切る" }).click();
  await page.clock.runFor(30_000);
  await pop.getByRole("button", { name: "区切る" }).click();
  const laps = await pop.locator(".tm-laps li").allTextContents();
  check(
    laps.length === 2 && laps[1].includes("p.") && /1:0\d/.test(laps[1]) && /0:3\d/.test(laps[0]),
    `区切り keep the pages and each length (${laps})`,
  );
  if (shots) await page.screenshot({ path: `${shots}/6_計る.png` });
  await pop.getByRole("button", { name: "止める" }).click();
  await pop.getByRole("button", { name: "リセット" }).click();

  // --- アラーム ---
  await page.locator("#timer-tab-alarms").click();
  await pop.locator(".tm-add .tm-alarm-time").fill("10:00");
  await pop.locator('.tm-add input[type="text"]').fill("締め切りの確認");
  await pop.getByRole("button", { name: "足す" }).click();
  check((await pop.locator(".tm-alarms li").count()) === 1, "an alarm is added");
  check(
    (await pop.locator(".tm-pane:not([hidden]) .tm-note").first().textContent()).includes("次は 10:00「締め切りの確認」"),
    "the next one is said",
  );
  if (shots) await page.screenshot({ path: `${shots}/7_アラーム.png` });
  await page.keyboard.press("Escape");
  check((await chipText()) === "10:00", `idle, the bar shows the next alarm (${await chipText()})`);

  // What is set survives a restart.
  await page.reload();
  await page.waitForFunction(() => window.nameStudio);
  await openSample();
  await page.clock.runFor(500);
  check((await chipText()) === "10:00", "after a restart the alarm is still set");
  const now = await page.evaluate(() => Date.now());
  await page.clock.runFor(new Date(2026, 10, 12, 10, 0, 1).getTime() - now);
  check((await alertText()).includes("アラーム 10:00「締め切りの確認」 の時間です"), "it rings at its time");
  await page.locator("#alerts .alert").last().getByRole("button", { name: "5 分後にもう一度" }).click();
  await page.clock.runFor(5 * 60_000);
  check((await alertText()).includes("アラーム 10:00"), "あとで rings it again five minutes on");

  // Said outside the window too (Windows' notification, the taskbar) when another app is in front.
  await page.evaluate(() => {
    window.__calls.length = 0;
    document.hasFocus = () => false;
  });
  await chip.click();
  await page.locator("#timer-tab-countdown").click();
  await pop.locator(".tm-length").fill("10s");
  await pop.locator(".tm-length").press("Enter");
  await page.keyboard.press("Escape");
  await page.clock.runFor(11_000);
  const notice = await page.evaluate(() => window.__calls.find((call) => call.command === "timer_notice")?.args.notice);
  check(
    notice?.toast === true && notice.flash === true && notice.body.includes("10 秒"),
    `away, it asks for Windows' notice (${JSON.stringify(notice)})`,
  );

  // Only while one runs: the bar keeps out of the way.
  await page.evaluate(() => {
    const kept = JSON.parse(localStorage.getItem("namestudio.timers"));
    kept.alarms = [];
    localStorage.setItem("namestudio.timers", JSON.stringify(kept));
    localStorage.setItem("namestudio.timerSettings", JSON.stringify({ chip: "running" }));
  });
  await page.reload();
  await page.waitForFunction(() => window.nameStudio);
  await openSample();
  await page.clock.runFor(1500);
  check(await chip.isHidden(), "set to show only while running, an idle timer is not in the bar");
  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}

// How the app says things and how it is reached without a pointer: a failure
// looks like one and says what to do (not the system's own words), 大きめ makes
// what is pressed 28px or more, and F8 takes the keyboard round the parts of
// the screen. Run: npm run e2e:notices
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1464, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
const errors = [];
async function open(width, height, init) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  if (init) await page.addInitScript(init);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  return page;
}
const demo = (page) =>
  page.evaluate(async () => {
    const { demoName } = await import("/e2e/demoname.js");
    window.nameStudio.show(demoName(null));
  });
const status = (page) =>
  page.evaluate(() => {
    const s = document.getElementById("status");
    return {
      text: s.textContent,
      error: s.classList.contains("error"),
      open: s.classList.contains("open"),
      role: s.getAttribute("role"),
      color: getComputedStyle(s).color,
    };
  });

try {
  // A file another app holds: opening it fails as Windows says it.
  const RAW = "C:\\作品\\第4話.namestudio: プロセスはファイルにアクセスできません。別のプロセスが使用中です。 (os error 32)";
  const page = await open(1366, 768, () => {
    Object.defineProperty(navigator, "userAgent", { get: () => "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    window.__answer = (command) => {
      if (command === "choose_open") return "C:\\作品\\第4話.namestudio";
      if (command === "load_project")
        throw "C:\\作品\\第4話.namestudio: プロセスはファイルにアクセスできません。別のプロセスが使用中です。 (os error 32)";
      return undefined;
    };
  });
  const plain = await status(page);
  await page.click("#open");
  await page
    .waitForFunction(() => document.getElementById("status").classList.contains("error"), null, { timeout: 5000 })
    .catch(() => undefined);
  const failed = await status(page);
  check(
    failed.error && failed.role === "alert" && failed.color !== plain.color,
    `a failure looks like one in the status line (${failed.color} against ${plain.color}, role ${failed.role})`,
  );
  check(
    failed.text.includes("開けませんでした") && failed.text.includes("ほかのアプリ") && failed.text.includes("閉じてから"),
    `it says what to do: ${failed.text}`,
  );
  check(!failed.text.includes("os error"), "and not the system's own words");
  const alert = await page.evaluate(() => document.querySelector("#alerts .alert.error")?.textContent ?? "");
  check(alert.includes("ほかのアプリ"), `it is shown over the page too (${alert.slice(0, 40)}…)`);
  // The error as it came is one click (or Enter) away.
  await page.click("#status");
  const opened = await status(page);
  check(opened.open && opened.text.includes(RAW), "a click opens all of it, with the error as it came");
  await page.keyboard.press("Escape");
  check(!(await status(page)).open, "Esc closes it");
  await page.focus("#status");
  await page.keyboard.press("Enter");
  check((await status(page)).open, "Enter opens it from the keyboard");
  await page.mouse.click(600, 300);
  check(!(await status(page)).open, "a click elsewhere closes it");
  const logged = await page.evaluate(() => window.__calls.filter((c) => c.command === "log_error").map((c) => c.args.message));
  check(
    logged.some((line) => line.includes("os error 32")),
    "the error as it came goes to the log",
  );
  // The next message is an ordinary one again.
  await demo(page);
  await page.keyboard.press("F7");
  const after = await status(page);
  check(!after.error && after.role === "status", `the next message is an ordinary one (${after.text})`);

  // 大きめ: turned on in the settings, every button and field on screen is 28px or more.
  const small = (page, limit) =>
    page.evaluate((limit) => {
      const seen = (e) =>
        e.getClientRects().length > 0 &&
        getComputedStyle(e).visibility !== "hidden" &&
        e.getBoundingClientRect().top < innerHeight &&
        e.getBoundingClientRect().left < innerWidth &&
        e.getBoundingClientRect().bottom > 0;
      return [
        ...document.querySelectorAll(
          "button, select, textarea, summary, input:not([type=checkbox], [type=radio], [type=range], [type=color])",
        ),
      ]
        .filter((e) => seen(e) && !e.closest("dialog"))
        .map((e) => [
          e.id || e.title || e.textContent.trim().slice(0, 12),
          Math.round(e.getBoundingClientRect().width),
          Math.round(e.getBoundingClientRect().height),
        ])
        .filter(([, w, h]) => Math.min(w, h) < limit);
    }, limit);
  const before = await small(page, 28);
  const textBefore = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  await page.click("#settings");
  await page.locator("#settings-dialog input[type=search], #settings-dialog input[placeholder*='設定を探す']").first().fill("大きめ");
  await page.locator("#st-ui-large").check();
  await page.keyboard.press("Escape");
  const large = await small(page, 28);
  const textAfter = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  check(
    before.length > 0 && large.length === 0,
    `大きめ leaves nothing under 28px (${before.length} before, now ${JSON.stringify(large.slice(0, 5))})`,
  );
  check(textAfter === textBefore + 2, `and the words are a step larger (${textBefore} → ${textAfter} px)`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the window still holds everything at 1366 px");
  await page.reload();
  await page.waitForFunction(() => window.nameStudio);
  check(await page.evaluate(() => document.documentElement.dataset.density === "large"), "it is kept for the next start");
  await page.evaluate(() => localStorage.removeItem("namestudio.look"));

  // F8: the keyboard goes round the parts of the screen.
  const keys = await open(1600, 900);
  await demo(keys);
  await keys.waitForTimeout(300);
  const where = () =>
    keys.evaluate(() => {
      const a = document.activeElement;
      const part = ["dock-left", "editor-tools", "tool-options", "page-nav", "story", "dock-right"].find((id) =>
        document.getElementById(id)?.contains(a),
      );
      return a?.id === "editor-canvas" ? "page" : (part ?? (a?.closest("header.toolbar") ? "top" : "nowhere"));
    });
  const round = [];
  for (let i = 0; i < 8; i++) {
    await keys.keyboard.press("F8");
    round.push(await where());
  }
  check(new Set(round).size >= 6 && !round.includes("nowhere"), `F8 goes round the parts (${round.join(" → ")})`);
  check(round.indexOf("page") >= 0 && round[0] === round[round.findIndex((p, i) => i > 0 && p === round[0])], "and comes round again");
  const first = round[0];
  await keys.keyboard.press("Shift+F8");
  await keys.keyboard.press("Shift+F8");
  const back = await where();
  check(back === round[round.length - 3], `Shift+F8 goes back (${round[round.length - 1]} → ${back})`);
  check((await status(keys)).text.includes("に移りました"), "the status line says where the keyboard is");
  // From a text field too: it is how the keyboard leaves it.
  const memo = keys.locator("#dock-right textarea:visible").first();
  await memo.focus();
  await keys.keyboard.press("F8");
  check((await where()) !== "dock-right", `F8 leaves a text field (to ${await where()})`);
  // A tool's key still picks the tool once the keyboard is on the page.
  while ((await where()) !== "page") await keys.keyboard.press("F8");
  await keys.keyboard.press("p");
  check(await keys.evaluate(() => window.nameStudio.workbench.editor.tool === "pen"), `on the page, P picks the pen (${first} was first)`);
  check(errors.length === 0, `no errors (${errors.join(" | ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nnotices: all passed");

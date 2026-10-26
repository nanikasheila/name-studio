// The start screen: the names opened last, one click (or Ctrl+K and a few
// letters) to pick one up again. Run: npm run e2e:start
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const recent = [
  { path: "C:\\ネーム\\第4話.namestudio", title: "第4話", pages: 24, timeMs: Date.now() - 3_600_000 },
  { path: "C:\\ネーム\\消えた.namestudio", title: "消えたネーム", pages: 16, timeMs: Date.now() - 86_400_000 },
  { path: "D:\\old\\読み切り.namestudio", title: "読み切り", pages: 32, timeMs: Date.now() - 40 * 86_400_000 },
];

const server = await createServer({ root, logLevel: "error", server: { port: 1435, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript((names) => {
    if (!localStorage.getItem("namestudio.recentNames")) localStorage.setItem("namestudio.recentNames", JSON.stringify(names));
  }, recent);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  // 第4話 opens; the one that was moved away does not.
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    window.__answer = (command, args) => {
      if (command !== "load_project") return undefined;
      if (args.path.includes("第4話")) return newProject("第4話", 24);
      throw new Error("ファイルが見つかりません");
    };
  });
  const rows = page.locator("#recent-names .recent-name");
  const titles = () => rows.locator(".recent-title").allTextContents();
  const kept = () => page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.recentNames") ?? "[]").map((n) => n.title));

  check(await page.locator("#empty").isVisible(), "the start screen shows before anything is open");
  check(!(await page.locator("#viewer .sidebar").isVisible()), "with no sheet, the empty layer list is out of the way");
  check(JSON.stringify(await titles()) === JSON.stringify(["第4話", "消えたネーム", "読み切り"]), "it lists the names opened last, newest first");
  check((await rows.first().locator(".recent-when").textContent()).startsWith("24 ページ ・ 今日"), "with their pages and when");

  await rows.nth(1).locator(".recent-open").click();
  await page.waitForTimeout(200);
  check(JSON.stringify(await titles()) === JSON.stringify(["第4話", "読み切り"]), "a name that cannot be opened leaves the list");
  check((await page.locator("#status").textContent()).includes("開けませんでした"), "and the status says why");
  check(await page.locator("#empty").isVisible(), "the start screen stays");

  await rows.nth(1).locator(".recent-forget").click();
  check(JSON.stringify(await kept()) === JSON.stringify(["第4話"]), "× takes a name off the list (and off this computer's list)");

  await page.keyboard.press("Control+k");
  const palette = page.locator("#start-palette");
  check(await palette.evaluate((d) => d.open), "Ctrl+K works on the start screen");
  check(!(await page.locator("#command-palette").evaluate((d) => d.open)), "with the start screen's commands, not the editor's");
  await palette.locator("input").fill("4話");
  check((await palette.locator(".cmdp-item.current .cmdp-label").textContent()) === "第4話 を開く", "a few letters find a recent name");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  check(await page.locator("#editor").isVisible(), "Enter opens it in the editor");
  const first = await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.recentNames"))[0]);
  check(first.title === "第4話" && Date.now() - first.timeMs < 60_000, "opening it puts it first again, as of now");

  await page.keyboard.press("Control+k");
  check(await page.locator("#command-palette").evaluate((d) => d.open), "in the editor Ctrl+K is the editor's palette");
  await page.keyboard.press("Escape");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

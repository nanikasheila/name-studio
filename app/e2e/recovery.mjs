// Names autosave kept and never saved, at start: every one is offered (the
// one that cannot be read too, with why), each to bring back or remove for
// good; あとで (closing) keeps them all for the next start.
// Run: npm run e2e:recovery
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const NOW = Date.parse("2026-10-15T12:00:00+09:00");

const server = await createServer({ root, logLevel: "error", server: { port: 1443, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  /** The app started with these kept names (as Rust lists them, newest first). */
  const start = async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, timezoneId: "Asia/Tokyo" });
    await page.clock.setFixedTime(NOW);
    await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
    await page.addInitScript((now) => {
      window.__removed = [];
      const project = (title, pages) => ({
        title,
        pageFormat: { canvasMm: [257, 364], trimMm: [220, 310], basicMm: [180, 270] },
        pages: Array.from({ length: pages }, (_, i) => ({ id: `p${i}`, panels: [], lines: [], strokes: [], memo: "" })),
      });
      const kept = [
        { file: "cut-01.json", timeMs: now - 60_000, recovery: null, unreadable: "控えのファイルが壊れています: EOF while parsing" },
        { file: "dai4-02.json", timeMs: now - 3_600_000, recovery: { path: "C:\\ネーム\\第4話.namestudio", timeMs: now - 3_600_000, project: project("第4話", 24), problems: ["重なった id"] }, unreadable: null },
        { file: "untitled.json", timeMs: now - 7_200_000, recovery: { path: null, timeMs: now - 7_200_000, project: project("読み切り", 8) }, unknownFields: ["pages.strokes.wobble"], unreadable: null },
      ];
      window.__answer = (command, args) => {
        switch (command) {
          case "pending_recoveries":
            return kept.filter((item) => !window.__removed.includes(item.file));
          case "remove_recovery":
            window.__removed.push(args.file);
            return null;
          case "plugin:dialog|message":
            // 削除… asks first: the test's answer.
            return args.buttons?.OkCancelCustom?.[window.__decline ? 1 : 0] ?? "Ok";
          default:
            return undefined;
        }
      };
    }, NOW);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => window.nameStudio);
    return { page, errors };
  };

  const { page, errors } = await start();
  const dialog = page.locator("#recovery-dialog");
  await dialog.waitFor({ state: "visible" });
  const rows = dialog.locator(".rc-item");
  check((await page.locator("#rc-count").textContent()).includes("3 件"), "all three kept names are offered, not just the newest");
  const texts = await rows.allTextContents();
  check(texts[0].startsWith("読めない控え（cut-01.json）") && texts[0].includes("控えのファイルが壊れています"), `the one that cannot be read is there, with why (${texts[0].slice(0, 40)})`);
  check((await rows.nth(0).getByText("復元する").count()) === 0, "it cannot be brought back, only removed");
  check(texts[1].includes("第4話") && texts[1].includes("24 ページ・今日 11:00:00 の自動保存・C:\\ネーム\\第4話.namestudio") && texts[1].includes("直せる問題が 1 か所"), `each says what it is, when and where (${texts[1].slice(0, 60)})`);
  check(texts[2].includes("まだ保存していないネーム") && texts[2].includes("この版が知らない項目"), "and what a newer version added that this one does not show");

  await page.evaluate(() => {
    window.__decline = true;
  });
  await rows.nth(0).getByText("削除…").click();
  await page.waitForTimeout(200);
  check((await rows.count()) === 3 && (await page.evaluate(() => window.__removed.length)) === 0, "削除… asks first: やめる keeps it");
  await page.evaluate(() => {
    window.__decline = false;
  });
  await rows.nth(0).getByText("削除…").click();
  await page.waitForFunction(() => document.querySelectorAll("#rc-list .rc-item").length === 2);
  check(JSON.stringify(await page.evaluate(() => window.__removed)) === JSON.stringify(["cut-01.json"]), "消す removes that one only");
  await dialog.getByRole("button", { name: "あとで" }).click();
  await page.waitForTimeout(200);
  check(!(await dialog.isVisible()) && (await page.locator("#empty").isVisible()), "あとで closes it, on the start screen");
  check((await page.evaluate(() => window.__removed.length)) === 1, "and keeps the others");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
  await page.close();

  // Another start: one is brought back.
  const again = await start();
  const second = again.page.locator("#recovery-dialog");
  await second.waitFor({ state: "visible" });
  if (process.argv.includes("--shot")) await second.screenshot({ path: process.argv[process.argv.indexOf("--shot") + 1] });
  await second.locator(".rc-item", { hasText: "読み切り" }).getByText("復元する").click();
  await again.page.waitForFunction(() => window.nameStudio.workbench.project?.title === "読み切り");
  check(!(await second.isVisible()) && (await again.page.locator("#editor").isVisible()), "復元する opens it in the editor");
  check((await again.page.locator("#status").textContent()).includes("の自動保存から復元しました"), "as unsaved changes from that autosave");
  const warning = await again.page.locator("#alerts .alert.warning").allTextContents();
  check(warning.length === 1 && warning[0].includes("pages.strokes.wobble"), "saying what this version does not show of it");
  check((await again.page.evaluate(() => window.__removed.length)) === 0, "nothing else is removed");
  check(again.errors.length === 0, `no page errors${again.errors.length ? `: ${again.errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

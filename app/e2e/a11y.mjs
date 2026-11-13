// アクセシビリティ: each colour theme, on the start screen, the editor with
// the sample name, the settings and the export dialogs, checked with axe-core
// (WCAG 2.1 A/AA: names of buttons and fields, roles, the contrast of words).
// Run: npm run e2e:a11y [-- --list] (--list: every finding, not just a count)
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const list = process.argv.includes("--list");
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1489, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const THEMES = ["light", "dark", "sepia", "contrast-dark", "contrast-light"];
try {
  for (const theme of THEMES) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: theme === "dark" ? "dark" : "light" });
    await context.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
    await context.addInitScript((theme) => {
      localStorage.setItem("namestudio.look", JSON.stringify({ theme }));
      localStorage.setItem("namestudio.largeOffered", "1");
    }, theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => window.nameStudio);
    await page.addScriptTag({ path: axePath });
    const audit = async (where) => {
      const result = await page.evaluate(async () => {
        const found = await window.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
          resultTypes: ["violations", "incomplete"],
        });
        window.__incomplete = found.incomplete.map((v) => `${v.id} ×${v.nodes.length}`);
        window.__dialogs = [...document.querySelectorAll("dialog[open]")].map((d) => d.id);
        return found.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.map(
            (n) =>
              `${n.target.join(" ")}${n.any[0]?.data?.contrastRatio ? ` (${n.any[0].data.contrastRatio}:1, ${n.any[0].data.fgColor} on ${n.any[0].data.bgColor})` : ""}`,
          ),
        }));
      });
      const count = result.reduce((sum, v) => sum + v.nodes.length, 0);
      check(count === 0, `${theme} / ${where}: ${count ? result.map((v) => `${v.id} ×${v.nodes.length}`).join(", ") : "nothing found"}`);
      if (list)
        console.log(
          `       incomplete: ${await page.evaluate(() => window.__incomplete.join(", "))}; open dialogs: ${await page.evaluate(() => window.__dialogs.join(","))}`,
        );
      if (list && count) for (const v of result) for (const node of v.nodes) console.log(`       ${v.id} (${v.impact}) ${node}`);
    };
    await audit("開始画面");
    await page.evaluate(async () => {
      const { sampleName } = await import("/src/domain/samplename.ts");
      window.nameStudio.show(sampleName());
    });
    await page.waitForTimeout(300);
    await audit("編集画面（見本のネーム）");
    // A balloon selected: the inspector shows its fields.
    await page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      const page = wb.project.pages[0];
      wb.editor.select({ kind: "line", pageId: page.id, id: page.lines[0].id });
    });
    await page.waitForTimeout(200);
    await audit("セリフを選んだところ");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(200);
    await audit("命令パレット");
    await page.keyboard.press("Escape");
    await page.keyboard.press("?");
    await page.waitForTimeout(200);
    await audit("画面全体のヘルプ");
    await page.keyboard.press("Escape");
    await page.keyboard.press("F5");
    await page.waitForTimeout(300);
    await audit("読む表示");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.click("#settings");
    await page.waitForTimeout(200);
    await audit("設定");
    await page.keyboard.press("Escape");
    await page.click("#name-export");
    await page.waitForTimeout(200);
    await audit("書き出し");
    await page.keyboard.press("Escape");
    // タイマー: a work period running (red in the bar), an alarm in its list, and 設定 › タイマー.
    await page.click("#timer-chip");
    await page.click("#timer-tab-pomodoro");
    await page.locator("#timer-pop").getByRole("button", { name: "始める" }).click();
    await page.waitForTimeout(200);
    await audit("タイマー（ポモドーロ）");
    await page.click("#timer-tab-alarms");
    await page.locator("#timer-pop").getByRole("button", { name: "足す" }).click();
    await page.waitForTimeout(200);
    await audit("タイマー（アラーム）");
    await page.click("#timer-tab-pomodoro");
    await page.locator("#timer-pop").getByRole("button", { name: "設定…" }).click();
    await page.waitForTimeout(200);
    await audit("設定 › タイマー");
    await page.keyboard.press("Escape");
    check(errors.length === 0, `${theme}: no page errors (${errors.join(" / ")})`);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}

// 作品情報・ノンブル in the export dialog (ツールで設定する): サブタイトル,
// positions, ページ番号 and a shown ノンブル go into the page the Rust side
// makes, are kept with the name, and come back when the dialog opens again.
// Run: npm run e2e:storyinfo
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1436, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(() => {
    window.__setups = [];
    window.__answer = (command, args) => {
      if (command === "prepare_builtin_template") {
        window.__setups.push(args.setup);
        return { page: "/t/page.clip", parts: "/t/parts.clip", work: "/t/work.cmc" };
      }
      if (command === "check_export_target") return null;
      return undefined;
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    window.nameStudio.show(newProject("第1話", 3));
  });
  const settle = () => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));

  await page.click("#name-export");
  await page.waitForSelector("#name-export-dialog[open]");
  // The page settings are under 詳しい設定.
  await page.click("#ne-more > summary");
  await page.click("#ne-mode-builtin");
  check(await page.locator(".ne-shown").first().isHidden(), "the shown ノンブル's rows are hidden with the hidden ノンブル");
  await page.fill("#ne-subtitle", "はじまり");
  await page.selectOption("#ne-title-pos", "right");
  await page.check("#ne-page-number");
  await page.fill("#ne-page-number-start", "7");
  await page.selectOption("#ne-nombre-place", "bottom-outer");
  check(await page.locator(".ne-shown").first().isVisible(), "choosing a place shows the shown ノンブル's rows");
  await page.selectOption("#ne-nombre-color", "white");
  await page.check("#ne-nombre-edge");
  await page.fill("#ne-nombre-edge-mm", "0.5");
  await page.fill("#ne-nombre-prefix", "p.");
  await page.fill("#ne-nombre-y", "3");
  await page.dispatchEvent("#ne-nombre-y", "change");
  await page.click("#ne-run");
  await settle();
  const setup = await page.evaluate(() => window.__setups.at(-1) ?? null);
  check(
    JSON.stringify(setup?.story) ===
      JSON.stringify({
        subtitle: "はじまり",
        titlePosition: "right",
        pageNumber: { start: 7 },
        nombre: { place: "bottom-outer", white: true, edgeMm: 0.5, prefix: "p.", offsetMm: [0, 3] },
      }),
    `the page is made with them (${JSON.stringify(setup?.story)})`,
  );
  const kept = await page.evaluate(() => window.nameStudio.workbench.project.cspPage?.story ?? null);
  check(kept?.nombre?.place === "bottom-outer" && kept?.subtitle === "はじまり", `the name keeps them (${JSON.stringify(kept)})`);

  // Opened again: the fields show what the name has.
  await page.evaluate(() => document.getElementById("name-export-dialog").close());
  await page.click("#name-export");
  await page.waitForSelector("#name-export-dialog[open]");
  const shown = await page.evaluate(() => ({
    subtitle: document.getElementById("ne-subtitle").value,
    place: document.getElementById("ne-nombre-place").value,
    start: document.getElementById("ne-page-number-start").value,
    prefix: document.getElementById("ne-nombre-prefix").value,
  }));
  check(
    JSON.stringify(shown) === JSON.stringify({ subtitle: "はじまり", place: "bottom-outer", start: "7", prefix: "p." }),
    `the dialog shows them again (${JSON.stringify(shown)})`,
  );

  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

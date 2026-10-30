// 作業の配置 with the mouse and the keys: 全体 lays every page on one canvas
// with the lists and the band, 描く the pages large with the pen's palettes,
// CSP に渡す what is still open before writing out; a palette moved in one is
// kept for it (and the arrangement used before any was chosen counts as 描く),
// 既定に戻す brings one as it comes, and the choice is kept for the next start.
// Run: npm run e2e:workspaces (-- --shots <dir> keeps the pictures).
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1442, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.waitForFunction(() => window.nameStudio);
    await page.evaluate(async () => {
      const { newProject } = await import("/src/project.ts");
      window.nameStudio.show(newProject("配置", 8));
    });
  };
  await page.goto(server.resolvedUrls.local[0]);
  await page.evaluate(() => localStorage.removeItem("namestudio.workspaces"));
  await open();

  /** What is on screen: the open palettes of each column, the view, the band. */
  const state = () =>
    page.evaluate(() => {
      const open = (side) => [...document.querySelectorAll(`#dock-${side} .dock-stack > .palette:not(.folded)`)].map((p) => p.dataset.palette);
      const wb = window.nameStudio.workbench;
      return {
        left: open("left"),
        right: open("right"),
        rightNarrow: document.getElementById("dock-right").classList.contains("narrow"),
        view: document.getElementById("continuous-mode").classList.contains("active") ? "continuous" : document.getElementById("single-mode").classList.contains("active") ? "single" : "spread",
        band: wb.board.expanded ? "wide" : wb.board.isFolded ? "folded" : "strip",
        active: [...document.querySelectorAll("#workspace-modes button.active")].map((b) => b.id),
      };
    });
  check((await state()).active.join() === "ws-draw", "the arrangement in use counts as 描く until another is chosen");
  // Something of the person's own in it, before any workspace is chosen.
  await page.click("#tab-cast");
  const mine = await state();

  await page.click("#ws-overview");
  const overview = await state();
  check(overview.view === "continuous" && overview.band === "strip", `全体: every page on one canvas, the band shown (${overview.view}, ${overview.band})`);
  check(overview.left.join() === "pages,script,notes" && overview.right.join() === "inspector", `全体: ページ・台本・付箋 and 詳細 (${overview.left} | ${overview.right})`);
  check(overview.active.join() === "ws-overview", "its button is the one pressed");
  if (shots) await page.waitForTimeout(500).then(() => page.screenshot({ path: `${shots}/ws-overview.png` }));

  // A palette hidden in 全体 stays hidden there.
  await page.click("#tab-script");
  await page.click("#ws-handoff");
  const handoff = await state();
  check(handoff.left.join() === "pages,notes,held" && handoff.right.join() === "layers,inspector" && handoff.band === "folded" && handoff.view === "spread", `CSP に渡す: ページ・付箋・保留 | レイヤー・詳細, band folded (${handoff.left} | ${handoff.right}, ${handoff.band})`);
  if (shots) await page.screenshot({ path: `${shots}/ws-handoff.png` });

  await page.click("#ws-draw");
  const draw = await state();
  check(draw.left.join() === mine.left.join() && draw.view === mine.view, `描く: back as it was before, the person's own palettes kept (${draw.left})`);

  await page.keyboard.press("Control+2");
  const again = await state();
  check(again.left.join() === "pages,notes" && again.view === "continuous", `Ctrl+2: 全体 as it was left, 台本 still hidden (${again.left})`);

  // 既定に戻す from the command palette.
  await page.keyboard.press("Control+k");
  await page.keyboard.type("既定に戻す");
  await page.keyboard.press("Enter");
  check((await state()).left.join() === "pages,script,notes", "既定に戻す: 全体 as it comes");

  // 描く as it comes: the pen's palettes, the right column to its icons.
  await page.click("#ws-draw");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("既定に戻す");
  await page.keyboard.press("Enter");
  const drawn = await state();
  check(drawn.left.join() === "subtools,layers" && drawn.rightNarrow && drawn.band === "folded", `描く as it comes: サブツール・レイヤー, the right column folded, the band folded (${drawn.left})`);
  if (shots) await page.screenshot({ path: `${shots}/ws-draw.png` });

  // Started again: the workspace chosen and the palettes as left.
  await page.click("#ws-overview");
  await page.reload();
  await open();
  const reopened = await state();
  check(reopened.active.join() === "ws-overview" && reopened.left.join() === "pages,script,notes", `started again: 全体, as it was (${reopened.active} ${reopened.left})`);

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

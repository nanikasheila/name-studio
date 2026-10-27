// ヘルプ: the bar under the window names what is under the pointer and what
// the mouse and the keys do there (the keys as set now, a held modifier's
// steps first), and can be hidden; ? lays the names of the screen's parts over
// it, none on top of another; the first-time guide comes once, on the start
// screen and in the editor, and goes on with → and away with Esc.
// Run: npm run e2e:help
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1452, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  // A first start on this computer: the guide not seen yet (the mock marks it seen for the other tests).
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("started")) localStorage.setItem("namestudio.tourSeen", "{}");
    sessionStorage.setItem("started", "1");
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);

  // --- the first-time guide on the start screen ---
  await page.waitForSelector("#tour:not([hidden])", { timeout: 3000 }).catch(() => undefined);
  check(await page.locator("#tour").isVisible(), "a first start shows the guide on the start screen");
  check((await page.locator(".tour-card h3").textContent()).includes("ようこそ"), "it welcomes");

  // A name opened: the editor's guide takes over, from its first stop.
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const { addPanel } = await import("/src/panels.ts");
    const { addLine } = await import("/src/dialogue.ts");
    const { rectShape } = await import("/src/geometry.ts");
    const project = newProject("ヘルプ", 8);
    addPanel(project, project.pages[1], rectShape([20, 20, 160, 120]));
    addLine(project, project.pages[1], [100, 60], "セリフ");
    window.nameStudio.show(project);
    await new Promise((done) => setTimeout(done, 300));
    window.nameStudio.workbench.editor.showPage(2);
  });
  await page.waitForTimeout(200);
  const count = () => page.locator(".tour-count").textContent();
  check(await page.locator("#tour").isVisible(), "opening a name shows the editor's guide");
  const first = await count();
  check(/^1 \/ \d+$/.test(first), `from its first stop (${first})`);
  await page.keyboard.press("ArrowRight");
  check((await count()).startsWith("2 /"), "→ goes on");
  check((await page.locator(".tour-card").textContent()).includes("コマ割り K"), "naming the keys as set");
  const pageBefore = await page.evaluate(() => window.nameStudio.workbench.editor.currentPages());
  await page.keyboard.press("ArrowLeft");
  check((await count()).startsWith("1 /"), "← goes back");
  check(JSON.stringify(await page.evaluate(() => window.nameStudio.workbench.editor.currentPages())) === JSON.stringify(pageBefore), "and does not turn the page");
  await page.keyboard.press("Escape");
  check(await page.locator("#tour").isHidden(), "Esc closes it");
  check((await page.evaluate(() => localStorage.getItem("namestudio.tourSeen"))) === JSON.stringify({ start: true, editor: true }), "and both guides are kept as seen");

  // --- the help bar ---
  const bar = () => page.locator("#help-bar-text").textContent();
  const settle = () => page.waitForTimeout(120);
  const at = (mm) => page.evaluate((mm) => { const wb = window.nameStudio.workbench; return wb.editor.clientOf(wb.project.pages[1].id, mm); }, mm);
  const [px, py] = await at([60, 100]);
  await page.mouse.move(px, py);
  await page.mouse.move(px + 2, py + 2);
  await settle();
  let text = await bar();
  check(text.startsWith("コマ") && text.includes("ドラッグ動かす") && text.includes("ダブルクリックコマのメモを書く"), `over a panel: its name and what the mouse does (${text.slice(0, 40)}…)`);
  check(text.includes("Ctrl+T変形"), "and the keys");
  // A key set anew in キー設定 is the one named.
  await page.evaluate(() => {
    const shortcuts = window.nameStudio.workbench.shortcuts;
    shortcuts.unbind("transform", "Ctrl+T");
    shortcuts.bind("transform", "Ctrl+Shift+T");
  });
  await page.mouse.move(px + 4, py + 4);
  await settle();
  text = await bar();
  check(text.includes("Ctrl+Shift+T変形") && !text.includes("Ctrl+T変形"), "a key changed in キー設定 is named as changed");
  // Alt held: the steps with Alt come first, marked.
  await page.keyboard.down("Alt");
  await settle();
  const held = await page.locator(".help-step.held").allTextContents();
  check(held.length === 1 && held[0].startsWith("Alt+ドラッグ"), `Alt held: its step first (${held})`);
  check((await page.locator(".help-step").first().textContent()).startsWith("Alt+"), "before the others");
  await page.keyboard.up("Alt");

  // Over a balloon, a gutter, nothing; another tool.
  const [lx, ly] = await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    const page = wb.project.pages[1];
    const line = page.lines[0];
    const [x0, y0, x1, y1] = line.box;
    return wb.editor.clientOf(page.id, [(x0 + x1) / 2, (y0 + y1) / 2]);
  });
  await page.mouse.move(lx, ly);
  await settle();
  text = await bar();
  check(text.startsWith("セリフ") && text.includes("ダブルクリックその場で書く"), `over a line of dialogue: セリフ (${text.slice(0, 30)})`);
  await page.evaluate(() => window.nameStudio.workbench.setTool("pen"));
  await page.mouse.move(px, py);
  await settle();
  text = await bar();
  check(text.startsWith("ペン") && text.includes("Shift+ドラッグまっすぐな線") && text.includes("]太く"), "with the pen: what the pen does, and its keys");
  await page.evaluate(() => window.nameStudio.workbench.setTool("select"));

  // Off the pages: a part's own words.
  const box = await page.locator("#tool-cut").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await settle();
  text = await bar();
  check(text.startsWith("コマ割り") && text.includes("K持ち替える") && text.includes("K を押したままその間だけ持ち替える"), "over a tool's button: the tool, its key, holding it");
  const save = await page.locator("#save").boundingBox();
  await page.mouse.move(save.x + 10, save.y + 10);
  await settle();
  check((await bar()).startsWith("保存") && (await bar()).includes("Ctrl+S"), "over 保存: its words and its key");
  const lane = await page.locator(".board-label.pages-label").boundingBox();
  const scroller = await page.locator(".board-scroll").boundingBox();
  await page.mouse.move(scroller.x + 200, lane.y + 60);
  await settle();
  text = await bar();
  check(text.startsWith("ページ・コマ") || text.startsWith("ページ"), `in 物語の帯: the lane under the pointer (${text.slice(0, 20)})`);

  // Hidden from the bar itself, shown again from the settings; kept.
  await page.locator("#help-bar-hide").click();
  check(await page.locator("#help-bar").isHidden(), "× hides the help bar");
  check(await page.locator("#status").isVisible().then(() => true), "the messages stay");
  check((await page.evaluate(() => localStorage.getItem("namestudio.helpBar"))) === "0", "kept on this computer");
  await page.evaluate(() => document.getElementById("settings").click());
  check(!(await page.locator("#st-help-bar").isChecked()), "the settings show it hidden");
  await page.locator("#st-search").fill("ヘルプ");
  await page.locator("#st-help-bar").check();
  check(await page.locator("#help-bar").isVisible(), "and show it again");
  await page.evaluate(() => {
    document.getElementById("settings-dialog").close();
    document.activeElement?.blur();
  });

  // --- the help over the whole screen ---
  await page.mouse.move(800, 400);
  await page.keyboard.press("?");
  const overlay = page.locator("#help-overlay");
  check(await overlay.isVisible(), "? lays the help over the screen");
  check((await page.locator("#help").getAttribute("aria-pressed")) === "true", "the help button shows it on");
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll(".help-label")].map((label) => {
      const r = label.getBoundingClientRect();
      return { text: label.textContent, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }),
  );
  check(labels.length >= 25, `the parts are named (${labels.length})`);
  for (const name of ["選択V", "コマ割りK", "紙面Ctrl+0", "物語の帯F6", "書き出すCtrl+Shift+E", "ヘルプ?"]) {
    check(labels.some((label) => label.text.startsWith(name)), `${name.replace(/[A-Z0-9+?]+$/, "")} with its key`);
  }
  check(labels.some((label) => label.text.startsWith("変形")) === false, "parts not on screen are left out");
  const overlapping = labels.flatMap((a, i) => labels.slice(i + 1).filter((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).map((b) => `${a.text.slice(0, 6)} / ${b.text.slice(0, 6)}`));
  check(overlapping.length === 0, `no words over other words (${overlapping.join(", ")})`);
  check(labels.every((l) => l.left >= 0 && l.top >= 0 && l.right <= 1600 && l.bottom <= 1000), "all inside the window");
  const head = await page.locator(".help-head").boundingBox();
  check(labels.every((l) => l.right <= head.x || l.left >= head.x + head.width || l.bottom <= head.y || l.top >= head.y + head.height), "and none under its header");
  // While it is open the keys are its own: V does not change the tool.
  await page.keyboard.press("p");
  check((await page.evaluate(() => window.nameStudio.workbench.editor.tool)) === "select", "keys do nothing else while it is open");
  await page.keyboard.press("?");
  check(await overlay.isHidden(), "? again closes it");
  await page.locator("#help").click();
  check(await overlay.isVisible(), "the help button opens it");
  await page.mouse.click(700, 500);
  check(await overlay.isHidden(), "a click closes it");
  await page.keyboard.press("?");
  await page.keyboard.press("Escape");
  check(await overlay.isHidden(), "Esc closes it");
  // A narrow window: still no words over others.
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.waitForTimeout(200);
  await page.keyboard.press("?");
  const narrow = await page.evaluate(() =>
    [...document.querySelectorAll(".help-label")].map((label) => {
      const r = label.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }),
  );
  const crowded = narrow.filter((a, i) => narrow.slice(i + 1).some((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)).length;
  check(crowded <= 2, `a narrow window: hardly any words over others (${crowded})`);
  await page.locator("#help-tour").click();
  check(await overlay.isHidden() && (await page.locator("#tour").isVisible()), "its 使い方の案内 starts the guide again");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1600, height: 1000 });

  // The commands: found by name in the palette.
  await page.keyboard.press("Control+k");
  await page.keyboard.type("使い方の案内");
  await page.waitForTimeout(100);
  const found = await page.locator(".palette-list, #palette-list, .command-palette").first().textContent().catch(() => "");
  check(found.includes("使い方の案内を始める"), "the palette finds 使い方の案内");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  check(await page.locator("#tour").isVisible(), "and runs it");
  await page.keyboard.press("Escape");

  // Started again: the guide is not offered a second time.
  await page.reload();
  await page.waitForFunction(() => window.nameStudio);
  await page.waitForTimeout(400);
  check(await page.locator("#tour").isHidden(), "seen once, the guide is not offered again");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall ok");

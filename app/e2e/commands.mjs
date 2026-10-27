// Smaller things that save steps: the コマ割り modes and 保留 as commands
// (keys can be set for them), pages added many at once, where a held panel
// would go while it is dragged, and stopping an export part way.
// Run: npm run e2e:commands
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1442, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(() => {
    window.__answer = (command) => {
      if (command === "plugin:dialog|save") return "C:\\\\ネーム\\\\読む.pdf";
      if (command === "write_pdf") return null;
      return undefined;
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  const ids = await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const { addPanel } = await import("/src/panels.ts");
    const { rectShape } = await import("/src/geometry.ts");
    const project = newProject("命令", 40);
    const first = project.pages[0];
    const a = addPanel(project, first, rectShape([20, 20, 100, 80]));
    const b = addPanel(project, first, rectShape([20, 100, 160, 200]));
    window.nameStudio.show(project);
    await new Promise((done) => setTimeout(done, 300));
    return { page: first.id, a: a.id, b: b.id };
  });
  const wb = (fn, arg) => page.evaluate(fn, arg);
  const undos = () => wb(() => window.nameStudio.workbench.session.history.undoStack.length);

  // コマ割りの作り方: commands, the tool coming too.
  await wb(() => window.nameStudio.workbench.setTool("pen"));
  await wb(() => window.nameStudio.workbench.run("panel.modeRect"));
  let s = await wb(() => ({ tool: window.nameStudio.workbench.editor.tool, mode: window.nameStudio.workbench.editor.panelMode }));
  check(s.tool === "cut" && s.mode === "rect", `「コマ割り: 四角」 takes the tool and the mode (${JSON.stringify(s)})`);
  check(await page.locator("#panel-rect").evaluate((b) => b.classList.contains("active")), "and the bar shows it");
  await wb(() => window.nameStudio.workbench.run("panel.modePolygon"));
  check((await wb(() => window.nameStudio.workbench.editor.panelMode)) === "polygon", "「多角形」 too");
  const keyed = await wb(() => window.nameStudio.workbench.shortcuts.keys("panel.modeCut"));
  check(Array.isArray(keyed), "the modes are in the key settings");

  // 保留 as a command, for the selected panel.
  await wb(() => window.nameStudio.workbench.setTool("select"));
  check(!(await wb(() => window.nameStudio.workbench.run("panel.hold"))), "with no panel selected, 保留 does nothing");
  await wb((ids) => window.nameStudio.workbench.editor.select({ kind: "panel", pageId: ids.page, id: ids.a }), ids);
  const before = await undos();
  check(await wb(() => window.nameStudio.workbench.run("panel.hold")), "the selected panel goes to 保留");
  s = await wb(() => ({ held: window.nameStudio.workbench.project.held?.length ?? 0, panels: window.nameStudio.workbench.project.pages[0].panels.length }));
  check(s.held === 1 && s.panels === 1 && (await undos()) === before + 1, `in one undo step (${JSON.stringify(s)})`);

  // Where it would go, while it is dragged from the 保留 list.
  await wb(() => window.nameStudio.workbench.docks.open("held"));
  const target = await wb((ids) => {
    const editor = window.nameStudio.workbench.editor;
    return { into: editor.clientOf(ids.page, [90, 150]), place: editor.clientOf(ids.page, [150, 60]) };
  }, ids);
  const hint = () => page.locator(".drop-hint-label").evaluate((label) => (label.style.display === "none" ? null : label.textContent));
  await page.locator(".held-item").first().hover();
  await page.mouse.down();
  await page.mouse.move(target.into[0], target.into[1], { steps: 8 });
  const into = await hint();
  await page.mouse.move(target.place[0], target.place[1], { steps: 8 });
  const place = await hint();
  await page.mouse.up();
  check(into?.includes("コマ") && into?.includes("に中身を入れる"), `over a panel: its contents go in it (${into})`);
  check(place === "1 ページのここに置く", `elsewhere: put there (${place})`);
  check((await hint()) === null, "the hint goes with the drop");
  check((await wb(() => window.nameStudio.workbench.project.held?.length ?? 0)) === 0, "and the drop puts it");

  // Pages, many at once: one undo step.
  await wb(() => window.nameStudio.workbench.docks.open("pages"));
  const pages = () => wb(() => window.nameStudio.workbench.project.pages.length);
  const [count, steps] = [await pages(), await undos()];
  await page.fill("#add-page-count", "4");
  await page.dispatchEvent("#add-page-count", "change");
  await page.click("#add-pages");
  check((await pages()) === count + 4 && (await undos()) === steps + 1, "4 pages added at the end, in one undo step");

  // Stopping a PDF part way: nothing written.
  await page.click("#name-export");
  await page.click("#ne-kind-pdf");
  await page.selectOption("#ne-pdf-dpi", "300");
  await page.click("#ne-run");
  await page.waitForFunction(() => /PDF: \d+ \//.test(document.getElementById("status").textContent));
  check(await page.locator("#ne-stop").isVisible(), "中止 shows while it is written");
  await page.click("#ne-stop");
  await page.waitForFunction(() => document.getElementById("ne-stop").hidden, null, { timeout: 30000 });
  const written = await wb(() => window.__calls.some((call) => call.command === "write_pdf"));
  const message = await page.locator("#status").textContent();
  check(!written && message === "書き出しをやめました（何も書き換えていません）", `中止 stops before the file is written (${message})`);

  // 読み戻し one change at a time: all ticked to start with, the unticked stay as the name has them.
  await page.keyboard.press("Escape");
  await wb(async () => {
    const { chooseTakeBack } = await import("/src/readbackpick.ts");
    const plan = {
      retyped: [{ page: 0, line: "a", from: "今日も", to: "今夜も" }],
      added: [{ text: "……", page: 1, box: null }],
      removed: [{ page: 2, line: "c", text: "ねえ" }],
      conflicts: [],
      unrecorded: [],
      missing: [],
      paths: ["out/page0001.clip"],
    };
    window.__picked = chooseTakeBack(plan, "out");
  });
  const go = page.locator("#readback-go");
  check((await page.locator("#readback-pick .readback-item input:checked").count()) === 3 && (await go.textContent()) === "3 件を読み戻す", "every change is listed, ticked");
  await page.locator("#readback-pick .readback-item").filter({ hasText: "ねえ" }).locator("input").uncheck();
  check((await go.textContent()) === "2 件を読み戻す", "the button counts what is ticked");
  await go.click();
  const picked = await wb(async () => {
    const plan = await window.__picked;
    return [plan.retyped.length, plan.added.length, plan.removed.length];
  });
  check(JSON.stringify(picked) === "[1,1,0]" && (await page.locator("#readback-pick").count()) === 0, `only the ticked are taken back (${picked})`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\ncommands checked");

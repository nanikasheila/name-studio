// 管理画面の一覧操作: 人物・台本・付箋・保留・レイヤー・シリーズ・物語の帯・
// サブツール have the page list's operations — a right-click menu, Ctrl /
// Shift + click, and the same keys (Insert, Ctrl+D, Delete, Alt+↑↓, Ctrl+C/V,
// F2) — each one undo step, plus what each list needs of its own.
// Run: npm run e2e:lists
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.SHOTS;
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1447, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(() => {
    window.__asked = [];
    window.__answer = (command, args) => {
      if (command === "plugin:dialog|message") {
        window.__asked.push(args?.message ?? "");
        return "Yes";
      }
      return undefined;
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const { addPanel } = await import("/src/domain/panels.ts");
    const { addLine } = await import("/src/domain/dialogue.ts");
    const { addCharacter, addScene } = await import("/src/domain/cast.ts");
    const { addSticky } = await import("/src/domain/stickies.ts");
    const { holdPanel } = await import("/src/domain/hold.ts");
    const { rectShape } = await import("/src/model/geometry.ts");
    const project = newProject("一覧の操作", 6);
    const [a, b, c] = ["ユメ", "ノスト", "ユメ（取り込み）"].map((n) => addCharacter(project, n));
    const p1 = project.pages[0];
    addPanel(project, p1, rectShape([20, 20, 160, 120]));
    addPanel(project, p1, rectShape([20, 130, 160, 230]));
    const said = [
      [a, "おはよう"],
      [b, "こんにちは"],
      [c, "またね"],
    ];
    said.forEach(([who, text], i) => {
      const line = addLine(project, p1, [60 + i * 30, 60], text);
      line.speaker = who.id;
    });
    addSticky(project, p1, [20, 300], "ここ迷う");
    addSticky(project, project.pages[1], [20, 300], "あとで");
    const p3 = project.pages[2];
    for (const x of [20, 100]) {
      const panel = addPanel(project, p3, rectShape([x, 20, x + 60, 80]));
      addLine(project, p3, [x + 30, 50], `保留${x}`);
      holdPanel(project, p3, panel);
    }
    addScene(project, project.pages[0].id, project.pages[3].id, "朝");
    addScene(project, project.pages[4].id, project.pages[5].id, "夜");
    window.nameStudio.show(project);
    await new Promise((done) => setTimeout(done, 300));
  });
  const wb = (fn, arg) => page.evaluate(fn, arg);
  const undos = () => wb(() => window.nameStudio.workbench.session.history.undoStack.length);
  const project = (fn) => page.evaluate(`(${fn})(window.nameStudio.workbench.project)`);
  const menuItem = (label) => page.locator(".popup-menu button", { hasText: label });
  const open = async (id) => {
    await wb((which) => window.nameStudio.workbench.docks.open(which), id);
    await page.waitForTimeout(100);
  };

  // --- 人物 ---------------------------------------------------------------------------
  await open("cast");
  const grip = (n) => page.locator("#side-cast .cast-block .list-grip").nth(n - 1);
  const names = () => project((p) => p.characters.map((c) => c.name).join(","));
  await grip(1).click();
  await page.keyboard.press("Control+d");
  check((await names()) === "ユメ,ユメのコピー,ノスト,ユメ（取り込み）", `Ctrl+D copies a character behind it (${await names()})`);
  await page.locator("#side-cast").focus();
  await page.keyboard.press("Delete");
  check((await names()) === "ユメ,ノスト,ユメ（取り込み）", `Delete removes the copy (${await names()})`);
  await grip(3).click();
  let before = await undos();
  await page.keyboard.press("Alt+ArrowUp");
  check((await names()) === "ユメ,ユメ（取り込み）,ノスト", `Alt+↑ moves it one up (${await names()})`);
  check((await undos()) === before + 1, "in one undo step");
  await grip(1).click();
  await grip(2).click({ modifiers: ["Control"] });
  check((await page.locator("#side-cast .cast-block.picked").count()) === 2, "Ctrl+click picks a second character");
  await grip(1).click({ button: "right" });
  check(await page.locator(".popup-menu").isVisible(), "right click opens the menu");
  if (shots) await page.screenshot({ path: `${shots}/cast-menu.png` });
  await menuItem("1 人にまとめる").click();
  check((await names()) === "ユメ,ノスト", `「1 人にまとめる」 merges them (${await names()})`);
  const speakers = await project((p) => p.pages[0].lines.map((l) => p.characters.find((c) => c.id === l.speaker)?.name).join(","));
  check(speakers === "ユメ,ノスト,ユメ", `and the lines go to the one kept (${speakers})`);
  await grip(2).click();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Insert");
  check((await names()).split(",").length === 3, `Insert adds a character (${await names()})`);
  await page.keyboard.press("Escape");
  await page.locator("#side-cast").focus();
  await page.keyboard.press("Control+v");
  check(
    await wb(() => document.querySelector("#status")?.textContent?.includes("同じ名前")),
    "pasting a character the name has is left out (said so)",
  );

  // --- 台本 ---------------------------------------------------------------------------
  await open("script");
  const line = (n) => page.locator("#side-script .script-line").nth(n - 1);
  await line(1).click();
  await line(3).click({ modifiers: ["Shift"] });
  check((await page.locator("#side-script .script-line.picked").count()) === 3, "Shift+click picks three lines");
  await line(2).click({ button: "right" });
  check(await menuItem("話者を「ノスト」に").isVisible(), "the menu has the speakers");
  await menuItem("話者を「ノスト」に").click();
  const all = await project((p) => p.pages[0].lines.every((l) => p.characters.find((c) => c.id === l.speaker)?.name === "ノスト"));
  check(all, "and gives all three another speaker at once");
  await line(1).click();
  await line(2).click({ modifiers: ["Control"] });
  before = await undos();
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => window.nameStudio.workbench.project.pages[0].lines.length === 1);
  check((await undos()) === before + 1, "Delete removes the two picked lines in one step");
  await wb(() => window.nameStudio.workbench.undo());

  // --- 付箋 ---------------------------------------------------------------------------
  await open("notes");
  const stickies = () => project((p) => p.pages.reduce((n, pg) => n + (pg.stickies?.length ?? 0), 0));
  await wb(() => window.nameStudio.workbench.editor.showPage(1));
  await page.locator("#side-notes").focus();
  await page.keyboard.press("Insert");
  check((await stickies()) === 3, "Insert sticks a new 付箋 on the page worked on");
  await page.locator("#side-notes").focus();
  await page.locator("#side-notes").press("Control+a");
  check((await page.locator("#side-notes .note-item.picked").count()) === 3, "Ctrl+A picks every 付箋");
  await page.locator("#side-notes .note-item").first().click({ button: "right" });
  await menuItem("桃にする").click();
  check(
    (await project((p) => p.pages.flatMap((pg) => pg.stickies ?? []).every((s) => s.color === "pink"))) === true,
    "the menu gives them all another colour",
  );
  await page.locator("#side-notes .note-filter").nth(1).click();
  check((await page.locator("#side-notes .note-item").count()) === 3, "the colour filter keeps the pink ones");
  await page.locator("#side-notes .note-filter").nth(1).click();
  await page.locator("#side-notes .note-filter").nth(0).click();
  check((await page.locator("#side-notes .note-item").count()) === 0, "and the yellow filter none of them");
  await page.locator("#side-notes .note-filter").nth(0).click();
  await page.locator("#side-notes .note-item").first().click();
  await page.keyboard.press("Delete");
  check((await stickies()) === 2, "Delete takes a 付箋 off as 済み");

  // --- 保留 ---------------------------------------------------------------------------
  await open("held");
  const heldWords = () => project((p) => (p.held ?? []).map((h) => h.lines[0]?.text).join(","));
  check((await heldWords()) === "保留20,保留100", `two held panels (${await heldWords()})`);
  await page
    .locator("#side-held .held-item")
    .first()
    .click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+d");
  check((await heldWords()) === "保留20,保留20,保留100", `Ctrl+D copies a held panel (${await heldWords()})`);
  await page
    .locator("#side-held .held-item")
    .nth(2)
    .click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Alt+ArrowUp");
  check((await heldWords()) === "保留20,保留100,保留20", `Alt+↑ moves it up (${await heldWords()})`);
  await page
    .locator("#side-held .held-item")
    .nth(1)
    .click({ button: "right", position: { x: 4, y: 4 } });
  check(await menuItem("このページに置く").isVisible(), "the menu puts it on the page");
  await page.keyboard.press("Escape");
  await page
    .locator("#side-held .held-item")
    .nth(0)
    .click({ position: { x: 4, y: 4 } });
  await page
    .locator("#side-held .held-item")
    .nth(1)
    .click({ position: { x: 4, y: 4 }, modifiers: ["Control"] });
  await page.keyboard.press("Delete");
  check((await heldWords()) === "保留20", `Delete drops the two picked (${await heldWords()})`);

  // --- レイヤー -------------------------------------------------------------------------
  await wb(() => window.nameStudio.workbench.editor.showPage(1));
  await open("layers");
  const layerNames = () => project((p) => (p.roughLayers ?? []).map((l) => l.name).join(","));
  await page.locator("#rough-layers .rough-row").last().locator(".layer-name").click();
  await page.keyboard.press("Control+d");
  check((await layerNames()) === "ラフ線,ラフ線のコピー", `Ctrl+D copies a ラフ線のレイヤー (${await layerNames()})`);
  await page.locator("#rough-layers .rough-row").first().locator(".layer-name").click({ button: "right" });
  check(await menuItem("下のレイヤーと結合").isVisible(), "its menu merges down");
  await page.keyboard.press("Escape");
  await page.locator("#rough-layers").focus();
  await page.keyboard.press("Control+e");
  check((await layerNames()) === "", `Ctrl+E merges it down (${await layerNames()})`);
  const panelRows = page.locator("#layer-rows .layer-row[data-panel]");
  await panelRows.nth(0).click();
  await panelRows.nth(1).click({ modifiers: ["Control"] });
  const kind = await wb(() => window.nameStudio.workbench.editor.selection?.kind);
  check(kind === "group", `Ctrl+click on two panel rows selects both on the page (${kind})`);
  const panels = () => project((p) => p.pages[0].panels.length);
  const had = await panels();
  await page.keyboard.press("Control+d");
  check((await panels()) === had + 2, "Ctrl+D in the layer list duplicates them");
  await wb(() => window.nameStudio.workbench.undo());

  // --- 物語の帯: シーン --------------------------------------------------------------
  const scenes = () => project((p) => p.scenes.map((s) => s.title).join(","));
  await wb(() => window.nameStudio.workbench.board.toggleWide(true));
  await page.waitForTimeout(300);
  const opened = await wb(() => {
    const bar = document.querySelector(".scene-lane rect.scene[data-scene]");
    if (!bar) return false;
    const box = bar.getBoundingClientRect();
    bar.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + 4 }),
    );
    return true;
  });
  check(opened, "the story band shows the scenes");
  if (opened) {
    check(await page.locator(".popup-menu").isVisible(), "right click on a scene opens its menu");
    if (shots) await page.screenshot({ path: `${shots}/scene-menu.png` });
    await menuItem("別のシーンに分ける").click();
    check((await scenes()).split(",").length === 3, `「分ける」 splits it (${await scenes()})`);
    await page.waitForTimeout(150);
    await wb(() => {
      const bar = document.querySelectorAll(".scene-lane rect.scene[data-scene]")[1];
      const box = bar.getBoundingClientRect();
      bar.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 4, clientY: box.top + 4 }));
    });
    await menuItem("とつなぐ").first().click();
    check((await scenes()) === "朝,夜", `「前のシーンとつなぐ」 joins them back (${await scenes()})`);
  }
  await wb(() => window.nameStudio.workbench.board.toggleWide(false));

  // --- サブツール --------------------------------------------------------------------
  await open("subtools");
  await wb(() => window.nameStudio.workbench.setTool("pen"));
  await page.waitForTimeout(100);
  await page.locator("#side-subtools .subtool-row").first().click({ button: "right" });
  check(await menuItem("キーを割り当てる").isVisible(), "the pen list's menu is the same kind of menu");
  check(await menuItem("複製して後ろに入れる").isVisible(), "with 複製");
  await page.keyboard.press("Escape");

  check(errors.length === 0, `no page errors ${errors.join(" / ")}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nlists checked");

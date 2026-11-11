// 欄の配置 as a person changes it (as CSP's palette docks): a palette's header
// dragged to a column's edge makes a new column (up to three a side), onto
// another palette's header makes it a tab there, onto the pages floats it; the
// ≡ menu does the same by name; a floating palette moves by its header and
// goes back into a column when let go over one; the sub tools are as tall as
// they hold; all of it is kept for the next start; and the screen as it is can
// be kept under a name and gone back to (名前をつけた配置).
// Run: npm run e2e:docks   (SHOTS=<folder> keeps pictures)
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const show = async () => {
    await page.waitForFunction(() => window.nameStudio);
    await page.evaluate(async () => {
      const { sampleName } = await import("/src/domain/samplename.ts");
      window.nameStudio.show(sampleName());
    });
    await page.waitForTimeout(300);
  };
  await page.goto(server.resolvedUrls.local[0]);
  await show();
  const layout = () => page.evaluate(() => structuredClone(window.nameStudio.workbench.docks.layout));
  const cols = (side) => page.locator(`#dock-${side} .dock-col`);
  const header = (id) => page.locator(`.palette[data-lead="${id}"] > header`).first();

  // Out of the box: one column a side, the icons by the window's edge.
  check((await cols("left").count()) === 1 && (await cols("right").count()) === 1, "one column a side");
  const rail = await page.locator("#dock-left .dock-rail").boundingBox();
  const col = await cols("left").first().boundingBox();
  check(rail.x < col.x && rail.height > rail.width * 3, "the icons stand in a row by the window's edge");
  const sub = await page.locator('.palette[data-lead="subtools"]').boundingBox();
  const pages = await page.locator('.palette[data-lead="pages"]').boundingBox();
  check(sub.height < pages.height, `サブツール is as tall as it holds, the page list takes the rest (${sub.height} < ${pages.height})`);

  // Drag ページ to the left column's inner edge: a new column.
  const box = await cols("left").first().boundingBox();
  await header("pages").dragTo(cols("left").first(), { targetPosition: { x: box.width - 6, y: box.height / 2 } });
  let l = await layout();
  check((await cols("left").count()) === 2 && l.palettes.pages.col === 1, "a header dropped at a column's inner edge makes a new column");
  // 台本 as a tab of ページ: by its icon, then its header onto ページ's header.
  await page.click("#tab-script");
  await header("script").dragTo(header("pages"));
  l = await layout();
  check(l.palettes.script.tab === "pages", "a header dropped on another's header makes it a tab there");
  check((await page.locator('.palette[data-lead="pages"] .palette-tab').count()) === 2, "the frame shows both tabs");
  check(await page.locator("#side-script").isVisible(), "the tab dropped is in front");
  await page.locator('.palette[data-lead="pages"] .palette-tab[data-palette="pages"]').click();
  check(
    (await page.locator("#side-pages").isVisible()) && !(await page.locator("#side-script").isVisible()),
    "a click on a tab brings it to the front",
  );
  // The ≡ menu: レイヤー into a third column, then no more.
  await page.click("#tab-layers-edit");
  await page.locator('.palette[data-lead="layers"] .palette-menu').click();
  await page.locator(".popup-menu button", { hasText: "新しい列を作って移す" }).click();
  check((await cols("left").count()) === 3, "≡ › 新しい列 makes a third column");
  await page.locator('.palette[data-lead="subtools"] .palette-menu').click();
  check(await page.locator(".popup-menu button", { hasText: "新しい列を作って移す" }).isDisabled(), "and a fourth cannot be made");
  await page.keyboard.press("Escape");
  // Widths, each column its own.
  const second = cols("left").nth(1);
  const before = (await second.boundingBox()).width;
  const handle = await second.locator(".dock-resize").boundingBox();
  await page.mouse.move(handle.x + 3, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x - 37, handle.y + 200, { steps: 5 });
  await page.mouse.up();
  check(Math.abs((await second.boundingBox()).width - before + 40) < 3, "a column's edge changes its own width");
  if (shots) await page.screenshot({ path: `${shots}/docks-columns.png` });

  // Float ツールプロパティ over the pages.
  const stage = await page.locator("#editor .stage-column").boundingBox();
  await header("toolprops").dragTo(page.locator("#editor-canvas"), { targetPosition: { x: 80, y: 200 } });
  l = await layout();
  check(!!l.palettes.toolprops.float, "a header dropped on the pages floats the palette there");
  const floating = page.locator(".dock-floats .palette.floating");
  check((await floating.count()) === 1 && (await page.locator("#side-toolprops").isVisible()), "it shows over the pages");
  const at = await floating.boundingBox();
  check(at.x > stage.x && at.x < stage.x + 400, "where it was dropped");
  // Moved by its header.
  const head = await floating.locator("header").boundingBox();
  await page.mouse.move(head.x + 40, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x + 140, head.y + head.height / 2 + 100, { steps: 6 });
  await page.mouse.up();
  const moved = await floating.boundingBox();
  check(Math.abs(moved.x - at.x - 100) < 3 && Math.abs(moved.y - at.y - 100) < 3, "dragged by its header, it moves");
  if (shots) await page.screenshot({ path: `${shots}/docks-float.png` });

  // Kept for the next start.
  await page.reload();
  await show();
  l = await layout();
  check(
    (await cols("left").count()) === 3 && l.palettes.script.tab === "pages" && !!l.palettes.toolprops.float,
    "columns, tabs and the floating palette are kept for the next start",
  );

  // Let go over a column: back in it.
  const fhead = await page.locator(".dock-floats .palette.floating header").boundingBox();
  const target = await page.locator('.palette[data-lead="subtools"]').boundingBox();
  await page.mouse.move(fhead.x + 40, fhead.y + fhead.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 4, { steps: 10 });
  await page.mouse.up();
  l = await layout();
  check(!l.palettes.toolprops.float && l.palettes.toolprops.side === "left", "a floating palette let go over a column goes into it");
  check((await page.locator(".dock-floats .palette").count()) === 0, "and floats no more");

  // Tab out by the menu; the right side.
  await page.locator('.palette[data-lead="pages"] .palette-tab[data-palette="script"]').click({ button: "right" });
  await page.locator(".popup-menu button", { hasText: "タブから外す" }).click();
  l = await layout();
  check(l.palettes.script.tab === null && (await page.locator("#side-script").isVisible()), "タブから外す: on its own again");
  await page.locator('.palette[data-lead="layers"] .palette-menu').click();
  await page.locator(".popup-menu button", { hasText: "右の欄へ移す" }).click();
  l = await layout();
  check(l.palettes.layers.side === "right" && (await cols("left").count()) === 2, "右の欄へ: its column, now empty, goes");
  // 高さを中身に合わせる / 分ける.
  await page.locator('.palette[data-lead="subtools"] .palette-menu').click();
  await page.locator(".popup-menu button", { hasText: "高さを列に合わせて分ける" }).click();
  check(!(await layout()).palettes.subtools.fit, "≡ › 高さを列に合わせて分ける");

  // 名前をつけた配置: the screen as it is, kept under a name and gone back to.
  await page.click("#ws-mine");
  await page.locator(".popup-menu button", { hasText: "今の配置に名前をつけて残す" }).click();
  check(await page.locator("#workspace-dialog").evaluate((d) => d.open), "▾ › 名前をつけて残す opens the dialog");
  await page.fill("#ws-name", "二列");
  await page.press("#ws-name", "Enter");
  check((await page.locator("#ws-list .ws-row").count()) === 1, "Enter keeps it under the name");
  if (shots) await page.locator("#workspace-dialog").screenshot({ path: `${shots}/docks-workspaces.png` });
  await page.keyboard.press("Escape");
  check((await page.textContent("#ws-mine-name")) === "二列", "the ▾ shows the name in use");
  await page.click("#ws-overview");
  check((await layout()).palettes.layers.side === "left", "全体 is as it comes");
  await page.click("#ws-mine");
  await page.locator(".popup-menu button", { hasText: "二列" }).click();
  l = await layout();
  check(l.palettes.layers.side === "right" && (await cols("left").count()) === 2, "▾ › its name brings it back, columns and all");
  // Renamed and taken away in the dialog.
  await page.click("#ws-mine");
  await page.locator(".popup-menu button", { hasText: "整理" }).click();
  const name = page.locator("#ws-list .ws-row input");
  await name.fill("ふたつ");
  await name.press("Enter");
  check((await page.textContent("#ws-mine-name")) === "ふたつ", "renamed, the ▾ follows");
  await page.locator("#ws-list .ws-row button", { hasText: "消す" }).click();
  check((await page.locator("#ws-list .ws-row").count()) === 0 && (await page.textContent("#ws-mine-name")) === "", "消す takes it away");
  await page.keyboard.press("Escape");
  check(errors.length === 0, `no page errors ${errors.join("; ")}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

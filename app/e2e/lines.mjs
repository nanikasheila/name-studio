// セリフ種類 × キャラのフキダシ設定 and 白縁: a type made in 設定 › セリフ,
// chosen in the 種類 menu on the right; a character's フキダシ設定 in 人物 that
// their lines follow; 白縁 on a line, drawn round the letters.
// Run: npm run e2e:lines
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
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const { addLine } = await import("/src/domain/dialogue.ts");
    const project = newProject("セリフ", 2);
    project.characters = [
      { id: "c1", name: "ミオ", color: "#d23c78" },
      { id: "c2", name: "ソラ", color: "#2878d2" },
    ];
    const first = project.pages[0];
    const a = addLine(project, first, [60, 60], "おはよう");
    a.speaker = "c1";
    a.id = "line-a";
    const b = addLine(project, first, [120, 120], "まって！");
    b.speaker = "c2";
    b.id = "line-b";
    window.nameStudio.show(project);
  });
  await page.waitForTimeout(400);
  const line = (id) =>
    page.evaluate((id) => {
      const found = window.nameStudio.workbench.project.pages[0].lines.find((l) => l.id === id);
      return JSON.parse(JSON.stringify(found));
    }, id);
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  const select = (id) =>
    page.evaluate((id) => {
      const wb = window.nameStudio.workbench;
      wb.editor.select({ kind: "line", pageId: wb.project.pages[0].id, id });
    }, id);

  // --- 設定 › セリフ: a type 叫び, トゲ and 白抜き ---
  await page.click("#settings");
  await page.fill("#st-search", "種類を足す");
  check(await page.locator("#st-line-types").isVisible(), "searching 種類を足す finds the types");
  await page.locator("#st-line-types button", { hasText: "種類を足す" }).click();
  check((await page.locator("#st-line-types .line-type").count()) === 1, "＋ 種類を足す makes a type");
  const type = page.locator("#st-line-types .line-type").first();
  await type.locator(".line-type-name").fill("叫び");
  await type.locator(".line-type-name").press("Enter");
  await page.waitForTimeout(50);
  await type.locator(".look-row", { hasText: "形" }).locator("select").selectOption("spike");
  await page.locator("#st-line-types .line-type").first().locator(".look-row", { hasText: "白抜き" }).locator("select").selectOption("on");
  const types = await page.evaluate(() => window.nameStudio.workbench.project.lineTypes);
  check(
    types?.length === 1 &&
      types[0].name === "叫び" &&
      types[0].shape === "spike" &&
      types[0].inverted === true &&
      types[0].base === "speech",
    `the type keeps its name and look (${JSON.stringify(types)})`,
  );
  await page.fill("#st-search", "");
  await page.locator(".settings-nav-item").first().focus();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  check(!(await page.locator("#settings-dialog").isVisible()), "設定 closes");

  // --- the 種類 menu on the right: 叫び under 作った種類 ---
  await select("line-b");
  await page.waitForTimeout(100);
  const kind = page.locator("#inspector label", { hasText: "種類" }).locator("select").first();
  check((await kind.locator("optgroup option", { hasText: "叫び" }).count()) === 1, "the 種類 menu lists the type made");
  await kind.selectOption({ label: "叫び" });
  await page.waitForTimeout(50);
  let b = await line("line-b");
  check(
    b.type === types[0].id && b.balloonShape === "spike" && b.inverted === true,
    `the line takes the type's look (${JSON.stringify(b)})`,
  );
  await blur();
  await page.keyboard.press("Control+z");
  b = await line("line-b");
  check(b.type === undefined && b.balloonShape === undefined && !b.inverted, "undone in one go");
  await page.keyboard.press("Control+y");
  b = await line("line-b");
  check(b.type === types[0].id && b.inverted === true, "and done again");

  // --- 白縁 on a line, and it is drawn ---
  await select("line-a");
  await page.waitForTimeout(100);
  const edge = page.locator("#inspector label", { hasText: "白縁" }).locator("input");
  check(!(await edge.isChecked()), "白縁 starts off");
  await edge.check();
  check((await line("line-a")).edge === true, "白縁 is kept on the line");

  // --- 人物 › フキダシ設定: ミオ's lines follow ---
  await page.locator("#tab-cast").click();
  await page.waitForTimeout(100);
  const mio = page.locator("#side-cast .cast-look").first();
  await mio.locator("summary").click();
  await mio.locator(".look-row", { hasText: "形" }).locator("select").selectOption("rounded");
  await page.waitForTimeout(50);
  await page.locator("#side-cast .cast-look").first().locator(".look-row", { hasText: "大きさ" }).locator("input").fill("14");
  await page.locator("#side-cast .cast-look").first().locator(".look-row", { hasText: "大きさ" }).locator("input").press("Enter");
  await page.waitForTimeout(50);
  const a = await line("line-a");
  check(
    a.balloonShape === "rounded" && a.fontSizePt === 14 && a.edge === true,
    `ミオ's line follows her フキダシ設定 (${JSON.stringify(a)})`,
  );
  check(
    (await page.evaluate(() => window.nameStudio.workbench.project.characters[0].look))?.shape === "rounded",
    "the look is kept on the character",
  );
  check((await page.locator("#side-cast .cast-look summary").first().textContent()).includes("2 項目"), "the summary counts what is set");
  b = await line("line-b");
  check(b.balloonShape === "spike" && b.fontSizePt !== 14, "ソラ's line is left as it was");

  // --- the speaker changed to ミオ: 叫び's line takes her shape and size ---
  await select("line-b");
  await page.waitForTimeout(100);
  await page.locator("#inspector label", { hasText: "話者" }).locator("select").selectOption("c1");
  b = await line("line-b");
  check(
    b.balloonShape === "rounded" && b.fontSizePt === 14 && b.inverted === true,
    `a new speaker brings their look (${JSON.stringify(b)})`,
  );

  check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall passed");

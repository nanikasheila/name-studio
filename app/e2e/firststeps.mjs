// The first minutes with the app: Enter in a dialog's field does what was
// meant (作る, not やめる; the settings stay open), the top bar fits a
// 1280 px window with the file name shown, a line across a blank page's
// 基本枠 cuts it, 見本で試す opens the sample with the guide on it, 大きめ is
// offered once when a pen is used, and the help over the screen lays its
// words clear of each other. Run: npm run e2e:firststeps
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1463, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
const errors = [];
async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  return page;
}
const isOpen = (page, id) => page.evaluate((id) => document.getElementById(id).open, id);
const project = (page) => page.evaluate(() => window.nameStudio.workbench.project);

try {
  // 新しいネーム: a title typed and Enter makes the name.
  const page = await open(1366, 768);
  await page.click("#start-new");
  await page.locator("#nn-title").fill("はじめてのネーム");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.nameStudio.workbench.project !== null, null, { timeout: 5000 }).catch(() => undefined);
  const made = await project(page);
  check(
    made?.title === "はじめてのネーム" && made.pages.length === 16,
    `Enter in the title of 新しいネーム makes the name (${made?.title}, ${made?.pages.length} pages)`,
  );

  // The Enter that settles かな漢字変換 is the field's own: the dialog stays.
  await page.click("#new-project");
  await page.locator("#nn-title").focus();
  await page.evaluate(() => {
    const field = document.getElementById("nn-title");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
  });
  check(await isOpen(page, "new-dialog"), "Enter while a word is being composed leaves the dialog open");
  await page.keyboard.press("Escape");
  check(
    !(await isOpen(page, "new-dialog")) && (await project(page)).title === "はじめてのネーム",
    "Esc still closes it, and the name is as it was",
  );

  // 設定: Enter in the search and in a number keeps the settings open; the number is taken.
  await page.click("#settings");
  const search = page.locator("#settings-dialog input[type=search], #settings-dialog input[placeholder*='設定を探す']").first();
  await search.fill("コマ間");
  await page.keyboard.press("Enter");
  check(await isOpen(page, "settings-dialog"), "Enter in the settings' search keeps the settings open");
  await search.fill("");
  const gutter = page.locator("#settings-dialog input[type=number]:visible").first();
  await gutter.fill("3.5");
  await page.keyboard.press("Enter");
  const kept = await page.evaluate(() => window.nameStudio.workbench.project.gutters);
  check(
    (await isOpen(page, "settings-dialog")) && JSON.stringify(kept).includes("3.5"),
    `Enter in a number of the settings takes it and stays (${JSON.stringify(kept)})`,
  );
  check(await page.evaluate(() => document.activeElement?.matches("#settings-dialog input[type=number]")), "the field keeps the focus");
  await page.keyboard.press("Escape");

  // 書き出す: Enter in 作品名 does not close the dialog (and does not start writing).
  await page.click("#name-export");
  const before = await page.evaluate(() => window.__calls.length);
  const title = page.locator("#name-export-dialog input[type=text]:visible").first();
  await title.fill("書き出す名前");
  await page.keyboard.press("Enter");
  const wrote = await page.evaluate((before) => window.__calls.slice(before).some((c) => /export|write_/.test(c.command)), before);
  check((await isOpen(page, "name-export-dialog")) && !wrote, "Enter in the export's 作品名 keeps the dialog open and writes nothing");
  await page.keyboard.press("Escape");

  // A blank page: a line across the 基本枠 with コマ割り cuts it in two; one undo takes both back.
  await page.keyboard.press("k");
  const at = (mm) =>
    page.evaluate((mm) => {
      const { editor, project } = window.nameStudio.workbench;
      return editor.clientOf(project.pages[0].id, mm);
    }, mm);
  const [ax, ay] = await at([30, 180]);
  const [bx, by] = await at([230, 181]);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps: 8 });
  await page.mouse.up();
  let panels = (await project(page)).pages[0].panels;
  check(panels.length === 2, `a line across a blank page's 基本枠 makes two panels (${panels.length})`);
  const status = await page.evaluate(() => document.getElementById("status").textContent);
  check(status.includes("基本枠をコマにして"), `and says so (${status})`);
  await page.keyboard.press("Control+z");
  panels = (await project(page)).pages[0].panels;
  check(panels.length === 0, `one undo takes it back (${panels.length} panels)`);
  // A line that misses the frame makes nothing, and says what to do.
  const [cx, cy] = await at([30, 8]);
  const [dx, dy] = await at([230, 8]);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(dx, dy, { steps: 6 });
  await page.mouse.up();
  const missed = await page.evaluate(() => [
    window.nameStudio.workbench.project.pages[0].panels.length,
    document.getElementById("status").textContent,
  ]);
  check(missed[0] === 0 && missed[1].includes("基本枠を横切る"), `a line off the frame makes nothing and tells how (${missed[1]})`);
  await page.close();

  // 見本で試す: the sample opens, unsaved, with the editor's guide on it (even when the guide was seen).
  {
    const tried = await open(1366, 768);
    await tried.evaluate(() => localStorage.setItem("namestudio.tourSeen", JSON.stringify({ start: true, editor: true })));
    const shown = await tried.locator("#start-sample").isVisible();
    await tried.click("#start-sample");
    await tried.waitForSelector("#tour:not([hidden])", { timeout: 3000 }).catch(() => undefined);
    const sample = await tried.evaluate(() => {
      const wb = window.nameStudio.workbench;
      const project = wb.project;
      return {
        title: project?.title,
        pages: project?.pages.length,
        panels: project?.pages.reduce((n, page) => n + page.panels.length, 0),
        lines: project?.pages.reduce((n, page) => n + page.lines.length, 0),
        path: wb.session.path ?? null,
        editor: !document.getElementById("editor").hidden,
        status: document.getElementById("status").textContent,
        tour: !document.getElementById("tour").hidden,
        first: document.querySelector(".tour-count")?.textContent,
      };
    });
    check(shown, "the start screen offers 見本で試す");
    check(
      sample.editor && sample.pages === 8 && sample.panels >= 24 && sample.lines >= 20,
      `見本で試す opens the sample name in the editor (${sample.title}: ${sample.pages} pages, ${sample.panels} panels, ${sample.lines} lines)`,
    );
    check(sample.path === null && sample.status.includes("保存するまで"), `it is not a file until saved (${sample.status})`);
    check(sample.tour && sample.first?.startsWith("1 /"), `and the editor's guide starts on it (${sample.first})`);
    await tried.keyboard.press("Escape");
    // In the command palette too.
    const palette = await open(1366, 768);
    await palette.keyboard.press("Control+k");
    await palette.keyboard.type("見本");
    await palette.waitForTimeout(200);
    const listed = await palette.evaluate(() =>
      [...document.querySelectorAll("#start-palette [role=option]")].map((node) => node.textContent),
    );
    check(
      listed.some((text) => text.includes("見本のネームで試す")),
      `Ctrl+K on the start screen finds it (${listed.slice(0, 3).join(" / ")})`,
    );
    await palette.close();
    await tried.close();
  }

  // 大きめを勧める: once, when a pen first touches; its button turns 大きめ on.
  {
    const pen = await open(1366, 768);
    const touch = () =>
      pen.evaluate(() =>
        document
          .getElementById("start-open")
          .dispatchEvent(new PointerEvent("pointerdown", { pointerType: "pen", bubbles: true, cancelable: true })),
      );
    const offered = () => pen.locator(".alert.info").count();
    check((await offered()) === 0, "no 大きめ offer before a pen is used (an ordinary screen)");
    await touch();
    const words = await pen
      .locator(".alert.info p")
      .textContent()
      .catch(() => "");
    check((await offered()) === 1 && words.includes("ペン"), `a pen's first touch offers 大きめ (${words.slice(0, 30)}…)`);
    await pen.locator(".alert.info .alert-action").click();
    const after = await pen.evaluate(() => [
      document.documentElement.dataset.density,
      JSON.parse(localStorage.getItem("namestudio.look")).large,
    ]);
    check(after[0] === "large" && after[1] === true, `its button turns 大きめ on and keeps it (${after.join(", ")})`);
    await touch();
    check((await offered()) === 0, "it is offered once only");
    await pen.reload();
    await pen.waitForFunction(() => window.nameStudio);
    await touch();
    check((await offered()) === 0, "nor after the app starts again");
    await pen.close();
  }

  // The top bar in windows of every width: nothing off the right edge, the file name readable or on hover.
  for (const width of [900, 1100, 1181, 1241, 1280, 1366, 1400, 1501, 1681, 1920]) {
    const narrow = await open(width, 720);
    await narrow.evaluate(async () => {
      const { demoName } = await import("/e2e/demoname.js");
      window.nameStudio.show(demoName(null));
    });
    await narrow.waitForTimeout(300);
    const bar = await narrow.evaluate(() => {
      const name = document.getElementById("file-name");
      return {
        help: document.getElementById("help").getBoundingClientRect().right,
        wide: document.documentElement.scrollWidth,
        name: name.getBoundingClientRect().width,
        title: name.title,
        text: name.textContent,
      };
    });
    check(
      bar.help <= width && bar.wide <= width,
      `${width} px: the bar fits (ヘルプ ends at ${Math.round(bar.help)}, page ${bar.wide} wide)`,
    );
    check(
      bar.name >= 100 && bar.title === bar.text,
      `${width} px: the file name has room (${Math.round(bar.name)} px) and its whole text on hover`,
    );
    if (width === 1280 || width === 1366) {
      // 画面のヘルプ: no words over other words.
      await narrow.click("#help");
      await narrow.waitForTimeout(300);
      const over = await narrow.evaluate(() => {
        const boxes = [...document.querySelectorAll(".help-label")].map((label) => [
          label.textContent.slice(0, 6),
          label.getBoundingClientRect(),
        ]);
        const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const out = [];
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++) if (hit(boxes[i][1], boxes[j][1])) out.push(`${boxes[i][0]}×${boxes[j][0]}`);
        return out;
      });
      check(over.length === 0, `${width} px: the help's words do not cover each other (${over.join(", ") || "none"})`);
    }
    await narrow.close();
  }
  check(errors.length === 0, `no errors on the page (${errors.join("; ") || "none"})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

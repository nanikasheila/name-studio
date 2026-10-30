// The number and memo under each page: all of a long memo is shown, wrapped
// to the page's width, with room for it under the pages: 見開き, 単独, and
// 連続 in one row and in two (each row as far below the one above as its
// longest memo needs). Run: node e2e/captions.mjs (SHOTS=dir to save the
// screens, NAME=file.namestudio to look at a name of one's own)
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

const server = await createServer({ root, logLevel: "error", server: { port: 1439, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  const file = process.env.NAME;
  await page.evaluate(async (text) => {
    const { newProject } = await import("/src/project.ts");
    const project = text ? JSON.parse(text) : newProject("説明", 12);
    if (!text) {
      const long = "場面の説明：ここでは二人が出会い、互いの目的を確かめる。会話は短く、表情で気持ちの変化を見せる。次のページへの引きを残す。";
      project.pages.forEach((p, i) => (p.memo = i % 3 === 1 ? `${long}${long}` : i % 3 === 0 ? long : "短い説明"));
    }
    window.nameStudio.show(project);
  }, file ? (await import("node:fs")).readFileSync(file, "utf8") : null);
  await page.waitForTimeout(300);

  /** Each shown page's caption: how many rows it is drawn in, and where its room ends and what lies under it begins (px). */
  const captions = () =>
    page.evaluate(async () => {
      const { captionRows, CAPTION_FONT } = await import("/src/screendraw.ts");
      const { trimBox } = await import("/src/pagebox.ts");
      const { editor, project } = window.nameStudio.workbench;
      const slots = editor.slots;
      // Measured as drawn: on the editor's own canvas (a canvas apart may pick another font for the letters).
      const ctx = editor.ctx;
      ctx.save();
      ctx.font = CAPTION_FONT;
      const [x0, , x1] = trimBox(project.pageFormat);
      const pageH = project.pageFormat.canvasMm[1];
      const stage = document.getElementById("editor-canvas").getBoundingClientRect().height;
      const all = slots.map((slot) => {
        const width = (x1 - x0) * slot.scale;
        const rows = captionRows(ctx, slot.page, slot.index, width, width < 170);
        const bottom = slot.y + pageH * slot.scale;
        // The last row's baseline and a little for the letters below it.
        const textEnd = bottom + 18 + (rows.length - 1) * 16 + 4;
        const below = slots.filter((other) => other.y > slot.y + 1 && Math.abs(other.x - slot.x) < 1).map((other) => other.y);
        return { index: slot.index, rows: rows.length, ellipsis: rows.some((row) => row.endsWith("…")), textEnd, roomEnd: bottom + (slot.caption ?? 36), next: below.length ? Math.min(...below) : null, stage };
      });
      ctx.restore();
      return all;
    });
  const shot = async (name) => shots && (await page.locator("#editor-canvas").screenshot({ path: `${shots}/${name}.png` }));
  const expectAll = async (where, onStage) => {
    const all = await captions();
    check(all.length > 0, `${where}: pages are shown`);
    check(all.some((c) => c.rows >= 3), `${where}: a long memo takes more than two rows (${Math.max(...all.map((c) => c.rows))})`);
    check(all.every((c) => !c.ellipsis), `${where}: no memo is cut off with …`);
    check(all.every((c) => c.textEnd <= c.roomEnd + 0.5), `${where}: every memo fits in the room under its page ${JSON.stringify(all.filter((c) => c.textEnd > c.roomEnd + 0.5))}`);
    check(all.every((c) => c.next === null || c.roomEnd <= c.next), `${where}: and ends above the next row`);
    if (onStage) check(all.every((c) => c.textEnd <= c.stage), `${where}: and is on the stage`);
  };

  await expectAll("見開き", true);
  await shot("1-spread");
  await page.evaluate(() => window.nameStudio.workbench.bars.setView("single"));
  await page.waitForTimeout(500);
  await expectAll("単独", true);
  await page.evaluate(() => window.nameStudio.workbench.bars.setView("continuous"));
  await page.waitForTimeout(600);
  await expectAll("連続 1 行", true);
  await shot("2-continuous-1");
  await page.evaluate(() => {
    const { editor } = window.nameStudio.workbench;
    editor.setRows(2);
    // Ctrl+0: the spread worked on as large as on its own. (Rows as tall as the stage can make the pages
    // too small for their memos, depending on how tall the stage is.)
    editor.fitView();
  });
  await page.waitForTimeout(600);
  await expectAll("連続 2 行", false);
  await shot("3-continuous-2");
  check(errors.length === 0, `no page errors ${errors.join(" / ")}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}

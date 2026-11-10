// 複数選択をまとめて動かす: inside the transform frame of what is picked, a
// drag anywhere (on a thing or between them) moves it all; a click there on
// nothing lets it go. A 範囲選択 may lie over a 見開き's two pages (囲む,
// Shift + クリック): it moves, turns, grows, is copied, nudged and removed
// together, each thing staying on its page. Rough (vector) lines picked grow
// and shrink with the frame, their width too.
// Run: npm run e2e:groupmove
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  // A 見開き (pages 2 and 3): dialogue and a rough line on each page.
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const { addLine } = await import("/src/domain/dialogue.ts");
    const project = newProject("まとめて", 4);
    const [, right, left] = project.pages;
    addLine(project, right, [60, 80], "うわ");
    addLine(project, right, [100, 120], "あなた");
    addLine(project, right, [140, 90], "学校");
    right.strokes.push({
      id: "stroke-r",
      points: [
        [50, 160, 1],
        [80, 170, 1],
        [120, 165, 1],
      ],
      widthMm: 0.4,
      closed: false,
    });
    addLine(project, left, [120, 100], "そうなの");
    left.strokes.push({
      id: "stroke-l",
      points: [
        [110, 150, 1],
        [140, 160, 1],
      ],
      widthMm: 0.4,
      closed: false,
    });
    window.nameStudio.show(project);
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(2);
    wb.editor.fitView();
    wb.setTool("select");
  });
  await page.waitForTimeout(300);

  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const at = (index, mm) =>
    page.evaluate(
      ([index, mm]) => {
        const wb = window.nameStudio.workbench;
        return wb.editor.clientOf(wb.project.pages[index].id, mm);
      },
      [index, mm],
    );
  async function path(points, keys = []) {
    for (const key of keys) await page.keyboard.down(key);
    await page.mouse.move(...points[0]);
    await page.mouse.down();
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      for (let s = 1; s <= 6; s++) await page.mouse.move(ax + ((bx - ax) * s) / 6, ay + ((by - ay) * s) / 6);
    }
    await page.mouse.up();
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
    await settle();
  }
  const state = () =>
    page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      const [, right, left] = wb.project.pages;
      const one = (p) => ({
        lines: p.lines
          .map((l) => ({ id: l.id, x: (l.box[0] + l.box[2]) / 2, y: (l.box[1] + l.box[3]) / 2 }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        strokes: p.strokes.map((s) => ({ id: s.id, x: s.points[0][0], y: s.points[0][1], w: s.widthMm })),
      });
      return { selection: wb.editor.selection, right: one(right), left: one(left), frame: !!wb.editor.picks.frameGeometry() };
    });
  const lasso = async (index, [x0, y0, x1, y1], keys) =>
    path(
      [
        await at(index, [x0, y0]),
        await at(index, [x1, y0]),
        await at(index, [x1, y1]),
        await at(index, [x0, y1]),
        await at(index, [x0, y0 + 1]),
      ],
      keys,
    );
  const near = (a, b) => Math.abs(a - b) < 0.05;

  // Picked on one page; a drag between the things (on none of them) moves them all.
  await lasso(1, [30, 40, 180, 190]);
  let before = await state();
  check(
    before.selection?.kind === "group" && before.selection.items.length === 4 && before.frame,
    "囲んで: 3 lines and a rough line, with the frame",
  );
  await path([await at(1, [100, 95]), await at(1, [110, 105])]);
  let s = await state();
  check(
    s.selection?.kind === "group" &&
      s.right.lines.every((l, i) => near(l.x - before.right.lines[i].x, 10) && near(l.y - before.right.lines[i].y, 10)) &&
      near(s.right.strokes[0].x - before.right.strokes[0].x, 10),
    "a drag between the picked things (inside the frame) moves them all, still picked",
  );
  // On one of them too.
  before = s;
  const onLine = before.right.lines[0];
  await path([await at(1, [onLine.x, onLine.y]), await at(1, [onLine.x - 5, onLine.y])]);
  s = await state();
  check(
    s.right.lines.every((l, i) => near(l.x - before.right.lines[i].x, -5)),
    "a drag on one of the picked things moves them all",
  );
  // A click inside the frame on nothing lets them go.
  await path([await at(1, [100, 100])]);
  s = await state();
  check(s.selection === null, "a click inside the frame on nothing lets them go");

  // 見開き: a lasso over both pages picks the things on both.
  const [rx, ry] = await at(1, [190, 40]);
  const [lx, ly] = await at(2, [100, 190]);
  await path([
    [rx, ry],
    [lx, ry],
    [lx, ly],
    [rx, ly],
    [rx, ry + 2],
  ]);
  before = await state();
  const items = before.selection?.items ?? [];
  check(
    before.selection?.kind === "group" && items.length === 6 && items.filter((item) => item.pageId).length === 2,
    "a lasso over the 見開き picks both pages' things (those of the facing page named with it)",
  );
  check(before.frame, "one frame around both pages' things");
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  // Drag from the facing page's thing: all of it moves, each thing on its page.
  const theirs = before.left.lines[0];
  await path([await at(2, [theirs.x, theirs.y]), await at(2, [theirs.x, theirs.y + 8])]);
  s = await state();
  check(
    s.left.lines.length === 1 &&
      s.right.lines.length === 3 &&
      near(s.left.lines[0].y - before.left.lines[0].y, 8) &&
      s.right.lines.every((l, i) => near(l.y - before.right.lines[i].y, 8)) &&
      near(s.left.strokes[0].y - before.left.strokes[0].y, 8),
    "dragging the facing page's thing moves both pages' things, each staying on its page",
  );
  // The arrows too.
  before = s;
  await page.keyboard.press("ArrowLeft");
  await settle();
  s = await state();
  check(
    s.left.lines[0].x < before.left.lines[0].x && s.right.lines.every((l, i) => l.x < before.right.lines[i].x),
    "← moves both pages' things",
  );
  // The frame grows both pages' things about one middle (a rough line's width with it).
  before = s;
  const handle = await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    const frame = wb.editor.picks.frameGeometry();
    const canvas = document.querySelector("#editor-canvas") ?? document.querySelector("canvas");
    const r = canvas.getBoundingClientRect();
    const [x, y] = frame.handles[2];
    return [r.left + x, r.top + y];
  });
  await path([handle, [handle[0] + 80, handle[1] + 80]]);
  s = await state();
  const spanBefore = before.right.lines[1].x - before.left.lines[0].x;
  const spanAfter = s.right.lines[1].x - s.left.lines[0].x;
  check(spanAfter > spanBefore + 1 && s.left.lines.length === 1, "the frame's corner grows both pages' things apart, each on its page");
  check(s.right.strokes[0].w > before.right.strokes[0].w, "a rough (vector) line picked grows with the frame, its width too");
  await page.keyboard.press("Control+z");
  await settle();
  s = await state();
  check(near(s.right.lines[1].x, before.right.lines[1].x) && near(s.right.strokes[0].w, before.right.strokes[0].w), "Ctrl+Z puts it back");

  // Shift + click on the facing page takes its line out, and back in.
  const lineL = s.left.lines[0];
  await path([await at(2, [lineL.x, lineL.y])], ["Shift"]);
  s = await state();
  check(s.selection?.items?.length === 5, "Shift + click on the facing page's line takes it out");
  await path([await at(2, [lineL.x, lineL.y])], ["Shift"]);
  s = await state();
  check(s.selection?.items?.length === 6, "and Shift + click puts it back");

  // Copy and paste the two pages' things: pasted over the 見開き again, each on the page it lies over.
  await page.keyboard.press("Control+c");
  const counts = await page.evaluate(() => window.nameStudio.workbench.project.pages.map((p) => p.lines.length));
  await page.mouse.move(...(await at(1, [100, 100])));
  await page.keyboard.press("Control+v");
  await settle();
  const pasted = await page.evaluate(() => window.nameStudio.workbench.project.pages.map((p) => p.lines.length));
  check(pasted[1] === counts[1] + 3 && pasted[2] === counts[2] + 1, "Ctrl+C / Ctrl+V of both pages' things pastes each over its page");
  await page.keyboard.press("Control+z");
  await settle();

  // Delete takes both pages' things.
  await lasso(1, [10, 10, 10, 10]);
  const [ax, ay] = await at(1, [190, 40]);
  const [bx, by] = await at(2, [100, 190]);
  await path([
    [ax, ay],
    [bx, ay],
    [bx, by],
    [ax, by],
    [ax, ay + 2],
  ]);
  await page.keyboard.press("Delete");
  await settle();
  s = await state();
  check(s.left.lines.length === 0 && s.right.lines.length === 0 && s.selection === null, "Delete takes both pages' things");
  await page.keyboard.press("Control+z");
  await settle();
  s = await state();
  check(s.left.lines.length === 1 && s.right.lines.length === 3, "Ctrl+Z brings them back");

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

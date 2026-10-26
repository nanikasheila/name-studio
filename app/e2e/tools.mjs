// Every tool driven with the mouse, as a person would, and what each step left
// in the name compared with the record of how it was (tools.golden.json):
// コマ割り (cut, rectangle, polygon), select (move, gutter, corner, pick, group),
// 変形 (scale, rotate, warp), text and しっぽ, pen (curve, straight, over the
// gutter), the erasers, fill, はみ出し, 付箋, swapping panels, then undo back
// to the start. Run: npm run e2e:tools (-- --update writes the record anew,
// -- --shots <dir> keeps a picture of each step).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const goldenPath = fileURLToPath(new URL("tools.golden.json", import.meta.url));
const update = process.argv.includes("--update");
/** --shots <dir>: a picture of the pages after each step, for comparing how they are drawn. */
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

/** Numbers to 0.01 (mm), so that the record does not depend on the last bits of floating point. */
const rounded = (value) =>
  typeof value === "number"
    ? Math.round(value * 100) / 100
    : Array.isArray(value)
      ? value.map(rounded)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rounded(v)]))
        : value;

/** Where `a` and `b` differ (numbers within 0.05 are the same), as paths. */
function differences(a, b, path = "", out = []) {
  if (out.length > 12) return out;
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) > 0.05) out.push(`${path}: ${a} → ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: ${a.length} items → ${b.length}`);
    else a.forEach((x, i) => differences(x, b[i], `${path}[${i}]`, out));
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], `${path}.${key}`, out);
  } else if (a !== b) {
    out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
  return out;
}

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: 1432, strictPort: false },
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const steps = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  await page.addInitScript({
    path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)),
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.nameStudio);

  // A name of four pages, each with the basic frame as one panel; pages 2 and 3 face each other.
  await page.evaluate(async () => {
    const { newProject, addPanel, rectShape, basicBox } = await import("/src/project.ts");
    const project = newProject("道具の通しテスト", 4);
    for (const p of project.pages) addPanel(project, p, rectShape(basicBox(project.pageFormat)));
    window.nameStudio.show(project);
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(2);
    wb.editor.fitView();
  });
  await page.waitForTimeout(300);

  const tool = (name) => page.evaluate((name) => window.nameStudio.workbench.setTool(name), name);
  /** Screen position of a point (mm) on page `n` (1-based). */
  const at = (n, mm) =>
    page.evaluate(
      ([n, mm]) => {
        const wb = window.nameStudio.workbench;
        return wb.editor.clientOf(wb.project.pages[n - 1].id, mm);
      },
      [n, mm],
    );
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  /** Press, move through the points (screen px) in small steps, let go; `keys` held throughout. */
  async function drag(points, keys = []) {
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
  const dragMm = async (n, points, keys) => drag(await Promise.all(points.map((p) => at(n, p))), keys);
  const click = async (n, mm, keys = []) => drag([await at(n, mm)], keys);
  async function record(name) {
    await settle();
    const state = await page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      const project = wb.project;
      return {
        pages: project.pages.slice(1, 3).map(({ id, panels, lines, strokes, breakouts, fills, stickies }) => ({
          id,
          panels,
          lines,
          strokes,
          breakouts,
          fills,
          stickies,
        })),
        nextId: project.nextId,
        selection: wb.editor.selection,
        tool: wb.editor.tool,
        undo: wb.session.history.undoStack.length,
        status: document.getElementById("status").textContent,
      };
    });
    steps.push({ name, ...rounded(state) });
    if (shots)
      await page.locator("#editor-canvas").screenshot({
        path: `${shots}/${String(steps.length).padStart(2, "0")} ${name}.png`,
      });
    console.log(`     ${name}`);
  }

  await record("start");

  // コマ割り: cut the panel of page 2 across, then its top half down the middle.
  await tool("cut");
  await dragMm(2, [
    [40, 200],
    [260, 202],
  ]);
  await record("cut across");
  await dragMm(2, [
    [150, 60],
    [151, 190],
  ]);
  await record("cut down");
  // 四角: a panel drawn on page 3.
  await page.evaluate(() => window.nameStudio.workbench.editor.setPanelMode("rect"));
  await dragMm(3, [
    [70, 90],
    [150, 160],
  ]);
  await record("rectangle panel");
  // 多角形: four corners, then back to the first.
  await page.evaluate(() => window.nameStudio.workbench.editor.setPanelMode("polygon"));
  for (const corner of [
    [80, 220],
    [200, 230],
    [190, 320],
    [90, 300],
    [80, 220],
  ])
    await click(3, corner);
  await record("polygon panel");
  await page.evaluate(() => window.nameStudio.workbench.editor.setPanelMode("cut"));

  // Select: a panel, moved; the gutter; a corner; a panel and what is in it.
  await tool("select");
  await click(2, [100, 300]);
  await record("select a panel");
  await dragMm(2, [
    [100, 300],
    [104, 306],
  ]);
  await record("move the panel");
  await page.keyboard.press("Control+z");
  const gutter = await page.evaluate(() => {
    const page = window.nameStudio.workbench.project.pages[1];
    const top = Math.max(...page.panels.filter((p) => p.shape.every(([, y]) => y < 220)).flatMap((p) => p.shape.map(([, y]) => y)));
    const bottom = Math.min(...page.panels.filter((p) => p.shape.every(([, y]) => y > 180)).flatMap((p) => p.shape.map(([, y]) => y)));
    return (top + bottom) / 2;
  });
  await dragMm(2, [
    [120, gutter],
    [120, gutter + 12],
  ]);
  await record("move the gutter");
  await click(2, [100, 300]);
  const corner = await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    const panel = wb.project.pages[1].panels.find((p) => p.id === wb.editor.selection.id);
    return panel.shape.reduce((best, p) => (p[0] + p[1] > best[0] + best[1] ? p : best));
  });
  await dragMm(2, [corner, [corner[0] - 8, corner[1] - 5]]);
  await record("drag a corner");

  // Text: a line written in a panel, a second one, then しっぽ pulled out and bent.
  await tool("text");
  await click(2, [100, 120]);
  await page.waitForTimeout(50);
  await page.keyboard.type("テスト");
  await page.keyboard.press("Control+Enter");
  await record("write a line");
  await click(2, [200, 280]);
  await page.waitForTimeout(50);
  await page.keyboard.type("二つ目\nのセリフ");
  await page.keyboard.press("Control+Enter");
  await record("write a second line");
  await tool("select");
  const balloon = await page.evaluate(() => {
    const [x0, y0, x1, y1] = window.nameStudio.workbench.project.pages[1].lines[0].box;
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  });
  const lineAt = balloon;
  await dragMm(2, [lineAt, [lineAt[0] + 25, lineAt[1] + 30]], ["Alt"]);
  await record("pull out a tail");
  await dragMm(2, [
    [lineAt[0] + 25, lineAt[1] + 30],
    [lineAt[0] + 32, lineAt[1] + 36],
  ]);
  await record("move the tail's tip");

  // Pen: a curve, a straight line (Shift), and a line across the gutter.
  await tool("pen");
  await dragMm(3, [
    [100, 100],
    [120, 110],
    [140, 105],
    [160, 125],
  ]);
  await record("pen curve");
  await dragMm(
    3,
    [
      [100, 180],
      [170, 186],
    ],
    ["Shift"],
  );
  await record("pen straight");
  await dragMm(3, [
    [40, 250],
    [10, 255],
    [-20, 258],
  ]);
  await record("pen over the gutter");

  // Erasers: the whole line, 囲って消す, then 触れた部分.
  await page.evaluate(() => window.nameStudio.workbench.setEraseMode("whole"));
  await tool("eraser");
  await dragMm(3, [
    [130, 95],
    [130, 125],
  ]);
  await record("erase whole");
  await page.evaluate(() => window.nameStudio.workbench.setEraseMode("lasso"));
  await dragMm(3, [
    [90, 170],
    [180, 170],
    [180, 200],
    [90, 200],
    [90, 172],
  ]);
  await record("erase lasso");
  await page.evaluate(() => window.nameStudio.workbench.setEraseMode("touched"));
  await dragMm(3, [
    [25, 240],
    [25, 270],
  ]);
  await record("erase touched");

  // Fill and はみ出し.
  await tool("fill");
  await dragMm(3, [
    [100, 240],
    [160, 240],
    [160, 280],
    [100, 280],
    [100, 242],
  ]);
  await record("fill");
  await tool("breakout");
  await dragMm(2, [
    [140, 40],
    [175, 40],
    [175, 80],
    [140, 80],
    [140, 42],
  ]);
  await record("breakout");

  // 付箋: on a panel (tied to it), then moved.
  await tool("sticky");
  await click(2, [90, 330]);
  await record("sticky on a panel");
  const sticky = await page.evaluate(() => window.nameStudio.workbench.project.pages[1].stickies?.[0]?.at ?? null);
  if (sticky) {
    await dragMm(2, [
      [sticky[0] + 2, sticky[1] + 2],
      [sticky[0] + 12, sticky[1] + 8],
    ]);
    await record("move the sticky");
    // Its round handle dragged onto the first line: tied to that instead.
    const handle = await page.evaluate(async () => {
      const { stickyAnchor } = await import("/src/project.ts");
      const page = window.nameStudio.workbench.project.pages[1];
      return stickyAnchor(page, page.stickies[0]);
    });
    await dragMm(2, [handle, lineAt]);
    await record("tie the sticky to a line");
  }

  // A panel's memo: its tag dragged out of the way.
  await tool("select");
  const tag = await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    const page = wb.project.pages[1];
    const panel = page.panels.find((p) => p.shape.some(([x, y]) => x < 70 && y > 300));
    wb.edit(() => (panel.note = "引きの絵"));
    const xs = panel.shape.map(([x]) => x);
    const ys = panel.shape.map(([, y]) => y);
    const [x, y] = wb.editor.clientOf(page.id, [Math.min(...xs), Math.min(...ys)]);
    return [x + 12, y + 10];
  });
  await drag([tag, [tag[0] + 40, tag[1] + 30]]);
  await record("drag a panel's memo");

  // 範囲選択: from the margin, drag round things on page 3, then move them together.
  await tool("select");
  await dragMm(3, [
    [20, 210],
    [270, 210],
    [270, 340],
    [20, 340],
    [20, 212],
  ]);
  await record("pick around");
  const picked = await page.evaluate(() => window.nameStudio.workbench.editor.selection?.kind === "group");
  if (picked) {
    await dragMm(3, [
      [130, 260],
      [136, 266],
    ]);
    await record("move the picked");
  }

  // 変形: a panel scaled from its corner, turned, and warped (Ctrl + corner).
  await click(2, [200, 120]);
  await page.evaluate(() => window.nameStudio.workbench.editor.toggleTransform(true));
  const frame = await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    const page = wb.project.pages[1];
    const panel = page.panels.find((p) => p.id === wb.editor.selection.id);
    const xs = panel.shape.map(([x]) => x);
    const ys = panel.shape.map(([, y]) => y);
    const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const a = wb.editor.clientOf(page.id, [x0, y0]);
    const b = wb.editor.clientOf(page.id, [x1, y1]);
    return {
      topLeft: [a[0] - 3, a[1] - 3],
      bottomRight: [b[0] + 3, b[1] + 3],
      rotate: [(a[0] + b[0]) / 2, a[1] - 3 - 22],
    };
  });
  await drag([frame.bottomRight, [frame.bottomRight[0] - 20, frame.bottomRight[1] - 14]]);
  await record("scale from a corner");
  await drag([frame.rotate, [frame.rotate[0] + 30, frame.rotate[1] + 6]]);
  await record("turn");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await drag([frame.topLeft, [frame.topLeft[0] + 15, frame.topLeft[1] + 10]], ["Control"]);
  await record("warp a corner");
  await page.evaluate(() => window.nameStudio.workbench.editor.toggleTransform(false));

  // コマの入れ替え: Alt + drag a panel onto another.
  await dragMm(
    2,
    [
      [100, 300],
      [200, 120],
    ],
    ["Alt"],
  );
  await record("swap panels");

  // Undo everything: back to the four plain pages.
  for (let i = 0; i < 60; i++) await page.keyboard.press("Control+z");
  await record("undo all");

  check(errors.length === 0, `no errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}

if (update) {
  writeFileSync(goldenPath, `${JSON.stringify(steps, null, 1)}\n`);
  console.log(`wrote ${steps.length} steps to tools.golden.json`);
} else {
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  check(steps.length === golden.length, `${steps.length} steps as recorded (${golden.length})`);
  for (const [i, step] of steps.entries()) {
    const was = golden[i];
    const found = was ? differences(was, step) : ["not recorded"];
    check(found.length === 0, `${step.name}: as recorded${found.length ? `\n       ${found.join("\n       ")}` : ""}`);
  }
}
const first = steps[0];
const last = steps.at(-1);
check(JSON.stringify(first.pages) === JSON.stringify(last.pages) && last.undo === 0, "undoing every step gives back the name as it was");
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

// 指示 (the 指示 tool, R): scribbled in red over everything on a 指示のレイヤー
// of their own, apart from the rough — the eraser leaves them, the 指示
// tool's 消す erases only them; another colour is another layer; Shift+R
// hides and shows them all; the レイヤー palette lists them with their colour;
// written to CSP as a 下描き layer each on top, and onto the PDF.
// Run: npm run e2e:marks
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1437, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    window.nameStudio.show(newProject("指示", 2));
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(1);
    wb.editor.fitView();
  });
  await page.waitForTimeout(300);

  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const at = (mm) =>
    page.evaluate((mm) => {
      const wb = window.nameStudio.workbench;
      return wb.editor.clientOf(wb.project.pages[0].id, mm);
    }, mm);
  async function dragMm(points) {
    const screen = await Promise.all(points.map(at));
    await page.mouse.move(...screen[0]);
    await page.mouse.down();
    for (let i = 1; i < screen.length; i++) {
      const [ax, ay] = screen[i - 1];
      const [bx, by] = screen[i];
      for (let s = 1; s <= 8; s++) await page.mouse.move(ax + ((bx - ax) * s) / 8, ay + ((by - ay) * s) / 8);
    }
    await page.mouse.up();
    await settle();
  }
  const state = () =>
    page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      return {
        tool: wb.editor.tool,
        layers: wb.project.roughLayers ?? [],
        strokes: wb.project.pages[0].strokes.map(({ id, layer }) => ({ id, layer: layer ?? null })),
        status: document.getElementById("status").textContent,
      };
    });
  // The colour drawn on the canvas at a point of the page (mm).
  const pixel = async (mm) => {
    const [x, y] = await at(mm);
    return page.evaluate(
      ([x, y]) => {
        const canvas = document.getElementById("editor-canvas");
        const box = canvas.getBoundingClientRect();
        const ratio = canvas.width / box.width;
        const data = canvas.getContext("2d").getImageData(Math.round((x - box.left) * ratio), Math.round((y - box.top) * ratio), 1, 1).data;
        return [data[0], data[1], data[2]];
      },
      [x, y],
    );
  };
  const red = ([r, g, b]) => r > 170 && g < 120 && b < 120;

  // R takes up the 指示 tool, with its bar.
  await page.mouse.move(800, 500);
  await page.keyboard.press("r");
  let s = await state();
  check(s.tool === "mark", `R takes up the 指示 tool (${s.tool})`);
  check(await page.locator("#mark-bar").isVisible(), "the 指示 bar shows");
  check((await page.locator("#mark-colors .mark-chip").count()) === 1, "one colour (red) to begin with");
  check(await page.locator("#marks-shown-label").isHidden(), "no 指示 shown/hidden button before there are any");

  // The first 指示 makes the red 指示のレイヤー.
  await dragMm([
    [40, 100],
    [120, 100],
  ]);
  s = await state();
  const marks = s.layers.find((layer) => layer.marks);
  check(!!marks && marks.name === "指示" && !marks.color, `the first 指示 makes the red layer 指示 (${JSON.stringify(s.layers)})`);
  check(s.strokes.length === 1 && s.strokes[0].layer === marks?.id, "the line is on it");
  check(red(await pixel([80, 100])), `it is drawn red (${await pixel([80, 100])})`);
  check(await page.locator("#marks-shown-label").isVisible(), "the 指示 shown/hidden button shows");

  // A rough line across it with the pen; the eraser takes the rough line only.
  await page.keyboard.press("p");
  await dragMm([
    [80, 70],
    [80, 130],
  ]);
  s = await state();
  check(s.strokes.length === 2 && s.strokes[1].layer === null, "the pen draws on the rough, not on the 指示のレイヤー");
  await page.keyboard.press("e");
  await page.click("#erase-whole");
  await dragMm([
    [70, 100],
    [90, 100],
  ]);
  s = await state();
  check(s.strokes.length === 1 && s.strokes[0].layer === marks?.id, `the eraser leaves the 指示 (${JSON.stringify(s.strokes)})`);

  // The 指示 tool's 消す erases the 指示 only.
  await page.keyboard.press("p");
  await dragMm([
    [80, 70],
    [80, 130],
  ]);
  await page.keyboard.press("r");
  await page.click("#mark-erase");
  check((await state()).tool === "mark" && (await page.locator("#mark-erase.active").count()) === 1, "消す is on");
  await page.click("#tool-eraser");
  await page.click("#erase-whole");
  await page.click("#tool-mark");
  await dragMm([
    [70, 100],
    [90, 100],
  ]);
  s = await state();
  check(s.strokes.length === 1 && s.strokes[0].layer === null, `消す erases the 指示 and leaves the rough line (${JSON.stringify(s.strokes)})`);
  await page.keyboard.press("Control+z");
  s = await state();
  check(s.strokes.length === 2, "undo brings the 指示 back");
  await page.click("#mark-draw");

  // Another colour: another layer.
  await page.click("#mark-add");
  s = await state();
  const blue = s.layers.filter((layer) => layer.marks)[1];
  check(blue?.color === "#1e6fd9" && blue.name === "指示（青）", `＋色 adds 指示（青） (${JSON.stringify(blue)})`);
  check((await page.locator("#mark-colors .mark-chip.active").textContent())?.includes("指示（青）"), "and draws in it");
  await dragMm([
    [40, 160],
    [120, 160],
  ]);
  s = await state();
  check(s.strokes.at(-1)?.layer === blue?.id, "the next 指示 is on the blue layer");
  const [r, g, b] = await pixel([80, 160]);
  check(b > r + 30 && b > g, `drawn blue (${[r, g, b]})`);
  // The red chip: back to red.
  await page.locator(`#mark-colors .mark-chip[data-mark="${marks.id}"]`).click();
  await dragMm([
    [40, 190],
    [120, 190],
  ]);
  check((await state()).strokes.at(-1)?.layer === marks.id, "picking the red chip draws red again");

  // Shift+R: all 指示 hidden, then shown.
  await page.keyboard.press("Shift+R");
  s = await state();
  check(s.layers.filter((layer) => layer.marks).every((layer) => layer.hidden), "Shift+R hides every 指示のレイヤー");
  check(!red(await pixel([80, 100])), "the 指示 are not drawn");
  check((await page.locator("#marks-shown").getAttribute("aria-pressed")) === "false", "the button shows them hidden");
  await page.keyboard.press("Shift+R");
  s = await state();
  check(s.layers.filter((layer) => layer.marks).every((layer) => !layer.hidden), "Shift+R shows them again");
  check(red(await pixel([80, 100])), "drawn again");

  // The レイヤー palette: the 指示のレイヤー above the rough's, with their colours.
  if (!(await page.locator("#rough-add").isVisible())) await page.click("#tab-layers-edit");
  await page.waitForSelector("#marks-add", { state: "visible" });
  const rows = await page.locator(".rough-row").evaluateAll((list) => list.map((row) => ({ id: row.dataset.rough, color: row.dataset.color ?? null })));
  check(rows.length === 3 && rows[0].id === blue.id && rows[1].id === marks.id && rows[2].color === null, `the palette lists 指示（青）, 指示, then ラフ線 (${JSON.stringify(rows)})`);
  await page.locator(`.rough-row[data-rough="${marks.id}"] .mark-swatch`).click();
  s = await state();
  check(s.layers.find((layer) => layer.id === marks.id)?.color === "#1e6fd9", "pressing the colour turns 指示 blue");
  await page.keyboard.press("Control+z");
  // Picking a rough layer row takes up the pen; a 指示 row the 指示 tool.
  await page.locator(`.rough-row[data-rough="rough"]`).click();
  check((await state()).tool === "pen", "a rough layer's row takes up the pen");
  await page.locator(`.rough-row[data-rough="${blue.id}"]`).click();
  check((await state()).tool === "mark", "a 指示 row takes up the 指示 tool");

  // The 指示 can be picked and moved with the select tool.
  await page.keyboard.press("v");
  const [mx, my] = await at([60, 190]);
  await page.mouse.click(mx, my);
  s = await page.evaluate(() => window.nameStudio.workbench.editor.selection);
  check(s?.kind === "stroke", `the select tool picks a 指示 (${JSON.stringify(s)})`);
  await page.keyboard.press("Escape");

  // CSP: a 下描き layer each, on top, in its colour.
  const exported = await page.evaluate(async () => {
    const { exportToCsp } = await import("/src/nameexport.ts");
    const pages = [];
    let request = null;
    window.__answer = (command, args) => {
      if (command === "begin_name_export") {
        request = args.request;
        return { widthPx: 1000, heightPx: 1400, resolution: 100, trimPx: null, basicPx: null, vectorLayers: false, textLayers: false, frameFolders: false, firstPageLeft: null, spread: null, spreadProblem: null };
      }
      if (command === "export_name_page") {
        const body = args instanceof Uint8Array ? args : new Uint8Array(args);
        const length = new DataView(body.buffer, body.byteOffset).getUint32(0, true);
        pages.push(JSON.parse(new TextDecoder().decode(body.slice(4, 4 + length))));
        return { path: "p.clip", problems: [], layers: 0, vectorLines: 0, texts: 0 };
      }
      if (command === "finish_name_export") return { pages: [], work: null, workCheck: null };
      return undefined;
    };
    const wb = window.nameStudio.workbench;
    const project = structuredClone(wb.project);
    project.roughLayers.find((layer) => layer.name === "指示（青）").hidden = true;
    const base = { template: "t.clip", outDir: "o", workTemplate: null, workName: null, storyIndex: null, inputs: [], donors: [] };
    await exportToCsp(project, base, false, () => {});
    const withMarks = { request, pages: pages.splice(0) };
    await exportToCsp(project, { ...base, marks: false }, false, () => {});
    window.__answer = undefined;
    return { withMarks, without: pages.map((p) => p.layers.map((layer) => layer.name)) };
  });
  const names = exported.withMarks.pages[0].layers.map((layer) => layer.name);
  check(names.slice(-2).join() === "指示,指示（青）", `the 指示のレイヤー go on top (${names})`);
  check(exported.withMarks.pages[0].layers.at(-1).length > 0 && exported.withMarks.pages[1].layers.at(-1).length === 0, "with a picture where there are 指示, empty on a page without");
  check(["指示", "指示（青）"].every((name) => exported.withMarks.request.draftLayers.includes(name)), "as 下描き layers");
  check(exported.withMarks.request.layerLooks?.some((look) => look.name === "指示（青）" && look.hidden), "a hidden one goes hidden");
  check(["指示", "指示（青）"].every((name) => exported.withMarks.request.layerLooks?.some((look) => look.name === name && look.whole && look.opacity === 1)), "in their colour: at full opacity, not the 下描き half");
  check(!exported.without[0].some((name) => name.startsWith("指示")), `--no-marks / unchecked leaves them out (${exported.without[0]})`);

  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`${failures.length} failed`);
  process.exit(1);
}
console.log("all ok");

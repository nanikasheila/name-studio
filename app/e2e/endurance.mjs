// A long session on a heavy name (32 pages, 200 rough lines each), as a day
// of work goes: lines drawn with the pen on page after page, erased, balloons
// moved, undo and redo, the spread turned, 連続 and back. After each round,
// with the garbage collected: the JS memory, the canvases alive (and their
// pixels), the page's elements and listeners, undo's depth and the pictures
// the editor keeps. Then rounds that change nothing in the end (lines drawn
// and undone) must leave all of it where it was: what grows there is a leak.
// Run: npm run e2e:endurance (-- --rounds <n> for a longer session, -- --report <file> writes the samples as JSON).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { openHeavyName } from "./heavy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const ROUNDS = Number(arg("--rounds", 50));
const STEADY = Number(arg("--steady", 20));
const report = arg("--report", null);
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

process.env.VITE_PERF = "1";
const server = await createServer({ root, logLevel: "error", server: { port: 1433, strictPort: false } });
await server.listen();
const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
const samples = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  // Every canvas made, held weakly: those still alive after the garbage is collected are kept by the app.
  await page.addInitScript(() => {
    const made = new Set();
    const create = Document.prototype.createElement;
    Document.prototype.createElement = function (tag, ...rest) {
      const node = create.call(this, tag, ...rest);
      if (String(tag).toLowerCase() === "canvas") made.add(new WeakRef(node));
      return node;
    };
    window.__canvases = () => {
      let count = 0;
      let pixels = 0;
      for (const ref of made) {
        const canvas = ref.deref();
        if (!canvas) {
          made.delete(ref);
          continue;
        }
        if (!canvas.width || !canvas.height) continue;
        count++;
        pixels += canvas.width * canvas.height;
      }
      for (const canvas of document.querySelectorAll("canvas")) if (![...made].some((ref) => ref.deref() === canvas)) (count++, (pixels += canvas.width * canvas.height));
      return { count, mb: Math.round((pixels * 4) / 104857.6) / 10 };
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await openHeavyName(page, { pages: 32, strokes: 200, show: 1 });
  await page.waitForTimeout(400);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const at = (n, mm) => page.evaluate(([n, mm]) => window.nameStudio.workbench.editor.clientOf(window.nameStudio.workbench.project.pages[n - 1].id, mm), [n, mm]);
  const tool = (name) => page.evaluate((name) => window.nameStudio.workbench.setTool(name), name);
  const pen = (type, [x, y], pressure, buttons = 1) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "pen", force: pressure });
  async function penLine(points) {
    await pen("mouseMoved", points[0], 0, 0);
    await pen("mousePressed", points[0], 0.4);
    for (let i = 1; i < points.length; i++) await pen("mouseMoved", points[i], 0.3 + 0.4 * Math.sin((Math.PI * i) / points.length));
    await pen("mouseReleased", points[points.length - 1], 0, 0);
  }
  async function mouseDrag(points) {
    await page.mouse.move(...points[0]);
    await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(...point, { steps: 6 });
    await page.mouse.up();
  }
  /** The spread showing page `n`. */
  const show = (n) => page.evaluate((n) => {
    const editor = window.nameStudio.workbench.editor;
    editor.showPage(n);
    editor.draw();
  }, n);

  /** Lines drawn on page `n` with the pen (as a person sketches a panel). */
  async function sketch(n, lines, seed) {
    await tool("pen");
    for (let l = 0; l < lines; l++) {
      const [x, y] = await at(n, [50 + ((seed * 37 + l * 23) % 160), 60 + ((seed * 53 + l * 41) % 240)]);
      await penLine(Array.from({ length: 50 }, (_, i) => [x + i * 3, y + Math.sin((i + l) / 5) * 12]));
    }
    await settle();
  }

  async function sample(label) {
    // The stand-in for the Rust side keeps every call (autosave sends the whole name): not the app's memory.
    await page.evaluate(() => {
      window.__calls = [];
    });
    await settle();
    await cdp.send("HeapProfiler.collectGarbage");
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const metric = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
    const app = await page.evaluate(() => ({ canvases: window.__canvases(), ...window.nameStudio.workbench.resources() }));
    const row = { label, heapMb: Math.round(heap.usedSize / 104857.6) / 10, nodes: metric("Nodes"), listeners: metric("JSEventListeners"), canvases: app.canvases.count, canvasMb: app.canvases.mb, undo: app.undo, redo: app.redo, strokes: app.strokes, linePictures: app.linePictures, linePicturesMb: app.linePicturesMb };
    samples.push(row);
    return row;
  }
  const line = (row) =>
    `${row.label.padEnd(10)} heap ${String(row.heapMb).padStart(6)} MB · canvases ${row.canvases} (${row.canvasMb} MB) · nodes ${row.nodes} · listeners ${row.listeners} · undo ${row.undo}/${row.redo} · lines ${row.strokes} · line pictures ${row.linePictures} (${row.linePicturesMb} MB)`;

  const start = await sample("start");
  console.log(`     ${line(start)}`);
  const began = Date.now();
  let full = null;
  // A day of work, quickened: every round another page.
  for (let round = 1; round <= ROUNDS; round++) {
    const n = 1 + ((round * 5) % 32);
    await show(n);
    await sketch(n, 6, round);
    // The eraser across a part of the page, a balloon moved, back and forth in undo.
    await page.evaluate(() => window.nameStudio.workbench.setEraseMode("touched"));
    await tool("eraser");
    await mouseDrag([await at(n, [60, 100]), await at(n, [200, 120])]);
    await tool("select");
    await mouseDrag([await at(n, [80, 90]), await at(n, [86, 96])]);
    for (let u = 0; u < 4; u++) await page.keyboard.press("Control+z");
    for (let r = 0; r < 2; r++) await page.keyboard.press("Control+Shift+z");
    if (round % 5 === 0) {
      // 連続 and back.
      await page.keyboard.press("F7");
      await page.waitForTimeout(250);
      await page.evaluate(() => window.nameStudio.workbench.editor.fitAll());
      await settle();
      await page.keyboard.press("F7");
      await page.waitForTimeout(250);
    }
    const undo = await page.evaluate(() => window.nameStudio.workbench.resources().undo);
    if (!full && undo >= 190) {
      full = await sample(`full ${round}`);
      console.log(`     ${line(full)}`);
    } else if (round % 10 === 0 || round === ROUNDS) console.log(`     ${line(await sample(`round ${round}`))}`);
  }
  const worked = await sample("worked");
  const minutes = ((Date.now() - began) / 60000).toFixed(1);
  console.log(`     ${ROUNDS} rounds in ${minutes} min: ${worked.strokes - start.strokes} lines more, ${(worked.heapMb - start.heapMb).toFixed(1)} MB more`);
  check(worked.undo <= 200, `undo keeps at most 200 steps (${worked.undo})`);
  if (full) {
    // Undo's first steps cost a copy of the page each (its text); once it keeps no more, what grows is what is drawn.
    const perStep = ((full.heapMb - start.heapMb) * 1024) / full.undo;
    const lines = worked.strokes - full.strokes;
    const perLine = lines > 0 ? ((worked.heapMb - full.heapMb) * 1024) / lines : 0;
    console.log(`     while undo fills: ${perStep.toFixed(0)} KB a step; once it is full: ${perLine.toFixed(1)} KB for each of ${lines} lines more`);
    check(perStep < 400, `an undo step of a heavy page keeps ${perStep.toFixed(0)} KB (400 KB at most)`);
    check(perLine < 40, `once undo is full, memory grows only with what is drawn: ${perLine.toFixed(1)} KB a line (40 KB at most)`);
  } else {
    console.log(`     (undo did not fill in ${ROUNDS} rounds: give more with --rounds)`);
  }
  check(worked.canvases <= start.canvases + 6, `canvases alive stay few (${start.canvases} → ${worked.canvases})`);

  // Rounds that change nothing in the end: lines drawn, then undone, on page after page.
  const before = await sample("steady 0");
  for (let round = 1; round <= STEADY; round++) {
    const n = 1 + ((round * 7) % 32);
    await show(n);
    await sketch(n, 4, round + 100);
    await tool("select");
    for (let u = 0; u < 4; u++) await page.keyboard.press("Control+z");
    if (round % 5 === 0) await sample(`steady ${round}`);
  }
  // The same page shown as at the start of these rounds, so the editor's pictures are of the same pages.
  await show(1 + ((STEADY * 7) % 32));
  const after = await sample("steady");
  console.log(`     ${line(before)}`);
  console.log(`     ${line(after)}`);
  check(after.strokes === before.strokes, `the lines drawn and undone leave the name as it was (${before.strokes} → ${after.strokes})`);
  check(after.heapMb - before.heapMb < 8, `memory does not grow when nothing is kept: ${before.heapMb} → ${after.heapMb} MB (8 MB at most)`);
  check(after.canvases <= before.canvases + 2 && after.canvasMb <= before.canvasMb + 16, `canvases do not pile up: ${before.canvases} (${before.canvasMb} MB) → ${after.canvases} (${after.canvasMb} MB)`);
  check(after.nodes <= before.nodes + 300, `the page's elements do not pile up: ${before.nodes} → ${after.nodes}`);
  check(after.listeners <= before.listeners + 50, `listeners do not pile up: ${before.listeners} → ${after.listeners}`);
  check(errors.length === 0, `no errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (report) writeFileSync(report, `${JSON.stringify(samples, null, 1)}\n`);
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

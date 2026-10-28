// How quick the app is with a heavy name (32 pages, each with panels,
// dialogue in balloons and 200 rough lines: heavy.mjs): each operation a person does is
// timed in the page as the work it costs on the main thread (the input
// handlers plus the drawing of the frame that shows it), against the budget
// (50 ms; a change of the whole view and autosave, which waits for a pause,
// 100 ms). Twice the budget fails. Run: npm run e2e:perf
// (-- --report <file> writes the times as JSON, -- --profile <operation>
// shows where its time goes).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { openHeavyName } from "./heavy.mjs";

/** The most one operation (or one frame of a drag) may take (ms). */
const BUDGET_MS = 50;
const root = fileURLToPath(new URL("..", import.meta.url));
/** --profile <operation>: where the time of that operation goes (the busiest functions). */
const profile = process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : null;
const report = process.argv.includes("--report") ? process.argv[process.argv.indexOf("--report") + 1] : null;
const failures = [];
const results = {};
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
/**
 * Within the budget: ok. Over it: said so, as a target missed. Over twice the
 * budget: failed, as the app has become slower (the machines CI runs on are
 * shared, and a frame there can take much longer now and then).
 */
const timed = (time, budget, what) => {
  if (time <= budget) return check(true, what);
  if (time <= 2 * budget) return console.log(`slow ${what}`);
  check(false, `${what} — more than twice the budget`);
};

// As built: without the checks of development that cost time (freezing the lists undo shares).
process.env.VITE_PERF = "1";
const server = await createServer({ root, logLevel: "error", server: { port: 1433, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  // The meter: input handlers from the first listener (capture) to the last (bubble, added later), and every drawing.
  await page.addInitScript(() => {
    const meter = { work: 0, frames: [], handlers: 0, on: false };
    window.__meter = meter;
    for (const type of ["pointerdown", "pointermove", "pointerup", "keydown"]) {
      window.addEventListener(type, () => (meter.start = performance.now()), true);
    }
    meter.wrap = (object, name) => {
      const original = object[name];
      object[name] = function (...args) {
        const start = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          if (meter.on) {
            // One frame: what the handlers since the last drawing cost, and this drawing.
            meter.frames.push(meter.handlers + performance.now() - start);
            meter.handlers = 0;
          }
        }
      };
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(() => {
    const meter = window.__meter;
    for (const type of ["pointerdown", "pointermove", "pointerup", "keydown"]) {
      window.addEventListener(type, () => {
        if (meter.on && meter.start !== undefined) meter.handlers += performance.now() - meter.start;
        meter.start = undefined;
      });
    }
  });

  // Opening the heavy name.
  const opened = await openHeavyName(page, { pages: 32, strokes: 200, show: 10 });
  await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    window.__meter.wrap(wb.editor, "draw");
    window.__meter.wrap(wb.editor, "drawOverlay");
  });
  results.open = opened;
  await page.waitForTimeout(500);

  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  /** The frames an operation took, from its first input until it is drawn. */
  async function frames(name, operation) {
    await settle();
    const cdp = name === profile ? await page.context().newCDPSession(page) : null;
    if (cdp) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
      await cdp.send("Profiler.start");
    }
    await page.evaluate(() => Object.assign(window.__meter, { on: true, frames: [], handlers: 0 }));
    await operation();
    await settle();
    if (cdp) printProfile((await cdp.send("Profiler.stop")).profile);
    return page.evaluate(() => {
      const meter = window.__meter;
      meter.on = false;
      // Handlers whose change drew nothing are a frame of their own.
      if (meter.handlers) meter.frames.push(meter.handlers);
      return meter.frames;
    });
  }
  /**
   * An operation within the budget: its slowest frame. Over it, the operation
   * is done once more (a pause of the machine is not the app being slow),
   * after `reset` (null: it cannot be done again the same way).
   */
  async function measure(name, operation, { budget = BUDGET_MS, reset = async () => {} } = {}) {
    let found = await frames(name, operation);
    let worst = found.length ? Math.max(...found) : 0;
    if (worst > budget && reset) {
      await reset();
      const again = await frames(name, operation);
      const second = again.length ? Math.max(...again) : 0;
      if (second < worst) [found, worst] = [again, second];
    }
    results[name] = { frames: found.length, worst: Math.round(worst * 10) / 10, budget };
    if (name === profile) console.log(`  frames: ${found.map((f) => f.toFixed(1)).join(" ")}`);
    timed(worst, budget, `${name}: the slowest of ${found.length} frames takes ${worst.toFixed(1)} ms (budget ${budget} ms)`);
  }
  const at = (n, mm) =>
    page.evaluate(
      ([n, mm]) => {
        const wb = window.nameStudio.workbench;
        return wb.editor.clientOf(wb.project.pages[n - 1].id, mm);
      },
      [n, mm],
    );
  async function drag(points, keys = []) {
    for (const key of keys) await page.keyboard.down(key);
    await page.mouse.move(...points[0]);
    await page.mouse.down();
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      for (let s = 1; s <= 10; s++) await page.mouse.move(ax + ((bx - ax) * s) / 10, ay + ((by - ay) * s) / 10);
    }
    await page.mouse.up();
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
  }
  const dragMm = async (n, points, keys) => drag(await Promise.all(points.map((p) => at(n, p))), keys);
  const tool = (name) => page.evaluate((name) => window.nameStudio.workbench.setTool(name), name);
  timed(opened, 500, `opening the heavy name takes ${opened.toFixed(0)} ms (budget 500 ms)`);

  await tool("pen");
  await measure("pen line", () =>
    dragMm(11, [
      [60, 60],
      [120, 90],
      [180, 70],
      [200, 140],
    ]),
  );
  const undo = () => page.keyboard.press("Control+z");
  const redo = () => page.keyboard.press("Control+Shift+z");
  await measure("undo", undo, { reset: redo });
  await measure("redo", redo, { reset: undo });
  await tool("select");
  await measure("select a panel", () => dragMm(11, [[100, 300]]));
  await measure("move a panel", () =>
    dragMm(11, [
      [100, 300],
      [110, 310],
      [120, 300],
    ]),
  );
  await measure("move the gutter", () =>
    dragMm(11, [
      [100, 160],
      [100, 175],
    ]),
  );
  await measure("move a balloon", () =>
    dragMm(11, [
      [80, 90],
      [90, 100],
      [100, 95],
    ]),
  );
  await page.evaluate(() => window.nameStudio.workbench.setEraseMode("touched"));
  await tool("eraser");
  await measure("erase", () =>
    dragMm(11, [
      [40, 40],
      [220, 320],
    ]),
  );
  await tool("cut");
  await measure(
    "cut a panel",
    () =>
      dragMm(11, [
        [40, 210],
        [260, 211],
      ]),
    { reset: undo },
  );
  await tool("select");
  await measure("next spread", () => page.keyboard.press("ArrowLeft"));
  await page.keyboard.press("F7");
  await page.waitForTimeout(400);
  // Every page drawn anew at another size: a change of the whole view, once.
  await measure("every page on one canvas", () => page.evaluate(() => window.nameStudio.workbench.editor.fitAll()), { budget: 2 * BUDGET_MS, reset: null });
  await measure("move about every page", () =>
    drag(
      [
        [800, 500],
        [700, 450],
        [600, 500],
      ],
      ["Space"],
    ),
  );

  // Autosave, after a few seconds of quiet: the name as the bytes it sends.
  const save = await page.evaluate(async () => {
    const { projectBody } = await import("/src/projectjson.ts");
    const project = window.nameStudio.workbench.project;
    projectBody({}, project);
    const start = performance.now();
    projectBody({}, project);
    return performance.now() - start;
  });
  results.save = save;
  timed(save, 2 * BUDGET_MS, `autosave makes what it writes in ${save.toFixed(1)} ms (budget ${2 * BUDGET_MS} ms: it waits for a pause)`);
  // Before it writes, autosave sees whether the file holds the name already (a snapshot, compared).
  const same = await page.evaluate(async () => {
    const { sameSnapshot } = await import("/src/snapshot.ts");
    const session = window.nameStudio.workbench.session;
    const held = session.snapshot();
    const start = performance.now();
    sameSnapshot(held, session.snapshot());
    return performance.now() - start;
  });
  results.unchanged = same;
  timed(same, BUDGET_MS, `autosave sees whether anything changed in ${same.toFixed(1)} ms (budget ${BUDGET_MS} ms)`);
  check(errors.length === 0, `no errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
/** The functions the most time was spent in (self time), with where they are. */
function printProfile({ nodes, samples, timeDeltas }) {
  const self = new Map();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (timeDeltas[i] ?? 0)));
  const totals = new Map();
  for (const [id, time] of self) {
    const { functionName, url, lineNumber } = byId.get(id).callFrame;
    const key = `${functionName || "(anonymous)"} ${url.split("/").pop()}:${lineNumber + 1}`;
    totals.set(key, (totals.get(key) ?? 0) + time);
  }
  for (const [key, time] of [...totals].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${(time / 1000).toFixed(1).padStart(7)} ms  ${key}`);
}

if (report) writeFileSync(report, `${JSON.stringify(results, null, 1)}\n`);
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

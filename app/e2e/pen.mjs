// ペンの描き心地, with pen events as a tablet sends them (pointerType "pen",
// pressure, tilt), on a heavy name (32 pages, 200 rough lines each):
// - a reading of 0 while the pen is on the page (some tablets send one at the
//   start of a line and now and then) holds the pressure before it, and the
//   first real reading goes back to the start: no blob or dot in the line;
// - the cursor where the pen came down does not stay on screen while the
//   line is drawn;
// - a long line costs no more a frame at its end than at its start (only
//   what the pen added is painted), and 動作の記録 (perfmeter.ts) times the
//   pen's input to the screen;
// - 先読み shows the line a little ahead of the last point while it is drawn,
//   and none of it stays in the line.
// Run: npm run e2e:pen
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { openHeavyName } from "./heavy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

process.env.VITE_PERF = "1";
const server = await createServer({ root, logLevel: "error", server: { port: 1433, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await openHeavyName(page, { pages: 32, strokes: 200, show: 10 });
  await page.evaluate(() => window.nameStudio.workbench.setTool("pen"));
  await page.waitForTimeout(400);

  const cdp = await page.context().newCDPSession(page);
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const at = (n, mm) => page.evaluate(([n, mm]) => window.nameStudio.workbench.editor.clientOf(window.nameStudio.workbench.project.pages[n - 1].id, mm), [n, mm]);
  const pen = (type, [x, y], pressure, buttons = 1) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "pen", force: pressure, tiltX: 10, tiltY: 5 });
  /** A line with the pen through screen points, each with its pressure. */
  async function line(points, pressures, { during } = {}) {
    await pen("mouseMoved", points[0], 0, 0);
    await pen("mousePressed", points[0], pressures[0]);
    for (let i = 1; i < points.length; i++) {
      await pen("mouseMoved", points[i], pressures[i]);
      if (during && (await during(i)) === false) break;
    }
    await pen("mouseReleased", points[points.length - 1], 0, 0);
    await settle();
  }
  const lastStroke = () =>
    page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      const strokes = wb.project.pages[10].strokes;
      return strokes[strokes.length - 1];
    });

  // A reading of 0 at the start and three times on the way, else 0.3.
  const [x0, y0] = await at(11, [60, 200]);
  const straight = Array.from({ length: 60 }, (_, i) => [x0 + i * 4, y0 + Math.sin(i / 6) * 10]);
  const pressures = straight.map((_, i) => ([0, 10, 25, 40].includes(i) ? 0 : 0.3));
  const before = await page.evaluate(() => window.nameStudio.workbench.project.pages[10].strokes.length);
  await line(straight, pressures);
  const drawn = await lastStroke();
  const read = drawn.points.map((p) => p[2]);
  check(
    (await page.evaluate(() => window.nameStudio.workbench.project.pages[10].strokes.length)) === before + 1,
    "the line is drawn",
  );
  check(
    read.every((p) => Math.abs(p - 0.3) < 0.01),
    `a pressure of 0 on the way (and at the start) holds the pen's pressure: every point at 0.3 (${Math.min(...read).toFixed(2)}–${Math.max(...read).toFixed(2)})`,
  );

  // The cursor where the pen came down: a big pen shows a ring there; once the pen is away it is gone.
  await page.evaluate(() => {
    window.nameStudio.workbench.editor.penWidthMm = 4;
  });
  const [cx, cy] = await at(11, [60, 300]);
  const ringRadius = await page.evaluate(() => {
    const editor = window.nameStudio.workbench.editor;
    return (editor.penWidthMm / 2) * editor.slots[0].scale;
  });
  const pixelAt = (x, y) =>
    page.evaluate(
      ([x, y]) => {
        const canvas = document.getElementById("editor-canvas");
        const box = canvas.getBoundingClientRect();
        const scale = canvas.width / box.width;
        const [r, g, b] = canvas.getContext("2d").getImageData(Math.round((x - box.left) * scale), Math.round((y - box.top) * scale), 1, 1).data;
        return r + g + b;
      },
      [x, y],
    );
  await pen("mouseMoved", [cx, cy], 0, 0);
  await settle();
  // Just inside the ring, above where the pen is: dark while the cursor is there.
  const ringPoint = [cx, cy - ringRadius];
  const withCursor = await pixelAt(...ringPoint);
  let during = null;
  await line(
    Array.from({ length: 40 }, (_, i) => [cx + i * 5, cy]),
    Array.from({ length: 40 }, () => 0.2),
    {
      during: async (i) => {
        if (i !== 39) return true;
        await settle();
        during = await pixelAt(...ringPoint);
        return true;
      },
    },
  );
  check(withCursor < 500, `the pen's cursor shows where the pen is (${withCursor})`);
  check(during !== null && during > 700, `while a line is drawn away from it, the cursor does not stay where the pen came down (${during})`);
  await page.evaluate(() => {
    window.nameStudio.workbench.editor.penWidthMm = 0.4;
  });

  // A long line: each frame paints what the pen added, so the end costs what the start did.
  await page.evaluate(() => {
    const editor = window.nameStudio.workbench.editor;
    const draw = editor.draw.bind(editor);
    editor.draw = () => {
      const start = performance.now();
      draw();
      if (editor.drag?.kind === "pen") window.__frames.push(performance.now() - start);
    };
    window.nameStudioPerf.reset();
  });
  // A spiral within page 11 (out to 80 mm from its middle), 2400 moves.
  const [sx, sy] = await at(11, [130, 190]);
  const mm = (await at(11, [131, 190]))[0] - sx;
  const spiral = Array.from({ length: 2400 }, (_, i) => {
    const a = i / 40;
    const r = (10 + (70 * i) / 2400) * mm;
    return [sx + Math.cos(a) * r, sy + Math.sin(a) * r * 1.3];
  });
  let aheadSeen = 0;
  let aheadFar = 0;
  const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0;
  async function longLine(what) {
    await page.evaluate(() => {
      window.__frames = [];
    });
    await line(
      spiral,
      spiral.map((_, i) => 0.3 + 0.4 * Math.abs(Math.sin(i / 50))),
      {
        during: async (i) => {
          if (i % 200 !== 0) return true;
          const ahead = await page.evaluate(() => {
            const drag = window.nameStudio.workbench.editor.drag;
            const last = drag.points[drag.points.length - 1];
            return (drag.ahead ?? []).map((p) => Math.hypot(p[0] - last[0], p[1] - last[1]) * drag.slot.scale);
          });
          if (ahead.length) aheadSeen++;
          if (ahead.some((d) => d > 30)) aheadFar++;
          return true;
        },
      },
    );
    const frames = await page.evaluate(() => window.__frames);
    const tenth = Math.max(5, Math.floor(frames.length / 10));
    const [first, last] = [median(frames.slice(0, tenth)), median(frames.slice(-tenth))];
    const points = (await lastStroke()).points.length;
    console.log(`     ${what}: ${frames.length} frames for a line of ${points} points: ${first.toFixed(2)} ms a frame at its start, ${last.toFixed(2)} ms at its end`);
    check(frames.length >= 20, `${what}: the long line is drawn over many frames (${frames.length})`);
    check(last <= first * 2 + 1, `${what}: a frame at the end of a long line costs about what one at its start does (${first.toFixed(2)} → ${last.toFixed(2)} ms)`);
  }
  await longLine("a round pen");
  // A brush that stamps its tip (flat, as CSP's 丸ペン at a slant): many stamps a line.
  await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    wb.project.brushes.push({ id: "brush-flat", name: "平たいペン", kind: "pen", sizeMm: 1.2, opacity: 1, hardness: 100, stabilization: 4, taperInMm: 3, taperOutMm: 3, thickness: 40, rotation: 30, sizePressure: { min: 0.2 } });
    wb.editor.penBrush = "brush-flat";
    wb.editor.penWidthMm = 1.2;
  });
  await longLine("a stamped brush");
  await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    wb.editor.penBrush = null;
    wb.editor.penWidthMm = 0.4;
  });
  // Lines let go are added to the picture of the page's lines, not drawn all again: the page looks as drawn anew.
  const differing = await page.evaluate(() => {
    const canvas = document.getElementById("editor-canvas");
    const editor = window.nameStudio.workbench.editor;
    editor.draw();
    const added = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    editor.strokeCache.clear();
    // (Pictures drawn anew take a frame each when they are slow: as many frames as pages.)
    for (let i = 0; i < 4; i++) editor.draw();
    const anew = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < added.length; i++) if (Math.abs(added[i] - anew[i]) > 2) count++;
    return count;
  });
  check(differing === 0, `lines added to the picture of the page look as the page drawn anew (${differing} values differ)`);
  // The strip (物語の帯) follows the lines once the pen rests, not after each of them.
  const thumbIsOld = (mark) =>
    page.evaluate((mark) => {
      const canvas = document.querySelector(`.board-page[data-page="${window.nameStudio.workbench.project.pages[10].id}"] canvas`);
      if (mark) canvas.dataset.old = "1";
      return canvas.dataset.old === "1";
    }, mark);
  await page.waitForTimeout(800);
  await thumbIsOld(true);
  const [tx, ty] = await at(11, [40, 40]);
  await line(Array.from({ length: 20 }, (_, i) => [tx + i * 4, ty]), Array.from({ length: 20 }, () => 0.5));
  const right = await thumbIsOld(false);
  await page.waitForTimeout(800);
  const later = !(await thumbIsOld(false));
  check(right && later, "the strip draws the page again once the pen rests, not as each line ends");
  const report = await page.evaluate(() => window.nameStudioPerf.report());
  console.log(`     動作の記録: input to screen ${JSON.stringify(report.penLatency)}, a frame ${JSON.stringify(report.penFrame)}, ${report.penRate} events a second`);
  check(report.penLatency && report.penLatency.count > 0 && report.penLatency.median > 0, "動作の記録 times the pen's input to the screen");
  check(report.penFrame && report.penFrame.p95 < 16, `a frame of the pen line takes ${report.penFrame?.p95} ms at the most often (under a frame at 60 Hz)`);
  // 先読み: where the browser predicts the pen (Chromium does for its pointer events).
  const predicts = await page.evaluate(() => typeof PointerEvent.prototype.getPredictedEvents === "function");
  if (predicts && aheadSeen) {
    check(aheadFar === 0, "先読み goes only a little ahead (30 px at most)");
    const stored = (await lastStroke()).points;
    const end = stored[stored.length - 1];
    const lastSent = await page.evaluate(([x, y]) => {
      const wb = window.nameStudio.workbench;
      const slot = wb.editor.slots.find((s) => s.page.id === wb.project.pages[10].id);
      const rect = document.getElementById("editor-canvas").getBoundingClientRect();
      return [(x - rect.left - slot.x) / slot.scale, (y - rect.top - slot.y) / slot.scale];
    }, spiral[spiral.length - 1]);
    check(Math.hypot(end[0] - lastSent[0], end[1] - lastSent[1]) < 0.5, "the line kept ends where the pen left the page (none of 先読み in it)");
  } else {
    console.log(`     (先読み not checked: ${predicts ? "this browser predicted nothing for these events" : "no getPredictedEvents"})`);
  }
  check(errors.length === 0, `no errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

// シリーズ in its palette, with files kept in the page: make a series from a
// name, make the next 話 (the cast comes along), change the cast there and
// open the first 話 again (it follows), leave the series and join it again.
// Run: npm run e2e:series
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1435, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  // Files and dialogs: what the dialogs answer is queued by the test.
  await page.addInitScript(() => {
    window.__files = {};
    window.__dialogs = [];
    window.__answer = (command, args) => {
      const files = window.__files;
      switch (command) {
        case "save_project": {
          const body = args;
          const length = new DataView(body.buffer, body.byteOffset).getUint32(0, true);
          const meta = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length)));
          files[meta.path] = new TextDecoder().decode(body.subarray(4 + length));
          return null;
        }
        case "load_project":
        case "load_series":
          if (!(args.path in files)) throw new Error(`no file: ${args.path}`);
          return JSON.parse(files[args.path]);
        case "save_series":
          files[args.path] = args.text;
          return null;
        case "discard_recovery":
          return null;
        case "plugin:dialog|save":
        case "plugin:dialog|open":
          return window.__dialogs.shift() ?? null;
        case "plugin:dialog|message":
          return "Yes";
        default:
          return undefined;
      }
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const first = newProject("第1話", 3);
    first.characters = [{ id: "mina", name: "ミナ" }];
    window.nameStudio.show(first);
  });
  const settle = () => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
  const dialogs = (...answers) => page.evaluate((answers) => window.__dialogs.push(...answers), answers);
  const file = (path) => page.evaluate((path) => (path in window.__files ? JSON.parse(window.__files[path]) : null), path);
  const state = () =>
    page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      return {
        title: wb.project.title,
        series: wb.project.series ?? null,
        characters: wb.project.characters.map((c) => c.name),
        rows: [...document.querySelectorAll(".series-row")].map((row) => row.textContent),
        status: document.getElementById("status").textContent,
      };
    });
  const SERIES = "C:\\作品\\作品.nameseries";
  const FIRST = "C:\\作品\\第1話\\第1話.namestudio";
  const SECOND = "C:\\作品\\第2話\\第2話.namestudio";

  if (!(await page.locator("#series-create").isVisible())) await page.click("#tab-series");
  await page.waitForSelector("#series-create", { state: "visible" });

  // The name is saved first, then the series file is chosen.
  await dialogs(FIRST, SERIES);
  await page.click("#series-create");
  await settle();
  let s = await state();
  let series = await file(SERIES);
  check(s.series === "../作品.nameseries" && (await file(FIRST))?.series === "../作品.nameseries", `the name links to its series (${s.series} / ${s.status})`);
  check(
    series?.title === "作品" && series.episodes.length === 1 && series.episodes[0].path === "第1話/第1話.namestudio" && series.episodes[0].storyIndex === 1,
    `the series lists the first 話 (${JSON.stringify(series?.episodes)})`,
  );
  check(s.rows.length === 1 && s.rows[0].includes("第1話"), `the palette lists it (${s.rows})`);

  // The next 話: blank, with the series' cast, saved next to the series.
  await dialogs(SECOND);
  // As many pages as asked for (the open one has 3).
  check((await page.inputValue("#series-next-pages")) === "3", "the next 話's page count starts as the open one's");
  await page.fill("#series-next-pages", "8");
  await page.dispatchEvent("#series-next-pages", "change");
  await page.click("#series-next");
  await settle();
  s = await state();
  series = await file(SERIES);
  const made = await page.evaluate(() => ({ pages: window.nameStudio.workbench.project.pages.length, target: window.nameStudio.workbench.project.plan?.targetPages }));
  check(made.pages === 8 && made.target === 8, `with the pages asked for, as its target too (${JSON.stringify(made)})`);
  check(s.title === "第2話" && s.characters.join() === "ミナ" && s.series === "../作品.nameseries", `the next 話 has the cast (${JSON.stringify(s)})`);
  check(series?.episodes.map((one) => one.storyIndex).join() === "1,2" && (await file(SECOND))?.storyIndex === 2, "the series lists both, in order");
  check(s.rows.length === 2, `the palette lists both (${s.rows})`);

  // A character added in the second 話 goes to the series, and to the first 話 when it opens.
  await page.evaluate(async () => {
    const wb = window.nameStudio.workbench;
    wb.project.characters.push({ id: "kai", name: "カイ" });
    await wb.save();
  });
  series = await file(SERIES);
  check(series?.shared.characters.map((c) => c.name).join() === "ミナ,カイ", `the series takes the new cast (${JSON.stringify(series?.shared.characters)})`);
  await page.locator(".series-row").first().click();
  await settle();
  s = await state();
  check(s.title === "第1話" && s.characters.join() === "ミナ,カイ", `the first 話 opens with the series' cast (${JSON.stringify(s)})`);

  // Out of the series, and in again.
  await page.click("#series-leave");
  await settle();
  s = await state();
  series = await file(SERIES);
  check(
    s.series === null && series?.episodes.length === 1 && (await page.locator("#series-join").isVisible()),
    `the first 話 left the series (${JSON.stringify(series?.episodes)})`,
  );
  await dialogs(SERIES);
  await page.click("#series-join");
  await settle();
  s = await state();
  series = await file(SERIES);
  check(s.series === "../作品.nameseries" && series?.episodes.map((one) => one.storyIndex).join() === "1,2", `it joined again (${JSON.stringify(series?.episodes)})`);
  await page.keyboard.press("Control+z");
  await settle();
  check((await state()).series === null && (await page.locator("#series-join").isVisible()), "undo takes the joining back");

  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

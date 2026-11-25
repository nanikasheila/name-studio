// The built app, for real: its window opens a small name and writes it out
// for CSP from the command line (--export-csp), so what only the real window
// has (the WebView, its Content-Security-Policy, the calls to the Rust side)
// is checked too, once with a CSP-made template page, once with the one
// the app makes from its own settings (--builtin, with a work) and once with
// each panel as a folder with a layer mask (--panel-masks), with two
// ラフ線のレイヤー, with 指示 (and --no-marks, then added by セリフだけ反映), a name saved by
// a newer version (its report says what this one leaves out), and a 縦スクロール
// whose pieces are joined into one tall page, and a page drawn on as in CSP
// (examples/csp_drawn.rs) read back with --read-back, and a work whose pages were
// added, deleted and moved as in CSP (examples/csp_pages.rs). The exports run side by side
// (one after another on Windows), each the app started on its own. Needs the
// release build and a template page:
//   npx tauri build --no-bundle
//   cargo run -p clip-core --features fixtures --example fixture_page -- <dir>/page.clip
//   node e2e/realapp.mjs <dir>
// (on Linux under xvfb-run).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = process.argv[2];
const app = join(root, "..", "target", "release", process.platform === "win32" ? "name-studio-app.exe" : "name-studio-app");
if (!dir || !existsSync(join(dir, "page.clip")) || !existsSync(app)) {
  console.error("usage: node e2e/realapp.mjs <dir with page.clip> (after the release build)");
  process.exit(2);
}

// A name of three pages with a panel, a line of dialogue, a rough line and a memo.
const server = await createServer({ root, logLevel: "error", server: { middlewareMode: true } });
const P = {};
for (const module of ["domain/project", "domain/panels", "domain/dialogue", "model/geometry"])
  Object.assign(P, await server.ssrLoadModule(`/src/${module}.ts`));
const { projectJson } = await server.ssrLoadModule("/src/domain/projectjson.ts");
const { cspPageOf } = await server.ssrLoadModule("/src/domain/csppage.ts");
const project = P.newProject("通しテスト", 3);
const page = project.pages[0];
P.addPanel(project, page, P.rectShape([20, 20, 160, 120]));
P.setLineText(P.addLine(project, page, [40, 40, 60, 100]), "セリフ");
page.strokes.push({
  id: "rough1",
  points: [
    [30, 30, 0.5],
    [90, 90, 0.5],
  ],
  widthMm: 0.5,
  closed: false,
});
page.memo = "メモ";
// The same name with its rough lines on two layers (人物 hidden and faint): one CSP layer more.
const layered = structuredClone(project);
layered.roughLayers = [
  { id: "rough", name: "ラフ線" },
  { id: "rough9", name: "人物", hidden: true, opacity: 0.5 },
];
layered.pages[0].strokes.push({
  id: "rough2",
  points: [
    [40, 30, 0.5],
    [90, 60, 0.5],
  ],
  widthMm: 0.5,
  closed: false,
  layer: "rough9",
});
// The same name with 指示 in red on a 指示のレイヤー: a 下描き layer more on top (none with --no-marks).
const marked = structuredClone(project);
marked.roughLayers = [
  { id: "rough", name: "ラフ線" },
  { id: "rough8", name: "指示", marks: true },
];
marked.pages[0].strokes.push({
  id: "mark1",
  points: [
    [50, 50, 1],
    [120, 70, 1],
  ],
  widthMm: 0.6,
  closed: false,
  layer: "rough8",
});
// The same name with a 資料 picture and a picture of the name (取り込んだネーム画像) on page 1: a 下描き layer each.
const pictured = structuredClone(project);
const dot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
pictured.images = [
  { id: "image1", name: "資料", mime: "image/png", dataBase64: dot, widthPx: 1, heightPx: 1 },
  { id: "image2", name: "ネーム 1", mime: "image/png", dataBase64: dot, widthPx: 1, heightPx: 1 },
];
pictured.pages[0].references = [
  { id: "reference1", image: "image1", box: [30, 30, 80, 80] },
  { id: "reference2", image: "image2", box: [20, 28, 277, 392], kind: "name" },
];
// A 縦スクロール of three pieces, joined: one tall page.
const scroll = P.newProject("縦スクロール", 3, "scroll");
for (const piece of scroll.pages) P.setLineText(P.addLine(scroll, piece, [40, 40, 60, 100]), "セリフ");
scroll.cspPage = { ...cspPageOf(scroll), joinPieces: true };
// One page drawn on in CSP after the export (examples/csp_drawn.rs), then read back.
const drawnOn = P.newProject("読み戻し", 1);
const drawnPage = drawnOn.pages[0];
P.addPanel(drawnOn, drawnPage, P.rectShape([20, 20, 160, 100]));
P.addPanel(drawnOn, drawnPage, P.rectShape([20, 110, 160, 200]));
for (const [i, y] of [40, 60, 80].entries())
  drawnPage.strokes.push({
    id: `rough${i + 1}`,
    points: [
      [30, y, 0.5],
      [90, y + 10, 0.5],
    ],
    widthMm: 0.5,
    closed: false,
  });
// A work of four pages whose pages are changed in CSP after the export (examples/csp_pages.rs).
const pagesOn = P.newProject("ページの読み戻し", 4);
for (const [i, page] of pagesOn.pages.entries())
  page.strokes.push({
    id: `line${i + 1}`,
    points: [
      [30, 40 + i * 20, 0.5],
      [90, 50 + i * 20, 0.5],
    ],
    widthMm: 0.5,
    closed: false,
  });
await server.close();
// As a newer version would save it: a field this version does not know, on a stroke.
const newer = JSON.parse(projectJson(project));
newer.pages[0].strokes[0].wobble = 0.3;
const newerName = join(dir, "newer.namestudio");
writeFileSync(newerName, JSON.stringify(newer));
const name = join(dir, "test.namestudio");
writeFileSync(name, projectJson(project));
const scrollName = join(dir, "scroll.namestudio");
writeFileSync(scrollName, projectJson(scroll));
const layeredName = join(dir, "layered.namestudio");
writeFileSync(layeredName, projectJson(layered));
const markedName = join(dir, "marked.namestudio");
writeFileSync(markedName, projectJson(marked));
const picturedName = join(dir, "pictured.namestudio");
writeFileSync(picturedName, projectJson(pictured));
// The same with the 資料's data spoilt: the WebView cannot decode it.
const spoilt = structuredClone(pictured);
spoilt.images[0].dataBase64 = Buffer.from("not a picture").toString("base64");
const spoiltName = join(dir, "spoilt.namestudio");
writeFileSync(spoiltName, projectJson(spoilt));
const drawnName = join(dir, "drawn.namestudio");
writeFileSync(drawnName, projectJson(drawnOn));
const pagesName = join(dir, "pages.namestudio");
writeFileSync(pagesName, projectJson(pagesOn));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

// Each export is the app started on its own. They run side by side, as many
// at once as the machine has cores (on Windows one after another: the app
// keeps its built-in template in the one local data folder Windows gives it,
// which no environment variable moves). On Linux each gets its own data
// folders, so two never write the same built-in template at once.
const parallel = process.platform === "win32" ? 1 : Math.max(1, availableParallelism());
let running = 0;
const waiting = [];
async function slot(work) {
  while (running >= parallel) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Run the app with `args`: its exit code, stderr and how long it took. */
function runApp(label, args) {
  return slot(
    () =>
      new Promise((resolve) => {
        const home = join(dir, ".data", label);
        const env =
          process.platform === "linux"
            ? {
                ...process.env,
                XDG_DATA_HOME: join(home, "data"),
                XDG_CONFIG_HOME: join(home, "config"),
                XDG_CACHE_HOME: join(home, "cache"),
              }
            : process.env;
        const started = Date.now();
        const child = spawn(app, args, { env, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (text) => {
          stderr += text;
        });
        const timer = setTimeout(() => child.kill(), 180000);
        const done = (status, error) => {
          clearTimeout(timer);
          console.log(`     ${label}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
          resolve({ status, error, stderr });
        };
        child.on("error", (error) => done(null, error));
        child.on("close", (status) => done(status));
      }),
  );
}

const readReport = (out) => {
  const reportPath = join(out, "name-studio-export.json");
  return existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8").replace(/^\uFEFF/, "")) : null;
};

/** Export with `args` into a folder of its own: the run and its report. */
async function exportTo(label, args, file = name) {
  const out = join(dir, label);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  const run = await runApp(label, ["--export-csp", file, ...args, "--out", out]);
  return { run, report: readReport(out) };
}

/** Check the app and the pages of an export; its report. */
function checked(label, { run, report }, pages = 3) {
  check(run.status === 0, `${label}: the app exits cleanly (${run.status ?? run.error?.message})`);
  check(report?.ok === true, `${label}: the export reports success (${report?.error ?? report?.summary?.join(" / ") ?? "no report"})`);
  check(report?.pages?.length === pages && report.pages.every((path) => existsSync(path)), `${label}: it wrote ${pages} page(s)`);
  check(report?.checks?.every((c) => c.problems.length === 0) ?? false, `${label}: each page reads back as sent`);
  if (failures.length && run.stderr) console.error(run.stderr);
  return report;
}

const started = Date.now();
// CSP から読み戻す: drawn on in CSP (as examples/csp_drawn.rs does), read back
// into the name, read back again (nothing new) and written out once more.
async function drawnThenReadBack() {
  const exported = await exportTo("drawn", ["--builtin"], drawnName);
  const before = readFileSync(drawnName, "utf8");
  const page = exported.report?.pages?.[0];
  const drawing = page
    ? await new Promise((resolve) => {
        const child = spawn("cargo", ["run", "-q", "-p", "clip-core", "--example", "csp_drawn", "--", page], {
          cwd: join(root, ".."),
          stdio: ["ignore", "ignore", "inherit"],
        });
        child.on("error", () => resolve(null));
        child.on("close", resolve);
      })
    : null;
  const back = [];
  for (const round of ["first", "again"]) {
    const run = await runApp(`readback-${round}`, ["--export-csp", drawnName, "--builtin", "--read-back", "--out", join(dir, "drawn")]);
    back.push({ run, report: readReport(join(dir, "drawn")), name: JSON.parse(readFileSync(drawnName, "utf8")) });
  }
  const again = await exportTo("drawn-again", ["--builtin"], drawnName);
  return { exported, before: JSON.parse(before), drawing, back, again };
}
/** Run an example of clip-core on `path`: its exit code. */
const example = (name, path) =>
  path
    ? new Promise((resolve) => {
        const child = spawn("cargo", ["run", "-q", "-p", "clip-core", "--example", name, "--", path], {
          cwd: join(root, ".."),
          stdio: ["ignore", "ignore", "inherit"],
        });
        child.on("error", () => resolve(null));
        child.on("close", resolve);
      })
    : null;
// The work's pages changed in CSP (added, deleted, moved; examples/csp_pages.rs), read back twice, then セリフだけ反映.
async function pagesThenReadBack() {
  const exported = await exportTo("pages", ["--builtin", "--work-name", "ページ"], pagesName);
  const before = JSON.parse(readFileSync(pagesName, "utf8"));
  const changed = await example("csp_pages", exported.report?.work);
  const back = [];
  for (const round of ["first", "again"]) {
    const run = await runApp(`pages-${round}`, ["--export-csp", pagesName, "--builtin", "--read-back", "--out", join(dir, "pages")]);
    back.push({ run, report: readReport(join(dir, "pages")), name: JSON.parse(readFileSync(pagesName, "utf8")) });
  }
  const run = await runApp("pages-update", ["--export-csp", pagesName, "--builtin", "--update-dialogue", "--out", join(dir, "pages")]);
  return { exported, before, changed, back, update: { run, report: readReport(join(dir, "pages")) } };
}
// 指示 drawn after the export: セリフだけ反映 adds them to those pages as a layer,
// and leaves them be the next time. Two runs on that folder, one after the other.
async function unmarkedThenUpdated() {
  const unmarked = await exportTo("unmarked", ["--builtin", "--no-marks"], markedName);
  const updates = [];
  for (const round of ["first", "again"]) {
    const run = await runApp(`update-${round}`, [
      "--export-csp",
      markedName,
      "--builtin",
      "--update-dialogue",
      "--out",
      join(dir, "unmarked"),
    ]);
    const record = join(dir, "unmarked", "name-studio-反映の記録.txt");
    updates.push({
      round,
      run,
      report: readReport(join(dir, "unmarked")),
      record: existsSync(record) ? readFileSync(record, "utf8").replace(/^\uFEFF/, "") : "",
    });
  }
  return { unmarked, updates };
}
const [out, builtinRun, masksRun, layeredRun, markedRun, unmarkedRuns, picturedRun, spoiltRun, newerRun, tallRun, drawn, paged] =
  await Promise.all([
    exportTo("out", ["--template", join(dir, "page.clip")]),
    exportTo("builtin", ["--builtin", "--work-name", "通しテスト", "--story-index", "1"]),
    exportTo("masks", ["--builtin", "--panel-masks"]),
    exportTo("layered", ["--builtin"], layeredName),
    exportTo("marked", ["--builtin"], markedName),
    unmarkedThenUpdated(),
    exportTo("pictured", ["--builtin"], picturedName),
    exportTo("spoilt", ["--builtin"], spoiltName),
    exportTo("newer", ["--builtin"], newerName),
    exportTo("tall", ["--builtin", "--work-name", "縦スクロール"], scrollName),
    drawnThenReadBack(),
    pagesThenReadBack(),
  ]);
console.log(`     all exports: ${((Date.now() - started) / 1000).toFixed(1)} s, ${parallel} at once`);

checked("out", out);
const builtin = checked("builtin", builtinRun);
check(!!builtin?.work && existsSync(builtin.work), "builtin: it wrote the work (.cmc)");
check(builtin?.workCheck?.problems?.length === 0, "builtin: the work reads back as sent");
check(builtin?.vectorLayers === true && builtin?.textLayers === true, "builtin: the panels and dialogue are editable layers");
// Each panel as a folder with a layer mask: the pages read back with the folder, its mask and the rough in it.
const masks = checked("masks", masksRun);
check(
  (masks?.checks?.[0]?.layers ?? 0) > (builtin?.checks?.[0]?.layers ?? 0),
  "masks: the first page has the panel's folder and its layers",
);
const layers = checked("layered", layeredRun);
check(
  (layers?.checks?.[0]?.layers ?? 0) === (builtin?.checks?.[0]?.layers ?? 0) + 1,
  "layered: the rough layer 人物 is a layer of its own",
);
const withMarks = checked("marked", markedRun);
check((withMarks?.checks?.[0]?.layers ?? 0) === (builtin?.checks?.[0]?.layers ?? 0) + 1, "marked: the 指示 are a layer of their own");
const noMarks = checked("unmarked", unmarkedRuns.unmarked);
check((noMarks?.checks?.[0]?.layers ?? 0) === (builtin?.checks?.[0]?.layers ?? 0), "unmarked: --no-marks leaves them out");
for (const { round, run, report, record } of unmarkedRuns.updates) {
  const want = round === "first" ? ["指示"] : [];
  check(
    run.status === 0 && report?.ok === true,
    `update (${round}): セリフだけ反映 succeeds (${report?.summary?.join(" / ") ?? run.stderr})`,
  );
  const drawn = report?.pages?.[0]?.marks ?? [];
  check(
    JSON.stringify(drawn) === JSON.stringify(want),
    `update (${round}): the 指示 redrawn on the first page are ${JSON.stringify(want)} (${JSON.stringify(drawn)})`,
  );
  // The record kept with the pages: one entry for the run that changed a page, none for the one that did not.
  const entries = record.split(/\r\n/).filter((line) => line.startsWith("■ "));
  check(
    entries.length === 1 && entries[0].endsWith("「通しテスト」セリフだけ反映") && record.includes("・1 ページ: 指示を描き直した"),
    `update (${round}): the record in the export folder has the one run that changed a page (${entries.length} entries)`,
  );
}
const withPictures = checked("pictured", picturedRun);
check(
  (withPictures?.checks?.[0]?.layers ?? 0) === (builtin?.checks?.[0]?.layers ?? 0) + 2,
  "pictured: the 資料 and the picture of the name are a layer each",
);
// A picture that cannot be read: the pages go out without it, and the report says which, on which page.
const withSpoilt = checked("spoilt", spoiltRun);
check(
  (withSpoilt?.summary ?? []).includes("注意: 読めない画像 1 枚は書き出していません: 1 ページ「資料」"),
  `spoilt: the report names the picture left out (${(withSpoilt?.summary ?? []).find((line) => line.includes("画像")) ?? "nothing"})`,
);
check(!(withPictures?.summary ?? []).some((line) => line.includes("読めない画像")), "pictured: pictures that read say nothing of the kind");
// A name saved by a newer version: it still goes out, and the report says first what this one leaves out.
const fromNewer = checked("newer", newerRun);
check(
  /^注意: このネームには、この版が知らない項目があります.*pages\.strokes\.wobble/.test(fromNewer?.summary?.[0] ?? ""),
  `newer: the report says first what this version does not know (${fromNewer?.summary?.[0]})`,
);
check(!(builtin?.summary ?? []).some((line) => line.includes("知らない項目")), "builtin: a name of this version says nothing of the kind");
const tall = checked("tall", tallRun, 1);
check(tall?.textLayers === true && (tall?.checks?.[0]?.layers ?? 0) > 0, "tall: the joined page has its layers");
checked("drawn", drawn.exported, 1);
check(drawn.drawing === 0, `drawn: the page was drawn on as in CSP (${drawn.drawing})`);
{
  const [first, again] = drawn.back;
  check(
    first.run.status === 0 && first.report?.ok === true,
    `readback: it reads back (${first.report?.summary?.join(" / ") ?? first.run.stderr})`,
  );
  const was = drawn.before.pages[0];
  const now = first.name.pages[0];
  const ids = now.strokes.map((s) => s.id);
  check(!ids.includes("rough1"), "readback: the line deleted in CSP is gone");
  const moved = now.strokes.find((s) => s.id === "rough2");
  const shift = moved ? moved.points[0][0] - was.strokes[1].points[0][0] : 0;
  check(
    shift > 1 && Math.abs(moved.points[0][1] - was.strokes[1].points[0][1]) < 0.2,
    `readback: the line moved in CSP moved right (${shift.toFixed(2)} mm)`,
  );
  check(ids.includes("rough3") && now.strokes.length === 3, `readback: the line drawn in CSP is a rough line (${ids.join(", ")})`);
  check(now.panels.length === 3, `readback: the line across a panel cut it in two (${now.panels.length} panels)`);
  const nudged = now.panels.filter((panel) => !was.panels.some((old) => JSON.stringify(old.shape) === JSON.stringify(panel.shape)));
  check(nudged.length === 3, `readback: one panel moved, the other cut (${nudged.length} of ${now.panels.length} new shapes)`);
  const pictures = (now.references ?? []).filter((r) => r.kind === "drawing");
  check(
    pictures.length === 1 && pictures[0].layer === "下描き",
    `readback: the raster drawn in CSP is a CSP の絵 on 下描き (${JSON.stringify(pictures.map((r) => r.layer))})`,
  );
  const box = pictures[0]?.box ?? [0, 0, 0, 0];
  const sizeMm = box[2] - box[0];
  check(sizeMm > 1 && Math.abs(sizeMm - (box[3] - box[1])) < 0.2, `readback: the picture is the square drawn (${sizeMm.toFixed(2)} mm)`);
  check(
    again.run.status === 0 && again.report?.summary?.[0] === "CSP で変えたものはありませんでした",
    `readback: reading back again takes nothing twice (${again.report?.summary?.[0]})`,
  );
  check(JSON.stringify(again.name) === JSON.stringify(first.name), "readback: the name is as the first read-back left it");
  const written = checked("drawn-again", drawn.again, 1);
  check(
    (written?.checks?.[0]?.layers ?? 0) === (drawn.exported.report?.checks?.[0]?.layers ?? 0) + 1,
    "drawn-again: the CSP の絵 is a layer of its own",
  );
}
checked("pages", paged.exported, 4);
check(paged.changed === 0, `pages: the work's pages were changed as in CSP (${paged.changed})`);
{
  const [first, again] = paged.back;
  check(
    first.run.status === 0 && first.report?.ok === true,
    `pages readback: it reads back (${first.report?.summary?.join(" / ") ?? first.run.stderr})`,
  );
  const [p1, p2, p3, p4] = paged.before.pages.map((page) => page.id);
  const order = first.name.pages.map((page) => page.id);
  const added = order.find((id) => !paged.before.pages.some((page) => page.id === id));
  // CSP: 1, new, 4, 2 (3 deleted there: left in the name, after the page it follows, until 保留 is picked).
  check(
    JSON.stringify(order) === JSON.stringify([p1, added, p4, p2, p3]),
    `pages readback: the page added in CSP is in its place and the pages in CSP's order (${order.join(", ")})`,
  );
  const page = first.name.pages.find((p) => p.id === added);
  const pictures = (page?.references ?? []).filter((r) => r.kind === "drawing");
  check(
    pictures.length === 1 && pictures[0].layer === "下描き" && (page?.strokes.length ?? -1) === 0,
    `pages readback: what was drawn on the new page comes with it (${JSON.stringify(pictures.map((r) => r.layer))}, ${page?.strokes.length} lines)`,
  );
  check(
    (first.report?.summary ?? []).some((line) => line.includes("CSP で消したページ 1 はネームに残しました")),
    "pages readback: the page deleted in CSP is said to be left in the name",
  );
  check(
    again.run.status === 0 && again.report?.summary?.[0] === "CSP で変えたものはありませんでした",
    `pages readback: reading back again takes nothing twice (${again.report?.summary?.[0]})`,
  );
  check(JSON.stringify(again.name) === JSON.stringify(first.name), "pages readback: the name is as the first read-back left it");
  // セリフだけ反映 finds each page's file by the pages it holds (the new page is in the file CSP made).
  const update = paged.update.report;
  check(
    paged.update.run.status === 0 && update?.ok === true,
    `pages update: every page's file is found (${update?.summary?.join(" / ") ?? paged.update.run.stderr})`,
  );
}
if (failures.length) process.exit(1);

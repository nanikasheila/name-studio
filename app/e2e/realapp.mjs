// The built app, for real: its window opens a small name and writes it out
// for CSP from the command line (--export-csp), so what only the real window
// has (the WebView, its Content-Security-Policy, the calls to the Rust side)
// is checked too, once with a CSP-made template page, once with the one
// the app makes from its own settings (--builtin, with a work) and once with
// each panel as a folder with a layer mask (--panel-masks), with two
// ラフ線のレイヤー, with 指示 (and --no-marks, then added by セリフだけ反映), a name saved by
// a newer version (its report says what this one leaves out), and a 縦スクロール
// whose pieces are joined into one tall page. The exports run side by side
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
for (const module of ["project", "panels", "dialogue", "geometry"]) Object.assign(P, await server.ssrLoadModule(`/src/${module}.ts`));
const { projectJson } = await server.ssrLoadModule("/src/domain/projectjson.ts");
const { cspPageOf } = await server.ssrLoadModule("/src/domain/csppage.ts");
const project = P.newProject("通しテスト", 3);
const page = project.pages[0];
P.addPanel(project, page, P.rectShape([20, 20, 160, 120]));
P.setLineText(P.addLine(project, page, [40, 40, 60, 100]), "セリフ");
page.strokes.push({ id: "rough1", points: [[30, 30, 0.5], [90, 90, 0.5]], widthMm: 0.5, closed: false });
page.memo = "メモ";
// The same name with its rough lines on two layers (人物 hidden and faint): one CSP layer more.
const layered = structuredClone(project);
layered.roughLayers = [{ id: "rough", name: "ラフ線" }, { id: "rough9", name: "人物", hidden: true, opacity: 0.5 }];
layered.pages[0].strokes.push({ id: "rough2", points: [[40, 30, 0.5], [90, 60, 0.5]], widthMm: 0.5, closed: false, layer: "rough9" });
// The same name with 指示 in red on a 指示のレイヤー: a 下描き layer more on top (none with --no-marks).
const marked = structuredClone(project);
marked.roughLayers = [{ id: "rough", name: "ラフ線" }, { id: "rough8", name: "指示", marks: true }];
marked.pages[0].strokes.push({ id: "mark1", points: [[50, 50, 1], [120, 70, 1]], widthMm: 0.6, closed: false, layer: "rough8" });
// The same name with a 資料 picture and a picture of the name (取り込んだネーム画像) on page 1: a 下描き layer each.
const pictured = structuredClone(project);
const dot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
pictured.images = [{ id: "image1", name: "資料", mime: "image/png", dataBase64: dot, widthPx: 1, heightPx: 1 }, { id: "image2", name: "ネーム 1", mime: "image/png", dataBase64: dot, widthPx: 1, heightPx: 1 }];
pictured.pages[0].references = [
  { id: "reference1", image: "image1", box: [30, 30, 80, 80] },
  { id: "reference2", image: "image2", box: [20, 28, 277, 392], kind: "name" },
];
// A 縦スクロール of three pieces, joined: one tall page.
const scroll = P.newProject("縦スクロール", 3, "scroll");
for (const piece of scroll.pages) P.setLineText(P.addLine(scroll, piece, [40, 40, 60, 100]), "セリフ");
scroll.cspPage = { ...cspPageOf(scroll), joinPieces: true };
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
            ? { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache") }
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
// 指示 drawn after the export: セリフだけ反映 adds them to those pages as a layer,
// and leaves them be the next time. Two runs on that folder, one after the other.
async function unmarkedThenUpdated() {
  const unmarked = await exportTo("unmarked", ["--builtin", "--no-marks"], markedName);
  const updates = [];
  for (const round of ["first", "again"]) {
    const run = await runApp(`update-${round}`, ["--export-csp", markedName, "--builtin", "--update-dialogue", "--out", join(dir, "unmarked")]);
    const record = join(dir, "unmarked", "name-studio-反映の記録.txt");
    updates.push({ round, run, report: readReport(join(dir, "unmarked")), record: existsSync(record) ? readFileSync(record, "utf8").replace(/^\uFEFF/, "") : "" });
  }
  return { unmarked, updates };
}
const [out, builtinRun, masksRun, layeredRun, markedRun, unmarkedRuns, picturedRun, spoiltRun, newerRun, tallRun] = await Promise.all([
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
]);
console.log(`     all exports: ${((Date.now() - started) / 1000).toFixed(1)} s, ${parallel} at once`);

checked("out", out);
const builtin = checked("builtin", builtinRun);
check(!!builtin?.work && existsSync(builtin.work), "builtin: it wrote the work (.cmc)");
check(builtin?.workCheck?.problems?.length === 0, "builtin: the work reads back as sent");
check(builtin?.vectorLayers === true && builtin?.textLayers === true, "builtin: the panels and dialogue are editable layers");
// Each panel as a folder with a layer mask: the pages read back with the folder, its mask and the rough in it.
const masks = checked("masks", masksRun);
check((masks?.checks?.[0]?.layers ?? 0) > (builtin?.checks?.[0]?.layers ?? 0), "masks: the first page has the panel's folder and its layers");
const layers = checked("layered", layeredRun);
check((layers?.checks?.[0]?.layers ?? 0) === (builtin?.checks?.[0]?.layers ?? 0) + 1, "layered: the rough layer 人物 is a layer of its own");
const withMarks = checked("marked", markedRun);
check((withMarks?.checks?.[0]?.layers ?? 0) === (builtin?.checks?.[0]?.layers ?? 0) + 1, "marked: the 指示 are a layer of their own");
const noMarks = checked("unmarked", unmarkedRuns.unmarked);
check((noMarks?.checks?.[0]?.layers ?? 0) === (builtin?.checks?.[0]?.layers ?? 0), "unmarked: --no-marks leaves them out");
for (const { round, run, report, record } of unmarkedRuns.updates) {
  const want = round === "first" ? ["指示"] : [];
  check(run.status === 0 && report?.ok === true, `update (${round}): セリフだけ反映 succeeds (${report?.summary?.join(" / ") ?? run.stderr})`);
  const drawn = report?.pages?.[0]?.marks ?? [];
  check(JSON.stringify(drawn) === JSON.stringify(want), `update (${round}): the 指示 redrawn on the first page are ${JSON.stringify(want)} (${JSON.stringify(drawn)})`);
  // The record kept with the pages: one entry for the run that changed a page, none for the one that did not.
  const entries = record.split(/\r\n/).filter((line) => line.startsWith("■ "));
  check(
    entries.length === 1 && entries[0].endsWith("「通しテスト」セリフだけ反映") && record.includes("・1 ページ: 指示を描き直した"),
    `update (${round}): the record in the export folder has the one run that changed a page (${entries.length} entries)`,
  );
}
const withPictures = checked("pictured", picturedRun);
check((withPictures?.checks?.[0]?.layers ?? 0) === (builtin?.checks?.[0]?.layers ?? 0) + 2, "pictured: the 資料 and the picture of the name are a layer each");
// A picture that cannot be read: the pages go out without it, and the report says which, on which page.
const withSpoilt = checked("spoilt", spoiltRun);
check(
  (withSpoilt?.summary ?? []).includes("注意: 読めない画像 1 枚は書き出していません: 1 ページ「資料」"),
  `spoilt: the report names the picture left out (${(withSpoilt?.summary ?? []).find((line) => line.includes("画像")) ?? "nothing"})`,
);
check(!(withPictures?.summary ?? []).some((line) => line.includes("読めない画像")), "pictured: pictures that read say nothing of the kind");
// A name saved by a newer version: it still goes out, and the report says first what this one leaves out.
const fromNewer = checked("newer", newerRun);
check(/^注意: このネームには、この版が知らない項目があります.*pages\.strokes\.wobble/.test(fromNewer?.summary?.[0] ?? ""), `newer: the report says first what this version does not know (${fromNewer?.summary?.[0]})`);
check(!(builtin?.summary ?? []).some((line) => line.includes("知らない項目")), "builtin: a name of this version says nothing of the kind");
const tall = checked("tall", tallRun, 1);
check(tall?.textLayers === true && (tall?.checks?.[0]?.layers ?? 0) > 0, "tall: the joined page has its layers");
if (failures.length) process.exit(1);

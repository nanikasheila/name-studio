// The built app, for real: its window opens a small name and writes it out
// for CSP from the command line (--export-csp), so what only the real window
// has (the WebView, its Content-Security-Policy, the calls to the Rust side)
// is checked too, once with a CSP-made template page, once with the one
// the app makes from its own settings (--builtin, with a work) and once with
// each panel as a folder with a layer mask (--panel-masks), with two
// ラフ線のレイヤー, and a 縦スクロール
// whose pieces are joined into one tall page. Needs the
// release build and a template page:
//   npx tauri build --no-bundle
//   cargo run -p clip-core --features fixtures --example fixture_page -- <dir>/page.clip
//   node e2e/realapp.mjs <dir>
// (on Linux under xvfb-run).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { projectJson } = await server.ssrLoadModule("/src/projectjson.ts");
const { cspPageOf } = await server.ssrLoadModule("/src/csppage.ts");
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
// A 縦スクロール of three pieces, joined: one tall page.
const scroll = P.newProject("縦スクロール", 3, "scroll");
for (const piece of scroll.pages) P.setLineText(P.addLine(scroll, piece, [40, 40, 60, 100]), "セリフ");
scroll.cspPage = { ...cspPageOf(scroll), joinPieces: true };
await server.close();
const name = join(dir, "test.namestudio");
writeFileSync(name, projectJson(project));
const scrollName = join(dir, "scroll.namestudio");
writeFileSync(scrollName, projectJson(scroll));
const layeredName = join(dir, "layered.namestudio");
writeFileSync(layeredName, projectJson(layered));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

/** Export with `args`; the report, after checking the app and its pages. */
function exportWith(label, args, { file = name, pages = 3 } = {}) {
  const out = join(dir, label);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  const run = spawnSync(app, ["--export-csp", file, ...args, "--out", out], { timeout: 180000, encoding: "utf8" });
  const reportPath = join(out, "name-studio-export.json");
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8").replace(/^\uFEFF/, "")) : null;
  check(run.status === 0, `${label}: the app exits cleanly (${run.status ?? run.error?.message})`);
  check(report?.ok === true, `${label}: the export reports success (${report?.error ?? report?.summary?.join(" / ") ?? "no report"})`);
  check(report?.pages?.length === pages && report.pages.every((path) => existsSync(path)), `${label}: it wrote ${pages} page(s)`);
  check(report?.checks?.every((c) => c.problems.length === 0) ?? false, `${label}: each page reads back as sent`);
  if (failures.length) console.error(run.stderr);
  return report;
}

exportWith("out", ["--template", join(dir, "page.clip")]);
const builtin = exportWith("builtin", ["--builtin", "--work-name", "通しテスト", "--story-index", "1"]);
check(!!builtin?.work && existsSync(builtin.work), "builtin: it wrote the work (.cmc)");
check(builtin?.workCheck?.problems?.length === 0, "builtin: the work reads back as sent");
check(builtin?.vectorLayers === true && builtin?.textLayers === true, "builtin: the panels and dialogue are editable layers");
// Each panel as a folder with a layer mask: the pages read back with the folder, its mask and the rough in it.
const masks = exportWith("masks", ["--builtin", "--panel-masks"]);
check((masks?.checks?.[0]?.layers ?? 0) > (builtin?.checks?.[0]?.layers ?? 0), "masks: the first page has the panel's folder and its layers");
const layers = exportWith("layered", ["--builtin"], { file: layeredName });
check((layers?.checks?.[0]?.layers ?? 0) === (builtin?.checks?.[0]?.layers ?? 0) + 1, "layered: the rough layer 人物 is a layer of its own");
const tall = exportWith("tall", ["--builtin", "--work-name", "縦スクロール"], { file: scrollName, pages: 1 });
check(tall?.textLayers === true && (tall?.checks?.[0]?.layers ?? 0) > 0, "tall: the joined page has its layers");
if (failures.length) process.exit(1);

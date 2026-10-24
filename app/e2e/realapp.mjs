// The built app, for real: its window opens a small name and writes it out
// for CSP from the command line (--export-csp), so what only the real window
// has (the WebView, its Content-Security-Policy, the calls to the Rust side)
// is checked too. Needs the release build and a template page:
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
const P = await server.ssrLoadModule("/src/project.ts");
const { projectJson } = await server.ssrLoadModule("/src/projectjson.ts");
const project = P.newProject("通しテスト", 3);
const page = project.pages[0];
P.addPanel(project, page, P.rectShape([20, 20, 160, 120]));
P.setLineText(P.addLine(project, page, [40, 40, 60, 100]), "セリフ");
page.strokes.push({ id: "rough1", points: [[30, 30, 0.5], [90, 90, 0.5]], widthMm: 0.5, closed: false });
page.memo = "メモ";
await server.close();
const name = join(dir, "test.namestudio");
writeFileSync(name, projectJson(project));
const out = join(dir, "out");
rmSync(out, { recursive: true, force: true });
mkdirSync(out);

const run = spawnSync(app, ["--export-csp", name, "--template", join(dir, "page.clip"), "--out", out], { timeout: 180000, encoding: "utf8" });
const reportPath = join(out, "name-studio-export.json");
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8").replace(/^﻿/, "")) : null;
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
check(run.status === 0, `the app exits cleanly (${run.status ?? run.error?.message})`);
check(report?.ok === true, `the export reports success (${report?.error ?? report?.summary?.join(" / ") ?? "no report"})`);
check(report?.pages?.length === 3 && report.pages.every((path) => existsSync(path)), "it wrote the three pages");
check(report?.checks?.every((c) => c.problems.length === 0) ?? false, "each page reads back as sent");
if (failures.length) {
  console.error(run.stderr);
  process.exit(1);
}

// The export dialog's ラフ線 settings for the CSP pages: the rough as raster
// or vector layers, their opacity (times each ラフ線のレイヤー's own) and CSP's
// レイヤーカラー go into what is written, are said in the line above the
// buttons, and are kept with the name for the next export.
// Run: node e2e/roughexport.mjs
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1438, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(() => {
    window.__pages = [];
    window.__answer = (command, args) => {
      switch (command) {
        case "prepare_builtin_template":
          return { page: "/t/page.clip", parts: "/t/parts.clip", work: "/t/work.cmc" };
        case "choose_open":
          return "C:\\out";
        case "check_export_target":
        case "record_export":
        case "write_text_file":
          return null;
        case "begin_name_export":
          return {
            widthPx: 1000,
            heightPx: 1400,
            resolution: 100,
            trimPx: null,
            basicPx: null,
            vectorLayers: true,
            textLayers: true,
            frameFolders: false,
            firstPageLeft: null,
            spread: null,
            spreadProblem: null,
          };
        case "export_name_page": {
          const body = args instanceof Uint8Array ? args : new Uint8Array(args);
          const length = new DataView(body.buffer, body.byteOffset).getUint32(0, true);
          window.__pages.push(JSON.parse(new TextDecoder().decode(body.slice(4, 4 + length))));
          return { path: "p.clip", problems: [], layers: 0, vectorLines: 0, texts: 0 };
        }
        case "finish_name_export":
          return { pages: [], work: null, workCheck: null };
        case "plugin:dialog|message":
          return "Ok";
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
    const { newProject } = await import("/src/domain/project.ts");
    const project = newProject("第1話", 1);
    project.roughLayers = [
      { id: "rough", name: "ラフ" },
      { id: "faint", name: "背景", opacity: 0.5 },
    ];
    const line = (id, layer, x) => ({
      id,
      points: [
        [x, 40, 0.5],
        [x + 30, 80, 0.5],
      ],
      widthMm: 0.5,
      closed: false,
      ...(layer ? { layer } : {}),
    });
    project.pages[0].strokes = [line("s1", null, 40), line("s2", "faint", 100)];
    window.nameStudio.show(project);
  });
  const settle = () => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
  const lastRequest = () =>
    page.evaluate(() => window.__calls.filter((c) => c.command === "begin_name_export").at(-1)?.args.request ?? null);
  const lastPage = () => page.evaluate(() => window.__pages.at(-1) ?? null);
  const kindOf = (meta, name) => meta?.layers.find((layer) => layer.name === name)?.kind;

  await page.click("#name-export");
  await page.waitForSelector("#name-export-dialog[open]");
  await page.click("#ne-more > summary");
  await page.click("#ne-mode-builtin");
  await page.click("#ne-pick-out-dir");
  const fields = () =>
    page.evaluate(() => ({
      form: document.getElementById("ne-rough-form").value,
      opacity: document.getElementById("ne-rough-opacity").value,
      colorOn: document.getElementById("ne-rough-color-on").checked,
      color: document.getElementById("ne-rough-color").value,
    }));
  let shown = await fields();
  check(
    JSON.stringify(shown) === JSON.stringify({ form: "vector", opacity: "50", colorOn: false, color: "#3e8cec" }),
    `at first as always: vector, 50 % on a 下描き layer, no レイヤーカラー (CSP's blue ready) (${JSON.stringify(shown)})`,
  );

  // As always: vector lines, the 下描き half, no colour.
  await page.click("#ne-run");
  await settle();
  let request = await lastRequest();
  let meta = await lastPage();
  check(kindOf(meta, "ラフ") === "vector" && kindOf(meta, "背景") === "vector", "the rough goes as vector lines");
  check(
    JSON.stringify(request?.rough) === JSON.stringify({ raster: false, opacity: 0.5 }) &&
      request.layerLooks.some((look) => look.name === "背景" && look.whole && look.opacity === 0.25 && !look.color),
    `at half, times a layer's own (${JSON.stringify(request?.layerLooks)})`,
  );

  // Raster, 30 %, レイヤーカラー red.
  await page.selectOption("#ne-rough-form", "raster");
  await page.fill("#ne-rough-opacity", "30");
  await page.dispatchEvent("#ne-rough-opacity", "change");
  await page.fill("#ne-rough-color", "#ff0000");
  shown = await fields();
  check(shown.colorOn, "choosing a colour turns レイヤーカラー on");
  const summary = await page.locator("#ne-summary").textContent();
  check(summary.includes("ラフは下描き（ラスター・不透明度 30%・レイヤーカラー）"), `the line above the buttons says so (${summary})`);
  await page.click("#ne-run");
  await settle();
  request = await lastRequest();
  meta = await lastPage();
  const rough = meta.layers.find((layer) => layer.name === "ラフ");
  check(rough?.kind === "raster" && rough.length > 0, `the rough goes as a picture (${JSON.stringify(rough)})`);
  check(kindOf(meta, "コマ枠") === "vector", "the panels stay vector lines");
  const looks = request?.layerLooks ?? [];
  const look = (name) => looks.find((one) => one.name === name);
  check(
    look("ラフ")?.opacity === 0.3 && look("背景")?.opacity === 0.15 && looks.every((one) => one.name.startsWith("指示") || one.whole),
    `at 30 %, times a layer's own, whatever 下描き has (${JSON.stringify(looks)})`,
  );
  check(
    ["ラフ", "背景", "ラフ（ネーム用紙）"].every((name) => JSON.stringify(look(name)?.color) === "[255,0,0]"),
    "every rough layer (the name sheet's rough too) in the レイヤーカラー",
  );

  // 下描き off: an opacity chosen stays; the usual one goes with it (full without).
  await page.uncheck("#ne-draft");
  check((await fields()).opacity === "30", "a chosen opacity stays when 下描き is turned off");
  await page.fill("#ne-rough-opacity", "50");
  await page.dispatchEvent("#ne-rough-opacity", "change");
  await page.check("#ne-draft");
  await page.uncheck("#ne-draft");
  check((await fields()).opacity === "100", "the usual 50 % becomes the usual 100 % without 下描き");
  await page.check("#ne-draft");
  check((await fields()).opacity === "50", "and back");

  // Not editable: everything is a picture, so the choice is not offered.
  await page.uncheck("#ne-editable");
  check(await page.locator("#ne-rough-form").isDisabled(), "with the lines as pictures, raster or vector is not asked");
  await page.check("#ne-editable");
  check(await page.locator("#ne-rough-form").isEnabled(), "and is again with editable lines");

  // Turned off again: no colour.
  await page.uncheck("#ne-rough-color-on");
  await page.click("#ne-run");
  await settle();
  request = await lastRequest();
  check(
    request?.rough && !("color" in request.rough) && !(request.layerLooks ?? []).some((one) => one.color),
    "レイヤーカラー off writes none",
  );
  check((await fields()).color === "#ff0000", "and keeps the colour for next time");

  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
console.log("all ok");

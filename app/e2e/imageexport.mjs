// 画像・PSD で書き出す, through the export dialog: the 見本のネーム (with a
// 指示 and a memo added) written as one PNG a page into a folder picked once,
// then as PSD 見開き (the layers as the CSP export names them, the memo
// hidden, the paper white or hidden), names taken from the name, files
// already there asked about before anything is written over, a transparent
// PNG, and 前回と同じ設定で to the same folder without asking where.
// Run: npm run e2e:imageexport (-- --out <dir> keeps the PSD bodies for the
// Rust side: name, layers' PNGs).
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1442, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(() => {
    window.__asked = [];
    window.__picked = [];
    window.__there = [];
    window.__answer = (command, args) => {
      switch (command) {
        case "plugin:dialog|message": {
          window.__asked.push(args.message);
          const custom = args.buttons?.OkCancelCustom;
          return custom ? custom[window.__decline ? 1 : 0] : "Ok";
        }
        case "choose_open":
          window.__opened = args.options;
          return window.__picked.shift() ?? null;
        case "place_chosen":
          return window.__chosen ?? false;
        case "existing_files":
          return args.names.filter((name) => window.__there.includes(name));
        case "write_binary_file":
        case "write_psd":
          return null;
        default:
          return undefined;
      }
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(() => localStorage.clear());

  await page.evaluate(async () => {
    const { demoName } = await import("/e2e/demoname.js");
    const { addMarkLayer } = await import("/src/domain/roughlayers.ts");
    const { trimBox } = await import("/src/domain/pagebox.ts");
    const project = demoName(null);
    const mark = addMarkLayer(project, () => "mark1");
    const [x0, y0] = trimBox(project.pageFormat);
    project.pages[1].strokes.push({
      id: "m1",
      points: [
        [x0 + 20, y0 + 20, 0.5],
        [x0 + 80, y0 + 60, 0.5],
      ],
      widthMm: 1,
      closed: false,
      layer: mark.id,
    });
    project.pages[0].memo = "扉。タイトルは大きく";
    window.nameStudio.show(project);
  });
  const calls = (command) => page.evaluate((c) => window.__calls.filter((call) => call.command === c).length, command);
  /** The meta and parts of the bodies sent with `command` since `from`. */
  const bodies = (command, from) =>
    page.evaluate(
      ([c, n]) =>
        window.__calls
          .filter((call) => call.command === c)
          .slice(n)
          .map((call) => {
            const body = call.args;
            const length = new DataView(body.buffer, body.byteOffset).getUint32(0, true);
            const meta = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length)));
            const rest = body.subarray(4 + length);
            let binary = "";
            for (let i = 0; i < rest.length; i += 0x8000) binary += String.fromCharCode(...rest.subarray(i, i + 0x8000));
            return { meta, rest: btoa(binary) };
          }),
      [command, from],
    );
  const pngSize = (bytes) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  const message = () => page.locator("#ne-message").textContent();
  /** Until the export has finished (the button is pressed again). */
  const done = () => page.waitForFunction(() => !document.getElementById("ne-run").disabled);
  const close = async () => {
    await done();
    await page.locator('#name-export-dialog button[value="cancel"]').click();
  };

  await page.locator("#name-export").click();
  await page.locator("#ne-kind-image").click();
  check(!(await page.locator("#ne-image").isHidden()), "画像・PSD shows its settings");
  const summary = await page.locator("#ne-summary").textContent();
  check(summary.includes("8 個の PNG") && summary.includes("350 dpi"), `the summary says what it makes (${summary})`);
  const names = await page.locator("#ne-image-names").textContent();
  check(names.includes("サンプル 部室の片付け_001.png") && names.includes("_008.png"), `the files are named by the name (${names})`);
  check(await page.locator("#ne-image-notes-row").isHidden(), "the memo choice is for PSD only");

  // --- one PNG a page; the folder is asked for the first time -----------------------------
  await page.evaluate(() => window.__picked.push("C:\\out\\画像"));
  await page.locator("#ne-run").click();
  await page.waitForFunction(() => document.getElementById("ne-message").textContent.includes("書き出しました"));
  check((await message()).includes("8 個の PNG"), `8 PNGs are written (${await message()})`);
  const opened = await page.evaluate(() => window.__opened);
  check(opened?.directory === true, "a folder is asked for");
  const pngs = await bodies("write_binary_file", 0);
  check(pngs.length === 8, "one file a page");
  check(pngs[0].meta.path === "C:\\out\\画像\\サンプル 部室の片付け_001.png", `in the folder, by page (${pngs[0].meta.path})`);
  const format = await page.evaluate(() => window.nameStudio.workbench.project.pageFormat);
  const trimPx = format.trimMm.map((mm) => Math.round((mm * 350) / 25.4));
  const first = Buffer.from(pngs[0].rest, "base64");
  check(JSON.stringify(pngSize(first)) === JSON.stringify(trimPx), `cut at the trim at 350 dpi (${pngSize(first)} = ${trimPx})`);
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}/page001.png`, Buffer.from(pngs[0].rest, "base64"));
    writeFileSync(`${out}/page002.png`, Buffer.from(pngs[1].rest, "base64"));
  }

  // --- PSD 見開き ------------------------------------------------------------------------------
  await page.locator("#ne-image-format").selectOption("psd");
  await page.locator("#ne-image-unit").selectOption("spread");
  check(!(await page.locator("#ne-image-notes-row").isHidden()), "PSD offers the memo as a hidden layer");
  const psdSummary = await page.locator("#ne-summary").textContent();
  check(
    psdSummary.includes("5 個の PSD") && psdSummary.includes("見開きごと"),
    `as 5 PSD spreads ([1] [2 3] [4 5] [6 7] [8]) (${psdSummary})`,
  );
  // The folder was picked: it is written to without asking again.
  await page.evaluate(() => {
    window.__chosen = true;
    window.__opened = null;
  });
  await page.locator("#ne-run").click();
  await page.waitForFunction(() => document.getElementById("ne-message").textContent.includes("PSD を書き出しました"));
  check((await page.evaluate(() => window.__opened)) === null, "the folder picked before is not asked for again");
  const psds = await bodies("write_psd", 0);
  check(psds.length === 5, "5 PSDs");
  check(psds[1].meta.path.endsWith("_002-003.psd"), `a spread is named by its pages (${psds[1].meta.path})`);
  const spreadMeta = psds[1].meta;
  check(
    Math.abs(spreadMeta.widthPx - 2 * trimPx[0]) <= 1 && spreadMeta.heightPx === trimPx[1] && spreadMeta.dpi === 350,
    `the spread is two trims wide (${spreadMeta.widthPx}×${spreadMeta.heightPx})`,
  );
  const layerNames = spreadMeta.layers.map((layer) => layer.name);
  console.log(`     ${layerNames.join(" / ")}`);
  check(layerNames[0] === "用紙" && !spreadMeta.layers[0].hidden, "the white paper at the bottom");
  for (const name of ["ラフ線", "コマ枠", "フキダシ", "セリフ", "指示"]) check(layerNames.includes(name), `a layer 「${name}」`);
  check(
    layerNames.indexOf("ラフ線") < layerNames.indexOf("コマ枠") &&
      layerNames.indexOf("コマ枠") < layerNames.indexOf("フキダシ") &&
      layerNames.indexOf("フキダシ") < layerNames.indexOf("セリフ") &&
      layerNames.indexOf("セリフ") < layerNames.indexOf("指示"),
    "in the CSP export's order",
  );
  const sizes = spreadMeta.layers.reduce((sum, layer) => sum + layer.length, 0);
  check(sizes === Buffer.from(psds[1].rest, "base64").length, "each layer's PNG is in the body");
  const titleMeta = psds[0].meta;
  const memo = titleMeta.layers.find((layer) => layer.name === "メモ（ネーム）");
  check(!!memo && memo.hidden && memo.length > 0, "the memo goes as a hidden layer");
  check(!psds[2].meta.layers.some((layer) => layer.name === "指示"), "a page with no 指示 has no 指示 layer");
  if (out) {
    for (const [i, psd] of psds.entries()) {
      writeFileSync(`${out}/psd${i + 1}.json`, JSON.stringify(psd.meta));
      writeFileSync(`${out}/psd${i + 1}.bin`, Buffer.from(psd.rest, "base64"));
    }
  }

  // --- files there already: asked first, nothing written when declined -----------------------
  const before = await calls("write_psd");
  await page.evaluate(() => {
    window.__there = ["サンプル 部室の片付け_001.psd", "サンプル 部室の片付け_004-005.psd"];
    window.__decline = true;
  });
  await page.locator("#ne-run").click();
  await page.waitForFunction(() => document.getElementById("ne-message").textContent.includes("やめました"));
  const asked = await page.evaluate(() => window.__asked.at(-1));
  check(asked.includes("2 個") && asked.includes("_004-005.psd"), `the files there are named before writing over (${asked.slice(0, 60)})`);
  check((await calls("write_psd")) === before, "nothing is written when it is declined");
  await page.evaluate(() => {
    window.__decline = false;
    window.__there = [];
  });

  // --- transparent paper -------------------------------------------------------------------------
  await page.locator("#ne-image-paper").uncheck();
  await page.locator("#ne-run").click();
  await page.waitForFunction((n) => window.__calls.filter((c) => c.command === "write_psd").length >= n + 5, before);
  const hidden = await bodies("write_psd", before);
  check(hidden[0].meta.layers[0].name === "用紙" && hidden[0].meta.layers[0].hidden, "the paper hidden in a PSD on no paper");
  await page.locator("#ne-image-format").selectOption("jpeg");
  check(await page.locator("#ne-image-paper").isDisabled(), "a JPEG is always on white");
  await page.locator("#ne-image-format").selectOption("png");
  await page.locator("#ne-image-unit").selectOption("page");
  const pngBefore = await calls("write_binary_file");
  await page.locator("#ne-run").click();
  await page.waitForFunction((n) => window.__calls.filter((c) => c.command === "write_binary_file").length >= n + 8, pngBefore);
  const clear = Buffer.from((await bodies("write_binary_file", pngBefore))[0].rest, "base64");
  const alpha = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(2, 2, 1, 1).data[3];
  }, clear.toString("base64"));
  check(alpha === 0, "a PNG on no paper is transparent where nothing is drawn");
  await close();

  // --- 前回と同じ設定で: the same folder, no questions ------------------------------------------
  // The name, saved: its files take its file name, and its export is kept by its path.
  await page.evaluate(() => {
    const project = window.nameStudio.workbench.project;
    window.nameStudio.workbench.show(project, "C:\\names\\部室.namestudio", "");
    window.__picked.push("C:\\out\\画像");
  });
  await page.locator("#name-export").click();
  await page.locator("#ne-kind-image").click();
  const n = await calls("write_binary_file");
  await page.locator("#ne-run").click();
  await page.waitForFunction((k) => window.__calls.filter((c) => c.command === "write_binary_file").length >= k + 8, n);
  const named = (await bodies("write_binary_file", n))[0].meta.path;
  check(named === "C:\\out\\画像\\部室_001.png", `a saved name's files take its file name (${named})`);
  await close();
  const again = await calls("write_binary_file");
  await page.evaluate(() => {
    window.__opened = null;
  });
  await page.keyboard.press("Control+Shift+E");
  await page.waitForFunction((k) => window.__calls.filter((c) => c.command === "write_binary_file").length >= k + 8, again);
  const repeated = (await bodies("write_binary_file", again))[0].meta.path;
  check(
    repeated === named && (await page.evaluate(() => window.__opened)) === null,
    "前回と同じ設定で (Ctrl+Shift+E) writes them again to the same folder without asking",
  );
  await close();
  check(errors.length === 0, `no errors on the page${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}

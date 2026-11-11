// CSP のペン・消しゴムを取り込む and CSP と合わせる: the list of CSP's own sub
// tools is read as soon as the dialog opens and shown as CSP's palette has it
// (ツール › グループ); what is taken stays linked, a sub tool changed in CSP
// is followed when the window comes back (and 元に戻す takes it back), one
// changed here too is left alone, a followed group (追う) brings in what is
// added to it, and 知らせるだけ waits for 合わせる.
// Run: npm run e2e:csptools   (SHOTS=<folder> keeps a picture of the dialog)
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.SHOTS;
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1439, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const tool = (uuid, name, group, size = 10, kind = "pen") => ({
      uuid,
      name,
      group,
      kind,
      size: { value: size, unit: "px" },
      sizeDynamics: null,
      opacity: 1,
      opacityDynamics: null,
      flow: 1,
      flowDynamics: null,
      hardness: 1,
      antiAlias: 2,
      stabilization: 6,
      stabilizationBySpeed: false,
      postCorrection: 0,
      taperIn: null,
      taperOut: null,
      taperMin: 0,
      interval: 10,
      thickness: 100,
      rotation: 0,
      tipMaterial: null,
      tip: null,
      vectorErase: kind === "eraser" ? "touched" : null,
      csp: {
        // CSP keeps 向きの影響元 as a number in every brush of its own (not a blob, though it ends in Effector).
        settings: { BrushSize: size, BrushSizeUnit: 0, Opacity: 100, BrushRotationEffector: 3 },
        node: { NodeName: name, NodeInputOp: kind === "eraser" ? 12 : 10, NodeOutputOp: kind === "eraser" ? 12 : 10 },
        manager: {},
        dpi: 0,
      },
    });
    window.__tool = tool;
    window.__tools = [
      tool("g", "Gペン", ["ペン", "ペン"], 10),
      tool("m", "丸ペン", ["ペン", "ペン"], 5),
      tool("k", "カブラペン", ["ペン", "ペン"], 8),
      tool("mk", "ミリペン", ["ペン", "マーカー"], 6),
      tool("e", "硬め", ["消しゴム", "消しゴム"], 40, "eraser"),
    ];
    window.__stamp = 1;
    window.__reads = 0;
    window.__answer = (command) => {
      switch (command) {
        case "csp_tool_locations":
          return { tools: "C:/CELSYS/Tool/EditImageTool.todb", materials: null };
        case "csp_tool_stamp":
          return { modifiedMs: window.__stamp, size: 1000 };
        case "read_csp_sub_tools":
          window.__reads++;
          return structuredClone(window.__tools);
        default:
          return undefined;
      }
    };
    const { newProject } = await import("/src/domain/project.ts");
    window.nameStudio.show(newProject("ペン", 2));
  });
  const brushes = () =>
    page.evaluate(() =>
      window.nameStudio.workbench.project.brushes.map((b) => ({ id: b.id, name: b.name, size: b.sizeMm, link: b.cspLink?.uuid ?? null })),
    );
  // CSP is written to (a sub tool changed, saved), and the window comes back.
  const cspWrites = (change) =>
    page.evaluate(async (change) => {
      new Function("tools", "tool", change)(window.__tools, window.__tool);
      window.__stamp++;
      window.nameStudio.workbench.cspTools.lastCheck = 0;
      await window.nameStudio.workbench.cspTools.check();
    }, change);
  const alertText = () => page.evaluate(() => document.querySelector("#alerts .alert p")?.textContent ?? "");

  await page.keyboard.press("p");
  await page.click("#brush-import");
  await page.waitForSelector("#bd-list .bd-tool");
  const tools = await page.$$eval("#bd-list .bd-tool h3 > span", (spans) => spans.map((s) => s.textContent));
  const groups = await page.$$eval("#bd-list h4 > span:first-child", (spans) => spans.map((s) => s.textContent));
  check(tools.join(",") === "ペン,消しゴム", `the list is read as it opens, by CSP's tools in CSP's order (${tools})`);
  check(groups.join(",") === "ペン,マーカー,消しゴム", `with the groups under them (${groups})`);
  check(!(await page.isHidden("#bd-picks")), "the quick choices are there for CSP's list");

  // The ペン group, all of it, taken.
  await page.locator("#bd-list h4", { hasText: "ペン" }).first().getByRole("button", { name: "すべて" }).click();
  check((await page.textContent("#bd-import")).includes("3 本"), "すべて picks the group");
  await page.click("#bd-import");
  let taken = await brushes();
  check(taken.length === 3 && taken.every((b) => b.link), `taken pens are linked to CSP's sub tools (${JSON.stringify(taken)})`);
  const marks = await page.$$eval("#bd-list .bd-state", (nodes) => nodes.map((n) => n.textContent));
  check(marks.filter((m) => m === "取り込み済み").length === 3, `rows say what was taken (${marks})`);
  check((await page.textContent("#bd-message")).includes("3 本を取り込みました"), "and says so");
  await page.click("#bd-pick-new");
  check((await page.textContent("#bd-import")).includes("2 本"), "まだのもの picks the two not taken");
  if (shots) await page.locator("#brush-dialog").screenshot({ path: `${shots}/csptools-dialog.png` });
  await page.keyboard.press("Escape");

  // Gペン changed in CSP: followed when the window comes back.
  const gBefore = taken.find((b) => b.name === "Gペン");
  await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    const g = wb.project.brushes.find((b) => b.name === "Gペン");
    wb.project.pages[0].strokes.push({ id: "s1", points: [], widthMm: 1, closed: false, brush: g.id });
  });
  await cspWrites(`const g = tools.find((t) => t.uuid === "g"); g.size.value = 20; g.csp.settings.BrushSize = 20;`);
  taken = await brushes();
  const gAfter = taken.find((b) => b.name === "Gペン");
  check(
    gAfter.id === gBefore.id && Math.abs(gAfter.size - gBefore.size * 2) < 1e-9,
    "a sub tool changed in CSP is followed, as the same brush",
  );
  check((await alertText()).includes("CSP に合わせました") && (await alertText()).includes("Gペン"), "and it says so");
  await page.locator("#alerts .alert").getByRole("button", { name: "元に戻す" }).click();
  check(Math.abs((await brushes()).find((b) => b.name === "Gペン").size - gBefore.size) < 1e-9, "元に戻す takes it back");
  await page.evaluate(() => {
    window.nameStudio.workbench.cspTools.lastCheck = 0;
    return window.nameStudio.workbench.cspTools.check();
  });
  check(
    Math.abs((await brushes()).find((b) => b.name === "Gペン").size - gBefore.size) < 1e-9,
    "and the same change is not made again by itself",
  );

  // 丸ペン changed here and in CSP: left alone, and named.
  await page.evaluate(() => {
    const m = window.nameStudio.workbench.project.brushes.find((b) => b.name === "丸ペン");
    m.csp.settings.Opacity = 50;
  });
  await cspWrites(`const m = tools.find((t) => t.uuid === "m"); m.size.value = 9; m.csp.settings.BrushSize = 9;`);
  const maru = (await brushes()).find((b) => b.name === "丸ペン");
  check(Math.abs(maru.size - (5 * 25.4) / 600) < 1e-9, "a pen changed here too is not overwritten");
  check((await alertText()).includes("丸ペン") && (await alertText()).includes("そのままにしました"), "and it is named");

  // 追う the マーカー group: what is in it is taken, and what CSP adds to it later.
  await page.locator('#alerts .alert button[title="閉じる"]').click();
  await page.click("#brush-import");
  await page.waitForSelector("#bd-list .bd-tool");
  const state = await page.$eval("#bd-list", (list) =>
    [...list.querySelectorAll(".brush-row")].map((row) => `${row.children[2].textContent}:${row.querySelector(".bd-state").textContent}`),
  );
  check(state.includes("丸ペン:両方で変わった") && state.includes("Gペン:CSP で変わった"), `the list shows how each stands (${state})`);
  await page.locator("#bd-list h4", { hasText: "マーカー" }).locator(".bd-follow input").check();
  check(
    (await brushes()).some((b) => b.name === "ミリペン"),
    "追う takes in what the group has",
  );
  await page.keyboard.press("Escape");
  await cspWrites(`tools.push(tool("pp", "ピグマ", ["ペン", "マーカー"], 4));`);
  check(
    (await brushes()).some((b) => b.name === "ピグマ" && b.link === "pp"),
    "and what CSP adds to it later",
  );

  // 知らせるだけ: nothing changes until 合わせる.
  await page.evaluate(() => localStorage.setItem("namestudio.cspSync", "notify"));
  await cspWrites(`const k = tools.find((t) => t.uuid === "k"); k.size.value = 16; k.csp.settings.BrushSize = 16;`);
  const kabura = () => brushes().then((list) => list.find((b) => b.name === "カブラペン").size);
  check(
    Math.abs((await kabura()) - (8 * 25.4) / 600) < 1e-9 && (await alertText()).includes("CSP で変わりました"),
    "知らせるだけ only says so",
  );
  await page.locator("#alerts .alert").getByRole("button", { name: "合わせる" }).click();
  check(Math.abs((await kabura()) - (16 * 25.4) / 600) < 1e-9, "合わせる follows it");
  const reads = await page.evaluate(() => window.__reads);
  await page.evaluate(() => {
    window.nameStudio.workbench.cspTools.lastCheck = 0;
    return window.nameStudio.workbench.cspTools.check();
  });
  check((await page.evaluate(() => window.__reads)) === reads, "CSP's list is not read again while CSP has not written it");

  check(errors.length === 0, `no errors on the page (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

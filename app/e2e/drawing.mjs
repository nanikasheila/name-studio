// 作画 (backgrounds drawn by an AI) with the Rust side stood in for: the 背景
// tool (H) marks a vanishing point in a panel; the 作画 palette asks nothing
// until writing and commands are allowed, then writes the request (依頼.md,
// the panels' pictures) to the background folder and starts a turn allowed to
// write there only (work = the folder), apart from 相談; the takes listed in
// 背景.json show per panel; 採用 lays one in the panel (cut to its shape,
// undone with Ctrl+Z), 修正 asks again in the same conversation, 外す takes it
// out.
// Run: node e2e/drawing.mjs
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const FOLDER = "C:\\work\\屋上_背景";
const server = await createServer({ root, logLevel: "error", server: { port: 1443, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript((folder) => {
    window.__turns = [];
    window.__sessions = [];
    window.__writes = [];
    window.__files = {};
    window.__listeners = [];
    window.__answer = (command, args) => {
      if (command === "plugin:event|listen" && args.event === "ai-event") {
        window.__listeners.push(args.handler);
        return window.__listeners.length;
      }
      if (command === "ai_detect")
        return { claude: { path: "C:\\bin\\claude.exe", version: "2.1.0 (Claude Code)" }, codex: null, node: null };
      if (command === "ai_models")
        return [{ value: "", label: "Default", description: "", efforts: ["low", "high"], defaultEffort: null, isDefault: true }];
      if (command === "ai_prepare_session") {
        window.__sessions.push(args);
        return args.dir ?? "C:\\data\\ai-sessions\\draw-1";
      }
      if (command === "ai_turn") {
        window.__turns.push(args.turn);
        return window.__turns.length;
      }
      if (command === "ai_stop") return null;
      if (command === "bg_folder") return folder;
      if (command === "bg_blender") return "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe";
      if (command === "bg_write") {
        window.__writes.push(args);
        return null;
      }
      if (command === "bg_read") return window.__files[args.path] ?? null;
      return undefined;
    };
    window.__say = (run, kind, text) => {
      for (const id of window.__listeners) window[`_${id}`]?.({ event: "ai-event", id: 1, payload: { run, kind, text } });
    };
  }, FOLDER);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const { applyOps } = await import("/src/domain/assist.ts");
    const project = newProject("屋上", 2);
    applyOps(project, [{ op: "panels", page: 1, count: 3 }]);
    window.nameStudio.show(project);
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(1);
    wb.editor.fitView();
  });
  const settle = (ms = 150) => page.evaluate((ms) => new Promise((resolve) => setTimeout(resolve, ms)), ms);
  await settle(300);
  const panels = () =>
    page.evaluate(() =>
      window.nameStudio.workbench.project.pages[0].panels.map((panel) => ({
        id: panel.id,
        shape: panel.shape,
        background: panel.background ?? null,
      })),
    );
  const first = (await panels()).sort((a, b) => a.shape[0][1] - b.shape[0][1] || b.shape[0][0] - a.shape[0][0])[0];
  check(!!first, "the page has panels to draw backgrounds in");
  const centre = (shape) => [
    shape.reduce((sum, [x]) => sum + x, 0) / shape.length,
    shape.reduce((sum, [, y]) => sum + y, 0) / shape.length,
  ];
  const at = (mm) =>
    page.evaluate((mm) => {
      const wb = window.nameStudio.workbench;
      return wb.editor.clientOf(wb.project.pages[0].id, mm);
    }, mm);

  // 背景の指示: a vanishing point in the first panel.
  await page.keyboard.press("h");
  await settle();
  check((await page.evaluate(() => window.nameStudio.workbench.editor.tool)) === "background", "H takes the 背景 tool");
  check(await page.isVisible("#background-bar"), "with its bar of what a press marks");
  await page.click("#background-bar [data-bg-mode=vanishing]");
  const [cx, cy] = centre(first.shape);
  await page.mouse.click(...(await at([cx, cy])));
  await settle();
  const marked = (await panels()).find((panel) => panel.id === first.id);
  check(marked.background?.vanishing?.length === 1, "a click puts a vanishing point in the panel under it");

  // The 作画 palette.
  await page.click("#tab-drawing");
  await page.waitForSelector(".drawing");
  await settle();
  check(
    (await page.textContent("#side-drawing .assist-state")).includes("Claude Code に背景を描いてもらいます"),
    "says which AI will draw",
  );
  await page.selectOption('#side-drawing [data-part="scope"]', "marked");
  await settle();
  check((await page.textContent('#side-drawing [data-part="count"]')) === "1 コマ", "背景の指示があるコマ counts the panel marked");
  check(await page.locator('#side-drawing [data-part="send"]').isDisabled(), "nothing is asked until writing and commands are allowed");
  await page.check('#side-drawing [data-part="allowed"]');
  check(!(await page.locator('#side-drawing [data-part="send"]').isDisabled()), "allowed, it can be asked");
  await page.fill('#side-drawing [data-part="world"]', "屋上は古い団地の屋上。給水塔がある");
  await page.locator('#side-drawing [data-part="world"]').dispatchEvent("change");
  await page.fill('#side-drawing [data-part="note"]', "夜。線は細めに");
  await page.click('#side-drawing [data-part="send"]');
  await page.waitForFunction(() => window.__turns.length === 1);
  const project = () => page.evaluate(() => window.nameStudio.workbench.project);
  check((await project()).backgrounds?.brief === "屋上は古い団地の屋上。給水塔がある", "世界の設定 is kept in the name");
  const [write] = await page.evaluate(() => window.__writes);
  const written = Object.fromEntries(write.files.map((file) => [file.path, file]));
  const brief = Object.entries(written).find(([path]) => path.endsWith("/依頼.md"))?.[1]?.text ?? "";
  check(write.folder === FOLDER, "the request goes to the background folder");
  check(
    brief.includes("給水塔") && brief.includes("夜。線は細めに") && brief.includes("消失点") && brief.includes("blender.exe"),
    "依頼.md has the world, this request, the panel's instructions and where Blender is",
  );
  check(
    Object.keys(written).some((path) => path.endsWith(`/${first.id}.png`) && written[path].base64?.length > 100) &&
      Object.keys(written).some((path) => /\/p001\.png$/.test(path)),
    "with the panel's picture and its page's",
  );
  const [session] = await page.evaluate(() => window.__sessions);
  check(
    ["SYSTEM.md", "CLAUDE.md", "AGENTS.md"].every((path) => session.files.some((file) => file.path === path && file.text.includes(FOLDER))),
    "the AI is told where it may write",
  );
  const [turn] = await page.evaluate(() => window.__turns);
  check(turn.kind === "claude" && turn.work === FOLDER && turn.resume === null, "the turn may write in that folder only");
  check(turn.prompt.includes("依頼.md"), "and is pointed at 依頼.md");
  check((await page.evaluate(() => document.querySelectorAll("#side-assist .assist-entry").length)) === 0, "相談 has none of it");

  // A take drawn: 背景.json lists it, its picture a red square.
  const red = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 90;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 120, 90);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.evaluate(
    ({ panel, red }) => {
      window.__files[`案/${panel}/1/完成.png`] = red;
      window.__files[`案/${panel}/1/線画.png`] = red;
      window.__files["背景.json"] = JSON.stringify({
        takes: [{ panel, take: "1", files: { 完成: `案/${panel}/1/完成.png`, 線画: `案/${panel}/1/線画.png` }, note: "給水塔を右奥に" }],
      });
      window.__say(1, "session", "draw-sess");
      window.__say(1, "tool", `Write: 案/${panel}/1/完成.png`);
      window.__say(1, "delta", "1 コマ描きました。");
      window.__say(1, "done", "");
    },
    { panel: first.id, red },
  );
  await page.waitForSelector(`#side-drawing .drawing-panel[data-panel="${first.id}"] .drawing-take img`);
  check(
    (await page.textContent(`#side-drawing .drawing-panel[data-panel="${first.id}"]`)).includes("給水塔を右奥に"),
    "the take shows per panel, with what the AI said of it",
  );
  await page.click(`#side-drawing .drawing-panel[data-panel="${first.id}"] button:has-text("採用")`);
  await page.waitForFunction(
    (id) => window.nameStudio.workbench.project.pages[0].references?.some((r) => r.kind === "background" && r.panel === id),
    first.id,
  );
  const adopted = (await project()).pages[0].references.find((r) => r.kind === "background");
  check(adopted.source === `${first.id}/1/完成`, `採用 lays the take in the panel (${adopted.source})`);
  await settle();
  const colour = await page.evaluate(
    ([x, y]) => {
      const canvas = document.getElementById("editor-canvas");
      const box = canvas.getBoundingClientRect();
      const ratio = canvas.width / box.width;
      return [...canvas.getContext("2d").getImageData(Math.round((x - box.left) * ratio), Math.round((y - box.top) * ratio), 1, 1).data];
    },
    await at([cx + 5, cy + 5]),
  );
  check(colour[0] > 200 && colour[1] < 120 && colour[2] < 120, `and it shows in the panel (${colour.slice(0, 3)})`);
  check(
    (await page.textContent(`#side-drawing .drawing-panel[data-panel="${first.id}"] .drawing-status`)).includes("採用中（案1・完成）"),
    "the panel says which take it has",
  );
  await page.keyboard.press("Escape");
  await page
    .locator("#editor-canvas")
    .focus()
    .catch(() => {});
  await page.keyboard.press("Control+z");
  await settle();
  check(!(await project()).pages[0].references?.some((r) => r.kind === "background"), "Ctrl+Z takes it out again");
  await page.keyboard.press("Control+y");
  await settle();
  check(!!(await project()).pages[0].references?.some((r) => r.kind === "background"), "and Ctrl+Y puts it back");

  // 修正: in the same conversation, the take and the words in 依頼.md.
  await page.click(`#side-drawing .drawing-panel[data-panel="${first.id}"] button:has-text("修正")`);
  await page.fill(`#side-drawing .drawing-revise textarea`, "もっと引きで");
  await page.click(`#side-drawing .drawing-revise button:has-text("修正を頼む")`);
  await page.waitForFunction(() => window.__turns.length === 2);
  const again = await page.evaluate(() => window.__turns[1]);
  const second = await page.evaluate(() => window.__writes[1].files.find((file) => file.path.endsWith("/依頼.md")).text);
  check(again.resume === "draw-sess" && again.work === FOLDER, "修正 goes on with the same conversation, still in the folder");
  check(second.includes("もっと引きで") && second.includes("案1"), "with the take to change and how");
  await page.evaluate(() => window.__say(2, "done", ""));
  await settle();

  await page.click(`#side-drawing .drawing-panel[data-panel="${first.id}"] button:has-text("外す")`);
  await settle();
  check(!(await project()).pages[0].references?.some((r) => r.kind === "background"), "外す takes the background out of the panel");
  if (process.env.DRAWING_SHOT) await page.locator("#dock-right").screenshot({ path: process.env.DRAWING_SHOT });
  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

// 作画 (backgrounds drawn by an AI) with the Rust side stood in for: the 背景
// tool (H) marks a vanishing point in a panel; the 作画 palette asks nothing
// until writing and commands are allowed, then writes the request (依頼.md,
// the panels' pictures) to the background folder and starts a turn allowed to
// write there only (work = the folder), apart from 相談; the takes listed in
// 背景.json show per panel; 採用 lays one in the panel (cut to its shape,
// undone with Ctrl+Z), 修正 asks again in the same conversation, 外す takes it
// out. 素材: the folder of places and things kept for reuse is listed (3D
// files added with one button, renamed with the panels that name them), a
// panel's 場所 and a 物's 素材 are chosen, and the request names them and lets
// the AI write in that folder too.
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
const ASSETS = "C:\\work\\背景素材";
const server = await createServer({ root, logLevel: "error", server: { port: 1443, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(
    ([folder, assets]) => {
      window.__assetFiles = {
        "素材.json": JSON.stringify({ assets: [{ name: "団地の屋上", kind: "place", file: "団地の屋上/屋上.blend", note: "北が給水塔" }] }),
      };
      window.__assetWrites = [];
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
        if (command === "bg_assets") return assets;
        if (command === "bg_models") return ["団地の屋上/屋上.blend", "給水塔/給水塔.blend"];
        if (command === "bg_write" && args.folder === assets) {
          window.__assetWrites.push(args);
          for (const file of args.files) window.__assetFiles[file.path] = file.text;
          return null;
        }
        if (command === "bg_write") {
          window.__writes.push(args);
          return null;
        }
        if (command === "bg_read") return (args.folder === assets ? window.__assetFiles : window.__files)[args.path] ?? null;
        return undefined;
      };
      window.__say = (run, kind, text) => {
        for (const id of window.__listeners) window[`_${id}`]?.({ event: "ai-event", id: 1, payload: { run, kind, text } });
      };
    },
    [FOLDER, ASSETS],
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const { applyOps } = await import("/src/domain/assist.ts");
    const project = newProject("屋上", 2);
    project.backgrounds = { assets: "C:\\work\\背景素材" };
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
  check(
    (await page.getAttribute("#background-bar [data-perspective='1']", "aria-pressed")) === "true",
    "the first point makes a 1点 ruler",
  );

  // 透視の定規: 2点 lays out both points on the eye level and an X and a Y line in the panel.
  await page.click("#background-bar [data-perspective='2']");
  await settle();
  const ruler = async () => (await panels()).find((panel) => panel.id === first.id).background;
  /** How far `p` is from the line through `a` and `b` (mm). */
  const away = (p, [a, b]) =>
    Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
  const together = (bg) =>
    bg.vanishing.every((p) => away(p, bg.horizon) < 0.1) && bg.guides.every((line, k) => away(bg.vanishing[Math.min(k, 2)], line) < 0.1);
  let bg = await ruler();
  check(
    bg.perspective === 2 && bg.vanishing.length === 2 && bg.guides.length === 2 && together(bg),
    "2点: both points on the eye level, a line aimed at each",
  );
  // The X line's end dragged: its point slides along the eye level (beyond the panel too).
  const end = bg.guides[0][1];
  const before = bg.vanishing[0];
  await page.mouse.move(...(await at(end)));
  await page.mouse.down();
  await page.mouse.move(...(await at([end[0], end[1] - 4])), { steps: 4 });
  await page.mouse.up();
  await settle();
  bg = await ruler();
  check(bg.vanishing[0][0] !== before[0] && together(bg), "dragging a line's end moves its point along the eye level");
  // The eye level dragged up: the points slide along their lines.
  await page.click("#background-bar [data-bg-mode=horizon]");
  const across = [
    cx,
    bg.horizon[0][1] + ((bg.horizon[1][1] - bg.horizon[0][1]) * (cx - bg.horizon[0][0])) / (bg.horizon[1][0] - bg.horizon[0][0]),
  ];
  const lines = bg.guides;
  await page.mouse.move(...(await at(across)));
  await page.mouse.down();
  await page.mouse.move(...(await at([across[0], across[1] - 6])), { steps: 4 });
  await page.mouse.up();
  await settle();
  bg = await ruler();
  check(
    Math.abs(bg.horizon[0][1] - (across[1] - 6)) < 0.6 && JSON.stringify(bg.guides) === JSON.stringify(lines) && together(bg),
    "dragging the eye level keeps the lines and slides the points along them",
  );
  await page.keyboard.press("Control+z");
  await settle();
  check(Math.abs((await ruler()).horizon[0][1] - across[1]) < 0.6, "Ctrl+Z puts the eye level back in one step");

  // Beyond the panel: the eye level dragged above it stays there to take again, and turns by its ends.
  const dragOn = async (from, to) => {
    await page.mouse.move(...(await at(from)));
    await page.mouse.down();
    await page.mouse.move(...(await at(to)), { steps: 5 });
    await page.mouse.up();
    await settle();
  };
  const yAt = (one, x) =>
    one.horizon[0][1] + ((one.horizon[1][1] - one.horizon[0][1]) * (x - one.horizon[0][0])) / (one.horizon[1][0] - one.horizon[0][0]);
  const top = Math.min(...first.shape.map(([, y]) => y));
  const [left, right] = [Math.min(...first.shape.map(([x]) => x)), Math.max(...first.shape.map(([x]) => x))];
  bg = await ruler();
  await dragOn([cx, yAt(bg, cx)], [cx, top - 6]);
  bg = await ruler();
  check(Math.abs(yAt(bg, cx) - (top - 6)) < 0.6 && together(bg), "the eye level is dragged out of the panel (above it)");
  await dragOn([cx, top - 6], [cx, top - 10]);
  bg = await ruler();
  check(Math.abs(yAt(bg, cx) - (top - 10)) < 0.6, "and is found there and moved again");
  await dragOn([right, yAt(bg, right)], [right, yAt(bg, right) + 8]);
  bg = await ruler();
  check(
    Math.abs(yAt(bg, right) - yAt(bg, left) - 8) < 0.8 && Math.abs(yAt(bg, left) - (top - 10)) < 0.6 && together(bg),
    "its right end turns it about the left end",
  );
  if (process.env.RULER_SHOT) await page.locator("#editor-canvas").screenshot({ path: process.env.RULER_SHOT });

  // 物: placed, then moved from inside, sized by a corner and named anew in the bar.
  await page.click("#background-bar [data-bg-mode=object]");
  const drag = async (from, to) => {
    await page.mouse.move(...(await at(from)));
    await page.mouse.down();
    await page.mouse.move(...(await at(to)), { steps: 5 });
    await page.mouse.up();
    await settle();
  };
  const [bx, by] = [cx - 30, cy + 2];
  await drag([bx, by], [bx + 16, by + 10]);
  let things = (await ruler()).objects ?? [];
  check(things.length === 1, "物: a drag places a thing");
  await drag([bx + 8, by + 5], [bx + 14, by + 3]);
  things = (await ruler()).objects;
  check(things.length === 1 && Math.abs(things[0].shape[0][0] - (bx + 6)) < 0.3, "dragging inside it moves it (no new one)");
  await drag(things[0].shape[2], [things[0].shape[2][0] + 6, things[0].shape[2][1] + 4]);
  things = (await ruler()).objects;
  check(Math.abs(things[0].shape[2][0] - things[0].shape[0][0] - 22) < 0.3, "dragging a corner sizes it");
  await page.fill("#background-label", "バン 横向き");
  await page.press("#background-label", "Enter");
  await settle();
  check((await ruler()).objects[0].label === "バン 横向き", "its name is changed in the bar once picked");

  // The 作画 palette.
  await page.click("#tab-drawing");
  await page.waitForSelector(".drawing");
  await settle();
  check(
    (await page.textContent("#side-drawing .assist-state")).includes("Claude Code に背景を描いてもらいます"),
    "says which AI will draw",
  );
  // 素材: listed from 素材.json; the 3D files not listed added as 物.
  await page.waitForFunction(() => document.querySelector('#side-drawing [data-part="assets-count"]')?.textContent === "1 件");
  check(true, "素材 lists what 素材.json has");
  await page.click("#side-drawing .drawing-assets > summary");
  await page.click('#side-drawing [data-part="assets-models"]');
  await page.waitForFunction(() => window.__assetWrites.length === 1);
  const listed = () => page.evaluate(() => JSON.parse(window.__assetFiles["素材.json"]).assets);
  check(
    JSON.stringify((await listed()).map((asset) => [asset.name, asset.kind])) ===
      JSON.stringify([
        ["団地の屋上", "place"],
        ["給水塔", "thing"],
      ]),
    "the 3D file not listed is added as a 物 named after its file",
  );
  // 場所 of the panel, from the 素材.
  const row = `#side-drawing .drawing-panel[data-panel="${first.id}"]`;
  await page.fill(`${row} .drawing-place`, "団地の屋上");
  await page.press(`${row} .drawing-place`, "Enter");
  await settle();
  check((await ruler()).place === "団地の屋上", "a panel's 場所 is chosen from the 素材");
  await page.selectOption(`${row} .drawing-object-asset select`, "給水塔");
  await settle();
  check((await ruler()).objects[0].asset === "給水塔", "a 物's 素材 is chosen");
  // Renamed in the list: the 物 naming it follows.
  const name = '#side-drawing .drawing-asset[data-asset="給水塔"] input[aria-label="素材の名前"]';
  await page.fill(name, "給水塔 大");
  await page.press(name, "Enter");
  await page.waitForFunction(() => window.__assetWrites.length === 2);
  await settle();
  check(
    (await listed())[1].name === "給水塔 大" && (await ruler()).objects[0].asset === "給水塔 大",
    "a 素材 renamed is renamed where it is used",
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
  check(
    brief.includes("## 素材（使い回す 3D）") &&
      brief.includes("場所の素材: 「団地の屋上」") &&
      brief.includes("物「バン 横向き」の素材: 「給水塔 大」") &&
      brief.includes("あたり（モック）"),
    "依頼.md names the 素材 of the panel and asks for a quick あたり",
  );
  const [session] = await page.evaluate(() => window.__sessions);
  check(
    ["SYSTEM.md", "CLAUDE.md", "AGENTS.md"].every((path) => session.files.some((file) => file.path === path && file.text.includes(FOLDER))),
    "the AI is told where it may write",
  );
  const [turn] = await page.evaluate(() => window.__turns);
  check(turn.kind === "claude" && turn.work === FOLDER && turn.resume === null, "the turn may write in that folder only");
  check(turn.assets === ASSETS && session.files[0].text.includes(ASSETS), "and in the folder of 素材 (it is told so)");
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
  // A few spots of the panel, the 背景 tool put down (its ruler shows with it only).
  await page.keyboard.press("v");
  await settle();
  const colours = [];
  for (const [dx, dy] of [
    [5, 5],
    [-20, 12],
    [25, -12],
    [-40, -15],
    [40, 15],
  ]) {
    colours.push(
      await page.evaluate(
        ([x, y]) => {
          const canvas = document.getElementById("editor-canvas");
          const box = canvas.getBoundingClientRect();
          const ratio = canvas.width / box.width;
          return [
            ...canvas.getContext("2d").getImageData(Math.round((x - box.left) * ratio), Math.round((y - box.top) * ratio), 1, 1).data,
          ];
        },
        await at([cx + dx, cy + dy]),
      ),
    );
  }
  const reddish = colours.filter((colour) => colour[0] > 200 && colour[1] < 120 && colour[2] < 120);
  check(
    reddish.length === colours.length,
    `and it shows in the panel (${colours.map((colour) => colour.slice(0, 3).join(",")).join(" / ")})`,
  );
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
